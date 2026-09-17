// BrowserDock desktop backend.
//! - `dock_status`: minimal IPC probe used by the Svelte pill.
//! - `win32_helper`: corrected SetForegroundWindow path (Windows only).
//! - runtime/desktop own vault lifecycle, shortcuts, tray and window controls.

mod desktop;
mod runtime;
mod organization;
mod window_sizing;
mod win32_helper;
use browserdock_launcher as launcher;
use tauri::Manager;

struct LauncherState {
    config: Result<launcher::config::Config, String>,
    companion: Result<launcher::ws_server::ServerHandle, String>,
}

#[derive(serde::Serialize)]
struct CompanionStatus {
    port: Option<u16>,
    error: Option<String>,
    instances: Vec<launcher::ws_server::Instance>,
}

#[derive(serde::Serialize)]
struct CompanionDigest {
    error: Option<String>,
    instances: Vec<launcher::ws_server::InstanceDigest>,
}

#[tauri::command]
fn companion_tabs_digest(state: tauri::State<'_, LauncherState>) -> CompanionDigest {
    match &state.companion {
        Ok(server) => CompanionDigest {
            error: server.error(),
            instances: server.tabs_digest(),
        },
        Err(error) => CompanionDigest {
            error: Some(error.clone()),
            instances: vec![],
        },
    }
}

#[tauri::command]
fn companion_status(state: tauri::State<'_, LauncherState>) -> CompanionStatus {
    match &state.companion {
        Ok(server) => CompanionStatus {
            port: Some(server.port()),
            error: server.error(),
            instances: server.instances(),
        },
        Err(error) => CompanionStatus {
            port: None,
            error: Some(error.clone()),
            instances: vec![],
        },
    }
}

fn current_config(app: &tauri::AppHandle) -> Result<launcher::config::Config, String> {
    if let Some(state) = app.try_state::<runtime::DesktopState>() {
        return state.config.lock().map(|c| c.clone()).map_err(|_| "Configuration unavailable".into());
    }
    app.state::<LauncherState>().config.clone()
}

fn selected_bookmark(
    app: &tauri::AppHandle,
    config: &launcher::config::Config,
    id: Option<&str>,
    private: Option<bool>,
) -> Result<Option<launcher::vault::Bookmark>, String> {
    let Some(id) = id else { return Ok(None); };
    if private != Some(true) {
        if let Some(value) = config.bookmarks.iter().find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id)) {
            let bookmark: launcher::vault::Bookmark = serde_json::from_value(value.clone()).map_err(|_| "Cannot read bookmark")?;
            bookmark.validate()?;
            return Ok(Some(bookmark));
        }
        if private == Some(false) { return Err("Bookmark no longer exists".into()); }
    }
    let state = app.try_state::<runtime::DesktopState>().ok_or("Configuration unavailable")?;
    let epoch = state.gate.ticket().ok_or("Vault is locked")?;
    let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
    let result = (|| {
        if !state.gate.valid(epoch) { return Err("Vault is locked".into()); }
        let bookmarks = vault.list(std::time::Instant::now())?;
        let selected = bookmarks.into_iter().find(|b| b.id == id).ok_or("Bookmark no longer exists")?;
        if !state.gate.valid(epoch) { return Err("Vault is locked".into()); }
        Ok(Some(selected))
    })();
    runtime::notify_lock(app, &state, &mut vault);
    result
}

#[tauri::command]
async fn open_url(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    force_new_tab: Option<bool>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::LaunchOutcome, String> {
    let config = current_config(&app)?;
    let private_launch = bookmark_id.as_ref().is_some_and(|id|
        bookmark_private == Some(true) || (bookmark_private.is_none() && !config.bookmarks.iter().any(|b|
            b.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))));
    let epoch = if private_launch {
        Some(app.try_state::<runtime::DesktopState>().ok_or("Configuration unavailable")?
            .gate.ticket().ok_or("Vault is locked")?)
    } else { None };
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    let input = bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url);
    let selected = browser_id.as_deref().or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str()));
    let options = bookmark.as_ref().and_then(|b| b.browser_options.as_ref());
    let mode = if force_new_tab.unwrap_or(false) {
        launcher::ws_server::MatchMode::NewTab
    } else {
        launcher::ws_server::MatchMode::DomainOrExact
    };
    let handle = app.clone();
    let still_valid = std::sync::Arc::new(move || {
        let Some(epoch) = epoch else { return true; };
        let Some(state) = handle.try_state::<runtime::DesktopState>() else { return false; };
        if !state.gate.valid(epoch) { return false; }
        let Ok(mut vault) = state.vault.lock() else { return false; };
        let unlocked = !vault.status(std::time::Instant::now()).locked;
        runtime::notify_lock(&handle, &state, &mut vault);
        unlocked && state.gate.valid(epoch)
    });
    let outcome = launcher::dispatch::open_url_with_options_guarded(&config, state.companion.as_ref().ok(), input, selected, mode, options, still_valid).await?;
    if outcome.result == "FOCUSED_EXISTING" || outcome.result == "OPENED_NEW_TAB" {
        // The companion activated the tab inside the browser, but on Windows a
        // background browser cannot pull its window past another app's window
        // (foreground lock). The dock was just clicked, so this process still
        // owns the foreground and may legally bring the browser forward.
        // Best-effort: a `false` return keeps the SUCCESS outcome unchanged.
        let exe = config.browsers.iter().find(|b| b.id == outcome.browser_id).map(|b| b.exe_path.as_str());
        win32_helper::bring_browser_to_front(&outcome.browser_id, exe);
    }
    Ok(outcome)
}

