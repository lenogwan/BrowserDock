//! IPC adapters for public imports and encrypted library backup/restore.
use crate::runtime::DesktopState;
use browserdock_launcher::portable::{self, ImportItem, ImportSummary};
use serde::Serialize;
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn import_bookmarks(
    app: tauri::AppHandle,
    items: Vec<ImportItem>,
    browser_id: String,
    group_id: Option<String>,
    folders: bool,
    preview: bool,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let (next, summary) =
            portable::prepare_import(&config, &items, &browser_id, group_id.as_deref(), folders)?;
        if !preview {
            next.save(&state.path)?;
            *config = next;
            let _ = app.emit("bookmarks-changed", ());
        }
        Ok(summary)
    })
    .await
    .map_err(|_| "Import task failed")?
}
#[derive(Serialize)]
pub struct BackupPreview {
    bookmarks: usize,
    groups: usize,
    has_vault: bool,
}
#[tauri::command]
pub async fn backup_preview(app: tauri::AppHandle, text: String) -> Result<BackupPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let archive = portable::preview(&text, &config)?;
        Ok(BackupPreview {
            bookmarks: archive.bookmarks.len(),
            groups: archive.groups.len(),
            has_vault: archive.vault_hex.is_some(),
        })
    })
    .await
    .map_err(|_| "Backup task failed")?
}
#[tauri::command]
pub async fn backup_export(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let _vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
        portable::export(&config, &state.path.with_file_name("vault.enc"))
    })
    .await
    .map_err(|_| "Backup task failed")?
}
#[tauri::command]
pub async fn backup_save(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app
            .path()
            .download_dir()
            .map_err(|_| "Cannot locate your Downloads folder")?;
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let _vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
        let path = portable::export_to_directory(
            &config,
            &state.path.with_file_name("vault.enc"),
            &directory,
        )?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Backup save task failed")?
}

#[tauri::command]
pub async fn backup_restore(
    app: tauri::AppHandle,
    text: String,
    restore_vault: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        // Validate before locking or writing. Restoring locks even for a public-only restore.
        portable::preview(&text, &config)?;
        let epoch = state.gate.request_lock();
        let _ = app.emit("vault-locked", ());
        let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
        state.gate.complete_lock(epoch, || {
            vault.lock();
            vault.take_lock_event();
        });
        let mut history = state.history.lock().map_err(|_| "Undo unavailable")?;
        let directory = portable::restore(&mut config, &state.path, &text, restore_vault)?;
        history.clear();
        let _ = app.emit("bookmarks-changed", ());
        Ok(directory)
    })
    .await
    .map_err(|_| "Restore task failed")?
}

#[tauri::command]
pub(crate) fn library_inspect(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::LauncherState>,
) -> Result<Vec<browserdock_launcher::library_tools::LibraryIssue>, String> {
    let config = crate::current_config(&app)?;
    let instances = state
        .companion
        .as_ref()
        .map(|s| s.tabs_digest())
        .unwrap_or_default();
    Ok(browserdock_launcher::library_tools::inspect(
        &config, &instances,
    ))
}
#[tauri::command]
pub(crate) async fn library_cleanup(
    app: tauri::AppHandle,
    selections: Vec<browserdock_launcher::library_tools::CleanupSelection>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let next = browserdock_launcher::library_tools::prepare_cleanup(&config, &selections)?;
        let mut history = state.history.lock().map_err(|_| "Undo unavailable")?;
        next.save(&state.path)?;
        *config = next;
        history.clear();
        let _ = app.emit("bookmarks-changed", ());
        Ok(())
    })
    .await
    .map_err(|_| "Cleanup task failed")?
}
#[tauri::command]
pub(crate) async fn workspace_tabs(
    state: tauri::State<'_, crate::LauncherState>,
) -> Result<Vec<browserdock_launcher::ws_server::PublicTabs>, String> {
    state
        .companion
        .as_ref()
        .map_err(Clone::clone)?
        .all_public_tabs()
        .await
}
#[derive(Serialize)]
pub struct WorkspaceSaved {
    pub group_id: String,
    pub added: usize,
}
#[tauri::command]
pub(crate) async fn workspace_save(
    app: tauri::AppHandle,
    name: String,
    selected: Vec<browserdock_launcher::library_tools::TabSelection>,
    state: tauri::State<'_, crate::LauncherState>,
) -> Result<WorkspaceSaved, String> {
    if selected.is_empty() || selected.len() > 50 {
        return Err("Select between 1 and 50 public tabs".into());
    }
    let server = state.companion.as_ref().map_err(Clone::clone)?;
    let ids: std::collections::HashSet<_> =
        selected.iter().map(|s| s.instance_id.as_str()).collect();
    let ids: Vec<String> = ids.into_iter().map(str::to_owned).collect();
    let fresh = server.public_tabs_for(&ids).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let (next, group_id, added) = browserdock_launcher::library_tools::prepare_workspace(
            &config, &name, &selected, &fresh,
        )?;
        next.save(&state.path)?;
        *config = next;
        let _ = app.emit("bookmarks-changed", ());
        Ok(WorkspaceSaved { group_id, added })
    })
    .await
    .map_err(|_| "Workspace task failed")?
}
