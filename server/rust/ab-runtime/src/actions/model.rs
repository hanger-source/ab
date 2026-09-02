use crate::browser::session_manager::OpenDialog;
use crate::error::AbError;
use crate::observation::ObservationOutput;
use crate::selector::ElementTarget;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTargetIdentity {
    pub source: String,
    pub target_id: String,
    pub session_id: String,
    pub frame_id: String,
    pub document_generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<ActionCoordinateIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

impl ActionTargetIdentity {
    pub fn new(source: &str, target: &ElementTarget) -> Self {
        Self {
            source: source.to_owned(),
            target_id: target.target_id.clone(),
            session_id: target.session_id.clone(),
            frame_id: target.frame_id.clone(),
            document_generation: target.document_generation.clone(),
            backend_node_id: Some(target.backend_node_id),
            coordinate: None,
            observation_id: None,
            ref_id: None,
            element_id: None,
        }
    }

    pub fn coordinate(
        target_id: &str,
        session_id: &str,
        frame_id: &str,
        document_generation: &str,
        coordinate: ActionCoordinateIdentity,
    ) -> Self {
        Self {
            source: "cua".to_owned(),
            target_id: target_id.to_owned(),
            session_id: session_id.to_owned(),
            frame_id: frame_id.to_owned(),
            document_generation: document_generation.to_owned(),
            backend_node_id: None,
            coordinate: Some(coordinate),
            observation_id: None,
            ref_id: None,
            element_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCoordinateIdentity {
    pub viewport_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_y: Option<f64>,
}

impl ActionCoordinateIdentity {
    pub fn point(viewport_id: &str, x: f64, y: f64) -> Self {
        Self {
            viewport_id: viewport_id.to_owned(),
            x,
            y,
            end_x: None,
            end_y: None,
        }
    }

    pub fn drag(viewport_id: &str, x: f64, y: f64, end_x: f64, end_y: f64) -> Self {
        Self {
            viewport_id: viewport_id.to_owned(),
            x,
            y,
            end_x: Some(end_x),
            end_y: Some(end_y),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTiming {
    pub started_at_unix_ms: u64,
    pub ended_at_unix_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationChange {
    pub before_url: String,
    pub after_url: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChange {
    pub before_generation: String,
    pub after_generation: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOutcome {
    pub opened: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialog: Option<OpenDialog>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionObservationStatus {
    NotRequested,
    Completed,
    SkippedDialog,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionObservationOutcome {
    pub status: ActionObservationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AbError>,
}

impl ActionObservationOutcome {
    pub fn not_requested() -> Self {
        Self {
            status: ActionObservationStatus::NotRequested,
            error: None,
        }
    }

    pub fn completed() -> Self {
        Self {
            status: ActionObservationStatus::Completed,
            error: None,
        }
    }

    pub fn skipped_dialog() -> Self {
        Self {
            status: ActionObservationStatus::SkippedDialog,
            error: None,
        }
    }

    pub fn failed(error: AbError) -> Self {
        Self {
            status: ActionObservationStatus::Failed,
            error: Some(error),
        }
    }

    pub fn last_stage(&self) -> &'static str {
        match self.status {
            ActionObservationStatus::NotRequested => "action.dispatch.completed",
            ActionObservationStatus::Completed => "action.post_observation.completed",
            ActionObservationStatus::SkippedDialog => "action.post_observation.skipped_dialog",
            ActionObservationStatus::Failed => "action.post_observation.failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub id: String,
    pub action: String,
    pub target: ActionTargetIdentity,
    pub dispatch_mechanism: String,
    pub timing: ActionTiming,
    pub navigation: NavigationChange,
    pub document: DocumentChange,
    pub dialog: DialogOutcome,
    pub pending_release: bool,
    pub observation_outcome: ActionObservationOutcome,
    pub last_stage: String,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<ObservationOutput>,
}

pub fn dispatch_mechanism(operation: &str) -> &'static str {
    match operation {
        "click" | "dblclick" | "hover" | "wheel" | "drag" | "scrollintoview" | "scrollIntoView" => {
            "cdp.pointer"
        }
        "type" | "press" => "cdp.keyboard",
        "fill" | "clear" | "focus" | "check" | "uncheck" | "select" => "cdp.form",
        "upload" => "cdp.fileInput",
        "dominvoke" => "cdp.domInvoke",
        "text" | "innertext" | "getattribute" | "boundingbox" | "inspect" => "cdp.read",
        "screenshot" => "cdp.screenshot",
        _ => "cdp.unknown",
    }
}
