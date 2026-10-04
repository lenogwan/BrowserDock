//! Public library diagnostics and workspace snapshots. No website requests or vault access.
use crate::{
    config::Config,
    groups::{self, Group},
    options::BrowserOptions,
    vault::Bookmark,
    ws_server::PublicTabs,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
pub struct LibraryIssue {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub detail: String,
    pub removable: bool,
}
fn typed(config: &Config) -> Vec<Bookmark> {
    config
        .bookmarks
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect()
}
/// Duplicate destinations include effective launch options and group. Keep the first entry.
pub fn inspect(
    config: &Config,
    instances: &[crate::ws_server::InstanceDigest],
) -> Vec<LibraryIssue> {
    let bookmarks = typed(config);
    let mut issues = vec![];
    let mut destinations = HashMap::new();
    for bookmark in &bookmarks {
        let routing = groups::effective_routing(bookmark, &bookmarks);
        let details = crate::route_details(
            config,
            &bookmark.url,
            Some(&routing.target_browser),
            routing.browser_options.as_ref(),
        );
        if let Ok(details) = &details {
            let key = (
                bookmark.url.clone(),
                details.browser_id.clone(),
                bookmark.group_id.clone(),
                details.profile.clone(),
                details.container.clone(),
                details.incognito,
            );
            if let Some(first) = destinations.get(&key) {
                let has_children = config.bookmarks.iter().any(|value| {
                    value.get("parent_id").and_then(Value::as_str) == Some(&bookmark.id)
                });
                issues.push(LibraryIssue {
                    kind: "duplicate".into(),
                    id: bookmark.id.clone(),
                    title: bookmark.title.clone(),
                    detail: format!("Same destination and group as {first}"),
                    removable: !has_children,
                });
            } else {
                destinations.insert(key, bookmark.title.clone());
            }
            if let Some(container) = &details.container {
                let connected: Vec<_> = instances
                    .iter()
                    .filter(|i| i.browser == details.browser_id)
                    .collect();
                if !connected.is_empty()
                    && !connected.iter().any(|i| {
                        i.containers
                            .iter()
                            .any(|c| c.name == *container || c.cookie_store_id == *container)
                    })
                {
                    issues.push(LibraryIssue {
                        kind: "container".into(),
                        id: bookmark.id.clone(),
                        title: bookmark.title.clone(),
                        detail: format!(
                            "Container {container} is absent from the connected {} companions",
                            details.browser_id
                        ),
                        removable: false,
                    });
                }
            }
        }
        let missing = config
            .browsers
            .iter()
            .find(|b| b.id == routing.target_browser)
            .is_none_or(|b| b.exe_path.is_empty() || !std::path::Path::new(&b.exe_path).is_file());
        if missing || details.is_err() {
            issues.push(LibraryIssue {
                kind: "browser".into(),
                id: bookmark.id.clone(),
                title: bookmark.title.clone(),
                detail: format!(
                    "Check the configured {} browser path and launch options",
                    routing.target_browser
                ),
                removable: false,
            });
        }
    }
    for group in &config.groups {
        // Count unreadable raw entries too: cleanup must not orphan retained data.
        if !config
            .bookmarks
            .iter()
            .any(|v| v.get("group_id").and_then(Value::as_str) == Some(&group.id))
        {
            issues.push(LibraryIssue {
                kind: "empty_group".into(),
                id: group.id.clone(),
                title: group.name.clone(),
                detail: "No public bookmarks in this group".into(),
                removable: true,
            });
        }
    }
    issues
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupSelection {
    pub kind: String,
    pub id: String,
}
pub fn prepare_cleanup(config: &Config, selections: &[CleanupSelection]) -> Result<Config, String> {
    if selections.is_empty() || selections.len() > 1050 {
        return Err("Select cleanup items first".into());
    }
    let issues = inspect(config, &[]);
    let mut seen = HashSet::new();
    let mut next = config.clone();
    for selected in selections {
        if !seen.insert((selected.kind.as_str(), selected.id.as_str()))
            || !issues
                .iter()
                .any(|i| i.kind == selected.kind && i.id == selected.id && i.removable)
        {
            return Err(
                "Cleanup selection changed. Review the library again before removing anything."
                    .into(),
            );
        }
        match selected.kind.as_str() {
            "duplicate" => next
                .bookmarks
                .retain(|v| v.get("id").and_then(Value::as_str) != Some(&selected.id)),
            "empty_group" => next.groups.retain(|g| g.id != selected.id),
            _ => return Err("This issue requires editing, not deletion".into()),
        }
    }
    Ok(next)
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabSelection {
    pub instance_id: String,
    pub tab_id: i64,
    pub url: String,
    pub container: Option<String>,
}
/// Revalidate selection against fresh public-only replies before constructing a new group.
pub fn prepare_workspace(
    config: &Config,
    name: &str,
    selected: &[TabSelection],
    fresh: &[PublicTabs],
) -> Result<(Config, String, usize), String> {
    if selected.is_empty() || selected.len() > 50 {
        return Err("Select between 1 and 50 public tabs".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut next = config.clone();
    let group = Group {
        id: id.clone(),
        name: name.trim().into(),
        color: String::new(),
        sort_order: next.groups.len() as u32,
        collapsed: false,
    };
    groups::save_group(&mut next.groups, group)?;
    let mut seen = HashSet::new();
    let mut destinations = HashSet::new();
    let mut added = 0;
    for item in selected {
        if !seen.insert((&item.instance_id, item.tab_id)) {
            return Err("Duplicate tab selection".into());
        }
        let instance = fresh
            .iter()
            .find(|i| i.instance_id == item.instance_id)
            .ok_or("Companion changed. Refresh the tab list.")?;
        if !matches!(
            instance.browser.as_str(),
            "firefox" | "mullvad" | "chrome" | "edge"
        ) || !config.browsers.iter().any(|b| b.id == instance.browser)
        {
            return Err("Configure this browser before saving a workspace".into());
        }
        let tab = instance
            .tabs
            .iter()
            .find(|t| t.id == item.tab_id && t.url == item.url && t.container == item.container)
            .ok_or("A selected tab changed, closed or became private. Refresh before saving.")?;
        if !tab.valid()
            || (tab.container.is_some()
                && !matches!(instance.browser.as_str(), "firefox" | "mullvad"))
        {
            return Err("Invalid public tab".into());
        }
        if !destinations.insert((&tab.url, &instance.browser, &tab.container)) {
            continue;
        }
        if next.bookmarks.len() >= 1000 {
            return Err("Bookmark limit reached".into());
        }
        let bookmark = Bookmark {
            id: uuid::Uuid::new_v4().to_string(),
            title: tab.title.clone(),
            url: tab.url.clone(),
            target_browser: instance.browser.clone(),
            tags: vec!["workspace".into()],
            icon: String::new(),
            group_id: Some(id.clone()),
            parent_id: None,
            sort_order: added as u32,
            pinned: false,
            browser_options: Some(BrowserOptions {
                profile: None,
                container: tab.container.clone(),
                incognito: Some(false),
            }),
        };
        bookmark.validate()?;
        next.bookmarks
            .push(serde_json::to_value(&bookmark).map_err(|_| "Cannot prepare workspace")?);
        added += 1;
    }
    Ok((next, id, added))
}
