//! Browser-side pointer action transaction.
//!
//! This module owns actionability, stability, scrolling, protocol content
//! quads, strict hit testing, event-time interception, and safe retry. It does
//! not fall back to DOM `click()`.
//!
//! Design and evidence:
//! `docs/evidence/20260902__pointer-action-transaction-and-spa-navigation__@codex.md`.
//! Deterministic regressions:
//! `test/ab/scenarios/pointer-hit-target-layout-shift/README.md` and
//! `test/ab/scenarios/async-spa-navigation/README.md`.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::sleep;

use super::cdp::client::CdpClient;
use super::element::{resolve_element_object_id, RefMap};

const RETRY_DELAYS_MS: [u64; 5] = [0, 20, 100, 100, 500];
const SCROLL_ALIGNMENTS: [&str; 4] = ["protocol", "end", "center", "start"];
const STABILITY_SAMPLE_INTERVAL_MS: u64 = 16;
const STABILITY_TOLERANCE_CSS_PX: f64 = 0.25;

#[derive(Debug, Clone)]
pub struct PreparedPointerAction {
    pub x: f64,
    pub y: f64,
    pub session_id: String,
    pub(crate) object_id: String,
}

pub async fn register_for_session(client: &CdpClient, session_id: &str) -> Result<(), String> {
    client
        .send_command(
            "Page.addScriptToEvaluateOnNewDocument",
            Some(json!({ "source": POINTER_ACTION_GATE_SCRIPT })),
            Some(session_id),
        )
        .await?;
    Ok(())
}

