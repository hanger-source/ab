use crate::agent_browser_engine::element::RefMap;
use crate::agent_browser_engine::{element, interaction};
use crate::browser::{target_lane::TargetState, TargetContext};
use crate::error::{AbError, AbResult};
use crate::selector::ElementTarget;
use ab_protocol::{ElementInspection, ElementInspectionRequest};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

mod model;

pub use model::{
    dispatch_mechanism, ActionCoordinateIdentity, ActionObservationOutcome, ActionResult,
    ActionTargetIdentity, ActionTiming, DialogOutcome, DocumentChange, FileChooserOutcome,
    NavigationChange,
};

#[derive(Clone, Default)]
pub struct ActionDispatchMarker(Arc<AtomicBool>);

impl ActionDispatchMarker {
    pub fn mark_started(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn started(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct ActionRunner;

impl ActionRunner {
    pub async fn perform(
        context: &TargetContext,
        state: &mut TargetState,
        target: &ElementTarget,
        operation: &str,
        arguments: &Value,
    ) -> AbResult<Value> {
        Self::perform_inner(context, state, target, operation, arguments, None).await
    }

    pub async fn perform_transaction(
        context: &TargetContext,
        state: &mut TargetState,
        target: &ElementTarget,
        operation: &str,
        arguments: &Value,
        before_dispatch: &(dyn Fn() + Send + Sync),
    ) -> AbResult<Value> {
        Self::perform_inner(
            context,
            state,
            target,
            operation,
            arguments,
            Some(before_dispatch),
        )
        .await
    }

    async fn perform_inner(
        context: &TargetContext,
        state: &mut TargetState,
        target: &ElementTarget,
        operation: &str,
        arguments: &Value,
        before_dispatch: Option<&(dyn Fn() + Send + Sync)>,
    ) -> AbResult<Value> {
        Self::assert_live(context, target).await?;
        let mut action_sessions = context.iframe_sessions.clone();
        action_sessions.insert(target.frame_id.clone(), target.session_id.clone());
        let ref_id = "e1";
        let mut refs = RefMap::new();
        refs.add_exact_with_frame(
            ref_id.to_owned(),
            target.backend_node_id,
            &target.role,
            &target.name,
            Some(&target.frame_id),
        );
        let selector = format!("@{ref_id}");
        if !matches!(operation, "click" | "dblclick") {
            if let Some(before_dispatch) = before_dispatch {
                before_dispatch();
            }
        }
        let result = match operation {
            "click" => {
                let mark_dispatch = || {
                    if let Some(before_dispatch) = before_dispatch {
                        before_dispatch();
                    }
                };
                let click = interaction::click_with_dispatch_hook(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    arguments
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                    arguments
                        .get("clickCount")
                        .and_then(Value::as_i64)
                        .unwrap_or(1) as i32,
                    &action_sessions,
                    Some(&mark_dispatch),
                )
                .await
                .map_err(|message| action_error("click", message))?;
                let dialog_session_id = click
                    .dialog_event
                    .as_ref()
                    .and_then(|event| event.session_id.clone());
                state.pending_release = click.pending_release;
                json!({
                    "dialogOpened": click.dialog_opened,
                    "dialogSessionId": dialog_session_id
                })
            }
            "dblclick" => {
                let mark_dispatch = || {
                    if let Some(before_dispatch) = before_dispatch {
                        before_dispatch();
                    }
                };
                let click = interaction::click_with_dispatch_hook(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    "left",
                    2,
                    &action_sessions,
                    Some(&mark_dispatch),
                )
                .await
                .map_err(|message| action_error("dblclick", message))?;
                let dialog_session_id = click
                    .dialog_event
                    .as_ref()
                    .and_then(|event| event.session_id.clone());
                state.pending_release = click.pending_release;
                json!({
                    "dialogOpened": click.dialog_opened,
                    "dialogSessionId": dialog_session_id
                })
            }
            "hover" => {
                interaction::hover(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("hover", message))?;
                json!({})
            }
            "wheel" => {
                let (x, y, session_id) = element::resolve_element_center(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("wheel.target", message))?;
                context
                    .client
                    .send_command(
                        "Input.dispatchMouseEvent",
                        Some(json!({
                            "type": "mouseWheel",
                            "x": x,
                            "y": y,
                            "deltaX": arguments.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0),
                            "deltaY": arguments.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0)
                        })),
                        Some(&session_id),
                    )
                    .await
                    .map_err(|message| action_error("wheel.dispatch", message))?;
                json!({ "x": x, "y": y })
            }
            "fill" => {
                let requested = required_string(arguments, "value", "fill")?;
                interaction::fill(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    requested,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("fill", message))?;
                text_input_outcome(context, target, requested, true).await?
            }
            "type" => {
                let requested = required_string(arguments, "text", "type")?;
                interaction::type_text(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    requested,
                    arguments
                        .get("clear")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    arguments
                        .get("delay")
                        .or_else(|| arguments.get("delayMs"))
                        .and_then(Value::as_u64),
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("type", message))?;
                let replaces_value = arguments
                    .get("clear")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                text_input_outcome(context, target, requested, replaces_value).await?
            }
            "press" => {
                interaction::focus(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("press.focus", message))?;
                interaction::press_key(
                    &context.client,
                    &target.session_id,
                    required_string(arguments, "key", "press")?,
                )
                .await
                .map_err(|message| action_error("press", message))?;
                json!({})
            }
            "focus" => {
                interaction::focus(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("focus", message))?;
                json!({})
            }
            "clear" => {
                interaction::clear(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("clear", message))?;
                json!({})
            }
            "scrollintoview" | "scrollIntoView" => {
                interaction::scroll_into_view(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("scroll_into_view", message))?;
                json!({})
            }
            "select" => {
                let values = string_array(arguments, "values", "select")?;
                interaction::select_option(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &values,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("select", message))?;
                json!({ "values": values })
            }
            "check" => {
                interaction::check_without_dom_fallback(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("check", message))?;
                json!({})
            }
            "uncheck" => {
                interaction::uncheck_without_dom_fallback(
                    &context.client,
                    &context.root_session_id,
                    &refs,
                    &selector,
                    &action_sessions,
                )
                .await
                .map_err(|message| action_error("uncheck", message))?;
                json!({})
            }
            "upload" => {
                let files = string_array(arguments, "files", "upload")?;
                context
                    .client
                    .send_command(
                        "DOM.setFileInputFiles",
                        Some(json!({ "backendNodeId": target.backend_node_id, "files": files })),
                        Some(&target.session_id),
                    )
                    .await
                    .map_err(|message| action_error("upload", message))?;
                json!({ "files": files })
            }
            "dominvoke" => {
                let method = required_string(arguments, "method", "dominvoke")?;
                let args = arguments
                    .get("args")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let (object_id, release_after) = resolve_object(context, target).await?;
                let invoked = context
                    .client
                    .send_command(
                        "Runtime.callFunctionOn",
                        Some(json!({
                            "objectId": object_id,
                            "functionDeclaration": "function(method, args) { const fn = this[method]; if (typeof fn !== 'function') throw new TypeError(method + ' is not a function'); return fn.apply(this, args); }",
                            "arguments": [{ "value": method }, { "value": args }],
                            "returnByValue": true,
                            "awaitPromise": true
                        })),
                        Some(&target.session_id),
                    )
                    .await
                    .map_err(|message| action_error("dominvoke", message));
                if release_after {
                    release_object(context, target, &object_id).await;
                }
                let invoked = invoked?;
                if let Some(exception) = invoked.get("exceptionDetails") {
                    return Err(action_error("dominvoke", exception.to_string()));
                }
                json!({ "value": invoked.pointer("/result/value").cloned().unwrap_or(Value::Null) })
            }
            "text" => json!({ "text": element::get_element_text_content(
                &context.client, &context.root_session_id, &refs, &selector, &action_sessions
            ).await.map_err(|message| action_error("text", message))? }),
            "innertext" => json!({ "text": element::get_element_inner_text(
                &context.client, &context.root_session_id, &refs, &selector, &action_sessions
            ).await.map_err(|message| action_error("innertext", message))? }),
            "getattribute" => json!({ "value": element::get_element_attribute(
                &context.client,
                &context.root_session_id,
                &refs,
                &selector,
                required_string(arguments, "attribute", "getattribute")?,
                &action_sessions,
            ).await.map_err(|message| action_error("getattribute", message))? }),
            "boundingbox" => element::get_element_bounding_box(
                &context.client,
                &context.root_session_id,
                &refs,
                &selector,
                &action_sessions,
            )
            .await
            .map_err(|message| action_error("boundingbox", message))?,
            "isvisible" => json!({
                "value": read_node_value(
                    context,
                    target,
                    "function() { const style = getComputedStyle(this); const rect = this.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0; }",
                )
                .await?
                .as_bool()
                .unwrap_or(false)
            }),
            "isenabled" => json!({
                "value": read_node_value(
                    context,
                    target,
                    "function() { return !Boolean(this.disabled) && this.getAttribute('aria-disabled') !== 'true'; }",
                )
                .await?
                .as_bool()
                .unwrap_or(false)
            }),
            "ischecked" => json!({
                "value": read_node_value(
                    context,
                    target,
                    "function() { return 'checked' in this ? Boolean(this.checked) : this.getAttribute('aria-checked') === 'true'; }",
                )
                .await?
                .as_bool()
                .unwrap_or(false)
            }),
            "inputvalue" => json!({
                "value": read_node_value(
                    context,
                    target,
                    "function() { return this.value == null ? '' : String(this.value); }",
                )
                .await?
                .as_str()
                .unwrap_or_default()
            }),
            "inspect" => serde_json::to_value(inspect_node(context, target, arguments).await?)
                .map_err(|error| action_error("inspect.serialize", error.to_string()))?,
            other => {
                return Err(AbError::new(
                    "action_not_supported",
                    "action.dispatch",
                    format!("element operation {other} is not supported"),
                ))
            }
        };
        Ok(result)
    }

    pub async fn assert_live(context: &TargetContext, target: &ElementTarget) -> AbResult<()> {
        assert_fresh(context, target).await?;
        assert_attached(context, target).await
    }

    pub async fn drag(
        context: &TargetContext,
        source: &ElementTarget,
        target: &ElementTarget,
    ) -> AbResult<Value> {
        Self::assert_live(context, source).await?;
        Self::assert_live(context, target).await?;
        if source.target_id != target.target_id {
            return Err(AbError::new(
                "target_mismatch",
                "action.drag.target",
                "drag source and target must belong to the same tab",
            ));
        }
        let mut action_sessions = context.iframe_sessions.clone();
        action_sessions.insert(source.frame_id.clone(), source.session_id.clone());
        action_sessions.insert(target.frame_id.clone(), target.session_id.clone());
        let mut refs = RefMap::new();
        refs.add_exact_with_frame(
            "e1".to_owned(),
            source.backend_node_id,
            &source.role,
            &source.name,
            Some(&source.frame_id),
        );
        refs.add_exact_with_frame(
            "e2".to_owned(),
            target.backend_node_id,
            &target.role,
            &target.name,
            Some(&target.frame_id),
        );
        let (source_x, source_y, source_session) = element::resolve_element_center(
            &context.client,
            &context.root_session_id,
            &refs,
            "@e1",
            &action_sessions,
        )
        .await
        .map_err(|message| action_error("drag.source", message))?;
        let (target_x, target_y, target_session) = element::resolve_element_center(
            &context.client,
            &context.root_session_id,
            &refs,
            "@e2",
            &action_sessions,
        )
        .await
        .map_err(|message| action_error("drag.target", message))?;
        if source_session != target_session {
            return Err(AbError::new(
                "cross_session_drag_unsupported",
                "action.drag.session",
                "drag across different CDP target sessions is not supported",
            ));
        }
        Self::drag_coordinates(
            context,
            &source_session,
            source_x,
            source_y,
            target_x,
            target_y,
        )
        .await
    }

    pub async fn drag_coordinates(
        context: &TargetContext,
        session_id: &str,
        source_x: f64,
        source_y: f64,
        target_x: f64,
        target_y: f64,
    ) -> AbResult<Value> {
        context
            .client
            .send_command(
                "Input.dispatchMouseEvent",
                Some(json!({ "type": "mouseMoved", "x": source_x, "y": source_y })),
                Some(session_id),
            )
            .await
            .map_err(|message| action_error("drag.move_source", message))?;
        context.client.send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mousePressed", "x": source_x, "y": source_y, "button": "left", "buttons": 1, "clickCount": 1 })),
            Some(session_id),
        ).await.map_err(|message| action_error("drag.press", message))?;
        for step in 1..=10 {
            let fraction = step as f64 / 10.0;
            let x = source_x + (target_x - source_x) * fraction;
            let y = source_y + (target_y - source_y) * fraction;
            context.client.send_command(
                "Input.dispatchMouseEvent",
                Some(json!({ "type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1 })),
                Some(session_id),
            ).await.map_err(|message| action_error("drag.move", message))?;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        context.client.send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mouseReleased", "x": target_x, "y": target_y, "button": "left", "buttons": 0, "clickCount": 1 })),
            Some(session_id),
        ).await.map_err(|message| action_error("drag.release", message))?;
        Ok(json!({
            "source": { "x": source_x, "y": source_y },
            "target": { "x": target_x, "y": target_y }
        }))
    }
}

async fn resolve_object(
    context: &TargetContext,
    target: &ElementTarget,
) -> AbResult<(String, bool)> {
    if let Some(object_id) = &target.remote_object_id {
        return Ok((object_id.clone(), false));
    }
    let resolved = context
        .client
        .send_command(
            "DOM.resolveNode",
            Some(json!({ "backendNodeId": target.backend_node_id })),
            Some(&target.session_id),
        )
        .await
        .map_err(|message| action_error("object.resolve", message))?;
    let object_id = resolved
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| action_error("object.resolve", "node has no remote object".to_owned()))?;
    Ok((object_id.to_owned(), true))
}

async fn read_node_value(
    context: &TargetContext,
    target: &ElementTarget,
    function: &str,
) -> AbResult<Value> {
    call_node_function(context, target, function, Vec::new()).await
}

async fn call_node_function(
    context: &TargetContext,
    target: &ElementTarget,
    function: &str,
    arguments: Vec<Value>,
) -> AbResult<Value> {
    let (object_id, release_after) = resolve_object(context, target).await?;
    let result = context
        .client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": &object_id,
                "functionDeclaration": function,
                "arguments": arguments,
                "returnByValue": true,
                "awaitPromise": false,
            })),
            Some(&target.session_id),
        )
        .await
        .map_err(|message| action_error("read", message));
    if release_after {
        release_object(context, target, &object_id).await;
    }
    let result = result?;
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(action_error("read", exception.to_string()));
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

