use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::browser::session_manager::{FrameState, SessionManager};
use crate::error::{AbError, AbResult};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct TargetContext {
    pub target_id: String,
    pub root_session_id: String,
    pub root_frame: FrameState,
    pub frames: Vec<FrameState>,
    pub iframe_sessions: HashMap<String, String>,
    pub client: Arc<CdpClient>,
    pub sessions: Arc<SessionManager>,
}

impl TargetContext {
    pub async fn resolve(sessions: Arc<SessionManager>, target_id: &str) -> AbResult<Self> {
        let root_session_id = sessions.root_session(target_id).await?;
        let frames = sessions.ensure_frames(target_id).await?;
        let root_frame = frames
            .iter()
            .find(|frame| frame.parent_id.is_none())
            .cloned()
            .ok_or_else(|| {
                AbError::new(
                    "frame_not_found",
                    "browser.context.root_frame",
                    format!("tab {target_id} has no root frame"),
                )
            })?;
        Ok(Self {
            target_id: target_id.to_owned(),
            root_session_id,
            root_frame,
            frames,
            iframe_sessions: sessions.iframe_sessions(target_id).await,
            client: sessions.client(),
            sessions,
        })
    }
}
