use crate::error::AbError;
use ab_protocol::{Request, RequestTarget, Stage};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// Immutable correlation identity for one accepted SDK request.
#[derive(Debug, Clone)]
pub struct RequestTrace {
    request_id: String,
    trace_id: String,
    method: String,
    target: Option<RequestTarget>,
}

impl RequestTrace {
    pub fn from_request(request: &Request) -> Self {
        Self {
            request_id: request.id.clone(),
            trace_id: request.trace.trace_id.clone(),
            method: request.method.clone(),
            target: request.target.clone(),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn stage(&self, name: &str, sequence: u64, detail: Option<Value>) -> Stage {
        Stage {
            request_id: self.request_id.clone(),
            trace_id: self.trace_id.clone(),
            method: self.method.clone(),
            name: name.to_owned(),
            sequence,
            timestamp_unix_ms: now_unix_ms(),
            target: self.target.clone(),
            detail,
        }
    }

    pub fn enrich_error(&self, mut error: AbError, retryable: bool) -> AbError {
        let mut context = error.context.take().unwrap_or_default();
        context
            .request_id
            .get_or_insert_with(|| self.request_id.clone());
        context
            .trace_id
            .get_or_insert_with(|| self.trace_id.clone());
        context.method.get_or_insert_with(|| self.method.clone());
        if context.target.is_none() {
            context.target = self.target.clone();
        }
        error.context = Some(context);
        error.retryable |= retryable;
        error
    }

    pub fn interrupted_error(&self, side_effect: bool, stage: &str, message: &str) -> AbError {
        let error = if side_effect {
            AbError::new("outcome_unknown", stage, message)
        } else {
            AbError::new("cancelled", stage, message).with_retryable(true)
        };
        self.enrich_error(error, !side_effect)
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
