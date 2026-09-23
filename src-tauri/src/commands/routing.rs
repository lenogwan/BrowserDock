use crate::{current_config, launcher, runtime, selected_bookmark, LauncherState};
use tauri::Manager;

#[tauri::command]
pub(crate) fn route_details(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
) -> Result<launcher::RouteDetails, String> {
    let config = current_config(&app)?;
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    launcher::route_details(
        &config,
        bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url),
        browser_id
            .as_deref()
            .or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str())),
        bookmark.as_ref().and_then(|b| b.browser_options.as_ref()),
    )
}

#[tauri::command]
pub(crate) async fn browser_profiles(
    app: tauri::AppHandle,
    browser_id: String,
    state: tauri::State<'_, LauncherState>,
) -> Result<Vec<String>, String> {
    let config = current_config(&app)?;
    Ok(launcher::browser_profiles(&config, state.companion.as_ref().ok(), &browser_id).await)
}

#[tauri::command]
pub(crate) fn route_url(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
) -> Result<String, String> {
    let config = current_config(&app)?;
    launcher::target_browser(&config, &url, browser_id.as_deref())
}

#[tauri::command]
pub(crate) fn dock_status() -> String {
    "BrowserDock backend online".to_string()
}

/// Re-run browser detection and fill in executables that are missing or point
/// at files that no longer exist (e.g. a browser installed after first run).
/// Configured paths are never overwritten, so custom installations survive.
#[tauri::command]
pub(crate) fn redetect_browsers(
    app: tauri::AppHandle,
) -> Result<Vec<launcher::config::Browser>, String> {
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
