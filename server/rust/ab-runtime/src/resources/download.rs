use super::events::{emit, emit_closed, release_event_domains};
use super::state::ResourceState;
use super::ClientOutbound;
use crate::artifacts::{ArtifactDescriptor, ArtifactStore};
use crate::browser::{BrowserCore, EventSubscription};
use crate::error::{AbError, AbResult};
use ab_protocol::DaemonMessage;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadRecord {
    pub guid: String,
    pub target_id: String,
    pub frame_id: String,
    pub url: String,
    pub suggested_filename: String,
    pub path: Option<String>,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub state: String,
    pub reason: Option<String>,
    pub artifact: Option<DownloadArtifact>,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadArtifact {
    pub id: String,
    pub path: String,
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub encoding: String,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
}

impl DownloadArtifact {
    fn from_descriptor(name: String, descriptor: ArtifactDescriptor) -> Self {
        Self {
            id: descriptor.id,
            path: descriptor.path,
            name,
            sha256: descriptor.sha256,
            bytes: descriptor.bytes,
            media_type: descriptor.media_type,
            encoding: descriptor.encoding,
            created_at_unix_ms: descriptor.created_at_unix_ms,
            expires_at_unix_ms: descriptor.expires_at_unix_ms,
        }
    }
}

#[derive(Default)]
pub(super) struct DownloadStore {
    records: Mutex<HashMap<String, DownloadRecord>>,
}

impl DownloadStore {
    pub(super) async fn get(&self, guid: &str) -> AbResult<DownloadRecord> {
        self.records.lock().await.get(guid).cloned().ok_or_else(|| {
            AbError::new(
                "download_not_found",
                "resource.download.lookup",
                format!("download {guid} does not belong to this watcher"),
            )
        })
    }

    pub(super) async fn list(&self) -> Vec<DownloadRecord> {
        let mut records = self
            .records
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.created_at_unix_ms);
        records
    }

    async fn start(&self, target_id: &str, params: &Value) -> Option<DownloadRecord> {
        let guid = params.get("guid")?.as_str()?.to_owned();
        let frame_id = params
            .get("frameId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let now = now_unix_ms();
        let record = DownloadRecord {
            guid: guid.clone(),
            target_id: target_id.to_owned(),
            frame_id,
            url: params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            suggested_filename: params
                .get("suggestedFilename")
                .and_then(Value::as_str)
                .unwrap_or(&guid)
                .to_owned(),
            path: None,
            received_bytes: 0,
            total_bytes: 0,
            state: "inProgress".to_owned(),
            reason: None,
            artifact: None,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };
        self.records.lock().await.insert(guid, record.clone());
        Some(record)
    }

    async fn update_progress(
        &self,
        params: &Value,
        artifacts: &ArtifactStore,
        client_id: &str,
    ) -> Option<DownloadRecord> {
        let guid = params.get("guid")?.as_str()?.to_owned();
        let mut records = self.records.lock().await;
        let record = records.get_mut(&guid)?;
        record.received_bytes = number_to_u64(params.get("receivedBytes"));
        record.total_bytes = number_to_u64(params.get("totalBytes"));
        record.updated_at_unix_ms = now_unix_ms();
        match params.get("state").and_then(Value::as_str) {
            Some("completed") => {
                let source = artifacts.root().join(&guid);
                match adopt_completed_download(artifacts, client_id, &source, record) {
                    Ok(artifact) => {
                        record.path = Some(artifact.path.clone());
                        record.artifact = Some(artifact);
                        record.state = "completed".to_owned();
                        record.reason = None;
                    }
                    Err(error) => {
                        record.path = None;
                        record.artifact = None;
                        record.state = "interrupted".to_owned();
                        record.reason = Some(error.to_string());
                    }
                }
            }
            Some("canceled") => {
                record.state = "canceled".to_owned();
                record.reason = Some(
                    params
                        .get("reason")
                        .or_else(|| params.get("errorText"))
                        .and_then(Value::as_str)
                        .unwrap_or("browser_cancelled")
                        .to_owned(),
                );
            }
            Some(other) => {
                record.state = other.to_owned();
            }
            None => {}
        }
        Some(record.clone())
    }

    async fn interrupt_open(&self, reason: &str) -> Vec<DownloadRecord> {
        let now = now_unix_ms();
        let mut records = self.records.lock().await;
        records
            .values_mut()
            .filter_map(|record| {
                (record.state == "inProgress").then(|| {
                    record.state = "interrupted".to_owned();
                    record.reason = Some(reason.to_owned());
                    record.updated_at_unix_ms = now;
                    record.clone()
                })
            })
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn forward_download_events(
    resource_id: String,
    client_id: String,
    mut source: EventSubscription,
    mut cancelled: watch::Receiver<Option<String>>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
    artifacts: Arc<ArtifactStore>,
    browser: Arc<BrowserCore>,
    downloads: Arc<DownloadStore>,
) {
    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                let reason = cancelled.borrow().clone().unwrap_or_else(|| "disposed".to_owned());
                for download in downloads.interrupt_open(&reason).await {
                    emit_download_event(&outbound, &resource_id, &state, "download.updated", download).await;
                }
                release_event_domains(&source).await;
                emit_closed(&outbound, &resource_id, &reason, &state, state.complete()).await;
                return;
            }
            event = source.receiver.recv() => match event {
                Ok(event) if event.method.ends_with("downloadWillBegin") => {
                    let Some(target_id) = download_start_target(&browser, &source, &event).await else {
                        continue;
                    };
                    if let Some(download) = downloads.start(&target_id, &event.params).await {
                        emit_download_event(&outbound, &resource_id, &state, "download.started", download).await;
                    }
                }
                Ok(event) if event.method.ends_with("downloadProgress") => {
                    if let Some(download) = downloads
                        .update_progress(&event.params, &artifacts, &client_id)
                        .await
                    {
                        if download.state == "interrupted" {
                            state.mark_incomplete();
                        }
                        emit_download_event(&outbound, &resource_id, &state, "download.updated", download).await;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    state.mark_incomplete();
                    let message = state.record(
                        &resource_id,
                        "resource.gap".to_owned(),
                        json!({ "lostEvents": count }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    for download in downloads.interrupt_open("browser_event_stream_closed").await {
                        emit_download_event(&outbound, &resource_id, &state, "download.updated", download).await;
                    }
                    release_event_domains(&source).await;
                    emit_closed(
                        &outbound,
                        &resource_id,
                        "browser_event_stream_closed",
                        &state,
                        false,
                    ).await;
                    return;
                }
            },
            lifecycle = source.lifecycle.recv() => match lifecycle {
                Ok(crate::browser::session_manager::SessionLifecycle::Attached(session))
                    if source.target_id.as_deref() == Some(session.root_target_id.as_str()) =>
                {
                    if acquire_session_domains(&mut source, &session.session_id).await {
                        source.session_ids.insert(session.session_id);
                    } else {
                        state.mark_incomplete();
                        let message = state.record(
                            &resource_id,
                            "resource.gap".to_owned(),
                            json!({ "reason": "new_session_domain_enable_failed" }),
                        ).await;
                        emit(&outbound, DaemonMessage::ResourceEvent(message));
                    }
                }
                Ok(crate::browser::session_manager::SessionLifecycle::Detached {
                    session_id,
                    root_target_id,
                    ..
                }) if source.target_id.as_deref() == Some(root_target_id.as_str()) => {
                    source.session_ids.remove(&session_id);
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
            }
        }
    }
}

async fn emit_download_event(
    outbound: &ClientOutbound,
    resource_id: &str,
    state: &ResourceState,
    method: &str,
    download: DownloadRecord,
) {
    let artifact = download.artifact.clone();
    let message = state
        .record(
            resource_id,
            method.to_owned(),
            json!({
                "method": method,
                "params": download,
                "sessionId": null,
                "artifact": artifact
            }),
        )
        .await;
    emit(outbound, DaemonMessage::ResourceEvent(message));
}

async fn download_start_target(
    browser: &BrowserCore,
    source: &EventSubscription,
    event: &crate::agent_browser_engine::cdp::types::CdpEvent,
) -> Option<String> {
    if let Some(target_id) = source.target_id.as_deref() {
        if let Some(session_id) = event.session_id.as_deref() {
            return source
                .session_ids
                .contains(session_id)
                .then(|| target_id.to_owned());
        }
        let frame_id = event.params.get("frameId").and_then(Value::as_str)?;
        return browser
            .frames(target_id)
            .await
            .is_ok_and(|frames| frames.iter().any(|frame| frame.id == frame_id))
            .then(|| target_id.to_owned());
    }
    browser
        .root_target_for_event(
            event.session_id.as_deref(),
            event.params.get("frameId").and_then(Value::as_str),
        )
        .await
}

async fn acquire_session_domains(source: &mut EventSubscription, session_id: &str) -> bool {
    for domain in &source.domains {
        if source
            .leases
            .acquire(session_id, domain, &source.owner_id)
            .await
            .is_err()
        {
            for acquired in &source.domains {
                let _ = source
                    .leases
                    .release(session_id, acquired, &source.owner_id)
                    .await;
                if acquired == domain {
                    break;
                }
            }
            return false;
        }
    }
    true
}

fn adopt_completed_download(
    artifacts: &ArtifactStore,
    client_id: &str,
    source: &Path,
    record: &DownloadRecord,
) -> AbResult<DownloadArtifact> {
    let descriptor = artifacts.adopt(client_id, source, "download", "application/octet-stream")?;
    if record.total_bytes > 0 && descriptor.bytes != record.total_bytes {
        let _ = artifacts.dispose(client_id, &descriptor.id);
        return Err(AbError::new(
            "download_size_mismatch",
            "resource.download.verify",
            format!(
                "download {} reported {} bytes but committed {} bytes",
                record.guid, record.total_bytes, descriptor.bytes
            ),
        ));
    }
    Ok(DownloadArtifact::from_descriptor(
        record.suggested_filename.clone(),
        descriptor,
    ))
}

fn number_to_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
        })
        .unwrap_or_default()
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
