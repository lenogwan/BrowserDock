//! Desktop IPC and vault lifecycle. No pairing token is returned to the webview.
use browserdock_launcher::{
    config::Config,
    groups::{self, Group},
    vault::{Bookmark, Vault, VaultStatus},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use zeroize::Zeroizing;

pub struct DesktopState {
    pub size: Mutex<browserdock_launcher::window_size::SizeState>,
    pub config: Mutex<Config>,
    pub vault: Mutex<Vault>,
    pub gate: browserdock_launcher::session::SessionGate,
    pub path: PathBuf,
    pub startup_errors: Mutex<Vec<String>>,
}
pub use browserdock_launcher::settings::Settings;
#[derive(Serialize)]
pub struct DockData {
    warnings: Vec<String>,
    bookmarks: Vec<Bookmark>,
    groups: Vec<Group>,
    browsers: Vec<browserdock_launcher::config::Browser>,
    settings: Settings,
}
#[tauri::command]
pub async fn get_dock_data(state: tauri::State<'_, DesktopState>) -> Result<DockData, String> {
    let c = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?;
    let mut invalid_public = 0usize;
    let mut bookmarks: Vec<Bookmark> = c
        .bookmarks
        .iter()
        .filter_map(
            |value| match serde_json::from_value::<Bookmark>(value.clone()) {
                Ok(bookmark) if bookmark.validate().is_ok() => Some(bookmark),
                _ => {
                    invalid_public += 1;
                    None
                }
            },
        )
        .collect();
    let mut warnings = state
        .startup_errors
        .lock()
        .map_err(|_| "Status unavailable")?
        .clone();
    if browserdock_launcher::window_size::WindowSize::from_value(c.settings.get("window_size")).1 {
        warnings.push("Invalid saved window size was adjusted to safe defaults.".into());
    }
    if invalid_public > 0 {
        warnings.push(format!(
            "{invalid_public} public bookmark(s) could not be read and were hidden."
        ));
    }
    let orphaned = groups::display_roots(&mut bookmarks);
    if orphaned > 0 {
        warnings.push(format!("{orphaned} public bookmark(s) have invalid parents and are shown at the root. Repair their Parent field."));
    }
    Ok(DockData {
        warnings,
        bookmarks,
        groups: c.groups.clone(),
        browsers: c.browsers.clone(),
        settings: Settings::from_config(&c),
    })
}
pub fn lock(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        let requested_epoch = state.gate.request_lock();
        let _ = app.emit("vault-locked", ());
        if let Ok(mut vault) = state.vault.try_lock() {
            state.gate.complete_lock(requested_epoch, || {
                vault.lock();
                vault.take_lock_event();
            });
        } else {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<DesktopState>();
                if let Ok(mut vault) = state.vault.lock() {
                    state.gate.complete_lock(requested_epoch, || {
                        vault.lock();
                        vault.take_lock_event();
                    });
                };
            });
        }
    }
}
#[tauri::command]
pub fn vault_lock(app: tauri::AppHandle) {
    lock(&app);
}
pub(crate) fn notify_lock(app: &tauri::AppHandle, state: &DesktopState, vault: &mut Vault) {
    if vault.take_lock_event() && state.gate.expired() {
        let _ = app.emit("vault-locked", ());
    }
}
#[tauri::command]
pub async fn vault_status(app: tauri::AppHandle) -> Result<VaultStatus, String> {
    let state = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable; repair config.json and restart")?;
    let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
    let mut status = vault.status(Instant::now());
    if state.gate.ticket().is_none() {
        status.locked = true;
    }
    notify_lock(&app, &state, &mut vault);
    Ok(status)
}
#[tauri::command]
pub fn vault_activity(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    if let Ok(mut vault) = state.vault.try_lock() {
        vault.activity(Instant::now());
        notify_lock(&app, &state, &mut vault);
    };
}
#[tauri::command]
pub async fn vault_auth(app: tauri::AppHandle, secret: String, create: bool) -> Result<(), String> {
    let secret = Zeroizing::new(secret);
    let state = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable; repair config.json and restart")?;
    if state.gate.ticket().is_none() {
        return Err("Vault is locking; try again".into());
    }
    let epoch = state.gate.ticket().ok_or("Vault is locking; try again")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable; repair config.json and restart")?;
        let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
        if !state.gate.valid(epoch) {
            return Err("Unlock was cancelled".into());
        }
        notify_lock(&app, &state, &mut vault);
        let epoch = state.gate.ticket().ok_or("Vault is locking; try again")?;
        let result = if create {
            vault.create(&secret, Instant::now())
        } else {
            vault.unlock(&secret, Instant::now())
        };
        if !state.gate.valid(epoch) {
            vault.lock();
            return Err("Unlock was cancelled".into());
        }
        result
    })
    .await
    .map_err(|_| "Vault task failed")?
}
#[derive(Serialize)]
pub struct VaultData {
    bookmarks: Vec<Bookmark>,
    groups: Vec<Group>,
}
#[tauri::command]
pub async fn vault_list(app: tauri::AppHandle) -> Result<VaultData, String> {
    let state = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable")?;
    let epoch = state.gate.ticket().ok_or("Vault is locked")?;
    let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
    let now = Instant::now();
    let result = (|| {
        if !state.gate.valid(epoch) {
            return Err("Vault is locked".into());
        }
        let bookmarks = vault.list(now)?;
        let groups = vault.groups(now)?;
        if !state.gate.valid(epoch) {
            return Err("Vault is locked".into());
        }
        Ok(VaultData { bookmarks, groups })
    })();
    notify_lock(&app, &state, &mut vault);
    result
}
#[tauri::command]
pub async fn save_bookmark(
    app: tauri::AppHandle,
    bookmark: Bookmark,
    private: bool,
) -> Result<(), String> {
    let epoch = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable; repair config.json and restart")?
        .gate
        .ticket();
    tauri::async_runtime::spawn_blocking(move || {
        bookmark.validate()?;
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable; repair config.json and restart")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        if !config
            .browsers
            .iter()
            .any(|b| b.id == bookmark.target_browser)
        {
            return Err("Choose a configured browser".into());
        }
        if private {
            drop(config);
            let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
            if !epoch.is_some_and(|ticket| state.gate.valid(ticket)) {
                return Err("Vault is locked".into());
            }
            let result = vault.save(bookmark, Instant::now());
            notify_lock(&app, &state, &mut vault);
            return result;
        }
        let mut next = config.clone();
        let mut bookmarks: Vec<Bookmark> = next
            .bookmarks
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        let id = bookmark.id.clone();
        groups::save_bookmark(&mut bookmarks, &next.groups, bookmark)?;
        let bookmark = bookmarks
            .iter()
            .find(|b| b.id == id)
            .ok_or("Bookmark no longer exists")?;
        let value = serde_json::to_value(&bookmark).map_err(|_| "Cannot save bookmark")?;
        if let Some(existing) = next
            .bookmarks
            .iter_mut()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(bookmark.id.as_str()))
        {
            // Preserve future fields on public entries during edits.
            if let (Some(object), Some(fields)) = (existing.as_object_mut(), value.as_object()) {
                object.extend(fields.clone());
            } else {
                *existing = value;
            }
        } else {
            if next.bookmarks.len() >= 1000 {
                return Err("Bookmark limit reached".into());
            }
            next.bookmarks.push(value);
        }
        groups::patch_organization(&mut next.bookmarks, &bookmarks);
        next.save(&state.path)?;
        *config = next;
        Ok(())
    })
    .await
    .map_err(|_| "Bookmark task failed")?
}
#[tauri::command]
pub async fn delete_bookmark(
    app: tauri::AppHandle,
    id: String,
    private: bool,
) -> Result<(), String> {
    let epoch = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable; repair config.json and restart")?
        .gate
        .ticket();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable; repair config.json and restart")?;
        if private {
            let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
            if !epoch.is_some_and(|ticket| state.gate.valid(ticket)) {
                return Err("Vault is locked".into());
            }
            let result = vault.delete(&id, Instant::now());
            notify_lock(&app, &state, &mut vault);
            return result;
        }
        let mut c = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let mut next = c.clone();
        let mut bookmarks: Vec<Bookmark> = next
            .bookmarks
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        groups::delete_bookmark(&mut bookmarks, &id)?;
        groups::patch_organization(&mut next.bookmarks, &bookmarks);
        next.bookmarks
            .retain(|b| b.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        next.save(&state.path)?;
        *c = next;
        Ok(())
    })
    .await
    .map_err(|_| "Bookmark task failed")?
}
#[tauri::command]
pub async fn save_settings(
    app: tauri::AppHandle,
    mut settings: Settings,
) -> Result<SaveSettingsOutcome, String> {
    settings.validate()?;
    let state = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable; repair config.json and restart")?;
    let mut config = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?;
    let old = Settings::from_config(&config);
    // Shortcut changes are applied on restart, so current panic binding remains available.
    use tauri_plugin_global_shortcut::Shortcut;
    let summon = settings
        .global_shortcut
        .parse::<Shortcut>()
        .map_err(|_| "Invalid summon shortcut")?;
    let panic = settings
        .panic_shortcut
        .parse::<Shortcut>()
        .map_err(|_| "Invalid panic shortcut")?;
    let escape = "Escape"
        .parse::<Shortcut>()
        .map_err(|_| "Invalid reserved shortcut")?;
    if summon == escape || panic == escape {
        return Err("Escape is reserved for hiding and panic lock".into());
    }
    if summon == panic {
        return Err("Summon and panic shortcuts must differ".into());
    }
    let window = app.get_webview_window("main").ok_or("Dock unavailable")?;
    let mut size = state.size.lock().map_err(|_| "Window size unavailable")?;
    let previous_size = size.requested;
    crate::window_sizing::apply(&window, &config, &mut size, settings.window_size, None)?;
    settings.window_size = size.requested;
    let mut next = config.clone();
    for (key, value) in serde_json::to_value(&settings)
        .map_err(|_| "Invalid settings")?
        .as_object()
        .ok_or("Invalid settings")?
    {
        next.settings.insert(key.clone(), value.clone());
    }
    // Save position and size together, including shifts caused by edge anchoring.
    let position = window
        .outer_position()
        .map_err(|_| "Cannot read dock position")?;
    let mut saved_position = next
        .settings
        .get("dock_position")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"snapped":false}));
    saved_position["x"] = serde_json::json!(position.x);
    saved_position["y"] = serde_json::json!(position.y);
    next.settings.insert("dock_position".into(), saved_position);
    if window.set_always_on_top(settings.always_on_top).is_err() {
        let _ = crate::window_sizing::apply(&window, &config, &mut size, previous_size, None);
        return Err("Cannot update window".into());
    }
    if let Err(error) = next.save(&state.path) {
        let _ = window.set_always_on_top(old.always_on_top);
        let _ = crate::window_sizing::apply(&window, &config, &mut size, previous_size, None);
        return Err(error);
    }
    *config = next;
    state
        .vault
        .lock()
        .map_err(|_| "Vault unavailable")?
        .set_timeout(Duration::from_secs(settings.vault_timeout_minutes * 60));
    Ok(SaveSettingsOutcome {
        notice: hot_swap_shortcuts(&app, &old, &settings),
    })
}

