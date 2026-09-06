//! Noobty 托盘壳:常驻托盘,内嵌中枢网页 UI,提供通知与自动接收

mod config;
mod download;

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// 壳运行状态(供托盘菜单与命令共享)
struct ShellState {
    hub: Mutex<String>,
    auto_accept: AtomicBool,
}

#[derive(Clone, Serialize)]
struct HubInfo {
    hub: String,
}

#[tauri::command]
fn hub_url(state: tauri::State<ShellState>) -> HubInfo {
    HubInfo {
        hub: state.hub.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn set_hub_url(state: tauri::State<ShellState>, url: String) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("地址必须以 http:// 或 https:// 开头".into());
    }
    config::save(&url)?;
    *state.hub.lock().unwrap() = url;
    Ok(())
}

#[tauri::command]
fn auto_accept(state: tauri::State<ShellState>) -> bool {
    let v = state.auto_accept.load(Ordering::Relaxed);
    eprintln!("[shell] invoke auto_accept -> {v}");
    v
}

#[tauri::command]
async fn download_to(
    url: String,
    name: String,
    on_progress: tauri::ipc::Channel<download::DownloadProgress>,
) -> Result<String, String> {
    eprintln!("[shell] invoke download_to name={name}");
    let result = download::download_to_downloads(&url, &name, on_progress).await;
    match &result {
        Ok(path) => eprintln!("[shell] download_to ok -> {path}"),
        Err(e) => eprintln!("[shell] download_to ERR {e}"),
    }
    result
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn run() {
    let cfg = config::load();
    let initial_hub = cfg.hub;

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ShellState {
            hub: Mutex::new(initial_hub),
            auto_accept: AtomicBool::new(true),
        })
        .invoke_handler(tauri::generate_handler![
            hub_url,
            set_hub_url,
            auto_accept,
            download_to
        ])
        .setup(move |app| {
            // 主窗口:已配置中枢则直接内嵌,否则进首启配置页
            let hub = app.state::<ShellState>().hub.lock().unwrap().clone();
            let url = if hub.is_empty() {
                WebviewUrl::App("index.html".into())
            } else {
                WebviewUrl::External(
                    hub.parse()
                        .map_err(|e| format!("中枢地址无效:{e}"))?,
                )
            };
            let win = WebviewWindowBuilder::new(app, "main", url)
                .title("Noobty")
                .inner_size(1120.0, 740.0)
                .min_inner_size(960.0, 620.0)
                .build()?;

            // 托盘:左键单击唤出主窗口
            let open = MenuItem::with_id(app, "open", "打开 Noobty", true, None::<&str>)?;
            let auto_item =
                CheckMenuItem::with_id(app, "auto_accept", "自动接收文件到下载目录", true, true, None::<&str>)?;
            let launch_item = {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                CheckMenuItem::with_id(app, "autostart", "开机自启", true, enabled, None::<&str>)?
            };
            let quit = MenuItem::with_id(app, "quit", "退出 Noobty", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &auto_item, &launch_item, &quit])?;

            TrayIconBuilder::with_id("noobty-tray")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .tooltip("Noobty — 局域网传输中枢")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    "auto_accept" => {
                        let state = app.state::<ShellState>();
                        let next = !state.auto_accept.load(Ordering::Relaxed);
                        state.auto_accept.store(next, Ordering::Relaxed);
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        let enabled = manager.is_enabled().unwrap_or(false);
                        if enabled {
                            let _ = manager.disable();
                        } else {
                            let _ = manager.enable();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // 关窗收进托盘,不退出
            let win_for_close = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_for_close.hide();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Noobty 托盘壳启动失败");
}
