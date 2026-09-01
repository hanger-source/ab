use super::model::{Bounds, DomSnapshotCapture, NodeIdentity, ObservationGap};
use crate::agent_browser_engine::element::RefMap;
use crate::agent_browser_engine::snapshot::{self, SnapshotOptions as EngineSnapshotOptions};
use crate::browser::TargetContext;
use crate::error::{AbError, AbResult};
use crate::observation::model::ObservationSurface;
use crate::observation::{ObservationRecord, SnapshotOptions, COMPUTED_STYLES};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[allow(clippy::too_many_arguments)]
pub async fn capture(
    context: &TargetContext,
    client_id: &str,
    observation_id: String,
    revision: u64,
    options: &SnapshotOptions,
    previous: Option<&ObservationRecord>,
) -> AbResult<ObservationRecord> {
    let (context, snapshot_frame_id) = scoped_context(context, options)?;
    let lease_owner = format!("observation:{observation_id}");
    let domains = context.sessions.domains();
    let mut acquired = Vec::new();
    for session_id in capture_session_ids(&context) {
        for domain in ["DOM", "Accessibility"] {
            if let Err(error) = domains.acquire(&session_id, domain, &lease_owner).await {
                release_domains(&domains, &lease_owner, &acquired).await;
                return Err(error);
            }
            acquired.push((session_id.clone(), domain));
        }
        if let Err(error) = domains
            .acquire(&session_id, "DOMSnapshot", &lease_owner)
            .await
        {
            release_domains(&domains, &lease_owner, &acquired).await;
            return Err(error);
        }
        acquired.push((session_id, "DOMSnapshot"));
    }
    let result = capture_inner(
        &context,
        client_id,
        observation_id,
        revision,
        options,
        previous,
        snapshot_frame_id.as_deref(),
    )
    .await;
    release_domains(&domains, &lease_owner, &acquired).await;
    result
}

