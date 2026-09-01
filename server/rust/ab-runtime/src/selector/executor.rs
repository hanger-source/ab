use super::runtime::{dom_query_expression, isolated_context};
use crate::agent_browser_engine::snapshot::model_visible_text;
use crate::browser::TargetContext;
use crate::error::{AbError, AbResult};
use ab_protocol::{LocatorQuery, LocatorRequest};
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementTarget {
    pub target_id: String,
    pub session_id: String,
    pub frame_id: String,
    pub backend_node_id: i64,
    #[serde(skip)]
    pub remote_object_id: Option<String>,
    #[serde(skip)]
    pub object_group: Option<String>,
    pub document_generation: String,
    pub role: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct Scope {
    session_id: String,
    frame_id: String,
    document_generation: String,
}

#[derive(Debug)]
pub struct Resolution {
    pub count: usize,
    pub selected: Option<ElementTarget>,
}

pub struct SelectorEngine;

impl SelectorEngine {
    pub async fn resolve(
        context: &TargetContext,
        request: &LocatorRequest,
    ) -> AbResult<Resolution> {
        let frame_id = validate_query(&request.query)?;
        let scopes = scopes(context, frame_id.as_deref()).await?;
        let mut matches = Vec::new();
        for scope in scopes {
            matches.extend(resolve_query(context, &scope, &request.query).await?);
        }
        deduplicate(&mut matches);
        if let Some(visible) = request.visible {
            let mut filtered = Vec::new();
            for target in matches {
                if is_visible(context, &target).await? == visible {
                    filtered.push(target);
                }
            }
            matches = filtered;
        }
        let count = matches.len();
        if request.operation == "count" {
            return Ok(Resolution {
                count,
                selected: None,
            });
        }
        if count == 0 {
            return Err(AbError::new(
                "not_found",
                "selector.resolve",
                "locator did not match any element",
            ));
        }
        let selected_index = match request.index {
            Some(index) if index < 0 => count as i64 + index,
            Some(index) => index,
            None if count == 1 => 0,
            None => {
                let candidates = candidate_diagnostics(context, &matches).await;
                return Err(AbError::new(
                    "strict_violation",
                    "selector.strict",
                    format!("locator matched {count} elements; action requires exactly one"),
                )
                .with_details(json!({
                    "count": count,
                    "candidates": candidates,
                    "truncated": count > candidates.len(),
                })));
            }
        };
        let selected = usize::try_from(selected_index)
            .ok()
            .and_then(|index| matches.get(index).cloned())
            .ok_or_else(|| {
                AbError::new(
                    "locator_index_out_of_range",
                    "selector.index",
                    format!("locator index {selected_index} is outside {count} matches"),
                )
            })?;
        Ok(Resolution {
            count,
            selected: Some(selected),
        })
    }
}

async fn candidate_diagnostics(context: &TargetContext, matches: &[ElementTarget]) -> Vec<Value> {
    const MAX_CANDIDATES: usize = 12;
    let mut diagnostics = Vec::new();
    for (index, target) in matches.iter().take(MAX_CANDIDATES).enumerate() {
        let inspected = call_on_node_value(
            context,
            target,
            r#"function() {
              const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ');
              const style = getComputedStyle(this);
              const rect = this.getBoundingClientRect();
              const attributes = {};
              for (const attribute of Array.from(this.attributes ?? []).slice(0, 16)) {
                attributes[attribute.name] = String(attribute.value).slice(0, 160);
              }
              const tagName = String(this.tagName ?? '').toLocaleLowerCase();
              const implicitRole = tagName === 'a' && this.hasAttribute('href') ? 'link'
                : tagName === 'button' ? 'button'
                : tagName === 'select' ? 'combobox'
                : tagName === 'textarea' ? 'textbox'
                : tagName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[this.type] ?? 'textbox')
                : '';
              const text = normalize(this.innerText || this.textContent).slice(0, 240);
              return {
                tagName,
                role: normalize(this.getAttribute('role') || implicitRole),
                name: normalize(this.getAttribute('aria-label') || text).slice(0, 240),
                text,
                visible: style.visibility !== 'hidden' && style.display !== 'none'
                  && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0,
                attributes,
              };
            }"#,
            Vec::new(),
        )
        .await
        .unwrap_or_else(|error| {
            json!({
                "diagnosticError": {
                    "kind": error.kind,
                    "stage": error.stage,
                    "message": error.message,
                }
            })
        });
        let mut candidate = json!({
            "index": index,
            "frameId": target.frame_id,
            "role": target.role,
            "name": target.name,
        });
        if let (Some(output), Some(fields)) = (candidate.as_object_mut(), inspected.as_object()) {
            for (key, value) in fields {
                if (key == "role" || key == "name")
                    && value.as_str().is_some_and(str::is_empty)
                    && output
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty())
                {
                    continue;
                }
                output.insert(key.clone(), value.clone());
            }
        }
        diagnostics.push(candidate);
    }
    diagnostics
}

