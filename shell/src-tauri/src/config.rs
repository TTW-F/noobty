//! 壳配置:中枢地址、自动接收、接收目录 — %APPDATA%/noobty-shell/config.json

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    #[serde(default)]
    pub hub: String,
    /// 收到文件时是否自动落到接收目录。默认开启。
    #[serde(default = "default_true")]
    pub auto_accept: bool,
    /// 自定义接收目录。空 = 系统「下载/Noobty」。
    #[serde(default)]
    pub download_dir: String,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            hub: String::new(),
            auto_accept: true,
            download_dir: String::new(),
        }
    }
}

pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("noobty-shell").join("config.json"))
}

pub fn load() -> ShellConfig {
    let Some(path) = config_path() else {
        return ShellConfig::default();
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ShellConfig::default(),
    }
}

fn write(cfg: &ShellConfig) -> Result<(), String> {
    let path = config_path().ok_or("无法定位配置目录")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

pub fn save_hub(hub: &str) -> Result<(), String> {
    let mut cfg = load();
    cfg.hub = hub.to_string();
    write(&cfg)
}

pub fn save_auto_accept(auto_accept: bool) -> Result<(), String> {
    let mut cfg = load();
    cfg.auto_accept = auto_accept;
    write(&cfg)
}

pub fn save_download_dir(download_dir: &str) -> Result<(), String> {
    let mut cfg = load();
    cfg.download_dir = download_dir.to_string();
    write(&cfg)
}

/// 解析实际落盘目录:自定义路径优先,否则「下载/Noobty」。
pub fn resolve_download_dir(configured: &str) -> PathBuf {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        return PathBuf::from(trimmed);
    }
    dirs::download_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Noobty")
}
