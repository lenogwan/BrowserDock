use crate::{detection::detect_browsers, groups::Group, routing::RoutingRule};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Browser {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub args: Vec<String>,
    pub color: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Browser {
    pub fn defaults() -> Vec<Self> {
        [
            ("firefox", "Firefox", "#FF7139"),
            ("mullvad", "Mullvad Browser", "#218838"),
            ("chrome", "Google Chrome", "#4285F4"),
            ("edge", "Microsoft Edge", "#0078D7"),
        ]
        .into_iter()
        .map(|(id, name, color)| Self {
            id: id.into(),
            name: name.into(),
            color: color.into(),
            exe_path: String::new(),
            args: if id == "firefox" {
                vec!["-new-tab".into()]
            } else {
                vec![]
            },
            extra: Map::new(),
        })
        .collect()
    }
}

// Settings/bookmarks retain the complete schema and future fields without
// introducing vault or UI behavior in this phase. Never return settings via IPC.
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: String,
    pub settings: Map<String, Value>,
    pub browsers: Vec<Browser>,
    pub routing_rules: Vec<RoutingRule>,
    pub bookmarks: Vec<Value>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        // Built entry-by-entry so a schema change can never panic on an
        // `unwrap()` of a hardcoded JSON literal.
        let mut settings = Map::new();
        settings.insert("always_on_top".into(), json!(true));
        settings.insert("global_shortcut".into(), json!("Ctrl+Shift+Space"));
        settings.insert("panic_shortcut".into(), json!("Ctrl+Alt+L"));
        settings.insert("theme".into(), json!("dark"));
        settings.insert(
            "dock_position".into(),
            json!({"x":100,"y":100,"snapped":false}),
        );
        settings.insert("auto_hide".into(), json!(false));
        settings.insert("auto_tab_groups".into(), json!(true));
        settings.insert("hide_on_open".into(), json!(true));
        settings.insert("opacity".into(), json!(1.0));
        settings.insert("window_size".into(), json!({"width":400,"height":null}));
        settings.insert("vault_timeout_minutes".into(), json!(5));
        settings.insert("ws_port".into(), json!(49222));
        settings.insert("auth_token".into(), json!(uuid::Uuid::new_v4().to_string()));
        Self {
            version: "1.1.0".into(),
            settings,
            browsers: Browser::defaults(),
            routing_rules: [
                ("rule-1", "*://*.google.com/*", "chrome", 10),
                ("rule-2", "*://*.onion/*", "mullvad", 20),
                ("rule-3", "*://forbidden-site.org/*", "edge", 30),
                ("rule-4", "*://*.forbidden-site.org/*", "edge", 30),
                ("rule-5", "check.torproject.org", "mullvad", 20),
            ]
            .into_iter()
            .map(|(id, pattern, target_browser, priority)| RoutingRule {
                id: id.into(),
                pattern: pattern.into(),
                target_browser: target_browser.into(),
                priority,
                extra: Map::new(),
            })
            .collect(),
            groups: vec![],
            bookmarks: vec![
                json!({"id":"bm-1","title":"GitHub","url":"https://github.com",
                "target_browser":"firefox","tags":["dev","daily"],"icon":"github"}),
            ],
            extra: Map::new(),
        }
    }
}

pub fn config_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let root = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or("APPDATA is unavailable")?;
    #[cfg(not(windows))]
    let root = directories::BaseDirs::new()
        .ok_or("Config directory is unavailable")?
        .config_dir()
        .to_path_buf();
    Ok(root.join("BrowserDock").join("config.json"))
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !["1.0.0", "1.1.0"].contains(&self.version.as_str()) {
            return Err("Unsupported config version".into());
        }
        crate::groups::validate_groups(&self.groups)?;
        let mut bookmark_ids = HashSet::new();
        for bookmark in &self.bookmarks {
            if let Some(id) = bookmark.get("id").and_then(Value::as_str) {
                if !bookmark_ids.insert(id) {
                    return Err("Duplicate public bookmark ID; give each entry a unique ID in config.json. The existing file was preserved".into());
                }
            }
        }
        let mut ids = HashSet::new();
        for browser in &self.browsers {
            crate::options::validate_browser(browser)?;
            if browser.id.is_empty() || !ids.insert(&browser.id) {
                return Err("Browser IDs must be nonempty and unique".into());
            }
        }
        if !ids.contains(&"firefox".to_string()) {
            return Err("Config must include the Firefox fallback".into());
        }
        let mut rule_ids = HashSet::new();
        for rule in &self.routing_rules {
            crate::options::validate_rule(rule)?;
            if rule.id.is_empty()
                || !rule_ids.insert(&rule.id)
                || rule.pattern.is_empty()
                || !ids.contains(&rule.target_browser)
            {
                return Err(
                    "Routing rules need unique IDs, patterns and configured browser targets".into(),
                );
            }
        }
        Ok(())
    }

    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                let mut config: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid config.json; existing file was preserved")?;
                config.validate()?;
                config.settings.entry("hide_on_open").or_insert(json!(true));
                config.settings.entry("opacity").or_insert(json!(1.0));
                if config.version == "1.0.0" {
                    for (index, bookmark) in config.bookmarks.iter_mut().enumerate() {
                        if let Some(object) = bookmark.as_object_mut() {
                            object.entry("group_id").or_insert(Value::Null);
                            object.entry("sort_order").or_insert(json!(index));
                        }
                    }
                    config.version = "1.1.0".into();
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| "Invalid system clock")?
                        .as_nanos();
                    let backup = path.with_file_name(format!(
                        "{}.bak.{timestamp}",
                        path.file_name()
                            .ok_or("Invalid config path")?
                            .to_string_lossy()
                    ));
                    let mut backup_options = fs::OpenOptions::new();
                    backup_options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        backup_options.mode(0o600);
                    }
                    let mut file = backup_options
                        .open(backup)
                        .map_err(|_| "Cannot back up config; original preserved")?;
                    file.write_all(&bytes)
                        .and_then(|()| file.sync_all())
                        .map_err(|_| "Cannot back up config; original preserved")?;
                    config.save(path)?;
                }
                Ok(config)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut config = Self::default();
                for found in detect_browsers() {
                    if let Some(browser) = config.browsers.iter_mut().find(|b| b.id == found.id) {
                        *browser = found;
                    }
                }
                let temporary = config.write_temporary(path)?;
                match temporary.persist_noclobber(path) {
                    Ok(_) => Ok(config),
                    Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                        Self::load_or_create(path)
                    }
                    Err(error) => Err(format!("Cannot create config: {}", error.error)),
                }
            }
            Err(error) => Err(format!("Cannot read config: {error}")),
        }
    }

    fn write_temporary(&self, path: &Path) -> Result<tempfile::NamedTempFile, String> {
        self.validate()?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, self).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        Ok(file)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.write_temporary(path)?
            .persist(path)
            .map_err(|e| format!("Cannot save config: {}", e.error))?;
        Ok(())
    }
}