async fn scopes(context: &TargetContext, frame_id: Option<&str>) -> AbResult<Vec<Scope>> {
    let mut output = context
        .frames
        .iter()
        .filter(|frame| match frame_id {
            Some(frame_id) => frame.id == frame_id,
            None => frame.id == context.root_frame.id,
        })
        .cloned()
        .map(|frame| Scope {
            session_id: frame.session_id,
            frame_id: frame.id,
            document_generation: frame.document_generation,
        })
        .collect::<Vec<_>>();
    output.sort_by(|left, right| left.frame_id.cmp(&right.frame_id));
    output.dedup_by(|left, right| left.frame_id == right.frame_id);
    if output.is_empty() && frame_id.is_none() {
        output.push(Scope {
            session_id: context.root_session_id.clone(),
            frame_id: context.root_frame.id.clone(),
            document_generation: context.root_frame.document_generation.clone(),
        });
    }
    if output.is_empty() {
        return Err(AbError::new(
            "frame_not_found",
            "selector.frame_scope",
            format!(
                "frame {} does not belong to tab {}",
                frame_id.expect("empty explicit frame scope"),
                context.target_id
            ),
        ));
    }
    Ok(output)
}

fn validate_query(query: &LocatorQuery) -> AbResult<Option<String>> {
    const MAX_DEPTH: usize = 32;
    const MAX_NODES: usize = 256;

    fn visit(
        query: &LocatorQuery,
        depth: usize,
        nodes: &mut usize,
        frame_ids: &mut HashSet<String>,
    ) -> AbResult<()> {
        *nodes += 1;
        if depth > MAX_DEPTH || *nodes > MAX_NODES {
            return Err(AbError::new(
                "selector_query_limit",
                "selector.query.validate",
                format!(
                    "locator query exceeds the product limit of {MAX_DEPTH} levels or {MAX_NODES} nodes"
                ),
            ));
        }
        match query {
            LocatorQuery::And { left, right } | LocatorQuery::Or { left, right } => {
                visit(left, depth + 1, nodes, frame_ids)?;
                visit(right, depth + 1, nodes, frame_ids)?;
            }
            LocatorQuery::Descendant {
                ancestor,
                descendant,
            } => {
                visit(ancestor, depth + 1, nodes, frame_ids)?;
                visit(descendant, depth + 1, nodes, frame_ids)?;
            }
            LocatorQuery::Has { query, descendant } => {
                visit(query, depth + 1, nodes, frame_ids)?;
                visit(descendant, depth + 1, nodes, frame_ids)?;
            }
            LocatorQuery::HasText { query, .. } => {
                visit(query, depth + 1, nodes, frame_ids)?;
            }
            LocatorQuery::Frame { frame_id, query } => {
                frame_ids.insert(frame_id.clone());
                visit(query, depth + 1, nodes, frame_ids)?;
            }
            LocatorQuery::Css { .. }
            | LocatorQuery::Role { .. }
            | LocatorQuery::Text { .. }
            | LocatorQuery::Label { .. }
            | LocatorQuery::Placeholder { .. }
            | LocatorQuery::AltText { .. }
            | LocatorQuery::Title { .. }
            | LocatorQuery::TestId { .. } => {}
        }
        Ok(())
    }

    let mut nodes = 0;
    let mut frame_ids = HashSet::new();
    visit(query, 1, &mut nodes, &mut frame_ids)?;
    if frame_ids.len() > 1 {
        return Err(AbError::new(
            "cross_frame_selector",
            "selector.frame_scope",
            "one Locator query cannot compose nodes from different frames",
        ));
    }
    Ok(frame_ids.into_iter().next())
}

