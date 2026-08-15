use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("model not found: {0}")]
    ModelNotFound(String),
    #[error("model unavailable: {0}")]
    ModelUnavailable(String),
    #[error("out of memory: {0}")]
    Oom(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("deadline exceeded")]
    DeadlineExceeded,
    #[error("internal: {0}")]
    Internal(String),
}

impl EngineError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ModelNotFound(_) => "MODEL_NOT_FOUND",
            Self::ModelUnavailable(_) => "MODEL_UNAVAILABLE",
            Self::Oom(_) => "OOM",
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::Internal(_) => "INTERNAL",
        }
    }
}
