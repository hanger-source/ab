use super::domain_leases::DomainLeases;
use super::init_scripts::{
    InitScriptDefinition, InitScriptInstance, InitScriptInstanceIdentity, InitScriptRegistry,
    InitScriptSubscription,
};
use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::agent_browser_engine::cdp::types::CdpEvent;
use crate::agent_browser_engine::pointer_action;
use crate::error::{AbError, AbResult};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch, Mutex, Notify, RwLock};
use tokio::time::{timeout, Instant};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct TargetSession {
    pub target_id: String,
    pub opener_id: Option<String>,
    pub session_id: String,
    pub root_target_id: String,
    pub parent_session_id: Option<String>,
    pub target_type: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct FrameState {
    pub id: String,
    pub root_target_id: String,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub url: String,
    pub name: Option<String>,
    pub document_generation: String,
}

#[derive(Debug, Clone)]
pub struct RealmState {
    pub id: String,
    pub execution_context_id: i64,
    pub root_target_id: String,
    pub target_id: String,
    pub session_id: String,
    pub frame_id: Option<String>,
    pub origin: String,
    pub name: String,
    pub kind: String,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub enum SessionLifecycle {
    Attached(TargetSession),
    Detached {
        session_id: String,
        root_target_id: String,
        is_root: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDialog {
    pub id: String,
    pub root_target_id: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub dialog_type: String,
    pub message: String,
    pub url: String,
    pub default_prompt: String,
    pub has_browser_handler: bool,
}

#[derive(Debug, Clone)]
pub enum DialogLifecycle {
    Opened(OpenDialog),
    Closed {
        dialog: OpenDialog,
        accepted: Option<bool>,
        user_input: Option<String>,
        reason: String,
    },
}

#[derive(Default)]
struct RegistryState {
    targets: HashMap<String, TargetSession>,
    sessions: HashMap<String, String>,
    ready_sessions: HashSet<String>,
    frames: HashMap<String, FrameState>,
    realms: HashMap<String, RealmState>,
    dialogs: HashMap<String, OpenDialog>,
}

pub struct SessionManager {
    client: Arc<CdpClient>,
    domains: Arc<DomainLeases>,
    state: RwLock<RegistryState>,
    init_scripts: Arc<InitScriptRegistry>,
    pending_init_bindings: Mutex<Vec<CdpEvent>>,
    lifecycle: broadcast::Sender<SessionLifecycle>,
    dialog_lifecycle: broadcast::Sender<DialogLifecycle>,
    feature_owners: Mutex<HashMap<(String, String), HashSet<String>>>,
    changed: Notify,
}

impl SessionManager {
    pub async fn connect(ws_url: &str) -> AbResult<Arc<Self>> {
        let client = Arc::new(
            CdpClient::connect(ws_url)
                .await
                .map_err(|message| session_error("connect", message))?,
        );
        let domains = Arc::new(DomainLeases::new(Arc::clone(&client)));
        let (lifecycle, _) = broadcast::channel(1024);
        let (dialog_lifecycle, _) = broadcast::channel(256);
        let init_scripts = InitScriptRegistry::new(Arc::clone(&client));
        let manager = Arc::new(Self {
            client,
            domains,
            state: RwLock::new(RegistryState::default()),
            init_scripts,
            pending_init_bindings: Mutex::new(Vec::new()),
            lifecycle,
            dialog_lifecycle,
            feature_owners: Mutex::new(HashMap::new()),
            changed: Notify::new(),
        });
        manager.spawn_event_pump();
        manager.bootstrap().await?;
        Ok(manager)
    }

    pub fn client(&self) -> Arc<CdpClient> {
        Arc::clone(&self.client)
    }

    pub fn domains(&self) -> Arc<DomainLeases> {
        Arc::clone(&self.domains)
    }

    pub fn subscribe_lifecycle(&self) -> broadcast::Receiver<SessionLifecycle> {
        self.lifecycle.subscribe()
    }

    pub fn subscribe_dialogs(&self) -> broadcast::Receiver<DialogLifecycle> {
        self.dialog_lifecycle.subscribe()
    }

    pub fn subscribe_browser_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.client.subscribe()
    }

    pub fn subscribe_disconnected(&self) -> watch::Receiver<bool> {
        self.client.subscribe_disconnected()
    }

    pub async fn session_belongs_to_root(&self, session_id: &str, target_id: &str) -> bool {
        self.root_for_session(session_id).await.as_deref() == Some(target_id)
    }

    pub async fn root_target_for_session(&self, session_id: &str) -> Option<String> {
        self.root_for_session(session_id).await
    }

    pub async fn root_target_for_frame(&self, frame_id: &str) -> Option<String> {
        self.state
            .read()
            .await
            .frames
            .get(frame_id)
            .map(|frame| frame.root_target_id.clone())
    }

    pub async fn acquire_feature(
        &self,
        target_id: &str,
        feature: &str,
        owner: &str,
    ) -> AbResult<()> {
        self.target(target_id).await?;
        assert_supported_feature(feature)?;
        let key = (target_id.to_owned(), feature.to_owned());
        let should_enable = {
            let mut owners = self.feature_owners.lock().await;
            let feature_owners = owners.entry(key.clone()).or_default();
            if !feature_owners.insert(owner.to_owned()) {
                return Ok(());
            }
            feature_owners.len() == 1
        };
        if !should_enable {
            return Ok(());
        }
        let mut enabled: Vec<String> = Vec::new();
        for session in self.sessions_for_root(target_id).await {
            if let Err(error) = self
                .set_feature_for_session(&session.session_id, feature, true)
                .await
            {
                self.feature_owners.lock().await.remove(&key);
                for session_id in enabled {
                    let _ = self
                        .set_feature_for_session(&session_id, feature, false)
                        .await;
                }
                return Err(error);
            }
            enabled.push(session.session_id);
        }
        Ok(())
    }

    pub async fn release_feature(
        &self,
        target_id: &str,
        feature: &str,
        owner: &str,
    ) -> AbResult<()> {
        assert_supported_feature(feature)?;
        let key = (target_id.to_owned(), feature.to_owned());
        let should_disable = {
            let mut owners = self.feature_owners.lock().await;
            let Some(feature_owners) = owners.get_mut(&key) else {
                return Ok(());
            };
            feature_owners.remove(owner);
            if feature_owners.is_empty() {
                owners.remove(&key);
                true
            } else {
                false
            }
        };
        if should_disable {
            let mut first_error = None;
            for session in self.sessions_for_root(target_id).await {
                if let Err(error) = self
                    .set_feature_for_session(&session.session_id, feature, false)
                    .await
                {
                    first_error.get_or_insert(error);
                }
            }
            if let Some(error) = first_error {
                return Err(error);
            }
        }
        Ok(())
    }

    pub async fn dialog_for_target(&self, target_id: &str) -> Option<OpenDialog> {
        self.state
            .read()
            .await
            .dialogs
            .values()
            .find(|dialog| dialog.root_target_id == target_id)
            .cloned()
    }

    pub async fn dialogs_for_target(&self, target_id: &str) -> Vec<OpenDialog> {
        let mut dialogs = self
            .state
            .read()
            .await
            .dialogs
            .values()
            .filter(|dialog| dialog.root_target_id == target_id)
            .cloned()
            .collect::<Vec<_>>();
        dialogs.sort_by(|left, right| left.id.cmp(&right.id));
        dialogs
    }

    async fn record_dialog_event(
        &self,
        target_id: &str,
        event_session_id: &str,
        params: &Value,
    ) -> AbResult<OpenDialog> {
        self.target(target_id).await?;
        if self.root_for_session(event_session_id).await.as_deref() != Some(target_id) {
            return Err(dialog_stale(
                "unknown",
                "dialog event session is not owned by the target",
            ));
        }
        let session_id = event_session_id.to_owned();
        let mut state = self.state.write().await;
        if let Some(dialog) = state.dialogs.get(&session_id) {
            return Ok(dialog.clone());
        }
        let dialog = OpenDialog {
            id: Uuid::new_v4().to_string(),
            root_target_id: target_id.to_owned(),
            session_id: session_id.clone(),
            dialog_type: params
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            message: params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            default_prompt: params
                .get("defaultPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            has_browser_handler: params
                .get("hasBrowserHandler")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        state.dialogs.insert(session_id, dialog.clone());
        drop(state);
        let _ = self
            .dialog_lifecycle
            .send(DialogLifecycle::Opened(dialog.clone()));
        self.changed.notify_waiters();
        Ok(dialog)
    }

    pub async fn wait_for_dialog(
        &self,
        target_id: &str,
        session_id: Option<&str>,
    ) -> AbResult<OpenDialog> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let notified = self.changed.notified();
            let dialog = self
                .state
                .read()
                .await
                .dialogs
                .values()
                .find(|dialog| {
                    dialog.root_target_id == target_id
                        && session_id.is_none_or(|session_id| dialog.session_id == session_id)
                })
                .cloned();
            if let Some(dialog) = dialog {
                return Ok(dialog);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(AbError::new(
                    "dialog_sync_failed",
                    "dialog.open.event_owner",
                    "action observed a dialog but the persistent SessionManager did not register it",
                ));
            }
        }
    }

    pub async fn wait_for_dialog_closed(&self, dialog_id: &str, session_id: &str) -> AbResult<()> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let notified = self.changed.notified();
            let still_open = self
                .state
                .read()
                .await
                .dialogs
                .get(session_id)
                .is_some_and(|dialog| dialog.id == dialog_id);
            if !still_open {
                return Ok(());
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(AbError::new(
                    "dialog_sync_failed",
                    "dialog.close.event_owner",
                    "Chrome handled the dialog command but SessionManager did not observe its close event",
                ));
            }
        }
    }

    pub async fn exact_dialog(
        &self,
        target_id: &str,
        dialog_id: &str,
        session_id: &str,
    ) -> AbResult<OpenDialog> {
        let dialog = self
            .state
            .read()
            .await
            .dialogs
            .get(session_id)
            .cloned()
            .ok_or_else(|| dialog_stale(dialog_id, "the dialog is no longer open"))?;
        if dialog.root_target_id != target_id || dialog.id != dialog_id {
            return Err(dialog_stale(
                dialog_id,
                "another dialog now owns this browser session",
            ));
        }
        Ok(dialog)
    }

    pub async fn tabs(&self) -> Vec<TargetSession> {
        let state = self.state.read().await;
        let mut tabs = state
            .targets
            .values()
            .filter(|target| {
                target.target_id == target.root_target_id
                    && is_page_target(target)
                    && state.ready_sessions.contains(&target.session_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.target_id.cmp(&right.target_id));
        tabs
    }

    pub async fn target(&self, target_id: &str) -> AbResult<TargetSession> {
        let state = self.state.read().await;
        state
            .targets
            .get(target_id)
            .filter(|target| {
                target.root_target_id == target_id
                    && is_page_target(target)
                    && state.ready_sessions.contains(&target.session_id)
            })
            .cloned()
            .ok_or_else(|| {
                AbError::new(
                    "target_not_found",
                    "session.target",
                    format!("tab {target_id} does not exist"),
                )
            })
    }

    pub async fn target_is_active(&self, target: &TargetSession) -> bool {
        let probe = self.client.send_command(
            "Runtime.evaluate",
            Some(json!({
                "expression": "document.visibilityState === 'visible'",
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(&target.session_id),
        );
        timeout(Duration::from_millis(350), probe)
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|result| result.pointer("/result/value").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    pub async fn active_target_ids(&self, targets: &[TargetSession]) -> HashSet<String> {
        join_all(targets.iter().map(|target| async move {
            (
                target.target_id.clone(),
                self.target_is_active(target).await,
            )
        }))
        .await
        .into_iter()
        .filter_map(|(target_id, active)| active.then_some(target_id))
        .collect()
    }

    pub async fn root_session(&self, target_id: &str) -> AbResult<String> {
        Ok(self.target(target_id).await?.session_id)
    }

    pub async fn sessions_for_root(&self, target_id: &str) -> Vec<TargetSession> {
        let state = self.state.read().await;
        let mut sessions = state
            .targets
            .values()
            .filter(|target| {
                target.root_target_id == target_id
                    && state.ready_sessions.contains(&target.session_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            left.parent_session_id
                .is_some()
                .cmp(&right.parent_session_id.is_some())
                .then_with(|| left.target_id.cmp(&right.target_id))
        });
        sessions
    }

    pub async fn iframe_sessions(&self, target_id: &str) -> HashMap<String, String> {
        self.state
            .read()
            .await
            .targets
            .values()
            .filter(|target| target.root_target_id == target_id && target.target_type == "iframe")
            .map(|target| (target.target_id.clone(), target.session_id.clone()))
            .collect()
    }

    pub async fn frames(&self, target_id: &str) -> Vec<FrameState> {
        let mut frames = self
            .state
            .read()
            .await
            .frames
            .values()
            .filter(|frame| frame.root_target_id == target_id)
            .cloned()
            .collect::<Vec<_>>();
        frames.sort_by(|left, right| left.id.cmp(&right.id));
        frames
    }

    pub async fn ensure_frames(&self, target_id: &str) -> AbResult<Vec<FrameState>> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let sessions = self.sessions_for_root(target_id).await;
            for session in sessions {
                if let Ok(tree) = self
                    .client
                    .send_command_no_params("Page.getFrameTree", Some(&session.session_id))
                    .await
                {
                    self.ingest_frame_tree(target_id, &session.session_id, &tree)
                        .await;
                }
            }
            let frames = self.frames(target_id).await;
            if frames.iter().any(|frame| frame.parent_id.is_none()) {
                return Ok(frames);
            }
            timeout(
                deadline.saturating_duration_since(Instant::now()),
                self.changed.notified(),
            )
            .await
            .map_err(|_| {
                AbError::new(
                    "frame_attach_timeout",
                    "session.frames.wait",
                    format!("tab {target_id} did not expose a root frame"),
                )
            })?;
        }
    }

    pub async fn realms(&self, target_id: &str) -> Vec<RealmState> {
        let mut realms = self
            .state
            .read()
            .await
            .realms
            .values()
            .filter(|realm| realm.root_target_id == target_id)
            .cloned()
            .collect::<Vec<_>>();
        realms.sort_by(|left, right| left.id.cmp(&right.id));
        realms
    }

    pub async fn open_tab(self: &Arc<Self>, url: &str) -> AbResult<TargetSession> {
        let result = self
            .client
            .send_command("Target.createTarget", Some(json!({ "url": url })), None)
            .await
            .map_err(|message| session_error("target.create", message))?;
        let target_id = required_string(&result, "targetId", "target.create")?.to_owned();
        self.wait_for_target(&target_id, Duration::from_secs(10))
            .await
    }

    pub async fn register_init_script(
        &self,
        owner_id: &str,
        target_id: &str,
        definition: InitScriptDefinition,
    ) -> AbResult<InitScriptSubscription> {
        self.target(target_id).await?;
        let subscription = self
            .init_scripts
            .register(owner_id, target_id, definition)
            .await?;
        let sessions = self.sessions_for_root(target_id).await;
        for session in sessions {
            if let Err(error) = self
                .init_scripts
                .install_for_session(owner_id, &session.session_id, true)
                .await
            {
                let _ = self.unregister_init_script(owner_id).await;
                return Err(error);
            }
        }
        Ok(subscription)
    }

    pub async fn unregister_init_script(&self, owner_id: &str) -> AbResult<()> {
        self.init_scripts.unregister(owner_id).await
    }

    pub async fn init_script_instances(&self, owner_id: &str) -> AbResult<Vec<InitScriptInstance>> {
        self.init_scripts.instances(owner_id).await
    }

    pub async fn command_init_script(
        &self,
        owner_id: &str,
        instance_id: &str,
        name: &str,
        payload: Value,
    ) -> AbResult<Value> {
        self.init_scripts
            .command(owner_id, instance_id, name, payload)
            .await
    }

    pub async fn close_tab(&self, target_id: &str) -> AbResult<()> {
        self.target(target_id).await?;
        self.client
            .send_command(
                "Target.closeTarget",
                Some(json!({ "targetId": target_id })),
                None,
            )
            .await
            .map_err(|message| session_error("target.close", message))?;
        self.remove_root(target_id).await;
        Ok(())
    }

    async fn bootstrap(self: &Arc<Self>) -> AbResult<()> {
        self.client
            .send_command(
                "Target.setDiscoverTargets",
                Some(json!({ "discover": true })),
                None,
            )
            .await
            .map_err(|message| session_error("target.discover", message))?;
        self.client
            .send_command(
                "Target.setAutoAttach",
                Some(json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": true,
                    "flatten": true,
                    "filter": [
                        { "type": "page", "exclude": false },
                        { "type": "webview", "exclude": false },
                        { "exclude": true }
                    ]
                })),
                None,
            )
            .await
            .map_err(|message| session_error("target.auto_attach", message))?;
        let targets = self
            .client
            .send_command("Target.getTargets", Some(json!({})), None)
            .await
            .map_err(|message| session_error("target.list", message))?;
        let pages = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|target| track_page_value(target))
            .collect::<Vec<_>>();
        let page_ids = pages
            .iter()
            .filter_map(|target| target.get("targetId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        eprintln!(
            "[ab.session] bootstrap discovered_pages={} target_ids={}",
            pages.len(),
            page_ids.join(",")
        );
        for target in pages.iter().copied() {
            let target_id = required_string(target, "targetId", "target.bootstrap")?;
            let ready = self
                .wait_for_target(target_id, Duration::from_secs(10))
                .await?;
            eprintln!(
                "[ab.session] bootstrap target_ready target_id={} session_id={}",
                ready.target_id, ready.session_id
            );
        }
        if pages.is_empty() {
            self.open_tab("about:blank").await?;
        }
        Ok(())
    }

    async fn attach_existing_page(self: &Arc<Self>, value: &Value) -> AbResult<()> {
        let target_id = required_string(value, "targetId", "target.attach")?.to_owned();
        let result = self
            .client
            .send_command(
                "Target.attachToTarget",
                Some(json!({ "targetId": target_id, "flatten": true })),
                None,
            )
            .await
            .map_err(|message| session_error("target.attach", message))?;
        let session_id = required_string(&result, "sessionId", "target.attach")?.to_owned();
        self.register_target(TargetSession {
            target_id: target_id.clone(),
            opener_id: value
                .get("openerId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            session_id,
            root_target_id: target_id.clone(),
            parent_session_id: None,
            target_type: value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("page")
                .to_owned(),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: value
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
        .await?;

        // Target.attachedToTarget can win the race with this explicit attach and
        // start registration on the event pump. In that case register_target()
        // observes the existing session, but its Page/Runtime/Network bootstrap
        // is still running asynchronously. Browser readiness must not be
        // published until every page discovered during bootstrap is usable.
        let ready = self
            .wait_for_target(&target_id, Duration::from_secs(10))
            .await?;
        eprintln!(
            "[ab.session] bootstrap target_ready target_id={} session_id={}",
            ready.target_id, ready.session_id
        );
        Ok(())
    }

    fn spawn_event_pump(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        let mut receiver = self.client.subscribe();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => manager.handle_event(event).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = manager.resync_targets().await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn handle_event(self: &Arc<Self>, event: CdpEvent) {
        match event.method.as_str() {
            "Target.attachedToTarget" => self.handle_attached(&event).await,
            "Target.detachedFromTarget" => {
                if let Some(session_id) = event.params.get("sessionId").and_then(Value::as_str) {
                    self.remove_session(session_id).await;
                }
            }
            "Target.targetInfoChanged" => self.update_target_info(&event.params).await,
            "Target.targetDestroyed" => {
                if let Some(target_id) = event.params.get("targetId").and_then(Value::as_str) {
                    self.remove_root(target_id).await;
                }
            }
            "Page.frameAttached" | "Page.frameNavigated" => {
                self.update_frame(&event).await;
                self.drain_init_script_bindings().await;
            }
            "Page.frameDetached" => {
                self.remove_frame(&event).await;
            }
            "Runtime.executionContextCreated" => {
                self.update_realm(&event).await;
                self.drain_init_script_bindings().await;
            }
            "Runtime.bindingCalled" => self.update_init_script(&event).await,
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = event
                    .params
                    .get("executionContextId")
                    .and_then(Value::as_i64)
                {
                    if let Some(session_id) = event.session_id.as_deref() {
                        self.init_scripts
                            .context_destroyed(session_id, Some(id))
                            .await;
                        self.state.write().await.realms.retain(|_, realm| {
                            realm.session_id != session_id || realm.execution_context_id != id
                        });
                    }
                }
            }
            "Runtime.executionContextsCleared" => {
                if let Some(session_id) = event.session_id.as_deref() {
                    self.init_scripts.context_destroyed(session_id, None).await;
                    self.state
                        .write()
                        .await
                        .realms
                        .retain(|_, realm| realm.session_id != session_id);
                }
            }
            "Page.javascriptDialogOpening" => self.open_dialog(&event).await,
            "Page.javascriptDialogClosed" => self.close_dialog(&event, "handled").await,
            _ => {}
        }
    }

    async fn open_dialog(&self, event: &CdpEvent) {
        let Some(session_id) = event.session_id.as_deref() else {
            return;
        };
        let Some(root_target_id) = self.root_for_session(session_id).await else {
            return;
        };
        let _ = self
            .record_dialog_event(&root_target_id, session_id, &event.params)
            .await;
    }

    async fn close_dialog(&self, event: &CdpEvent, reason: &str) {
        let Some(session_id) = event.session_id.as_deref() else {
            return;
        };
        let dialog = self.state.write().await.dialogs.remove(session_id);
        if let Some(dialog) = dialog {
            let _ = self.dialog_lifecycle.send(DialogLifecycle::Closed {
                dialog,
                accepted: event.params.get("result").and_then(Value::as_bool),
                user_input: event
                    .params
                    .get("userInput")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                reason: reason.to_owned(),
            });
            self.changed.notify_waiters();
        }
    }

    async fn handle_attached(self: &Arc<Self>, event: &CdpEvent) {
        let Some(session_id) = event.params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let target = event.params.get("targetInfo").unwrap_or(&Value::Null);
        let target_id = target
            .get("targetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target_type = target
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let parent_session_id = event.session_id.clone();
        let root_target_id = if let Some(parent) = parent_session_id.as_deref() {
            self.root_for_session(parent).await
        } else if matches!(target_type, "page" | "webview") {
            Some(target_id.to_owned())
        } else {
            None
        };
        let Some(root_target_id) = root_target_id else {
            let _ = self
                .client
                .send_command_no_params("Runtime.runIfWaitingForDebugger", Some(session_id))
                .await;
            return;
        };
        let record = TargetSession {
            target_id: target_id.to_owned(),
            opener_id: target
                .get("openerId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            session_id: session_id.to_owned(),
            root_target_id,
            parent_session_id,
            target_type: target_type.to_owned(),
            title: target
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: target
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        };
        if !self.begin_register_target(&record).await {
            eprintln!(
                "[ab.session] attach duplicate target_id={} session_id={}",
                record.target_id, record.session_id
            );
            return;
        }
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let _ = manager.finish_register_target(record).await;
        });
    }

    async fn register_target(self: &Arc<Self>, record: TargetSession) -> AbResult<()> {
        if !self.begin_register_target(&record).await {
            return Ok(());
        }
        self.finish_register_target(record).await
    }

    async fn begin_register_target(&self, record: &TargetSession) -> bool {
        let mut state = self.state.write().await;
        if state.sessions.contains_key(&record.session_id) {
            return false;
        }
        state
            .sessions
            .insert(record.session_id.clone(), record.target_id.clone());
        state
            .targets
            .insert(record.target_id.clone(), record.clone());
        true
    }

    async fn finish_register_target(self: &Arc<Self>, record: TargetSession) -> AbResult<()> {
        if let Err(error) = self.initialize_session(&record).await {
            self.remove_session(&record.session_id).await;
            return Err(error);
        }
        self.state
            .write()
            .await
            .ready_sessions
            .insert(record.session_id.clone());
        eprintln!(
            "[ab.session] attach ready target_id={} session_id={} root_target_id={}",
            record.target_id, record.session_id, record.root_target_id
        );
        let _ = self.lifecycle.send(SessionLifecycle::Attached(record));
        self.changed.notify_waiters();
        Ok(())
    }

    async fn initialize_session(&self, record: &TargetSession) -> AbResult<()> {
        let baseline_owner = format!("baseline:{}", record.session_id);
        for domain in ["Page", "Runtime", "Network"] {
            self.domains
                .acquire(&record.session_id, domain, &baseline_owner)
                .await?;
        }
        // Register the new-document gate while an auto-attached OOPIF is still
        // paused, but do not evaluate page code until after
        // Runtime.runIfWaitingForDebugger. Awaiting Runtime.evaluate in a
        // paused child session deadlocks its parent's load. See
        // `docs/evidence/20260902__pointer-action-transaction-and-spa-navigation__@codex.md`.
        // Executable OOPIF coverage:
        // `test/ab/scenarios/oopif-session-registry/README.md`.
        pointer_action::register_for_session(&self.client, &record.session_id)
            .await
            .map_err(|message| session_error("pointer_action.register", message))?;
        let active_features = self
            .feature_owners
            .lock()
            .await
            .keys()
            .filter(|(target_id, _)| target_id == &record.root_target_id)
            .map(|(_, feature)| feature.clone())
            .collect::<Vec<_>>();
        for feature in active_features {
            self.set_feature_for_session(&record.session_id, &feature, true)
                .await?;
        }
        self.client
            .send_command(
                "Target.setAutoAttach",
                Some(json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": true,
                    "flatten": true,
                    "filter": [
                        { "type": "iframe", "exclude": false },
                        { "exclude": true }
                    ]
                })),
                Some(&record.session_id),
            )
            .await
            .map_err(|message| session_error("target.iframe_auto_attach", message))?;
        let script_owners = self
            .init_scripts
            .owners_for_target(&record.root_target_id)
            .await;
        for owner in script_owners {
            self.init_scripts
                .install_for_session(&owner, &record.session_id, false)
                .await?;
        }
        let _ = self
            .client
            .send_command_no_params("Runtime.runIfWaitingForDebugger", Some(&record.session_id))
            .await;
        pointer_action::evaluate_current_for_session(&self.client, &record.session_id)
            .await
            .map_err(|message| session_error("pointer_action.evaluate_current", message))?;
        match self
            .client
            .send_command_no_params("Page.getFrameTree", Some(&record.session_id))
            .await
        {
            Ok(tree) => {
                self.ingest_frame_tree(&record.root_target_id, &record.session_id, &tree)
                    .await;
            }
            Err(message) => {
                eprintln!(
                    "[ab.session] frame_tree unavailable target_id={} session_id={} root_target_id={} error={}",
                    record.target_id, record.session_id, record.root_target_id, message
                );
            }
        }
        for owner in self
            .init_scripts
            .owners_for_target(&record.root_target_id)
            .await
        {
            self.init_scripts
                .evaluate_current_for_session(&owner, &record.session_id)
                .await?;
        }
        Ok(())
    }

    async fn set_feature_for_session(
        &self,
        session_id: &str,
        feature: &str,
        enabled: bool,
    ) -> AbResult<()> {
        match feature {
            "fileChooser" => self
                .client
                .send_command(
                    "Page.setInterceptFileChooserDialog",
                    Some(json!({ "enabled": enabled })),
                    Some(session_id),
                )
                .await
                .map(|_| ())
                .map_err(|message| {
                    session_error(
                        "feature.file_chooser",
                        format!("session {session_id}: {message}"),
                    )
                }),
            _ => Err(unsupported_feature(feature)),
        }
    }

    async fn ingest_frame_tree(&self, root_target_id: &str, session_id: &str, value: &Value) {
        let mut frames = Vec::new();
        collect_frame_tree(
            root_target_id,
            session_id,
            value.get("frameTree"),
            &mut frames,
        );
        let mut state = self.state.write().await;
        let incoming_ids = frames
            .iter()
            .map(|frame| frame.id.clone())
            .collect::<HashSet<_>>();
        state.frames.retain(|frame_id, frame| {
            frame.root_target_id != root_target_id
                || frame.session_id != session_id
                || incoming_ids.contains(frame_id)
        });
        for mut frame in frames {
            if let Some(existing) = state.frames.get(&frame.id) {
                if frame.parent_id.is_none() {
                    frame.parent_id.clone_from(&existing.parent_id);
                }
                let existing_is_oopif = state
                    .sessions
                    .get(&existing.session_id)
                    .and_then(|target_id| state.targets.get(target_id))
                    .is_some_and(|target| target.target_type == "iframe");
                if existing.session_id != session_id && existing_is_oopif {
                    frame.session_id = existing.session_id.clone();
                }
            }
            state.frames.insert(frame.id.clone(), frame);
        }
        drop(state);
        self.drain_init_script_bindings().await;
    }

    async fn update_frame(&self, event: &CdpEvent) {
        let Some(session_id) = event.session_id.as_deref() else {
            return;
        };
        let Some(root_target_id) = self.root_for_session(session_id).await else {
            eprintln!(
                "[ab.session] frame event before registration method={} session_id={}",
                event.method, session_id
            );
            return;
        };
        let frame = event.params.get("frame").unwrap_or(&event.params);
        let Some(frame_id) = frame.get("id").and_then(Value::as_str) else {
            return;
        };
        let parent_id = frame
            .get("parentId")
            .or_else(|| event.params.get("parentFrameId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut state = self.state.write().await;
        if parent_id.is_none() {
            state.frames.retain(|existing_id, existing| {
                existing.root_target_id != root_target_id || existing_id == frame_id
            });
        }
        state.frames.insert(
            frame_id.to_owned(),
            FrameState {
                id: frame_id.to_owned(),
                root_target_id,
                session_id: session_id.to_owned(),
                parent_id,
                url: frame
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: frame.get("name").and_then(Value::as_str).map(str::to_owned),
                document_generation: frame
                    .get("loaderId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(frame_id)
                    .to_owned(),
            },
        );
        self.changed.notify_waiters();
    }

    async fn remove_frame(&self, event: &CdpEvent) {
        let Some(frame_id) = event.params.get("frameId").and_then(Value::as_str) else {
            return;
        };
        let Some(event_session_id) = event.session_id.as_deref() else {
            eprintln!(
                "[ab.session] frame detach without session frame_id={} reason={}",
                frame_id,
                event
                    .params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            return;
        };
        let mut state = self.state.write().await;
        let Some(current) = state.frames.get(frame_id) else {
            return;
        };
        if current.session_id != event_session_id {
            eprintln!(
                "[ab.session] ignored stale frame detach frame_id={} event_session_id={} owner_session_id={} reason={}",
                frame_id,
                event_session_id,
                current.session_id,
                event
                    .params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            return;
        }
        state.frames.remove(frame_id);
        drop(state);
        self.changed.notify_waiters();
    }

    async fn update_realm(&self, event: &CdpEvent) {
        let Some(session_id) = event.session_id.as_deref() else {
            return;
        };
        let Some(target_id) = self.target_for_session(session_id).await else {
            return;
        };
        let Some(root_target_id) = self.root_for_session(session_id).await else {
            return;
        };
        let context = event.params.get("context").unwrap_or(&Value::Null);
        let Some(context_id) = context.get("id").and_then(Value::as_i64) else {
            return;
        };
        let auxiliary = context.get("auxData").unwrap_or(&Value::Null);
        let is_default = auxiliary
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let id = format!("context:{session_id}:{context_id}");
        self.state.write().await.realms.insert(
            id.clone(),
            RealmState {
                id,
                execution_context_id: context_id,
                root_target_id,
                target_id,
                session_id: session_id.to_owned(),
                frame_id: auxiliary
                    .get("frameId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                origin: context
                    .get("origin")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: context
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                kind: if is_default { "main" } else { "isolated" }.to_owned(),
                is_default,
            },
        );
        self.changed.notify_waiters();
    }

    async fn update_init_script(&self, event: &CdpEvent) {
        if !event
            .params
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("__ab_binding_"))
        {
            return;
        }
        if !self.try_update_init_script(event).await {
            self.pending_init_bindings.lock().await.push(event.clone());
        }
    }

    async fn try_update_init_script(&self, event: &CdpEvent) -> bool {
        let Some(session_id) = event.session_id.as_deref() else {
            return false;
        };
        let Some(execution_context_id) = event
            .params
            .get("executionContextId")
            .and_then(Value::as_i64)
        else {
            return false;
        };
        let Some(binding_name) = event.params.get("name").and_then(Value::as_str) else {
            return false;
        };
        let Some(payload) = event.params.get("payload").and_then(Value::as_str) else {
            return false;
        };
        let identity = {
            let state = self.state.read().await;
            let Some(realm) = state.realms.values().find(|realm| {
                realm.session_id == session_id && realm.execution_context_id == execution_context_id
            }) else {
                return false;
            };
            let Some(frame_id) = realm.frame_id.as_deref() else {
                return false;
            };
            let Some(frame) = state.frames.get(frame_id) else {
                return false;
            };
            InitScriptInstanceIdentity {
                session_id: session_id.to_owned(),
                execution_context_id,
                frame_id: frame_id.to_owned(),
                document_generation: frame.document_generation.clone(),
            }
        };
        self.init_scripts
            .record_binding(binding_name, identity, payload)
            .await;
        true
    }

    async fn drain_init_script_bindings(&self) {
        let pending = {
            let mut bindings = self.pending_init_bindings.lock().await;
            std::mem::take(&mut *bindings)
        };
        if pending.is_empty() {
            return;
        }
        let mut unresolved = Vec::new();
        for event in pending {
            if !self.try_update_init_script(&event).await {
                unresolved.push(event);
            }
        }
        if !unresolved.is_empty() {
            self.pending_init_bindings.lock().await.extend(unresolved);
        }
    }

    async fn update_target_info(&self, params: &Value) {
        let target = params.get("targetInfo").unwrap_or(params);
        let Some(target_id) = target.get("targetId").and_then(Value::as_str) else {
            return;
        };
        if let Some(record) = self.state.write().await.targets.get_mut(target_id) {
            record.opener_id = target
                .get("openerId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| record.opener_id.clone());
            record.title = target
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(&record.title)
                .to_owned();
            record.url = target
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or(&record.url)
                .to_owned();
        }
        self.changed.notify_waiters();
    }

    async fn remove_session(&self, session_id: &str) {
        let detached_dialog = self.state.write().await.dialogs.remove(session_id);
        if let Some(dialog) = detached_dialog {
            let _ = self.dialog_lifecycle.send(DialogLifecycle::Closed {
                dialog,
                accepted: None,
                user_input: None,
                reason: "session_detached".to_owned(),
            });
        }
        let (removed, detached_target_id, root_target_id) = {
            let mut state = self.state.write().await;
            let Some(target_id) = state.sessions.remove(session_id) else {
                return;
            };
            state.ready_sessions.remove(session_id);
            let root_target_id = state
                .targets
                .get(&target_id)
                .map(|target| target.root_target_id.clone());
            let removed = state
                .targets
                .get(&target_id)
                .is_some_and(|target| target.session_id == session_id)
                .then(|| state.targets.remove(&target_id))
                .flatten();
            state
                .frames
                .retain(|_, frame| frame.session_id != session_id);
            state
                .realms
                .retain(|_, realm| realm.session_id != session_id);
            (removed, target_id, root_target_id)
        };
        self.init_scripts.session_detached(session_id).await;
        self.pending_init_bindings
            .lock()
            .await
            .retain(|event| event.session_id.as_deref() != Some(session_id));
        self.domains.forget_session(session_id).await;
        let removed_current = removed.is_some();
        if let Some(root_target_id) = removed
            .map(|record| record.root_target_id)
            .or(root_target_id)
        {
            eprintln!(
                "[ab.session] detach session_id={} target_id={} root_target_id={} removed_current={}",
                session_id,
                detached_target_id,
                root_target_id,
                removed_current
            );
            let _ = self.lifecycle.send(SessionLifecycle::Detached {
                session_id: session_id.to_owned(),
                is_root: detached_target_id == root_target_id,
                root_target_id,
            });
        }
        self.changed.notify_waiters();
    }

    async fn remove_root(&self, target_id: &str) {
        let sessions = self
            .all_sessions_for_root(target_id)
            .await
            .into_iter()
            .map(|record| record.session_id)
            .collect::<Vec<_>>();
        for session in sessions {
            self.remove_session(&session).await;
        }
    }

    async fn all_sessions_for_root(&self, target_id: &str) -> Vec<TargetSession> {
        self.state
            .read()
            .await
            .targets
            .values()
            .filter(|target| target.root_target_id == target_id)
            .cloned()
            .collect()
    }

    async fn root_for_session(&self, session_id: &str) -> Option<String> {
        let state = self.state.read().await;
        let target_id = state.sessions.get(session_id)?;
        state
            .targets
            .get(target_id)
            .map(|target| target.root_target_id.clone())
    }

    async fn target_for_session(&self, session_id: &str) -> Option<String> {
        self.state.read().await.sessions.get(session_id).cloned()
    }

    async fn wait_for_target(
        &self,
        target_id: &str,
        duration: Duration,
    ) -> AbResult<TargetSession> {
        let deadline = Instant::now() + duration;
        loop {
            // Register before checking state so a readiness notification cannot
            // be lost between the check and the await.
            let notified = self.changed.notified();
            if let Ok(target) = self.target(target_id).await {
                return Ok(target);
            }
            timeout(deadline.saturating_duration_since(Instant::now()), notified)
                .await
                .map_err(|_| {
                    AbError::new(
                        "target_attach_timeout",
                        "session.target.wait",
                        format!("tab {target_id} did not attach within {duration:?}"),
                    )
                })?;
        }
    }

    async fn resync_targets(self: &Arc<Self>) -> AbResult<()> {
        let targets = self
            .client
            .send_command("Target.getTargets", Some(json!({})), None)
            .await
            .map_err(|message| session_error("target.resync", message))?;
        for target in targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !track_page_value(target) {
                continue;
            }
            let target_id = required_string(target, "targetId", "target.resync")?;
            if self.target(target_id).await.is_err() {
                let _ = self.attach_existing_page(target).await;
            } else {
                self.update_target_info(target).await;
            }
        }
        Ok(())
    }
}

fn collect_frame_tree(
    root_target_id: &str,
    session_id: &str,
    tree: Option<&Value>,
    output: &mut Vec<FrameState>,
) {
    let Some(tree) = tree else {
        return;
    };
    let frame = tree.get("frame").unwrap_or(&Value::Null);
    if let Some(frame_id) = frame.get("id").and_then(Value::as_str) {
        output.push(FrameState {
            id: frame_id.to_owned(),
            root_target_id: root_target_id.to_owned(),
            session_id: session_id.to_owned(),
            parent_id: frame
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            url: frame
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: frame.get("name").and_then(Value::as_str).map(str::to_owned),
            document_generation: frame
                .get("loaderId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(frame_id)
                .to_owned(),
        });
    }
    for child in tree
        .get("childFrames")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_frame_tree(root_target_id, session_id, Some(child), output);
    }
}

fn is_page_target(target: &TargetSession) -> bool {
    matches!(target.target_type.as_str(), "page" | "webview") && !is_internal_url(&target.url)
}

fn track_page_value(target: &Value) -> bool {
    matches!(
        target.get("type").and_then(Value::as_str),
        Some("page" | "webview")
    ) && target
        .get("url")
        .and_then(Value::as_str)
        .is_none_or(|url| url.is_empty() || !is_internal_url(url))
}

fn is_internal_url(url: &str) -> bool {
    url.starts_with("chrome://")
        || url.starts_with("chrome-extension://")
        || url.starts_with("devtools://")
}

fn required_string<'a>(value: &'a Value, field: &str, stage: &str) -> AbResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        AbError::new(
            "invalid_cdp_response",
            stage,
            format!("CDP response is missing {field}"),
        )
    })
}

fn session_error(stage: &str, message: String) -> AbError {
    AbError::new("session_manager_error", format!("session.{stage}"), message)
}

fn assert_supported_feature(feature: &str) -> AbResult<()> {
    match feature {
        "fileChooser" => Ok(()),
        _ => Err(unsupported_feature(feature)),
    }
}

fn unsupported_feature(feature: &str) -> AbError {
    AbError::new(
        "unsupported_feature",
        "session.feature",
        format!("browser feature {feature} is not supported"),
    )
}

fn dialog_stale(dialog_id: &str, message: &str) -> AbError {
    AbError::new("stale_dialog", "dialog.identity", message)
        .with_details(json!({ "dialogId": dialog_id }))
}