fn resolve_query<'a>(
    context: &'a TargetContext,
    scope: &'a Scope,
    query: &'a LocatorQuery,
) -> BoxFuture<'a, AbResult<Vec<ElementTarget>>> {
    Box::pin(async move {
        match query {
            LocatorQuery::Css { value } => resolve_dom(context, scope, "css", value, false).await,
            LocatorQuery::Role { role, name, exact } => {
                resolve_role(context, scope, role, name.as_deref(), *exact).await
            }
            LocatorQuery::Text { value, exact } => {
                resolve_dom(context, scope, "text", value, *exact).await
            }
            LocatorQuery::Label { value, exact } => {
                resolve_dom(context, scope, "label", value, *exact).await
            }
            LocatorQuery::Placeholder { value, exact } => {
                resolve_dom(context, scope, "placeholder", value, *exact).await
            }
            LocatorQuery::AltText { value, exact } => {
                resolve_dom(context, scope, "altText", value, *exact).await
            }
            LocatorQuery::Title { value, exact } => {
                resolve_dom(context, scope, "title", value, *exact).await
            }
            LocatorQuery::TestId { value, exact } => {
                resolve_dom(context, scope, "testId", value, *exact).await
            }
            LocatorQuery::And { left, right } => {
                let left = resolve_query(context, scope, left).await?;
                let right = resolve_query(context, scope, right).await?;
                Ok(intersection(left, &right))
            }
            LocatorQuery::Or { left, right } => {
                let mut output = resolve_query(context, scope, left).await?;
                output.extend(resolve_query(context, scope, right).await?);
                deduplicate(&mut output);
                Ok(output)
            }
            LocatorQuery::Descendant {
                ancestor,
                descendant,
            } => {
                let ancestors = resolve_query(context, scope, ancestor).await?;
                let descendants = resolve_query(context, scope, descendant).await?;
                filter_descendants(context, ancestors, descendants).await
            }
            LocatorQuery::Has { query, descendant } => {
                let candidates = resolve_query(context, scope, query).await?;
                let descendants = resolve_query(context, scope, descendant).await?;
                filter_has(context, candidates, &descendants).await
            }
            LocatorQuery::HasText {
                query,
                value,
                exact,
            } => {
                let candidates = resolve_query(context, scope, query).await?;
                filter_text(context, candidates, value, *exact).await
            }
            LocatorQuery::Frame { frame_id, query } => {
                if scope.frame_id == *frame_id {
                    resolve_query(context, scope, query).await
                } else {
                    Ok(Vec::new())
                }
            }
        }
    })
}

async fn resolve_dom(
    context: &TargetContext,
    scope: &Scope,
    strategy: &str,
    value: &str,
    exact: bool,
) -> AbResult<Vec<ElementTarget>> {
    let expression = dom_query_expression(strategy, value, exact)?;
    let context_id = isolated_context(
        &context.client,
        &scope.session_id,
        &scope.frame_id,
        "selector",
    )
    .await?;
    let params = json!({
        "expression": expression,
        "returnByValue": false,
        "awaitPromise": false,
        "objectGroup": "ab-selector",
        "contextId": context_id
    });
    let evaluated = context
        .client
        .send_command("Runtime.evaluate", Some(params), Some(&scope.session_id))
        .await
        .map_err(|message| selector_error("dom.evaluate", message))?;
    if let Some(exception) = evaluated.get("exceptionDetails") {
        return Err(selector_error("dom.evaluate", exception.to_string()));
    }
    let object_id = evaluated
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| selector_error("dom.evaluate", "query did not return an element array"))?;
    let properties = context
        .client
        .send_command(
            "Runtime.getProperties",
            Some(json!({ "objectId": object_id, "ownProperties": true })),
            Some(&scope.session_id),
        )
        .await
        .map_err(|message| selector_error("dom.properties", message))?;
    let mut output = Vec::new();
    for property in properties
        .get("result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if property
            .get("name")
            .and_then(Value::as_str)
            .is_none_or(|name| name.parse::<usize>().is_err())
        {
            continue;
        }
        let Some(element_object_id) = property.pointer("/value/objectId").and_then(Value::as_str)
        else {
            continue;
        };
        if let Some(target) = describe_object(context, scope, element_object_id, "", "").await? {
            output.push(target);
        }
    }
    let _ = context
        .client
        .send_command(
            "Runtime.releaseObjectGroup",
            Some(json!({ "objectGroup": "ab-selector" })),
            Some(&scope.session_id),
        )
        .await;
    Ok(output)
}

