use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 3;
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_ID: &str = env!("AB_SOURCE_BUILD_ID");

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RequestTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorData {
    pub kind: String,
    pub stage: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ErrorContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<serde_json::Value>")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TraceContext {
    pub trace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol_version: u32,
    pub sdk_version: String,
    pub build_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum ChromeSource {
    Launched,
    Reattached,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChromeIdentity {
    pub source: ChromeSource,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientReady {
    pub protocol_version: u32,
    pub sdk_version: String,
    pub build_id: String,
    pub client_id: String,
    pub daemon_id: String,
    pub browser_generation: String,
    pub chrome: ChromeIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub method: String,
    pub trace: TraceContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RequestTarget>,
    #[ts(as = "serde_json::Value")]
    pub params: Value,
    #[ts(type = "number")]
    pub deadline_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Cancel {
    pub id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocatorQuery {
    Css {
        value: String,
    },
    Role {
        role: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default)]
        exact: bool,
    },
    Text {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    Label {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    Placeholder {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    AltText {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    Title {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    TestId {
        value: String,
        #[serde(default)]
        exact: bool,
    },
    And {
        left: Box<LocatorQuery>,
        right: Box<LocatorQuery>,
    },
    Or {
        left: Box<LocatorQuery>,
        right: Box<LocatorQuery>,
    },
    Descendant {
        ancestor: Box<LocatorQuery>,
        descendant: Box<LocatorQuery>,
    },
    Has {
        query: Box<LocatorQuery>,
        descendant: Box<LocatorQuery>,
    },
    HasText {
        query: Box<LocatorQuery>,
        value: String,
        #[serde(default)]
        exact: bool,
    },
    Frame {
        #[serde(rename = "frameId")]
        #[ts(rename = "frameId")]
        frame_id: String,
        query: Box<LocatorQuery>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocatorRequest {
    pub query: LocatorQuery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub visible: Option<bool>,
    pub operation: String,
    #[ts(as = "serde_json::Value")]
    pub arguments: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ElementInspectionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attributes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ElementInspection {
    pub tag_name: String,
    pub role_attribute: Option<String>,
    pub input_type: Option<String>,
    pub attributes: BTreeMap<String, Option<String>>,
    pub text_content: String,
    pub inner_text: String,
    pub value: Option<String>,
    pub visible: bool,
    pub enabled: bool,
    pub checked: Option<bool>,
    pub read_only: bool,
    pub content_editable: bool,
    pub bounds: ElementBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ResponseOutcome {
    Success {
        #[ts(as = "serde_json::Value")]
        result: Value,
    },
    Error {
        error: Box<ErrorData>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: String,
    pub outcome: ResponseOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub request_id: String,
    pub trace_id: String,
    pub method: String,
    pub name: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub timestamp_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RequestTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<serde_json::Value>")]
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvent {
    pub resource_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    pub event: String,
    #[ts(as = "serde_json::Value")]
    pub value: Value,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceClosed {
    pub resource_id: String,
    pub reason: String,
    #[ts(type = "number")]
    pub last_sequence: u64,
    pub complete: bool,
    #[ts(type = "number")]
    pub closed_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEvent {
    pub event: String,
    #[ts(as = "serde_json::Value")]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientClosed {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "client.hello")]
    ClientHello(ClientHello),
    #[serde(rename = "request")]
    Request(Box<Request>),
    #[serde(rename = "cancel")]
    Cancel(Cancel),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type")]
pub enum DaemonMessage {
    #[serde(rename = "client.ready")]
    ClientReady(ClientReady),
    #[serde(rename = "client.rejected")]
    ClientRejected { error: ErrorData },
    #[serde(rename = "response")]
    Response(Response),
    #[serde(rename = "stage")]
    Stage(Stage),
    #[serde(rename = "resource.event")]
    ResourceEvent(ResourceEvent),
    #[serde(rename = "resource.closed")]
    ResourceClosed(ResourceClosed),
    #[serde(rename = "daemon.event")]
    DaemonEvent(DaemonEvent),
    #[serde(rename = "client.closed")]
    ClientClosed(ClientClosed),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProtocolContract {
    pub client_message: ClientMessage,
    pub daemon_message: DaemonMessage,
}

pub fn typescript_declarations() -> String {
    let config = ts_rs::Config::default();
    let declarations = [
        RequestTarget::decl(&config),
        ErrorContext::decl(&config),
        ErrorData::decl(&config),
        TraceContext::decl(&config),
        ClientHello::decl(&config),
        ChromeSource::decl(&config),
        ChromeIdentity::decl(&config),
        ClientReady::decl(&config),
        Request::decl(&config),
        Cancel::decl(&config),
        LocatorQuery::decl(&config),
        LocatorRequest::decl(&config),
        ElementInspectionRequest::decl(&config),
        ElementBounds::decl(&config),
        ElementInspection::decl(&config),
        ResponseOutcome::decl(&config),
        Response::decl(&config),
        Stage::decl(&config),
        ResourceEvent::decl(&config),
        ResourceClosed::decl(&config),
        DaemonEvent::decl(&config),
        ClientClosed::decl(&config),
        ClientMessage::decl(&config),
        DaemonMessage::decl(&config),
    ];
    let declarations = declarations
        .join("\n\n")
        .replace("\ntype ", "\nexport type ");
    let declarations = if declarations.starts_with("type ") {
        format!("export {declarations}")
    } else {
        declarations
    };
    format!(
        "// Generated from server/rust/ab-protocol. Do not edit.\n\
         export const PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;\n\
         export const SDK_VERSION = \"{SDK_VERSION}\" as const;\n\
         export const BUILD_ID = \"{BUILD_ID}\" as const;\n\n\
         export type JsonValue = null | boolean | number | string | JsonValue[] | {{ [key: string]: JsonValue }};\n\n{}\n",
        declarations
    )
}
