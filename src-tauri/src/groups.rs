use crate::vault::Bookmark;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use zeroize::Zeroize;

#[derive(Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub sort_order: u32,
    #[serde(default)]
    pub collapsed: bool,
}
impl Drop for Group {
    fn drop(&mut self) {
        self.id.zeroize();
        self.name.zeroize();
        self.color.zeroize();
    }
}
impl Group {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.name.trim().is_empty()
            || self.name.chars().count() > 64
        {
            return Err("Group needs an ID and a name of 1–64 characters".into());
        }
        if !self.color.is_empty()
            && !(self.color.starts_with('#')
                && [4, 7].contains(&self.color.len())
                && self.color[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Group color must be a hex color".into());
        }
        Ok(())
    }
}
pub fn validate_groups(groups: &[Group]) -> Result<(), String> {
    if groups.len() > 50 {
        return Err("At most 50 groups are supported".into());
    }
    let mut ids = HashSet::new();
    for group in groups {
        group.validate()?;
        if !ids.insert(&group.id) {
            return Err("Duplicate group ID".into());
        }
    }
    Ok(())
}
pub fn validate_target(groups: &[Group], group_id: Option<&str>) -> Result<(), String> {
    if group_id.is_some_and(|id| !groups.iter().any(|g| g.id == id)) {
        return Err("Choose an existing group".into());
    }
    Ok(())
}
pub fn save_group(groups: &mut Vec<Group>, group: Group) -> Result<(), String> {
    group.validate()?;
    if groups.len() >= 50 && !groups.iter().any(|g| g.id == group.id) {
        return Err("At most 50 groups are supported".into());
    }
    let index = group.sort_order as usize;
    groups.retain(|g| g.id != group.id);
    groups.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.id.cmp(&b.id)));
    groups.insert(index.min(groups.len()), group);
    for (index, group) in groups.iter_mut().enumerate() {
        group.sort_order = index as u32;
    }
    Ok(())
}
pub fn normalize_bookmarks(bookmarks: &mut [Bookmark]) {
    let mut indices: Vec<_> = (0..bookmarks.len()).collect();
    indices.sort_by(|&a, &b| {
        bookmarks[a]
            .group_id
            .cmp(&bookmarks[b].group_id)
            .then(bookmarks[a].parent_id.cmp(&bookmarks[b].parent_id))
            .then(bookmarks[a].sort_order.cmp(&bookmarks[b].sort_order))
            .then(bookmarks[a].title.cmp(&bookmarks[b].title))
            .then(bookmarks[a].id.cmp(&bookmarks[b].id))
    });
    let mut previous: Option<usize> = None;
    let mut order = 0;
    for index in indices {
        if previous.is_some_and(|p| {
            bookmarks[p].group_id == bookmarks[index].group_id
                && bookmarks[p].parent_id == bookmarks[index].parent_id
        }) {
            order += 1;
        } else {
            order = 0;
        }
        bookmarks[index].sort_order = order;
        previous = Some(index);
    }
}
pub fn delete_group(
    groups: &mut Vec<Group>,
    bookmarks: &mut [Bookmark],
    id: &str,
) -> Result<(), String> {
    if !groups.iter().any(|g| g.id == id) {
        return Err("Group does not exist".into());
    }
    groups.retain(|g| g.id != id);
    for (i, g) in groups.iter_mut().enumerate() {
        g.sort_order = i as u32;
    }
    for bookmark in bookmarks.iter_mut() {
        if bookmark.group_id.as_deref() == Some(id) {
            bookmark.group_id = None;
        }
    }
    normalize_bookmarks(bookmarks);
    Ok(())
}
pub fn move_bookmark(
    bookmarks: &mut [Bookmark],
    groups: &[Group],
    id: &str,
    group_id: Option<String>,
    parent_id: Option<Option<String>>,
    index: u32,
) -> Result<(), String> {
    let mut draft = bookmarks.to_vec();
    let moving = draft
        .iter()
        .position(|b| b.id == id)
        .ok_or("Bookmark does not exist")?;
    let mut item = draft[moving].clone();
    item.group_id = group_id;
    if let Some(parent) = parent_id {
        item.parent_id = parent;
    }
    save_bookmark(&mut draft, groups, item)?;
    let moving = draft
        .iter()
        .position(|b| b.id == id)
        .ok_or("Bookmark does not exist")?;
    let mut indices: Vec<_> = (0..draft.len())
        .filter(|&i| {
            i != moving
                && draft[i].group_id == draft[moving].group_id
                && draft[i].parent_id == draft[moving].parent_id
        })
        .collect();
    indices.sort_by(|&a, &b| {
        draft[a]
            .sort_order
            .cmp(&draft[b].sort_order)
            .then(draft[a].title.cmp(&draft[b].title))
            .then(draft[a].id.cmp(&draft[b].id))
    });
    indices.insert((index as usize).min(indices.len()), moving);
    for (order, i) in indices.into_iter().enumerate() {
        draft[i].sort_order = order as u32;
    }
    normalize_bookmarks(&mut draft);
    bookmarks.clone_from_slice(&draft);
    Ok(())
}