async fn release_domains(
    domains: &crate::browser::domain_leases::DomainLeases,
    owner: &str,
    acquired: &[(String, &'static str)],
) {
    for (session_id, domain) in acquired.iter().rev() {
        let _ = domains.release(session_id, domain, owner).await;
    }
}

async fn capture_inner(
    context: &TargetContext,
    client_id: &str,
    observation_id: String,
    revision: u64,
    options: &SnapshotOptions,
    previous: Option<&ObservationRecord>,
    snapshot_frame_id: Option<&str>,
) -> AbResult<ObservationRecord> {
    if previous.is_some_and(|record| record.output.frame_id != context.root_frame.id) {
        return Err(AbError::new(
            "observation_scope_mismatch",
            "observation.diff.scope",
            "diff observations must use the same frame scope",
        ));
    }
    let active_surface =
        if options.surface == ObservationSurface::Active && snapshot_frame_id.is_none() {
            resolve_active_surface(context).await?
        } else {
            None
        };
    let effective_surface = if active_surface.is_some() {
        ObservationSurface::Active
    } else {
        ObservationSurface::Document
    };
    let mut refs = RefMap::new();
    let mut ax_capture = snapshot::take_snapshot_report_prepared_in_scope(
        &context.client,
        &context.root_session_id,
        &EngineSnapshotOptions {
            selector: None,
            interactive: options.interactive()?,
            compact: true,
            depth: options.max_depth,
            urls: options.include_urls,
        },
        &mut refs,
        snapshot_frame_id,
        &context.iframe_sessions,
        active_surface.as_ref(),
    )
    .await
    .map_err(|message| observation_error("ax.capture", message))?;
    ax_capture
        .captured_frame_ids
        .insert(context.root_frame.id.clone());
    let mut relevant_frame_ids = ax_capture.captured_frame_ids.clone();
    relevant_frame_ids.insert(context.root_frame.id.clone());
    relevant_frame_ids.extend(
        ax_capture
            .gaps
            .iter()
            .filter_map(|gap| gap.frame_id.clone()),
    );
    let mut gaps = ax_capture
        .gaps
        .into_iter()
        .map(|gap| ObservationGap {
            frame_id: gap.frame_id,
            session_id: Some(gap.session_id),
            source: gap.stage,
            reason: gap.message,
        })
        .collect::<Vec<_>>();
    for frame in &context.frames {
        if active_surface.is_some() && !relevant_frame_ids.contains(&frame.id) {
            continue;
        }
        if !ax_capture.captured_frame_ids.contains(&frame.id) {
            gaps.push(ObservationGap {
                frame_id: Some(frame.id.clone()),
                session_id: Some(frame.session_id.clone()),
                source: "ax.frame".to_owned(),
                reason:
                    "frame was present in the capture topology but absent from the AX traversal"
                        .to_owned(),
            });
        }
    }
    let dom_snapshots = capture_dom_snapshots(context).await?;
    let pierced_dom = capture_pierced_dom(context).await?;
    let observation_frames = context
        .frames
        .iter()
        .filter(|frame| active_surface.is_none() || relevant_frame_ids.contains(&frame.id))
        .cloned()
        .collect::<Vec<_>>();
    let mut record = super::build_record(
        client_id,
        &context.target_id,
        observation_id,
        revision,
        options,
        previous,
        context.root_frame.id.clone(),
        context.root_frame.document_generation.clone(),
        ax_capture.text,
        refs,
        &observation_frames,
        &ax_capture.captured_frame_ids,
        gaps,
        &pierced_dom,
        &dom_snapshots,
        effective_surface,
    );
    hydrate_ref_bounds(context, &mut record).await;
    retain_refs(context, &mut record).await?;
    Ok(record)
}

async fn resolve_active_surface(context: &TargetContext) -> AbResult<Option<HashSet<i64>>> {
    let result = context
        .client
        .send_command(
            "Runtime.evaluate",
            Some(json!({
                "expression": r#"(() => {
                    const width = window.innerWidth;
                    const height = window.innerHeight;
                    if (!(width > 0 && height > 0)) return null;
                    const meaningfulSelector = [
                        'button',
                        'a[href]',
                        'input',
                        'textarea',
                        'select',
                        '[role]:not([role="presentation"]):not([role="none"])',
                        '[aria-label]',
                        '[contenteditable="true"]',
                        '[tabindex]:not([tabindex="-1"])',
                        'canvas',
                        'iframe',
                        'video',
                        'img',
                        'svg',
                    ].join(',');
                    const visibleRect = element => {
                        const style = getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        if (style.display === 'none'
                            || style.visibility === 'hidden'
                            || Number(style.opacity) === 0
                            || !(rect.width > 0 && rect.height > 0)
                            || rect.right <= 0
                            || rect.bottom <= 0
                            || rect.left >= width
                            || rect.top >= height) return null;
                        return { style, rect };
                    };
                    const candidates = [];
                    const candidateElements = new Set();
                    const addCandidate = (element, modal = false) => {
                        if (candidateElements.has(element)) return;
                        const geometry = visibleRect(element);
                        if (!geometry) return;
                        const { style, rect } = geometry;
                        const viewportCoverage = Math.max(0, Math.min(width, rect.right) - Math.max(0, rect.left))
                            * Math.max(0, Math.min(height, rect.bottom) - Math.max(0, rect.top))
                            / (width * height);
                        const numericZIndex = style.zIndex === 'auto' ? 0 : Number(style.zIndex);
                        const fullViewportLayer = viewportCoverage >= 0.85
                            && (style.position === 'fixed'
                                || (style.position === 'absolute'
                                    && Number.isFinite(numericZIndex)
                                    && numericZIndex > 0));
                        if (!modal && !fullViewportLayer) return;
                        candidateElements.add(element);
                        candidates.push({ element, modal, zIndex: Number.isFinite(numericZIndex) ? numericZIndex : 0 });
                    };

                    for (const modal of document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"]')) {
                        addCandidate(modal, true);
                    }
                    for (const witness of document.querySelectorAll(meaningfulSelector)) {
                        const geometry = visibleRect(witness);
                        if (!geometry || geometry.style.pointerEvents === 'none') continue;
                        const x = Math.max(0, Math.min(width - 1, geometry.rect.left + geometry.rect.width / 2));
                        const y = Math.max(0, Math.min(height - 1, geometry.rect.top + geometry.rect.height / 2));
                        const hit = document.elementFromPoint(x, y);
                        if (!hit || !(hit === witness || witness.contains(hit))) continue;
                        for (let element = witness.parentElement; element; element = element.parentElement) {
                            addCandidate(element);
                        }
                    }
                    return candidates.reduce((best, candidate) => {
                        if (!best) return candidate;
                        if (candidate.modal !== best.modal) return candidate.modal ? candidate : best;
                        if (best.element.contains(candidate.element)) return candidate;
                        if (candidate.element.contains(best.element)) return best;
                        if (candidate.zIndex !== best.zIndex) return candidate.zIndex > best.zIndex ? candidate : best;
                        return best.element.compareDocumentPosition(candidate.element) & Node.DOCUMENT_POSITION_FOLLOWING
                            ? candidate
                            : best;
                    }, null)?.element ?? null;
                })()"#,
                "returnByValue": false,
                "awaitPromise": false,
            })),
            Some(&context.root_session_id),
        )
        .await
        .map_err(|message| observation_error("active_surface.evaluate", message))?;
    let Some(object_id) = result
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let described = context
        .client
        .send_command(
            "DOM.describeNode",
            Some(json!({ "objectId": object_id, "depth": -1, "pierce": true })),
            Some(&context.root_session_id),
        )
        .await
        .map_err(|message| observation_error("active_surface.describe", message));
    let _ = context
        .client
        .send_command(
            "Runtime.releaseObject",
            Some(json!({ "objectId": object_id })),
            Some(&context.root_session_id),
        )
        .await;
    let described = described?;
    let mut backend_ids = HashSet::new();
    collect_backend_ids(&described, &mut backend_ids);
    if backend_ids.is_empty() {
        return Err(AbError::new(
            "observation_consistency_error",
            "observation.active_surface.identity",
            "active surface resolved without a DOM subtree identity",
        ));
    }
    Ok(Some(backend_ids))
}

