use crate::{config::Browser, routing::RoutingRule};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct BrowserOptions {
    #[serde(default)] pub profile: Option<String>,
    #[serde(default)] pub container: Option<String>,
    #[serde(default)] pub incognito: Option<bool>,
}
impl std::fmt::Debug for BrowserOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("BrowserOptions { .. }") }
}
impl Drop for BrowserOptions {
    fn drop(&mut self) { self.profile.zeroize(); self.container.zeroize(); }
}
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.bytes().all(|c| c.is_ascii_alphanumeric() || b" _.-".contains(&c)) && name != "." && name != ".."
}
impl BrowserOptions {
    pub fn validate(&self) -> Result<(), String> {
        for (label, value) in [("Profile", &self.profile), ("Container", &self.container)] {
            if value.as_ref().is_some_and(|v| !v.is_empty() && !valid_name(v)) { return Err(format!("{label} must be 1–128 letters, digits, spaces, underscores, dots or hyphens")); }
        }
        Ok(())
    }
}
pub fn defaults(browser: &Browser) -> Result<BrowserOptions, String> {
    let value = serde_json::Value::Object(browser.extra.clone());
    let options: BrowserOptions = serde_json::from_value(value).map_err(|_| "Invalid browser launch options")?;
    options.validate()?; Ok(options)
}
pub fn extra_args(browser: &Browser) -> Result<Vec<String>, String> {
    let args: Vec<String> = match browser.extra.get("extra_args") {
        None => vec![], Some(value) => serde_json::from_value(value.clone()).map_err(|_| "extra_args must be a list of strings")?,
    };
    if args.len() > 20 || args.iter().any(|arg| arg.len() > 256 || arg.chars().any(|c| c.is_control() || ";&|`$<>\"'".contains(c))) {
        return Err("Extra arguments allow at most 20 items of 256 characters, without shell metacharacters".into());
    }
    Ok(args)
}
pub fn validate_browser(browser: &Browser) -> Result<(), String> { defaults(browser)?; extra_args(browser)?; Ok(()) }
pub fn rule_options(rule: &RoutingRule) -> Result<Option<BrowserOptions>, String> {
    rule.extra.get("browser_options").filter(|v| !v.is_null()).map(|v| {
        let options: BrowserOptions=serde_json::from_value(v.clone()).map_err(|_| "Invalid routing rule browser options")?;
        options.validate()?; Ok(options)
    }).transpose()
}
pub fn validate_rule(rule: &RoutingRule) -> Result<(), String> { rule_options(rule)?; Ok(()) }