async fn inspect_node(
    context: &TargetContext,
    target: &ElementTarget,
    arguments: &Value,
) -> AbResult<ElementInspection> {
    let request: ElementInspectionRequest =
        serde_json::from_value(arguments.clone()).map_err(|error| {
            AbError::new(
                "invalid_argument",
                "action.inspect.arguments",
                format!("invalid element inspection request: {error}"),
            )
        })?;
    let value = call_node_function(
        context,
        target,
        r#"function(attributeNames) {
            const rect = this.getBoundingClientRect();
            const style = getComputedStyle(this);
            const ariaChecked = this.getAttribute('aria-checked');
            const attributes = Object.fromEntries(
                attributeNames.map((name) => [name, this.getAttribute(name)])
            );
            const hasValue = 'value' in this;
            const hasChecked = 'checked' in this;
            const tagName = String(this.tagName || '').toLowerCase();
            return {
                tagName,
                roleAttribute: this.getAttribute('role'),
                inputType: tagName === 'input' ? String(this.type || 'text') : null,
                attributes,
                textContent: this.textContent == null ? '' : String(this.textContent),
                innerText: typeof this.innerText === 'string' ? this.innerText : (this.textContent == null ? '' : String(this.textContent)),
                value: hasValue ? String(this.value == null ? '' : this.value) : null,
                visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0,
                enabled: !Boolean(this.disabled) && this.getAttribute('aria-disabled') !== 'true',
                checked: hasChecked ? Boolean(this.checked) : (ariaChecked === null ? null : ariaChecked === 'true'),
                readOnly: Boolean(this.readOnly) || this.getAttribute('aria-readonly') === 'true',
                contentEditable: Boolean(this.isContentEditable),
                bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
        }"#,
        vec![json!({ "value": request.attributes.unwrap_or_default() })],
    )
    .await?;
    serde_json::from_value(value).map_err(|error| {
        action_error(
            "inspect.decode",
            format!("browser returned an invalid element inspection: {error}"),
        )
    })
}

