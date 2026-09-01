use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::error::{AbError, AbResult};
use crate::selector::ElementTarget;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_ELEMENTS_PER_CLIENT: usize = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementHandleDescriptor {
    pub id: String,
    pub target_id: String,
    pub frame_id: String,
    pub document_generation: String,
    pub backend_node_id: i64,
}

struct ElementHandleRecord {
    client_id: String,
    target: ElementTarget,
}

pub struct ElementRegistry {
    client: Arc<CdpClient>,
    records: Mutex<HashMap<String, ElementHandleRecord>>,
}

impl ElementRegistry {
    pub fn new(client: Arc<CdpClient>) -> Self {
        Self {
            client,
            records: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(
        &self,
        client_id: &str,
        target: ElementTarget,
    ) -> AbResult<ElementHandleDescriptor> {
        self.assert_capacity(client_id).await?;
        let id = Uuid::new_v4().to_string();
        let target = self.retain(target, &id).await?;
        let descriptor = ElementHandleDescriptor {
            id: id.clone(),
            target_id: target.target_id.clone(),
            frame_id: target.frame_id.clone(),
            document_generation: target.document_generation.clone(),
            backend_node_id: target.backend_node_id,
        };
        let mut records = self.records.lock().await;
        if owned_count(&records, client_id) >= MAX_ELEMENTS_PER_CLIENT {
            drop(records);
            self.release(&target).await;
            return Err(capacity_error());
        }
        records.insert(
            id,
            ElementHandleRecord {
                client_id: client_id.to_owned(),
                target,
            },
        );
        Ok(descriptor)
    }

    pub async fn target(&self, client_id: &str, element_id: &str) -> AbResult<ElementTarget> {
        let records = self.records.lock().await;
        let record = records.get(element_id).ok_or_else(|| {
            AbError::new(
                "element_not_found",
                "element.lookup",
                format!("element handle {element_id} does not exist"),
            )
        })?;
        if record.client_id != client_id {
            return Err(AbError::new(
                "resource_owner_mismatch",
                "element.owner",
                "element handle belongs to another client",
            ));
        }
        Ok(record.target.clone())
    }

    pub async fn dispose(&self, client_id: &str, element_id: &str) -> AbResult<()> {
        let record = {
            let mut records = self.records.lock().await;
            let record = records.get(element_id).ok_or_else(|| {
                AbError::new(
                    "element_not_found",
                    "element.dispose",
                    format!("element handle {element_id} does not exist"),
                )
            })?;
            if record.client_id != client_id {
                return Err(AbError::new(
                    "resource_owner_mismatch",
                    "element.dispose",
                    "element handle belongs to another client",
                ));
            }
            records
                .remove(element_id)
                .expect("element existed while its owner was checked")
        };
        self.release(&record.target).await;
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
            self.release(&record.target).await;
        }
    }

    async fn assert_capacity(&self, client_id: &str) -> AbResult<()> {
        let records = self.records.lock().await;
        if owned_count(&records, client_id) >= MAX_ELEMENTS_PER_CLIENT {
            return Err(capacity_error());
        }
        Ok(())
    }

    async fn retain(&self, mut target: ElementTarget, element_id: &str) -> AbResult<ElementTarget> {
        let object_group = format!("ab-element:{element_id}");
        let result = if let Some(object_id) = target.remote_object_id.as_deref() {
            self.client
                .send_command(
                    "Runtime.callFunctionOn",
                    Some(json!({
                        "objectId": object_id,
                        "functionDeclaration": "function() { return this; }",
                        "objectGroup": object_group,
                        "returnByValue": false
                    })),
                    Some(&target.session_id),
                )
                .await
        } else {
            self.client
                .send_command(
                    "DOM.resolveNode",
                    Some(json!({
                        "backendNodeId": target.backend_node_id,
                        "objectGroup": object_group
                    })),
                    Some(&target.session_id),
                )
                .await
        }
        .map_err(|message| {
            AbError::new(
                "stale_ref",
                "element.retain",
                format!("element changed before its handle was retained: {message}"),
            )
        })?;
        let object_id = result
            .pointer("/result/objectId")
            .or_else(|| result.pointer("/object/objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AbError::new(
                    "stale_ref",
                    "element.retain.object",
                    "element did not resolve to a remote object",
                )
            })?
            .to_owned();
        target.remote_object_id = Some(object_id);
        target.object_group = Some(object_group);
        Ok(target)
    }

    async fn release(&self, target: &ElementTarget) {
        let Some(object_group) = target.object_group.as_deref() else {
            return;
        };
        let _ = self
            .client
            .send_command(
                "Runtime.releaseObjectGroup",
                Some(json!({ "objectGroup": object_group })),
                Some(&target.session_id),
            )
            .await;
    }
}

fn owned_count(records: &HashMap<String, ElementHandleRecord>, client_id: &str) -> usize {
    records
        .values()
        .filter(|record| record.client_id == client_id)
        .count()
}

fn capacity_error() -> AbError {
    AbError::new(
        "resource_limit",
        "element.create",
        format!("client already owns {MAX_ELEMENTS_PER_CLIENT} element handles"),
    )
}
