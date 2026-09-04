mod actions;
mod agent_browser_engine;
mod artifacts;
mod browser;
mod chrome;
mod config;
mod diagnostics;
mod elements;
mod error;
mod lock;
mod observation;
mod resources;
mod rpc;
mod selector;
mod startup;

use crate::artifacts::ArtifactStore;
use crate::browser::BrowserCore;
use crate::config::Config;
use crate::error::{AbError, AbResult};
use crate::lock::LockOutcome;
use crate::resources::ResourceRegistry;
use crate::rpc::DaemonState;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UnixListener;
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

#[tokio::main]
async fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--build-id")) {
        println!("{}", ab_protocol::BUILD_ID);
        return;
    }
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> AbResult<()> {
    let config = Config::load()?;
    let _daemon_lock = match lock::acquire(&config.lock_path)? {
        LockOutcome::Acquired(file) => file,
        LockOutcome::AlreadyRunning => return Ok(()),
    };
    let startup = startup::StartupAttempt::begin(&config)?;
    let result = run_owned(&config, &startup).await;
    if let Err(error) = &result {
        startup.failed(error);
    }
    result
}

async fn run_owned(config: &Config, startup: &startup::StartupAttempt) -> AbResult<()> {
    if config.socket_path.exists() {
        fs::remove_file(&config.socket_path).map_err(|error| {
            AbError::new(
                "filesystem_error",
                "daemon.socket.cleanup",
                format!(
                    "failed to remove stale {}: {error}",
                    config.socket_path.display()
                ),
            )
        })?;
    }

    let listener = UnixListener::bind(&config.socket_path).map_err(|error| {
        AbError::new(
            "socket_bind_failed",
            "daemon.socket.bind",
            format!("failed to bind {}: {error}", config.socket_path.display()),
        )
    })?;
    fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600)).map_err(
        |error| {
            AbError::new(
                "filesystem_error",
                "daemon.socket.permissions",
                format!(
                    "failed to set permissions on {}: {error}",
                    config.socket_path.display()
                ),
            )
        },
    )?;

    let chrome = match chrome::connect(&config.browser_provider, &config.logs_dir).await {
        Ok(chrome) => chrome,
        Err(error) => {
            append_daemon_log(config, &format!("startupError={error}"));
            startup.failed(&error);
            rpc::reject_starting_clients(&listener, &error).await;
            return Err(error);
        }
    };
    let artifacts = Arc::new(ArtifactStore::new(config.artifacts_dir.clone())?);
    artifacts.cleanup_expired();
    let artifact_cleanup = Arc::clone(&artifacts);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await;
        loop {
            interval.tick().await;
            artifact_cleanup.cleanup_expired();
        }
    });
    let browser = match BrowserCore::new(
        &chrome.ws_url,
        chrome.generation.clone(),
        Arc::clone(&artifacts),
        chrome.provider,
    )
    .await
    {
        Ok(browser) => Arc::new(browser),
        Err(error) => {
            append_daemon_log(config, &format!("startupError={error}"));
            startup.failed(&error);
            rpc::reject_starting_clients(&listener, &error).await;
            return Err(error);
        }
    };
    let (shutdown, mut shutdown_rx) = watch::channel(false);
    let mut browser_disconnected = browser.subscribe_disconnected();
    let daemon_id = Uuid::new_v4().to_string();
    startup.ready(&daemon_id)?;
    let state = Arc::new(DaemonState {
        daemon_id,
        browser_generation: chrome.generation.clone(),
        chrome_source: chrome.source.as_str(),
        chrome_pid: chrome.pid,
        resources: ResourceRegistry::new(Arc::clone(&browser), artifacts),
        browser,
        connections: AtomicUsize::new(0),
        active_clients: AtomicUsize::new(0),
        active_side_effects: AtomicUsize::new(0),
        handshake_gate: Mutex::new(()),
        shutdown,
    });

    append_daemon_log(
        config,
        &format!(
            "daemon={} browserGeneration={} chromeSource={} chromePid={:?} socket={} dataDir={} runtimeDir={}",
            state.daemon_id,
            state.browser_generation,
            state.chrome_source,
            state.chrome_pid,
            config.socket_path.display(),
            config.data_dir.display(),
            config.runtime_dir.display()
        ),
    );

    loop {
        tokio::select! {
            disconnected = browser_disconnected.changed() => {
                if disconnected.is_err() || *browser_disconnected.borrow() {
                    append_daemon_log(
                        config,
                        &format!("daemon={} browserGeneration={} browserConnection=closed handover=exit", state.daemon_id, state.browser_generation),
                    );
                    break;
                }
            }
            changed = shutdown_rx.changed() => {
                if changed.is_ok() && *shutdown_rx.borrow() {
                    append_daemon_log(config, &format!("daemon={} handover=yield", state.daemon_id));
                    break;
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|error| {
                    AbError::new(
                        "transport_error",
                        "daemon.socket.accept",
                        format!("failed to accept SDK client: {error}"),
                    )
                })?;
                let client_state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(error) = rpc::serve_client(stream, client_state).await {
                        eprintln!("client ended with error: {error}");
                    }
                });
            }
        }
    }
    drop(listener);
    match fs::remove_file(&config.socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AbError::new(
                "filesystem_error",
                "daemon.socket.handover_cleanup",
                format!("failed to remove {}: {error}", config.socket_path.display()),
            ))
        }
    }
    Ok(())
}

fn append_daemon_log(config: &Config, line: &str) {
    let path = config.logs_dir.join("daemon.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}