async fn text_input_outcome(
    context: &TargetContext,
    target: &ElementTarget,
    requested_text: &str,
    replaces_value: bool,
) -> AbResult<Value> {
    let request = json!({
        "attributes": [
            "role",
            "aria-autocomplete",
            "aria-controls",
            "aria-haspopup",
            "list",
            "class"
        ]
    });
    let initial = inspect_node(context, target, &request).await?;
    let mut signals = Vec::new();
    if target.role.eq_ignore_ascii_case("combobox")
        || initial.role_attribute.as_deref() == Some("combobox")
    {
        signals.push("role=combobox".to_owned());
    }
    if let Some(value) = nonempty_attribute(&initial, "aria-autocomplete") {
        if value != "none" {
            signals.push(format!("aria-autocomplete={value}"));
        }
    }
    if nonempty_attribute(&initial, "list").is_some() {
        signals.push("datalist".to_owned());
    }
    if initial
        .attributes
        .get("class")
        .and_then(|value| value.as_deref())
        .is_some_and(|value| {
            value
                .split_ascii_whitespace()
                .any(|name| name == "ui-autocomplete-input")
        })
    {
        signals.push("jquery-ui-autocomplete".to_owned());
    }
    if nonempty_attribute(&initial, "aria-controls").is_some()
        && initial
            .attributes
            .get("aria-haspopup")
            .and_then(|value| value.as_deref())
            .is_some_and(|value| value == "listbox" || value == "true")
    {
        signals.push("controlled-listbox".to_owned());
    }
    let popup_backed = !signals.is_empty();
    let settled = inspect_node(context, target, &request).await?;
    let input_value = settled.value;
    let matches_requested_text = if replaces_value {
        input_value.as_deref().map(|value| value == requested_text)
    } else {
        None
    };
    Ok(json!({
        "field": {
            "requestedText": requested_text,
            "inputValue": input_value,
            "matchesRequestedText": matches_requested_text,
            "popupBacked": popup_backed,
            "signals": signals,
            "next": if popup_backed { "selectSuggestion" } else { "none" }
        }
    }))
}

