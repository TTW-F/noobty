use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use crate::api::acting_device;
use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;
use crate::wire;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<u32>,
    /// Cursor: return files strictly older than this file_id (newest-first paging).
    pub before: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadQuery {
    /// `1` / `true` → `Content-Disposition: inline` + image Content-Type for `<img>`.
    pub inline: Option<String>,
}

/// File warehouse: every committed blob on the hub (newest first).
pub async fn list(
    State(st): State<SharedState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<wire::StoredFileList>> {
    let entries = service::transfers::list_files(&st, q.limit, q.before).await?;
    Ok(Json(wire::StoredFileList {
        files: entries
            .into_iter()
            .map(|e| wire::StoredFileListItem {
                file_id: e.id,
                name: e.name,
                size: e.size,
                device_id: e.device_id,
                uploaded_at: wire::ms_to_rfc3339(e.uploaded_ms),
                expires_at: wire::ms_to_rfc3339(e.expires_ms),
            })
            .collect(),
    }))
}

pub async fn download(
    State(st): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Result<Response> {
    let entry = service::transfers::file_entry(&st, &file_id).await?;
    let mut file = tokio::fs::File::open(st.blobs.file_path(&file_id))
        .await
        .map_err(|_| Error::NotFound(format!("content of file {file_id} is missing")))?;
    let size = file.metadata().await?.len();

    let inline = q
        .inline
        .as_deref()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let disposition = if inline {
        content_disposition_inline(&entry.name)
    } else {
        content_disposition(&entry.name)
    };
    let content_type = if inline {
        image_content_type(&entry.name).unwrap_or("application/octet-stream")
    } else {
        "application/octet-stream"
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_single_range(range, size)? {
        Some((start, end)) => {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            file.seek(std::io::SeekFrom::Start(start)).await?;
            let len = end - start + 1;
            // 256 KiB stream chunks: align with upload/relay BufWriter; fewer syscalls per GiB.
            let body = Body::from_stream(ReaderStream::with_capacity(file.take(len), 256 * 1024));
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, len)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_DISPOSITION, disposition)
                .body(body)
                .map_err(Error::from)
        }
        None => {
            let body = Body::from_stream(ReaderStream::with_capacity(file, 256 * 1024));
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
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
    disposition_with_type("attachment", name)
}

fn content_disposition_inline(name: &str) -> String {
    disposition_with_type("inline", name)
}

fn disposition_with_type(kind: &str, name: &str) -> String {
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
    format!("{kind}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

fn image_content_type(name: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    })
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
