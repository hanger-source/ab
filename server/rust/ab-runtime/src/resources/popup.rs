use super::events::{emit, emit_closed};
use super::state::ResourceState;
use super::ClientOutbound;
use crate::browser::session_manager::SessionLifecycle;
use ab_protocol::DaemonMessage;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};

/// Publishes ready child page targets created by one exact opener. The
/// subscription is established before the triggering action, so a fast popup
/// cannot be lost between an action result and a later tabs.list() diff.
///
/// Design evidence:
/// `docs/evidence/20260902__client-target-ownership-and-popup-expectation__@codex.md`.
pub(super) async fn forward_popup_events(
    resource_id: String,
    opener_id: String,
    mut lifecycle: broadcast::Receiver<SessionLifecycle>,
    mut cancelled: watch::Receiver<Option<String>>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
) {
    let mut children = HashSet::new();
    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                let reason = cancelled.borrow().clone().unwrap_or_else(|| "disposed".to_owned());
                emit_closed(&outbound, &resource_id, &reason, &state, state.complete()).await;
                return;
            }
            event = lifecycle.recv() => match event {
                Ok(SessionLifecycle::Attached(target))
                    if target.target_id == target.root_target_id
                        && target.opener_id.as_deref() == Some(opener_id.as_str()) =>
                {
                    if !children.insert(target.target_id.clone()) {
                        continue;
                    }
                    let message = state.record(
                        &resource_id,
                        "Target.targetCreated".to_owned(),
                        json!({
                            "method": "Target.targetCreated",
                            "params": {
                                "targetId": target.target_id,
                                "openerId": opener_id,
                                "url": target.url,
                                "title": target.title,
                                "type": target.target_type,
                            },
                            "sessionId": target.session_id,
                            "artifact": null
                        }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
                Ok(SessionLifecycle::Detached { root_target_id, is_root: true, .. })
                    if children.remove(&root_target_id) =>
                {
                    let message = state.record(
                        &resource_id,
                        "Target.targetDestroyed".to_owned(),
                        json!({
                            "method": "Target.targetDestroyed",
                            "params": { "targetId": root_target_id },
                            "sessionId": null,
                            "artifact": null
                        }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    state.mark_incomplete();
                    let message = state.record(
                        &resource_id,
                        "resource.gap".to_owned(),
                        json!({ "lostEvents": count }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
                }
                Err(broadcast::error::RecvError::Closed) => {
                    state.mark_incomplete();
                    emit_closed(
                        &outbound,
                        &resource_id,
                        "target_event_stream_closed",
                        &state,
                        false,
                    ).await;
                    return;
                }
            }
        }
    }
}