fn collect_backend_ids(value: &Value, output: &mut HashSet<i64>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_backend_ids(value, output);
            }
        }
        Value::Object(values) => {
            if let Some(id) = values.get("backendNodeId").and_then(Value::as_i64) {
                output.insert(id);
            }
            for value in values.values() {
                collect_backend_ids(value, output);
            }
        }
        _ => {}
    }
}

fn scoped_context(
    context: &TargetContext,
    options: &SnapshotOptions,
) -> AbResult<(TargetContext, Option<String>)> {
    let Some(root_id) = options.frame_root()? else {
        return Ok((context.clone(), None));
    };
    let root_frame = context
        .frames
        .iter()
        .find(|frame| frame.id == root_id)
        .cloned()
        .ok_or_else(|| {
            AbError::new(
                "frame_not_found",
                "observation.frame_scope",
                format!(
                    "frame {root_id} does not belong to tab {}",
                    context.target_id
                ),
            )
        })?;
    let mut frame_ids = HashSet::from([root_id.to_owned()]);
    loop {
        let before = frame_ids.len();
        for frame in &context.frames {
            if frame
                .parent_id
                .as_ref()
                .is_some_and(|parent_id| frame_ids.contains(parent_id))
            {
                frame_ids.insert(frame.id.clone());
            }
        }
        if frame_ids.len() == before {
            break;
        }
    }
    let frames = context
        .frames
        .iter()
        .filter(|frame| frame_ids.contains(&frame.id))
        .cloned()
        .collect::<Vec<_>>();
    let iframe_sessions = context
        .iframe_sessions
        .iter()
        .filter(|(frame_id, _)| frame_ids.contains(*frame_id))
        .map(|(frame_id, session_id)| (frame_id.clone(), session_id.clone()))
        .collect();
    Ok((
        TargetContext {
            target_id: context.target_id.clone(),
            root_session_id: context.root_session_id.clone(),
            root_frame,
            frames,
            iframe_sessions,
            client: context.client.clone(),
            sessions: context.sessions.clone(),
        },
        Some(root_id.to_owned()),
    ))
}

