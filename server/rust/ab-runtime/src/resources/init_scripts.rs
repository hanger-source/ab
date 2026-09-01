use super::events::{emit, emit_closed};
use super::state::ResourceState;
use super::ClientOutbound;
use crate::browser::init_scripts::InitScriptSubscription;
use ab_protocol::DaemonMessage;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::watch;

pub(super) async fn forward_init_script_events(
    resource_id: String,
    mut source: InitScriptSubscription,
    mut cancelled: watch::Receiver<Option<String>>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
) {
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
                Ok(event) if event.registration_id == resource_id => {
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
                        "init_script_event_stream_closed",
                        &state,
                        false,
                    ).await;
                    return;
                }
            }
        }
    }
}
