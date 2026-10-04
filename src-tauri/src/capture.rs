//! Explicit, public bookmark capture from an authenticated companion.
use crate::{config::Config, groups, options::BrowserOptions, vault::Bookmark};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};
use zeroize::Zeroize;

#[derive(Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum CaptureRequest {
    #[serde(rename = "CAPTURE_BATCH")]
    Batch {
        id: String,
        group_id: Option<String>,
        items: Vec<CaptureItem>,
    },
    #[serde(rename = "CAPTURE_GROUPS")]
    Groups { id: String },
    #[serde(rename = "CAPTURE_SAVE")]
    Save {
        id: String,
        title: String,
        url: String,
        group_id: Option<String>,
        incognito: bool,
        container: Option<String>,
    },
}
impl CaptureRequest {
    pub fn id(&self) -> &str {
        match self {
            Self::Groups { id } | Self::Save { id, .. } | Self::Batch { id, .. } => id,
        }
    }
    pub fn valid_id(&self) -> bool {
        uuid::Uuid::parse_str(self.id())
            .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == self.id())
    }
}
impl Drop for CaptureRequest {
    fn drop(&mut self) {
        match self {
            Self::Groups { id } => id.zeroize(),
            Self::Batch {
                id,
                group_id,
                items,
            } => {
                id.zeroize();
                group_id.zeroize();
                items.clear();
            }
            Self::Save {
                id,
                title,
                url,
                group_id,
                container,
                ..
            } => {
                id.zeroize();
                title.zeroize();
                url.zeroize();
                group_id.zeroize();
                container.zeroize();
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub container: Option<String>,
}
impl Drop for CaptureItem {
    fn drop(&mut self) {
        self.id.zeroize();
        self.title.zeroize();
        self.url.zeroize();
        self.container.zeroize();
    }
}

pub type CaptureHandler =
    dyn Fn(&str, &CaptureRequest, Instant) -> Result<Value, String> + Send + Sync;
pub type CaptureBridge = Arc<Mutex<Option<Arc<CaptureHandler>>>>;

/// Caller holds the shared config lock. Commit memory only after atomic disk save.
pub fn capture_public(
    config: &mut Config,
    path: &Path,
    browser: &str,
    request: &CaptureRequest,
    deadline: Instant,
) -> Result<Value, String> {
    crate::portable::ensure_no_pending_restore(path)?;
    if Instant::now() >= deadline {
        return Err("Capture expired. Reopen the popup.".into());
    }
    if !request.valid_id() {
        return Err("Invalid capture request".into());
    }
    if !matches!(browser, "firefox" | "mullvad" | "chrome" | "edge")
        || !config.browsers.iter().any(|item| item.id == browser)
    {
        return Err("Choose a configured browser in BrowserDock".into());
    }
    if let CaptureRequest::Batch {
        group_id, items, ..
    } = request
    {
        if items.is_empty() || items.len() > 50 {
            return Err("Select between 1 and 50 tabs".into());
        }
        let mut next = config.clone();
        let (mut added, mut duplicates) = (0, 0);
        let mut ids = std::collections::HashSet::new();
        for item in items {
            if !ids.insert(&item.id) {
                return Err("Duplicate capture ID".into());
            }
            let single = CaptureRequest::Save {
                id: item.id.clone(),
                title: item.title.clone(),
                url: item.url.clone(),
                group_id: group_id.clone(),
                incognito: false,
                container: item.container.clone(),
            };
            let (prepared, result) = prepare_public(&next, browser, &single)?;
            next = prepared;
            if result["result"] == "SAVED" {
                added += 1;
            } else {
                duplicates += 1;
            }
        }
        if Instant::now() >= deadline {
            return Err("Capture expired. Refresh before saving.".into());
        }
        if added > 0 {
            next.save(path).map_err(|_| {
                "Could not save bookmarks. Check BrowserDock's configuration storage."
            })?;
            *config = next;
        }
        return Ok(json!({"result":"BATCH_SAVED", "added":added, "duplicates":duplicates}));
    }
    let (next, result) = prepare_public(config, browser, request)?;
    if result["result"] == "SAVED" {
        if Instant::now() >= deadline {
            return Err("Capture expired. Reopen the popup.".into());
        }
        next.save(path)
            .map_err(|_| "Could not save bookmark. Check BrowserDock's configuration storage.")?;
        *config = next;
    }
    Ok(result)
}

fn prepare_public(
    config: &Config,
    browser: &str,
    request: &CaptureRequest,
) -> Result<(Config, Value), String> {
    if !request.valid_id() {
        return Err("Invalid capture request".into());
    }
    let CaptureRequest::Save {
        id,
        title,
        url,
        group_id,
        incognito,
        container,
    } = request
    else {
        let mut groups = config.groups.iter().collect::<Vec<_>>();
        groups.sort_by_key(|group| (group.sort_order, group.id.as_str()));
        return Ok((
            config.clone(),
            json!({"groups": groups.iter().map(|group| json!({"id":group.id,"name":group.name})).collect::<Vec<_>>()}),
        ));
    };
    if *incognito {
        return Err(
            "Private-window tabs cannot be saved to public bookmarks. Use BrowserDock's vault."
                .into(),
        );
    }
    if container.is_some() && !matches!(browser, "firefox" | "mullvad") {
        return Err("Containers require Firefox or Mullvad".into());
    }
    groups::validate_target(&config.groups, group_id.as_deref())?;
    let bookmark = Bookmark {
        id: id.clone(),
        title: title.trim().into(),
        url: url.clone(),
        target_browser: browser.into(),
        tags: vec![],
        icon: String::new(),
        group_id: group_id.clone(),
        parent_id: None,
        sort_order: 0,
        pinned: false,
        browser_options: container.as_ref().map(|container| BrowserOptions {
            profile: None,
            container: Some(container.clone()),
            incognito: None,
        }),
    };
    bookmark.validate()?;
    let mut bookmarks: Vec<Bookmark> = config
        .bookmarks
        .iter()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect();
    let same_destination = |existing: &Bookmark| {
        existing.url == bookmark.url
            && existing.target_browser == bookmark.target_browser
            && existing.group_id == bookmark.group_id
            && existing
                .browser_options
                .as_ref()
                .and_then(|options| options.profile.as_ref())
                .is_none()
            && existing
                .browser_options
                .as_ref()
                .and_then(|options| options.container.as_ref())
                == container.as_ref()
            && !existing
                .browser_options
                .as_ref()
                .and_then(|options| options.incognito)
                .unwrap_or(false)
    };
    if let Some(existing) = bookmarks.iter().find(|existing| existing.id == *id) {
        return if same_destination(existing) {
            Ok((config.clone(), json!({"result":"ALREADY_SAVED"})))
        } else {
            Err("Capture ID is already used. No bookmark was changed.".into())
        };
    }
    if bookmarks.iter().any(same_destination) {
        return Ok((config.clone(), json!({"result":"ALREADY_SAVED"})));
    }
    if config
        .bookmarks
        .iter()
        .any(|value| value.get("id").and_then(Value::as_str) == Some(id))
    {
        return Err("Capture ID is already used".into());
    }
    if config.bookmarks.len() >= 1000 {
        return Err("Bookmark limit reached".into());
    }
    let mut bookmark = bookmark;
    bookmark.sort_order = bookmarks
        .iter()
        .filter(|entry| entry.group_id == *group_id && entry.parent_id.is_none())
        .map(|entry| entry.sort_order)
        .max()
        .map_or(0, |order| order.saturating_add(1));
    groups::save_bookmark(&mut bookmarks, &config.groups, bookmark)?;
    let saved = bookmarks
        .iter()
        .find(|entry| entry.id == *id)
        .ok_or("Cannot prepare bookmark")?;
    let mut next = config.clone();
    next.bookmarks
        .push(serde_json::to_value(saved).map_err(|_| "Cannot prepare bookmark")?);
    groups::patch_organization(&mut next.bookmarks, &bookmarks);
    Ok((next, json!({"result":"SAVED"})))
}
