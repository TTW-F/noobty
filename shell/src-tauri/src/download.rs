//! 自动接收:把中枢寄存的文件流式下载到 系统下载目录/Noobty

use futures_util::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// 清理文件名:去掉路径分隔与非法字符
fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "未命名文件".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 目标已存在时追加序号:name.ext → name (1).ext
fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
    let path = dir.join(name);
    if !path.exists() {
        return path;
    }
    let stem = PathBuf::from(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = PathBuf::from(name)
        .extension()
        .map(|s| s.to_string_lossy().to_string());
    for i in 1..10_000u32 {
        let candidate = match &ext {
            Some(e) => dir.join(format!("{stem} ({i}).{e}")),
            None => dir.join(format!("{stem} ({i})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-overflow.bin"))
}

pub async fn download_to_downloads(
    url: &str,
    name: &str,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, String> {
    let dir = dirs::download_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Noobty");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建下载目录失败:{e}"))?;

    let dest = unique_path(&dir, &sanitize_name(name));

    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("下载请求失败:{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载请求失败:{e}"))?;

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("创建文件失败:{e}"))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_sent = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断:{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败:{e}"))?;
        received += chunk.len() as u64;
        // 进度节流:每 150ms 或收尾时上报一次
        if last_sent.elapsed().as_millis() > 150 {
            let _ = on_progress.send(DownloadProgress { received, total });
            last_sent = std::time::Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("写入失败:{e}"))?;
    let _ = on_progress.send(DownloadProgress { received, total });

    Ok(dest.to_string_lossy().to_string())
}
