use crate::actions::ActionDispatchMarker;
use crate::browser::BrowserCore;
use crate::diagnostics::RequestTrace;
use crate::error::{AbError, AbResult};
use crate::resources::ResourceRegistry;
use ab_protocol::{
    Cancel, ChromeIdentity, ChromeSource, ClientHello, ClientMessage, ClientReady, DaemonMessage,
    ErrorData, Request, Response, ResponseOutcome, Stage, BUILD_ID, PROTOCOL_VERSION, SDK_VERSION,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tokio::time::{sleep_until, timeout, Instant};
use uuid::Uuid;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub struct DaemonState {
    pub daemon_id: String,
    pub browser_generation: String,
    pub chrome_source: &'static str,
    pub chrome_pid: Option<u32>,
    pub browser: Arc<BrowserCore>,
    pub resources: Arc<ResourceRegistry>,
    pub connections: AtomicUsize,
    pub active_clients: AtomicUsize,
    pub active_side_effects: AtomicUsize,
    pub handshake_gate: Mutex<()>,
    pub shutdown: watch::Sender<bool>,
}

type Outbound = mpsc::UnboundedSender<Value>;
type Inflight = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;

struct ActiveSideEffect {
    state: Arc<DaemonState>,
}

impl Drop for ActiveSideEffect {
    fn drop(&mut self) {
        self.state
            .active_side_effects
            .fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn serve_client(stream: UnixStream, state: Arc<DaemonState>) -> AbResult<()> {
    state.connections.fetch_add(1, Ordering::SeqCst);
    let result = serve_client_inner(stream, Arc::clone(&state)).await;
    state.connections.fetch_sub(1, Ordering::SeqCst);
    result
}

async fn serve_client_inner(mut stream: UnixStream, state: Arc<DaemonState>) -> AbResult<()> {
    if let Err(error) = validate_peer_uid(&stream) {
        reject_client(&mut stream, &error).await;
        return Err(error);
    }
    let hello = parse_hello(read_frame(&mut stream).await?)?;
    let handshake = state.handshake_gate.lock().await;
    if hello.protocol_version != PROTOCOL_VERSION {
        let error = AbError::new(
            "protocol_version_mismatch",
            "handshake.version",
            format!("daemon requires protocol version {PROTOCOL_VERSION}"),
        )
        .with_details(json!({
            "daemonProtocolVersion": PROTOCOL_VERSION,
            "clientProtocolVersion": hello.protocol_version,
            "handoverAllowed": false
        }));
        reject_client(&mut stream, &error).await;
        return Err(error);
    }
    if hello.build_id != BUILD_ID {
        let connections = state.connections.load(Ordering::SeqCst);
        let active_clients = state.active_clients.load(Ordering::SeqCst);
        let active_side_effects = state.active_side_effects.load(Ordering::SeqCst);
        let handover_allowed = connections == 1 && active_clients == 0 && active_side_effects == 0;
        let error = if handover_allowed {
            AbError::new(
                "daemon_version_mismatch",
                "handshake.build",
                format!(
                    "daemon build {BUILD_ID} is yielding to client build {}",
                    hello.build_id
                ),
            )
        } else {
            AbError::new(
                "daemon_version_in_use",
                "handshake.build",
                format!("daemon build {BUILD_ID} still has active owners"),
            )
        }
        .with_details(json!({
            "daemonBuildId": BUILD_ID,
            "clientBuildId": hello.build_id,
            "handoverAllowed": handover_allowed,
            "connections": connections,
            "activeClients": active_clients,
            "activeSideEffects": active_side_effects
        }));
        reject_client(&mut stream, &error).await;
        if handover_allowed {
            let _ = state.shutdown.send(true);
        }
        return Err(error);
    }
    let client_id = Uuid::new_v4().to_string();
    let ready = DaemonMessage::ClientReady(ClientReady {
        protocol_version: PROTOCOL_VERSION,
        sdk_version: SDK_VERSION.to_owned(),
        build_id: BUILD_ID.to_owned(),
        client_id: client_id.clone(),
        daemon_id: state.daemon_id.clone(),
        browser_generation: state.browser_generation.clone(),
        chrome: ChromeIdentity {
            source: match state.chrome_source {
                "launched" => ChromeSource::Launched,
                "reattached" => ChromeSource::Reattached,
                other => {
                    return Err(AbError::new(
                        "invalid_daemon_state",
                        "handshake.chrome_source",
                        format!("unknown Chrome source {other}"),
                    ))
                }
            },
            pid: state.chrome_pid,
        },
    });
    write_frame(
        &mut stream,
        &serde_json::to_value(ready).map_err(serialization_error)?,
    )
    .await?;
    state.resources.register_client(&client_id).await;
    state.active_clients.fetch_add(1, Ordering::SeqCst);
    drop(handshake);

    let result = serve_messages(stream, Arc::clone(&state), client_id.clone()).await;
    state.resources.cleanup_client(&client_id).await;
    state.browser.cleanup_client(&client_id).await;
    state.active_clients.fetch_sub(1, Ordering::SeqCst);
    result
}

async fn serve_messages(
    stream: UnixStream,
    state: Arc<DaemonState>,
    client_id: String,
) -> AbResult<()> {
    let (mut reader, mut writer) = stream.into_split();
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
    let writer_task = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            write_frame(&mut writer, &message).await?;
        }
        Ok::<(), AbError>(())
    });
    let inflight: Inflight = Arc::new(Mutex::new(HashMap::new()));
    let mut request_tasks = JoinSet::new();

    let read_result = loop {
        let frame = tokio::select! {
            frame = read_frame(&mut reader) => Some(frame),
            result = request_tasks.join_next(), if !request_tasks.is_empty() => {
                if let Some(result) = result {
                    report_request_task_result(&outbound, result);
                }
                None
            }
        };
        let Some(frame) = frame else {
            continue;
        };
        let value = match frame {
            Ok(value) => value,
            Err(error) if error.kind == "client_disconnected" => break Ok(()),
            Err(error) => break Err(error),
        };
        let message: ClientMessage = match serde_json::from_value(value) {
            Ok(message) => message,
            Err(error) => {
                emit_daemon_error(
                    &outbound,
                    "protocol.error",
                    AbError::new(
                        "protocol_error",
                        "rpc.message",
                        format!("invalid client message: {error}"),
                    ),
                );
                continue;
            }
        };
        match message {
            ClientMessage::Request(request) => {
                let request = *request;
                let (cancel_tx, cancel_rx) = watch::channel(false);
                if inflight
                    .lock()
                    .await
                    .insert(request.id.clone(), cancel_tx)
                    .is_some()
                {
                    emit_response(
                        &outbound,
                        request.id,
                        Err(AbError::new(
                            "duplicate_request_id",
                            "request.accept",
                            "request id is already active",
                        )),
                    );
                    continue;
                }
                request_tasks.spawn(run_request(
                    Arc::clone(&state),
                    client_id.clone(),
                    request,
                    cancel_rx,
                    outbound.clone(),
                    Arc::clone(&inflight),
                ));
            }
            ClientMessage::Cancel(cancel) => cancel_request(&inflight, cancel).await,
            ClientMessage::ClientHello(_) => emit_daemon_error(
                &outbound,
                "protocol.error",
                AbError::new(
                    "protocol_error",
                    "rpc.handshake.repeated",
                    "client.hello is only valid as the first frame",
                ),
            ),
        }
    };

    let cancellation_senders = inflight.lock().await.values().cloned().collect::<Vec<_>>();
    for sender in cancellation_senders {
        let _ = sender.send(true);
    }
    while let Some(result) = request_tasks.join_next().await {
        report_request_task_result(&outbound, result);
    }
    drop(outbound);
    writer_task.abort();
    match writer_task.await {
        Ok(Ok(())) => read_result,
        Ok(Err(error)) if error.kind == "client_disconnected" => read_result,
        Ok(Err(error)) => Err(error),
        Err(error) if error.is_cancelled() => read_result,
        Err(error) => Err(AbError::new(
            "transport_error",
            "rpc.writer.join",
            format!("writer task failed: {error}"),
        )),
    }
}

