use super::session_manager::SessionManager;
use super::target_lane::{TargetLane, TargetState};
use crate::error::{AbError, AbResult};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{watch, Mutex, OwnedMutexGuard};

#[derive(Default)]
struct LaneRegistry {
    lanes: HashMap<String, Arc<TargetLane>>,
    unavailable: HashSet<String>,
}

pub struct BrowserOwner {
    sessions: Arc<SessionManager>,
    lanes: Mutex<LaneRegistry>,
    input_surface: Arc<Mutex<()>>,
}

impl BrowserOwner {
    pub async fn connect(ws_url: &str) -> AbResult<Arc<Self>> {
        Ok(Arc::new(Self {
            sessions: SessionManager::connect(ws_url).await?,
            lanes: Mutex::new(LaneRegistry::default()),
            input_surface: Arc::new(Mutex::new(())),
        }))
    }

    pub fn sessions(&self) -> Arc<SessionManager> {
        Arc::clone(&self.sessions)
    }

    pub fn subscribe_disconnected(&self) -> watch::Receiver<bool> {
        self.sessions.subscribe_disconnected()
    }

    pub async fn lock_target(&self, target_id: &str) -> AbResult<OwnedMutexGuard<TargetState>> {
        if let Some(dialog) = self.sessions.dialog_for_target(target_id).await {
            return Err(dialog_blocked(target_id, &dialog));
        }
        self.lock_target_inner(target_id, false).await
    }

    pub async fn lock_target_for_dialog(
        &self,
        target_id: &str,
    ) -> AbResult<OwnedMutexGuard<TargetState>> {
        self.lock_target_inner(target_id, true).await
    }

    /// Own the one headed-Chrome surface that can reliably receive browser
    /// input. The target remains explicit at the API boundary; this lease only
    /// serializes physical input across tabs and makes that exact target active
    /// before dispatch.
    /// Design evidence:
    /// `docs/evidence/20260902__action-resource-ownership__@codex.md`.
    pub async fn lock_input_surface(&self, target_id: &str) -> AbResult<OwnedMutexGuard<()>> {
        let guard = Arc::clone(&self.input_surface).lock_owned().await;
        self.sessions.target(target_id).await?;
        self.sessions
            .client()
            .send_command(
                "Target.activateTarget",
                Some(json!({ "targetId": target_id })),
                None,
            )
            .await
            .map_err(|message| {
                AbError::new(
                    "target_activation_failed",
                    "browser_owner.input_surface.activate",
                    message,
                )
            })?;
        Ok(guard)
    }

    async fn lock_target_inner(
        &self,
        target_id: &str,
        allow_dialog: bool,
    ) -> AbResult<OwnedMutexGuard<TargetState>> {
        self.sessions.target(target_id).await?;
        let lane = {
            let mut registry = self.lanes.lock().await;
            if registry.unavailable.contains(target_id) {
                return Err(target_gone(target_id));
            }
            Arc::clone(
                registry
                    .lanes
                    .entry(target_id.to_owned())
                    .or_insert_with(|| Arc::new(TargetLane::new())),
            )
        };
        let guard = Arc::clone(&lane.state).lock_owned().await;
        if self.lanes.lock().await.unavailable.contains(target_id) {
            return Err(target_gone(target_id));
        }
        if !allow_dialog {
            if let Some(dialog) = self.sessions.dialog_for_target(target_id).await {
                drop(guard);
                return Err(dialog_blocked(target_id, &dialog));
            }
        }
        Ok(guard)
    }

    pub async fn close_target(&self, target_id: &str) -> AbResult<()> {
        let lane = {
            let mut registry = self.lanes.lock().await;
            registry.unavailable.insert(target_id.to_owned());
            registry.lanes.get(target_id).cloned()
        };
        let _guard = if let Some(lane) = lane {
            Some(Arc::clone(&lane.state).lock_owned().await)
        } else {
            None
        };
        self.sessions.close_tab(target_id).await?;
        self.lanes.lock().await.lanes.remove(target_id);
        Ok(())
    }
}

fn dialog_blocked(target_id: &str, dialog: &super::session_manager::OpenDialog) -> AbError {
    AbError::new(
        "dialog_blocked",
        "browser_owner.target_lane",
        format!(
            "tab {target_id} is blocked by an open {} dialog",
            dialog.dialog_type
        ),
    )
    .with_details(serde_json::json!({
        "dialogId": dialog.id,
        "sessionId": dialog.session_id,
        "type": dialog.dialog_type,
        "message": dialog.message
    }))
}

fn target_gone(target_id: &str) -> AbError {
    AbError::new(
        "target_gone",
        "browser_owner.target_lane",
        format!("tab {target_id} is closing or closed"),
    )
}