/// The slice is one persistence scope; parents in the other scope cannot resolve.
pub fn validate_parent(bookmark: &Bookmark, bookmarks: &[Bookmark]) -> Result<(), String> {
    let mut seen = HashSet::from([bookmark.id.as_str()]);
    let mut parent = bookmark.parent_id.as_deref();
    let mut depth = 0;
    while let Some(id) = parent {
        if !seen.insert(id) {
            return Err("Bookmark parents cannot form a cycle".into());
        }
        let node = bookmarks
            .iter()
            .find(|b| b.id == id)
            .ok_or("Choose a parent in the same bookmark scope")?;
        if node.group_id != bookmark.group_id {
            return Err("Parent and child must share a group".into());
        }
        depth += 1;
        if depth > 2 {
            return Err("Bookmarks support only root, child and grandchild levels".into());
        }
        parent = node.parent_id.as_deref();
    }
    Ok(())
}

pub fn validate_tree(bookmarks: &[Bookmark]) -> Result<(), String> {
    for bookmark in bookmarks {
        validate_parent(bookmark, bookmarks)?;
    }
    Ok(())
}

/// Tolerant display only; do not rewrite hand-edited config while reading it.
pub fn display_roots(bookmarks: &mut [Bookmark]) -> usize {
    let invalid: Vec<_> = bookmarks
        .iter()
        .enumerate()
        .filter(|(_, b)| validate_parent(b, bookmarks).is_err())
        .map(|(i, _)| i)
        .collect();
    for &i in &invalid {
        bookmarks[i].parent_id = None;
    }
    invalid.len()
}

fn sync_descendant_groups(bookmarks: &mut [Bookmark], id: &str) {
    let mut pending = vec![id.to_owned()];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let group = bookmarks
            .iter()
            .find(|b| b.id == id)
            .and_then(|b| b.group_id.clone());
        for child in bookmarks
            .iter_mut()
            .filter(|b| b.parent_id.as_deref() == Some(&id))
        {
            child.group_id = group.clone();
            pending.push(child.id.clone());
        }
    }
}

/// Work on a draft so failed validation never alters the caller's state.
pub fn save_bookmark(
    bookmarks: &mut Vec<Bookmark>,
    groups: &[Group],
    mut bookmark: Bookmark,
) -> Result<(), String> {
    bookmark.validate()?;
    if let Some(parent) = &bookmark.parent_id {
        bookmark.group_id = bookmarks
            .iter()
            .find(|b| &b.id == parent)
            .ok_or("Choose a parent in the same bookmark scope")?
            .group_id
            .clone();
    }
    validate_target(groups, bookmark.group_id.as_deref())?;
    let id = bookmark.id.clone();
    let mut draft = bookmarks.clone();
    if let Some(existing) = draft.iter_mut().find(|b| b.id == id) {
        *existing = bookmark;
    } else {
        draft.push(bookmark);
    }
    sync_descendant_groups(&mut draft, &id);
    validate_tree(&draft)?;
    normalize_bookmarks(&mut draft);
    *bookmarks = draft;
    Ok(())
}

