use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use tokio_util::io::ReaderStream;

use crate::api::acting_device;
use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn download(
    State(st): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let entry = service::transfers::file_entry(&st, &file_id).await?;
    let mut file = tokio::fs::File::open(st.blobs.file_path(&file_id))
        .await
        .map_err(|_| Error::NotFound(format!("content of file {file_id} is missing")))?;
    let size = file.metadata().await?.len();

    let disposition = content_disposition(&entry.name);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_single_range(range, size)? {
        Some((start, end)) => {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            file.seek(std::io::SeekFrom::Start(start)).await?;
            let len = end - start + 1;
            // 64 KiB stream chunks: fewer syscalls per gigabyte than the 8 KiB default.
            let body = Body::from_stream(ReaderStream::with_capacity(file.take(len), 64 * 1024));
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_LENGTH, len)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_DISPOSITION, disposition)
                .body(body)
                .map_err(Error::from)
        }
        None => {
            let body = Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024));
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_LENGTH, size)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_DISPOSITION, disposition)
                .body(body)
                .map_err(Error::from)
        }
    }
}

pub async fn meta(
    State(st): State<SharedState>,
    Path(file_id): Path<String>,
) -> Result<Json<wire::FullFileMeta>> {
    let entry = service::transfers::file_entry(&st, &file_id).await?;
    Ok(Json(wire::FullFileMeta {
        file_id: entry.id,
        name: entry.name,
        size: entry.size,
        uploaded_at: wire::ms_to_rfc3339(entry.uploaded_ms),
        expires_at: wire::ms_to_rfc3339(entry.expires_ms),
    }))
}

/// Devices are equal: any registered device may delete any stored file.
pub async fn delete_file(
    State(st): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let _device = acting_device(&st, &headers).await?;
    let existed = service::maintenance::purge_file(&st, &file_id).await?;
    if !existed {
        return Err(Error::NotFound(format!("file {file_id} not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Parse a single-range `Range` header (RFC 9110). Anything malformed or
/// unsupported (multiple ranges, foreign units) yields `Ok(None)` → serve
/// the full representation, which is RFC-legal; only a range that is
/// syntactically fine but outside the file yields 416.
fn parse_single_range(spec: Option<&str>, size: u64) -> Result<Option<(u64, u64)>> {
    let Some(spec) = spec else {
        return Ok(None);
    };
    let Some(spec) = spec.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return Ok(None);
    };
    if start_s.is_empty() {
        // suffix form: last N bytes
        let Ok(n) = end_s.trim().parse::<u64>() else {
            return Ok(None);
        };
        if n == 0 || size == 0 {
            return Err(Error::RangeNotSatisfiable(size));
        }
        let start = size.saturating_sub(n);
        return Ok(Some((start, size - 1)));
    }
    let Ok(start) = start_s.trim().parse::<u64>() else {
        return Ok(None);
    };
    let end = if end_s.trim().is_empty() {
        size.saturating_sub(1)
    } else {
        let Ok(e) = end_s.trim().parse::<u64>() else {
            return Ok(None);
        };
        e.min(size.saturating_sub(1))
    };
    if size == 0 || start >= size {
        return Err(Error::RangeNotSatisfiable(size));
    }
    if end < start {
        return Ok(None);
    }
    Ok(Some((start, end)))
}

/// Both filename forms: quoted ASCII fallback + RFC 5987 UTF-8 encoding,
/// so non-ASCII names (压缩包.zip) survive every browser.
pub fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' && c != '\r' && c != '\n' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.trim().is_empty() {
        "file".to_string()
    } else {
        fallback
    };
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

impl From<axum::http::Error> for Error {
    fn from(e: axum::http::Error) -> Self {
        Error::Internal(anyhow::anyhow!("response build: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_forms() {
        assert_eq!(
            parse_single_range(Some("bytes=0-4"), 10).unwrap(),
            Some((0, 4))
        );
        assert_eq!(
            parse_single_range(Some("bytes=5-"), 10).unwrap(),
            Some((5, 9))
        );
        assert_eq!(
            parse_single_range(Some("bytes=-3"), 10).unwrap(),
            Some((7, 9))
        );
        assert_eq!(
            parse_single_range(Some("bytes=8-99"), 10).unwrap(),
            Some((8, 9))
        );
    }

    #[test]
    fn range_out_of_bounds_is_416() {
        assert!(matches!(
            parse_single_range(Some("bytes=10-"), 10),
            Err(Error::RangeNotSatisfiable(10))
        ));
        assert!(matches!(
            parse_single_range(Some("bytes=-0"), 10),
            Err(Error::RangeNotSatisfiable(10))
        ));
        assert!(matches!(
            parse_single_range(Some("bytes=0-9"), 0),
            Err(Error::RangeNotSatisfiable(0))
        ));
    }

    #[test]
    fn malformed_ranges_serve_full_representation() {
        assert_eq!(parse_single_range(None, 10).unwrap(), None);
        assert_eq!(parse_single_range(Some("chars=1-2"), 10).unwrap(), None);
        assert_eq!(parse_single_range(Some("bytes=abc"), 10).unwrap(), None);
        assert_eq!(parse_single_range(Some("bytes=0-1,3-4"), 10).unwrap(), None);
        assert_eq!(parse_single_range(Some("bytes=9-5"), 10).unwrap(), None);
    }

    #[test]
    fn disposition_encodes_utf8_names() {
        assert_eq!(
            content_disposition("a b.zip"),
            "attachment; filename=\"a b.zip\"; filename*=UTF-8''a%20b.zip"
        );
        assert_eq!(
            content_disposition("压缩包.zip"),
            "attachment; filename=\"___.zip\"; filename*=UTF-8''%E5%8E%8B%E7%BC%A9%E5%8C%85.zip"
        );
    }
}
