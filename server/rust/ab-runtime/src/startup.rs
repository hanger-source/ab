use crate::config::Config;
use crate::error::{AbError, AbResult};
use serde::Serialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct StartupAttempt {
    id: String,
    path: PathBuf,
    started_at_unix_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupState<'a> {
    startup_id: &'a str,
    state: &'a str,
    started_at_unix_ms: u128,
    updated_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a AbError>,
}

impl StartupAttempt {
    pub fn begin(config: &Config) -> AbResult<Self> {
        let attempt = Self {
            id: Uuid::new_v4().to_string(),
            path: config.startup_path.clone(),
            started_at_unix_ms: now_unix_ms(),
        };
        attempt.write("starting", None, None)?;
        Ok(attempt)
    }

    pub fn ready(&self, daemon_id: &str) -> AbResult<()> {
        self.write("ready", Some(daemon_id), None)
    }

    pub fn failed(&self, error: &AbError) {
        if let Err(write_error) = self.write("failed", None, Some(error)) {
            eprintln!("failed to persist AB startup error: {write_error}");
        }
    }

    fn write(&self, state: &str, daemon_id: Option<&str>, error: Option<&AbError>) -> AbResult<()> {
        let bytes = serde_json::to_vec(&StartupState {
            startup_id: &self.id,
            state,
            started_at_unix_ms: self.started_at_unix_ms,
            updated_at_unix_ms: now_unix_ms(),
            daemon_id,
            error,
        })
        .map_err(|cause| startup_error("serialize", &self.path, cause))?;
        let temporary = self.path.with_extension(format!("{}.tmp", self.id));
        fs::write(&temporary, bytes).map_err(|cause| startup_error("write", &temporary, cause))?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|cause| startup_error("permissions", &temporary, cause))?;
        fs::rename(&temporary, &self.path)
            .map_err(|cause| startup_error("publish", &self.path, cause))?;
        Ok(())
    }
}

fn startup_error(stage: &str, path: &Path, cause: impl std::fmt::Display) -> AbError {
    AbError::new(
        "startup_state_error",
        format!("daemon.startup.{stage}"),
        format!("failed to publish {}: {cause}", path.display()),
    )
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
