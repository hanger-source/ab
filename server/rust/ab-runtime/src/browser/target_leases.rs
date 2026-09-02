use crate::error::{AbError, AbResult};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use tokio::sync::Mutex;

/// Client ownership of mutable page targets inside the one shared persistent
/// Chrome. This is deliberately separate from target/session discovery: every
/// client may discover and observe a tab, but only its lease holder may mutate
/// or close it.
///
/// Design evidence:
/// `docs/evidence/20260902__client-target-ownership-and-popup-expectation__@codex.md`.
#[derive(Default)]
pub struct TargetLeases {
    owners: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetOwnership {
    Available,
    Owned,
    Other,
}

impl TargetLeases {
    pub async fn acquire(&self, client_id: &str, target_id: &str) -> AbResult<()> {
        let mut owners = self.owners.lock().await;
        match owners.get(target_id) {
            Some(owner) if owner == client_id => Ok(()),
            Some(owner) => Err(lease_conflict(target_id, owner)),
            None => {
                owners.insert(target_id.to_owned(), client_id.to_owned());
                eprintln!(
                    "[ab.target] lease=acquired client_id={} target_id={}",
                    client_id, target_id
                );
                Ok(())
            }
        }
    }

    pub async fn require(&self, client_id: &str, target_id: &str) -> AbResult<()> {
        let owners = self.owners.lock().await;
        match owners.get(target_id) {
            Some(owner) if owner == client_id => Ok(()),
            Some(owner) => Err(lease_conflict(target_id, owner)),
            None => Err(AbError::new(
                "target_not_acquired",
                "target.lease.require",
                format!(
                    "tab {target_id} is available but has not been acquired by this client; call browser.tabs.acquire(targetId) before mutating it"
                ),
            )
            .with_details(json!({
                "targetId": target_id,
                "ownership": "available"
            }))),
        }
    }

    pub async fn ownership(&self, client_id: &str, target_id: &str) -> TargetOwnership {
        match self.owners.lock().await.get(target_id) {
            Some(owner) if owner == client_id => TargetOwnership::Owned,
            Some(_) => TargetOwnership::Other,
            None => TargetOwnership::Available,
        }
    }

    pub async fn inherit(&self, opener_id: &str, target_id: &str) {
        let mut owners = self.owners.lock().await;
        if owners.contains_key(target_id) {
            return;
        }
        let Some(owner) = owners.get(opener_id).cloned() else {
            return;
        };
        owners.insert(target_id.to_owned(), owner.clone());
        eprintln!(
            "[ab.target] lease=inherited client_id={} target_id={} opener_id={}",
            owner, target_id, opener_id
        );
    }

    pub async fn target_closed(&self, target_id: &str) {
        if let Some(owner) = self.owners.lock().await.remove(target_id) {
            eprintln!(
                "[ab.target] lease=closed client_id={} target_id={}",
                owner, target_id
            );
        }
    }

    pub async fn release_client(&self, client_id: &str) {
        let mut owners = self.owners.lock().await;
        let targets = owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == client_id)
            .map(|(target_id, _)| target_id.clone())
            .collect::<Vec<_>>();
        for target_id in targets {
            owners.remove(&target_id);
            eprintln!(
                "[ab.target] lease=released client_id={} target_id={} reason=client_disconnected",
                client_id, target_id
            );
        }
    }
}

fn lease_conflict(target_id: &str, owner: &str) -> AbError {
    AbError::new(
        "target_in_use",
        "target.lease.acquire",
        format!("tab {target_id} is owned by another active client"),
    )
    .with_details(json!({
        "targetId": target_id,
        "ownership": "other",
        "ownerClientId": owner
    }))
}
