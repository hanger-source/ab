use crate::artifacts::{ArtifactDescriptor, ArtifactStore};
use crate::browser::BrowserCore;
use crate::error::{AbError, AbResult};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::Mutex;

const DEFAULT_BODY_RETENTION_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_BODY_MEMORY_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_CDP_BUFFER_BYTES: u64 = 100 * 1024 * 1024;
const INLINE_BODY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct BodyKey {
    pub session_id: String,
    pub request_id: String,
}

#[derive(Clone)]
enum BodyState {
    Pending { media_type: Option<String> },
    Available(RetainedBody),
    Unavailable { reason: String },
    Ignored,
}

#[derive(Clone)]
struct RetainedBody {
    body: Option<String>,
    base64_encoded: bool,
    bytes: u64,
    artifact: Option<ArtifactDescriptor>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyStorageMode {
    Auto,
    Artifact,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyCaptureMode {
    All,
    Text,
}

#[derive(Clone, Copy)]
enum BodyStorageReservation {
    Inline(u64),
    Artifact,
}

pub(super) struct NetworkBodyStore {
    states: HashMap<BodyKey, BodyState>,
    retained_order: VecDeque<BodyKey>,
    retained_bytes: u64,
    inline_bytes: u64,
    reserved_inline_bytes: u64,
    retention_bytes: u64,
    memory_bytes: u64,
    max_body_bytes: u64,
    cdp_buffer_bytes: u64,
    storage_mode: BodyStorageMode,
    capture_mode: BodyCaptureMode,
}

impl NetworkBodyStore {
    pub(super) fn new(params: &Value) -> AbResult<Self> {
        let retention_bytes =
            positive_budget(params, "bodyRetentionBytes", DEFAULT_BODY_RETENTION_BYTES)?;
        let memory_bytes = positive_budget(params, "bodyMemoryBytes", DEFAULT_BODY_MEMORY_BYTES)?;
        let max_body_bytes = positive_budget(params, "maxBodyBytes", DEFAULT_MAX_BODY_BYTES)?;
        let cdp_buffer_bytes = positive_budget(params, "cdpBufferBytes", DEFAULT_CDP_BUFFER_BYTES)?;
        if max_body_bytes > retention_bytes {
            return Err(AbError::new(
                "invalid_argument",
                "resource.network.body_budget",
                "maxBodyBytes cannot exceed bodyRetentionBytes",
            ));
        }
        if memory_bytes > retention_bytes {
            return Err(AbError::new(
                "invalid_argument",
                "resource.network.body_budget",
                "bodyMemoryBytes cannot exceed bodyRetentionBytes",
            ));
        }
        if max_body_bytes > cdp_buffer_bytes {
            return Err(AbError::new(
                "invalid_argument",
                "resource.network.cdp_buffer",
                "maxBodyBytes cannot exceed cdpBufferBytes",
            ));
        }
        let storage_mode = match params
            .get("bodyStorage")
            .and_then(Value::as_str)
            .unwrap_or("auto")
        {
            "auto" => BodyStorageMode::Auto,
            "artifact" => BodyStorageMode::Artifact,
            value => {
                return Err(AbError::new(
                    "invalid_argument",
                    "resource.network.body_storage",
                    format!("unsupported bodyStorage {value}"),
                ))
            }
        };
        let capture_mode = match params
            .get("bodyCapture")
            .and_then(Value::as_str)
            .unwrap_or("all")
        {
            "all" => BodyCaptureMode::All,
            "text" => BodyCaptureMode::Text,
            value => {
                return Err(AbError::new(
                    "invalid_argument",
                    "resource.network.body_capture",
                    format!("unsupported bodyCapture {value}"),
                ))
            }
        };
        Ok(Self {
            states: HashMap::new(),
            retained_order: VecDeque::new(),
            retained_bytes: 0,
            inline_bytes: 0,
            reserved_inline_bytes: 0,
            retention_bytes,
            memory_bytes,
            max_body_bytes,
            cdp_buffer_bytes,
            storage_mode,
            capture_mode,
        })
    }

    pub(super) fn domain_enable_params(&self) -> Value {
        json!({
            "maxTotalBufferSize": self.cdp_buffer_bytes,
            "maxResourceBufferSize": self.max_body_bytes,
            "durableMessages": true,
        })
    }

    pub(super) fn response(&self, key: &BodyKey) -> AbResult<Value> {
        match self.states.get(key).cloned() {
            Some(BodyState::Available(body)) => Ok(json!({
                "body": body.body,
                "base64Encoded": body.base64_encoded,
                "bytes": body.bytes,
                "artifact": body.artifact
            })),
            Some(BodyState::Pending { .. }) => Err(AbError::new(
                "network_body_pending",
                "resource.network.response_body",
                "response body has not reached loadingFinished",
            )),
            Some(BodyState::Unavailable { reason }) => Err(AbError::new(
                "network_body_unavailable",
                "resource.network.response_body",
                format!("response body is unavailable: {reason}"),
            )
            .with_details(json!({ "reason": reason }))),
            Some(BodyState::Ignored) => Err(AbError::new(
                "network_body_not_captured",
                "resource.network.response_body",
                "response body was excluded by this observer's bodyCapture policy",
            )),
            None => Err(AbError::new(
                "network_body_not_observed",
                "resource.network.response_body",
                "request was not observed by this network resource",
            )),
        }
    }

    pub(super) fn mark_pending(
        &mut self,
        key: BodyKey,
        media_type: Option<String>,
        resource_type: Option<&str>,
    ) {
        let capture = self.capture_mode == BodyCaptureMode::All
            || matches!(resource_type, Some("Document" | "XHR" | "Fetch"))
            || media_type
                .as_deref()
                .is_some_and(|value| value.contains("json") || value.starts_with("text/"));
        self.states.entry(key).or_insert_with(|| {
            if capture {
                BodyState::Pending { media_type }
            } else {
                BodyState::Ignored
            }
        });
    }

    pub(super) fn should_capture(&self, key: &BodyKey) -> bool {
        matches!(self.states.get(key), Some(BodyState::Pending { .. }))
    }

    pub(super) fn mark_unavailable(&mut self, key: BodyKey, reason: impl Into<String>) {
        self.remove_retained(&key);
        self.states.insert(
            key,
            BodyState::Unavailable {
                reason: reason.into(),
            },
        );
    }

    fn reserve_storage(&mut self, bytes: u64) -> BodyStorageReservation {
        if self.storage_mode == BodyStorageMode::Artifact
            || bytes > INLINE_BODY_BYTES
            || self
                .inline_bytes
                .saturating_add(self.reserved_inline_bytes)
                .saturating_add(bytes)
                > self.memory_bytes
        {
            return BodyStorageReservation::Artifact;
        }
        self.reserved_inline_bytes = self.reserved_inline_bytes.saturating_add(bytes);
        BodyStorageReservation::Inline(bytes)
    }

    fn release_reservation(&mut self, reservation: BodyStorageReservation) {
        if let BodyStorageReservation::Inline(bytes) = reservation {
            self.reserved_inline_bytes = self.reserved_inline_bytes.saturating_sub(bytes);
        }
    }

    fn retain(
        &mut self,
        key: BodyKey,
        body: RetainedBody,
        reservation: BodyStorageReservation,
    ) -> Vec<ArtifactDescriptor> {
        self.release_reservation(reservation);
        self.remove_retained(&key);
        let mut evicted_artifacts = Vec::new();
        while self.retained_bytes.saturating_add(body.bytes) > self.retention_bytes {
            let Some(evicted) = self.retained_order.pop_front() else {
                break;
            };
            if let Some(BodyState::Available(previous)) = self.states.get(&evicted) {
                self.retained_bytes = self.retained_bytes.saturating_sub(previous.bytes);
                if previous.body.is_some() {
                    self.inline_bytes = self.inline_bytes.saturating_sub(previous.bytes);
                }
                if let Some(artifact) = previous.artifact.clone() {
                    evicted_artifacts.push(artifact);
                }
            }
            self.states.insert(
                evicted,
                BodyState::Unavailable {
                    reason: "evicted_by_body_budget".to_owned(),
                },
            );
        }
        self.retained_bytes = self.retained_bytes.saturating_add(body.bytes);
        if body.body.is_some() {
            self.inline_bytes = self.inline_bytes.saturating_add(body.bytes);
        }
        self.retained_order.push_back(key.clone());
        self.states.insert(key, BodyState::Available(body));
        evicted_artifacts
    }

    fn remove_retained(&mut self, key: &BodyKey) {
        if let Some(BodyState::Available(previous)) = self.states.get(key) {
            self.retained_bytes = self.retained_bytes.saturating_sub(previous.bytes);
            if previous.body.is_some() {
                self.inline_bytes = self.inline_bytes.saturating_sub(previous.bytes);
            }
        }
        self.retained_order.retain(|candidate| candidate != key);
    }
}

pub(super) async fn retain_network_body(
    browser: &BrowserCore,
    artifacts: &Arc<ArtifactStore>,
    store: &Arc<Mutex<NetworkBodyStore>>,
    client_id: &str,
    key: BodyKey,
) {
    let (max_body_bytes, media_type) = {
        let mut bodies = store.lock().await;
        let media_type = match bodies.states.get(&key) {
            Some(BodyState::Pending { media_type }) => media_type.clone(),
            Some(BodyState::Available(_)) => return,
            Some(BodyState::Unavailable { .. }) => return,
            None => {
                bodies.mark_pending(key.clone(), None, None);
                None
            }
            Some(BodyState::Ignored) => return,
        };
        (bodies.max_body_bytes, media_type)
    };
    let response = match browser
        .raw_cdp_session(
            &key.session_id,
            "Network.getResponseBody",
            json!({ "requestId": key.request_id }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            store
                .lock()
                .await
                .mark_unavailable(key, format!("cdp_get_response_body_failed:{error}"));
            return;
        }
    };
    let Some(body) = response
        .get("body")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        store
            .lock()
            .await
            .mark_unavailable(key, "cdp_response_missing_body");
        return;
    };
    let base64_encoded = response
        .get("base64Encoded")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let decoded = if base64_encoded {
        match base64::engine::general_purpose::STANDARD.decode(&body) {
            Ok(value) => value,
            Err(error) => {
                store
                    .lock()
                    .await
                    .mark_unavailable(key, format!("invalid_base64_body:{error}"));
                return;
            }
        }
    } else {
        body.as_bytes().to_vec()
    };
    let bytes = decoded.len() as u64;
    if bytes > max_body_bytes {
        store
            .lock()
            .await
            .mark_unavailable(key, format!("body_too_large:{bytes}>{max_body_bytes}"));
        return;
    }
    let reservation = store.lock().await.reserve_storage(bytes);
    let artifact = if matches!(reservation, BodyStorageReservation::Artifact) {
        let artifacts = artifacts.clone();
        let client_id = client_id.to_owned();
        let media_type = media_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let encoding = if base64_encoded { "binary" } else { "utf-8" }.to_owned();
        match tokio::task::spawn_blocking(move || {
            artifacts.write_with_encoding(
                &client_id,
                if encoding == "utf-8" { "txt" } else { "bin" },
                &media_type,
                &encoding,
                &decoded,
            )
        })
        .await
        {
            Ok(Ok(descriptor)) => Some(descriptor),
            Ok(Err(error)) => {
                store
                    .lock()
                    .await
                    .mark_unavailable(key, format!("artifact_write_failed:{error}"));
                return;
            }
            Err(error) => {
                store
                    .lock()
                    .await
                    .mark_unavailable(key, format!("artifact_task_failed:{error}"));
                return;
            }
        }
    } else {
        None
    };
    let evicted_artifacts = store.lock().await.retain(
        key,
        RetainedBody {
            body: artifact.is_none().then_some(body),
            base64_encoded,
            bytes,
            artifact,
        },
        reservation,
    );
    for artifact in evicted_artifacts {
        let _ = artifacts.dispose(client_id, &artifact.id);
    }
}

fn positive_budget(params: &Value, field: &str, default: u64) -> AbResult<u64> {
    match params.get(field) {
        None => Ok(default),
        Some(value) => value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
            AbError::new(
                "invalid_argument",
                format!("resource.network.{field}"),
                format!("{field} must be a positive integer"),
            )
        }),
    }
}
