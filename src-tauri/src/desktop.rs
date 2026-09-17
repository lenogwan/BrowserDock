use crate::runtime::{self, DesktopState, Settings};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn report_window_error(app: &tauri::AppHandle, message: &str) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut errors) = state.startup_errors.lock() {
            if !errors.iter().any(|e| e == message) { errors.push(message.into()); }
        }
    }
    let _ = app.emit("dock-error", message);
}

pub fn summon(app: &tauri::AppHandle, settings: bool) {
    if let Some(w) = app.get_webview_window("main") {
        if w.show().is_err() {
            report_window_error(app, "Cannot show dock. Try the tray control again.");
            return;
        }
        if w.set_focus().is_err() { report_window_error(app, "Dock is visible but could not receive keyboard focus."); }
        if w.emit(
            if settings {
                "show-settings"
            } else {
                "dock-summoned"
            },
            (),
        ).is_err() { report_window_error(app, "Could not refresh the visible dock."); }
    }
}
#[tauri::command]
pub fn dock_hide(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("Dock unavailable")?;
    w.hide().map_err(|_| {
        let message = "Cannot hide dock. The window is still visible.";
        report_window_error(&app, message);
        message.into()
    })
}
#[tauri::command]
pub async fn dock_resize(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    crate::window_sizing::auto_fit(app,height)
}
fn position_at_edge(w: &tauri::WebviewWindow, edge: &str, expected: Option<tauri::PhysicalSize<u32>>) -> Result<(), String> {
    let m = w
        .current_monitor()
        .map_err(|_| "Cannot read monitor")?
        .ok_or("Monitor unavailable")?;
    let a = m.work_area();
    let size = match expected { Some(size) => size, None => w.outer_size().map_err(|_| "Cannot read dock size")? };
    let mut p = w.outer_position().map_err(|_| "Cannot read position")?;
    match edge {
        "left" => p.x = a.position.x,
        "right" => p.x = a.position.x + a.size.width.saturating_sub(size.width) as i32,
        "top" => p.y = a.position.y,
        "bottom" => p.y = a.position.y + a.size.height.saturating_sub(size.height) as i32,
        _ => {}
    }
    w.set_position(p).map_err(|_| "Cannot position dock".into())
}
fn clamp(w: &tauri::WebviewWindow) { clamp_with_size(w, None); }
fn clamp_with_size(w: &tauri::WebviewWindow, expected: Option<tauri::PhysicalSize<u32>>) {
    let size = expected.map(Ok).unwrap_or_else(|| w.outer_size());
    if let (Ok(Some(m)), Ok(p), Ok(s)) = (w.current_monitor(), w.outer_position(), size) {
        let area = m.work_area();
        let min = area.position;
        let max_x = min.x + (area.size.width.saturating_sub(s.width)) as i32;
        let max_y = min.y + (area.size.height.saturating_sub(s.height)) as i32;
        let next = PhysicalPosition::new(p.x.clamp(min.x, max_x), p.y.clamp(min.y, max_y));
        if p != next {
            let _ = w.set_position(next);
        }
    }
}
#[tauri::command]
pub async fn dock_save_position(app: tauri::AppHandle, snap: bool) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("Dock unavailable")?;
    clamp(&w);
    let mut p = w.outer_position().map_err(|_| "Cannot read position")?;
    let mut edge = String::new();
    if snap {
        if let (Ok(Some(m)), Ok(size)) = (w.current_monitor(), w.outer_size()) {
            let a = m.work_area();
            let candidates = [
                ((p.x - a.position.x).abs(), "left"),
                (
                    (p.x - a.position.x - a.size.width.saturating_sub(size.width) as i32).abs(),
                    "right",
                ),
                ((p.y - a.position.y).abs(), "top"),
                (
                    (p.y - a.position.y - a.size.height.saturating_sub(size.height) as i32).abs(),
                    "bottom",
                ),
            ];
            edge = candidates
                .into_iter()
                .min_by_key(|c| c.0)
                .map_or_else(String::new, |c| c.1.into());
            position_at_edge(&w, &edge, None)?;
            p = w.outer_position().map_err(|_| "Cannot read position")?;
        }
    }
    let state = app
        .try_state::<DesktopState>()
        .ok_or("Configuration unavailable")?;
    let mut c = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?;
    let mut next = c.clone();
    next.settings.insert(
        "dock_position".into(),
        serde_json::json!({"x":p.x,"y":p.y,"snapped":snap,"edge":edge}),
    );
    next.save(&state.path)?;
    *c = next;
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let record = |message: String| {
        if let Some(state) = app.try_state::<DesktopState>() {
            if let Ok(mut errors) = state.startup_errors.lock() {
                errors.push(message);
            }
        }
    };
    let settings = {
        let state = app.state::<DesktopState>();
        let c = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        Settings::from_config(&c)
    };
    let summon_result =
        app.global_shortcut()
            .on_shortcut(settings.global_shortcut.as_str(), |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    summon(app, false);
                }
            });
    let panic_result =
        app.global_shortcut()
            .on_shortcut(settings.panic_shortcut.as_str(), |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = dock_hide(app.clone());
                    runtime::lock(app);
                }
            });
    for (label, result) in [("Summon", summon_result), ("Panic lock", panic_result)] {
        if result.is_err() {
            app.state::<DesktopState>().startup_errors.lock().map_err(|_|"Status unavailable")?.push(format!("{label} shortcut is unavailable. Choose another in Settings and restart; tray controls remain available."));
        }
    }
    // Escape is temporarily global after the first press, catching the second
    // press even after the webview loses focus. Never retain the registration.
    use tauri::menu::{Menu, MenuItem};
    let tray_result = (|| -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "Lock Vault", true, None::<&str>)?;
    let prefs = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &lock, &prefs, &exit])?;
    let mut tray = tauri::tray::TrayIconBuilder::with_id("browserdock")
        .tooltip("BrowserDock")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if app
                    .get_webview_window("main")
                    .is_some_and(|w| w.is_visible().unwrap_or(false))
                {
                    let _ = dock_hide(app.clone());
                } else {
                    summon(app, false);
                }
            }
            "lock" => runtime::lock(app),
            "settings" => summon(app, true),
            "exit" => {
                runtime::lock(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
    })();
    if let Err(error) = tray_result { record(format!("System tray unavailable: {error}")); }
    if let Some(w) = app.get_webview_window("main") {
        let state = app.state::<DesktopState>();
        let config = state
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?;
        if let Err(error) = w.set_always_on_top(settings.always_on_top) {
            record(format!("Could not configure always-on-top: {error}"));
        }
        if let Some(position) = config.settings.get("dock_position") {
            if let (Some(x), Some(y)) = (
                position.get("x").and_then(|v| v.as_i64()),
                position.get("y").and_then(|v| v.as_i64()),
            ) {
                if let Err(error) = w.set_position(PhysicalPosition::new(
                    x.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                    y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                )) {
                    record(format!("Could not restore dock position: {error}"));
                }
            }
        }
        drop(config);
        if let Err(error) = tauri::async_runtime::block_on(dock_resize(app.clone(), 56.)) {
            record(format!("Could not size dock: {error}"));
        }
        if let Err(error) = w.show() {
            record(format!("Could not show dock: {error}"));
        }
    }
    Ok(())
}
#[tauri::command]
pub fn dock_escape(app: tauri::AppHandle) -> Result<(), String> {
    if app.global_shortcut().is_registered("Escape") {
        runtime::lock(&app);
        return dock_hide(app);
    }
    let result = app
        .global_shortcut()
        .on_shortcut("Escape", |app, _, event| {
            if event.state == ShortcutState::Pressed {
                runtime::lock(app);
            }
        });
    // If another application owns Escape, fail safe by locking immediately.
    if result.is_err() {
        runtime::lock(&app);
    }
    let hidden = dock_hide(app.clone());
    if result.is_ok() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let _ = app.global_shortcut().unregister("Escape");
        });
    }
    hidden
}

// startDragging resolves after posting the native drag message, not on mouse-up.
#[tauri::command]
pub fn dock_drag_finished() -> bool {
    #[cfg(windows)]
    {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
            let primary = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                2
            } else {
                1
            };
            windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(primary) >= 0
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}
