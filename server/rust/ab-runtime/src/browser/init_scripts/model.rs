use crate::error::{AbError, AbResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitScriptDefinition {
    pub name: String,
    #[serde(default = "default_world")]
    pub world: String,
    #[serde(default = "default_frames")]
    pub frames: String,
    pub source: String,
    #[serde(default)]
    pub args: Vec<Value>,
}

impl InitScriptDefinition {
    pub fn validate(self) -> AbResult<Self> {
        if self.name.trim().is_empty() {
            return Err(init_script_argument("name", "name must not be empty"));
        }
        if self.source.trim().is_empty() {
            return Err(init_script_argument("source", "source must not be empty"));
        }
        if !matches!(self.world.as_str(), "main" | "isolated") {
            return Err(init_script_argument(
                "world",
                "world must be main or isolated",
            ));
        }
        if !matches!(self.frames.as_str(), "all" | "top") {
            return Err(init_script_argument("frames", "frames must be all or top"));
        }
        Ok(self)
    }
}

fn default_world() -> String {
    "isolated".to_owned()
}

fn default_frames() -> String {
    "all".to_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitScriptInstance {
    pub id: String,
    pub frame_id: String,
    pub document_generation: String,
    pub session_id: String,
    pub execution_context_id: i64,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InitScriptInstanceIdentity {
    pub session_id: String,
    pub execution_context_id: i64,
    pub frame_id: String,
    pub document_generation: String,
}

#[derive(Debug, Clone)]
pub struct InitScriptEvent {
    pub registration_id: String,
    pub method: String,
    pub params: Value,
    pub session_id: String,
}

pub struct InitScriptSubscription {
    pub receiver: broadcast::Receiver<InitScriptEvent>,
}

pub(super) fn init_script_argument(field: &str, message: &str) -> AbError {
    AbError::new(
        "invalid_argument",
        format!("resource.init_script.{field}"),
        message,
    )
}

pub(super) fn init_script_error(stage: &str, message: impl Into<String>) -> AbError {
    AbError::new("init_script_error", format!("init_script.{stage}"), message)
}

pub(super) fn init_script_not_found(owner_id: &str) -> AbError {
    AbError::new(
        "resource_not_found",
        "init_script.registration",
        format!("init script registration {owner_id} does not exist"),
    )
}

pub(super) fn invalid_binding_payload(error: impl std::fmt::Display) -> Value {
    json!({
        "kind": "error",
        "message": format!("invalid binding payload: {error}")
    })
}
