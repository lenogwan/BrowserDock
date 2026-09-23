// BrowserDock desktop backend.
//! - `dock_status`: minimal IPC probe used by the Svelte pill.
//! - `win32_helper`: corrected SetForegroundWindow path (Windows only).
//! - runtime/desktop own vault lifecycle, shortcuts, tray and window controls.

mod commands;
mod desktop;
mod organization;
mod runtime;
mod win32_helper;
mod window_sizing;
use browserdock_launcher as launcher;
use tauri::Manager;

struct LauncherState {
    config: Result<launcher::config::Config, String>,
    companion: Result<launcher::ws_server::ServerHandle, String>,
}

fn current_config(app: &tauri::AppHandle) -> Result<launcher::config::Config, String> {
    if let Some(state) = app.try_state::<runtime::DesktopState>() {
        return state
            .config
            .lock()
            .map(|c| c.clone())
            .map_err(|_| "Configuration unavailable".into());
    }
    app.state::<LauncherState>().config.clone()
}

fn selected_bookmark(
    app: &tauri::AppHandle,
    config: &launcher::config::Config,
    id: Option<&str>,
    private: Option<bool>,
) -> Result<Option<launcher::vault::Bookmark>, String> {
    let Some(id) = id else {
        return Ok(None);
    };
    if private != Some(true) {
        if let Some(value) = config
            .bookmarks
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
        {
            let bookmark: launcher::vault::Bookmark =
                serde_json::from_value(value.clone()).map_err(|_| "Cannot read bookmark")?;
            bookmark.validate()?;
            return Ok(Some(bookmark));
        }
        if private == Some(false) {
            return Err("Bookmark no longer exists".into());
        }
    }
    let state = app
        .try_state::<runtime::DesktopState>()
        .ok_or("Configuration unavailable")?;
    let epoch = state.gate.ticket().ok_or("Vault is locked")?;
    let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
    let result = (|| {
        if !state.gate.valid(epoch) {
            return Err("Vault is locked".into());
        }
        let bookmarks = vault.list(std::time::Instant::now())?;
        let selected = bookmarks
            .into_iter()
            .find(|b| b.id == id)
            .ok_or("Bookmark no longer exists")?;
        if !state.gate.valid(epoch) {
            return Err("Vault is locked".into());
        }
        Ok(Some(selected))
    })();
    runtime::notify_lock(app, &state, &mut vault);
    result
}

fn group_data(
    app: &tauri::AppHandle,
    config: &launcher::config::Config,
    id: &str,
    private: bool,
) -> Result<(launcher::groups::Group, Vec<launcher::vault::Bookmark>), String> {
    let (groups, bookmarks) = if private {
        let state = app
            .try_state::<runtime::DesktopState>()
            .ok_or("Configuration unavailable")?;
        let epoch = state.gate.ticket().ok_or("Vault is locked")?;
        let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
        let result = (|| {
            if !state.gate.valid(epoch) {
                return Err("Vault is locked".to_string());
            }
            let now = std::time::Instant::now();
            let data = (vault.groups(now)?, vault.list(now)?);
            if !state.gate.valid(epoch) {
                return Err("Vault is locked".to_string());
            }
            Ok(data)
        })();
        runtime::notify_lock(app, &state, &mut vault);
        result?
    } else {
        (
            config.groups.clone(),
            config
                .bookmarks
                .iter()
                .filter_map(|v| serde_json::from_value::<launcher::vault::Bookmark>(v.clone()).ok())
                .collect(),
        )
    };
    let group = groups
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("Group no longer exists")?;
    group.validate()?;
    let mut bookmarks: Vec<_> = bookmarks
        .into_iter()
        .filter(|b| b.group_id.as_deref() == Some(id))
        .collect();
    bookmarks.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then(a.title.cmp(&b.title))
            .then(a.id.cmp(&b.id))
    });
    Ok((group, bookmarks))
}

fn group_guard(
    app: &tauri::AppHandle,
    private: bool,
) -> Result<std::sync::Arc<dyn Fn() -> bool + Send + Sync>, String> {
    let epoch = if private {
        Some(
            app.try_state::<runtime::DesktopState>()
                .ok_or("Configuration unavailable")?
                .gate
                .ticket()
                .ok_or("Vault is locked")?,
        )
    } else {
        None
    };
    let handle = app.clone();
    Ok(std::sync::Arc::new(move || {
        let Some(epoch) = epoch else {
            return true;
        };
        let Some(state) = handle.try_state::<runtime::DesktopState>() else {
            return false;
        };
        if !state.gate.valid(epoch) {
            return false;
        }
        let Ok(mut vault) = state.vault.lock() else {
            return false;
        };
        let unlocked = !vault.status(std::time::Instant::now()).locked;
        runtime::notify_lock(&handle, &state, &mut vault);
        unlocked && state.gate.valid(epoch)
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::summon(app, false)
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::routing::dock_status,
            commands::routing::route_url,
            commands::routing::route_details,
            commands::routing::browser_profiles,
            organization::save_group,
            organization::delete_group,
            organization::move_bookmark,
            organization::save_browser,
            commands::dispatch::open_url,
            commands::dispatch::close_tab,
            commands::dispatch::open_group,
            commands::dispatch::open_bookmark_tree,
            commands::dispatch::close_group_tabs,
            commands::companion::companion_status,
            commands::companion::companion_tabs_digest,
            commands::pairing::pairing_export,
            commands::pairing::pairing_copy,
            commands::pairing::pairing_open_page,
            commands::pairing::pairing_install_companion,
            commands::routing::redetect_browsers,
            runtime::get_dock_data,
            runtime::vault_auth,
            runtime::vault_status,
            runtime::vault_list,
            runtime::vault_lock,
            runtime::vault_activity,
            runtime::save_bookmark,
            runtime::delete_bookmark,
            runtime::save_settings,
            desktop::dock_hide,
            desktop::dock_resize,
            window_sizing::dock_set_size,
            window_sizing::dock_commit_size,
            window_sizing::dock_cancel_size,
            desktop::dock_escape,
            desktop::dock_save_position,
            desktop::dock_drag_finished
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                runtime::lock(window.app_handle());
            }
        })
        .setup(|app| {
            let initialized = tauri::async_runtime::block_on(async {
                let path = launcher::config::config_path()?;
                let mut config = launcher::config::Config::load_or_create(&path)?;
                let companion = launcher::ws_server::start_configured(&mut config, &path).await;
                Ok::<_, String>(LauncherState {
                    config: Ok(config),
                    companion,
                })
            });
            if let Ok(state) = &initialized {
                if let Ok(config) = &state.config {
                    runtime::initialize(
                        app.handle(),
                        config.clone(),
                        launcher::config::config_path()?,
                    );
                }
            }
            app.manage(initialized.unwrap_or_else(|error| LauncherState {
                config: Err(error.clone()),
                companion: Err(error),
            }));
            if app.try_state::<runtime::DesktopState>().is_some() {
                desktop::initialize(app.handle())?;
            } else if let Some(window) = app.get_webview_window("main") {
                // Show startup errors in the UI even when config initialization failed.
                window.set_size(tauri::LogicalSize::new(400., 440.))?;
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BrowserDock");
}
