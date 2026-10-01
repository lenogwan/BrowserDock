//! One-step public organization undo, guarded against intervening changes.
use crate::{config::Config, groups::Group};
use serde_json::Value;
use std::path::Path;

#[derive(Default)]
pub struct PublicHistory {
    snapshot: Option<(Vec<Value>, Vec<Value>, Vec<Group>)>,
}
impl PublicHistory {
    pub fn record(&mut self, before: &Config, after: &Config) {
        self.snapshot = Some((
            before.bookmarks.clone(),
            after.bookmarks.clone(),
            after.groups.clone(),
        ));
    }
    pub fn clear(&mut self) {
        self.snapshot = None;
    }
    pub fn undo(&mut self, config: &mut Config, path: &Path) -> Result<(), String> {
        let (before, after, groups) = self.snapshot.as_ref().ok_or("Nothing to undo")?;
        if &config.bookmarks != after
            || serde_json::to_value(&config.groups).ok() != serde_json::to_value(groups).ok()
        {
            self.clear();
            return Err("Bookmarks or groups changed since this action; undo was discarded".into());
        }
        let mut next = config.clone();
        next.bookmarks = before.clone();
        next.save(path)?;
        *config = next;
        self.clear();
        Ok(())
    }
}
