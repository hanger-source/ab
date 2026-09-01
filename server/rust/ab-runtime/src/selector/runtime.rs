use crate::browser::isolated_world;
use crate::error::{AbError, AbResult};

pub(super) use isolated_world::create as isolated_context;

pub(super) fn dom_query_expression(strategy: &str, value: &str, exact: bool) -> AbResult<String> {
    let value = serde_json::to_string(value)
        .map_err(|error| runtime_error("query.encode", error.to_string()))?;
    let candidate = match strategy {
        "css" => format!("queryAll({value})"),
        "text" => "queryAll('*').filter(el => el.children.length === 0 && matches(el.textContent))".to_owned(),
        "label" => "(() => { const out=[]; for (const label of queryAll('label')) { if (!matches(label.textContent)) continue; const el=label.control||label.querySelector('input,select,textarea,button'); if (el) out.push(el); } for (const el of queryAll('[aria-label]')) if (matches(el.getAttribute('aria-label'))) out.push(el); for (const el of queryAll('[aria-labelledby]')) { const text=el.getAttribute('aria-labelledby').split(/\\s+/).map(id=>byId(id)?.textContent||'').join(' '); if (matches(text)) out.push(el); } return out; })()".to_owned(),
        "placeholder" => "queryAll('input[placeholder],textarea[placeholder]').filter(el => matches(el.getAttribute('placeholder')))".to_owned(),
        "altText" => "queryAll('[alt]').filter(el => matches(el.getAttribute('alt')))".to_owned(),
        "title" => "queryAll('[title]').filter(el => matches(el.getAttribute('title')))".to_owned(),
        "testId" => "queryAll('[data-testid]').filter(el => matches(el.getAttribute('data-testid')))".to_owned(),
        other => {
            return Err(runtime_error(
                "query.strategy",
                format!("unsupported selector strategy {other}"),
            ))
        }
    };
    Ok(format!(
        "(() => {{ const roots=[document]; for(let i=0;i<roots.length;i++) for(const el of roots[i].querySelectorAll('*')) if(el.shadowRoot) roots.push(el.shadowRoot); const queryAll=s=>roots.flatMap(root=>Array.from(root.querySelectorAll(s))); const byId=id=>{{ for(const root of roots) {{ const value=root.getElementById?.(id); if(value) return value; }} }}; const normalize=v=>String(v??'').replace(/[\\uE000-\\uF8FF\\u{{F0000}}-\\u{{FFFFD}}\\u{{100000}}-\\u{{10FFFD}}]/gu,' ').replace(/[\\uFEFF\\u200B-\\u200D\\u2060]/g,'').trim().replace(/\\s+/g,' '); const expected=normalize({value}); const matches=v=>{}; return Array.from(new Set({candidate})); }})()",
        if exact { "normalize(v)===expected" } else { "normalize(v).toLocaleLowerCase().includes(expected.toLocaleLowerCase())" }
    ))
}

fn runtime_error(stage: &str, message: impl Into<String>) -> AbError {
    AbError::new(
        "selector_error",
        format!("selector.{stage}"),
        message.into(),
    )
}
