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
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// 壳运行状态(供托盘菜单与命令共享)
struct ShellState {
    hub: Mutex<String>,
    auto_accept: AtomicBool,
    /// 自定义接收目录;空字符串 = 使用「下载/Noobty」
    download_dir: Mutex<String>,
}

#[derive(Clone, Serialize)]
struct HubInfo {
    hub: String,
}

#[derive(Clone, Serialize)]
struct DownloadDirInfo {
    /// 配置中的路径(空 = 默认)
    configured: String,
    /// 实际落盘目录
    resolved: String,
    /// 是否为用户自定义(非默认)
    is_custom: bool,
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
    let lower = url.to_ascii_lowercase();
    if lower.contains("://localhost") || lower.contains("://127.0.0.1") || lower.contains("://[::1]")
    {
        return Err(
            "不要填 localhost：壳和中枢不在同一台机器时会连不上。请填中枢的局域网地址，例如 http://192.168.31.35:7317"
                .into(),
        );
    }
    config::save_hub(&url)?;
    *state.hub.lock().unwrap() = url;
    Ok(())
}

#[tauri::command]
fn auto_accept(state: tauri::State<ShellState>) -> bool {
    state.auto_accept.load(Ordering::Relaxed)
}

#[tauri::command]
fn download_dir(state: tauri::State<ShellState>) -> DownloadDirInfo {
    let configured = state.download_dir.lock().unwrap().clone();
    let resolved = config::resolve_download_dir(&configured);
    DownloadDirInfo {
        is_custom: !configured.trim().is_empty(),
        configured,
        resolved: resolved.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn set_download_dir(state: tauri::State<ShellState>, path: String) -> Result<DownloadDirInfo, String> {
    let path = path.trim().to_string();
    if !path.is_empty() {
        let p = std::path::Path::new(&path);
        if p.exists() && !p.is_dir() {
            return Err("路径已存在且不是文件夹".into());
        }
        std::fs::create_dir_all(p).map_err(|e| format!("无法创建目录:{e}"))?;
    }
    config::save_download_dir(&path)?;
    *state.download_dir.lock().unwrap() = path.clone();
    let resolved = config::resolve_download_dir(&path);
    Ok(DownloadDirInfo {
        is_custom: !path.is_empty(),
        configured: path,
        resolved: resolved.to_string_lossy().to_string(),
    })
}

/// 弹出系统文件夹选择框;取消则返回当前配置不变。
#[tauri::command]
fn pick_download_dir(state: tauri::State<ShellState>) -> Result<DownloadDirInfo, String> {
    let current = state.download_dir.lock().unwrap().clone();
    let start = config::resolve_download_dir(&current);
    let picked = rfd::FileDialog::new()
        .set_title("选择 Noobty 接收目录")
        .set_directory(&start)
        .pick_folder();
    match picked {
        Some(path) => set_download_dir(state, path.to_string_lossy().to_string()),
        None => Ok(download_dir(state)),
    }
}

/// 系统通知:走 Rust 插件,远程中枢页只需 invoke,不依赖 `__TAURI__.notification` JS 形态。
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// 导航到已配置的中枢(首启页「连接」或托盘换址后使用)。
#[tauri::command]
fn open_hub(app: tauri::AppHandle, state: tauri::State<ShellState>) -> Result<(), String> {
    let hub = state.hub.lock().unwrap().clone();
    if hub.is_empty() {
        return Err("尚未配置中枢地址".into());
    }
    let url: tauri::Url = hub
        .parse()
        .map_err(|e| format!("中枢地址无效:{e}"))?;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    win.navigate(url).map_err(|e| e.to_string())?;
    show_main(&app);
    Ok(())
}

/// 把相对路径拼到已配置的中枢上;已是绝对 URL 则原样返回。
fn resolve_download_url(hub: &str, url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(url.to_string());
    }
    if hub.is_empty() {
        return Err("未配置中枢地址,无法下载".into());
    }
    let path = if url.starts_with('/') {
        url.to_string()
    } else {
        format!("/{url}")
    };
    Ok(format!("{}{path}", hub.trim_end_matches('/')))
}

#[tauri::command]
async fn download_to(
    state: tauri::State<'_, ShellState>,
    url: String,
    name: String,
    on_progress: Option<tauri::ipc::Channel<download::DownloadProgress>>,
) -> Result<String, String> {
    let hub = state.hub.lock().unwrap().clone();
    let dir_cfg = state.download_dir.lock().unwrap().clone();
    let dir = config::resolve_download_dir(&dir_cfg);
    let absolute = resolve_download_url(&hub, &url)?;
    eprintln!(
        "[shell] invoke download_to name={name} url={absolute} dir={}",
        dir.display()
    );
    let result = download::download_to_dir(&absolute, &name, &dir, on_progress).await;
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

fn notify_tray(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 用当前中枢地址拉 latest.json;有更新则被动安装(Windows 会先退出本进程)。
async fn check_and_install_update(app: tauri::AppHandle) -> Result<String, String> {
    let hub = {
        let state = app.state::<ShellState>();
        let hub = state.hub.lock().unwrap().clone();
        hub
    };
    if hub.trim().is_empty() {
        return Err("尚未配置中枢地址".into());
    }
    let endpoint = format!(
        "{}/releases/shell/latest.json",
        hub.trim().trim_end_matches('/')
    );
    let endpoint_url: url::Url = endpoint
        .parse()
        .map_err(|e| format!("更新地址无效:{e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint_url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(format!("已是最新版本 ({})", env!("CARGO_PKG_VERSION")));
    };

    let notes = update.body.clone().unwrap_or_default();
    notify_tray(
        &app,
        &format!("正在更新到 {}", update.version),
        if notes.is_empty() {
            "下载并安装中…"
        } else {
            notes.as_str()
        },
    );

    update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await
        .map_err(|e: tauri_plugin_updater::Error| e.to_string())?;
    Ok(format!("已安装 {}，请重新打开 Noobty", update.version))
}

fn open_hub_setup(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // Windows WebView2 的 App 资源源是 http://tauri.localhost(非 WebviewUrl)
        if let Ok(url) = "http://tauri.localhost/index.html".parse() {
            let _ = win.navigate(url);
        }
        show_main(app);
    }
}

fn pick_download_dir_from_tray(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let current = state.download_dir.lock().unwrap().clone();
    let start = config::resolve_download_dir(&current);
    let picked = rfd::FileDialog::new()
        .set_title("选择 Noobty 接收目录")
        .set_directory(&start)
        .pick_folder();
    if let Some(path) = picked {
        let s = path.to_string_lossy().to_string();
        if let Err(e) = std::fs::create_dir_all(&path) {
            eprintln!("[shell] create download dir failed: {e}");
            return;
        }
        if let Err(e) = config::save_download_dir(&s) {
            eprintln!("[shell] save download_dir failed: {e}");
            return;
        }
        *state.download_dir.lock().unwrap() = s.clone();
        let _ = app
            .notification()
            .builder()
            .title("接收目录已更新")
            .body(&s)
            .show();
    }
}

pub fn run() {
    let cfg = config::load();
    let initial_hub = cfg.hub;
    let initial_auto = cfg.auto_accept;
    let initial_dir = cfg.download_dir;

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ShellState {
            hub: Mutex::new(initial_hub),
            auto_accept: AtomicBool::new(initial_auto),
            download_dir: Mutex::new(initial_dir),
        })
        .invoke_handler(tauri::generate_handler![
            hub_url,
            set_hub_url,
            auto_accept,
            download_dir,
            set_download_dir,
            pick_download_dir,
            download_to,
            notify,
            open_hub
        ])
        .setup(move |app| {
            // Windows 首次可能要授权通知;失败不阻塞启动
            let _ = app.notification().request_permission();

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
            // disable_drag_drop_handler:让系统文件拖拽走 HTML5 DnD,网页 Composer 直接收件
            let win = WebviewWindowBuilder::new(app, "main", url)
                .title("Noobty")
                .inner_size(1120.0, 740.0)
                .min_inner_size(960.0, 620.0)
                .disable_drag_drop_handler()
                .build()?;

            let open = MenuItem::with_id(app, "open", "打开 Noobty", true, None::<&str>)?;
            let change_hub =
                MenuItem::with_id(app, "change_hub", "更换中枢地址…", true, None::<&str>)?;
            let pick_dir =
                MenuItem::with_id(app, "pick_download_dir", "选择接收目录…", true, None::<&str>)?;
            let reset_dir =
                MenuItem::with_id(app, "reset_download_dir", "恢复默认接收目录", true, None::<&str>)?;
            let auto_item = CheckMenuItem::with_id(
                app,
                "auto_accept",
                "自动接收文件到接收目录",
                true,
                initial_auto,
                None::<&str>,
            )?;
            let launch_item = {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                CheckMenuItem::with_id(app, "autostart", "开机自启", true, enabled, None::<&str>)?
            };
            let check_update =
                MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Noobty", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &change_hub,
                    &pick_dir,
                    &reset_dir,
                    &auto_item,
                    &launch_item,
                    &check_update,
                    &quit,
                ],
            )?;

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
                    "change_hub" => open_hub_setup(app),
                    "pick_download_dir" => pick_download_dir_from_tray(app),
                    "reset_download_dir" => {
                        let state = app.state::<ShellState>();
                        let _ = config::save_download_dir("");
                        *state.download_dir.lock().unwrap() = String::new();
                        let resolved = config::resolve_download_dir("");
                        let _ = app
                            .notification()
                            .builder()
                            .title("已恢复默认接收目录")
                            .body(resolved.to_string_lossy())
                            .show();
                    }
                    "check_update" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match check_and_install_update(app.clone()).await {
                                Ok(msg) => notify_tray(&app, "检查更新", &msg),
                                Err(e) => notify_tray(&app, "检查更新失败", &e),
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    "auto_accept" => {
                        let state = app.state::<ShellState>();
                        let next = !state.auto_accept.load(Ordering::Relaxed);
                        state.auto_accept.store(next, Ordering::Relaxed);
                        let _ = config::save_auto_accept(next);
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
