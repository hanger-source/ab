use crate::agent_browser_engine::element::RefMap;
use crate::agent_browser_engine::interaction::PendingRelease;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct TargetLane {
    pub state: Arc<Mutex<TargetState>>,
}

impl TargetLane {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(TargetState::new())),
        }
    }
}

pub struct TargetState {
    pub refs: RefMap,
    pub pending_release: Option<PendingRelease>,
}

impl TargetState {
    fn new() -> Self {
        Self {
            refs: RefMap::new(),
            pending_release: None,
        }
    }
}
