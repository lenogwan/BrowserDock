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