async fn run_request(
    state: Arc<DaemonState>,
    client_id: String,
    request: Request,
    mut cancelled: watch::Receiver<bool>,
    outbound: Outbound,
    inflight: Inflight,
) {
    let trace = RequestTrace::from_request(&request);
    let request_id = trace.request_id().to_owned();
    let side_effect = may_have_side_effect(&request);
    let dispatch_marker = ActionDispatchMarker::default();
    let deadline_unix_ms = request.deadline_unix_ms;
    let deadline = deadline_instant(request.deadline_unix_ms);
    if side_effect {
        state.active_side_effects.fetch_add(1, Ordering::SeqCst);
    }
    emit_stage(
        &outbound,
        trace.stage(
            "dispatched",
            1,
            Some(json!({
                "deadlineUnixMs": deadline_unix_ms,
                "sideEffect": side_effect,
            })),
        ),
    );
    let active_side_effect = side_effect.then(|| ActiveSideEffect {
        state: Arc::clone(&state),
    });
    let operation_state = Arc::clone(&state);
    let operation_outbound = outbound.clone();
    let operation_dispatch_marker = dispatch_marker.clone();
    let mut operation = tokio::spawn(async move {
        let _active_side_effect = active_side_effect;
        dispatch(
            operation_state,
            client_id,
            request,
            operation_outbound,
            operation_dispatch_marker,
        )
        .await
    });
    let outcome = tokio::select! {
        biased;
        result = &mut operation => match result {
            Ok(result) => result,
            Err(error) => Err(request_join_error(error)),
        },
        changed = cancelled.changed() => {
            let reason = if changed.is_ok() && *cancelled.borrow() {
                "request was cancelled by the client"
            } else {
                "client connection closed while request was running"
            };
            if side_effect && dispatch_marker.started() {
                settle_interrupted_side_effect(
                    &trace,
                    &outbound,
                    &inflight,
                    &request_id,
                    &mut operation,
                    "request.cancel",
                    reason,
                ).await;
                return;
            }
            match abort_and_join_operation(&mut operation).await {
                Some(outcome) => outcome,
                None => Err(trace.interrupted_error(
                    false,
                    "request.cancel",
                    reason,
                )),
            }
        },
        _ = sleep_until(deadline) => {
            if side_effect && dispatch_marker.started() {
                settle_interrupted_side_effect(
                    &trace,
                    &outbound,
                    &inflight,
                    &request_id,
                    &mut operation,
                    "request.deadline",
                    "request deadline elapsed while the operation was running",
                ).await;
                return;
            }
            match abort_and_join_operation(&mut operation).await {
                Some(outcome) => outcome,
                None => Err(trace.interrupted_error(
                    false,
                    "request.deadline",
                    "request deadline elapsed while the operation was running",
                )),
            }
        },
    };
    let outcome = outcome.map_err(|error| {
        let retryable = !(side_effect && dispatch_marker.started())
            && matches!(error.kind.as_str(), "timeout" | "cancelled");
        trace.enrich_error(error, retryable)
    });
    emit_stage(
        &outbound,
        trace.stage("settled", 2, Some(outcome_detail(&outcome))),
    );
    emit_response(&outbound, request_id.clone(), outcome);
    inflight.lock().await.remove(&request_id);
}

