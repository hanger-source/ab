use super::events::{emit, emit_closed};
use super::state::ResourceState;
use super::ClientOutbound;
use crate::browser::session_manager::DialogLifecycle;
use crate::browser::DialogSubscription;
use ab_protocol::DaemonMessage;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::watch;

pub(super) async fn forward_dialog_events(
    resource_id: String,
    mut source: DialogSubscription,
    mut cancelled: watch::Receiver<Option<String>>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
) {
    let mut active = HashSet::new();
    for dialog in source.initial.drain(..) {
        active.insert(dialog.id.clone());
        emit_opened(&outbound, &resource_id, &state, dialog).await;
    }
    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                let reason = cancelled.borrow().clone().unwrap_or_else(|| "disposed".to_owned());
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
                Ok(DialogLifecycle::Opened(dialog))
                    if dialog.root_target_id == source.target_id =>
                {
                    if active.insert(dialog.id.clone()) {
                        emit_opened(&outbound, &resource_id, &state, dialog).await;
                    }
                }
                Ok(DialogLifecycle::Closed {
                    dialog,
                    accepted,
                    user_input,
                    reason,
                }) if dialog.root_target_id == source.target_id =>
                {
                    if !active.remove(&dialog.id) {
                        continue;
                    }
                    let session_id = dialog.session_id.clone();
                    let message = state.record(
                        &resource_id,
                        "Page.javascriptDialogClosed".to_owned(),
                        json!({
                            "method": "Page.javascriptDialogClosed",
                            "params": {
                                "dialogId": dialog.id,
                                "sessionId": dialog.session_id,
                                "result": accepted,
                                "userInput": user_input,
                                "reason": reason
                            },
                            "sessionId": session_id,
                            "artifact": null
                        }),
                    ).await;
                    emit(&outbound, DaemonMessage::ResourceEvent(message));
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
                    state.mark_incomplete();
                    emit_closed(
                        &outbound,
                        &resource_id,
                        "dialog_event_stream_closed",
                        &state,
                        false,
                    ).await;
                    return;
                }
            }
        }
    }
}

async fn emit_opened(
    outbound: &ClientOutbound,
    resource_id: &str,
    state: &ResourceState,
    dialog: crate::browser::session_manager::OpenDialog,
) {
    let session_id = dialog.session_id.clone();
    let message = state
        .record(
            resource_id,
            "Page.javascriptDialogOpening".to_owned(),
            json!({
                "method": "Page.javascriptDialogOpening",
                "params": dialog,
                "sessionId": session_id,
                "artifact": null
            }),
        )
        .await;
    emit(outbound, DaemonMessage::ResourceEvent(message));
}
