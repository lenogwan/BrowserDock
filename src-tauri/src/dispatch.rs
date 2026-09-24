use crate::{
    config::Config,
    options::BrowserOptions,
    route_details,
    ws_server::{MatchMode, ServerHandle},
};
use serde::Serialize;
use std::time::{Duration, Instant};

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

pub async fn open_url_with_options(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
    options: Option<&BrowserOptions>,
) -> Result<LaunchOutcome, String> {
    open_url_with_options_guarded(
        config,
        companion,
        input,
        override_id,
        mode,
        options,
        std::sync::Arc::new(|| true),
    )
    .await
}

pub async fn open_url_with_options_guarded(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
    options: Option<&BrowserOptions>,
    still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<LaunchOutcome, String> {
    open_url_with_group_guarded(
        config,
        companion,
        input,
        override_id,
        mode,
        LaunchHints {
            options,
            tab_group: None,
        },
        still_valid,
    )
    .await
}

pub struct LaunchHints<'a> {
    pub options: Option<&'a BrowserOptions>,
    pub tab_group: Option<&'a crate::ws_protocol::TabGroupHint>,
}

pub async fn open_url_with_group_guarded(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
    hints: LaunchHints<'_>,
    still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<LaunchOutcome, String> {
    if !still_valid() {
        return Err("Launch was cancelled".into());
    }
    let LaunchHints { options, tab_group } = hints;
    let details = route_details(config, input, override_id, options)?;
    let browser_id = details.browser_id.clone();
    if let Some(companion) = companion.filter(|_| !details.incognito) {
        if let Some(reply) = companion
            .focus_or_open_with_group(
                &browser_id,
                input,
                mode,
                details.container.as_deref(),
                details.profile.as_deref(),
                tab_group,
            )
            .await?
        {
            if !still_valid() {
                return Err("Launch was cancelled".into());
            }
            if reply.status == "SUCCESS" {
                return Ok(LaunchOutcome {
                    browser_id,
                    result: reply.result,
                    window_id: reply.window_id,
                    tab_id: reply.tab_id,
                    note: reply.note,
                });
            }
        }
    }
    if !still_valid() {
        return Err("Launch was cancelled".into());
    }
    let (config, input, selected) = (config.clone(), input.to_string(), browser_id.clone());
    let resolved = BrowserOptions {
        profile: details.profile,
        container: details.container.clone(),
        incognito: Some(details.incognito),
    };
    tokio::task::spawn_blocking(move || {
        let plan =
            crate::prepare_launch_with_options(&config, &input, Some(&selected), Some(&resolved))?;
        if !still_valid() {
            return Err("Launch was cancelled".into());
        }
        crate::launch_browser(&plan.exe_path, &plan.url, &plan.args)
    })
    .await
    .map_err(|_| "Browser launch task failed")??;
    let note = if tab_group.is_some() {
        Some(if details.incognito {
            format!("Opened normally in {browser_id}; incognito launches cannot use native tab grouping")
        } else {
            format!("Opened normally in {browser_id}; native grouping needs the {browser_id} companion connected")
        })
    } else {
        details
            .container
            .map(|_| "Container needs companion; opened normally".into())
    };
    Ok(LaunchOutcome {
        browser_id,
        result: "PROCESS_STARTED".into(),
        window_id: None,
        tab_id: None,
        note,
    })
}

#[derive(Debug, Serialize)]
pub struct CloseOutcome {
    pub browser_id: String,
    pub result: String,
    pub closed: u32,
    pub note: Option<String>,
}

pub async fn close_url_with_options(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
    options: Option<&BrowserOptions>,
) -> Result<CloseOutcome, String> {
    close_url_with_options_guarded(
        config,
        companion,
        input,
        override_id,
        mode,
        options,
        std::sync::Arc::new(|| true),
    )
    .await
}

/// Close tabs matching `input` through the companion extension. There is no
/// process fallback: closing can only reuse the companion inventory, so a
/// missing companion or no matching tab is reported, never launched.
pub async fn close_url_with_options_guarded(
    config: &Config,
    companion: Option<&ServerHandle>,
    input: &str,
    override_id: Option<&str>,
    mode: MatchMode,
    options: Option<&BrowserOptions>,
    still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<CloseOutcome, String> {
    if !still_valid() {
        return Err("Launch was cancelled".into());
    }
    let details = route_details(config, input, override_id, options)?;
    let browser_id = details.browser_id.clone();
    let Some(companion) = companion else {
        return Err(format!(
            "No companion connected for {browser_id}; cannot close tabs"
        ));
    };
    match companion
        .close_tabs_with_options(
            &browser_id,
            input,
            mode,
            details.container.as_deref(),
            details.profile.as_deref(),
        )
        .await?
    {
        Some(reply) if reply.status == "SUCCESS" => {
            if !still_valid() {
                return Err("Launch was cancelled".into());
            }
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

#[derive(Debug, Serialize)]
pub struct GroupOutcome {
    pub processed: u32,
    pub note: Option<String>,
}

/// Preflight every bookmark before mutating any browser. Mixed routing/options
/// produce separate batches; a dispatched batch is never retried.
pub async fn group_action_guarded(
    config: &Config,
    companion: Option<&ServerHandle>,
    bookmarks: &[crate::vault::Bookmark],
    hint: &crate::ws_protocol::TabGroupHint,
    override_id: Option<&str>,
    close: bool,
    still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<GroupOutcome, String> {
    if !still_valid() {
        return Err("Group action was cancelled".into());
    }
    if bookmarks.is_empty() || bookmarks.len() > 50 || !hint.valid() {
        return Err("Choose a group containing 1–50 bookmarks".into());
    }
    let mut batches: Vec<(crate::RouteDetails, zeroize::Zeroizing<Vec<String>>)> = Vec::new();
    for bookmark in bookmarks {
        bookmark.validate()?;
        let effective = crate::groups::effective_routing(bookmark, bookmarks);
        let details = route_details(
            config,
            &bookmark.url,
            override_id.or(Some(&effective.target_browser)),
            effective.browser_options.as_ref(),
        )?;
        if close && details.incognito {
            return Err(
                "Incognito launches bypass companion grouping; cannot close this group".into(),
            );
        }
        if let Some((_, urls)) = batches.iter_mut().find(|(d, _)| {
            d.browser_id == details.browser_id
                && d.container == details.container
                && d.profile == details.profile
                && d.incognito == details.incognito
        }) {
            urls.push(bookmark.url.clone());
        } else {
            batches.push((details, zeroize::Zeroizing::new(vec![bookmark.url.clone()])));
        }
    }
    // Reserve framing space, and reject oversized batches before any dispatch.
    if batches
        .iter()
        .any(|(_, urls)| serde_json::to_string(&**urls).map_or(true, |s| s.len() > 14000))
    {
        return Err("Tab group request exceeds 16 KB; use a smaller group".into());
    }
    let mut outcome = GroupOutcome {
        processed: 0,
        note: None,
    };
    for (details, urls) in batches {
        if !still_valid() {
            return Err("Group action was cancelled; earlier tabs may have changed".into());
        }
        let response = if let Some(server) = companion.filter(|_| !details.incognito) {
            server
                .group_tabs_guarded(
                    crate::ws_server::GroupCommand {
                        browser: &details.browser_id,
                        urls: &urls,
                        hint,
                        container: details.container.as_deref(),
                        profile: details.profile.as_deref(),
                        close,
                    },
                    still_valid.clone(),
                )
                .await?
        } else {
            None
        };
        if !still_valid() {
            return Err("Group action was cancelled; earlier tabs may have changed".into());
        }
        if let Some(reply) = response {
            outcome.processed += if close {
                reply.closed.unwrap_or(0)
            } else {
                urls.len() as u32
            };
            if reply.note.is_some() {
                outcome.note = reply.note;
            }
        } else if close {
            return Err(format!(
                "No companion connected for {}; earlier batches may have changed",
                details.browser_id
            ));
        } else {
            cold_launch_batch(
                config,
                companion,
                &details,
                &urls,
                hint,
                still_valid.clone(),
                &mut outcome,
            )
            .await?;
        }
    }
    Ok(outcome)
}

/// Cold-start fallback for an open batch no companion could group: launch one
/// process per argv chunk carrying every URL, so the browser opens its tabs
/// together instead of one process per URL. When this is not a private launch
/// and a companion server exists, wait bounded for the fresh browser's
/// companion and group the tabs natively. Regroup attempts reuse exact URLs,
/// so waiting retries cannot duplicate tabs; any ambiguous failure keeps the
/// opened tabs as-is without further retry.
async fn cold_launch_batch(
    config: &Config,
    companion: Option<&ServerHandle>,
    details: &crate::RouteDetails,
    urls: &[String],
    hint: &crate::ws_protocol::TabGroupHint,
    still_valid: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    outcome: &mut GroupOutcome,
) -> Result<(), String> {
    let options = BrowserOptions {
        container: details.container.clone(),
        profile: details.profile.clone(),
        incognito: Some(details.incognito),
    };
    let launched: Vec<String> = urls.to_vec();
    let (config, selected, first) = (
        config.clone(),
        details.browser_id.clone(),
        launched.first().cloned().unwrap_or_default(),
    );
    let launch_guard = still_valid.clone();
    tokio::task::spawn_blocking(move || {
        if !launch_guard() {
            return Err("Group action was cancelled; earlier tabs may have changed".to_string());
        }
        let plan =
            crate::prepare_launch_with_options(&config, &first, Some(&selected), Some(&options))?;
        crate::launch_browser_urls(&plan.exe_path, &launched, &plan.args)
    })
    .await
    .map_err(|_| "Browser launch task failed")??;
    outcome.processed += urls.len() as u32;
    if details.incognito {
        outcome.note = Some(format!(
            "Opened ordinary tabs in {}; incognito launches cannot use native tab grouping",
            details.browser_id
        ));
        return Ok(());
    }
    let Some(server) = companion else {
        outcome.note = Some(format!(
            "Opened ordinary tabs in {}; native grouping needs the {} companion connected",
            details.browser_id, details.browser_id
        ));
        return Ok(());
    };
    const REGROUP_WAIT: Duration = Duration::from_secs(10);
    let start = Instant::now();
    while start.elapsed() < REGROUP_WAIT {
        if !still_valid() {
            return Err("Group action was cancelled; earlier tabs may have changed".into());
        }
        if server
            .instances()
            .iter()
            .any(|i| i.browser == details.browser_id)
        {
            match server
                .group_tabs_guarded(
                    crate::ws_server::GroupCommand {
                        browser: &details.browser_id,
                        urls,
                        hint,
                        container: details.container.as_deref(),
                        profile: details.profile.as_deref(),
                        close: false,
                    },
                    still_valid.clone(),
                )
                .await
            {
                Ok(Some(reply)) => {
                    outcome.note = reply.note;
                    return Ok(());
                }
                // No usable window yet, or the instance vanished between poll
                // and dispatch: keep waiting for the window to open.
                Ok(None) => {}
                Err(error) if error.starts_with("Group action was cancelled") => return Err(error),
                // Any other failure is reported once without further retry.
                Err(_) => break,
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    outcome.note = Some(format!(
        "Opened ordinary tabs in {}; native grouping needs the {} companion connected",
        details.browser_id, details.browser_id
    ));
    Ok(())
}