pub async fn evaluate_current_for_session(
    client: &CdpClient,
    session_id: &str,
) -> Result<(), String> {
    client
        .send_command(
            "Runtime.evaluate",
            Some(json!({
                "expression": POINTER_ACTION_GATE_SCRIPT,
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(session_id),
        )
        .await?;
    Ok(())
}

pub async fn prepare(
    client: &CdpClient,
    root_session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    iframe_sessions: &HashMap<String, String>,
    attempt: usize,
) -> Result<PreparedPointerAction, String> {
    let delay = RETRY_DELAYS_MS[attempt.min(RETRY_DELAYS_MS.len() - 1)];
    if delay != 0 {
        sleep(Duration::from_millis(delay)).await;
    }

    let (object_id, session_id) = resolve_element_object_id(
        client,
        root_session_id,
        ref_map,
        selector_or_ref,
        iframe_sessions,
    )
    .await?;
    let alignment = SCROLL_ALIGNMENTS[attempt % SCROLL_ALIGNMENTS.len()];
    prepare_actionability(client, &session_id, &object_id, alignment).await?;
    let (x, y) = stable_clickable_point(client, &session_id, &object_id).await?;
    arm_hit_target_gate(client, &session_id, &object_id, x, y).await?;

    Ok(PreparedPointerAction {
        x,
        y,
        session_id,
        object_id,
    })
}

pub async fn stop(client: &CdpClient, prepared: &PreparedPointerAction) -> Result<(), String> {
    let stopped = client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": prepared.object_id,
                "functionDeclaration": r#"function() {
                    const gate = globalThis.__abPointerActionGateV1;
                    return gate ? gate.stop() : { status: 'done' };
                }"#,
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(&prepared.session_id),
        )
        .await;

    // A successful click may destroy the old execution context through
    // navigation. There is then no old document left to unblock. Other CDP
    // failures must remain visible instead of silently manufacturing success.
    let stopped = match stopped {
        Ok(stopped) => stopped,
        Err(error) if is_navigation_context_loss(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    let value = stopped.pointer("/result/value").unwrap_or(&Value::Null);
    if value.get("status").and_then(Value::as_str) == Some("intercepted") {
        let blocker = value
            .get("blocker")
            .and_then(Value::as_str)
            .unwrap_or("another element");
        return Err(format!("pointer action intercepted by {blocker}"));
    }
    Ok(())
}

fn is_navigation_context_loss(error: &str) -> bool {
    [
        "Execution context was destroyed",
        "Cannot find context with specified id",
        "Cannot find object with given id",
        "Inspected target navigated or closed",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

async fn prepare_actionability(
    client: &CdpClient,
    session_id: &str,
    object_id: &str,
    alignment: &str,
) -> Result<(), String> {
    let result = client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": object_id,
                "functionDeclaration": ACTIONABILITY_FUNCTION,
                "arguments": [{ "value": alignment }],
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(session_id),
        )
        .await?;
    let value = result.pointer("/result/value").unwrap_or(&Value::Null);
    match value.get("status").and_then(Value::as_str) {
        Some("done") => Ok(()),
        Some("detached") => Err("element is detached from the document".to_string()),
        Some("disabled") => Err("element is disabled".to_string()),
        _ => Err("element is not visible".to_string()),
    }
}

#[derive(Debug, Clone, Copy)]
struct ClickableGeometry {
    points: [(f64, f64); 4],
    center: (f64, f64),
}

async fn stable_clickable_point(
    client: &CdpClient,
    session_id: &str,
    object_id: &str,
) -> Result<(f64, f64), String> {
    let first = clickable_geometry(client, session_id, object_id).await?;
    sleep(Duration::from_millis(STABILITY_SAMPLE_INTERVAL_MS)).await;
    let second = clickable_geometry(client, session_id, object_id).await?;
    let moved = first.points.iter().zip(second.points.iter()).any(
        |((first_x, first_y), (second_x, second_y))| {
            (first_x - second_x).abs() > STABILITY_TOLERANCE_CSS_PX
                || (first_y - second_y).abs() > STABILITY_TOLERANCE_CSS_PX
        },
    );
    if moved {
        return Err("element is not stable".to_string());
    }
    Ok(second.center)
}

async fn clickable_geometry(
    client: &CdpClient,
    session_id: &str,
    object_id: &str,
) -> Result<ClickableGeometry, String> {
    let quads = client
        .send_command(
            "DOM.getContentQuads",
            Some(json!({ "objectId": object_id })),
            Some(session_id),
        )
        .await?;
    let viewport = client
        .send_command("Page.getLayoutMetrics", Some(json!({})), Some(session_id))
        .await?;
    let width = viewport
        .pointer("/cssLayoutViewport/clientWidth")
        .or_else(|| viewport.pointer("/layoutViewport/clientWidth"))
        .and_then(Value::as_f64)
        .ok_or_else(|| "browser did not report the layout viewport width".to_string())?;
    let height = viewport
        .pointer("/cssLayoutViewport/clientHeight")
        .or_else(|| viewport.pointer("/layoutViewport/clientHeight"))
        .and_then(Value::as_f64)
        .ok_or_else(|| "browser did not report the layout viewport height".to_string())?;
    let raw_quads = quads
        .get("quads")
        .and_then(Value::as_array)
        .ok_or_else(|| "element has no content quads".to_string())?;

    for raw_quad in raw_quads {
        let Some(values) = raw_quad.as_array() else {
            continue;
        };
        if values.len() < 8 {
            continue;
        }
        let mut points = [(0.0, 0.0); 4];
        let mut valid = true;
        for index in 0..4 {
            let Some(x) = values[index * 2].as_f64() else {
                valid = false;
                break;
            };
            let Some(y) = values[index * 2 + 1].as_f64() else {
                valid = false;
                break;
            };
            points[index] = (x.clamp(0.0, width), y.clamp(0.0, height));
        }
        if !valid || quad_area(&points) <= 0.99 {
            continue;
        }
        let x = points.iter().map(|point| point.0).sum::<f64>() / 4.0;
        let y = points.iter().map(|point| point.1).sum::<f64>() / 4.0;
        return Ok(ClickableGeometry {
            points,
            center: (x.round(), y.round()),
        });
    }
    Err("element is outside of the viewport or has no clickable area".to_string())
}

fn quad_area(points: &[(f64, f64); 4]) -> f64 {
    let mut area = 0.0;
    for index in 0..points.len() {
        let left = points[index];
        let right = points[(index + 1) % points.len()];
        area += (left.0 * right.1 - right.0 * left.1) / 2.0;
    }
    area.abs()
}

async fn arm_hit_target_gate(
    client: &CdpClient,
    session_id: &str,
    object_id: &str,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let armed = client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": object_id,
                "functionDeclaration": r#"function(x, y) {
                    const gate = globalThis.__abPointerActionGateV1;
                    if (!gate) return { status: 'missing' };
                    return gate.arm(this, x, y);
                }"#,
                "arguments": [{ "value": x }, { "value": y }],
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(session_id),
        )
        .await?;
    let value = armed.pointer("/result/value").unwrap_or(&Value::Null);
    match value.get("status").and_then(Value::as_str) {
        Some("armed") => Ok(()),
        Some("intercepted") => Err(format!(
            "pointer action intercepted by {}",
            value
                .get("blocker")
                .and_then(Value::as_str)
                .unwrap_or("another element")
        )),
        Some("detached") => Err("element is detached from the document".to_string()),
        _ => Err("pointer action gate is unavailable in the target document".to_string()),
    }
}

const ACTIONABILITY_FUNCTION: &str = r#"function(alignment) {
    if (!(this instanceof Element) || !this.isConnected) return { status: 'detached' };
    const style = getComputedStyle(this);
    const visible = style.visibility !== 'hidden' && style.display !== 'none' &&
        [...this.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    if (!visible) return { status: 'hidden' };
    for (let node = this; node; node = node.parentElement) {
        if (node.disabled === true || node.getAttribute?.('aria-disabled') === 'true')
            return { status: 'disabled' };
    }
    if (alignment === 'protocol') {
        this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    } else {
        this.scrollIntoView({ block: alignment, inline: alignment, behavior: 'instant' });
    }
    return { status: 'done' };
}"#;

const POINTER_ACTION_GATE_SCRIPT: &str = r#"(() => {
    if (globalThis.__abPointerActionGateV1) return;
    const state = { current: null };
    const parent = node => node && (node.assignedSlot || node.parentElement ||
        (node.getRootNode && node.getRootNode().host) || null);
    const preview = node => {
        if (!node) return '<html>';
        let text = String(node.tagName || 'element').toLowerCase();
        if (node.id) text += '#' + node.id;
        else if (typeof node.className === 'string' && node.className.trim())
            text += '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.');
        return '<' + text + '>';
    };
    const labelActivates = (hit, target) => {
        const hitLabel = hit && hit.closest ? hit.closest('label') : null;
        if (hitLabel && (hitLabel.control === target || hitLabel.contains(target))) return true;
        const targetLabel = target && target.closest ? target.closest('label') : null;
        return Boolean(targetLabel && targetLabel.contains(hit));
    };
    const expect = (target, x, y) => {
        const roots = [];
        let component = target;
        while (component) {
            const root = component.getRootNode ? component.getRootNode() : null;
            if (!root) break;
            roots.push(root);
            if (root.nodeType === Node.DOCUMENT_NODE) break;
            component = root.host;
        }
        let hit;
        for (let index = roots.length - 1; index >= 0; index--) {
            const root = roots[index];
            const elements = root.elementsFromPoint ? root.elementsFromPoint(x, y) : [];
            const inner = elements[0] || (root.elementFromPoint && root.elementFromPoint(x, y));
            if (!inner) break;
            hit = inner;
            if (index && inner !== roots[index - 1].host) break;
        }
        for (let node = hit; node; node = parent(node)) {
            if (node === target) return { status: 'done' };
        }
        if (labelActivates(hit, target)) return { status: 'done' };
        return { status: 'intercepted', blocker: preview(hit) };
    };
    // This gate currently owns semantic mouse clicks. The preceding move is
    // hover preparation, not proof that the later button events still target
    // the element: page hover handlers may move or replace it before down.
    // Keep this event set aligned with Playwright's mouse hit-target
    // interceptor and validate the first trusted button event instead.
    const events = new Set(['mousedown', 'mouseup', 'pointerdown', 'pointerup',
        'click', 'auxclick', 'dblclick', 'contextmenu']);
    const listener = event => {
        const current = state.current;
        if (!current || !events.has(event.type) || !event.isTrusted) return;
        const point = event.touches && event.touches[0] ? event.touches[0] : event;
        if (!current.result && Number.isFinite(point.clientX) && Number.isFinite(point.clientY))
            current.result = expect(current.target, point.clientX, point.clientY);
        if (current.result && current.result.status !== 'done') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    };
    for (const event of events)
        addEventListener(event, listener, { capture: true, passive: false });
    Object.defineProperty(globalThis, '__abPointerActionGateV1', {
        configurable: false,
        enumerable: false,
        value: {
            arm(target, x, y) {
                if (!(target instanceof Element) || !target.isConnected)
                    return { status: 'detached' };
                const preliminary = expect(target, x, y);
                if (preliminary.status !== 'done') return preliminary;
                state.current = { target, result: null };
                return { status: 'armed' };
            },
            stop() {
                const current = state.current;
                state.current = null;
                return current && current.result ? current.result : { status: 'done' };
            }
        }
    });
})()"#;