pub fn delete_bookmark(bookmarks: &mut Vec<Bookmark>, id: &str) -> Result<(), String> {
    let Some(deleted) = bookmarks.iter().find(|b| b.id == id) else {
        return Ok(());
    };
    let parent = deleted.parent_id.clone();
    let group = deleted.group_id.clone();
    let mut children: Vec<_> = bookmarks
        .iter()
        .filter(|b| b.parent_id.as_deref() == Some(id))
        .cloned()
        .collect();
    children.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then(a.title.cmp(&b.title))
            .then(a.id.cmp(&b.id))
    });
    let mut draft: Vec<_> = bookmarks
        .iter()
        .filter(|b| b.id != id && b.parent_id.as_deref() != Some(id))
        .cloned()
        .collect();
    normalize_bookmarks(&mut draft);
    let end = draft
        .iter()
        .filter(|b| b.group_id == group && b.parent_id == parent)
        .count() as u32;
    for (i, mut child) in children.into_iter().enumerate() {
        child.parent_id = parent.clone();
        child.sort_order = end + i as u32;
        draft.push(child);
    }
    validate_tree(&draft)?;
    normalize_bookmarks(&mut draft);
    *bookmarks = draft;
    Ok(())
}

/// Preserve unknown JSON fields and unreadable entries when changing organization.
pub fn patch_organization(values: &mut [serde_json::Value], bookmarks: &[Bookmark]) {
    for bookmark in bookmarks {
        if let Some(value) = values
            .iter_mut()
            .find(|v| v.get("id").and_then(|v| v.as_str()) == Some(&bookmark.id))
        {
            value["group_id"] = serde_json::json!(bookmark.group_id);
            value["parent_id"] = serde_json::json!(bookmark.parent_id);
            value["sort_order"] = serde_json::json!(bookmark.sort_order);
        }
    }
}

pub fn parent_update(body: &serde_json::Value) -> Result<Option<Option<String>>, String> {
    match body.get("parentId") {
        None => Ok(None),
        Some(serde_json::Value::Null) => Ok(Some(None)),
        Some(serde_json::Value::String(id)) if !id.is_empty() && id.len() <= 128 => {
            Ok(Some(Some(id.clone())))
        }
        _ => Err("Invalid parent ID".into()),
    }
}

pub fn bookmark_tree(
    bookmarks: &[Bookmark],
    groups: &[Group],
    id: &str,
) -> Result<(Vec<Bookmark>, crate::ws_server::TabGroupHint), String> {
    let root = bookmarks
        .iter()
        .find(|b| b.id == id)
        .ok_or("Bookmark no longer exists")?;
    let mut pending = vec![root];
    let mut seen = HashSet::new();
    let mut tree = Vec::new();
    while let Some(node) = pending.pop() {
        if !seen.insert(node.id.as_str()) {
            return Err("Bookmark parents cannot form a cycle".into());
        }
        node.validate()?;
        validate_parent(node, bookmarks)?;
        tree.push(node.clone());
        if tree.len() > 50 {
            return Err("A bookmark subtree can open at most 50 URLs including its parent".into());
        }
        let mut children: Vec<_> = bookmarks
            .iter()
            .filter(|b| b.parent_id.as_deref() == Some(&node.id))
            .collect();
        children.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then(a.title.cmp(&b.title))
                .then(a.id.cmp(&b.id))
        });
        pending.extend(children.into_iter().rev());
    }
    let hint = crate::ws_server::TabGroupHint {
        name: root.title.trim().chars().take(64).collect(),
        color: groups
            .iter()
            .find(|g| Some(&g.id) == root.group_id.as_ref())
            .filter(|g| !g.color.is_empty())
            .map(|g| g.color.clone()),
        collapsed: None,
    };
    if !hint.valid() {
        return Err("Bookmark title or group color cannot form a browser tab group".into());
    }
    Ok((tree, hint))
}
