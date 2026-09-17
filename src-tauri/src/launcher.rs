//! Phase 3 backend, compiled independently so routing/configuration tests do
//! not require a desktop runtime. Phase 4 will dispatch to extensions first.
pub mod config;
pub mod options;
pub mod groups;
pub mod pairing;
pub mod settings;
pub mod window_size;
pub mod crypto;
pub mod detection;
pub mod dispatch;
pub mod routing;
pub mod session;
pub mod vault;
mod ws_protocol;
pub mod ws_server;

use config::Config;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
pub struct LaunchPlan {
    pub browser_id: String,
    pub exe_path: String,
    pub args: Vec<String>,
    pub url: String,
    pub resolved_profile: Option<String>,
    pub resolved_container: Option<String>,
    pub resolved_incognito: bool,
}

pub fn target_browser(
    config: &Config,
    input: &str,
    override_id: Option<&str>,
) -> Result<String, String> {
    let url = routing::parse_url(input)?;
    let id = override_id.unwrap_or_else(|| routing::route(&url, &config.routing_rules));
    if !config.browsers.iter().any(|b| b.id == id) {
        return Err(format!("Browser '{id}' is not configured"));
    }
    Ok(id.into())
}

#[derive(Clone, Debug, Serialize)]
pub struct RouteDetails {
    pub browser_id: String,
    pub profile: Option<String>,
    pub container: Option<String>,
    pub incognito: bool,
}

pub fn route_details(config: &Config, input: &str, override_id: Option<&str>, overrides: Option<&options::BrowserOptions>) -> Result<RouteDetails, String> {
    let browser_id = target_browser(config, input, override_id)?;
    let browser = config.browsers.iter().find(|b| b.id == browser_id).ok_or("Browser is not configured")?;
    let defaults = options::defaults(browser)?;
    let url = routing::parse_url(input)?;
    let rule = if override_id.is_none() { config.routing_rules.iter().filter(|r| routing::matches_pattern(&r.pattern, &url)).min_by(|a,b| a.priority.cmp(&b.priority).then(a.id.cmp(&b.id))) } else { None };
    let rule_options = rule.map(options::rule_options).transpose()?.flatten();
    if let Some(o) = overrides { o.validate()?; }
    let sources = [overrides, rule_options.as_ref(), Some(&defaults)];
    let profile = sources.iter().flatten().find_map(|o| o.profile.as_ref().filter(|v| !v.is_empty())).cloned();
    let container = sources.iter().flatten().find_map(|o| o.container.as_ref().filter(|v| !v.is_empty())).cloned();
    let incognito = sources.iter().flatten().find_map(|o| o.incognito).unwrap_or(false);
    Ok(RouteDetails { profile: if matches!(browser_id.as_str(), "chrome" | "edge") { profile } else { None }, container: if matches!(browser_id.as_str(), "firefox" | "mullvad") { container } else { None }, browser_id, incognito })
}

pub fn prepare_launch(config: &Config, input: &str, override_id: Option<&str>) -> Result<LaunchPlan,String> {
    prepare_launch_with_options(config, input, override_id, None)
}

pub fn prepare_launch_with_options(
    config: &Config,
    input: &str,
    override_id: Option<&str>,
    overrides: Option<&options::BrowserOptions>,
) -> Result<LaunchPlan, String> {
    let details = route_details(config, input, override_id, overrides)?;
    let browser_id = details.browser_id;
    let browser = config
        .browsers
        .iter()
        .find(|b| b.id == browser_id)
        .ok_or("Browser is not configured")?;
    let exe_path = if browser.exe_path.is_empty() {
        detection::detect_browsers()
            .into_iter()
            .find(|b| b.id == browser_id)
            .map(|b| b.exe_path)
            .ok_or_else(|| {
                format!("Browser '{browser_id}' is not installed; set its exe_path in config.json")
            })?
    } else {
        browser.exe_path.clone()
    };
    if !Path::new(&exe_path).is_absolute() || !Path::new(&exe_path).is_file() {
        return Err(format!(
            "Browser '{browser_id}' executable is missing or not an absolute path"
        ));
    }
    let mut args = browser.args.clone();
    args.extend(options::extra_args(browser)?);
    if let Some(profile) = &details.profile { args.push(format!("--profile-directory={profile}")); }
    if details.incognito {
        if matches!(browser_id.as_str(), "firefox" | "mullvad") { args.retain(|a| a != "-new-tab"); args.push("-private-window".into()); }
        else { args.push("--incognito".into()); }
    }
    Ok(LaunchPlan {
        browser_id,
        exe_path,
        args,
        resolved_profile: details.profile,
        resolved_container: details.container,
        resolved_incognito: details.incognito,
        url: routing::parse_url(input)?.to_string(),
    })
}

