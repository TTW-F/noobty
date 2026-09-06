//! HTTP mapping of the semantic `crate::error::Error`. This is the only
//! place that knows status codes.

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::error::Error;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Error::RangeNotSatisfiable(size) => {
                let mut resp = (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    Json(json!({ "error": format!("requested range not satisfiable for {size}-byte file") })),
                )
                    .into_response();
                resp.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}")).expect("static header value"),
                );
                resp
            }
            Error::Conflict {
                message,
                current_offset,
                fallback,
            } => {
                let mut body = json!({ "error": message });
                if let Some(offset) = current_offset {
                    body["current_offset"] = json!(offset);
                }
                if let Some(fb) = fallback {
                    body["fallback"] = json!(fb);
                }
                (StatusCode::CONFLICT, Json(body)).into_response()
            }
            other => {
                let (status, message) = match other {
                    Error::Validation(m) => (StatusCode::BAD_REQUEST, m),
                    Error::NotFound(m) => (StatusCode::NOT_FOUND, m),
                    Error::Forbidden(m) => (StatusCode::FORBIDDEN, m),
                    Error::QuotaExceeded(m) => (StatusCode::INSUFFICIENT_STORAGE, m),
                    Error::Internal(e) => {
                        tracing::error!("internal error: {e:#}");
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal server error".to_string(),
                        )
                    }
                    Error::Conflict { .. } | Error::RangeNotSatisfiable(_) => unreachable!(),
                };
                (status, Json(json!({ "error": message }))).into_response()
            }
        }
    }
}
