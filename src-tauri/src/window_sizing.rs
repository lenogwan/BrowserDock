//! Live size previews and one-write gesture commits. Lock order is config, then size.
use crate::runtime::DesktopState;
use browserdock_launcher::{config::Config, settings::Settings, window_size::{SizeState,WindowSize}};
use tauri::{Manager,LogicalSize,PhysicalPosition};

pub(crate) fn apply(
    window:&tauri::WebviewWindow, config:&Config, state:&mut SizeState,
    requested:WindowSize, auto_height:Option<f64>,
) -> Result<(),String> {
    requested.validate()?;
    let monitor=window.current_monitor().map_err(|_| "Cannot read monitor")?
        .or_else(||window.primary_monitor().ok().flatten()).ok_or("Monitor unavailable")?;
    let area=monitor.work_area();
    let scale=window.scale_factor().map_err(|_| "Cannot read dock scale")?;
    let (width,height)=(area.size.width as f64 / scale,area.size.height as f64 / scale);
    let bounded=requested.clamped(width,height)?;
    let previous=state.requested;
    state.requested=bounded;
    let target_height=if let Some(h)=auto_height { state.auto_fit(h,height) } else {Ok(state.display_height(height))};
    let result=(|| {
        let physical=LogicalSize::new(bounded.width,target_height?).to_physical::<u32>(scale);
        let mut position=window.outer_position().map_err(|_| "Cannot read dock position")?;
        let max_x=area.position.x+area.size.width.saturating_sub(physical.width) as i32;
        let max_y=area.position.y+area.size.height.saturating_sub(physical.height) as i32;
        if let Some(saved)=config.settings.get("dock_position") {
            if saved.get("snapped").and_then(|v|v.as_bool())==Some(true) {
                match saved.get("edge").and_then(|v|v.as_str()) {
                    Some("left")=>position.x=area.position.x,
                    Some("right")=>position.x=max_x,
                    Some("top")=>position.y=area.position.y,
                    Some("bottom")=>position.y=max_y,
                    _=>{}
                }
            }
        }
        position=PhysicalPosition::new(position.x.clamp(area.position.x,max_x),position.y.clamp(area.position.y,max_y));
        window.set_size(physical).map_err(|_| "Cannot resize dock")?;
        window.set_position(position).map_err(|_| "Cannot keep dock in the monitor work area")?;
        Ok(())
    })();
    if result.is_err() {state.requested=previous;}
    result
}

pub fn auto_fit(app:tauri::AppHandle,height:f64) -> Result<(),String> {
    if !height.is_finite() || height<=0.0 {return Err("Dock size must be finite".into());}
    let desktop=app.try_state::<DesktopState>().ok_or("Configuration unavailable")?;
    let config=desktop.config.lock().map_err(|_|"Configuration unavailable")?;
    let mut size=desktop.size.lock().map_err(|_|"Window size unavailable")?;
    let window=app.get_webview_window("main").ok_or("Dock unavailable")?;
    let requested=size.requested;
    apply(&window,&config,&mut size,requested,Some(height))
}

// Keep all sizing commands off the UI thread: auto_fit/save_settings can hold
// config and size while waiting for a window getter on that thread. A synchronous
// command waiting for those locks would prevent the getter from ever completing.
#[tauri::command]
pub async fn dock_set_size(app:tauri::AppHandle,width:f64,height:Option<f64>) -> Result<(),String> {
    let requested=WindowSize {width,height};requested.validate()?;
    let desktop=app.try_state::<DesktopState>().ok_or("Configuration unavailable")?;
    let config=desktop.config.lock().map_err(|_|"Configuration unavailable")?;
    let mut size=desktop.size.lock().map_err(|_|"Window size unavailable")?;
    let window=app.get_webview_window("main").ok_or("Dock unavailable")?;
    apply(&window,&config,&mut size,requested,None)
}

#[tauri::command]
pub async fn dock_cancel_size(app:tauri::AppHandle) -> Result<(),String> {
    let desktop=app.try_state::<DesktopState>().ok_or("Configuration unavailable")?;
    let config=desktop.config.lock().map_err(|_|"Configuration unavailable")?;
    let mut size=desktop.size.lock().map_err(|_|"Window size unavailable")?;
    let window=app.get_webview_window("main").ok_or("Dock unavailable")?;
    apply(&window,&config,&mut size,Settings::from_config(&config).window_size,None)
}

#[tauri::command]
pub async fn dock_commit_size(app:tauri::AppHandle) -> Result<(),String> {
    let desktop=app.try_state::<DesktopState>().ok_or("Configuration unavailable")?;
    let mut config=desktop.config.lock().map_err(|_|"Configuration unavailable")?;
    let size=desktop.size.lock().map_err(|_|"Window size unavailable")?;
    let window=app.get_webview_window("main").ok_or("Dock unavailable")?;
    let point=window.outer_position().map_err(|_|"Cannot read position")?;
    let mut position=config.settings.get("dock_position").filter(|v|v.is_object()).cloned()
        .unwrap_or_else(||serde_json::json!({"snapped":false}));
    position["x"]=serde_json::json!(point.x);position["y"]=serde_json::json!(point.y);
    *config=size.commit(&config,&desktop.path,position)?;
    Ok(())
}
