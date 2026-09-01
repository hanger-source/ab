use crate::config::Config;
use crate::error::{AbError, AbResult};
use serde::Deserialize;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::time::sleep;
use uuid::Uuid;

const PROFILE_MARKER_VALUE: &str = "ab-managed-profile-v1\n";

pub struct ChromeHandle {
    pub ws_url: String,
    pub generation: String,
    pub source: ChromeSource,
    pub pid: Option<u32>,
    #[allow(dead_code)]
    child: Option<Child>,
}

#[derive(Debug, Clone, Copy)]
pub enum ChromeSource {
    Launched,
    Reattached,
}

impl ChromeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launched => "launched",
            Self::Reattached => "reattached",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionResponse {
    web_socket_debugger_url: String,
}

pub async fn ensure(config: &Config) -> AbResult<ChromeHandle> {
    if !config.chrome_path.is_file() {
        return Err(AbError::new(
            "chrome_not_found",
            "chrome.resolve",
            format!(
                "Google Chrome was not found at {}",
                config.chrome_path.display()
            ),
        ));
    }
    let marker_path = config.profile_dir.join(".ab-managed-profile");
    let generation_path = config.profile_dir.join(".ab-browser-generation");

    if let Some(ws_url) = discover_endpoint(&config.profile_dir).await {
        verify_marker(&marker_path)?;
        let generation = read_generation(&generation_path)?.ok_or_else(|| {
            AbError::new(
                "profile_identity_missing",
                "chrome.reattach",
                format!(
                    "managed Chrome is reachable but {} is missing",
                    generation_path.display()
                ),
            )
        })?;
        return Ok(ChromeHandle {
            ws_url,
            generation,
            source: ChromeSource::Reattached,
            pid: None,
            child: None,
        });
    }

    if profile_looks_in_use(&config.profile_dir) {
        return Err(AbError::new(
            "profile_in_use_unmanaged",
            "chrome.profile",
            format!(
                "{} is locked but has no reachable DevTools endpoint",
                config.profile_dir.display()
            ),
        ));
    }

    fs::write(&marker_path, PROFILE_MARKER_VALUE).map_err(|error| {
        AbError::new(
            "filesystem_error",
            "chrome.profile.marker",
            format!("failed to write {}: {error}", marker_path.display()),
        )
    })?;
    let generation = Uuid::new_v4().to_string();
    fs::write(&generation_path, format!("{generation}\n")).map_err(|error| {
        AbError::new(
            "filesystem_error",
            "chrome.profile.generation",
            format!("failed to write {}: {error}", generation_path.display()),
        )
    })?;

    let active_port_path = config.profile_dir.join("DevToolsActivePort");
    if active_port_path.exists() {
        fs::remove_file(&active_port_path).map_err(|error| {
            AbError::new(
                "filesystem_error",
                "chrome.active_port.cleanup",
                format!(
                    "failed to remove stale {}: {error}",
                    active_port_path.display()
                ),
            )
        })?;
    }

    let stderr_path = config.logs_dir.join("chrome.stderr.log");
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|error| {
            AbError::new(
                "filesystem_error",
                "chrome.stderr",
                format!("failed to open {}: {error}", stderr_path.display()),
            )
        })?;

    let mut command = Command::new(&config.chrome_path);
    if config.headless {
        command
            .arg("--headless=new")
            .arg("--window-size=1200,856")
            .arg("--hide-scrollbars");
    }
    let mut child = command
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", config.profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-default-apps")
        .arg("--disable-component-update")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| {
            AbError::new(
                "chrome_launch_failed",
                "chrome.spawn",
                format!("failed to launch {}: {error}", config.chrome_path.display()),
            )
        })?;
    let pid = child.id();

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(ws_url) = discover_endpoint(&config.profile_dir).await {
            return Ok(ChromeHandle {
                ws_url,
                generation,
                source: ChromeSource::Launched,
                pid: Some(pid),
                child: Some(child),
            });
        }

        if let Some(status) = child.try_wait().map_err(|error| {
            AbError::new(
                "chrome_launch_failed",
                "chrome.wait",
                format!("failed to inspect Chrome process {pid}: {error}"),
            )
        })? {
            return Err(AbError::new(
                "chrome_launch_failed",
                "chrome.startup",
                format!("Chrome process {pid} exited before CDP was ready: {status}"),
            )
            .with_details(json!({ "pid": pid, "stderrPath": stderr_path })));
        }

        if Instant::now() >= deadline {
            return Err(AbError::new(
                "chrome_start_timeout",
                "chrome.devtools_active_port",
                format!("Chrome process {pid} did not expose CDP within 30 seconds"),
            )
            .with_details(json!({ "pid": pid, "stderrPath": stderr_path })));
        }
        sleep(Duration::from_millis(100)).await;
    }
}

fn verify_marker(path: &Path) -> AbResult<()> {
    let marker = fs::read_to_string(path).map_err(|error| {
        AbError::new(
            "profile_identity_missing",
            "chrome.reattach",
            format!("failed to read {}: {error}", path.display()),
        )
    })?;
    if marker != PROFILE_MARKER_VALUE {
        return Err(AbError::new(
            "profile_identity_mismatch",
            "chrome.reattach",
            format!("{} is not an AB managed profile", path.display()),
        ));
    }
    Ok(())
}

fn read_generation(path: &Path) -> AbResult<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(|value| Some(value.trim().to_owned()))
        .map_err(|error| {
            AbError::new(
                "filesystem_error",
                "chrome.generation.read",
                format!("failed to read {}: {error}", path.display()),
            )
        })
}

fn profile_looks_in_use(profile_dir: &Path) -> bool {
    ["SingletonLock", "SingletonSocket", "SingletonCookie"]
        .iter()
        .any(|name| fs::symlink_metadata(profile_dir.join(name)).is_ok())
}

async fn discover_endpoint(profile_dir: &Path) -> Option<String> {
    let (port, ws_path) = read_active_port(&profile_dir.join("DevToolsActivePort"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .ok()?;
    let version = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<VersionResponse>()
        .await
        .ok()?;
    if version.web_socket_debugger_url.is_empty() {
        Some(format!("ws://127.0.0.1:{port}{ws_path}"))
    } else {
        Some(version.web_socket_debugger_url)
    }
}

fn read_active_port(path: &Path) -> Option<(u16, String)> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines();
    let port = lines.next()?.trim().parse::<u16>().ok()?;
    let ws_path = lines.next()?.trim().to_owned();
    if ws_path.starts_with('/') {
        Some((port, ws_path))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::read_active_port;
    use std::fs;

    #[test]
    fn reads_chrome_active_port_shape() {
        let path =
            std::env::temp_dir().join(format!("ab-active-port-test-{}", uuid::Uuid::new_v4()));
        fs::write(&path, "9222\n/devtools/browser/example\n").unwrap();
        assert_eq!(
            read_active_port(&path),
            Some((9222, "/devtools/browser/example".to_owned()))
        );
        let _ = fs::remove_file(path);
    }
}
