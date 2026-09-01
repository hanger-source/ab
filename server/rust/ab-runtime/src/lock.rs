use crate::error::{AbError, AbResult};
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::path::Path;

pub enum LockOutcome {
    Acquired(File),
    AlreadyRunning,
}

pub fn acquire(path: &Path) -> AbResult<LockOutcome> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            AbError::new(
                "filesystem_error",
                "daemon.lock.open",
                format!("failed to open {}: {error}", path.display()),
            )
        })?;

    match file.try_lock_exclusive() {
        Ok(()) => Ok(LockOutcome::Acquired(file)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Ok(LockOutcome::AlreadyRunning)
        }
        Err(error) => Err(AbError::new(
            "daemon_lock_failed",
            "daemon.lock.acquire",
            format!("failed to lock {}: {error}", path.display()),
        )),
    }
}
