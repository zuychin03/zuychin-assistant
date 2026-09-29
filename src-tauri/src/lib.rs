mod config;
pub mod contract;
pub mod supervisor;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use supervisor::{DesktopHostStatus, Supervisor};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Manager, State, WebviewWindow,
};

struct DesktopState {
    supervisor: Arc<Supervisor>,
    origin: String,
    closing: AtomicBool,
    shutdown_complete: AtomicBool,
}

fn authorised(window: &WebviewWindow, state: &DesktopState) -> Result<(), String> {
    if state.closing.load(Ordering::Acquire)
        || window.label() != "main"
        || !window
            .url()
            .is_ok_and(|url| config::same_origin(&state.origin, &url))
    {
        return Err("Desktop control is unavailable from this window".into());
    }
    Ok(())
}

#[tauri::command]
fn council_desktop_status(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopHostStatus, String> {
    authorised(&window, &state)?;
    Ok(state.supervisor.status())
}

#[tauri::command]
async fn council_desktop_start(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopHostStatus, String> {
    authorised(&window, &state)?;
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.start())
        .await
        .map_err(|_| "Desktop worker unavailable".to_string())?
}

#[tauri::command]
async fn council_desktop_stop(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopHostStatus, String> {
    authorised(&window, &state)?;
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.stop())
        .await
        .map_err(|_| "Desktop worker unavailable".to_string())?
}

#[tauri::command]
async fn council_desktop_restart(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopHostStatus, String> {
    authorised(&window, &state)?;
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.restart())
        .await
        .map_err(|_| "Desktop worker unavailable".to_string())?
}

fn config_path(app: &tauri::App) -> tauri::Result<PathBuf> {
    if let Some(path) = std::env::var_os("ZUYCHIN_DESKTOP_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    let installed = app.path().app_config_dir()?.join("desktop.json");
    #[cfg(debug_assertions)]
    {
        let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("desktop.local.json");
        if local.is_file() {
            return Ok(local);
        }
    }
    Ok(installed)
}

fn close_owned_host(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<DesktopState>() else {
        app.exit(0);
        return;
    };
    if state.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    let supervisor = state.supervisor.clone();
    let app = app.clone();
    std::thread::spawn(move || match supervisor.shutdown() {
        Ok(status) if !status.owned => {
            app.state::<DesktopState>()
                .shutdown_complete
                .store(true, Ordering::Release);
            app.exit(0);
        }
        _ => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window
                    .set_title("Zuychin Council: host shutdown unconfirmed; close again to retry");
            }
            app.state::<DesktopState>()
                .closing
                .store(false, Ordering::Release);
        }
    });
}

pub fn run() {
    let application = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            council_desktop_status, council_desktop_start, council_desktop_stop, council_desktop_restart,
        ])
        .setup(|app| {
            let loaded = config_path(app).ok().and_then(|path| config::load(&path).ok());
            let Some(config) = loaded else {
                WebviewWindow::builder(app, "setup", tauri::WebviewUrl::App("index.html".into()))
                    .title("Zuychin Council: setup required").inner_size(720.0, 520.0)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_download(|_, _| false).build()?;
                return Ok(());
            };

            let capability = serde_json::json!({
                "identifier": "council-desktop-lifecycle",
                "description": "Owned host lifecycle on the configured app origin",
                "local": false,
                "windows": ["main"],
                "remote": {"urls": [format!("{}/*", config.origin)]},
                "permissions": ["allow-council-desktop-status", "allow-council-desktop-start", "allow-council-desktop-stop", "allow-council-desktop-restart"]
            }).to_string();
            app.add_capability(capability.as_str())?;

            let supervisor = Arc::new(Supervisor::new(config.launch));
            app.manage(DesktopState { supervisor, origin: config.origin.clone(), closing: AtomicBool::new(false), shutdown_complete: AtomicBool::new(false) });
            let start = MenuItem::with_id(app, "host-start", "Start host", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "host-stop", "Stop host", false, None::<&str>)?;
            let restart = MenuItem::with_id(app, "host-restart", "Restart host", false, None::<&str>)?;
            let status = MenuItem::with_id(app, "host-status", "Host stopped", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Zuychin Council", true, None::<&str>)?;
            let host_menu = Submenu::with_items(app, "Host", true, &[&status, &start, &stop, &restart, &quit])?;
            app.set_menu(Menu::with_items(app, &[&host_menu])?)?;

            WebviewWindow::builder(app, "main", tauri::WebviewUrl::External(config.app_url))
                .title("Zuychin Council: host stopped").inner_size(1200.0, 820.0).min_inner_size(640.0, 480.0)
                .on_navigation(move |url| config::same_origin(&config.origin, url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_menu_event(|window, event| {
                    let app = window.app_handle();
                    if event.id().as_ref() == "quit" { close_owned_host(app); return; }
                    let state = app.state::<DesktopState>();
                    if state.closing.load(Ordering::Acquire) { return; }
                    let supervisor = state.supervisor.clone();
                    let action = event.id().as_ref().to_owned();
                    let window = window.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let outcome = match action.as_str() {
                            "host-start" => supervisor.start(),
                            "host-stop" => supervisor.stop(),
                            "host-restart" => supervisor.restart(),
                            _ => return,
                        };
                        if let Err(error) = outcome { let _ = window.set_title(&format!("Zuychin Council: {error}")); }
                    });
                })
                .build()?;

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let state = handle.state::<DesktopState>();
                if state.shutdown_complete.load(Ordering::Acquire) { break; }
                if state.closing.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                let snapshot = state.supervisor.status();
                let value = serde_json::to_value(&snapshot).unwrap_or_default();
                let phase = value["phase"].as_str().unwrap_or("unknown");
                let idle = !snapshot.owned && (phase == "stopped" || phase == "failed");
                let _ = start.set_enabled(idle);
                let _ = stop.set_enabled(snapshot.restart_safe);
                let _ = restart.set_enabled(snapshot.restart_safe);
                let label = snapshot.error.as_deref().unwrap_or(phase);
                let _ = status.set_text(format!("Host: {label}"));
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.set_title(&format!("Zuychin Council: {label}"));
                }
                std::thread::sleep(Duration::from_secs(1));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                    if !state.shutdown_complete.load(Ordering::Acquire) {
                        api.prevent_close();
                        close_owned_host(window.app_handle());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cannot initialise the Council desktop shell");
    application.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app.try_state::<DesktopState>() {
                if !state.shutdown_complete.load(Ordering::Acquire) {
                    api.prevent_exit();
                    close_owned_host(app);
                }
            }
        }
    });
}
