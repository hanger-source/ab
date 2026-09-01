use ab_protocol::ErrorContext;
use serde::Serialize;
use serde_json::Value;

pub type AbResult<T> = Result<T, AbError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbError {
    pub kind: String,
    pub stage: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Box<ErrorContext>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<Value>>,
}

impl AbError {
    pub fn new(
        kind: impl Into<String>,
        stage: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            stage: stage.into(),
            message: message.into(),
            retryable: false,
            context: None,
            details: None,
        }
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_cdp_method(mut self, method: impl Into<String>) -> Self {
        self.context
            .get_or_insert_with(|| Box::new(ErrorContext::default()))
            .cdp_method = Some(method.into());
        self
    }

    pub fn with_cause(mut self, cause: impl Into<String>) -> Self {
        self.context
            .get_or_insert_with(|| Box::new(ErrorContext::default()))
            .cause = Some(cause.into());
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(Box::new(details));
        self
    }
}

impl std::fmt::Display for AbError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} [{}]: {}",
            self.kind, self.stage, self.message
        )
    }
}

impl std::error::Error for AbError {}