/// Empty notice means every change — including shortcuts — is live already.
/// A non-empty notice names what still needs a restart.
#[derive(Serialize)]
pub struct SaveSettingsOutcome {
    pub notice: String,
}

fn register_summon(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                crate::desktop::summon(app, false);
            }
        })
        .map_err(|_| "shortcut is unavailable".to_string())
}

fn register_panic(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let _ = crate::desktop::dock_hide(app.clone());
                lock(app);
            }
        })
        .map_err(|_| "shortcut is unavailable".to_string())
}

/// Swap global shortcuts without a restart. Previous bindings are released
/// first so swapped pairs (A<->B) cannot collide; anything that fails to grab
/// is rolled back to the previous binding and reported for a restart retry.
/// Only the exact previous strings are released — the temporary Escape
/// binding owned by `dock_escape` is never touched.
fn hot_swap_shortcuts(app: &tauri::AppHandle, old: &Settings, new: &Settings) -> String {
    if old.global_shortcut == new.global_shortcut && old.panic_shortcut == new.panic_shortcut {
        return String::new();
    }
    let _ = app
        .global_shortcut()
        .unregister(old.global_shortcut.as_str());
    let _ = app
        .global_shortcut()
        .unregister(old.panic_shortcut.as_str());
    let mut problems = vec![];
    if register_summon(app, &new.global_shortcut).is_err() {
        if register_summon(app, &old.global_shortcut).is_ok() {
            problems.push("Summon shortcut is in use by another app, so the previous one stays active until restart");
        } else {
            problems.push("Summon shortcut could not be activated; restart BrowserDock to retry");
        }
    }
    if register_panic(app, &new.panic_shortcut).is_err() {
        if register_panic(app, &old.panic_shortcut).is_ok() {
            problems.push("Panic shortcut is in use by another app, so the previous one stays active until restart");
        } else {
            problems.push("Panic shortcut could not be activated; restart BrowserDock to retry");
        }
    }
    problems.join(" ")
}
pub fn initialize(app: &tauri::AppHandle, config: Config, path: PathBuf) {
    let timeout = Settings::from_config(&config).vault_timeout_minutes;
    let startup_errors = config
        .settings
        .get("ws_port_warning")
        .and_then(|value| value.as_str())
        .map(|warning| vec![warning.to_string()])
        .unwrap_or_default();
    app.manage(DesktopState {
        size: Mutex::new(browserdock_launcher::window_size::SizeState::new(
            Settings::from_config(&config).window_size,
        )),
        config: Mutex::new(config),
        vault: Mutex::new(Vault::new(
            path.with_file_name("vault.enc"),
            Duration::from_secs(timeout * 60),
        )),
        gate: browserdock_launcher::session::SessionGate::default(),
        startup_errors: Mutex::new(startup_errors),
        path,
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            timer.tick().await;
            let state = handle.state::<DesktopState>();
            if let Ok(mut vault) = state.vault.try_lock() {
                vault.expire(Instant::now());
                notify_lock(&handle, &state, &mut vault);
            };
        }
    });
}