#[tauri::command]
async fn close_tab(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    exact_match: Option<bool>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::CloseOutcome, String> {
    let config = current_config(&app)?;
    let private_launch = bookmark_id.as_ref().is_some_and(|id|
        bookmark_private == Some(true) || (bookmark_private.is_none() && !config.bookmarks.iter().any(|b|
            b.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))));
    let epoch = if private_launch {
        Some(app.try_state::<runtime::DesktopState>().ok_or("Configuration unavailable")?
            .gate.ticket().ok_or("Vault is locked")?)
    } else { None };
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    let input = bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url);
    let selected = browser_id.as_deref().or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str()));
    let options = bookmark.as_ref().and_then(|b| b.browser_options.as_ref());
    let mode = if exact_match.unwrap_or(false) {
        launcher::ws_server::MatchMode::Exact
    } else {
        launcher::ws_server::MatchMode::DomainOrExact
    };
    let handle = app.clone();
    let still_valid = std::sync::Arc::new(move || {
        let Some(epoch) = epoch else { return true; };
        let Some(state) = handle.try_state::<runtime::DesktopState>() else { return false; };
        if !state.gate.valid(epoch) { return false; }
        let Ok(mut vault) = state.vault.lock() else { return false; };
        let unlocked = !vault.status(std::time::Instant::now()).locked;
        runtime::notify_lock(&handle, &state, &mut vault);
        unlocked && state.gate.valid(epoch)
    });
    launcher::dispatch::close_url_with_options_guarded(&config, state.companion.as_ref().ok(), input, selected, mode, options, still_valid).await
}

#[tauri::command]
fn route_details(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
) -> Result<launcher::RouteDetails, String> {
    let config = current_config(&app)?;
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    launcher::route_details(&config,
        bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url),
        browser_id.as_deref().or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str())),
        bookmark.as_ref().and_then(|b| b.browser_options.as_ref()))
}

#[tauri::command]
async fn browser_profiles(app: tauri::AppHandle, browser_id: String, state: tauri::State<'_, LauncherState>) -> Result<Vec<String>, String> {
    let config = current_config(&app)?;
    Ok(launcher::browser_profiles(&config, state.companion.as_ref().ok(), &browser_id).await)
}

#[tauri::command]
fn route_url(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
) -> Result<String, String> {
    let config = current_config(&app)?;
    launcher::target_browser(&config, &url, browser_id.as_deref())
}

#[tauri::command]
fn dock_status() -> String {
    "BrowserDock backend online".to_string()
}

/// Pairing artifacts never carry the bearer token back to the webview: the
/// frontend only receives file paths, while the token stays in Rust memory
/// (clipboard) or inside files on disk (imported by the extension page).
#[derive(serde::Serialize)]
struct PairingExport {
    dir: String,
    files: Vec<String>,
}

#[tauri::command]
fn pairing_export(app: tauri::AppHandle) -> Result<PairingExport, String> {
    let config = current_config(&app)?;
    let dir = launcher::pairing::pairing_dir()?;
    let files = launcher::pairing::export_pairing_files(&config, std::path::Path::new(&dir))?;
    Ok(PairingExport {
        dir: dir.to_string_lossy().into_owned(),
        files: files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[tauri::command]
fn pairing_copy(
    app: tauri::AppHandle,
    browser_id: String,
    include_private: Option<bool>,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use zeroize::Zeroizing;
    let config = current_config(&app)?;
    let code = Zeroizing::new(launcher::pairing::pairing_code(
        &config,
        &browser_id,
        include_private,
    )?);
    app.clipboard()
        .write_text(code.as_str())
        .map_err(|_| "Cannot copy pairing code".to_string())
}

#[tauri::command]
fn pairing_open_page(app: tauri::AppHandle, browser_id: String) -> Result<(), String> {
    let url = launcher::pairing::extension_page_url(&browser_id)?;
    let config = current_config(&app)?;
    let configured = config
        .browsers
        .iter()
        .find(|b| b.id == browser_id)
        .map(|b| b.exe_path.clone())
        .unwrap_or_default();
    let exe = if configured.is_empty() {
        launcher::detection::detect_browsers()
            .into_iter()
            .find(|b| b.id == browser_id)
            .map(|b| b.exe_path)
            .unwrap_or_default()
    } else {
        configured
    };
    if exe.is_empty() {
        return Err(format!("Browser '{browser_id}' is not installed"));
    }
    std::process::Command::new(exe)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| format!("Cannot open {browser_id}"))
}

#[derive(serde::Serialize)]
struct CompanionInstall {
    dir: String,
    flavors: Vec<String>,
}
fn copy_dir_recursive(source: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot stage companion: {e}"))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("Cannot read bundled companion: {e}"))? {
        let entry = entry.map_err(|e| format!("Cannot read bundled companion: {e}"))?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| format!("Cannot read bundled companion: {e}"))?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("Cannot stage companion: {e}"))?;
        }
    }
    Ok(())
}

