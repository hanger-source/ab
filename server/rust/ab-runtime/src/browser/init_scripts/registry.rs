use super::bootstrap::{build_source, instance_id};
use super::model::{
    init_script_error, init_script_not_found, invalid_binding_payload, InitScriptDefinition,
    InitScriptEvent, InitScriptInstance, InitScriptInstanceIdentity, InitScriptSubscription,
};
use crate::agent_browser_engine::cdp::client::CdpClient;
use crate::error::{AbError, AbResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

#[derive(Clone)]
struct InstalledScript {
    identifier: String,
}

struct Registration {
    root_target_id: String,
    definition: InitScriptDefinition,
    binding_name: String,
    world_name: Option<String>,
    global_key: String,
    source: String,
    installed: HashMap<String, InstalledScript>,
    instances: HashMap<String, InitScriptInstance>,
}

pub struct InitScriptRegistry {
    client: Arc<CdpClient>,
    registrations: Mutex<HashMap<String, Registration>>,
    events: broadcast::Sender<InitScriptEvent>,
}

impl InitScriptRegistry {
    pub fn new(client: Arc<CdpClient>) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        Arc::new(Self {
            client,
            registrations: Mutex::new(HashMap::new()),
            events,
        })
    }

    pub async fn register(
        &self,
        owner_id: &str,
        root_target_id: &str,
        definition: InitScriptDefinition,
    ) -> AbResult<InitScriptSubscription> {
        let definition = definition.validate()?;
        let suffix = owner_id.replace('-', "");
        let binding_name = format!("__ab_binding_{suffix}");
        let global_key = format!("__ab_init_{suffix}");
        let world_name = (definition.world == "isolated").then(|| format!("ab-init-{suffix}-v1"));
        let source = build_source(owner_id, &definition, &binding_name, &global_key)?;
        let receiver = self.events.subscribe();
        let mut registrations = self.registrations.lock().await;
        if registrations.contains_key(owner_id) {
            return Err(AbError::new(
                "resource_state_error",
                "init_script.register",
                format!("init script registration {owner_id} already exists"),
            ));
        }
        registrations.insert(
            owner_id.to_owned(),
            Registration {
                root_target_id: root_target_id.to_owned(),
                definition,
                binding_name,
                world_name,
                global_key,
                source,
                installed: HashMap::new(),
                instances: HashMap::new(),
            },
        );
        Ok(InitScriptSubscription { receiver })
    }

    pub async fn owners_for_target(&self, root_target_id: &str) -> Vec<String> {
        self.registrations
            .lock()
            .await
            .iter()
            .filter(|(_, registration)| registration.root_target_id == root_target_id)
            .map(|(owner, _)| owner.clone())
            .collect()
    }

    pub async fn install_for_session(
        &self,
        owner_id: &str,
        session_id: &str,
        evaluate_current: bool,
    ) -> AbResult<()> {
        let (binding_name, world_name, source) = {
            let registrations = self.registrations.lock().await;
            let Some(registration) = registrations.get(owner_id) else {
                return Ok(());
            };
            if registration.installed.contains_key(session_id) {
                return Ok(());
            }
            (
                registration.binding_name.clone(),
                registration.world_name.clone(),
                registration.source.clone(),
            )
        };

        if evaluate_current {
            self.validate_source(session_id, &source).await?;
        }

        let mut binding_params = json!({ "name": binding_name });
        if let Some(world_name) = world_name.as_deref() {
            binding_params["executionContextName"] = json!(world_name);
        }
        self.client
            .send_command("Runtime.addBinding", Some(binding_params), Some(session_id))
            .await
            .map_err(|message| init_script_error("binding.add", message))?;

        let mut script_params = json!({
            "source": source,
            "runImmediately": true
        });
        if let Some(world_name) = world_name.as_deref() {
            script_params["worldName"] = json!(world_name);
        }
        let result = match self
            .client
            .send_command(
                "Page.addScriptToEvaluateOnNewDocument",
                Some(script_params),
                Some(session_id),
            )
            .await
        {
            Ok(result) => result,
            Err(message) => {
                let _ = self
                    .client
                    .send_command(
                        "Runtime.removeBinding",
                        Some(json!({ "name": binding_name })),
                        Some(session_id),
                    )
                    .await;
                return Err(init_script_error("script.add", message));
            }
        };
        let identifier = result
            .get("identifier")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AbError::new(
                    "protocol_error",
                    "init_script.script.add",
                    "Page.addScriptToEvaluateOnNewDocument omitted identifier",
                )
            })?
            .to_owned();

        let mut registrations = self.registrations.lock().await;
        if let Some(registration) = registrations.get_mut(owner_id) {
            registration
                .installed
                .insert(session_id.to_owned(), InstalledScript { identifier });
            drop(registrations);
            if evaluate_current {
                self.evaluate_current_for_session(owner_id, session_id)
                    .await?;
            }
            return Ok(());
        }
        drop(registrations);
        self.remove_installation(session_id, &binding_name, &identifier)
            .await;
        Ok(())
    }

    pub async fn record_binding(
        &self,
        binding_name: &str,
        identity: InitScriptInstanceIdentity,
        payload: &str,
    ) {
        let parsed = serde_json::from_str::<Value>(payload).unwrap_or_else(invalid_binding_payload);
        let kind = parsed
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let mut registrations = self.registrations.lock().await;
        let Some((registration_id, registration)) = registrations
            .iter_mut()
            .find(|(_, registration)| registration.binding_name == binding_name)
        else {
            return;
        };
        let registration_id = registration_id.clone();
        let instance_id = instance_id(
            &registration_id,
            &identity.session_id,
            identity.execution_context_id,
        );
        let mut instance = registration
            .instances
            .get(&instance_id)
            .cloned()
            .unwrap_or_else(|| InitScriptInstance {
                id: instance_id.clone(),
                frame_id: identity.frame_id.clone(),
                document_generation: identity.document_generation.clone(),
                session_id: identity.session_id.clone(),
                execution_context_id: identity.execution_context_id,
                state: "starting".to_owned(),
                error: None,
            });

        let method = match kind {
            "ready" => {
                instance.state = "ready".to_owned();
                instance.error = None;
                "initScript.instanceReady"
            }
            "error" => {
                let message = parsed
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("init script failed")
                    .to_owned();
                instance.state = "error".to_owned();
                instance.error = Some(message);
                "initScript.instanceError"
            }
            "event" => "initScript.event",
            _ => "initScript.protocolError",
        };
        registration.instances.insert(instance_id, instance.clone());
        let registration_name = registration.definition.name.clone();
        let registration_world = registration.definition.world.clone();
        let registration_frames = registration.definition.frames.clone();
        drop(registrations);

        let mut params = json!({
            "instance": instance,
            "name": registration_name,
            "world": registration_world,
            "frames": registration_frames
        });
        if kind == "event" {
            params["event"] = parsed.get("name").cloned().unwrap_or(Value::Null);
            params["value"] = parsed.get("value").cloned().unwrap_or(Value::Null);
        }
        if kind == "error" {
            params["error"] = json!({
                "message": parsed.get("message").cloned().unwrap_or(Value::Null),
                "stack": parsed.get("stack").cloned().unwrap_or(Value::Null)
            });
        }
        let _ = self.events.send(InitScriptEvent {
            registration_id,
            method: method.to_owned(),
            params,
            session_id: identity.session_id,
        });
    }

    pub async fn instances(&self, owner_id: &str) -> AbResult<Vec<InitScriptInstance>> {
        let registrations = self.registrations.lock().await;
        let registration = registrations
            .get(owner_id)
            .ok_or_else(|| init_script_not_found(owner_id))?;
        let mut instances = registration.instances.values().cloned().collect::<Vec<_>>();
        instances.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(instances)
    }

    pub async fn command(
        &self,
        owner_id: &str,
        instance_id: &str,
        name: &str,
        payload: Value,
    ) -> AbResult<Value> {
        let (instance, global_key) = {
            let registrations = self.registrations.lock().await;
            let registration = registrations
                .get(owner_id)
                .ok_or_else(|| init_script_not_found(owner_id))?;
            let instance = registration
                .instances
                .get(instance_id)
                .filter(|instance| instance.state == "ready")
                .cloned()
                .ok_or_else(|| {
                    AbError::new(
                        "init_script_instance_not_ready",
                        "init_script.command",
                        format!("init script instance {instance_id} is not ready"),
                    )
                })?;
            (instance, registration.global_key.clone())
        };
        let expression = format!(
            "globalThis[{}].dispatch({}, {})",
            serde_json::to_string(&global_key).expect("string serializes"),
            serde_json::to_string(name).expect("string serializes"),
            serde_json::to_string(&payload).expect("JSON value serializes"),
        );
        let result = self
            .client
            .send_command(
                "Runtime.evaluate",
                Some(json!({
                    "expression": expression,
                    "contextId": instance.execution_context_id,
                    "awaitPromise": true,
                    "returnByValue": true
                })),
                Some(&instance.session_id),
            )
            .await
            .map_err(|message| init_script_error("command", message))?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(AbError::new(
                "init_script_command_error",
                "init_script.command",
                exception.to_string(),
            ));
        }
        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn context_destroyed(&self, session_id: &str, execution_context_id: Option<i64>) {
        self.close_instances(session_id, execution_context_id, "document_replaced")
            .await;
    }

    pub async fn session_detached(&self, session_id: &str) {
        {
            let mut registrations = self.registrations.lock().await;
            for registration in registrations.values_mut() {
                registration.installed.remove(session_id);
            }
        }
        self.close_instances(session_id, None, "session_detached")
            .await;
    }

    async fn close_instances(
        &self,
        session_id: &str,
        execution_context_id: Option<i64>,
        reason: &str,
    ) {
        let mut events = Vec::new();
        let mut registrations = self.registrations.lock().await;
        for (registration_id, registration) in registrations.iter_mut() {
            for instance in registration.instances.values_mut() {
                if instance.session_id != session_id
                    || execution_context_id.is_some_and(|id| instance.execution_context_id != id)
                    || instance.state == "disposed"
                {
                    continue;
                }
                instance.state = "disposed".to_owned();
                events.push(InitScriptEvent {
                    registration_id: registration_id.clone(),
                    method: "initScript.instanceDisposed".to_owned(),
                    params: json!({ "instance": instance, "reason": reason }),
                    session_id: session_id.to_owned(),
                });
            }
        }
        drop(registrations);
        for event in events {
            let _ = self.events.send(event);
        }
    }

    pub async fn unregister(&self, owner_id: &str) -> AbResult<()> {
        let registration = self
            .registrations
            .lock()
            .await
            .remove(owner_id)
            .ok_or_else(|| init_script_not_found(owner_id))?;
        for instance in registration.instances.values() {
            if instance.state != "disposed" {
                let expression = format!(
                    "globalThis[{}]?.cleanup?.()",
                    serde_json::to_string(&registration.global_key).expect("string serializes")
                );
                let _ = self
                    .client
                    .send_command(
                        "Runtime.evaluate",
                        Some(json!({
                            "expression": expression,
                            "contextId": instance.execution_context_id,
                            "awaitPromise": true,
                            "returnByValue": true
                        })),
                        Some(&instance.session_id),
                    )
                    .await;
            }
        }
        for (session_id, installed) in registration.installed {
            self.remove_installation(
                &session_id,
                &registration.binding_name,
                &installed.identifier,
            )
            .await;
        }
        Ok(())
    }

    pub async fn evaluate_current_for_session(
        &self,
        owner_id: &str,
        session_id: &str,
    ) -> AbResult<()> {
        let (world_name, source) = {
            let registrations = self.registrations.lock().await;
            let Some(registration) = registrations.get(owner_id) else {
                return Ok(());
            };
            if !registration.installed.contains_key(session_id) {
                return Err(AbError::new(
                    "resource_state_error",
                    "init_script.current",
                    format!("init script {owner_id} is not installed in session {session_id}"),
                ));
            }
            (registration.world_name.clone(), registration.source.clone())
        };
        self.evaluate_current(session_id, world_name.as_deref(), &source)
            .await
    }

    async fn remove_installation(&self, session_id: &str, binding_name: &str, identifier: &str) {
        let _ = self
            .client
            .send_command(
                "Page.removeScriptToEvaluateOnNewDocument",
                Some(json!({ "identifier": identifier })),
                Some(session_id),
            )
            .await;
        let _ = self
            .client
            .send_command(
                "Runtime.removeBinding",
                Some(json!({ "name": binding_name })),
                Some(session_id),
            )
            .await;
    }

    async fn evaluate_current(
        &self,
        session_id: &str,
        world_name: Option<&str>,
        source: &str,
    ) -> AbResult<()> {
        let context_ids = if let Some(world_name) = world_name {
            let tree = self
                .client
                .send_command_no_params("Page.getFrameTree", Some(session_id))
                .await
                .map_err(|message| init_script_error("current.frame_tree", message))?;
            let mut frame_ids = Vec::new();
            collect_frame_ids(tree.get("frameTree"), &mut frame_ids);
            if frame_ids.is_empty() {
                return Err(AbError::new(
                    "protocol_error",
                    "init_script.current.frame_tree",
                    "Page.getFrameTree returned no current frame",
                ));
            }
            let mut context_ids = Vec::with_capacity(frame_ids.len());
            for frame_id in frame_ids {
                let world = self
                    .client
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
                    .map_err(|message| init_script_error("current.world", message))?;
                let context_id = world
                    .get("executionContextId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        AbError::new(
                            "protocol_error",
                            "init_script.current.world",
                            "Page.createIsolatedWorld omitted executionContextId",
                        )
                    })?;
                context_ids.push(Some(context_id));
            }
            context_ids
        } else {
            vec![None]
        };

        for context_id in context_ids {
            let mut params = json!({
                "expression": source,
                "awaitPromise": true,
                "returnByValue": true
            });
            if let Some(context_id) = context_id {
                params["contextId"] = json!(context_id);
            }
            let result = self
                .client
                .send_command("Runtime.evaluate", Some(params), Some(session_id))
                .await
                .map_err(|message| init_script_error("current.evaluate", message))?;
            if let Some(exception) = result.get("exceptionDetails") {
                return Err(AbError::new(
                    "init_script_evaluation_error",
                    "init_script.current.evaluate",
                    exception.to_string(),
                ));
            }
        }
        Ok(())
    }

    async fn validate_source(&self, session_id: &str, source: &str) -> AbResult<()> {
        let result = self
            .client
            .send_command(
                "Runtime.compileScript",
                Some(json!({
                    "expression": source,
                    "sourceURL": "ab-init-script.js",
                    "persistScript": false
                })),
                Some(session_id),
            )
            .await
            .map_err(|message| init_script_error("source.compile", message))?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(AbError::new(
                "init_script_syntax_error",
                "init_script.source.compile",
                exception.to_string(),
            ));
        }
        Ok(())
    }
}

fn collect_frame_ids(value: Option<&Value>, output: &mut Vec<String>) {
    let Some(tree) = value else {
        return;
    };
    if let Some(frame_id) = tree.pointer("/frame/id").and_then(Value::as_str) {
        output.push(frame_id.to_owned());
    }
    for child in tree
        .get("childFrames")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_frame_ids(Some(child), output);
    }
}