async fn retain_refs(context: &TargetContext, record: &mut ObservationRecord) -> AbResult<()> {
    let object_group = format!("ab-observation:{}", record.output.id);
    let frame_sessions = context
        .frames
        .iter()
        .cloned()
        .map(|frame| (frame.id, frame.session_id))
        .collect::<HashMap<_, _>>();
    let mut retained_sessions = HashSet::new();
    let mut retained_nodes = HashMap::new();

    for public_ref in &record.output.refs {
        let Some(backend_node_id) = public_ref.backend_node_id else {
            continue;
        };
        let Some(session_id) = frame_sessions.get(&public_ref.frame_id) else {
            release_object_groups(&context.client, &retained_sessions, &object_group).await;
            return Err(AbError::new(
                "observation_consistency_error",
                "observation.ref.frame",
                format!("ref {} frame disappeared during capture", public_ref.id),
            ));
        };
        retained_sessions.insert(session_id.clone());
        let resolved = match context
            .client
            .send_command(
                "DOM.resolveNode",
                Some(json!({
                    "backendNodeId": backend_node_id,
                    "objectGroup": object_group
                })),
                Some(session_id),
            )
            .await
        {
            Ok(value) => value,
            Err(message) => {
                release_object_groups(&context.client, &retained_sessions, &object_group).await;
                return Err(AbError::new(
                    "observation_consistency_error",
                    "observation.ref.retain",
                    format!("ref {} changed during capture: {message}", public_ref.id),
                ));
            }
        };
        let Some(object_id) = resolved
            .pointer("/object/objectId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            release_object_groups(&context.client, &retained_sessions, &object_group).await;
            return Err(AbError::new(
                "observation_consistency_error",
                "observation.ref.object",
                format!("ref {} did not resolve to a remote object", public_ref.id),
            ));
        };
        retained_nodes.insert(
            public_ref.id.clone(),
            super::RetainedNode {
                session_id: session_id.clone(),
                object_id,
            },
        );
    }

    record.object_group = object_group;
    record.retained_sessions = retained_sessions;
    record.retained_nodes = retained_nodes;
    Ok(())
}

async fn release_object_groups(
    client: &crate::agent_browser_engine::cdp::client::CdpClient,
    sessions: &HashSet<String>,
    object_group: &str,
) {
    for session_id in sessions {
        let _ = client
            .send_command(
                "Runtime.releaseObjectGroup",
                Some(json!({ "objectGroup": object_group })),
                Some(session_id),
            )
            .await;
    }
}

