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
            .then(bookmarks[a].sort_order.cmp(&bookmarks[b].sort_order))
            .then(bookmarks[a].title.cmp(&bookmarks[b].title))
            .then(bookmarks[a].id.cmp(&bookmarks[b].id))
    });
    let mut previous: Option<usize> = None;
    let mut order = 0;
    for index in indices {
        if previous.is_some_and(|p| bookmarks[p].group_id == bookmarks[index].group_id) {
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
    index: u32,
) -> Result<(), String> {
    validate_target(groups, group_id.as_deref())?;
    let moving = bookmarks
        .iter()
        .position(|b| b.id == id)
        .ok_or("Bookmark does not exist")?;
    let mut indices: Vec<_> = (0..bookmarks.len())
        .filter(|&i| i != moving && bookmarks[i].group_id == group_id)
        .collect();
    indices.sort_by(|&a, &b| {
        bookmarks[a]
            .sort_order
            .cmp(&bookmarks[b].sort_order)
            .then(bookmarks[a].title.cmp(&bookmarks[b].title))
            .then(bookmarks[a].id.cmp(&bookmarks[b].id))
    });
    indices.insert((index as usize).min(indices.len()), moving);
    bookmarks[moving].group_id = group_id;
    for (order, i) in indices.into_iter().enumerate() {
        bookmarks[i].sort_order = order as u32;
    }
    normalize_bookmarks(bookmarks);
    Ok(())
}
