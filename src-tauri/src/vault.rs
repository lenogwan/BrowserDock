use crate::{
    crypto,
    groups::{self, Group},
    options::BrowserOptions,
    routing::parse_url,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct Bookmark {
    pub id: String,
    pub title: String,
    pub url: String,
    pub target_browser: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub sort_order: u32,
    #[serde(default)]
    pub browser_options: Option<BrowserOptions>,
    /// User pin: pinned bookmarks sort first. Defaults false for legacy entries.
    #[serde(default)]
    pub pinned: bool,
}
impl Drop for Bookmark {
    fn drop(&mut self) {
        self.id.zeroize();
        self.title.zeroize();
        self.url.zeroize();
        self.target_browser.zeroize();
        self.tags.zeroize();
        self.icon.zeroize();
        self.group_id.zeroize();
    }
}
impl Bookmark {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.title.trim().is_empty()
            || self.title.len() > 512
            || self.url.len() > 2048
            || self.tags.len() > 20
            || self.tags.iter().any(|t| t.len() > 128)
            || self.icon.len() > 64
            || self.target_browser.is_empty()
            || self.target_browser.len() > 128
        {
            return Err("Bookmark fields are empty or too long".into());
        }
        if let Some(options) = &self.browser_options {
            options.validate()?;
        }
        if self
            .group_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Invalid group ID".into());
        }
        parse_url(&self.url).map_err(|_| "Bookmark needs a valid HTTP(S) URL")?;
        Ok(())
    }
}
#[derive(Deserialize)]
struct VaultPayload {
    #[serde(default = "legacy_version")]
    version: u8,
    bookmarks: Vec<Bookmark>,
    #[serde(default)]
    groups: Vec<Group>,
}
fn legacy_version() -> u8 {
    1
}
struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    bookmarks: Vec<Bookmark>,
    groups: Vec<Group>,
    activity: Instant,
}
#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub locked: bool,
    pub retry_after_seconds: u64,
}
pub struct Vault {
    path: PathBuf,
    unlocked: Option<Unlocked>,
    timeout: Duration,
    failures: u8,
    lock_event: bool,
    blocked_until: Option<Instant>,
}
impl Vault {
    pub fn new(path: PathBuf, timeout: Duration) -> Self {
        Self {
            path,
            unlocked: None,
            timeout,
            failures: 0,
            lock_event: false,
            blocked_until: None,
        }
    }
    pub fn lock(&mut self) {
        self.lock_event |= self.unlocked.is_some();
        self.unlocked = None;
    }
    pub fn take_lock_event(&mut self) -> bool {
        std::mem::take(&mut self.lock_event)
    }
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }
    pub fn expire(&mut self, now: Instant) -> bool {
        if self
            .unlocked
            .as_ref()
            .is_some_and(|v| now.saturating_duration_since(v.activity) >= self.timeout)
        {
            self.lock();
            true
        } else {
            false
        }
    }
    pub fn activity(&mut self, now: Instant) {
        self.expire(now);
        if let Some(v) = self.unlocked.as_mut() {
            v.activity = now;
        }
    }
    pub fn status(&mut self, now: Instant) -> VaultStatus {
        self.expire(now);
        VaultStatus {
            exists: self.path.exists(),
            locked: self.unlocked.is_none(),
            retry_after_seconds: self
                .blocked_until
                .map(|t| t.saturating_duration_since(now).as_millis().div_ceil(1000) as u64)
                .unwrap_or(0),
        }
    }
    pub fn create(&mut self, secret: &str, now: Instant) -> Result<(), String> {
        if secret.chars().count() < 8 || secret.len() > 1024 || secret.chars().all(char::is_numeric)
        {
            return Err("Use at least 8 characters; numeric-only secrets are not allowed".into());
        }
        if self.path.exists() {
            return Err("Vault already exists".into());
        }
        let salt = crypto::salt();
        let key = crypto::derive(secret, &salt)?;
        let blob = crypto::encrypt(br#"{"version":2,"bookmarks":[],"groups":[]}"#, &key, &salt)?;
        write_blob(&self.path, &blob, true)?;
        self.unlocked = Some(Unlocked {
            key,
            salt,
            bookmarks: vec![],
            groups: vec![],
            activity: now,
        });
        self.failures = 0;
        self.lock_event = false;
        self.blocked_until = None;
        Ok(())
    }
    pub fn unlock(&mut self, secret: &str, now: Instant) -> Result<(), String> {
        if self.blocked_until.is_some_and(|t| now < t) {
            return Err("Too many attempts. Wait before trying again".into());
        }
        self.lock();
        let result = (|| {
            if secret.len() > 1024 {
                return Err("Cannot unlock vault".into());
            }
            let file = fs::File::open(&self.path).map_err(|_| "Cannot read vault")?;
            let mut blob = vec![];
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut blob)
                .map_err(|_| "Cannot read vault")?;
            if blob.len() < 44 || blob.len() > MAX_BYTES {
                return Err("Cannot unlock vault".into());
            }
            let salt: [u8; 16] = blob[..16].try_into().map_err(|_| "Cannot unlock vault")?;
            let key = crypto::derive(secret, &salt)?;
            let plain = crypto::decrypt(&blob, &key)?;
            // Deserialize directly into zeroizing domain types, avoiding plaintext Value copies.
            let (mut bookmarks, groups) =
                if plain.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'[') {
                    let mut bookmarks: Vec<Bookmark> =
                        serde_json::from_slice(&plain).map_err(|_| "Cannot unlock vault")?;
                    for (index, bookmark) in bookmarks.iter_mut().enumerate() {
                        bookmark.group_id = None;
                        bookmark.sort_order = index as u32;
                    }
                    (bookmarks, vec![])
                } else {
                    let payload: VaultPayload =
                        serde_json::from_slice(&plain).map_err(|_| "Cannot unlock vault")?;
                    if ![1, 2].contains(&payload.version) {
                        return Err("Cannot unlock vault".into());
                    }
                    (payload.bookmarks, payload.groups)
                };
            validate_bookmarks(&bookmarks).map_err(|_| "Cannot unlock vault")?;
            groups::validate_groups(&groups).map_err(|_| "Cannot unlock vault")?;
            for bookmark in &bookmarks {
                groups::validate_target(&groups, bookmark.group_id.as_deref())
                    .map_err(|_| "Cannot unlock vault")?;
            }
            groups::normalize_bookmarks(&mut bookmarks);
            Ok(Unlocked {
                key,
                salt,
                bookmarks,
                groups,
                activity: now,
            })
        })();
        match result {
            Ok(unlocked) => {
                self.unlocked = Some(unlocked);
                self.failures = 0;
                self.lock_event = false;
                self.blocked_until = None;
                Ok(())
            }
            Err(error) => {
                self.failures += 1;
                if self.failures >= 3 {
                    self.blocked_until = Some(now + Duration::from_secs(30));
                    self.failures = 0;
                }
                Err(error)
            }
        }
    }
    pub fn list(&mut self, now: Instant) -> Result<Vec<Bookmark>, String> {
        self.expire(now);
        Ok(self
            .unlocked
            .as_ref()
            .ok_or("Vault is locked")?
            .bookmarks
            .clone())
    }
    pub fn save(&mut self, bookmark: Bookmark, now: Instant) -> Result<(), String> {
        self.expire(now);
        bookmark.validate()?;
        let state = self.unlocked.as_ref().ok_or("Vault is locked")?;
        groups::validate_target(&state.groups, bookmark.group_id.as_deref())?;
        let mut bookmarks = state.bookmarks.clone();
        if let Some(existing) = bookmarks.iter_mut().find(|b| b.id == bookmark.id) {
            *existing = bookmark;
        } else {
            bookmarks.push(bookmark);
        }
        let groups = self
            .unlocked
            .as_ref()
            .ok_or("Vault is locked")?
            .groups
            .clone();
        self.persist(bookmarks, groups, now)
    }
    pub fn delete(&mut self, id: &str, now: Instant) -> Result<(), String> {
        self.expire(now);
        let mut bookmarks = self
            .unlocked
            .as_ref()
            .ok_or("Vault is locked")?
            .bookmarks
            .clone();
        bookmarks.retain(|b| b.id != id);
        let groups = self
            .unlocked
            .as_ref()
            .ok_or("Vault is locked")?
            .groups
            .clone();
        self.persist(bookmarks, groups, now)
    }
    pub fn groups(&mut self, now: Instant) -> Result<Vec<Group>, String> {
        self.expire(now);
        Ok(self
            .unlocked
            .as_ref()
            .ok_or("Vault is locked")?
            .groups
            .clone())
    }
    pub fn save_group(&mut self, group: Group, now: Instant) -> Result<(), String> {
        self.expire(now);
        let state = self.unlocked.as_ref().ok_or("Vault is locked")?;
        let mut groups = state.groups.clone();
        groups::save_group(&mut groups, group)?;
        self.persist(state.bookmarks.clone(), groups, now)
    }
    pub fn delete_group(&mut self, id: &str, now: Instant) -> Result<(), String> {
        self.expire(now);
        let state = self.unlocked.as_ref().ok_or("Vault is locked")?;
        let mut groups = state.groups.clone();
        let mut bookmarks = state.bookmarks.clone();
        groups::delete_group(&mut groups, &mut bookmarks, id)?;
        self.persist(bookmarks, groups, now)
    }
    pub fn move_bookmark(
        &mut self,
        id: &str,
        group_id: Option<String>,
        index: u32,
        now: Instant,
    ) -> Result<(), String> {
        self.expire(now);
        let state = self.unlocked.as_ref().ok_or("Vault is locked")?;
        let groups = state.groups.clone();
        let mut bookmarks = state.bookmarks.clone();
        groups::move_bookmark(&mut bookmarks, &groups, id, group_id, index)?;
        self.persist(bookmarks, groups, now)
    }
    fn persist(
        &mut self,
        mut bookmarks: Vec<Bookmark>,
        groups: Vec<Group>,
        now: Instant,
    ) -> Result<(), String> {
        validate_bookmarks(&bookmarks)?;
        groups::validate_groups(&groups)?;
        for bookmark in &bookmarks {
            groups::validate_target(&groups, bookmark.group_id.as_deref())?;
        }
        groups::normalize_bookmarks(&mut bookmarks);
        let state = self.unlocked.as_ref().ok_or("Vault is locked")?;
        #[derive(Serialize)]
        struct Payload<'a> {
            version: u8,
            bookmarks: &'a [Bookmark],
            groups: &'a [Group],
        }
        let plain = Zeroizing::new(
            serde_json::to_vec(&Payload {
                version: 2,
                bookmarks: &bookmarks,
                groups: &groups,
            })
            .map_err(|_| "Cannot encode vault")?,
        );
        let blob = crypto::encrypt(&plain, &state.key, &state.salt)?;
        if blob.len() > MAX_BYTES {
            return Err("Vault is too large".into());
        }
        write_blob(&self.path, &blob, false)?;
        let state = self.unlocked.as_mut().ok_or("Vault is locked")?;
        state.bookmarks = bookmarks;
        state.groups = groups;
        state.activity = now;
        Ok(())
    }
}
fn validate_bookmarks(bookmarks: &[Bookmark]) -> Result<(), String> {
    if bookmarks.len() > 1000 {
        return Err("At most 1000 private bookmarks are supported".into());
    }
    let mut ids = std::collections::HashSet::new();
    for bookmark in bookmarks {
        bookmark.validate()?;
        if !ids.insert(&bookmark.id) {
            return Err("Duplicate bookmark ID".into());
        }
    }
    Ok(())
}
fn write_blob(path: &Path, blob: &[u8], create: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid vault path")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create vault directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot write vault")?;
    file.write_all(blob)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| "Cannot write vault")?;
    if create {
        file.persist_noclobber(path)
    } else {
        file.persist(path)
    }
    .map_err(|_| "Cannot save vault; existing file preserved")?;
    Ok(())
}