async fn geometry(context: &TargetContext, session_id: &str) -> AbResult<super::GeometryContext> {
    let result = context.client.send_command(
        "Runtime.evaluate",
        Some(json!({
            "expression": "({ devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY })",
            "returnByValue": true
        })),
        Some(session_id),
    ).await.map_err(|message| observation_error("geometry", message))?;
    let value = result.pointer("/result/value").unwrap_or(&Value::Null);
    Ok(super::GeometryContext {
        device_pixel_ratio: value
            .get("devicePixelRatio")
            .and_then(Value::as_f64)
            .unwrap_or(1.0),
        scroll_x: value.get("scrollX").and_then(Value::as_f64).unwrap_or(0.0),
        scroll_y: value.get("scrollY").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

async fn capture_pierced_dom(context: &TargetContext) -> AbResult<super::DomTreeSummary> {
    let mut summary = super::DomTreeSummary::default();
    for session_id in capture_session_ids(context) {
        let document = context
            .client
            .send_command(
                "DOM.getDocument",
                Some(json!({ "depth": -1, "pierce": true })),
                Some(&session_id),
            )
            .await
            .map_err(|message| observation_error("dom.pierce", message))?;
        summary.session_count += 1;
        collect_dom_identity(&document, &session_id, &mut summary);
    }
    Ok(summary)
}

fn collect_dom_identity(value: &Value, session_id: &str, summary: &mut super::DomTreeSummary) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_dom_identity(value, session_id, summary);
            }
        }
        Value::Object(object) => {
            if let Some(id) = object.get("backendNodeId").and_then(Value::as_i64) {
                summary.backend_nodes.insert(NodeIdentity {
                    session_id: session_id.to_owned(),
                    backend_node_id: id,
                });
            }
            if object.contains_key("shadowRootType") {
                summary.shadow_root_count += 1;
            }
            for value in object.values() {
                collect_dom_identity(value, session_id, summary);
            }
        }
        _ => {}
    }
}

async fn capture_dom_snapshots(context: &TargetContext) -> AbResult<Vec<DomSnapshotCapture>> {
    let mut captures = Vec::new();
    for session_id in capture_session_ids(context) {
        let value = context
            .client
            .send_command(
                "DOMSnapshot.captureSnapshot",
                Some(json!({
                    "computedStyles": COMPUTED_STYLES,
                    "includePaintOrder": true,
                    "includeDOMRects": true,
                    "includeBlendedBackgroundColors": false,
                    "includeTextColorOpacities": false
                })),
                Some(&session_id),
            )
            .await
            .map_err(|message| observation_error("dom.capture", message))?;
        captures.push(DomSnapshotCapture {
            session_id: session_id.clone(),
            value,
            geometry: geometry(context, &session_id).await?,
        });
    }
    Ok(captures)
}

fn capture_session_ids(context: &TargetContext) -> Vec<String> {
    let mut sessions = context
        .frames
        .iter()
        .map(|frame| frame.session_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    sessions.sort();
    sessions
}

async fn hydrate_ref_bounds(context: &TargetContext, record: &mut ObservationRecord) {
    let frame_sessions = context
        .frames
        .iter()
        .map(|frame| (frame.id.as_str(), frame.session_id.as_str()))
        .collect::<HashMap<_, _>>();
    for public_ref in &mut record.output.refs {
        let Some(backend_node_id) = public_ref.backend_node_id else {
            continue;
        };
        let Some(session_id) = frame_sessions.get(public_ref.frame_id.as_str()) else {
            continue;
        };
        let Ok(model) = context
            .client
            .send_command(
                "DOM.getBoxModel",
                Some(json!({ "backendNodeId": backend_node_id })),
                Some(session_id),
            )
            .await
        else {
            continue;
        };
        let Some(quad) = model.pointer("/model/border").and_then(Value::as_array) else {
            continue;
        };
        let points = quad.iter().filter_map(Value::as_f64).collect::<Vec<_>>();
        if points.len() != 8 {
            continue;
        }
        let xs = [points[0], points[2], points[4], points[6]];
        let ys = [points[1], points[3], points[5], points[7]];
        let min_x = xs.into_iter().fold(f64::INFINITY, f64::min);
        let max_x = xs.into_iter().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.into_iter().fold(f64::INFINITY, f64::min);
        let max_y = ys.into_iter().fold(f64::NEG_INFINITY, f64::max);
        public_ref.bounds = Some(Bounds {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        });
    }
}

fn observation_error(stage: &str, message: String) -> AbError {
    AbError::new(
        "observation_failed",
        format!("observation.{stage}"),
        message,
    )
}