pub fn build_command(
    exe_path: &str,
    input: &str,
    extra_args: &[String],
) -> Result<Command, String> {
    let url = routing::parse_url(input)?;
    let mut command = Command::new(exe_path);
    command.args(extra_args).arg(url.as_str());
    // Browser output can include sensitive URLs. Do not inherit dock logging.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

pub fn launch_browser(exe_path: &str, url: &str, extra_args: &[String]) -> Result<(), String> {
    let mut child = build_command(exe_path, url, extra_args)?
        .spawn()
        .map_err(|error| format!("Could not start browser: {error}"))?;
    // Browser launchers often exit immediately after forwarding to an existing
    // instance. Reap a quickly-exiting forwarder without blocking the dock.
    // A still-running child is the live browser itself: on Windows dropping
    // the handle does not affect the process, so no waiter thread is kept per
    // launch (repeated launches used to accumulate one thread each for the
    // lifetime of the browser). On other platforms a detached reaper avoids
    // zombies; this path is dev-only since the target OS is Windows.
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            #[cfg(windows)]
            std::mem::forget(child);
            #[cfg(not(windows))]
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(_) => {}
    }
    Ok(())
}

pub fn launch_url(
    config: &Config,
    input: &str,
    override_id: Option<&str>,
) -> Result<String, String> {
    let plan = prepare_launch(config, input, override_id)?;
    launch_browser(&plan.exe_path, &plan.url, &plan.args)?;
    Ok(plan.browser_id)
}

/// Profile discovery is a hint only: failures never prevent launching.
pub async fn browser_profiles(config: &Config, companion: Option<&ws_server::ServerHandle>, browser_id: &str) -> Vec<String> {
    if !config.browsers.iter().any(|b| b.id == browser_id) { return vec![]; }
    if matches!(browser_id, "firefox" | "mullvad") {
        let mut names: Vec<_> = companion.map(|c| c.instances().into_iter().filter(|i| i.browser == browser_id).flat_map(|i| i.containers.into_iter().map(|c| c.name)).collect()).unwrap_or_default();
        names.sort(); names.dedup(); return names;
    }
    let Some(base) = std::env::var_os("LOCALAPPDATA") else { return vec![]; };
    let suffix = match browser_id { "chrome" => "Google/Chrome/User Data/Local State", "edge" => "Microsoft/Edge/User Data/Local State", _ => return vec![] };
    let path = std::path::PathBuf::from(base).join(suffix);
    // `Local State` is megabytes of JSON; re-parse at most when it changed.
    let fingerprint = std::fs::metadata(&path).ok().map(|m| (m.modified().ok(), m.len()));
    if let Some((cached_print, checked, profiles)) = profiles_cache_get(browser_id) {
        if cached_print == fingerprint && checked.elapsed() < PROFILES_CACHE_TTL {
            return profiles;
        }
    }
    let parsed = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        let Ok(file) = std::fs::File::open(path) else { return vec![]; };
        if file.take(4 * 1024 * 1024).read_to_end(&mut bytes).is_err() { return vec![]; }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return vec![]; };
        value.pointer("/profile/info_cache").and_then(|v| v.as_object()).map(|m| m.keys().filter(|s| options::valid_name(s)).take(200).cloned().collect()).unwrap_or_default()
    }).await.unwrap_or_default();
    profiles_cache_put(browser_id, fingerprint, parsed.clone());
    parsed
}

type ProfilesFingerprint = Option<(Option<std::time::SystemTime>, u64)>;
const PROFILES_CACHE_TTL: Duration = Duration::from_secs(30);
static PROFILES_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (ProfilesFingerprint, Instant, Vec<String>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn profiles_cache_get(browser_id: &str) -> Option<(ProfilesFingerprint, Instant, Vec<String>)> {
    PROFILES_CACHE.lock().ok()?.get(browser_id).cloned()
}

fn profiles_cache_put(browser_id: &str, fingerprint: ProfilesFingerprint, profiles: Vec<String>) {
    if let Ok(mut cache) = PROFILES_CACHE.lock() {
        cache.insert(browser_id.to_owned(), (fingerprint, Instant::now(), profiles));
    }
}
