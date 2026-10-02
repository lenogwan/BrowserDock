//! Public UI settings, excluding the companion authentication token.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub fn default_dock_shortcuts() -> BTreeMap<String, String> {
    static DEFAULTS: std::sync::LazyLock<BTreeMap<String, String>> =
        std::sync::LazyLock::new(|| {
            let definitions: Vec<serde_json::Value> = serde_json::from_str(include_str!(
                "../../src/lib/features/settings/shortcuts.json"
            ))
            .expect("bundled shortcut definitions must be valid");
            definitions
                .into_iter()
                .map(|item| {
                    (
                        item["id"].as_str().unwrap().to_owned(),
                        item["binding"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        });
    DEFAULTS.clone()
}

pub fn canonical_shortcut(raw: &str) -> Option<String> {
    if raw.len() > 80 {
        return None;
    }
    let mut parts: Vec<_> = raw.split('+').map(str::trim).collect();
    let name = parts.pop()?.to_ascii_lowercase();
    let mut modifiers = HashSet::new();
    for part in parts {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "super" | "meta" | "win" => "Super",
            _ => return None,
        };
        if !modifiers.insert(modifier) {
            return None;
        }
    }
    let name = name
        .strip_prefix("key")
        .filter(|s| s.len() == 1)
        .or_else(|| name.strip_prefix("digit").filter(|s| s.len() == 1))
        .unwrap_or(&name);
    let function_key = name
        .strip_prefix('f')
        .and_then(|s| s.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n))
        && !name.starts_with("f0");
    let key = if (name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric()) || function_key {
        name.to_ascii_uppercase()
    } else {
        [
            "Enter",
            "Escape",
            "Space",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Backspace",
            "Delete",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Insert",
            "Tab",
        ]
        .into_iter()
        .find(|key| key.to_ascii_lowercase() == name)?
        .to_owned()
    };
    let mut result: Vec<String> = ["Ctrl", "Alt", "Shift", "Super"]
        .into_iter()
        .filter(|m| modifiers.contains(m))
        .map(str::to_owned)
        .collect();
    result.push(key);
    Some(result.join("+"))
}

fn validate_binding(raw: &str, action: &str, global: bool) -> Result<String, String> {
    let combo = canonical_shortcut(raw).ok_or_else(|| format!("Invalid shortcut for {action}"))?;
    let key = combo.rsplit('+').next().unwrap();
    if key == "Escape" && (action != "hide" || combo != "Escape") {
        return Err("Escape is reserved for hiding and panic lock".into());
    }
    if key == "Tab"
        || [
            "Ctrl+A",
            "Ctrl+C",
            "Ctrl+V",
            "Ctrl+X",
            "Ctrl+Z",
            "Ctrl+Y",
            "Ctrl+Shift+Z",
            "Ctrl+ArrowLeft",
            "Ctrl+ArrowRight",
            "Ctrl+Shift+ArrowLeft",
            "Ctrl+Shift+ArrowRight",
            "Shift+ArrowLeft",
            "Shift+ArrowRight",
            "Shift+Home",
            "Shift+End",
            "Ctrl+Home",
            "Ctrl+End",
            "Ctrl+Shift+Home",
            "Ctrl+Shift+End",
            "Ctrl+Backspace",
            "Ctrl+Delete",
            "Ctrl+Shift+Backspace",
            "Ctrl+Shift+Delete",
            "Shift+Delete",
            "Shift+Insert",
        ]
        .contains(&combo.as_str())
    {
        return Err("Shortcut is reserved for focus or text editing".into());
    }
    if combo == key
        && !(key.starts_with('F')
            || (!global
                && [
                    "Enter",
                    "Escape",
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                ]
                .contains(&key)))
    {
        return Err("Add a modifier to the shortcut".into());
    }
    if combo.starts_with("Shift+") && key.len() == 1 {
        return Err("Add Ctrl or Alt so typing stays available".into());
    }
    Ok(combo)
}

pub fn normalized_dock_shortcuts(
    raw: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut result = default_dock_shortcuts();
    for (action, binding) in raw {
        if !result.contains_key(action) {
            return Err(format!("Unknown dock shortcut: {action}"));
        }
        result.insert(action.clone(), validate_binding(binding, action, false)?);
    }
    let mut seen = HashSet::new();
    if result.values().any(|binding| !seen.insert(binding)) {
        return Err("Dock shortcuts must differ".into());
    }
    Ok(result)
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub window_size: crate::window_size::WindowSize,
    pub always_on_top: bool,
    #[serde(default = "default_true")]
    pub hide_on_open: bool,
    #[serde(default = "default_true")]
    pub auto_tab_groups: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    pub auto_hide: bool,
    pub vault_timeout_minutes: u64,
    pub global_shortcut: String,
    pub panic_shortcut: String,
    #[serde(default = "default_dock_shortcuts")]
    pub dock_shortcuts: BTreeMap<String, String>,
}
impl Settings {
    pub fn from_config(c: &Config) -> Self {
        Self {
            theme: c
                .settings
                .get("theme")
                .and_then(|v| v.as_str())
                .filter(|s| VALID_THEMES.contains(s))
                .unwrap_or("sage")
                .into(),
            window_size: crate::window_size::WindowSize::from_value(c.settings.get("window_size"))
                .0,
            always_on_top: c
                .settings
                .get("always_on_top")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            auto_tab_groups: c
                .settings
                .get("auto_tab_groups")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            hide_on_open: c
                .settings
                .get("hide_on_open")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            opacity: c
                .settings
                .get("opacity")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0)
                .clamp(0.3, 1.0),
            auto_hide: c
                .settings
                .get("auto_hide")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            vault_timeout_minutes: c
                .settings
                .get("vault_timeout_minutes")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .clamp(1, 120),
            global_shortcut: c
                .settings
                .get("global_shortcut")
                .and_then(|v| v.as_str())
                .and_then(|binding| validate_binding(binding, "global_shortcut", true).ok())
                .unwrap_or_else(|| "Ctrl+Shift+Space".into()),
            panic_shortcut: c
                .settings
                .get("panic_shortcut")
                .and_then(|v| v.as_str())
                .and_then(|binding| validate_binding(binding, "panic_shortcut", true).ok())
                .unwrap_or_else(|| "Ctrl+Alt+L".into()),
            dock_shortcuts: c
                .settings
                .get("dock_shortcuts")
                .and_then(|raw| {
                    serde_json::from_value::<BTreeMap<String, String>>(raw.clone()).ok()
                })
                .and_then(|raw| normalized_dock_shortcuts(&raw).ok())
                .unwrap_or_else(default_dock_shortcuts),
        }
    }
}
const VALID_THEMES: &[&str] = &["sage", "nord", "amber", "tokyo", "rose"];
fn default_theme() -> String {
    "sage".into()
}
fn default_true() -> bool {
    true
}
fn default_opacity() -> f64 {
    1.0
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        self.window_size.validate()?;
        if !VALID_THEMES.contains(&self.theme.as_str()) {
            return Err("Theme must be one of: sage, nord, amber, tokyo, rose".into());
        }
        if !self.opacity.is_finite() || !(0.3..=1.0).contains(&self.opacity) {
            return Err("Opacity must be 30–100%".into());
        }
        if !(1..=120).contains(&self.vault_timeout_minutes) {
            return Err("Timeout must be 1–120 minutes".into());
        }
        let mut seen = HashMap::new();
        for (action, binding) in [
            (
                "Summon",
                validate_binding(&self.global_shortcut, "global_shortcut", true)?,
            ),
            (
                "Panic lock",
                validate_binding(&self.panic_shortcut, "panic_shortcut", true)?,
            ),
        ] {
            if let Some(previous) = seen.insert(binding, action.to_owned()) {
                return Err(format!("{action} shortcut conflicts with {previous}"));
            }
        }
        let local = normalized_dock_shortcuts(&self.dock_shortcuts)?;
        for (action, binding) in &local {
            if let Some(previous) = seen.insert(binding.clone(), action.clone()) {
                return Err(format!("{action} shortcut conflicts with {previous}"));
            }
        }
        let defaults = default_dock_shortcuts();
        for (index, action) in [
            "route_firefox",
            "route_mullvad",
            "route_chrome",
            "route_edge",
        ]
        .into_iter()
        .enumerate()
        {
            if local.get(action) == defaults.get(action)
                && seen.contains_key(&format!("Alt+{}", index + 1))
            {
                return Err("Shortcut conflicts with a default browser number override".into());
            }
        }
        Ok(())
    }
}
