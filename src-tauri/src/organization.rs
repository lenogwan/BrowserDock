//! Scoped bookmark organization commands. Writes commit only after durable storage succeeds.
use crate::runtime::{notify_lock, DesktopState};
use browserdock_launcher::{
    config::Browser,
    groups::{self, Group},
    vault::Bookmark,
};
use std::time::Instant;
use tauri::Manager;

enum Mutation {
    Save(Group),
    Delete(String),
    Move {
        id: String,
        group_id: Option<String>,
        parent_id: Option<Option<String>>,
        index: u32,
    },
}

async fn mutate(app: tauri::AppHandle, private: bool, operation: Mutation) -> Result<(), String> {
    let epoch = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable")?
        .gate
        .ticket();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        if private {
            let mut vault = state.vault.lock().map_err(|_| "Vault unavailable")?;
            if !epoch.is_some_and(|ticket| state.gate.valid(ticket)) {
                return Err("Vault is locked".into());
            }
            let now = Instant::now();
            let result = match operation {
                Mutation::Save(group) => vault.save_group(group, now),
                Mutation::Delete(id) => vault.delete_group(&id, now),
                Mutation::Move {
                    id,
                    group_id,
                    parent_id,
                    index,
                } => vault.move_bookmark(&id, group_id, parent_id, index, now),
            };
            notify_lock(&app, &state, &mut vault);
            return result;
        }
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let mut next = config.clone();
        // Read typed entries for ordering, then patch the original JSON so unknown
        // fields and malformed entries are preserved instead of disappearing.
        let mut bookmarks: Vec<Bookmark> = next
            .bookmarks
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        match operation {
            Mutation::Save(group) => groups::save_group(&mut next.groups, group)?,
            Mutation::Delete(id) => {
                groups::delete_group(&mut next.groups, &mut bookmarks, &id)?;
                // Also ungroup unreadable entries without changing their other fields.
                for value in &mut next.bookmarks {
                    if value.get("group_id").and_then(|v| v.as_str()) == Some(id.as_str()) {
                        value["group_id"] = serde_json::Value::Null;
                    }
                }
            }
            Mutation::Move {
                id,
                group_id,
                parent_id,
                index,
            } => {
                groups::move_bookmark(
                    &mut bookmarks,
                    &next.groups,
                    &id,
                    group_id,
                    parent_id,
                    index,
                )?;
            }
        }
        groups::patch_organization(&mut next.bookmarks, &bookmarks);
        next.save(&state.path)?;
        *config = next;
        Ok(())
    })
    .await
    .map_err(|_| "Organization task failed")?
}

#[tauri::command]
pub async fn save_group(app: tauri::AppHandle, group: Group, private: bool) -> Result<(), String> {
    mutate(app, private, Mutation::Save(group)).await
}
#[tauri::command]
pub async fn delete_group(app: tauri::AppHandle, id: String, private: bool) -> Result<(), String> {
    mutate(app, private, Mutation::Delete(id)).await
}
#[tauri::command]
pub async fn move_bookmark(
    app: tauri::AppHandle,
    id: String,
    group_id: Option<String>,
    index: u32,
    private: bool,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    // Reading the raw envelope distinguishes omitted parentId from explicit null.
    let tauri::ipc::InvokeBody::Json(body) = request.body() else {
        return Err("Expected JSON request".into());
    };
    let parent_id = groups::parent_update(body)?;
    mutate(
        app,
        private,
        Mutation::Move {
            id,
            group_id,
            parent_id,
            index,
        },
    )
    .await
}

#[tauri::command]
pub async fn save_browser(app: tauri::AppHandle, browser: Browser) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<DesktopState>()
            .ok_or("Configuration unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        let mut next = config.clone();
        let existing = next
            .browsers
            .iter_mut()
            .find(|b| b.id == browser.id)
            .ok_or("Choose a configured browser")?;
        // Browser identity is stable: edits affect launch settings only.
        existing.exe_path = browser.exe_path;
        existing.args = browser.args;
        for key in ["profile", "container", "extra_args"] {
            if let Some(value) = browser.extra.get(key) {
                existing.extra.insert(key.into(), value.clone());
            } else {
                existing.extra.remove(key);
            }
        }
        next.save(&state.path)?;
        *config = next;
        Ok(())
    })
    .await
    .map_err(|_| "Browser settings task failed")?
}
