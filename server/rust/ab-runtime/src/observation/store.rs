use super::{ObservationOutput, ObservationRecord, SnapshotOptions};
use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::error::{AbError, AbResult};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

const MAX_OBSERVATIONS_PER_CLIENT: usize = 32;

pub struct ObservationStore {
    client: Arc<CdpClient>,
    records: Mutex<HashMap<String, ObservationRecord>>,
    revisions: Mutex<HashMap<String, u64>>,
}

impl ObservationStore {
    pub fn new(client: Arc<CdpClient>) -> Self {
        Self {
            client,
            records: Mutex::new(HashMap::new()),
            revisions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn assert_capacity(&self, client_id: &str) -> AbResult<()> {
        let records = self.records.lock().await;
        if records
            .values()
            .filter(|record| record.client_id == client_id)
            .count()
            >= MAX_OBSERVATIONS_PER_CLIENT
        {
            return Err(capacity_error());
        }
        Ok(())
    }

    pub async fn next_revision(&self, target_id: &str) -> u64 {
        let mut revisions = self.revisions.lock().await;
        let revision = revisions.entry(target_id.to_owned()).or_insert(0);
        *revision += 1;
        *revision
    }

    pub async fn previous(
        &self,
        client_id: &str,
        target_id: &str,
        options: &SnapshotOptions,
    ) -> AbResult<Option<ObservationRecord>> {
        let Some(id) = options.diff_from.as_deref() else {
            return Ok(None);
        };
        let previous = self
            .get_owned(client_id, target_id, id, "observation.diff")
            .await?;
        // A diff compares two instances of one observation contract, not two
        // arbitrary renderings. Design evidence:
        // `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
        if !options.same_capture_shape(&previous.capture_options) {
            return Err(AbError::new(
                "observation_shape_mismatch",
                "observation.diff.shape",
                "a diff observation must use the same capture shape as its baseline",
            )
            .with_details(json!({ "baselineObservationId": id })));
        }
        Ok(Some(previous))
    }

    pub async fn get_owned(
        &self,
        client_id: &str,
        target_id: &str,
        observation_id: &str,
        stage: &str,
    ) -> AbResult<ObservationRecord> {
        let records = self.records.lock().await;
        let record = records
            .get(observation_id)
            .ok_or_else(|| observation_not_found(observation_id))?;
        if record.client_id != client_id {
            return Err(AbError::new(
                "resource_owner_mismatch",
                stage,
                "observation belongs to another client",
            ));
        }
        if record.output.target_id != target_id {
            return Err(AbError::new(
                "target_mismatch",
                stage,
                "observation belongs to another tab",
            ));
        }
        Ok(record.clone())
    }

    pub async fn insert(&self, record: ObservationRecord) -> AbResult<ObservationOutput> {
        let output = record.output.clone();
        let mut records = self.records.lock().await;
        if records
            .values()
            .filter(|candidate| candidate.client_id == record.client_id)
            .count()
            >= MAX_OBSERVATIONS_PER_CLIENT
        {
            drop(records);
            self.release(&record).await;
            return Err(capacity_error());
        }
        records.insert(output.id.clone(), record);
        Ok(output)
    }

    pub async fn dispose(&self, client_id: &str, observation_id: &str) -> AbResult<()> {
        let record = {
            let mut records = self.records.lock().await;
            let record = records
                .get(observation_id)
                .ok_or_else(|| observation_not_found(observation_id))?;
            if record.client_id != client_id {
                return Err(AbError::new(
                    "resource_owner_mismatch",
                    "observation.dispose",
                    "observation belongs to another client",
                ));
            }
            records
                .remove(observation_id)
                .expect("observation existed while its owner was checked")
        };
        self.release(&record).await;
        Ok(())
    }

    pub async fn cleanup_client(&self, client_id: &str) {
        let removed = {
            let mut records = self.records.lock().await;
            records
                .extract_if(|_, record| record.client_id == client_id)
                .map(|(_, record)| record)
                .collect::<Vec<_>>()
        };
        for record in &removed {
            self.release(record).await;
        }
    }

    pub async fn release(&self, record: &ObservationRecord) {
        if record.object_group.is_empty() {
            return;
        }
        for session_id in &record.retained_sessions {
            let _ = self
                .client
                .send_command(
                    "Runtime.releaseObjectGroup",
                    Some(json!({ "objectGroup": record.object_group })),
                    Some(session_id),
                )
                .await;
        }
    }
}

fn capacity_error() -> AbError {
    AbError::new(
        "resource_limit",
        "observation.create",
        format!("client already owns {MAX_OBSERVATIONS_PER_CLIENT} live observations"),
    )
}

fn observation_not_found(id: &str) -> AbError {
    AbError::new(
        "observation_not_found",
        "observation.resolve",
        format!("observation {id} does not exist"),
    )
}