fn nonempty_attribute<'a>(inspection: &'a ElementInspection, name: &str) -> Option<&'a str> {
    inspection
        .attributes
        .get(name)
        .and_then(|value| value.as_deref())
        .filter(|value| !value.trim().is_empty())
}

async fn release_object(context: &TargetContext, target: &ElementTarget, object_id: &str) {
    let _ = context
        .client
        .send_command(
            "Runtime.releaseObject",
            Some(json!({ "objectId": object_id })),
            Some(&target.session_id),
        )
        .await;
}

async fn assert_fresh(context: &TargetContext, target: &ElementTarget) -> AbResult<()> {
    let frame = context
        .sessions
        .frames(&context.target_id)
        .await
        .into_iter()
        .find(|frame| frame.id == target.frame_id)
        .ok_or_else(|| {
            AbError::new(
                "stale_ref",
                "action.frame",
                "element frame no longer exists",
            )
        })?;
    if frame.document_generation != target.document_generation {
        return Err(AbError::new(
            "stale_document",
            "action.document_generation",
            format!(
                "element belongs to document {}, current document is {}",
                target.document_generation, frame.document_generation
            ),
        ));
    }
    Ok(())
}

async fn assert_attached(context: &TargetContext, target: &ElementTarget) -> AbResult<()> {
    let (object_id, release_after_check) = if let Some(object_id) = &target.remote_object_id {
        (object_id.clone(), false)
    } else {
        let resolved = context
            .client
            .send_command(
                "DOM.resolveNode",
                Some(json!({
                    "backendNodeId": target.backend_node_id,
                    "objectGroup": "ab-actionability"
                })),
                Some(&target.session_id),
            )
            .await
            .map_err(|_| {
                AbError::new(
                    "stale_ref",
                    "action.attached.resolve",
                    "element backend node no longer resolves",
                )
            })?;
        let object_id = resolved
            .pointer("/object/objectId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AbError::new(
                    "stale_ref",
                    "action.attached.object",
                    "element backend node has no live object",
                )
            })?
            .to_owned();
        (object_id, true)
    };
    let attached = context
        .client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": object_id,
                "functionDeclaration": "function() { return this.isConnected === true; }",
                "returnByValue": true
            })),
            Some(&target.session_id),
        )
        .await
        .ok()
        .and_then(|value| value.pointer("/result/value").and_then(Value::as_bool))
        .unwrap_or(false);
    if release_after_check {
        let _ = context
            .client
            .send_command(
                "Runtime.releaseObject",
                Some(json!({ "objectId": object_id })),
                Some(&target.session_id),
            )
            .await;
    }
    if !attached {
        return Err(AbError::new(
            "stale_ref",
            "action.attached",
            "element is detached from its document",
        ));
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, field: &str, action: &str) -> AbResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        AbError::new(
            "invalid_argument",
            format!("action.{action}.{field}"),
            format!("{action} requires string argument {field}"),
        )
    })
}

fn string_array(value: &Value, field: &str, action: &str) -> AbResult<Vec<String>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AbError::new(
                "invalid_argument",
                format!("action.{action}.{field}"),
                format!("{action} requires string array argument {field}"),
            )
        })?
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                AbError::new(
                    "invalid_argument",
                    format!("action.{action}.{field}"),
                    format!("{field} must contain only strings"),
                )
            })
        })
        .collect()
}

fn action_error(stage: &str, message: String) -> AbError {
    let kind = if message.contains("covered by") || message.contains("intercepted by") {
        "action_intercepted"
    } else if message.contains("not editable") || message.contains("cannot be filled") {
        "element_not_editable"
    } else if message.contains("Stale ref")
        || message.contains("stale")
        || message.contains("detached from")
    {
        "stale_ref"
    } else if message.contains("not found") {
        "action_target_unavailable"
    } else {
        "action_failed"
    };
    AbError::new(kind, format!("action.{stage}"), message)
}
