use crate::agent_browser_engine::element::RefMap;
use crate::error::{AbError, AbResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOptions {
    #[serde(default = "default_mode")]
    pub mode: String,
    pub max_depth: Option<usize>,
    pub max_chars: Option<usize>,
    pub diff_from: Option<String>,
    #[serde(default)]
    pub frames: FrameScope,
    #[serde(default)]
    pub include_urls: bool,
    #[serde(default)]
    pub surface: ObservationSurface,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationSurface {
    Active,
    #[default]
    Document,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(untagged)]
pub enum FrameScope {
    #[default]
    All,
    Named(String),
    Subtree {
        root: String,
    },
}

fn default_mode() -> String {
    "interactive".to_owned()
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            max_depth: None,
            max_chars: None,
            diff_from: None,
            frames: FrameScope::All,
            include_urls: false,
            surface: ObservationSurface::Document,
        }
    }
}

impl SnapshotOptions {
    pub fn interactive(&self) -> AbResult<bool> {
        match self.mode.as_str() {
            "interactive" => Ok(true),
            "full" => Ok(false),
            mode => Err(AbError::new(
                "invalid_argument",
                "observation.options.mode",
                format!("unsupported observation mode {mode}"),
            )),
        }
    }

    pub fn frame_root(&self) -> AbResult<Option<&str>> {
        match &self.frames {
            FrameScope::All => Ok(None),
            FrameScope::Named(value) if value == "all" => Ok(None),
            FrameScope::Named(value) => Err(AbError::new(
                "invalid_argument",
                "observation.options.frames",
                format!("unsupported frame scope {value}"),
            )),
            FrameScope::Subtree { root } if root.is_empty() => Err(AbError::new(
                "invalid_argument",
                "observation.options.frames",
                "frame subtree root must not be empty",
            )),
            FrameScope::Subtree { root } => Ok(Some(root)),
        }
    }

    pub fn same_capture_shape(&self, other: &Self) -> bool {
        self.mode == other.mode
            && self.max_depth == other.max_depth
            && self.max_chars == other.max_chars
            && self.frames == other.frames
            && self.include_urls == other.include_urls
            && self.surface == other.surface
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRef {
    pub id: String,
    pub role: String,
    pub name: String,
    pub frame_id: String,
    pub document_generation: String,
    pub backend_node_id: Option<i64>,
    pub bounds: Option<Bounds>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationDiff {
    pub from_observation_id: String,
    pub document_replaced: bool,
    pub surface_replaced: bool,
    pub text: String,
    pub additions: usize,
    pub removals: usize,
    pub added_refs: Vec<String>,
    pub removed_refs: Vec<String>,
    pub changed_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationOutput {
    pub id: String,
    pub target_id: String,
    pub frame_id: String,
    pub document_generation: String,
    pub revision: u64,
    pub text: String,
    pub refs: Vec<PublicRef>,
    pub complete: bool,
    pub truncated: bool,
    pub node_count: usize,
    pub sources: ObservationSources,
    pub diff: Option<ObservationDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSources {
    pub ax: bool,
    pub dom: bool,
    pub layout: bool,
    pub pierced_dom: bool,
    pub session_count: usize,
    pub shadow_root_count: usize,
    pub backend_node_count: usize,
    pub refs_covered: bool,
    pub frame_count: usize,
    pub captured_frame_count: usize,
    pub gaps: Vec<ObservationGap>,
    pub surface: ObservationSurface,
    pub surface_identity: ObservationSurfaceIdentity,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSurfaceIdentity {
    pub session_id: String,
    pub frame_id: String,
    pub document_generation: String,
    pub root_backend_node_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationGap {
    pub frame_id: Option<String>,
    pub session_id: Option<String>,
    pub source: String,
    pub reason: String,
}

#[derive(Clone)]
pub struct ObservationRecord {
    pub client_id: String,
    pub output: ObservationOutput,
    pub capture_options: SnapshotOptions,
    pub engine_refs: RefMap,
    pub retained_nodes: HashMap<String, RetainedNode>,
    pub object_group: String,
    pub retained_sessions: HashSet<String>,
}

#[derive(Clone)]
pub struct RetainedNode {
    pub session_id: String,
    pub object_id: String,
}

#[derive(Debug, Clone, Copy)]
pub struct GeometryContext {
    pub device_pixel_ratio: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

#[derive(Debug, Default, Clone)]
pub struct DomTreeSummary {
    pub session_count: usize,
    pub shadow_root_count: usize,
    pub backend_nodes: HashSet<NodeIdentity>,
    pub root_backend_nodes: HashMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NodeIdentity {
    pub session_id: String,
    pub backend_node_id: i64,
}

#[derive(Debug, Clone)]
pub struct DomSnapshotCapture {
    pub session_id: String,
    pub value: serde_json::Value,
    pub geometry: GeometryContext,
}
