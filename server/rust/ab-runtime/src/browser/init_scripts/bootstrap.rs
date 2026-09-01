use super::model::{init_script_error, InitScriptDefinition};
use crate::error::AbResult;

pub(super) fn build_source(
    registration_id: &str,
    definition: &InitScriptDefinition,
    binding_name: &str,
    global_key: &str,
) -> AbResult<String> {
    let registration = serde_json::to_string(registration_id)
        .map_err(|error| init_script_error("source", error.to_string()))?;
    let binding = serde_json::to_string(binding_name)
        .map_err(|error| init_script_error("source", error.to_string()))?;
    let key = serde_json::to_string(global_key)
        .map_err(|error| init_script_error("source", error.to_string()))?;
    let args = serde_json::to_string(&definition.args)
        .map_err(|error| init_script_error("source", error.to_string()))?;
    let top_only = definition.frames == "top";
    let mut output = format!(
        r#"(() => {{
  if ({top_only} && globalThis !== globalThis.top) return;
  const __registration = {registration};
  const __bindingName = {binding};
  const __key = {key};
  if (globalThis[__key]) return;
  const __binding = globalThis[__bindingName];
  if (typeof __binding !== "function") throw new Error(`AB init binding ${{__bindingName}} is unavailable`);
  const __send = (kind, value = {{}}) => __binding(JSON.stringify({{ kind, ...value }}));
  const __state = {{
    commandHandler: null,
    cleanupHandlers: [],
    async dispatch(name, value) {{
      if (typeof this.commandHandler !== "function") throw new Error(`AB init script ${{__registration}} has no command handler`);
      return await this.commandHandler(name, value);
    }},
    async cleanup() {{
      const handlers = this.cleanupHandlers.splice(0).reverse();
      for (const handler of handlers) await handler();
    }}
  }};
  Object.defineProperty(globalThis, __key, {{ value: __state, configurable: true }});
  const ab = Object.freeze({{
    emit(name, value = null) {{ __send("event", {{ name, value }}); }},
    onCommand(handler) {{
      if (typeof handler !== "function") throw new TypeError("ab.onCommand requires a function");
      __state.commandHandler = handler;
    }},
    onCleanup(handler) {{
      if (typeof handler !== "function") throw new TypeError("ab.onCleanup requires a function");
      __state.cleanupHandlers.push(handler);
    }}
  }});
  const args = {args};
  const __run = async (ab, args) => {{
"#,
    );
    output.push_str(&definition.source);
    output.push_str(
        r#"
  };
  Promise.resolve(__run(ab, args)).then(
    () => __send("ready"),
    error => __send("error", {
      message: String(error?.message ?? error),
      stack: typeof error?.stack === "string" ? error.stack : null
    })
  );
})()
//# sourceURL=ab-init-script.js"#,
    );
    Ok(output)
}

pub(super) fn instance_id(
    registration_id: &str,
    session_id: &str,
    execution_context_id: i64,
) -> String {
    format!("{registration_id}:{session_id}:{execution_context_id}")
}
