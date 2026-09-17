use crate::config::Browser;
use std::path::{Path, PathBuf};

/// Ignore registry arguments, including `%1`; never execute a registry command line.
pub fn executable_from_command(command: &str) -> Option<String> {
    let command = command.trim();
    let path = if let Some(quoted) = command.strip_prefix('"') {
        quoted.split_once('"')?.0
    } else {
        let end = command.to_ascii_lowercase().find(".exe")? + 4;
        if !command[end..].is_empty() && !command[end..].starts_with(char::is_whitespace) {
            return None;
        }
        &command[..end]
    };
    // Require an absolute Windows path, avoiding PATH search and command wrappers.
    if path.as_bytes().get(1) != Some(&b':')
        || !matches!(path.as_bytes().get(2), Some(b'\\' | b'/'))
        || !path.to_ascii_lowercase().ends_with(".exe")
    {
        return None;
    }
    Some(path.into())
}

fn browser_id(path: &Path) -> Option<&'static str> {
    match path.file_name()?.to_str()?.to_ascii_lowercase().as_str() {
        "firefox.exe" => Some("firefox"),
        "mullvadbrowser.exe" => Some("mullvad"),
        "chrome.exe" => Some("chrome"),
        "msedge.exe" => Some("edge"),
        _ => None,
    }
}

#[cfg(windows)]
fn registry_paths() -> Vec<PathBuf> {
    use winreg::{enums::*, RegKey};
    let mut paths = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(root) = RegKey::predef(hive)
                .open_subkey_with_flags(r"SOFTWARE\Clients\StartMenuInternet", KEY_READ | view)
            else {
                continue;
            };
            let mut names: Vec<_> = root.enum_keys().filter_map(Result::ok).collect();
            names.sort();
            for name in names {
                let Ok(key) = root.open_subkey(format!(r"{name}\shell\open\command")) else {
                    continue;
                };
                let Ok(command) = key.get_value::<String, _>("") else {
                    continue;
                };
                if let Some(path) = executable_from_command(&command) {
                    paths.push(path.into());
                }
            }
        }
    }
    paths
}

#[cfg(not(windows))]
fn registry_paths() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(windows)]
fn default_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for variable in [
        "ProgramW6432",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
    ] {
        if let Some(root) = std::env::var_os(variable) {
            for suffix in [
                r"Mozilla Firefox\firefox.exe",
                r"Mullvad Browser\mullvadbrowser.exe",
                r"Mullvad Browser\Browser\mullvadbrowser.exe",
                r"Google\Chrome\Application\chrome.exe",
                r"Microsoft\Edge\Application\msedge.exe",
            ] {
                paths.push(PathBuf::from(&root).join(suffix));
            }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        paths.push(PathBuf::from(home).join(r"Desktop\Mullvad Browser\Browser\mullvadbrowser.exe"));
    }
    paths
}

#[cfg(not(windows))]
fn default_paths() -> Vec<PathBuf> {
    Vec::new()
}

/// Only return browsers whose executable exists. Registry paths win over defaults.
pub fn detect_browsers() -> Vec<Browser> {
    let mut detected = Vec::new();
    for path in registry_paths().into_iter().chain(default_paths()) {
        let Some(id) = browser_id(&path) else {
            continue;
        };
        if path.is_file() && !detected.iter().any(|browser: &Browser| browser.id == id) {
            // `browser_id` only yields ids present in `defaults()`; a schema
            // change must never turn this into a panic, so skip unknown ids.
            let Some(mut browser) = Browser::defaults().into_iter().find(|b| b.id == id) else {
                continue;
            };
            browser.exe_path = path.to_string_lossy().into_owned();
            detected.push(browser);
        }
    }
    detected
}
