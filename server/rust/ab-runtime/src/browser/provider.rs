use super::session_manager::{SessionManager, TargetSession};
use crate::agent_browser_engine::cdp::types::CdpEvent;
use crate::error::{AbError, AbResult};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserProviderKind {
    Managed,
    External,
}

#[derive(Debug, Clone)]
pub struct BrowserTarget {
    pub id: String,
    pub opener_id: Option<String>,
    pub title: String,
    pub url: String,
    pub kind: String,
    pub active: bool,
}

#[derive(Clone)]
pub enum BrowserProvider {
    Managed { sessions: Arc<SessionManager> },
    External { sessions: Arc<SessionManager> },
}

impl BrowserProvider {
    pub async fn connect(web_socket_url: &str, kind: BrowserProviderKind) -> AbResult<Self> {
        let sessions = SessionManager::connect(web_socket_url).await?;
        let provider = match kind {
            BrowserProviderKind::Managed => Self::Managed { sessions },
            BrowserProviderKind::External => Self::External { sessions },
        };
        provider.initialize().await?;
        provider.spawn_event_monitor();
        Ok(provider)
    }

    pub fn sessions(&self) -> Arc<SessionManager> {
        match self {
            Self::Managed { sessions } | Self::External { sessions } => Arc::clone(sessions),
        }
    }

    pub async fn list_targets(&self) -> AbResult<Vec<BrowserTarget>> {
        match self {
            Self::Managed { sessions } => {
                let targets = sessions.tabs().await;
                let active = sessions.active_target_ids(&targets).await;
                Ok(targets
                    .into_iter()
                    .map(|target| {
                        let is_active = active.contains(&target.target_id);
                        BrowserTarget::from_session(target, is_active)
                    })
                    .collect())
            }
            Self::External { sessions } => {
                let mut targets = Vec::new();
                for value in sessions.page_target_values().await? {
                    let mut target = BrowserTarget::from_value(&value)?;
                    if let Ok(session) = sessions.target(&target.id).await {
                        target.active = sessions.target_is_active(&session).await;
                    }
                    targets.push(target);
                }
                targets.sort_by(|left, right| left.id.cmp(&right.id));
                Ok(targets)
            }
        }
    }

    pub async fn target(&self, target_id: &str) -> AbResult<BrowserTarget> {
        match self {
            Self::Managed { sessions } => {
                let target = sessions.target(target_id).await?;
                let active = sessions.target_is_active(&target).await;
                Ok(BrowserTarget::from_session(target, active))
            }
            Self::External { .. } => self
                .list_targets()
                .await?
                .into_iter()
                .find(|target| target.id == target_id)
                .ok_or_else(|| target_not_found(target_id)),
        }
    }

    pub async fn acquire_target(&self, target_id: &str) -> AbResult<TargetSession> {
        match self {
            Self::Managed { sessions } => sessions.target(target_id).await,
            Self::External { sessions } => sessions.attach_target(target_id).await,
        }
    }

    pub async fn open_target(&self, url: &str) -> AbResult<TargetSession> {
        match self {
            Self::Managed { sessions } => {
                let target_id = sessions.create_target(url).await?;
                sessions
                    .wait_for_target(&target_id, Duration::from_secs(10))
                    .await
            }
            Self::External { sessions } => {
                let target_id = sessions.create_target(url).await?;
                sessions.attach_target(&target_id).await
            }
        }
    }

    pub async fn release_target(&self, target_id: &str) -> AbResult<()> {
        match self {
            Self::Managed { .. } => Ok(()),
            Self::External { sessions } => sessions.detach_target(target_id).await,
        }
    }

    async fn initialize(&self) -> AbResult<()> {
        let sessions = self.sessions();
        sessions.enable_discovery().await?;
        match self {
            Self::Managed { .. } => {
                sessions.enable_managed_auto_attach().await?;
                let targets = sessions.page_target_values().await?;
                let target_ids = targets
                    .iter()
                    .filter_map(|target| target.get("targetId").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                eprintln!(
                    "[ab.provider] kind=managed discovered_pages={} target_ids={}",
                    target_ids.len(),
                    target_ids.join(",")
                );
                for target_id in &target_ids {
                    sessions
                        .wait_for_target(target_id, Duration::from_secs(10))
                        .await?;
                }
                if target_ids.is_empty() {
                    let target_id = sessions.create_target("about:blank").await?;
                    sessions
                        .wait_for_target(&target_id, Duration::from_secs(10))
                        .await?;
                }
            }
            Self::External { .. } => {
                eprintln!("[ab.provider] kind=external discovery=enabled auto_attach=disabled");
            }
        }
        Ok(())
    }

    fn spawn_event_monitor(&self) {
        let provider = self.clone();
        let mut events = self.sessions().subscribe_browser_events();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => provider.handle_event(event).await,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        eprintln!(
                            "[ab.provider] event_stream_lagged skipped={skipped} resync=started"
                        );
                        if let Err(error) = provider.resync().await {
                            eprintln!("[ab.provider] resync_failed error={error}");
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn handle_event(&self, event: CdpEvent) {
        let Self::External { sessions } = self else {
            return;
        };
        if event.method != "Target.targetCreated" {
            return;
        }
        let Some(target) = event.params.get("targetInfo") else {
            return;
        };
        let Ok(target) = BrowserTarget::from_value(target) else {
            return;
        };
        let Some(opener_id) = target.opener_id.as_deref() else {
            return;
        };
        if sessions.target(opener_id).await.is_ok() {
            if let Err(error) = sessions.attach_target(&target.id).await {
                eprintln!(
                    "[ab.provider] popup_attach_failed target_id={} opener_id={} error={error}",
                    target.id, opener_id
                );
            }
        }
    }

    async fn resync(&self) -> AbResult<()> {
        match self {
            Self::Managed { sessions } => sessions.resync_all_pages().await,
            Self::External { sessions } => {
                for value in sessions.page_target_values().await? {
                    let target = BrowserTarget::from_value(&value)?;
                    if sessions.target(&target.id).await.is_ok() {
                        sessions.update_target_info(&value).await;
                        continue;
                    }
                    let Some(opener_id) = target.opener_id.as_deref() else {
                        continue;
                    };
                    if sessions.target(opener_id).await.is_ok() {
                        sessions.attach_target(&target.id).await?;
                    }
                }
                Ok(())
            }
        }
    }
}

impl BrowserTarget {
    fn from_session(target: TargetSession, active: bool) -> Self {
        Self {
            id: target.target_id,
            opener_id: target.opener_id,
            title: target.title,
            url: target.url,
            kind: target.target_type,
            active,
        }
    }

    fn from_value(value: &Value) -> AbResult<Self> {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let url = value.get("url").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind, "page" | "webview")
            || url.starts_with("chrome://")
            || url.starts_with("chrome-extension://")
            || url.starts_with("devtools://")
        {
            return Err(AbError::new(
                "target_not_found",
                "provider.target",
                "CDP target is not an attachable page",
            ));
        }
        let id = value
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AbError::new(
                    "invalid_cdp_response",
                    "provider.target",
                    "CDP target is missing targetId",
                )
            })?;
        Ok(Self {
            id: id.to_owned(),
            opener_id: value
                .get("openerId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            url: url.to_owned(),
            kind: kind.to_owned(),
            active: false,
        })
    }
}

fn target_not_found(target_id: &str) -> AbError {
    AbError::new(
        "target_not_found",
        "provider.target",
        format!("tab {target_id} does not exist"),
    )
}
