//! Public UI settings, excluding the companion authentication token.
use crate::config::Config;
use serde::{Deserialize, Serialize};
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
                .unwrap_or("Ctrl+Shift+Space")
                .into(),
            panic_shortcut: c
                .settings
                .get("panic_shortcut")
                .and_then(|v| v.as_str())
                .unwrap_or("Ctrl+Alt+L")
                .into(),
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
        Ok(())
    }
}
