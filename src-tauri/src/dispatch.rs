use crate::{
    config::Config,
    route_details,
    options::BrowserOptions,
    ws_server::{MatchMode, ServerHandle},
};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct LaunchOutcome {
    pub browser_id: String,
    pub result: String,
    pub window_id: Option<i64>,
    pub tab_id: Option<i64>,
    pub note: Option<String>,
}

pub async fn open_url(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
) -> Result<LaunchOutcome, String> {
    open_url_with_options(config, companion, input, override_id, mode, None).await
}

pub async fn open_url_with_options(config: &Config, companion: Option<&ServerHandle>, input: &str, override_id: Option<&str>, mode: MatchMode, options: Option<&BrowserOptions>) -> Result<LaunchOutcome,String> {
    open_url_with_options_guarded(config, companion, input, override_id, mode, options, std::sync::Arc::new(|| true)).await
}

pub async fn open_url_with_options_guarded(config: &Config, companion: Option<&ServerHandle>, input: &str, override_id: Option<&str>, mode: MatchMode, options: Option<&BrowserOptions>, still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>) -> Result<LaunchOutcome,String> {
    if !still_valid() { return Err("Launch was cancelled".into()); }
    let details = route_details(config, input, override_id, options)?;
    let browser_id = details.browser_id.clone();
    if let Some(companion) = companion.filter(|_| !details.incognito) {
        if let Some(reply) = companion.focus_or_open_with_options(&browser_id, input, mode, details.container.as_deref(), details.profile.as_deref()).await? {
            if !still_valid() { return Err("Launch was cancelled".into()); }
            if reply.status == "SUCCESS" { return Ok(LaunchOutcome {
                browser_id,
                result: reply.result,
                window_id: reply.window_id,
                tab_id: reply.tab_id,
                note: None,
            }); }
        }
    }
    if !still_valid() { return Err("Launch was cancelled".into()); }
    let (config, input, selected) = (config.clone(), input.to_string(), browser_id.clone());
    let resolved = BrowserOptions { profile: details.profile, container: details.container.clone(), incognito: Some(details.incognito) };
    tokio::task::spawn_blocking(move || {
        let plan = crate::prepare_launch_with_options(&config, &input, Some(&selected), Some(&resolved))?;
        if !still_valid() { return Err("Launch was cancelled".into()); }
        crate::launch_browser(&plan.exe_path, &plan.url, &plan.args)
    })
        .await
        .map_err(|_| "Browser launch task failed")??;
    Ok(LaunchOutcome {
        browser_id,
        result: "PROCESS_STARTED".into(),
        window_id: None,
        tab_id: None,
        note: details.container.map(|_| "Container needs companion; opened normally".into()),
    })
}

#[derive(Debug, Serialize)]
pub struct CloseOutcome {
    pub browser_id: String,
    pub result: String,
    pub closed: u32,
    pub note: Option<String>,
}

pub async fn close_url_with_options(config: &Config, companion: Option<&ServerHandle>, input: &str, override_id: Option<&str>, mode: MatchMode, options: Option<&BrowserOptions>) -> Result<CloseOutcome,String> {
    close_url_with_options_guarded(config, companion, input, override_id, mode, options, std::sync::Arc::new(|| true)).await
}

/// Close tabs matching `input` through the companion extension. There is no
/// process fallback: closing can only reuse the companion inventory, so a
/// missing companion or no matching tab is reported, never launched.
pub async fn close_url_with_options_guarded(config: &Config, companion: Option<&ServerHandle>, input: &str, override_id: Option<&str>, mode: MatchMode, options: Option<&BrowserOptions>, still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>) -> Result<CloseOutcome,String> {
    if !still_valid() { return Err("Launch was cancelled".into()); }
    let details = route_details(config, input, override_id, options)?;
    let browser_id = details.browser_id.clone();
    let Some(companion) = companion else {
        return Err(format!("No companion connected for {browser_id}; cannot close tabs"));
    };
    match companion.close_tabs_with_options(&browser_id, input, mode, details.container.as_deref(), details.profile.as_deref()).await? {
        Some(reply) if reply.status == "SUCCESS" => {
            if !still_valid() { return Err("Launch was cancelled".into()); }
            Ok(CloseOutcome {
                browser_id,
                result: reply.result,
                closed: reply.closed.unwrap_or(0),
                note: None,
            })
        }
        Some(reply) if reply.result == "ERROR_TAB_NOT_FOUND" => Ok(CloseOutcome {
            browser_id,
            result: "TAB_NOT_FOUND".into(),
            closed: 0,
            note: Some("No matching open tab".into()),
        }),
        Some(_) => Err("Companion could not close the tab".into()),
        None => Ok(CloseOutcome {
            browser_id,
            result: "TAB_NOT_FOUND".into(),
            closed: 0,
            note: Some("No matching open tab".into()),
        }),
    }
}