async fn resolve_role(
    context: &TargetContext,
    scope: &Scope,
    role: &str,
    name: Option<&str>,
    exact: bool,
) -> AbResult<Vec<ElementTarget>> {
    let mut params = json!({});
    if scope.session_id == context.root_session_id && scope.frame_id != context.root_frame.id {
        params["frameId"] = json!(scope.frame_id);
    }
    let tree = context
        .client
        .send_command(
            "Accessibility.getFullAXTree",
            Some(params),
            Some(&scope.session_id),
        )
        .await
        .map_err(|message| selector_error("ax.tree", message))?;
    let expected_role = normalize_role(role);
    let mut output = Vec::new();
    for node in tree
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if node
            .get("ignored")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let actual_role = node
            .pointer("/role/value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if normalize_role(actual_role) != expected_role {
            continue;
        }
        let actual_name = node
            .pointer("/name/value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches_text(actual_name, name, exact) {
            continue;
        }
        let Some(backend_node_id) = node.get("backendDOMNodeId").and_then(Value::as_i64) else {
            continue;
        };
        output.push(ElementTarget {
            target_id: context.target_id.clone(),
            session_id: scope.session_id.clone(),
            frame_id: scope.frame_id.clone(),
            backend_node_id,
            remote_object_id: None,
            object_group: None,
            document_generation: scope.document_generation.clone(),
            role: role.to_owned(),
            name: model_visible_text(actual_name),
        });
    }
    Ok(output)
}

async fn describe_object(
    context: &TargetContext,
    scope: &Scope,
    object_id: &str,
    role: &str,
    name: &str,
) -> AbResult<Option<ElementTarget>> {
    let result = context
        .client
        .send_command(
            "DOM.describeNode",
            Some(json!({ "objectId": object_id })),
            Some(&scope.session_id),
        )
        .await
        .map_err(|message| selector_error("dom.describe", message))?;
    let Some(backend_node_id) = result
        .pointer("/node/backendNodeId")
        .and_then(Value::as_i64)
    else {
        return Ok(None);
    };
    Ok(Some(ElementTarget {
        target_id: context.target_id.clone(),
        session_id: scope.session_id.clone(),
        frame_id: scope.frame_id.clone(),
        backend_node_id,
        remote_object_id: None,
        object_group: None,
        document_generation: scope.document_generation.clone(),
        role: role.to_owned(),
        name: name.to_owned(),
    }))
}

async fn filter_descendants(
    context: &TargetContext,
    ancestors: Vec<ElementTarget>,
    descendants: Vec<ElementTarget>,
) -> AbResult<Vec<ElementTarget>> {
    let mut output = Vec::new();
    for descendant in descendants {
        for ancestor in &ancestors {
            if contains(context, ancestor, &descendant).await? {
                output.push(descendant);
                break;
            }
        }
    }
    Ok(output)
}

async fn filter_has(
    context: &TargetContext,
    candidates: Vec<ElementTarget>,
    descendants: &[ElementTarget],
) -> AbResult<Vec<ElementTarget>> {
    let mut output = Vec::new();
    for candidate in candidates {
        let mut matched = false;
        for descendant in descendants {
            if candidate.backend_node_id != descendant.backend_node_id
                && contains(context, &candidate, descendant).await?
            {
                matched = true;
                break;
            }
        }
        if matched {
            output.push(candidate);
        }
    }
    Ok(output)
}

async fn contains(
    context: &TargetContext,
    ancestor: &ElementTarget,
    descendant: &ElementTarget,
) -> AbResult<bool> {
    if ancestor.session_id != descendant.session_id {
        return Ok(false);
    }
    call_with_node(
        context,
        ancestor,
        "function(id) { const other = document.querySelector(`[data-ab-node-id=\"${id}\"]`); return !!other && (this === other || this.contains(other)); }",
        vec![json!({ "value": descendant.backend_node_id.to_string() })],
        Some(descendant),
    ).await
}

