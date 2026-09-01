use super::model::{Bounds, ObservationDiff, ObservationOutput, ObservationRecord, PublicRef};
use crate::agent_browser_engine::diff::diff_snapshots;
use std::collections::HashMap;

pub(super) fn build_diff(
    previous: &ObservationRecord,
    current: &ObservationOutput,
) -> ObservationDiff {
    let text_diff = diff_snapshots(&previous.output.text, &current.text);
    let document_replaced = previous.output.document_generation != current.document_generation;
    if document_replaced {
        return ObservationDiff {
            from_observation_id: previous.output.id.clone(),
            document_replaced: true,
            text: current.text.clone(),
            additions: text_diff.additions,
            removals: text_diff.removals,
            added_refs: sorted_ids(current.refs.iter().map(|entry| entry.id.clone()).collect()),
            removed_refs: sorted_ids(
                previous
                    .output
                    .refs
                    .iter()
                    .map(|entry| entry.id.clone())
                    .collect(),
            ),
            changed_refs: Vec::new(),
        };
    }

    let previous_by_identity = refs_by_identity(&previous.output.refs);
    let current_by_identity = refs_by_identity(&current.refs);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (identity, entry) in &current_by_identity {
        match previous_by_identity.get(identity) {
            None => added.push(entry.id.clone()),
            Some(old)
                if old.role != entry.role
                    || old.name != entry.name
                    || bounds_changed(&old.bounds, &entry.bounds) =>
            {
                changed.push(entry.id.clone())
            }
            _ => {}
        }
    }
    for (identity, entry) in &previous_by_identity {
        if !current_by_identity.contains_key(identity) {
            removed.push(entry.id.clone());
        }
    }
    ObservationDiff {
        from_observation_id: previous.output.id.clone(),
        document_replaced: false,
        text: text_diff.diff,
        additions: text_diff.additions,
        removals: text_diff.removals,
        added_refs: sorted_ids(added),
        removed_refs: sorted_ids(removed),
        changed_refs: sorted_ids(changed),
    }
}

fn refs_by_identity(refs: &[PublicRef]) -> HashMap<String, &PublicRef> {
    refs.iter()
        .map(|entry| {
            let identity = entry
                .backend_node_id
                .map(|value| {
                    format!(
                        "node:{}:{}:{value}",
                        entry.frame_id, entry.document_generation
                    )
                })
                .unwrap_or_else(|| format!("ref:{}:{}:{}", entry.id, entry.role, entry.name));
            (identity, entry)
        })
        .collect()
}

fn bounds_changed(left: &Option<Bounds>, right: &Option<Bounds>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            (left.x - right.x).abs() > 0.5
                || (left.y - right.y).abs() > 0.5
                || (left.width - right.width).abs() > 0.5
                || (left.height - right.height).abs() > 0.5
        }
        (None, None) => false,
        _ => true,
    }
}

fn sorted_ids(mut ids: Vec<String>) -> Vec<String> {
    ids.sort_by_key(|id| ref_number(id));
    ids
}

fn ref_number(value: &str) -> usize {
    value
        .strip_prefix('e')
        .and_then(|value| value.parse().ok())
        .unwrap_or(usize::MAX)
}
