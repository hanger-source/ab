use crate::error::{AbError, AbResult};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDescriptor {
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub encoding: String,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
}

pub struct ArtifactStore {
    root: PathBuf,
    ttl: Duration,
    records: Mutex<HashMap<String, ArtifactRecord>>,
}

struct ArtifactRecord {
    owner_id: String,
    path: PathBuf,
    expires_at_unix_ms: u64,
}

impl ArtifactStore {
    pub fn new(root: PathBuf) -> AbResult<Self> {
        fs::create_dir_all(&root).map_err(|error| artifact_error("create_dir", error))?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|error| artifact_error("permissions", error))?;
        Ok(Self {
            root,
            ttl: Duration::from_secs(60 * 60),
            records: Mutex::new(HashMap::new()),
        })
    }

    pub fn write(
        &self,
        owner_id: &str,
        extension: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> AbResult<ArtifactDescriptor> {
        self.write_with_encoding(owner_id, extension, media_type, "binary", bytes)
    }

    pub fn write_with_encoding(
        &self,
        owner_id: &str,
        extension: &str,
        media_type: &str,
        encoding: &str,
        bytes: &[u8],
    ) -> AbResult<ArtifactDescriptor> {
        let id = Uuid::new_v4().to_string();
        let final_path = self.root.join(format!("{id}.{extension}"));
        let temporary_path = self.root.join(format!(".{id}.partial"));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary_path)
            .map_err(|error| artifact_error("open", error))?;
        file.write_all(bytes)
            .map_err(|error| artifact_error("write", error))?;
        file.sync_all()
            .map_err(|error| artifact_error("sync", error))?;
        fs::rename(&temporary_path, &final_path)
            .map_err(|error| artifact_error("commit", error))?;
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let created_at_unix_ms = now_unix_ms();
        let expires_at_unix_ms = created_at_unix_ms.saturating_add(self.ttl.as_millis() as u64);
        let descriptor = ArtifactDescriptor {
            id,
            path: final_path.to_string_lossy().into_owned(),
            sha256,
            bytes: bytes.len() as u64,
            media_type: media_type.to_owned(),
            encoding: encoding.to_owned(),
            created_at_unix_ms,
            expires_at_unix_ms,
        };
        self.records
            .lock()
            .map_err(|_| registry_poisoned())?
            .insert(
                descriptor.id.clone(),
                ArtifactRecord {
                    owner_id: owner_id.to_owned(),
                    path: final_path,
                    expires_at_unix_ms,
                },
            );
        Ok(descriptor)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn adopt(
        &self,
        owner_id: &str,
        source: &Path,
        extension: &str,
        media_type: &str,
    ) -> AbResult<ArtifactDescriptor> {
        let source =
            fs::canonicalize(source).map_err(|error| artifact_error("adopt_source", error))?;
        let root =
            fs::canonicalize(&self.root).map_err(|error| artifact_error("adopt_root", error))?;
        if source.parent() != Some(root.as_path()) {
            return Err(AbError::new(
                "artifact_path_outside_store",
                "artifact.adopt",
                "download path is outside the AB artifact store",
            ));
        }
        let bytes = fs::read(&source).map_err(|error| artifact_error("adopt_read", error))?;
        let id = Uuid::new_v4().to_string();
        let final_path = root.join(format!("{id}.{extension}"));
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600))
            .map_err(|error| artifact_error("adopt_permissions", error))?;
        fs::rename(&source, &final_path).map_err(|error| artifact_error("adopt_commit", error))?;
        let created_at_unix_ms = now_unix_ms();
        let expires_at_unix_ms = created_at_unix_ms.saturating_add(self.ttl.as_millis() as u64);
        let descriptor = ArtifactDescriptor {
            id,
            path: final_path.to_string_lossy().into_owned(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len() as u64,
            media_type: media_type.to_owned(),
            encoding: "binary".to_owned(),
            created_at_unix_ms,
            expires_at_unix_ms,
        };
        self.records
            .lock()
            .map_err(|_| registry_poisoned())?
            .insert(
                descriptor.id.clone(),
                ArtifactRecord {
                    owner_id: owner_id.to_owned(),
                    path: final_path,
                    expires_at_unix_ms,
                },
            );
        Ok(descriptor)
    }

    pub fn dispose(&self, owner_id: &str, artifact_id: &str) -> AbResult<()> {
        let record = {
            let mut records = self.records.lock().map_err(|_| registry_poisoned())?;
            let record = records.get(artifact_id).ok_or_else(|| {
                AbError::new(
                    "artifact_not_found",
                    "artifact.dispose",
                    format!("artifact {artifact_id} does not exist"),
                )
            })?;
            if record.owner_id != owner_id {
                return Err(AbError::new(
                    "resource_owner_mismatch",
                    "artifact.dispose",
                    "artifact belongs to another client",
                ));
            }
            records
                .remove(artifact_id)
                .expect("artifact existed while owner was checked")
        };
        remove_artifact_file(&record.path)
    }

    pub fn release_owner(&self, owner_id: &str) {
        let records = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let ids = records
                .iter()
                .filter(|(_, record)| record.owner_id == owner_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| records.remove(&id))
                .collect::<Vec<_>>()
        };
        for record in records {
            let _ = remove_artifact_file(&record.path);
        }
    }

    pub fn cleanup_expired(&self) {
        let now = now_unix_ms();
        let (records, retained_paths) = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let ids = records
                .iter()
                .filter(|(_, record)| record.expires_at_unix_ms <= now)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let expired = ids
                .into_iter()
                .filter_map(|id| records.remove(&id))
                .collect::<Vec<_>>();
            let retained = records
                .values()
                .map(|record| record.path.clone())
                .collect::<HashSet<_>>();
            (expired, retained)
        };
        for record in records {
            let _ = remove_artifact_file(&record.path);
        }
        self.cleanup_unregistered_files(&retained_paths);
    }

    fn cleanup_unregistered_files(&self, retained_paths: &HashSet<PathBuf>) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if retained_paths.contains(&path) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let Ok(age) = metadata.modified().and_then(|modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .map_err(std::io::Error::other)
            }) else {
                continue;
            };
            if age >= self.ttl {
                let _ = remove_artifact_file(&path);
            }
        }
    }
}

fn remove_artifact_file(path: &Path) -> AbResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(artifact_error("remove", error)),
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn registry_poisoned() -> AbError {
    AbError::new(
        "artifact_error",
        "artifact.registry",
        "artifact registry lock is poisoned",
    )
}

fn artifact_error(stage: &str, error: std::io::Error) -> AbError {
    AbError::new(
        "artifact_error",
        format!("artifact.{stage}"),
        error.to_string(),
    )
}
