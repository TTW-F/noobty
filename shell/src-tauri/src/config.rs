//! 壳配置:中枢地址持久化于 %APPDATA%/noobty-shell/config.json

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellConfig {
    #[serde(default)]
    pub hub: String,
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

pub fn save(hub: &str) -> Result<(), String> {
    let path = config_path().ok_or("无法定位配置目录")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = ShellConfig {
        hub: hub.to_string(),
    };
    let raw = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}
