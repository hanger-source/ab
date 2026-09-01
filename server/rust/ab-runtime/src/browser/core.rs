use super::init_scripts::{InitScriptDefinition, InitScriptInstance, InitScriptSubscription};
use super::owner::BrowserOwner;
use super::session_manager::{DialogLifecycle, FrameState, RealmState};
use super::target_lane::TargetState;
use crate::actions::{
    dispatch_mechanism, ActionCoordinateIdentity, ActionDispatchMarker, ActionObservationOutcome,
    ActionResult, ActionRunner, ActionTargetIdentity, ActionTiming, DialogOutcome, DocumentChange,
    FileChooserOutcome, NavigationChange,
};
use crate::agent_browser_engine::cdp::types::CdpEvent;
use crate::agent_browser_engine::interaction;
use crate::agent_browser_engine::screenshot::{capture_screenshot_base64, ScreenshotOptions};
use crate::artifacts::{ArtifactDescriptor, ArtifactStore};
use crate::browser::TargetContext;
use crate::elements::{ElementHandleDescriptor, ElementRegistry};
use crate::error::{AbError, AbResult};
use crate::observation::capture as observation_engine;
use crate::observation::{ObservationOutput, ObservationStore, SnapshotOptions};
use crate::selector::{ElementTarget, SelectorEngine};
use ab_protocol::{LocatorQuery, LocatorRequest};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Instant};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub opener_id: Option<String>,
    pub title: String,
    pub url: String,
    pub kind: String,
    pub active: bool,
    pub engine_id: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub id: String,
    pub target_id: String,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub url: String,
    pub name: Option<String>,
    pub document_generation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmRecord {
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

pub struct BrowserCore {
    owner: Arc<BrowserOwner>,
    observations: ObservationStore,
    generation: String,
    artifacts: Arc<ArtifactStore>,
    elements: ElementRegistry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOutput {
    pub artifact: ArtifactDescriptor,
    pub viewport_id: String,
    pub width: f64,
    pub height: f64,
    pub full_page: bool,
    pub scale: ScreenshotScale,
    pub css_viewport: CssViewport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotScale {
    Css,
    Device,
}

impl ScreenshotScale {
    pub fn parse(value: &str) -> AbResult<Self> {
        match value {
            "css" => Ok(Self::Css),
            "device" => Ok(Self::Device),
            other => Err(AbError::new(
                "invalid_argument",
                "screenshot.scale",
                format!("screenshot scale must be css or device; got {other}"),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssViewport {
    pub width: f64,
    pub height: f64,
    pub page_x: f64,
    pub page_y: f64,
    pub device_scale_factor: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageObservationOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ObservationOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ScreenshotOutput>,
}

pub struct EventSubscription {
    pub target_id: Option<String>,
    pub owner_id: String,
    pub domains: Vec<String>,
    pub domain_params: HashMap<String, Value>,
    pub session_ids: HashSet<String>,
    pub receiver: broadcast::Receiver<CdpEvent>,
    pub lifecycle: broadcast::Receiver<super::session_manager::SessionLifecycle>,
    pub leases: Arc<super::domain_leases::DomainLeases>,
}

pub struct DialogSubscription {
    pub target_id: String,
    pub initial: Vec<super::session_manager::OpenDialog>,
    pub receiver: broadcast::Receiver<DialogLifecycle>,
}

struct ActionTransaction {
    id: String,
    action: String,
    target: ActionTargetIdentity,
    started_at_unix_ms: u64,
    started_at: std::time::Instant,
    before_url: String,
    before_generation: String,
    events: broadcast::Receiver<CdpEvent>,
}

impl BrowserCore {
    pub async fn new(
        ws_url: &str,
        generation: String,
        artifacts: Arc<ArtifactStore>,
    ) -> AbResult<Self> {
        let owner = BrowserOwner::connect(ws_url).await?;
        let client = owner.sessions().client();
        Ok(Self {
            observations: ObservationStore::new(Arc::clone(&client)),
            elements: ElementRegistry::new(client),
            owner,
            generation,
            artifacts,
        })
    }

    pub fn subscribe_disconnected(&self) -> watch::Receiver<bool> {
        self.owner.subscribe_disconnected()
    }

    pub async fn list_tabs(&self) -> AbResult<Vec<TabInfo>> {
        let sessions = self.owner.sessions();
        let tabs = sessions.tabs().await;
        let active_target_ids = sessions.active_target_ids(&tabs).await;
        Ok(tabs
            .into_iter()
            .map(|target| {
                let active = active_target_ids.contains(&target.target_id);
                tab_info(target, active)
            })
            .collect())
    }

    pub async fn open_tab(
        &self,
        url: &str,
        wait_until: &str,
        timeout_ms: u64,
    ) -> AbResult<TabInfo> {
        let session = self.owner.sessions().open_tab("about:blank").await?;
        let target_id = session.target_id.clone();
        if url != "about:blank" {
            if let Err(error) = self.navigate(&target_id, url, wait_until, timeout_ms).await {
                let _ = self.owner.close_target(&target_id).await;
                return Err(error);
            }
        }
        self.get_tab(&target_id).await
    }

    pub async fn get_tab(&self, target_id: &str) -> AbResult<TabInfo> {
        let sessions = self.owner.sessions();
        let target = sessions.target(target_id).await?;
        let active = sessions.target_is_active(&target).await;
        Ok(tab_info(target, active))
    }

    pub async fn close_tab(&self, target_id: &str) -> AbResult<()> {
        self.owner.close_target(target_id).await
    }

    pub async fn frames(&self, target_id: &str) -> AbResult<Vec<FrameRecord>> {
        self.owner.sessions().target(target_id).await?;
        Ok(self
            .owner
            .sessions()
            .frames(target_id)
            .await
            .into_iter()
            .map(frame_record)
            .collect())
    }

    pub async fn realms(&self, target_id: &str) -> AbResult<Vec<RealmRecord>> {
        self.owner.sessions().target(target_id).await?;
        Ok(self
            .owner
            .sessions()
            .realms(target_id)
            .await
            .into_iter()
            .map(realm_record)
            .collect())
    }

    pub async fn navigate(
        &self,
        target_id: &str,
        url: &str,
        wait_until: &str,
        timeout_ms: u64,
    ) -> AbResult<Value> {
        let _lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        let mut events = context.client.subscribe();
        let result = context
            .client
            .send_command_with_timeout(
                "Page.navigate",
                Some(json!({ "url": url })),
                Some(&context.root_session_id),
                Duration::from_millis(timeout_ms),
            )
            .await
            .map_err(|message| browser_error("navigate", message))?;
        if let Some(text) = result.get("errorText").and_then(Value::as_str) {
            return Err(browser_error("navigate", text));
        }
        if wait_until != "none" {
            let expected = match wait_until {
                "domcontentloaded" => "Page.domContentEventFired",
                "load" => "Page.loadEventFired",
                other => {
                    return Err(AbError::new(
                        "invalid_argument",
                        "tab.navigate.wait_until",
                        format!("unsupported waitUntil {other}"),
                    ))
                }
            };
            timeout(Duration::from_millis(timeout_ms), async {
                loop {
                    match events.recv().await {
                        Ok(event)
                            if event.method == expected
                                && event.session_id.as_deref()
                                    == Some(&context.root_session_id) =>
                        {
                            return Ok(())
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(browser_error("navigate.events", "CDP event stream closed"))
                        }
                    }
                }
            })
            .await
            .map_err(|_| {
                AbError::new(
                    "timeout",
                    "tab.navigate.wait",
                    format!("{wait_until} did not occur within {timeout_ms}ms"),
                )
            })??;
        }
        Ok(result)
    }

    pub async fn screenshot(
        &self,
        client_id: &str,
        target_id: &str,
        full_page: bool,
        scale: ScreenshotScale,
    ) -> AbResult<ScreenshotOutput> {
        self.observe(client_id, target_id, None, true, full_page, scale)
            .await?
            .screenshot
            .ok_or_else(|| browser_error("screenshot", "capture returned no screenshot"))
    }

    pub async fn cua(
        &self,
        client_id: &str,
        target_id: &str,
        params: &Value,
        dispatch_marker: &ActionDispatchMarker,
    ) -> AbResult<Value> {
        let mut lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        let viewport = viewport_state(&context, &self.generation).await?;
        if let Some(expected) = params.get("viewportId").and_then(Value::as_str) {
            if expected != viewport.id {
                return Err(AbError::new(
                    "stale_viewport",
                    "cua.viewport",
                    format!(
                        "viewport {expected} is stale; current viewport is {}",
                        viewport.id
                    ),
                ));
            }
        }
        let operation = required_string(params, "operation", "cua.operation")?;
        let x = params
            .get("x")
            .and_then(Value::as_f64)
            .unwrap_or(viewport.width / 2.0);
        let y = params
            .get("y")
            .and_then(Value::as_f64)
            .unwrap_or(viewport.height / 2.0);
        let (event_type, button, click_count) = match operation {
            "move" => ("mouseMoved", None, None),
            "click" => (
                "mousePressed",
                Some(
                    params
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                ),
                Some(
                    params
                        .get("clickCount")
                        .and_then(Value::as_i64)
                        .unwrap_or(1),
                ),
            ),
            "wheel" => ("mouseWheel", None, None),
            "drag" => ("mouseMoved", Some("left"), Some(1)),
            other => {
                return Err(AbError::new(
                    "invalid_argument",
                    "cua.operation",
                    format!("unsupported CUA operation {other}"),
                ))
            }
        };
        let (baseline, observation_options) = self
            .resolve_action_observation(client_id, target_id, params)
            .await?;
        let drag_end = if operation == "drag" {
            Some((
                required_number(params, "endX", "cua.drag")?,
                required_number(params, "endY", "cua.drag")?,
            ))
        } else {
            None
        };
        let coordinate = if let Some((end_x, end_y)) = drag_end {
            ActionCoordinateIdentity::drag(&viewport.id, x, y, end_x, end_y)
        } else {
            ActionCoordinateIdentity::point(&viewport.id, x, y)
        };
        let identity = ActionTargetIdentity::coordinate(
            target_id,
            &context.root_session_id,
            &context.root_frame.id,
            &context.root_frame.document_generation,
            coordinate,
        );
        let transaction = self.begin_action(&context, operation, identity).await?;
        dispatch_marker.mark_started();
        let dispatch = if operation == "click" {
            let click = interaction::click_at(
                &context.client,
                &context.root_session_id,
                x,
                y,
                button.unwrap_or("left"),
                click_count.unwrap_or(1) as i32,
            )
            .await
            .map_err(|message| browser_error("cua.click", message));
            match click {
                Ok(click) => {
                    let dialog_session_id = click
                        .dialog_event
                        .as_ref()
                        .and_then(|event| event.session_id.clone());
                    lane.pending_release = click.pending_release;
                    json!({
                        "dialogOpened": click.dialog_opened,
                        "dialogSessionId": dialog_session_id,
                    })
                }
                Err(error) => {
                    self.abort_action(&transaction).await;
                    return Err(error);
                }
            }
        } else if let Some((end_x, end_y)) = drag_end {
            match ActionRunner::drag_coordinates(
                &context,
                &context.root_session_id,
                x,
                y,
                end_x,
                end_y,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    self.abort_action(&transaction).await;
                    return Err(error);
                }
            }
        } else {
            let mut wire = json!({ "type": event_type, "x": x, "y": y });
            if operation == "wheel" {
                wire["deltaX"] = json!(params.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0));
                wire["deltaY"] = json!(params.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0));
            }
            match context
                .client
                .send_command(
                    "Input.dispatchMouseEvent",
                    Some(wire),
                    Some(&context.root_session_id),
                )
                .await
                .map_err(|message| browser_error("cua.dispatch", message))
            {
                Ok(value) => value,
                Err(error) => {
                    self.abort_action(&transaction).await;
                    return Err(error);
                }
            }
        };
        let mut action_data = json!({
            "operation": operation,
            "x": x,
            "y": y,
            "viewportId": viewport.id,
            "dialogOpened": dispatch
                .get("dialogOpened")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "dialogSessionId": dispatch.get("dialogSessionId").cloned(),
            "dispatch": dispatch
        });
        if let Some((end_x, end_y)) = drag_end {
            action_data["endX"] = json!(end_x);
            action_data["endY"] = json!(end_y);
        }
        let result = self
            .finish_action(
                client_id,
                transaction,
                &lane,
                action_data,
                baseline.as_ref(),
                observation_options.as_ref(),
            )
            .await;
        Ok(json!(result?))
    }

    pub async fn snapshot(
        &self,
        client_id: &str,
        target_id: &str,
        options: SnapshotOptions,
    ) -> AbResult<ObservationOutput> {
        self.observe(
            client_id,
            target_id,
            Some(options),
            false,
            false,
            ScreenshotScale::Device,
        )
        .await?
        .state
        .ok_or_else(|| browser_error("observation", "capture returned no AX state"))
    }

    pub async fn observe(
        &self,
        client_id: &str,
        target_id: &str,
        ax: Option<SnapshotOptions>,
        screenshot: bool,
        full_page: bool,
        screenshot_scale: ScreenshotScale,
    ) -> AbResult<PageObservationOutput> {
        if ax.is_none() && !screenshot {
            return Err(AbError::new(
                "invalid_argument",
                "observation.request",
                "observe requires ax and/or screenshot",
            ));
        }
        let previous = match ax.as_ref() {
            Some(options) => {
                options.interactive()?;
                self.observations.assert_capacity(client_id).await?;
                self.observations
                    .previous(client_id, target_id, options)
                    .await?
            }
            None => None,
        };
        let lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        let before = capture_identity(&context, &self.generation).await?;
        let observation = if let Some(options) = ax.as_ref() {
            Some(
                observation_engine::capture(
                    &context,
                    client_id,
                    Uuid::new_v4().to_string(),
                    self.observations.next_revision(target_id).await,
                    options,
                    previous.as_ref(),
                )
                .await?,
            )
        } else {
            None
        };
        let pending_screenshot = if screenshot {
            match capture_screenshot(
                &context,
                &lane.refs,
                None,
                full_page,
                screenshot_scale,
                &self.generation,
            )
            .await
            {
                Ok(value) => Some(value),
                Err(error) => {
                    if let Some(record) = observation.as_ref() {
                        self.observations.release(record).await;
                    }
                    return Err(error);
                }
            }
        } else {
            None
        };
        let after_context = match self.context(target_id).await {
            Ok(value) => value,
            Err(error) => {
                if let Some(record) = observation.as_ref() {
                    self.observations.release(record).await;
                }
                return Err(error);
            }
        };
        let after = match capture_identity(&after_context, &self.generation).await {
            Ok(value) => value,
            Err(error) => {
                if let Some(record) = observation.as_ref() {
                    self.observations.release(record).await;
                }
                return Err(error);
            }
        };
        if before != after {
            if let Some(record) = observation.as_ref() {
                self.observations.release(record).await;
            }
            return Err(AbError::new(
                "observation_consistency_error",
                "observation.transaction.verify",
                "document, frame topology, viewport, scroll or DPR changed during capture",
            )
            .with_details(json!({ "before": before, "after": after })));
        }
        let state = if let Some(record) = observation {
            Some(self.observations.insert(record).await?)
        } else {
            None
        };
        let screenshot = pending_screenshot
            .map(|pending| pending.commit(&self.artifacts, client_id))
            .transpose()?;
        Ok(PageObservationOutput { state, screenshot })
    }

    pub async fn dispose_observation(&self, client_id: &str, observation_id: &str) -> AbResult<()> {
        self.observations.dispose(client_id, observation_id).await
    }

    pub async fn cleanup_client(&self, client_id: &str) {
        self.observations.cleanup_client(client_id).await;
        self.elements.cleanup_client(client_id).await;
        self.artifacts.release_owner(client_id);
    }

    async fn begin_action(
        &self,
        context: &TargetContext,
        action: &str,
        target: ActionTargetIdentity,
    ) -> AbResult<ActionTransaction> {
        let id = Uuid::new_v4().to_string();
        let events = context.sessions.subscribe_browser_events();
        context
            .sessions
            .acquire_feature(&context.target_id, "fileChooser", &id)
            .await?;
        let frame = context
            .frames
            .iter()
            .find(|frame| frame.id == target.frame_id)
            .unwrap_or(&context.root_frame);
        Ok(ActionTransaction {
            id,
            action: action.to_owned(),
            target,
            started_at_unix_ms: unix_ms(),
            started_at: std::time::Instant::now(),
            before_url: frame.url.clone(),
            before_generation: frame.document_generation.clone(),
            events,
        })
    }

    async fn abort_action(&self, transaction: &ActionTransaction) {
        let _ = self
            .owner
            .sessions()
            .release_feature(
                &transaction.target.target_id,
                "fileChooser",
                &transaction.id,
            )
            .await;
    }

    async fn finish_action(
        &self,
        client_id: &str,
        mut transaction: ActionTransaction,
        lane: &TargetState,
        data: Value,
        baseline: Option<&crate::observation::ObservationRecord>,
        observation_options: Option<&SnapshotOptions>,
    ) -> AbResult<ActionResult> {
        let target_id = transaction.target.target_id.clone();
        let dialog_opened = match self
            .synchronize_dialog_after_action(&target_id, &data)
            .await
        {
            Ok(opened) => opened,
            Err(error) => {
                self.abort_action(&transaction).await;
                return Err(error);
            }
        };
        let file_chooser =
            collect_file_chooser(self.owner.sessions(), &target_id, &mut transaction.events).await;
        self.owner
            .sessions()
            .release_feature(&target_id, "fileChooser", &transaction.id)
            .await?;

        let sessions = self.owner.sessions();
        let dialog = sessions.dialog_for_target(&target_id).await;
        let dialog_blocking = dialog_opened || dialog.is_some();
        let after_frames = sessions.frames(&target_id).await;
        let after_frame = after_frames
            .iter()
            .find(|frame| frame.id == transaction.target.frame_id);
        let after_url = after_frame
            .map(|frame| frame.url.clone())
            .unwrap_or_else(|| transaction.before_url.clone());
        let after_generation = after_frame
            .map(|frame| frame.document_generation.clone())
            .unwrap_or_else(|| transaction.before_generation.clone());
        let (observation, observation_outcome) =
            if observation_options.is_some() && !dialog_blocking {
                let capture = async {
                    let after_context = self.context(&target_id).await?;
                    let mut options = observation_options.expect("checked above").clone();
                    options.diff_from = baseline.map(|record| record.output.id.clone());
                    let record = observation_engine::capture(
                        &after_context,
                        client_id,
                        Uuid::new_v4().to_string(),
                        self.observations.next_revision(&target_id).await,
                        &options,
                        baseline,
                    )
                    .await?;
                    self.observations.insert(record).await
                }
                .await;
                match capture {
                    Ok(observation) => (Some(observation), ActionObservationOutcome::completed()),
                    Err(error) => (None, ActionObservationOutcome::failed(error)),
                }
            } else if observation_options.is_some() {
                (None, ActionObservationOutcome::skipped_dialog())
            } else {
                (None, ActionObservationOutcome::not_requested())
            };
        let ended_at_unix_ms = unix_ms();
        let duration_ms = transaction.started_at.elapsed().as_millis() as u64;
        Ok(ActionResult {
            id: transaction.id,
            action: transaction.action.clone(),
            target: transaction.target,
            dispatch_mechanism: dispatch_mechanism(&transaction.action).to_owned(),
            timing: ActionTiming {
                started_at_unix_ms: transaction.started_at_unix_ms,
                ended_at_unix_ms,
                duration_ms,
            },
            navigation: NavigationChange {
                changed: transaction.before_url != after_url,
                before_url: transaction.before_url,
                after_url,
            },
            document: DocumentChange {
                changed: transaction.before_generation != after_generation,
                before_generation: transaction.before_generation,
                after_generation,
            },
            dialog: DialogOutcome {
                opened: dialog_blocking,
                dialog,
            },
            file_chooser,
            pending_release: lane.pending_release.is_some(),
            last_stage: observation_outcome.last_stage().to_owned(),
            observation_outcome,
            data,
            observation,
        })
    }

    async fn resolve_action_observation(
        &self,
        client_id: &str,
        target_id: &str,
        arguments: &Value,
    ) -> AbResult<(
        Option<crate::observation::ObservationRecord>,
        Option<SnapshotOptions>,
    )> {
        let Some(mut request) = requested_action_observation(arguments)? else {
            return Ok((None, None));
        };
        let baseline = match request.baseline_observation_id.as_deref() {
            Some(observation_id) => Some(
                self.observations
                    .get_owned(
                        client_id,
                        target_id,
                        observation_id,
                        "action.observation.baseline",
                    )
                    .await?,
            ),
            None => None,
        };
        if let Some(baseline) = baseline.as_ref() {
            if request.options_explicit {
                if !request
                    .options
                    .same_capture_shape(&baseline.capture_options)
                {
                    return Err(AbError::new(
                        "observation_shape_mismatch",
                        "action.observation.shape",
                        "a diff observation must use the same capture shape as its baseline",
                    )
                    .with_details(json!({
                        "baselineObservationId": baseline.output.id,
                        "baseline": capture_shape_details(&baseline.capture_options),
                        "requested": capture_shape_details(&request.options),
                    })));
                }
            } else {
                request.options = baseline.capture_options.clone();
                request.options.diff_from = None;
            }
        }
        Ok((baseline, Some(request.options)))
    }

    pub async fn create_element_from_locator(
        &self,
        client_id: &str,
        target_id: &str,
        request: LocatorRequest,
    ) -> AbResult<ElementHandleDescriptor> {
        let _lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        let resolution = SelectorEngine::resolve(&context, &request).await?;
        let target = resolution.selected.ok_or_else(|| {
            AbError::new(
                "strict_violation",
                "element.create.locator",
                "locator did not resolve exactly one element",
            )
        })?;
        self.elements.insert(client_id, target).await
    }

    pub async fn create_element_from_ref(
        &self,
        client_id: &str,
        target_id: &str,
        observation_id: &str,
        ref_id: &str,
    ) -> AbResult<ElementHandleDescriptor> {
        let target = self
            .resolve_observation_ref(client_id, target_id, observation_id, ref_id)
            .await?;
        self.elements.insert(client_id, target).await
    }

    pub async fn perform_element(
        &self,
        client_id: &str,
        element_id: &str,
        operation: &str,
        arguments: &Value,
        dispatch_marker: &ActionDispatchMarker,
    ) -> AbResult<Value> {
        let target = self.elements.target(client_id, element_id).await?;
        let mut lane = self.owner.lock_target(&target.target_id).await?;
        let context = self.context(&target.target_id).await?;
        if operation == "screenshot" {
            return self
                .capture_target_screenshot(client_id, &context, &target, &mut lane)
                .await;
        }
        if !returns_action_result(operation) {
            return ActionRunner::perform(&context, &mut lane, &target, operation, arguments).await;
        }
        let drag_target = if operation == "drag" {
            let target_element_id = required_string(arguments, "targetElementId", "action.drag")?;
            Some(self.elements.target(client_id, target_element_id).await?)
        } else {
            None
        };
        let (baseline, observation_options) = self
            .resolve_action_observation(client_id, &target.target_id, arguments)
            .await?;
        let mut identity = ActionTargetIdentity::new("elementHandle", &target);
        identity.element_id = Some(element_id.to_owned());
        let transaction = self.begin_action(&context, operation, identity).await?;
        dispatch_marker.mark_started();
        let outcome = if let Some(drag_target) = drag_target.as_ref() {
            ActionRunner::drag(&context, &target, drag_target).await
        } else {
            ActionRunner::perform(&context, &mut lane, &target, operation, arguments).await
        };
        let value = match outcome {
            Ok(value) => value,
            Err(error) => {
                self.abort_action(&transaction).await;
                return Err(error);
            }
        };
        let result = self
            .finish_action(
                client_id,
                transaction,
                &lane,
                value,
                baseline.as_ref(),
                observation_options.as_ref(),
            )
            .await;
        Ok(json!(result?))
    }

    pub async fn dispose_element(&self, client_id: &str, element_id: &str) -> AbResult<()> {
        self.elements.dispose(client_id, element_id).await
    }

    pub fn dispose_artifact(&self, client_id: &str, artifact_id: &str) -> AbResult<()> {
        self.artifacts.dispose(client_id, artifact_id)
    }

    pub async fn perform_ref_action(
        &self,
        client_id: &str,
        target_id: &str,
        params: &Value,
        dispatch_marker: &ActionDispatchMarker,
    ) -> AbResult<Value> {
        let observation_id = required_string(params, "observationId", "action.observation")?;
        let ref_id = required_string(params, "refId", "action.ref")?.trim_start_matches('@');
        let action = required_string(params, "action", "action.kind")?;
        let record = self
            .observations
            .get_owned(client_id, target_id, observation_id, "action.resolve")
            .await?;
        let entry = record.engine_refs.get(ref_id).cloned().ok_or_else(|| {
            AbError::new(
                "ref_not_found",
                "action.resolve",
                format!("observation {observation_id} has no ref {ref_id}"),
            )
        })?;
        let public_ref = record
            .output
            .refs
            .iter()
            .find(|entry| entry.id == ref_id)
            .ok_or_else(|| {
                AbError::new(
                    "ref_not_found",
                    "action.resolve",
                    format!("observation {observation_id} did not retain ref {ref_id}"),
                )
            })?;
        let frame_id = public_ref.frame_id.clone();
        let frame = self
            .owner
            .sessions()
            .frames(target_id)
            .await
            .into_iter()
            .find(|frame| frame.id == frame_id)
            .ok_or_else(|| {
                AbError::new("stale_ref", "action.frame", "ref frame no longer exists")
            })?;
        let retained = record.retained_nodes.get(ref_id).ok_or_else(|| {
            AbError::new(
                "stale_ref",
                "action.object",
                "observation ref no longer owns its captured remote object",
            )
        })?;
        if frame.session_id != retained.session_id {
            return Err(AbError::new(
                "stale_ref",
                "action.session",
                "ref frame moved to another CDP session",
            ));
        }
        let target = ElementTarget {
            target_id: target_id.to_owned(),
            session_id: retained.session_id.clone(),
            frame_id,
            backend_node_id: entry.backend_node_id.ok_or_else(|| {
                AbError::new("stale_ref", "action.node", "ref has no live DOM node")
            })?,
            remote_object_id: Some(retained.object_id.clone()),
            object_group: Some(record.object_group.clone()),
            document_generation: public_ref.document_generation.clone(),
            role: entry.role,
            name: entry.name,
        };
        let mut lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        if action == "screenshot" {
            return self
                .capture_target_screenshot(client_id, &context, &target, &mut lane)
                .await;
        }
        if !returns_action_result(action) {
            return ActionRunner::perform(&context, &mut lane, &target, action, params).await;
        }
        let (baseline, observation_options) = self
            .resolve_action_observation(client_id, target_id, params)
            .await?;
        let mut identity = ActionTargetIdentity::new("axRef", &target);
        identity.observation_id = Some(observation_id.to_owned());
        identity.ref_id = Some(ref_id.to_owned());
        let drag_target = if action == "drag" {
            let target_observation_id = required_string(
                params,
                "targetObservationId",
                "action.drag.target_observation",
            )?;
            let target_ref_id = required_string(params, "targetRefId", "action.drag.target_ref")?;
            Some(
                self.resolve_observation_ref(
                    client_id,
                    target_id,
                    target_observation_id,
                    target_ref_id,
                )
                .await?,
            )
        } else {
            None
        };
        let transaction = self.begin_action(&context, action, identity).await?;
        dispatch_marker.mark_started();
        let outcome = if let Some(drag_target) = drag_target.as_ref() {
            ActionRunner::drag(&context, &target, drag_target).await
        } else {
            ActionRunner::perform(&context, &mut lane, &target, action, params).await
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                self.abort_action(&transaction).await;
                return Err(error);
            }
        };
        let result = self
            .finish_action(
                client_id,
                transaction,
                &lane,
                outcome,
                baseline.as_ref(),
                observation_options.as_ref(),
            )
            .await;
        result.map(|result| json!(result))
    }

    pub async fn locator_execute(
        &self,
        client_id: &str,
        target_id: &str,
        request: LocatorRequest,
        deadline: Instant,
        dispatch_marker: &ActionDispatchMarker,
    ) -> AbResult<Value> {
        loop {
            let mut lane = self.owner.lock_target(target_id).await?;
            let context = self.context(target_id).await?;
            if request.operation == "waitFor" {
                let state = request
                    .arguments
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("visible");
                let mut probe = request.clone();
                probe.operation = "count".to_owned();
                probe.index = None;
                probe.visible = match state {
                    "visible" | "hidden" => Some(true),
                    "attached" | "detached" => None,
                    _ => {
                        return Err(AbError::new(
                            "invalid_argument",
                            "locator.wait.state",
                            format!("unsupported wait state {state}"),
                        ))
                    }
                };
                let resolution = SelectorEngine::resolve(&context, &probe).await?;
                let matched = match state {
                    "visible" | "attached" => resolution.count > 0,
                    "hidden" | "detached" => resolution.count == 0,
                    _ => unreachable!("state validated above"),
                };
                if matched {
                    return Ok(json!({
                        "matched": true,
                        "state": state,
                        "count": resolution.count,
                    }));
                }
                if locator_retry_budget_exhausted(deadline) {
                    return Err(AbError::new(
                        "timeout",
                        "locator.wait",
                        format!("locator did not reach state {state} before the request deadline"),
                    )
                    .with_details(json!({
                        "operation": request.operation,
                        "state": state,
                        "lastCount": resolution.count,
                    })));
                }
                drop(lane);
                sleep(LOCATOR_RETRY_INTERVAL).await;
                continue;
            }
            match SelectorEngine::resolve(&context, &request).await {
                Ok(resolution) if request.operation == "count" => {
                    return Ok(json!({ "count": resolution.count }))
                }
                Ok(resolution) => {
                    let target = resolution
                        .selected
                        .expect("non-count resolution has a target");
                    if request.operation == "screenshot" {
                        return self
                            .capture_target_screenshot(client_id, &context, &target, &mut lane)
                            .await;
                    }
                    if !returns_action_result(&request.operation) {
                        return ActionRunner::perform(
                            &context,
                            &mut lane,
                            &target,
                            &request.operation,
                            &request.arguments,
                        )
                        .await;
                    }
                    let (baseline, observation_options) = self
                        .resolve_action_observation(client_id, target_id, &request.arguments)
                        .await?;
                    let identity = ActionTargetIdentity::new("locator", &target);
                    let transaction = self
                        .begin_action(&context, &request.operation, identity)
                        .await?;
                    dispatch_marker.mark_started();
                    let outcome = if request.operation == "drag" {
                        let drag_request = request
                            .arguments
                            .get("target")
                            .cloned()
                            .ok_or_else(|| {
                                AbError::new(
                                    "invalid_argument",
                                    "action.drag.target",
                                    "drag requires a target Locator query",
                                )
                            })
                            .and_then(|value| {
                                serde_json::from_value::<LocatorRequest>(value).map_err(|error| {
                                    AbError::new(
                                        "invalid_argument",
                                        "action.drag.target",
                                        error.to_string(),
                                    )
                                })
                            });
                        match drag_request {
                            Ok(drag_request) => {
                                match SelectorEngine::resolve(&context, &drag_request).await {
                                    Ok(resolution) => {
                                        let drag_target = resolution.selected.ok_or_else(|| {
                                            AbError::new(
                                                "strict_violation",
                                                "action.drag.target",
                                                "drag target did not resolve exactly one element",
                                            )
                                        });
                                        match drag_target {
                                            Ok(drag_target) => {
                                                ActionRunner::drag(&context, &target, &drag_target)
                                                    .await
                                            }
                                            Err(error) => Err(error),
                                        }
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        ActionRunner::perform(
                            &context,
                            &mut lane,
                            &target,
                            &request.operation,
                            &request.arguments,
                        )
                        .await
                    };
                    match outcome {
                        Ok(value) => {
                            let result = self
                                .finish_action(
                                    client_id,
                                    transaction,
                                    &lane,
                                    value,
                                    baseline.as_ref(),
                                    observation_options.as_ref(),
                                )
                                .await;
                            return Ok(json!(result?));
                        }
                        Err(error)
                            if retryable_action(&error)
                                && !locator_retry_budget_exhausted(deadline) =>
                        {
                            self.abort_action(&transaction).await;
                            drop(lane);
                            sleep(LOCATOR_RETRY_INTERVAL).await;
                        }
                        Err(error) if retryable_action(&error) => {
                            self.abort_action(&transaction).await;
                            return Err(locator_deadline_error(&request, &error));
                        }
                        Err(error) => {
                            self.abort_action(&transaction).await;
                            return Err(error);
                        }
                    }
                }
                Err(error)
                    if retryable_resolution(&error)
                        && !locator_retry_budget_exhausted(deadline) =>
                {
                    drop(lane);
                    sleep(LOCATOR_RETRY_INTERVAL).await;
                }
                Err(error) if retryable_resolution(&error) => {
                    return Err(locator_deadline_error(&request, &error));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub async fn raw_cdp(
        &self,
        target_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> AbResult<Value> {
        let sessions = self.owner.sessions();
        let session = match target_id {
            Some(target_id) => Some(sessions.root_session(target_id).await?),
            None => None,
        };
        sessions
            .client()
            .send_command(method, Some(params), session.as_deref())
            .await
            .map_err(|message| browser_error(&format!("cdp.{method}"), message))
    }

    pub(crate) async fn raw_cdp_session(
        &self,
        session_id: &str,
        method: &str,
        params: Value,
    ) -> AbResult<Value> {
        self.owner
            .sessions()
            .client()
            .send_command(method, Some(params), Some(session_id))
            .await
            .map_err(|message| browser_error(&format!("cdp.{method}"), message))
    }

    pub(crate) async fn resolve_cdp_session(
        &self,
        target_id: &str,
        requested_session_id: Option<&str>,
        frame_id: Option<&str>,
        document_generation: Option<&str>,
    ) -> AbResult<String> {
        let sessions = self.owner.sessions();
        sessions.target(target_id).await?;
        if let Some(frame_id) = frame_id {
            let frame = sessions
                .frames(target_id)
                .await
                .into_iter()
                .find(|frame| frame.id == frame_id)
                .ok_or_else(|| {
                    AbError::new(
                        "stale_frame",
                        "cdp.session.frame",
                        format!("frame {frame_id} is no longer attached to tab {target_id}"),
                    )
                })?;
            if document_generation.is_some_and(|expected| expected != frame.document_generation) {
                return Err(AbError::new(
                    "stale_document",
                    "cdp.session.document",
                    format!("frame {frame_id} has replaced its captured document"),
                ));
            }
            if requested_session_id.is_some_and(|requested| requested != frame.session_id) {
                return Err(AbError::new(
                    "stale_session",
                    "cdp.session.frame_route",
                    format!("frame {frame_id} moved to a different CDP session"),
                ));
            }
            return Ok(frame.session_id);
        }
        if let Some(session_id) = requested_session_id {
            if sessions
                .session_belongs_to_root(session_id, target_id)
                .await
            {
                return Ok(session_id.to_owned());
            }
            return Err(AbError::new(
                "session_not_found",
                "cdp.session.resolve",
                format!("CDP session {session_id} does not belong to tab {target_id}"),
            ));
        }
        sessions.root_session(target_id).await
    }

    pub(crate) async fn acquire_cdp_domain(
        &self,
        session_id: &str,
        domain: &str,
        owner_id: &str,
        params: Value,
    ) -> AbResult<()> {
        self.owner
            .sessions()
            .domains()
            .acquire_with_params(session_id, domain, owner_id, params)
            .await
    }

    pub(crate) async fn release_cdp_domain(
        &self,
        session_id: &str,
        domain: &str,
        owner_id: &str,
    ) -> AbResult<()> {
        self.owner
            .sessions()
            .domains()
            .release(session_id, domain, owner_id)
            .await
    }

    pub async fn evaluate(
        &self,
        target_id: &str,
        expression: &str,
        frame_id: Option<&str>,
        context_id: Option<i64>,
        realm_id: Option<&str>,
        requested_session_id: Option<&str>,
    ) -> AbResult<Value> {
        let _lane = self.owner.lock_target(target_id).await?;
        let context = self.context(target_id).await?;
        let realms = self.owner.sessions().realms(target_id).await;
        let realm = if let Some(realm_id) = realm_id {
            realms.into_iter().find(|realm| realm.id == realm_id)
        } else {
            match context_id {
                Some(context_id) => realms.into_iter().find(|realm| {
                    realm.execution_context_id == context_id
                        && requested_session_id
                            .is_some_and(|session_id| realm.session_id == session_id)
                }),
                None => frame_id.and_then(|frame_id| {
                    realms.into_iter().find(|realm| {
                        realm.frame_id.as_deref() == Some(frame_id) && realm.is_default
                    })
                }),
            }
        };
        if realm_id.is_some() || context_id.is_some() || frame_id.is_some() {
            let realm = realm.as_ref().ok_or_else(|| {
                AbError::new(
                    "stale_realm",
                    "evaluate.realm.resolve",
                    "the requested execution realm no longer exists",
                )
            })?;
            if context_id.is_some_and(|context_id| realm.execution_context_id != context_id)
                || requested_session_id.is_some_and(|session_id| realm.session_id != session_id)
                || frame_id.is_some_and(|frame_id| realm.frame_id.as_deref() != Some(frame_id))
            {
                return Err(AbError::new(
                    "stale_realm",
                    "evaluate.realm.identity",
                    "execution realm identity no longer matches its session or frame",
                ));
            }
        }
        let session_id = realm
            .as_ref()
            .map(|realm| realm.session_id.clone())
            .unwrap_or_else(|| context.root_session_id.clone());
        let mut params =
            json!({ "expression": expression, "returnByValue": true, "awaitPromise": true });
        if let Some(realm) = realm.as_ref() {
            params["contextId"] = json!(realm.execution_context_id);
        }
        let result = context
            .client
            .send_command("Runtime.evaluate", Some(params), Some(&session_id))
            .await
            .map_err(|message| browser_error("evaluate", message))?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(browser_error("evaluate", exception.to_string()));
        }
        Ok(json!({ "result": result.pointer("/result/value").cloned().unwrap_or(Value::Null) }))
    }

    pub async fn activate(&self, target_id: &str) -> AbResult<Value> {
        self.owner.sessions().target(target_id).await?;
        self.owner
            .sessions()
            .client()
            .send_command(
                "Target.activateTarget",
                Some(json!({ "targetId": target_id })),
                None,
            )
            .await
            .map_err(|message| browser_error("activate", message))
    }

    pub async fn reload(&self, target_id: &str) -> AbResult<Value> {
        self.raw_cdp(Some(target_id), "Page.reload", json!({}))
            .await
    }

    pub async fn history(&self, target_id: &str, delta: i64) -> AbResult<Value> {
        let history = self
            .raw_cdp(Some(target_id), "Page.getNavigationHistory", json!({}))
            .await?;
        let current = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let entries = history
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| browser_error("history", "Chrome returned no entries"))?;
        let index = current + delta;
        let entry_id = usize::try_from(index)
            .ok()
            .and_then(|index| entries.get(index))
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                AbError::new(
                    "navigation_unavailable",
                    "tab.history",
                    "no history entry in that direction",
                )
            })?;
        self.raw_cdp(
            Some(target_id),
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
        )
        .await
    }

    pub async fn wait_for(
        &self,
        client_id: &str,
        target_id: &str,
        params: &Value,
        deadline: Instant,
    ) -> AbResult<Value> {
        let selector = params.get("selector").and_then(Value::as_str);
        let text = params.get("text").and_then(Value::as_str);
        let query = match (selector, text) {
            (Some(selector), None) => LocatorQuery::Css {
                value: selector.to_owned(),
            },
            (None, Some(text)) => LocatorQuery::Text {
                value: text.to_owned(),
                exact: false,
            },
            (Some(_), Some(_)) => {
                return Err(AbError::new(
                    "invalid_argument",
                    "tab.wait",
                    "waitFor accepts either selector or text, not both",
                ))
            }
            (None, None) => {
                return Err(AbError::new(
                    "invalid_argument",
                    "tab.wait",
                    "waitFor requires selector or text",
                ))
            }
        };
        let dispatch_marker = ActionDispatchMarker::default();
        self.locator_execute(
            client_id,
            target_id,
            LocatorRequest {
                query,
                index: None,
                visible: None,
                operation: "waitFor".to_owned(),
                arguments: json!({
                    "state": params.get("state").and_then(Value::as_str).unwrap_or("visible")
                }),
            },
            deadline,
            &dispatch_marker,
        )
        .await
    }

    pub async fn handle_dialog(
        &self,
        target_id: &str,
        dialog_id: &str,
        session_id: &str,
        accept: bool,
        prompt_text: Option<&str>,
    ) -> AbResult<Value> {
        let sessions = self.owner.sessions();
        let dialog = sessions
            .exact_dialog(target_id, dialog_id, session_id)
            .await?;
        let client = sessions.client();
        let mut lane = self.owner.lock_target_for_dialog(target_id).await?;
        let mut params = json!({ "accept": accept });
        if let Some(prompt_text) = prompt_text {
            params["promptText"] = Value::String(prompt_text.to_owned());
        }
        client
            .send_command(
                "Page.handleJavaScriptDialog",
                Some(params),
                Some(&dialog.session_id),
            )
            .await
            .map_err(|message| browser_error("dialog", message))?;
        sessions
            .wait_for_dialog_closed(&dialog.id, &dialog.session_id)
            .await?;
        if let Some(release) = lane.pending_release.take() {
            interaction::dispatch_pending_release(&client, &release)
                .await
                .map_err(|message| browser_error("dialog.pointer_release", message))?;
        }
        Ok(json!({
            "handled": true,
            "accepted": accept,
            "dialogId": dialog.id,
            "sessionId": dialog.session_id
        }))
    }

    pub async fn subscribe_dialogs(&self, target_id: &str) -> AbResult<DialogSubscription> {
        self.owner.sessions().target(target_id).await?;
        let receiver = self.owner.sessions().subscribe_dialogs();
        let initial = self.owner.sessions().dialogs_for_target(target_id).await;
        Ok(DialogSubscription {
            target_id: target_id.to_owned(),
            initial,
            receiver,
        })
    }

    pub(crate) fn subscribe_session_lifecycle(
        &self,
    ) -> broadcast::Receiver<super::session_manager::SessionLifecycle> {
        self.owner.sessions().subscribe_lifecycle()
    }

    async fn synchronize_dialog_after_action(
        &self,
        target_id: &str,
        value: &Value,
    ) -> AbResult<bool> {
        let opened = value
            .get("dialogOpened")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !opened {
            return Ok(false);
        }
        let event_session_id = value.get("dialogSessionId").and_then(Value::as_str);
        self.owner
            .sessions()
            .wait_for_dialog(target_id, event_session_id)
            .await?;
        Ok(true)
    }

    pub async fn subscribe_events(
        &self,
        target_id: &str,
        domains: &[&str],
        owner_id: &str,
        domain_params: HashMap<String, Value>,
    ) -> AbResult<EventSubscription> {
        let sessions = self.owner.sessions();
        let target_sessions = sessions.sessions_for_root(target_id).await;
        if target_sessions.is_empty() {
            return Err(AbError::new(
                "target_not_found",
                "resource.subscribe",
                format!("tab {target_id} does not exist"),
            ));
        }
        let mut session_ids = HashSet::new();
        for session in target_sessions {
            session_ids.insert(session.session_id.clone());
            for domain in domains {
                sessions
                    .domains()
                    .acquire_with_params(
                        &session.session_id,
                        domain,
                        owner_id,
                        domain_params
                            .get(*domain)
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                    )
                    .await?;
            }
        }
        Ok(EventSubscription {
            target_id: Some(target_id.to_owned()),
            owner_id: owner_id.to_owned(),
            domains: domains.iter().map(|domain| (*domain).to_owned()).collect(),
            domain_params,
            session_ids,
            receiver: sessions.client().subscribe(),
            lifecycle: sessions.subscribe_lifecycle(),
            leases: sessions.domains(),
        })
    }

    pub async fn subscribe_browser_events(&self, owner_id: &str) -> EventSubscription {
        let sessions = self.owner.sessions();
        EventSubscription {
            target_id: None,
            owner_id: owner_id.to_owned(),
            domains: Vec::new(),
            domain_params: HashMap::new(),
            session_ids: HashSet::new(),
            receiver: sessions.subscribe_browser_events(),
            lifecycle: sessions.subscribe_lifecycle(),
            leases: sessions.domains(),
        }
    }

    pub async fn root_target_for_event(
        &self,
        session_id: Option<&str>,
        frame_id: Option<&str>,
    ) -> Option<String> {
        let sessions = self.owner.sessions();
        if let Some(session_id) = session_id {
            if let Some(target_id) = sessions.root_target_for_session(session_id).await {
                return Some(target_id);
            }
        }
        match frame_id {
            Some(frame_id) => sessions.root_target_for_frame(frame_id).await,
            None => None,
        }
    }

    pub async fn acquire_feature(
        &self,
        target_id: &str,
        feature: &str,
        owner: &str,
    ) -> AbResult<()> {
        self.owner
            .sessions()
            .acquire_feature(target_id, feature, owner)
            .await
    }

    pub async fn release_feature(
        &self,
        target_id: &str,
        feature: &str,
        owner: &str,
    ) -> AbResult<()> {
        self.owner
            .sessions()
            .release_feature(target_id, feature, owner)
            .await
    }

    pub async fn add_init_script(
        &self,
        owner_id: &str,
        target_id: &str,
        definition: InitScriptDefinition,
    ) -> AbResult<InitScriptSubscription> {
        self.owner
            .sessions()
            .register_init_script(owner_id, target_id, definition)
            .await
    }

    pub async fn remove_init_script(&self, owner_id: &str) -> AbResult<()> {
        self.owner.sessions().unregister_init_script(owner_id).await
    }

    pub async fn init_script_instances(&self, owner_id: &str) -> AbResult<Vec<InitScriptInstance>> {
        self.owner.sessions().init_script_instances(owner_id).await
    }

    pub async fn command_init_script(
        &self,
        owner_id: &str,
        instance_id: &str,
        name: &str,
        payload: Value,
    ) -> AbResult<Value> {
        self.owner
            .sessions()
            .command_init_script(owner_id, instance_id, name, payload)
            .await
    }

    async fn resolve_observation_ref(
        &self,
        client_id: &str,
        target_id: &str,
        observation_id: &str,
        ref_id: &str,
    ) -> AbResult<ElementTarget> {
        let normalized = ref_id.trim_start_matches('@');
        let record = self
            .observations
            .get_owned(client_id, target_id, observation_id, "element.ref")
            .await?;
        let entry = record.engine_refs.get(normalized).cloned().ok_or_else(|| {
            AbError::new(
                "ref_not_found",
                "element.ref",
                format!("observation {observation_id} has no ref {normalized}"),
            )
        })?;
        let public_ref = record
            .output
            .refs
            .iter()
            .find(|entry| entry.id == normalized)
            .ok_or_else(|| {
                AbError::new(
                    "ref_not_found",
                    "element.ref",
                    format!("observation {observation_id} did not retain ref {normalized}"),
                )
            })?;
        let frame = self
            .owner
            .sessions()
            .frames(target_id)
            .await
            .into_iter()
            .find(|frame| frame.id == public_ref.frame_id)
            .ok_or_else(|| {
                AbError::new("stale_ref", "element.frame", "ref frame no longer exists")
            })?;
        let retained = record.retained_nodes.get(normalized).ok_or_else(|| {
            AbError::new(
                "stale_ref",
                "element.object",
                "observation ref no longer owns its captured remote object",
            )
        })?;
        if frame.session_id != retained.session_id {
            return Err(AbError::new(
                "stale_ref",
                "element.session",
                "ref frame moved to another CDP session",
            ));
        }
        Ok(ElementTarget {
            target_id: target_id.to_owned(),
            session_id: retained.session_id.clone(),
            frame_id: public_ref.frame_id.clone(),
            backend_node_id: entry.backend_node_id.ok_or_else(|| {
                AbError::new("stale_ref", "element.node", "ref has no live DOM node")
            })?,
            remote_object_id: Some(retained.object_id.clone()),
            object_group: Some(record.object_group.clone()),
            document_generation: public_ref.document_generation.clone(),
            role: entry.role,
            name: entry.name,
        })
    }

    async fn capture_target_screenshot(
        &self,
        client_id: &str,
        context: &TargetContext,
        target: &ElementTarget,
        lane: &mut super::target_lane::TargetState,
    ) -> AbResult<Value> {
        ActionRunner::assert_live(context, target).await?;
        lane.refs.clear();
        lane.refs.add_exact_with_frame(
            "e1".to_owned(),
            target.backend_node_id,
            &target.role,
            &target.name,
            Some(&target.frame_id),
        );
        let captured = capture_screenshot(
            context,
            &lane.refs,
            Some("@e1".to_owned()),
            false,
            ScreenshotScale::Device,
            &self.generation,
        )
        .await;
        lane.refs.clear();
        serde_json::to_value(captured?.commit(&self.artifacts, client_id)?)
            .map_err(|error| browser_error("screenshot.serialize", error.to_string()))
    }

    async fn context(&self, target_id: &str) -> AbResult<TargetContext> {
        TargetContext::resolve(self.owner.sessions(), target_id).await
    }
}

fn tab_info(target: super::session_manager::TargetSession, active: bool) -> TabInfo {
    TabInfo {
        id: target.target_id,
        opener_id: target.opener_id,
        title: target.title,
        url: target.url,
        kind: target.target_type,
        active,
        engine_id: "ab".to_owned(),
        label: None,
    }
}

fn frame_record(frame: FrameState) -> FrameRecord {
    FrameRecord {
        id: frame.id,
        target_id: frame.root_target_id,
        session_id: frame.session_id,
        parent_id: frame.parent_id,
        url: frame.url,
        name: frame.name,
        document_generation: frame.document_generation,
    }
}

fn realm_record(realm: RealmState) -> RealmRecord {
    RealmRecord {
        id: realm.id,
        execution_context_id: realm.execution_context_id,
        root_target_id: realm.root_target_id,
        target_id: realm.target_id,
        session_id: realm.session_id,
        frame_id: realm.frame_id,
        origin: realm.origin,
        name: realm.name,
        kind: realm.kind,
        is_default: realm.is_default,
    }
}

struct ViewportState {
    id: String,
    width: f64,
    height: f64,
    page_x: f64,
    page_y: f64,
    device_scale_factor: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureIdentity {
    document_generation: String,
    frame_topology: Vec<(String, String, String)>,
    viewport_id: String,
}

struct PendingScreenshot {
    bytes: Vec<u8>,
    viewport: ViewportState,
    image_width: f64,
    image_height: f64,
    full_page: bool,
    scale: ScreenshotScale,
}

impl PendingScreenshot {
    fn commit(self, artifacts: &ArtifactStore, owner_id: &str) -> AbResult<ScreenshotOutput> {
        Ok(ScreenshotOutput {
            artifact: artifacts.write(owner_id, "png", "image/png", &self.bytes)?,
            viewport_id: self.viewport.id,
            width: self.image_width,
            height: self.image_height,
            full_page: self.full_page,
            scale: self.scale,
            css_viewport: CssViewport {
                width: self.viewport.width,
                height: self.viewport.height,
                page_x: self.viewport.page_x,
                page_y: self.viewport.page_y,
                device_scale_factor: self.viewport.device_scale_factor,
            },
        })
    }
}

async fn capture_identity(context: &TargetContext, generation: &str) -> AbResult<CaptureIdentity> {
    let mut frame_topology = context
        .sessions
        .frames(&context.target_id)
        .await
        .into_iter()
        .map(|frame| {
            (
                frame.id,
                frame.parent_id.unwrap_or_default(),
                frame.document_generation,
            )
        })
        .collect::<Vec<_>>();
    frame_topology.sort();
    Ok(CaptureIdentity {
        document_generation: context.root_frame.document_generation.clone(),
        frame_topology,
        viewport_id: viewport_state(context, generation).await?.id,
    })
}

async fn capture_screenshot(
    context: &TargetContext,
    refs: &crate::agent_browser_engine::element::RefMap,
    selector: Option<String>,
    full_page: bool,
    scale: ScreenshotScale,
    generation: &str,
) -> AbResult<PendingScreenshot> {
    let viewport = viewport_state(context, generation).await?;
    let capture_scale = match scale {
        ScreenshotScale::Css => 1.0 / viewport.device_scale_factor.max(0.1),
        ScreenshotScale::Device => 1.0,
    };
    let encoded = capture_screenshot_base64(
        &context.client,
        &context.root_session_id,
        refs,
        &ScreenshotOptions {
            selector,
            full_page,
            scale: capture_scale,
            ..ScreenshotOptions::default()
        },
        &context.iframe_sessions,
    )
    .await
    .map_err(|message| browser_error("screenshot", message))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| browser_error("screenshot.decode", error.to_string()))?;
    let (image_width, image_height) = png_dimensions(&bytes)
        .map(|(width, height)| (width as f64, height as f64))
        .unwrap_or((viewport.width, viewport.height));
    Ok(PendingScreenshot {
        bytes,
        viewport,
        image_width,
        image_height,
        full_page,
        scale,
    })
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

async fn viewport_state(context: &TargetContext, generation: &str) -> AbResult<ViewportState> {
    let metrics = context
        .client
        .send_command_no_params("Page.getLayoutMetrics", Some(&context.root_session_id))
        .await
        .map_err(|message| browser_error("viewport.metrics", message))?;
    let viewport = metrics
        .get("cssVisualViewport")
        .or_else(|| metrics.get("visualViewport"))
        .unwrap_or(&Value::Null);
    let width = viewport
        .get("clientWidth")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let height = viewport
        .get("clientHeight")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let page_x = viewport.get("pageX").and_then(Value::as_f64).unwrap_or(0.0);
    let page_y = viewport.get("pageY").and_then(Value::as_f64).unwrap_or(0.0);
    let scale = context
        .client
        .send_command(
            "Runtime.evaluate",
            Some(json!({ "expression": "window.devicePixelRatio", "returnByValue": true })),
            Some(&context.root_session_id),
        )
        .await
        .ok()
        .and_then(|value| value.pointer("/result/value").and_then(Value::as_f64))
        .unwrap_or(1.0);
    Ok(ViewportState {
        id: format!(
            "{generation}:{}:{}:{width}x{height}@{page_x},{page_y}:{scale}",
            context.target_id, context.root_frame.document_generation
        ),
        width,
        height,
        page_x,
        page_y,
        device_scale_factor: scale,
    })
}

fn required_string<'a>(value: &'a Value, field: &str, stage: &str) -> AbResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        AbError::new(
            "invalid_argument",
            stage,
            format!("{field} must be a string"),
        )
    })
}

fn required_number(value: &Value, field: &str, stage: &str) -> AbResult<f64> {
    value.get(field).and_then(Value::as_f64).ok_or_else(|| {
        AbError::new(
            "invalid_argument",
            stage,
            format!("{field} must be a finite number"),
        )
    })
}

struct ActionObservationRequest {
    options: SnapshotOptions,
    options_explicit: bool,
    baseline_observation_id: Option<String>,
}

fn requested_action_observation(arguments: &Value) -> AbResult<Option<ActionObservationRequest>> {
    let observe = arguments
        .get("observe")
        .and_then(Value::as_str)
        .unwrap_or("none");
    if observe == "none" {
        return Ok(None);
    }
    if !matches!(observe, "diff" | "state") {
        return Err(AbError::new(
            "invalid_argument",
            "action.observation.mode",
            format!("unsupported action observation mode {observe}"),
        ));
    }
    let options_explicit = arguments.get("observation").is_some();
    let mut options = match arguments.get("observation") {
        Some(value) => {
            serde_json::from_value::<SnapshotOptions>(value.clone()).map_err(|error| {
                AbError::new(
                    "invalid_argument",
                    "action.observation",
                    format!("invalid action observation options: {error}"),
                )
            })?
        }
        None => SnapshotOptions::default(),
    };
    if options.diff_from.take().is_some() {
        return Err(AbError::new(
            "invalid_argument",
            "action.observation.diff_from",
            "action observation diffFrom is owned by the action transaction",
        ));
    }
    options.interactive()?;
    options.frame_root()?;
    let baseline_observation_id = arguments
        .get("baselineObservationId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if observe == "diff" && baseline_observation_id.is_none() {
        return Err(AbError::new(
            "invalid_argument",
            "action.observation.baseline",
            "observe diff requires an explicit baselineObservationId",
        ));
    }
    if observe == "state" && baseline_observation_id.is_some() {
        return Err(AbError::new(
            "invalid_argument",
            "action.observation.baseline",
            "observe state does not accept a baselineObservationId",
        ));
    }
    Ok(Some(ActionObservationRequest {
        options,
        options_explicit,
        baseline_observation_id,
    }))
}

fn capture_shape_details(options: &SnapshotOptions) -> Value {
    json!({
        "mode": options.mode,
        "surface": options.surface,
        "maxDepth": options.max_depth,
        "maxChars": options.max_chars,
        "includeUrls": options.include_urls,
        "frames": format!("{:?}", options.frames),
    })
}

fn returns_action_result(operation: &str) -> bool {
    matches!(
        operation,
        "click"
            | "dblclick"
            | "hover"
            | "wheel"
            | "fill"
            | "type"
            | "press"
            | "focus"
            | "clear"
            | "scrollintoview"
            | "scrollIntoView"
            | "select"
            | "check"
            | "uncheck"
            | "upload"
            | "drag"
            | "dominvoke"
    )
}

async fn collect_file_chooser(
    sessions: Arc<super::session_manager::SessionManager>,
    target_id: &str,
    receiver: &mut broadcast::Receiver<CdpEvent>,
) -> FileChooserOutcome {
    let deadline = Instant::now() + Duration::from_millis(75);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return FileChooserOutcome::none();
        }
        match timeout(remaining, receiver.recv()).await {
            Ok(Ok(event)) if event.method == "Page.fileChooserOpened" => {
                let Some(session_id) = event.session_id else {
                    continue;
                };
                if !sessions
                    .session_belongs_to_root(&session_id, target_id)
                    .await
                {
                    continue;
                }
                return FileChooserOutcome {
                    opened: true,
                    complete: true,
                    session_id: Some(session_id),
                    frame_id: event
                        .params
                        .get("frameId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    backend_node_id: event.params.get("backendNodeId").and_then(Value::as_i64),
                    mode: event
                        .params
                        .get("mode")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                };
            }
            Ok(Ok(_)) => {}
            Ok(Err(broadcast::error::RecvError::Lagged(_)))
            | Ok(Err(broadcast::error::RecvError::Closed)) => {
                let mut outcome = FileChooserOutcome::none();
                outcome.complete = false;
                return outcome;
            }
            Err(_) => return FileChooserOutcome::none(),
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

const LOCATOR_RETRY_INTERVAL: Duration = Duration::from_millis(50);

fn locator_retry_budget_exhausted(deadline: Instant) -> bool {
    deadline.saturating_duration_since(Instant::now()) <= LOCATOR_RETRY_INTERVAL
}

fn locator_deadline_error(request: &LocatorRequest, last_error: &AbError) -> AbError {
    AbError::new(
        "timeout",
        "locator.resolve.deadline",
        format!(
            "locator {} timed out; last attempt failed at {}: {}",
            request.operation, last_error.stage, last_error.message
        ),
    )
    .with_details(json!({
        "operation": request.operation,
        "query": request.query,
        "lastError": {
            "kind": last_error.kind,
            "stage": last_error.stage,
            "message": last_error.message,
        },
    }))
}

fn retryable_resolution(error: &AbError) -> bool {
    matches!(error.kind.as_str(), "selector_error" | "not_found")
        && !matches!(
            error.stage.as_str(),
            "selector.query.strategy" | "selector.query.encode"
        )
}

fn retryable_action(error: &AbError) -> bool {
    error.kind == "action_target_unavailable"
}

fn browser_error(stage: &str, message: impl Into<String>) -> AbError {
    AbError::new("browser_error", format!("browser.{stage}"), message.into())
}
