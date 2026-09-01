use super::network::{retain_network_body, BodyKey, NetworkBodyStore};
use super::state::ResourceState;
use super::ClientOutbound;
use crate::artifacts::ArtifactStore;
use crate::browser::{BrowserCore, EventSubscription};
use crate::error::{AbError, AbResult};
use ab_protocol::{DaemonMessage, ResourceClosed};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinSet;

const NETWORK_BODY_CAPTURE_CONCURRENCY: usize = 64;

#[allow(clippy::too_many_arguments)]
pub(super) async fn forward_events(
    resource_id: String,
    client_id: String,
    kind: String,
    mut source: EventSubscription,
    mut cancelled: watch::Receiver<Option<String>>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
    artifacts: Arc<ArtifactStore>,
    browser: Arc<BrowserCore>,
    network_bodies: Option<Arc<Mutex<NetworkBodyStore>>>,
) {
    let body_capture_slots = Arc::new(Semaphore::new(NETWORK_BODY_CAPTURE_CONCURRENCY));
    let mut body_capture_tasks = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                let reason = cancelled.borrow().clone().unwrap_or_else(|| "disposed".to_owned());
                abort_body_capture_tasks(&mut body_capture_tasks).await;
                release_event_domains(&source).await;
                emit_closed(
                    &outbound,
                    &resource_id,
                    &reason,
                    &state,
                    state.complete(),
                ).await;
                return;
            }
            event = source.receiver.recv() => match event {
                Ok(event) => {
                    if !event_matches(&kind, &source.session_ids, &event) {
                        continue;
                    }
                    if kind == "network" {
                        if let (Some(store), Some(session_id), Some(request_id)) = (
                            network_bodies.as_ref(),
                            event.session_id.as_deref(),
                            event.params.get("requestId").and_then(Value::as_str),
                        ) {
                            let key = BodyKey {
                                session_id: session_id.to_owned(),
                                request_id: request_id.to_owned(),
                            };
                            match event.method.as_str() {
                                "Network.responseReceived" => {
                                    let media_type = event
                                        .params
                                        .pointer("/response/mimeType")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned);
                                    let resource_type = event.params.get("type").and_then(Value::as_str);
                                    store.lock().await.mark_pending(key, media_type, resource_type);
                                }
                                "Network.loadingFinished" => {
                                    if !store.lock().await.should_capture(&key) {
                                        continue;
                                    }
                                    let browser = Arc::clone(&browser);
                                    let artifacts = Arc::clone(&artifacts);
                                    let store = Arc::clone(store);
                                    let client_id = client_id.clone();
                                    let slots = Arc::clone(&body_capture_slots);
                                    body_capture_tasks.spawn(async move {
                                        let Ok(_permit) = slots.acquire_owned().await else {
                                            return;
                                        };
                                        retain_network_body(
                                            &browser,
                                            &artifacts,
                                            &store,
                                            &client_id,
                                            key,
                                        )
                                        .await;
                                    });
                                }
                                "Network.loadingFailed" => {
                                    let reason = event
                                        .params
                                        .get("errorText")
                                        .and_then(Value::as_str)
                                        .unwrap_or("loading_failed");
                                    store.lock().await.mark_unavailable(key, reason);
                                }
                                _ => {}
                            }
                        }
                    }
                    let message = state.record(
                        &resource_id,
                        event.method.clone(),
                        json!({
                            "method": event.method,
                            "params": event.params,
                            "sessionId": event.session_id,
                            "artifact": null
                        }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
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
                    abort_body_capture_tasks(&mut body_capture_tasks).await;
                    release_event_domains(&source).await;
                    state.mark_incomplete();
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
                    let mut acquired = true;
                    for domain in &source.domains {
                        if source
                            .leases
                            .acquire_with_params(
                                &session.session_id,
                                domain,
                                &source.owner_id,
                                source
                                    .domain_params
                                    .get(domain)
                                    .cloned()
                                    .unwrap_or_else(|| json!({})),
                            )
                            .await
                            .is_err()
                        {
                            acquired = false;
                            break;
                        }
                    }
                    if acquired {
                        source.session_ids.insert(session.session_id);
                    } else {
                        for domain in &source.domains {
                            let _ = source
                                .leases
                                .release(&session.session_id, domain, &source.owner_id)
                                .await;
                        }
                        state.mark_incomplete();
                        let message = state.record(
                            &resource_id,
                            "resource.gap".to_owned(),
                            json!({ "reason": "new_session_domain_enable_failed" }),
                        ).await;
                        emit(&outbound, DaemonMessage::ResourceEvent(message));
                    }
                }
                Ok(crate::browser::session_manager::SessionLifecycle::Detached { session_id, root_target_id, .. })
                    if source.target_id.as_deref() == Some(root_target_id.as_str()) =>
                {
                    source.session_ids.remove(&session_id);
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
            },
            completed = body_capture_tasks.join_next(), if !body_capture_tasks.is_empty() => {
                if completed.is_some_and(|result| result.is_err()) {
                    state.mark_incomplete();
                    let message = state.record(
                        &resource_id,
                        "resource.gap".to_owned(),
                        json!({ "reason": "network_body_capture_task_failed" }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
            },
        }
    }
}

async fn abort_body_capture_tasks(tasks: &mut JoinSet<()>) {
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

pub(super) async fn release_event_domains(source: &EventSubscription) {
    for session_id in &source.session_ids {
        for domain in &source.domains {
            let _ = source
                .leases
                .release(session_id, domain, &source.owner_id)
                .await;
        }
    }
}

pub(super) fn domains_for(kind: &str) -> AbResult<&'static [&'static str]> {
    match kind {
        "network" => Ok(&["Network"]),
        "console" => Ok(&["Runtime", "Log"]),
        "download" | "fileChooser" => Ok(&["Page"]),
        _ => Err(AbError::new(
            "unsupported_resource_kind",
            "resource.open.kind",
            format!("unsupported resource kind {kind}"),
        )),
    }
}

fn event_matches(
    kind: &str,
    sessions: &std::collections::HashSet<String>,
    event: &crate::agent_browser_engine::cdp::types::CdpEvent,
) -> bool {
    let session_matches = event
        .session_id
        .as_ref()
        .is_some_and(|session| sessions.contains(session));
    match kind {
        "network" => session_matches && event.method.starts_with("Network."),
        "console" => {
            session_matches
                && matches!(
                    event.method.as_str(),
                    "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" | "Log.entryAdded"
                )
        }
        "dialog" => {
            session_matches
                && matches!(
                    event.method.as_str(),
                    "Page.javascriptDialogOpening" | "Page.javascriptDialogClosed"
                )
        }
        "fileChooser" => session_matches && event.method == "Page.fileChooserOpened",
        _ => false,
    }
}

pub(super) async fn emit_closed(
    outbound: &ClientOutbound,
    resource_id: &str,
    reason: &str,
    state: &ResourceState,
    complete: bool,
) {
    let lifecycle = state.close(reason, complete).await;
    if !state.claim_closed_emission() {
        return;
    }
    emit(
        outbound,
        DaemonMessage::ResourceClosed(ResourceClosed {
            resource_id: resource_id.to_owned(),
            reason: lifecycle.close_reason.unwrap_or_else(|| reason.to_owned()),
            last_sequence: state.last_sequence(),
            complete: state.complete(),
            closed_at_unix_ms: lifecycle.closed_at_unix_ms.unwrap_or_default(),
        }),
    );
}

pub(super) fn emit(outbound: &ClientOutbound, message: DaemonMessage) {
    if let Ok(value) = serde_json::to_value(message) {
        let _ = outbound.send(value);
    }
}
