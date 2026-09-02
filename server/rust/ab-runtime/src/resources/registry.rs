use super::dialog::forward_dialog_events;
use super::download::{forward_download_events, DownloadStore};
use super::events::{domains_for, forward_events};
use super::init_scripts::forward_init_script_events;
use super::network::{BodyKey, NetworkBodyStore};
use super::popup::forward_popup_events;
use super::state::ResourceState;
use super::ClientOutbound;
use crate::artifacts::ArtifactStore;
use crate::browser::init_scripts::InitScriptDefinition;
use crate::browser::BrowserCore;
use crate::error::{AbError, AbResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDescriptor {
    pub id: String,
    pub kind: String,
    pub owner_id: String,
    pub scope: ResourceScope,
    pub state: String,
    pub created_at_unix_ms: u64,
    pub sequence: u64,
    pub complete: bool,
    pub close_reason: Option<String>,
    pub closed_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceScope {
    #[serde(rename = "type")]
    pub scope_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

struct ResourceEntry {
    client_id: String,
    target_id: Option<String>,
    kind: String,
    cancel: watch::Sender<Option<String>>,
    task: JoinHandle<()>,
    outbound: ClientOutbound,
    state: Arc<ResourceState>,
    backend: ResourceBackend,
    network_bodies: Option<Arc<Mutex<NetworkBodyStore>>>,
    downloads: Option<Arc<DownloadStore>>,
    cdp_session_id: Option<String>,
    cdp_domains: Option<Arc<Mutex<HashSet<String>>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResourceBackend {
    BrowserEvents,
    Cdp,
    Dialog,
    Download,
    InitScript,
    Popup,
}

pub struct ResourceRegistry {
    browser: Arc<BrowserCore>,
    artifacts: Arc<ArtifactStore>,
    entries: Mutex<HashMap<String, ResourceEntry>>,
    active_clients: Mutex<HashSet<String>>,
}

impl ResourceRegistry {
    pub fn new(browser: Arc<BrowserCore>, artifacts: Arc<ArtifactStore>) -> Arc<Self> {
        let registry = Arc::new(Self {
            browser,
            artifacts,
            entries: Mutex::new(HashMap::new()),
            active_clients: Mutex::new(HashSet::new()),
        });
        registry.spawn_target_cleanup();
        registry
    }

    pub async fn register_client(&self, client_id: &str) {
        self.active_clients
            .lock()
            .await
            .insert(client_id.to_owned());
    }

    pub async fn open(
        self: &Arc<Self>,
        client_id: &str,
        target_id: Option<&str>,
        kind: &str,
        params: &Value,
        outbound: ClientOutbound,
    ) -> AbResult<ResourceDescriptor> {
        self.ensure_client_active(client_id).await?;
        let target_id = target_id.map(str::to_owned);
        if target_id.is_none() && kind != "download" {
            return Err(AbError::new(
                "resource_scope_error",
                "resource.open.scope",
                format!("resource kind {kind} requires target.tabId"),
            ));
        }
        let mut entries = self.entries.lock().await;
        let owned = entries
            .values()
            .filter(|entry| entry.client_id == client_id)
            .count();
        if owned >= 64 {
            return Err(AbError::new(
                "resource_limit",
                "resource.open",
                "client already owns 64 live resources; dispose one before opening another",
            ));
        }
        let resource_id = Uuid::new_v4().to_string();
        let state = Arc::new(ResourceState::new());
        let (cancel, cancelled) = watch::channel(None::<String>);

        if kind == "cdp" {
            let target_id = required_resource_target(target_id.as_deref(), kind)?;
            let session_id = self
                .browser
                .resolve_cdp_session(
                    target_id,
                    params.get("sessionId").and_then(Value::as_str),
                    params.get("frameId").and_then(Value::as_str),
                    params.get("documentGeneration").and_then(Value::as_str),
                )
                .await?;
            if !self.client_is_active(client_id).await {
                return Err(client_closed(client_id));
            }
            let descriptor =
                open_descriptor(&resource_id, kind, client_id, Some(target_id), &state);
            let task = tokio::spawn(wait_for_cancel(cancelled));
            entries.insert(
                resource_id.clone(),
                ResourceEntry {
                    client_id: client_id.to_owned(),
                    target_id: Some(target_id.to_owned()),
                    kind: kind.to_owned(),
                    cancel,
                    task,
                    outbound,
                    state: Arc::clone(&state),
                    backend: ResourceBackend::Cdp,
                    network_bodies: None,
                    downloads: None,
                    cdp_session_id: Some(session_id),
                    cdp_domains: Some(Arc::new(Mutex::new(HashSet::new()))),
                },
            );
            drop(entries);
            return Ok(descriptor);
        }

        if kind == "initScript" {
            let target_id = required_resource_target(target_id.as_deref(), kind)?;
            let definition = serde_json::from_value::<InitScriptDefinition>(params.clone())
                .map_err(|error| {
                    AbError::new(
                        "invalid_argument",
                        "resource.init_script.definition",
                        error.to_string(),
                    )
                })?;
            let subscription = self
                .browser
                .add_init_script(&resource_id, target_id, definition)
                .await?;
            if !self.client_is_active(client_id).await {
                let _ = self.browser.remove_init_script(&resource_id).await;
                return Err(client_closed(client_id));
            }
            let descriptor =
                open_descriptor(&resource_id, kind, client_id, Some(target_id), &state);
            let task = tokio::spawn(forward_init_script_events(
                resource_id.clone(),
                subscription,
                cancelled,
                outbound.clone(),
                Arc::clone(&state),
            ));
            entries.insert(
                resource_id.clone(),
                ResourceEntry {
                    client_id: client_id.to_owned(),
                    target_id: Some(target_id.to_owned()),
                    kind: kind.to_owned(),
                    cancel,
                    task,
                    outbound,
                    state: Arc::clone(&state),
                    backend: ResourceBackend::InitScript,
                    network_bodies: None,
                    downloads: None,
                    cdp_session_id: None,
                    cdp_domains: None,
                },
            );
            drop(entries);
            return Ok(descriptor);
        }

        if kind == "dialog" {
            let target_id = required_resource_target(target_id.as_deref(), kind)?;
            let subscription = self.browser.subscribe_dialogs(target_id).await?;
            if !self.client_is_active(client_id).await {
                return Err(client_closed(client_id));
            }
            let descriptor =
                open_descriptor(&resource_id, kind, client_id, Some(target_id), &state);
            let task = tokio::spawn(forward_dialog_events(
                resource_id.clone(),
                subscription,
                cancelled,
                outbound.clone(),
                Arc::clone(&state),
            ));
            entries.insert(
                resource_id.clone(),
                ResourceEntry {
                    client_id: client_id.to_owned(),
                    target_id: Some(target_id.to_owned()),
                    kind: kind.to_owned(),
                    cancel,
                    task,
                    outbound,
                    state: Arc::clone(&state),
                    backend: ResourceBackend::Dialog,
                    network_bodies: None,
                    downloads: None,
                    cdp_session_id: None,
                    cdp_domains: None,
                },
            );
            drop(entries);
            return Ok(descriptor);
        }

        if kind == "popup" {
            let target_id = required_resource_target(target_id.as_deref(), kind)?;
            self.browser.get_tab(client_id, target_id).await?;
            let lifecycle = self.browser.subscribe_session_lifecycle();
            if !self.client_is_active(client_id).await {
                return Err(client_closed(client_id));
            }
            let descriptor =
                open_descriptor(&resource_id, kind, client_id, Some(target_id), &state);
            let task = tokio::spawn(forward_popup_events(
                resource_id.clone(),
                target_id.to_owned(),
                lifecycle,
                cancelled,
                outbound.clone(),
                Arc::clone(&state),
            ));
            entries.insert(
                resource_id.clone(),
                ResourceEntry {
                    client_id: client_id.to_owned(),
                    target_id: Some(target_id.to_owned()),
                    kind: kind.to_owned(),
                    cancel,
                    task,
                    outbound,
                    state: Arc::clone(&state),
                    backend: ResourceBackend::Popup,
                    network_bodies: None,
                    downloads: None,
                    cdp_session_id: None,
                    cdp_domains: None,
                },
            );
            drop(entries);
            return Ok(descriptor);
        }

        let domains = domains_for(kind)?;
        let mut domain_params = HashMap::new();
        let network_bodies = if kind == "network" {
            let store = NetworkBodyStore::new(params)?;
            domain_params.insert("Network".to_owned(), store.domain_enable_params());
            Some(Arc::new(Mutex::new(store)))
        } else {
            None
        };
        let subscription = match target_id.as_deref() {
            Some(target_id) => {
                self.browser
                    .subscribe_events(target_id, domains, &resource_id, domain_params)
                    .await?
            }
            None => self.browser.subscribe_browser_events(&resource_id).await,
        };
        if kind == "download" {
            self.browser
                .raw_cdp(
                    None,
                    "Browser.setDownloadBehavior",
                    json!({
                        "behavior": "allowAndName",
                        "downloadPath": self.artifacts.root(),
                        "eventsEnabled": true
                    }),
                )
                .await?;
        }
        if kind == "fileChooser" {
            let target_id = required_resource_target(target_id.as_deref(), kind)?;
            if let Err(error) = self
                .browser
                .acquire_feature(target_id, kind, &resource_id)
                .await
            {
                super::events::release_event_domains(&subscription).await;
                return Err(error);
            }
        }
        if !self.client_is_active(client_id).await {
            super::events::release_event_domains(&subscription).await;
            if kind == "fileChooser" {
                if let Some(target_id) = target_id.as_deref() {
                    let _ = self
                        .browser
                        .release_feature(target_id, kind, &resource_id)
                        .await;
                }
            }
            return Err(client_closed(client_id));
        }

        let downloads = (kind == "download").then(|| Arc::new(DownloadStore::default()));

        let descriptor =
            open_descriptor(&resource_id, kind, client_id, target_id.as_deref(), &state);
        let task = if let Some(downloads) = downloads.clone() {
            tokio::spawn(forward_download_events(
                resource_id.clone(),
                client_id.to_owned(),
                subscription,
                cancelled,
                outbound.clone(),
                Arc::clone(&state),
                Arc::clone(&self.artifacts),
                Arc::clone(&self.browser),
                downloads,
            ))
        } else {
            tokio::spawn(forward_events(
                resource_id.clone(),
                client_id.to_owned(),
                kind.to_owned(),
                subscription,
                cancelled,
                outbound.clone(),
                Arc::clone(&state),
                Arc::clone(&self.artifacts),
                Arc::clone(&self.browser),
                network_bodies.clone(),
            ))
        };
        entries.insert(
            resource_id.clone(),
            ResourceEntry {
                client_id: client_id.to_owned(),
                target_id: target_id.clone(),
                kind: kind.to_owned(),
                cancel,
                task,
                outbound,
                state: Arc::clone(&state),
                backend: if kind == "download" {
                    ResourceBackend::Download
                } else {
                    ResourceBackend::BrowserEvents
                },
                network_bodies: network_bodies.clone(),
                downloads: downloads.clone(),
                cdp_session_id: None,
                cdp_domains: None,
            },
        );
        drop(entries);
        Ok(descriptor)
    }

    pub async fn command(
        &self,
        client_id: &str,
        resource_id: &str,
        command: &str,
        params: Value,
    ) -> AbResult<Value> {
        let entries = self.entries.lock().await;
        let entry = entries
            .get(resource_id)
            .ok_or_else(|| resource_not_found(resource_id))?;
        assert_owner(entry, client_id)?;
        if !entry.state.complete() && command == "assertComplete" {
            return Err(AbError::new(
                "resource_incomplete",
                "resource.command",
                format!("resource {resource_id} lost one or more events"),
            ));
        }
        let target_id = entry.target_id.clone();
        let kind = entry.kind.clone();
        let state = Arc::clone(&entry.state);
        let network_bodies = entry.network_bodies.clone();
        let downloads = entry.downloads.clone();
        let cdp_session_id = entry.cdp_session_id.clone();
        let cdp_domains = entry.cdp_domains.clone();
        drop(entries);

        if matches!(kind.as_str(), "cdp" | "initScript")
            || (kind == "dialog" && matches!(command, "accept" | "dismiss"))
        {
            let target_id = required_resource_target(target_id.as_deref(), &kind)?;
            self.browser.require_target(client_id, target_id).await?;
        }

        match (kind.as_str(), command) {
            ("cdp", "send") => {
                let method = params
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AbError::new(
                            "invalid_argument",
                            "resource.cdp.method",
                            "CDPSession.send requires a method",
                        )
                    })?;
                let command_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
                let session_id = cdp_session_id.ok_or_else(|| {
                    AbError::new(
                        "resource_state_error",
                        "resource.cdp.session",
                        "CDPSession has no bound browser session",
                    )
                })?;
                let owned_domains = cdp_domains.ok_or_else(|| {
                    AbError::new(
                        "resource_state_error",
                        "resource.cdp.domains",
                        "CDPSession has no domain ownership state",
                    )
                })?;
                if let Some((domain, enabling)) = cdp_domain_control(method) {
                    if enabling {
                        let mut domains = owned_domains.lock().await;
                        if domains.insert(domain.to_owned()) {
                            if let Err(error) = self
                                .browser
                                .acquire_cdp_domain(
                                    &session_id,
                                    domain,
                                    resource_id,
                                    command_params,
                                )
                                .await
                                .map_err(|error| error.with_cdp_method(method))
                            {
                                domains.remove(domain);
                                return Err(error);
                            }
                        }
                        Ok(json!({}))
                    } else {
                        let mut domains = owned_domains.lock().await;
                        if domains.contains(domain) {
                            self.browser
                                .release_cdp_domain(&session_id, domain, resource_id)
                                .await
                                .map_err(|error| error.with_cdp_method(method))?;
                            domains.remove(domain);
                        }
                        Ok(json!({}))
                    }
                } else {
                    self.browser
                        .raw_cdp_session(&session_id, method, command_params)
                        .await
                        .map_err(|error| error.with_cdp_method(method))
                }
            }
            ("network", "responseBody") => {
                let request_id =
                    params
                        .get("requestId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.network.response_body",
                                "responseBody requires requestId",
                            )
                        })?;
                let session_id =
                    params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.network.response_body",
                                "responseBody requires the event sessionId",
                            )
                        })?;
                let store = network_bodies.ok_or_else(|| {
                    AbError::new(
                        "resource_state_error",
                        "resource.network.response_body",
                        "network observer has no response body store",
                    )
                })?;
                let key = BodyKey {
                    session_id: session_id.to_owned(),
                    request_id: request_id.to_owned(),
                };
                let response = store.lock().await.response(&key);
                response
            }
            ("dialog", "accept") => {
                let target_id = required_resource_target(target_id.as_deref(), &kind)?;
                let dialog_id =
                    params
                        .get("dialogId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.dialog.identity",
                                "accept requires dialogId",
                            )
                        })?;
                let session_id =
                    params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.dialog.session",
                                "accept requires sessionId",
                            )
                        })?;
                self.browser
                    .handle_dialog(
                        target_id,
                        dialog_id,
                        session_id,
                        true,
                        params.get("promptText").and_then(Value::as_str),
                    )
                    .await
            }
            ("dialog", "dismiss") => {
                let target_id = required_resource_target(target_id.as_deref(), &kind)?;
                let dialog_id =
                    params
                        .get("dialogId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.dialog.identity",
                                "dismiss requires dialogId",
                            )
                        })?;
                let session_id =
                    params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AbError::new(
                                "invalid_argument",
                                "resource.dialog.session",
                                "dismiss requires sessionId",
                            )
                        })?;
                self.browser
                    .handle_dialog(target_id, dialog_id, session_id, false, None)
                    .await
            }
            ("download", "downloadState") => {
                let guid = params.get("guid").and_then(Value::as_str).ok_or_else(|| {
                    AbError::new(
                        "invalid_argument",
                        "resource.download.identity",
                        "downloadState requires guid",
                    )
                })?;
                let store = downloads.ok_or_else(|| {
                    AbError::new(
                        "resource_state_error",
                        "resource.download.state",
                        "download watcher has no state store",
                    )
                })?;
                Ok(json!(store.get(guid).await?))
            }
            ("download", "downloads") => {
                let store = downloads.ok_or_else(|| {
                    AbError::new(
                        "resource_state_error",
                        "resource.download.state",
                        "download watcher has no state store",
                    )
                })?;
                Ok(json!(store.list().await))
            }
            ("initScript", "instances") => Ok(json!(
                self.browser.init_script_instances(resource_id).await?
            )),
            ("initScript", "command") => {
                let instance_id = params
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AbError::new(
                            "invalid_argument",
                            "resource.init_script.command.instance",
                            "command requires instanceId",
                        )
                    })?;
                let name = params.get("name").and_then(Value::as_str).ok_or_else(|| {
                    AbError::new(
                        "invalid_argument",
                        "resource.init_script.command.name",
                        "command requires name",
                    )
                })?;
                self.browser
                    .command_init_script(
                        resource_id,
                        instance_id,
                        name,
                        params.get("value").cloned().unwrap_or(Value::Null),
                    )
                    .await
            }
            (_, "assertComplete") => Ok(json!({ "complete": true })),
            (_, "state") => {
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                Ok(state.snapshot(after_sequence).await)
            }
            _ => Err(AbError::new(
                "resource_command_not_found",
                "resource.command",
                format!("resource kind {kind} has no command {command}"),
            )),
        }
    }

    pub async fn dispose(&self, client_id: &str, resource_id: &str) -> AbResult<()> {
        let entry = {
            let mut entries = self.entries.lock().await;
            let entry = entries
                .get(resource_id)
                .ok_or_else(|| resource_not_found(resource_id))?;
            assert_owner(entry, client_id)?;
            entries.remove(resource_id).expect("entry checked above")
        };
        self.close_entry(resource_id, entry, "disposed").await
    }

    pub async fn cleanup_client(&self, client_id: &str) {
        self.active_clients.lock().await.remove(client_id);
        let entries = {
            let mut registry = self.entries.lock().await;
            let ids = registry
                .iter()
                .filter(|(_, entry)| entry.client_id == client_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| registry.remove(&id).map(|entry| (id, entry)))
                .collect::<Vec<_>>()
        };
        for (id, entry) in entries {
            let _ = self.close_entry(&id, entry, "client_disconnected").await;
        }
    }

    async fn cleanup_target(&self, target_id: &str) {
        let entries = {
            let mut registry = self.entries.lock().await;
            let ids = registry
                .iter()
                .filter(|(_, entry)| entry.target_id.as_deref() == Some(target_id))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| registry.remove(&id).map(|entry| (id, entry)))
                .collect::<Vec<_>>()
        };
        for (id, entry) in entries {
            let _ = self.close_entry(&id, entry, "target_closed").await;
        }
    }

    async fn cleanup_session(&self, session_id: &str) {
        let entries = {
            let mut registry = self.entries.lock().await;
            let ids = registry
                .iter()
                .filter(|(_, entry)| entry.cdp_session_id.as_deref() == Some(session_id))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| registry.remove(&id).map(|entry| (id, entry)))
                .collect::<Vec<_>>()
        };
        for (id, entry) in entries {
            let _ = self.close_entry(&id, entry, "session_detached").await;
        }
    }

    fn spawn_target_cleanup(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        let mut lifecycle = self.browser.subscribe_session_lifecycle();
        tokio::spawn(async move {
            loop {
                match lifecycle.recv().await {
                    Ok(crate::browser::session_manager::SessionLifecycle::Detached {
                        session_id,
                        root_target_id,
                        is_root,
                    }) => {
                        if is_root {
                            registry.cleanup_target(&root_target_id).await;
                        } else {
                            registry.cleanup_session(&session_id).await;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn close_entry(
        &self,
        resource_id: &str,
        entry: ResourceEntry,
        reason: &str,
    ) -> AbResult<()> {
        let mut teardown_error = None;
        if entry.backend == ResourceBackend::InitScript {
            if let Err(error) = self.browser.remove_init_script(resource_id).await {
                teardown_error = Some(error);
            }
        }
        if entry.kind == "fileChooser" {
            if let Some(target_id) = entry.target_id.as_deref() {
                if let Err(error) = self
                    .browser
                    .release_feature(target_id, &entry.kind, resource_id)
                    .await
                {
                    teardown_error.get_or_insert(error);
                }
            }
        }
        if entry.backend == ResourceBackend::Cdp {
            if let (Some(session_id), Some(domains)) =
                (entry.cdp_session_id.as_deref(), entry.cdp_domains.as_ref())
            {
                for domain in domains.lock().await.drain() {
                    if let Err(error) = self
                        .browser
                        .release_cdp_domain(session_id, &domain, resource_id)
                        .await
                    {
                        teardown_error.get_or_insert(error);
                    }
                }
            }
        }
        let _ = entry.cancel.send(Some(reason.to_owned()));
        let task_failed = entry.task.await.is_err();
        super::events::emit_closed(
            &entry.outbound,
            resource_id,
            if task_failed {
                "resource_task_failed"
            } else {
                reason
            },
            &entry.state,
            !task_failed && entry.state.complete(),
        )
        .await;
        if task_failed {
            teardown_error.get_or_insert_with(|| {
                AbError::new(
                    "resource_task_failed",
                    "resource.close",
                    format!("resource {resource_id} forwarder terminated unexpectedly"),
                )
            });
        }
        teardown_error.map_or(Ok(()), Err)
    }

    async fn ensure_client_active(&self, client_id: &str) -> AbResult<()> {
        if self.client_is_active(client_id).await {
            Ok(())
        } else {
            Err(client_closed(client_id))
        }
    }

    async fn client_is_active(&self, client_id: &str) -> bool {
        self.active_clients.lock().await.contains(client_id)
    }
}

fn open_descriptor(
    resource_id: &str,
    kind: &str,
    client_id: &str,
    target_id: Option<&str>,
    state: &ResourceState,
) -> ResourceDescriptor {
    ResourceDescriptor {
        id: resource_id.to_owned(),
        kind: kind.to_owned(),
        owner_id: client_id.to_owned(),
        scope: ResourceScope {
            scope_type: if target_id.is_some() {
                "target"
            } else {
                "browser"
            }
            .to_owned(),
            target_id: target_id.map(str::to_owned),
        },
        state: "open".to_owned(),
        created_at_unix_ms: state.created_at_unix_ms(),
        sequence: state.last_sequence(),
        complete: state.complete(),
        close_reason: None,
        closed_at_unix_ms: None,
    }
}

fn required_resource_target<'a>(target_id: Option<&'a str>, kind: &str) -> AbResult<&'a str> {
    target_id.ok_or_else(|| {
        AbError::new(
            "resource_scope_error",
            "resource.target",
            format!("resource kind {kind} requires target scope"),
        )
    })
}

fn assert_owner(entry: &ResourceEntry, client_id: &str) -> AbResult<()> {
    if entry.client_id == client_id {
        Ok(())
    } else {
        Err(AbError::new(
            "resource_owner_mismatch",
            "resource.owner",
            "resource belongs to another client",
        ))
    }
}

fn resource_not_found(resource_id: &str) -> AbError {
    AbError::new(
        "resource_not_found",
        "resource.lookup",
        format!("resource {resource_id} does not exist"),
    )
}

fn client_closed(client_id: &str) -> AbError {
    AbError::new(
        "client_disconnected",
        "resource.owner",
        format!("client {client_id} is no longer active"),
    )
}

async fn wait_for_cancel(mut cancelled: watch::Receiver<Option<String>>) {
    loop {
        if cancelled.borrow().is_some() || cancelled.changed().await.is_err() {
            return;
        }
    }
}

fn cdp_domain_control(method: &str) -> Option<(&str, bool)> {
    let (domain, action) = method.split_once('.')?;
    if domain.is_empty()
        || !domain
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return None;
    }
    match action {
        "enable" => Some((domain, true)),
        "disable" => Some((domain, false)),
        _ => None,
    }
}
