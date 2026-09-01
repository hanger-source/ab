use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::error::{AbError, AbResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct DomainLeases {
    client: Arc<CdpClient>,
    owners: Mutex<HashMap<(String, String), HashMap<String, Value>>>,
}

impl DomainLeases {
    pub fn new(client: Arc<CdpClient>) -> Self {
        Self {
            client,
            owners: Mutex::new(HashMap::new()),
        }
    }

    pub async fn acquire(&self, session_id: &str, domain: &str, owner: &str) -> AbResult<()> {
        self.acquire_with_params(session_id, domain, owner, json!({}))
            .await
    }

    /// Enable the baseline page domains for a newly attached session as one
    /// initialization batch. The session is not published to resource owners
    /// until this method completes, so these are the first leases for each key.
    ///
    /// Keeping the three CDP commands in flight together is important for an
    /// auto-attached page that is still waiting for the debugger: Runtime or
    /// Network initialization must not prevent SessionManager from sending the
    /// matching resume command. See
    /// `docs/evidence/20260902__pointer-action-transaction-and-spa-navigation__@codex.md`.
    pub async fn acquire_initial_baseline(&self, session_id: &str, owner: &str) -> AbResult<()> {
        const DOMAINS: [&str; 3] = ["Page", "Runtime", "Network"];
        {
            let mut owners = self.owners.lock().await;
            for domain in DOMAINS {
                let key = (session_id.to_owned(), domain.to_owned());
                if owners.contains_key(&key) {
                    return Err(domain_error(
                        "initialize",
                        session_id,
                        domain,
                        "initial baseline lease already exists".to_owned(),
                    ));
                }
                owners.insert(key, HashMap::from([(owner.to_owned(), json!({}))]));
            }
        }

        let empty_params = json!({});
        let (page, runtime, network) = tokio::join!(
            self.apply_configuration(session_id, "Page", &empty_params),
            self.apply_configuration(session_id, "Runtime", &empty_params),
            self.apply_configuration(session_id, "Network", &empty_params),
        );
        for (domain, result) in DOMAINS.into_iter().zip([page, runtime, network]) {
            if let Err(message) = result {
                self.forget_session(session_id).await;
                return Err(domain_error("enable", session_id, domain, message));
            }
        }
        Ok(())
    }

    pub async fn acquire_with_params(
        &self,
        session_id: &str,
        domain: &str,
        owner: &str,
        params: Value,
    ) -> AbResult<()> {
        let key = (session_id.to_owned(), domain.to_owned());
        let mut owners = self.owners.lock().await;
        let domain_owners = owners.entry(key.clone()).or_default();
        if domain_owners.get(owner) == Some(&params) {
            return Ok(());
        }
        let previous = effective_params(domain, domain_owners.values());
        let replaced = domain_owners.insert(owner.to_owned(), params);
        let next = effective_params(domain, domain_owners.values());
        if domain_owners.len() == 1 || previous != next {
            if let Err(message) = self.apply_configuration(session_id, domain, &next).await {
                match replaced {
                    Some(params) => {
                        domain_owners.insert(owner.to_owned(), params);
                    }
                    None => {
                        domain_owners.remove(owner);
                    }
                }
                if domain_owners.is_empty() {
                    owners.remove(&key);
                }
                return Err(domain_error("enable", session_id, domain, message));
            }
        }
        Ok(())
    }

    pub async fn release(&self, session_id: &str, domain: &str, owner: &str) -> AbResult<()> {
        let key = (session_id.to_owned(), domain.to_owned());
        let mut owners = self.owners.lock().await;
        let Some(domain_owners) = owners.get_mut(&key) else {
            return Ok(());
        };
        let previous = effective_params(domain, domain_owners.values());
        let Some(released) = domain_owners.remove(owner) else {
            return Ok(());
        };
        if domain_owners.is_empty() {
            if let Err(message) = self
                .client
                .send_command_no_params(&format!("{domain}.disable"), Some(session_id))
                .await
            {
                domain_owners.insert(owner.to_owned(), released);
                return Err(domain_error("disable", session_id, domain, message));
            }
            owners.remove(&key);
        } else {
            let next = effective_params(domain, domain_owners.values());
            if previous != next {
                if let Err(message) = self.apply_configuration(session_id, domain, &next).await {
                    domain_owners.insert(owner.to_owned(), released);
                    return Err(domain_error("reconfigure", session_id, domain, message));
                }
            }
        }
        Ok(())
    }

    pub async fn forget_session(&self, session_id: &str) {
        self.owners
            .lock()
            .await
            .retain(|(session, _), _| session != session_id);
    }

    async fn apply_configuration(
        &self,
        session_id: &str,
        domain: &str,
        params: &Value,
    ) -> Result<(), String> {
        let mut enable_params = params.clone();
        let durable_messages = enable_params
            .as_object_mut()
            .and_then(|value| value.remove("durableMessages"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        self.client
            .send_command(
                &format!("{domain}.enable"),
                Some(enable_params.clone()),
                Some(session_id),
            )
            .await?;
        if domain == "Network" && durable_messages {
            let max_total_buffer_size = enable_params
                .get("maxTotalBufferSize")
                .and_then(Value::as_u64)
                .ok_or_else(|| "durable Network messages require maxTotalBufferSize".to_owned())?;
            let max_resource_buffer_size = enable_params
                .get("maxResourceBufferSize")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    "durable Network messages require maxResourceBufferSize".to_owned()
                })?;
            self.client
                .send_command(
                    "Network.configureDurableMessages",
                    Some(json!({
                        "maxTotalBufferSize": max_total_buffer_size,
                        "maxResourceBufferSize": max_resource_buffer_size,
                    })),
                    Some(session_id),
                )
                .await?;
        }
        Ok(())
    }
}

fn effective_params<'a>(domain: &str, values: impl Iterator<Item = &'a Value>) -> Value {
    let mut effective = serde_json::Map::new();
    for value in values {
        let Some(params) = value.as_object() else {
            continue;
        };
        for (name, value) in params {
            match (domain, effective.get(name), value) {
                ("Network", Some(Value::Number(current)), Value::Number(candidate)) => {
                    if candidate.as_u64() > current.as_u64() {
                        effective.insert(name.clone(), value.clone());
                    }
                }
                ("Network", Some(Value::Bool(current)), Value::Bool(candidate)) => {
                    effective.insert(name.clone(), Value::Bool(*current || *candidate));
                }
                (_, None, _) => {
                    effective.insert(name.clone(), value.clone());
                }
                _ => {}
            }
        }
    }
    Value::Object(effective)
}

fn domain_error(action: &str, session_id: &str, domain: &str, message: String) -> AbError {
    AbError::new(
        "cdp_domain_error",
        format!("session.domain.{action}"),
        format!("failed to {action} {domain} on session {session_id}: {message}"),
    )
}