async fn settle_interrupted_side_effect(
    trace: &RequestTrace,
    outbound: &Outbound,
    inflight: &Inflight,
    request_id: &str,
    operation: &mut JoinHandle<AbResult<Value>>,
    stage: &str,
    reason: &str,
) {
    let caller_outcome = Err(trace.interrupted_error(true, stage, reason));
    emit_stage(
        outbound,
        trace.stage("settled", 2, Some(outcome_detail(&caller_outcome))),
    );
    emit_response(outbound, request_id.to_owned(), caller_outcome);
    inflight.lock().await.remove(request_id);

    let terminal = match operation.await {
        Ok(outcome) => outcome,
        Err(error) => Err(request_join_error(error)),
    };
    emit_stage(
        outbound,
        trace.stage(
            "operation.settled",
            3,
            Some(json!({
                "callerOutcome": "outcome_unknown",
                "terminal": outcome_detail(&terminal),
            })),
        ),
    );
}

fn outcome_detail(outcome: &AbResult<Value>) -> Value {
    match outcome {
        Ok(_) => json!({ "status": "success" }),
        Err(error) => json!({
            "status": "error",
            "kind": error.kind,
            "stage": error.stage,
            "retryable": error.retryable,
        }),
    }
}

async fn abort_and_join_operation(
    operation: &mut JoinHandle<AbResult<Value>>,
) -> Option<AbResult<Value>> {
    operation.abort();
    match operation.await {
        Ok(outcome) => Some(outcome),
        Err(error) if error.is_cancelled() => None,
        Err(error) => Some(Err(request_join_error(error))),
    }
}