async fn filter_text(
    context: &TargetContext,
    candidates: Vec<ElementTarget>,
    expected: &str,
    exact: bool,
) -> AbResult<Vec<ElementTarget>> {
    let mut output = Vec::new();
    for candidate in candidates {
        let value = call_on_node_value(
            context,
            &candidate,
            "function() { return String(this.textContent ?? '').trim().replace(/\\s+/g, ' '); }",
            Vec::new(),
        )
        .await?;
        let actual = value.as_str().unwrap_or_default();
        if matches_text(actual, Some(expected), exact) {
            output.push(candidate);
        }
    }
    Ok(output)
}

async fn is_visible(context: &TargetContext, target: &ElementTarget) -> AbResult<bool> {
    Ok(call_on_node_value(
        context,
        target,
        "function() { const s=getComputedStyle(this); const r=this.getBoundingClientRect(); return s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity)!==0 && r.width>0 && r.height>0; }",
        Vec::new(),
    ).await?.as_bool().unwrap_or(false))
}

async fn call_with_node(
    context: &TargetContext,
    target: &ElementTarget,
    function: &str,
    arguments: Vec<Value>,
    other: Option<&ElementTarget>,
) -> AbResult<bool> {
    if let Some(other) = other {
        if target.session_id != other.session_id {
            return Ok(false);
        }
        let target_object = resolve_node_object(context, target).await?;
        let other_object = resolve_node_object(context, other).await?;
        let result = context.client.send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": target_object,
                "functionDeclaration": "function(other) { return this === other || this.contains(other); }",
                "arguments": [{ "objectId": other_object }],
                "returnByValue": true
            })),
            Some(&target.session_id),
        ).await.map_err(|message| selector_error("dom.contains", message))?;
        return Ok(result
            .pointer("/result/value")
            .and_then(Value::as_bool)
            .unwrap_or(false));
    }
    Ok(call_on_node_value(context, target, function, arguments)
        .await?
        .as_bool()
        .unwrap_or(false))
}

async fn call_on_node_value(
    context: &TargetContext,
    target: &ElementTarget,
    function: &str,
    arguments: Vec<Value>,
) -> AbResult<Value> {
    let object_id = resolve_node_object(context, target).await?;
    let result = context
        .client
        .send_command(
            "Runtime.callFunctionOn",
            Some(json!({
                "objectId": object_id,
                "functionDeclaration": function,
                "arguments": arguments,
                "returnByValue": true,
                "awaitPromise": false
            })),
            Some(&target.session_id),
        )
        .await
        .map_err(|message| selector_error("dom.call", message))?;
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(selector_error("dom.call", exception.to_string()));
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

async fn resolve_node_object(context: &TargetContext, target: &ElementTarget) -> AbResult<String> {
    let result = context
        .client
        .send_command(
            "DOM.resolveNode",
            Some(json!({ "backendNodeId": target.backend_node_id, "objectGroup": "ab-selector" })),
            Some(&target.session_id),
        )
        .await
        .map_err(|message| selector_error("dom.resolve", message))?;
    result
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            selector_error(
                "dom.resolve",
                format!("backend node {} is stale", target.backend_node_id),
            )
        })
}

fn intersection(left: Vec<ElementTarget>, right: &[ElementTarget]) -> Vec<ElementTarget> {
    let keys = right.iter().map(target_key).collect::<HashSet<_>>();
    left.into_iter()
        .filter(|target| keys.contains(&target_key(target)))
        .collect()
}

fn deduplicate(values: &mut Vec<ElementTarget>) {
    let mut seen = HashSet::new();
    values.retain(|target| seen.insert(target_key(target)));
}

fn target_key(target: &ElementTarget) -> (String, i64) {
    (target.session_id.clone(), target.backend_node_id)
}

fn normalize_role(role: &str) -> String {
    match role.to_ascii_lowercase().as_str() {
        "image" => "img".to_owned(),
        "rootwebarea" => "document".to_owned(),
        role => role.to_owned(),
    }
}

fn matches_text(actual: &str, expected: Option<&str>, exact: bool) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let actual = model_visible_text(actual);
    let expected = model_visible_text(expected);
    if exact {
        actual == expected
    } else {
        actual.to_lowercase().contains(&expected.to_lowercase())
    }
}

fn selector_error(stage: &str, message: impl Into<String>) -> AbError {
    AbError::new(
        "selector_error",
        format!("selector.{stage}"),
        message.into(),
    )
}
