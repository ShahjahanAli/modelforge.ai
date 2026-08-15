export type ApiErrorType =
  | "invalid_request"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_exceeded"
  | "quota_exceeded"
  | "model_not_found"
  | "model_unavailable"
  | "server_error"
  | "timeout";

export class ApiError extends Error {
  constructor(
    public readonly type: ApiErrorType,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.retryAfter !== undefined ? { retry_after: this.retryAfter } : {}),
      },
    };
  }
}

export function mapEngineError(code: string, message: string): ApiError {
  switch (code) {
    case "MODEL_NOT_FOUND":
      return new ApiError("model_not_found", message || "Model not found", 404);
    case "MODEL_UNAVAILABLE":
    case "OOM":
    case "LOAD_FAILED":
      return new ApiError(
        "model_unavailable",
        message || "Model temporarily unavailable",
        503,
        30,
      );
    case "DEADLINE_EXCEEDED":
      return new ApiError("timeout", message || "Inference timed out", 504);
    case "INVALID_ARGUMENT":
      return new ApiError("invalid_request", message || "Invalid request", 400);
    default:
      return new ApiError("server_error", message || "Internal server error", 500);
  }
}
