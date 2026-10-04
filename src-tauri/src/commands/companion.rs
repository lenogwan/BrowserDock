use crate::{launcher, LauncherState};
use tauri::{Emitter, Manager};

pub(crate) fn enable_capture(app: &tauri::AppHandle) {
    let state = app.state::<LauncherState>();
    let Ok(server) = &state.companion else {
        return;
    };
    let app = app.clone();
    server.set_capture_handler(std::sync::Arc::new(move |browser, request, deadline| {
        let state = app
            .try_state::<crate::runtime::DesktopState>()
            .ok_or("BrowserDock configuration is unavailable")?;
        let mut config = state
            .config
            .lock()
            .map_err(|_| "BrowserDock configuration is unavailable")?;
        let result = launcher::capture::capture_public(
            &mut config,
            &state.path,
            browser,
            request,
            deadline,
        )?;
        drop(config);
        if result.get("result").and_then(serde_json::Value::as_str) == Some("SAVED")
            || result
                .get("added")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|n| n > 0)
        {
            let _ = app.emit("bookmarks-changed", ());
        }
        Ok(result)
    }));
}

#[tauri::command]
pub(crate) async fn companion_test_connection(
    browser_id: String,
    state: tauri::State<'_, LauncherState>,
) -> Result<usize, String> {
    state
        .companion
        .as_ref()
        .map_err(Clone::clone)?
        .test_connection(&browser_id)
        .await
}

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