/// Locate a bundled companion flavor (`chromium`/`gecko`) by its manifest.
/// Tries explicit layouts first, then scans each base dir up to 3 levels deep
/// so any bundler layout (flat, `extension/`, `companion/`) resolves.
fn find_companion_flavor(
    bases: &[std::path::PathBuf],
    flavor: &str,
) -> Option<std::path::PathBuf> {
    for base in bases {
        for candidate in [
            base.join(flavor),
            base.join(format!("extension/{flavor}")),
            base.join(format!("companion/{flavor}")),
        ] {
            if candidate.join("manifest.json").is_file() {
                return Some(candidate);
            }
        }
    }
    for base in bases {
        let mut stack = vec![(base.clone(), 0u8)];
        let mut seen = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 3 || seen > 2000 {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.file_name().is_some_and(|name| name == flavor)
                    && path.join("manifest.json").is_file()
                {
                    return Some(path);
                }
                if depth < 3 {
                    stack.push((path, depth + 1));
                }
            }
        }
    }
    None
}

#[tauri::command]
fn pairing_install_companion(app: tauri::AppHandle) -> Result<CompanionInstall, String> {
    let mut bases: Vec<std::path::PathBuf> = vec![
        // Compile-time checkout path: resolves in `tauri dev` and any build
        // run from source, independent of the process working directory.
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension"),
    ];
    if let Ok(resource_dir) = app.path().resource_dir() {
        bases.push(resource_dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir = dir.to_path_buf();
            if !bases.contains(&dir) {
                bases.push(dir);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if !bases.contains(&cwd) {
            bases.push(cwd);
        }
    }
    let dest = launcher::pairing::stable_companion_dir()?;
    let mut flavors = vec![];
    for flavor in ["chromium", "gecko"] {
        let source = find_companion_flavor(&bases, flavor).ok_or_else(|| {
            let searched = bases
                .iter()
                .map(|b| b.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "Bundled companion ({flavor}) not found. Searched: {searched}. \
                Reinstall BrowserDock from the latest installer, or load the \
                extension/ folder from a source checkout instead."
            )
        })?;
        copy_dir_recursive(&source, &dest.join(flavor))?;
        flavors.push(flavor.to_string());
    }
    Ok(CompanionInstall {
        dir: dest.to_string_lossy().into_owned(),
        flavors,
    })
}

/// Re-run browser detection and fill in executables that are missing or point
/// at files that no longer exist (e.g. a browser installed after first run).
/// Configured paths are never overwritten, so custom installations survive.
#[tauri::command]
fn redetect_browsers(app: tauri::AppHandle) -> Result<Vec<launcher::config::Browser>, String> {
    let state = app
        .try_state::<runtime::DesktopState>()
        .ok_or("Configuration unavailable")?;
    let mut config = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?;
    let found = launcher::detection::detect_browsers();
    let mut next = config.clone();
    let mut changed = false;
    for browser in next.browsers.iter_mut() {
        let missing =
            browser.exe_path.is_empty() || !std::path::Path::new(&browser.exe_path).is_file();
        if missing {
            if let Some(detected) = found.iter().find(|b| b.id == browser.id) {
                browser.exe_path.clone_from(&detected.exe_path);
                changed = true;
            }
        }
    }
    if changed {
        next.save(&state.path)?;
        *config = next.clone();
    }
    Ok(next.browsers.clone())
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
            dock_status,
            route_url,
            route_details,
            browser_profiles,
            organization::save_group,
            organization::delete_group,
            organization::move_bookmark,
            organization::save_browser,
            open_url,
            close_tab,
            companion_status,
            companion_tabs_digest,
            pairing_export,
            pairing_copy,
            pairing_open_page,
            pairing_install_companion,
            redetect_browsers,
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
