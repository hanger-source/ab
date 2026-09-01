use super::diff::build_diff;
use super::model::{
    Bounds, DomSnapshotCapture, DomTreeSummary, GeometryContext, NodeIdentity, ObservationGap,
    ObservationOutput, ObservationRecord, ObservationSources, PublicRef, SnapshotOptions,
};
use crate::agent_browser_engine::element::RefMap;
use crate::browser::session_manager::FrameState;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const COMPUTED_STYLES: &[&str] = &[
    "display",
    "visibility",
    "opacity",
    "pointer-events",
    "cursor",
];

#[derive(Debug, Default, Clone)]
struct DomInfo {
    bounds: Option<Bounds>,
    visible: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn build_record(
    client_id: &str,
    target_id: &str,
    observation_id: String,
    revision: u64,
    options: &SnapshotOptions,
    previous: Option<&ObservationRecord>,
    frame_id: String,
    document_generation: String,
    engine_text: String,
    engine_refs: RefMap,
    frames: &[FrameState],
    captured_frame_ids: &HashSet<String>,
    gaps: Vec<ObservationGap>,
    pierced_dom: &DomTreeSummary,
    dom_snapshots: &[DomSnapshotCapture],
    surface: super::model::ObservationSurface,
) -> ObservationRecord {
    let dom_info = parse_dom_snapshots(dom_snapshots);
    let frame_identities = frames
        .iter()
        .map(|frame| {
            (
                frame.id.clone(),
                (frame.session_id.clone(), frame.document_generation.clone()),
            )
        })
        .collect::<HashMap<_, _>>();
    let (engine_text, engine_refs) = stabilize_ref_ids(
        previous,
        &frame_id,
        &document_generation,
        &frame_identities,
        engine_text,
        engine_refs,
    );
    let max_chars = options.max_chars.unwrap_or(120_000);
    let truncated = engine_text.chars().count() > max_chars;
    let text = if truncated {
        let mut value: String = engine_text.chars().take(max_chars).collect();
        value.push_str("\n… [observation truncated]");
        value
    } else {
        engine_text
    };

    let mut refs = engine_refs
        .entries_sorted()
        .into_iter()
        .filter_map(|(id, entry)| {
            let ref_frame_id = entry.frame_id.unwrap_or_else(|| frame_id.clone());
            let (session_id, ref_document_generation) = frame_identities
                .get(&ref_frame_id)
                .cloned()
                .unwrap_or_else(|| (String::new(), document_generation.clone()));
            let node_identity = entry.backend_node_id.map(|backend_node_id| NodeIdentity {
                session_id,
                backend_node_id,
            });
            let info = node_identity
                .as_ref()
                .and_then(|identity| dom_info.get(identity));
            if info.is_some_and(|value| !value.visible) {
                return None;
            }
            Some(PublicRef {
                id,
                role: entry.role,
                name: entry.display_name,
                document_generation: ref_document_generation,
                frame_id: ref_frame_id,
                backend_node_id: entry.backend_node_id,
                bounds: info.and_then(|value| value.bounds.clone()),
            })
        })
        .collect::<Vec<_>>();
    refs.sort_by_key(|entry| ref_number(&entry.id));
    let refs_covered = refs.iter().all(|entry| {
        let Some(backend_node_id) = entry.backend_node_id else {
            return true;
        };
        let Some((session_id, _)) = frame_identities.get(&entry.frame_id) else {
            return false;
        };
        pierced_dom.backend_nodes.contains(&NodeIdentity {
            session_id: session_id.clone(),
            backend_node_id,
        })
    });
    let expected_frame_ids = frames
        .iter()
        .map(|frame| frame.id.as_str())
        .collect::<HashSet<_>>();
    let captured_frame_count = captured_frame_ids
        .iter()
        .filter(|frame_id| expected_frame_ids.contains(frame_id.as_str()))
        .count();
    let frame_count = expected_frame_ids.len();
    let frame_coverage = captured_frame_count == frame_count;

    let mut output = ObservationOutput {
        id: observation_id,
        target_id: target_id.to_owned(),
        frame_id,
        document_generation,
        revision,
        node_count: text.lines().count(),
        text,
        refs,
        complete: !truncated && refs_covered && frame_coverage && gaps.is_empty(),
        truncated,
        sources: ObservationSources {
            ax: true,
            dom: true,
            layout: true,
            pierced_dom: true,
            session_count: pierced_dom.session_count,
            shadow_root_count: pierced_dom.shadow_root_count,
            backend_node_count: pierced_dom.backend_nodes.len(),
            refs_covered,
            frame_count,
            captured_frame_count,
            gaps,
            surface,
        },
        diff: None,
    };
    if let Some(previous) = previous {
        output.diff = Some(build_diff(previous, &output));
    }

    ObservationRecord {
        client_id: client_id.to_owned(),
        output,
        capture_options: options.clone(),
        engine_refs,
        retained_nodes: HashMap::new(),
        object_group: String::new(),
        retained_sessions: HashSet::new(),
    }
}

fn stabilize_ref_ids(
    previous: Option<&ObservationRecord>,
    root_frame_id: &str,
    document_generation: &str,
    frame_identities: &HashMap<String, (String, String)>,
    text: String,
    refs: RefMap,
) -> (String, RefMap) {
    let Some(previous) = previous.filter(|record| {
        record.output.frame_id == root_frame_id
            && record.output.document_generation == document_generation
    }) else {
        return (text, refs);
    };

    let previous_ids = previous
        .output
        .refs
        .iter()
        .filter_map(|entry| {
            Some((
                (
                    entry.frame_id.clone(),
                    entry.document_generation.clone(),
                    entry.backend_node_id?,
                ),
                entry.id.clone(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut used = HashSet::new();
    let mut next_ref = previous
        .output
        .refs
        .iter()
        .map(|entry| ref_number(&entry.id))
        .filter(|number| *number != usize::MAX)
        .max()
        .unwrap_or(0)
        + 1;
    let mut mapping = HashMap::new();

    for (current_id, entry) in refs.entries_sorted() {
        let frame_id = entry
            .frame_id
            .clone()
            .unwrap_or_else(|| root_frame_id.to_owned());
        let current_document_generation = frame_identities
            .get(&frame_id)
            .map(|(_, generation)| generation.as_str())
            .unwrap_or(document_generation);
        let reused = entry.backend_node_id.and_then(|backend_node_id| {
            previous_ids
                .get(&(
                    frame_id,
                    current_document_generation.to_owned(),
                    backend_node_id,
                ))
                .filter(|candidate| !used.contains(*candidate))
                .cloned()
        });
        let stable_id = reused.unwrap_or_else(|| loop {
            let candidate = format!("e{next_ref}");
            next_ref += 1;
            if !used.contains(&candidate) {
                break candidate;
            }
        });
        used.insert(stable_id.clone());
        mapping.insert(current_id, stable_id);
    }

    (remap_ref_tokens(&text, &mapping), refs.remap_ids(&mapping))
}

fn remap_ref_tokens(text: &str, mapping: &HashMap<String, String>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut remainder = text;
    while let Some(offset) = remainder.find("ref=e") {
        let id_start = offset + "ref=".len();
        output.push_str(&remainder[..id_start]);
        let digits = remainder[id_start + 1..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let id_end = id_start + 1 + digits;
        let current_id = &remainder[id_start..id_end];
        output.push_str(
            mapping
                .get(current_id)
                .map(String::as_str)
                .unwrap_or(current_id),
        );
        remainder = &remainder[id_end..];
    }
    output.push_str(remainder);
    output
}

fn parse_dom_snapshots(captures: &[DomSnapshotCapture]) -> HashMap<NodeIdentity, DomInfo> {
    let mut output = HashMap::new();
    for capture in captures {
        let strings = capture
            .value
            .get("strings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(documents) = capture.value.get("documents").and_then(Value::as_array) else {
            continue;
        };
        for document in documents {
            let backend_ids = array_at(document, "/nodes/backendNodeId");
            let layout_node_indices = array_at(document, "/layout/nodeIndex");
            let bounds = array_at(document, "/layout/bounds");
            let styles = array_at(document, "/layout/styles");
            for (layout_index, node_index_value) in layout_node_indices.iter().enumerate() {
                let Some(node_index) = node_index_value.as_u64().map(|value| value as usize) else {
                    continue;
                };
                let Some(backend_node_id) = backend_ids.get(node_index).and_then(Value::as_i64)
                else {
                    continue;
                };
                let style_values = styles
                    .get(layout_index)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let style = |index: usize| {
                    style_values
                        .get(index)
                        .and_then(Value::as_u64)
                        .and_then(|string_index| strings.get(string_index as usize))
                        .and_then(Value::as_str)
                };
                output.insert(
                    NodeIdentity {
                        session_id: capture.session_id.clone(),
                        backend_node_id,
                    },
                    DomInfo {
                        bounds: bounds
                            .get(layout_index)
                            .and_then(|value| parse_bounds(value, capture.geometry)),
                        visible: style(0) != Some("none")
                            && style(1) != Some("hidden")
                            && style(2).and_then(|value| value.parse::<f64>().ok()) != Some(0.0)
                            && style(3) != Some("none"),
                    },
                );
            }
        }
    }
    output
}

fn array_at(value: &Value, pointer: &str) -> Vec<Value> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn parse_bounds(value: &Value, geometry: GeometryContext) -> Option<Bounds> {
    let values = value.as_array()?;
    let scale = if geometry.device_pixel_ratio.is_finite() && geometry.device_pixel_ratio > 0.0 {
        geometry.device_pixel_ratio
    } else {
        1.0
    };
    Some(Bounds {
        x: values.first()?.as_f64()? / scale - geometry.scroll_x,
        y: values.get(1)?.as_f64()? / scale - geometry.scroll_y,
        width: values.get(2)?.as_f64()? / scale,
        height: values.get(3)?.as_f64()? / scale,
    })
}

fn ref_number(value: &str) -> usize {
    value
        .strip_prefix('e')
        .and_then(|value| value.parse().ok())
        .unwrap_or(usize::MAX)
}