fn request_join_error(error: JoinError) -> AbError {
    AbError::new(
        "request_task_failed",
        "request.join",
        format!("request task failed: {error}"),
    )
    .with_cause(error.to_string())
}

fn report_request_task_result(outbound: &Outbound, result: Result<(), JoinError>) {
    if let Err(error) = result {
        emit_daemon_error(outbound, "request.task.failed", request_join_error(error));
    }
}

async fn cancel_request(inflight: &Inflight, cancel: Cancel) {
    if let Some(sender) = inflight.lock().await.get(&cancel.request_id) {
        let _ = sender.send(true);
    }
}

fn parse_hello(value: Value) -> AbResult<ClientHello> {
    let ClientMessage::ClientHello(hello) = serde_json::from_value(value).map_err(|error| {
        AbError::new(
            "protocol_error",
            "handshake.type",
            format!("first frame must be client.hello: {error}"),
        )
    })?
    else {
        return Err(AbError::new(
            "protocol_error",
            "handshake.type",
            "first frame must be client.hello",
        ));
    };
    Ok(hello)
}

async fn reject_client(stream: &mut UnixStream, error: &AbError) {
    let message = DaemonMessage::ClientRejected {
        error: error_data(error),
    };
    if let Ok(value) = serde_json::to_value(message) {
        let _ = write_frame(stream, &value).await;
    }
}

