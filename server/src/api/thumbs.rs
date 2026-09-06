//! On-demand image thumbnails for the file warehouse and chat previews.
//! Cached under `{storage}/thumbs/{file_id}.jpg`. Skips huge sources to protect
//! hub RAM (decode runs in `spawn_blocking`).

use std::io::Cursor;
use std::path::Path;

use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader};

use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;

const THUMB_EDGE: u32 = 96;
/// Sources larger than this are not decoded (clients fall back to icons).
const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

fn is_raster_image(name: &str) -> bool {
    let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
    )
}

fn render_thumb_jpeg(src: &Path) -> std::result::Result<Vec<u8>, String> {
    let reader = ImageReader::open(src)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let img = reader.decode().map_err(|e| e.to_string())?;
    let thumb = img.resize(THUMB_EDGE, THUMB_EDGE, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    thumb
        .write_to(&mut out, ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// GET /api/files/{file_id}/thumb → small JPEG (or 404 when not an image / too large).
pub async fn thumb(
    State(st): State<SharedState>,
    AxumPath(file_id): AxumPath<String>,
) -> Result<Response> {
    let entry = service::transfers::file_entry(&st, &file_id).await?;
    if !is_raster_image(&entry.name) {
        return Err(Error::NotFound("not an image".into()));
    }
    if entry.size == 0 || entry.size > MAX_SOURCE_BYTES {
        return Err(Error::NotFound("image too large for thumbnail".into()));
    }

    let src = st.blobs.file_path(&file_id);
    let dest = st.blobs.thumb_path(&file_id);

    if !tokio::fs::try_exists(&dest).await.unwrap_or(false) {
        let src_c = src.clone();
        let dest_c = dest.clone();
        let jpeg = tokio::task::spawn_blocking(move || {
            let bytes = render_thumb_jpeg(&src_c)?;
            std::fs::write(&dest_c, &bytes).map_err(|e| e.to_string())?;
            Ok::<Vec<u8>, String>(bytes)
        })
        .await
        .map_err(|e| Error::Internal(anyhow::anyhow!("thumb join: {e}")))?
        .map_err(|e| Error::Internal(anyhow::anyhow!("thumb: {e}")))?;
        return jpeg_response(jpeg);
    }

    let bytes = tokio::fs::read(&dest)
        .await
        .map_err(|e| Error::Internal(e.into()))?;
    jpeg_response(bytes)
}

fn jpeg_response(bytes: Vec<u8>) -> Result<Response> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "public, max-age=604800, immutable")
        .body(Body::from(bytes))
        .map_err(Error::from)
}
