use crate::{launcher, LauncherState};

#[derive(serde::Serialize)]
pub(crate) struct CompanionStatus {
    port: Option<u16>,
    error: Option<String>,
    instances: Vec<launcher::ws_server::Instance>,
}

#[derive(serde::Serialize)]
pub(crate) struct CompanionDigest {
    error: Option<String>,
    instances: Vec<launcher::ws_server::InstanceDigest>,
}

#[tauri::command]
pub(crate) fn companion_tabs_digest(state: tauri::State<'_, LauncherState>) -> CompanionDigest {
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
pub(crate) fn companion_status(state: tauri::State<'_, LauncherState>) -> CompanionStatus {
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