async fn dispatch(
    state: Arc<DaemonState>,
    client_id: String,
    request: Request,
    outbound: Outbound,
    dispatch_marker: ActionDispatchMarker,
) -> AbResult<Value> {
    if now_unix_ms() > request.deadline_unix_ms {
        return Err(AbError::new(
            "timeout",
            "request.dispatch",
            "request deadline elapsed before dispatch",
        ));
    }
    let request_deadline = deadline_instant(request.deadline_unix_ms);
    let delayed_dispatch_marker = matches!(
        request.method.as_str(),
        "action.perform" | "cua.perform" | "locator.execute" | "element.perform"
    );
    if may_have_side_effect(&request) && !delayed_dispatch_marker {
        dispatch_marker.mark_started();
    }
    let method = request.method.clone();
    let target_id = request
        .target
        .as_ref()
        .and_then(|target| target.tab_id.clone());
    let browser = &state.browser;
    if request_requires_target_lease(&request) {
        browser
            .require_target(&client_id, required_target(target_id.as_deref())?)
            .await?;
    }
    let params = request.params;
    match method.as_str() {
        "client.release" => {
            state.resources.cleanup_client(&client_id).await;
            state.browser.cleanup_client(&client_id).await;
            Ok(json!({ "released": true }))
        }
        "tabs.list" => Ok(json!(browser.list_tabs(&client_id).await?)),
        "tabs.get" => Ok(json!(
            browser
                .get_tab(&client_id, required_target(target_id.as_deref())?)
                .await?
        )),
        "tabs.acquire" => Ok(json!(
            browser
                .acquire_tab(&client_id, required_target(target_id.as_deref())?)
                .await?
        )),
        "tabs.open" => {
            let url = required_string(&params, "url", "tabs.open")?;
            let wait_until = params
                .get("waitUntil")
                .and_then(Value::as_str)
                .unwrap_or("domcontentloaded");
            let timeout_ms = params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30_000);
            Ok(json!(
                browser
                    .open_tab(&client_id, url, wait_until, timeout_ms)
                    .await?
            ))
        }
        "tab.close" => {
            browser
                .close_tab(&client_id, required_target(target_id.as_deref())?)
                .await?;
            Ok(json!({ "closed": true }))
        }
        "tab.navigate" => {
            let url = required_string(&params, "url", "tab.navigate")?;
            let wait_until = params
                .get("waitUntil")
                .and_then(Value::as_str)
                .unwrap_or("domcontentloaded");
            browser
                .navigate(
                    required_target(target_id.as_deref())?,
                    url,
                    wait_until,
                    request_deadline,
                )
                .await
        }
        "tab.screenshot" => {
            let full_page = params
                .get("fullPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let scale = crate::browser::ScreenshotScale::parse(
                params
                    .get("scale")
                    .and_then(Value::as_str)
                    .unwrap_or("device"),
            )?;
            Ok(json!(
                browser
                    .screenshot(
                        &client_id,
                        required_target(target_id.as_deref())?,
                        full_page,
                        scale
                    )
                    .await?
            ))
        }
        "tab.observe" => {
            let ax = params
                .get("ax")
                .filter(|value| !value.is_null() && **value != Value::Bool(false))
                .map(|value| {
                    let value = if *value == Value::Bool(true) {
                        json!({})
                    } else {
                        value.clone()
                    };
                    serde_json::from_value(value).map_err(|error| {
                        AbError::new(
                            "invalid_argument",
                            "tab.observe.ax",
                            format!("invalid AX options: {error}"),
                        )
                    })
                })
                .transpose()?;
            let screenshot = params
                .get("screenshot")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let full_page = params
                .get("fullPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let scale = crate::browser::ScreenshotScale::parse(
                params
                    .get("scale")
                    .and_then(Value::as_str)
                    .unwrap_or("device"),
            )?;
            Ok(json!(
                browser
                    .observe(
                        &client_id,
                        required_target(target_id.as_deref())?,
                        ax,
                        screenshot,
                        full_page,
                        scale,
                    )
                    .await?
            ))
        }
        "tab.frames" => Ok(json!(
            browser
                .frames(required_target(target_id.as_deref())?)
                .await?
        )),
        "tab.realms" => Ok(json!(
            browser
                .realms(required_target(target_id.as_deref())?)
                .await?
        )),
        "observation.snapshot" => {
            let options = serde_json::from_value(params).map_err(|error| {
                AbError::new(
                    "invalid_argument",
                    "observation.options",
                    format!("invalid snapshot options: {error}"),
                )
            })?;
            Ok(json!(
                browser
                    .snapshot(&client_id, required_target(target_id.as_deref())?, options)
                    .await?
            ))
        }
        "observation.dispose" => {
            let observation_id = required_string(&params, "observationId", "observation.dispose")?;
            browser
                .dispose_observation(&client_id, observation_id)
                .await?;
            Ok(json!({ "disposed": true }))
        }
        "action.perform" => {
            browser
                .perform_ref_action(
                    &client_id,
                    required_target(target_id.as_deref())?,
                    &params,
                    request_deadline,
                    &dispatch_marker,
                )
                .await
        }
        "cua.perform" => {
            browser
                .cua(
                    &client_id,
                    required_target(target_id.as_deref())?,
                    &params,
                    request_deadline,
                    &dispatch_marker,
                )
                .await
        }
        "locator.execute" => {
            let locator = serde_json::from_value(params).map_err(|error| {
                AbError::new(
                    "invalid_argument",
                    "locator.request",
                    format!("invalid locator request: {error}"),
                )
            })?;
            browser
                .locator_execute(
                    &client_id,
                    required_target(target_id.as_deref())?,
                    locator,
                    request_deadline,
                    &dispatch_marker,
                )
                .await
        }
        "element.createFromLocator" => {
            let locator = serde_json::from_value(params).map_err(|error| {
                AbError::new(
                    "invalid_argument",
                    "element.create.locator",
                    format!("invalid locator request: {error}"),
                )
            })?;
            Ok(json!(
                browser
                    .create_element_from_locator(
                        &client_id,
                        required_target(target_id.as_deref())?,
                        locator,
                    )
                    .await?
            ))
        }
        "element.createFromRef" => {
            let observation_id = required_string(&params, "observationId", "element.create.ref")?;
            let ref_id = required_string(&params, "refId", "element.create.ref")?;
            Ok(json!(
                browser
                    .create_element_from_ref(
                        &client_id,
                        required_target(target_id.as_deref())?,
                        observation_id,
                        ref_id,
                    )
                    .await?
            ))
        }
        "element.perform" => {
            let element_id = request
                .target
                .as_ref()
                .and_then(|target| target.element_id.as_deref())
                .ok_or_else(|| {
                    AbError::new(
                        "protocol_error",
                        "element.perform.target",
                        "element.perform requires target.elementId",
                    )
                })?;
            let operation = required_string(&params, "operation", "element.perform")?;
            let arguments = params.get("arguments").unwrap_or(&Value::Null);
            browser
                .perform_element(
                    &client_id,
                    element_id,
                    operation,
                    arguments,
                    request_deadline,
                    &dispatch_marker,
                )
                .await
        }
        "element.dispose" => {
            let element_id = request
                .target
                .as_ref()
                .and_then(|target| target.element_id.as_deref())
                .ok_or_else(|| {
                    AbError::new(
                        "protocol_error",
                        "element.dispose.target",
                        "element.dispose requires target.elementId",
                    )
                })?;
            browser.dispose_element(&client_id, element_id).await?;
            Ok(json!({ "disposed": true }))
        }
        "artifact.dispose" => {
            let artifact_id = request
                .target
                .as_ref()
                .and_then(|target| target.artifact_id.as_deref())
                .ok_or_else(|| {
                    AbError::new(
                        "protocol_error",
                        "artifact.dispose.target",
                        "artifact.dispose requires target.artifactId",
                    )
                })?;
            browser.dispose_artifact(&client_id, artifact_id)?;
            Ok(json!({ "disposed": true }))
        }
        "tab.evaluate" => {
            let expression = required_string(&params, "expression", "tab.evaluate")?;
            let frame_id = params.get("frameId").and_then(Value::as_str);
            let context_id = params.get("contextId").and_then(Value::as_i64);
            let realm_id = params.get("realmId").and_then(Value::as_str);
            let session_id = params.get("sessionId").and_then(Value::as_str);
            browser
                .evaluate(
                    required_target(target_id.as_deref())?,
                    expression,
                    frame_id,
                    context_id,
                    realm_id,
                    session_id,
                )
                .await
        }
        "tab.activate" => {
            browser
                .activate(required_target(target_id.as_deref())?)
                .await
        }
        "tab.reload" => browser.reload(required_target(target_id.as_deref())?).await,
        "tab.goBack" => {
            browser
                .history(required_target(target_id.as_deref())?, -1)
                .await
        }
        "tab.goForward" => {
            browser
                .history(required_target(target_id.as_deref())?, 1)
                .await
        }
        "tab.waitFor" => {
            browser
                .wait_for(
                    &client_id,
                    required_target(target_id.as_deref())?,
                    &params,
                    request_deadline,
                )
                .await
        }
        "tab.waitForURL" => {
            let pattern = required_string(&params, "url", "tab.waitForURL")?;
            browser
                .wait_for_url(
                    required_target(target_id.as_deref())?,
                    pattern,
                    request_deadline,
                )
                .await
        }
        "tab.waitForLoadState" => {
            let load_state = params
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("load");
            browser
                .wait_for_load_state(
                    required_target(target_id.as_deref())?,
                    load_state,
                    request_deadline,
                )
                .await
        }
        "resource.open" => {
            let kind = required_string(&params, "kind", "resource.open")?;
            let resource_params = params.get("options").cloned().unwrap_or_else(|| json!({}));
            Ok(json!(
                state
                    .resources
                    .open(
                        &client_id,
                        Some(required_target(target_id.as_deref())?),
                        kind,
                        &resource_params,
                        outbound,
                    )
                    .await?
            ))
        }
        "resource.command" => {
            let resource_id = request
                .target
                .as_ref()
                .and_then(|target| target.resource_id.as_deref())
                .ok_or_else(|| {
                    AbError::new(
                        "protocol_error",
                        "resource.command.target",
                        "resource.command requires target.resourceId",
                    )
                })?;
            let command = required_string(&params, "command", "resource.command")?;
            let command_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
            state
                .resources
                .command(&client_id, resource_id, command, command_params)
                .await
        }
        "resource.dispose" => {
            let resource_id = request
                .target
                .as_ref()
                .and_then(|target| target.resource_id.as_deref())
                .ok_or_else(|| {
                    AbError::new(
                        "protocol_error",
                        "resource.dispose.target",
                        "resource.dispose requires target.resourceId",
                    )
                })?;
            state.resources.dispose(&client_id, resource_id).await?;
            Ok(json!({ "disposed": true }))
        }
        _ => Err(AbError::new(
            "method_not_found",
            "request.dispatch",
            format!("AB method {method} does not exist"),
        )),
    }
}

