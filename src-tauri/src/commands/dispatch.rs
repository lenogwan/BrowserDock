use crate::{
    current_config, group_data, group_guard, launcher, runtime, selected_bookmark, win32_helper,
    LauncherState,
};
use tauri::Manager;

#[tauri::command]
pub(crate) async fn open_group(
    app: tauri::AppHandle,
    group_id: String,
    private: bool,
    browser_id: Option<String>,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::GroupOutcome, String> {
    let guard = group_guard(&app, private)?;
    let config = current_config(&app)?;
    let (group, bookmarks) = group_data(&app, &config, &group_id, private)?;
    let hint = launcher::ws_server::TabGroupHint::from(&group);
    let outcome = launcher::dispatch::group_action_guarded(
        &config,
        state.companion.as_ref().ok(),
        &bookmarks,
        &hint,
        browser_id.as_deref(),
        false,
        guard,
    )
    .await?;
    if let Some(browser) = browser_id
        .as_deref()
        .or_else(|| bookmarks.last().map(|b| b.target_browser.as_str()))
    {
        let exe = config
            .browsers
            .iter()
            .find(|b| b.id == browser)
            .map(|b| b.exe_path.as_str());
        win32_helper::bring_browser_to_front(browser, exe);
    }
    Ok(outcome)
}

#[tauri::command]
pub(crate) async fn open_bookmark_tree(
    app: tauri::AppHandle,
    id: String,
    private: bool,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::GroupOutcome, String> {
    let guard = group_guard(&app, private)?;
    let config = current_config(&app)?;
    let (groups, bookmarks) = if private {
        let desktop = app
            .try_state::<runtime::DesktopState>()
            .ok_or("Configuration unavailable")?;
        let epoch = desktop.gate.ticket().ok_or("Vault is locked")?;
        let mut vault = desktop.vault.lock().map_err(|_| "Vault unavailable")?;
        let result = (|| {
            if !desktop.gate.valid(epoch) {
                return Err("Vault is locked".to_string());
            }
            let now = std::time::Instant::now();
            let data = (vault.groups(now)?, vault.list(now)?);
            if !desktop.gate.valid(epoch) {
                return Err("Vault is locked".to_string());
            }
            Ok(data)
        })();
        runtime::notify_lock(&app, &desktop, &mut vault);
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
    let (tree, hint) = launcher::groups::bookmark_tree(&bookmarks, &groups, &id)?;
    let outcome = launcher::dispatch::group_action_guarded(
        &config,
        state.companion.as_ref().ok(),
        &tree,
        &hint,
        None,
        false,
        guard.clone(),
    )
    .await?;
    if !guard() {
        return Err("Bookmark subtree open was cancelled; earlier tabs may have changed".into());
    }
    if let Some(bookmark) = tree.last() {
        let browser = bookmark.target_browser.as_str();
        let exe = config
            .browsers
            .iter()
            .find(|b| b.id == browser)
            .map(|b| b.exe_path.as_str());
        win32_helper::bring_browser_to_front(browser, exe);
    }
    Ok(outcome)
}

#[tauri::command]
pub(crate) async fn close_group_tabs(
    app: tauri::AppHandle,
    group_id: String,
    private: bool,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::GroupOutcome, String> {
    let guard = group_guard(&app, private)?;
    let config = current_config(&app)?;
    let (group, bookmarks) = group_data(&app, &config, &group_id, private)?;
    let hint = launcher::ws_server::TabGroupHint::from(&group);
    launcher::dispatch::group_action_guarded(
        &config,
        state.companion.as_ref().ok(),
        &bookmarks,
        &hint,
        None,
        true,
        guard,
    )
    .await
}

#[tauri::command]
pub(crate) async fn open_url(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    force_new_tab: Option<bool>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::LaunchOutcome, String> {
    let config = current_config(&app)?;
    let private_launch = bookmark_id.as_ref().is_some_and(|id| {
        bookmark_private == Some(true)
            || (bookmark_private.is_none()
                && !config
                    .bookmarks
                    .iter()
                    .any(|b| b.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
    });
    let epoch = if private_launch {
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
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    let input = bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url);
    let selected = browser_id
        .as_deref()
        .or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str()));
    let options = bookmark.as_ref().and_then(|b| b.browser_options.as_ref());
    let mode = if force_new_tab.unwrap_or(false) {
        launcher::ws_server::MatchMode::NewTab
    } else {
        launcher::ws_server::MatchMode::DomainOrExact
    };
    let handle = app.clone();
    let still_valid = std::sync::Arc::new(move || {
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
    });
    let group = if launcher::settings::Settings::from_config(&config).auto_tab_groups {
        bookmark
            .as_ref()
            .and_then(|b| b.group_id.as_deref())
            .map(|id| {
                group_data(&app, &config, id, private_launch)
                    .map(|(g, _)| launcher::ws_server::TabGroupHint::from(&g))
            })
            .transpose()?
    } else {
        None
    };
    let outcome = launcher::dispatch::open_url_with_group_guarded(
        &config,
        state.companion.as_ref().ok(),
        input,
        selected,
        mode,
        launcher::dispatch::LaunchHints {
            options,
            tab_group: group.as_ref(),
        },
        still_valid,
    )
    .await?;
    if outcome.result == "FOCUSED_EXISTING" || outcome.result == "OPENED_NEW_TAB" {
        // The companion activated the tab inside the browser, but on Windows a
        // background browser cannot pull its window past another app's window
        // (foreground lock). The dock was just clicked, so this process still
        // owns the foreground and may legally bring the browser forward.
        // Best-effort: a `false` return keeps the SUCCESS outcome unchanged.
        let exe = config
            .browsers
            .iter()
            .find(|b| b.id == outcome.browser_id)
            .map(|b| b.exe_path.as_str());
        win32_helper::bring_browser_to_front(&outcome.browser_id, exe);
    }
    Ok(outcome)
}

#[tauri::command]
pub(crate) async fn close_tab(
    app: tauri::AppHandle,
    url: String,
    browser_id: Option<String>,
    exact_match: Option<bool>,
    bookmark_id: Option<String>,
    bookmark_private: Option<bool>,
    state: tauri::State<'_, LauncherState>,
) -> Result<launcher::dispatch::CloseOutcome, String> {
    let config = current_config(&app)?;
    let private_launch = bookmark_id.as_ref().is_some_and(|id| {
        bookmark_private == Some(true)
            || (bookmark_private.is_none()
                && !config
                    .bookmarks
                    .iter()
                    .any(|b| b.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
    });
    let epoch = if private_launch {
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
    let bookmark = selected_bookmark(&app, &config, bookmark_id.as_deref(), bookmark_private)?;
    let input = bookmark.as_ref().map(|b| b.url.as_str()).unwrap_or(&url);
    let selected = browser_id
        .as_deref()
        .or_else(|| bookmark.as_ref().map(|b| b.target_browser.as_str()));
    let options = bookmark.as_ref().and_then(|b| b.browser_options.as_ref());
    let mode = if exact_match.unwrap_or(false) {
        launcher::ws_server::MatchMode::Exact
    } else {
        launcher::ws_server::MatchMode::DomainOrExact
    };
    let handle = app.clone();
    let still_valid = std::sync::Arc::new(move || {
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
    });
    launcher::dispatch::close_url_with_options_guarded(
        &config,
        state.companion.as_ref().ok(),
        input,
        selected,
        mode,
        options,
        still_valid,
    )
    .await
}
