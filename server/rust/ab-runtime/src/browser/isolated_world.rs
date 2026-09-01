use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::error::{AbError, AbResult};
use serde_json::{json, Value};

pub(crate) async fn create(
    client: &CdpClient,
    session_id: &str,
    frame_id: &str,
    purpose: &str,
) -> AbResult<i64> {
    let world_name = format!("ab-{purpose}-v1");
    let result = client
        .send_command(
            "Page.createIsolatedWorld",
            Some(json!({
                "frameId": frame_id,
                "worldName": world_name,
                "grantUniveralAccess": false
            })),
            Some(session_id),
        )
        .await
        .map_err(|message| world_error(purpose, "create", message))?;
    result
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            world_error(
                purpose,
                "identity",
                "isolated world has no executionContextId",
            )
        })
}

fn world_error(purpose: &str, stage: &str, message: impl Into<String>) -> AbError {
    AbError::new(
        "isolated_world_error",
        format!("isolated_world.{purpose}.{stage}"),
        message.into(),
    )
}