pub async fn reject_starting_clients(listener: &UnixListener, error: &AbError) {
    let mut accepted = false;
    loop {
        let wait = if accepted {
            Duration::from_millis(250)
        } else {
            Duration::from_secs(3)
        };
        let Ok(accepted_stream) = timeout(wait, listener.accept()).await else {
            return;
        };
        let Ok((mut stream, _)) = accepted_stream else {
            return;
        };
        if validate_peer_uid(&stream).is_err() {
            continue;
        }
        accepted = true;
        if timeout(Duration::from_millis(250), read_frame(&mut stream))
            .await
            .is_err()
        {
            continue;
        }
        let message = DaemonMessage::ClientRejected {
            error: error_data(error),
        };
        if let Ok(value) = serde_json::to_value(message) {
            let _ = write_frame(&mut stream, &value).await;
        }
    }
}

#[cfg(target_os = "macos")]
fn validate_peer_uid(stream: &UnixStream) -> AbResult<()> {
    let mut peer_uid: libc::uid_t = 0;
    let mut peer_gid: libc::gid_t = 0;
    let result = unsafe {
        libc::getpeereid(
            stream.as_raw_fd(),
            &mut peer_uid as *mut libc::uid_t,
            &mut peer_gid as *mut libc::gid_t,
        )
    };
    if result != 0 {
        return Err(AbError::new(
            "peer_identity_failed",
            "rpc.peer_identity",
            format!(
                "failed to inspect Unix socket peer: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let daemon_uid = unsafe { libc::geteuid() };
    if peer_uid != daemon_uid {
        return Err(AbError::new(
            "peer_identity_mismatch",
            "rpc.peer_identity",
            format!("SDK uid {peer_uid} does not match daemon uid {daemon_uid}"),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn validate_peer_uid(_stream: &UnixStream) -> AbResult<()> {
    Ok(())
}

fn emit_response(outbound: &Outbound, id: String, outcome: AbResult<Value>) {
    let response = match outcome {
        Ok(result) => Response {
            id,
            outcome: ResponseOutcome::Success { result },
        },
        Err(error) => Response {
            id,
            outcome: ResponseOutcome::Error {
                error: Box::new(error_data(&error)),
            },
        },
    };
    emit(outbound, DaemonMessage::Response(response));
}

fn emit_stage(outbound: &Outbound, stage: Stage) {
    emit(outbound, DaemonMessage::Stage(stage));
}

fn emit_daemon_error(outbound: &Outbound, event: &str, error: AbError) {
    emit(
        outbound,
        DaemonMessage::DaemonEvent(ab_protocol::DaemonEvent {
            event: event.to_owned(),
            value: serde_json::to_value(error_data(&error)).unwrap_or(Value::Null),
        }),
    );
}

fn emit(outbound: &Outbound, message: DaemonMessage) {
    if let Ok(value) = serde_json::to_value(message) {
        let _ = outbound.send(value);
    }
}

fn may_have_side_effect(request: &Request) -> bool {
    match request.method.as_str() {
        "tabs.list"
        | "tabs.get"
        | "tab.frames"
        | "tab.realms"
        | "tab.screenshot"
        | "tab.observe"
        | "tab.waitFor"
        | "tab.waitForURL"
        | "tab.waitForLoadState"
        | "observation.snapshot" => false,
        "action.perform" => request
            .params
            .get("action")
            .and_then(Value::as_str)
            .is_none_or(action_operation_has_side_effect),
        "locator.execute" | "element.perform" => request
            .params
            .get("operation")
            .and_then(Value::as_str)
            .is_none_or(action_operation_has_side_effect),
        _ => true,
    }
}

fn request_requires_target_lease(request: &Request) -> bool {
    match request.method.as_str() {
        "tab.close" | "tab.navigate" | "tab.evaluate" | "tab.activate" | "tab.reload"
        | "tab.goBack" | "tab.goForward" | "cua.perform" => true,
        "action.perform" => request
            .params
            .get("action")
            .and_then(Value::as_str)
            .is_none_or(action_operation_has_side_effect),
        "locator.execute" => request
            .params
            .get("operation")
            .and_then(Value::as_str)
            .is_none_or(action_operation_has_side_effect),
        "resource.open" => matches!(
            request.params.get("kind").and_then(Value::as_str),
            Some("cdp" | "dialog" | "fileChooser" | "initScript")
        ),
        _ => false,
    }
}

fn action_operation_has_side_effect(operation: &str) -> bool {
    !matches!(
        operation,
        "count"
            | "waitFor"
            | "text"
            | "innertext"
            | "getattribute"
            | "boundingbox"
            | "screenshot"
            | "isvisible"
            | "isenabled"
            | "ischecked"
            | "inputvalue"
            | "inspect"
    )
}

fn deadline_instant(deadline_unix_ms: u64) -> Instant {
    let remaining = deadline_unix_ms.saturating_sub(now_unix_ms());
    Instant::now() + Duration::from_millis(remaining)
}

fn required_target(target_id: Option<&str>) -> AbResult<&str> {
    target_id.ok_or_else(|| {
        AbError::new(
            "protocol_error",
            "request.target",
            "request requires target.tabId",
        )
    })
}

fn required_string<'a>(value: &'a Value, field: &str, stage: &str) -> AbResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        AbError::new(
            "protocol_error",
            stage,
            format!("params.{field} must be a string"),
        )
    })
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn error_data(error: &AbError) -> ErrorData {
    ErrorData {
        kind: error.kind.clone(),
        stage: error.stage.clone(),
        message: error.message.clone(),
        retryable: error.retryable,
        context: error.context.as_deref().cloned(),
        details: error.details.as_deref().cloned(),
    }
}

fn serialization_error(error: serde_json::Error) -> AbError {
    AbError::new("serialization_failed", "rpc.serialize", error.to_string())
        .with_cause(error.to_string())
}

async fn read_frame<R: AsyncRead + Unpin>(stream: &mut R) -> AbResult<Value> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).await.map_err(|error| {
        if matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::BrokenPipe
        ) {
            AbError::new("client_disconnected", "rpc.read", "client socket closed")
        } else {
            AbError::new(
                "transport_error",
                "rpc.read.length",
                format!("failed to read frame length: {error}"),
            )
        }
    })?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(AbError::new(
            "protocol_error",
            "rpc.read.length",
            format!("invalid frame length {length}"),
        ));
    }
    let mut bytes = vec![0_u8; length];
    stream.read_exact(&mut bytes).await.map_err(|error| {
        AbError::new(
            "transport_error",
            "rpc.read.body",
            format!("failed to read frame body: {error}"),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        AbError::new(
            "protocol_error",
            "rpc.read.json",
            format!("invalid JSON frame: {error}"),
        )
    })
}

async fn write_frame<W: AsyncWrite + Unpin>(stream: &mut W, value: &Value) -> AbResult<()> {
    let bytes = serde_json::to_vec(value).map_err(serialization_error)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AbError::new(
            "result_too_large",
            "rpc.write.length",
            format!("frame is {} bytes", bytes.len()),
        ));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|error| {
            AbError::new(
                "transport_error",
                "rpc.write.length",
                format!("failed to write frame length: {error}"),
            )
        })?;
    stream.write_all(&bytes).await.map_err(|error| {
        AbError::new(
            "transport_error",
            "rpc.write.body",
            format!("failed to write frame body: {error}"),
        )
    })
}
