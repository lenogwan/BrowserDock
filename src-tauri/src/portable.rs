//! Local library interchange. Archives contain no machine settings or pairing secrets.
use crate::{
    config::Config,
    groups::{self, Group},
    vault::Bookmark,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_FILE: u64 = 12 * 1024 * 1024;
const MAX_VAULT: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Archive {
    format: String,
    version: u8,
    pub bookmarks: Vec<serde_json::Value>,
    pub groups: Vec<Group>,
    pub vault_hex: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportItem {
    pub title: String,
    pub url: String,
    pub folder: Option<String>,
}
#[derive(Serialize)]
pub struct ImportSummary {
    pub added: usize,
    pub duplicates: usize,
    pub groups_added: usize,
}

/// A live process must not mutate files that startup recovery may later roll back.
pub(crate) fn ensure_no_pending_restore(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    match fs::symlink_metadata(parent.join("restore-pending.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect restore recovery state; no changes were made".into()),
        Ok(_) => {
            Err("Restore recovery is pending. Restart BrowserDock before further changes.".into())
        }
    }
}
struct ArchiveWriter(Vec<u8>);
impl Write for ArchiveWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_FILE as usize - self.0.len() {
            return Err(std::io::Error::other("Backup exceeds 12 MB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn read_bounded(path: &Path, max: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read backup source".into()),
    };
    let mut data = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Cannot read backup source")?;
    if data.len() as u64 > max {
        return Err("Backup source is too large".into());
    }
    Ok(Some(data))
}
fn validate_library(
    bookmarks: &[serde_json::Value],
    groups: &[Group],
    config: &Config,
) -> Result<(), String> {
    if bookmarks.len() > 1000 {
        return Err("At most 1000 bookmarks are supported".into());
    }
    groups::validate_groups(groups)?;
    let typed = bookmarks
        .iter()
        .map(|value| {
            Bookmark::deserialize(value)
                .map_err(|_| "Repair unreadable public bookmarks before backup or restore")
        })
        .collect::<Result<Vec<_>, _>>()?;
    groups::validate_tree(&typed)?;
    let mut ids = std::collections::HashSet::new();
    for bookmark in &typed {
        bookmark.validate()?;
        groups::validate_target(groups, bookmark.group_id.as_deref())?;
        if !ids.insert(&bookmark.id) {
            return Err("Duplicate bookmark ID".into());
        }
        if !config
            .browsers
            .iter()
            .any(|b| b.id == bookmark.target_browser)
        {
            return Err("Backup uses an unconfigured browser".into());
        }
    }
    Ok(())
}
pub fn export(config: &Config, vault_path: &Path) -> Result<String, String> {
    ensure_no_pending_restore(vault_path)?;
    validate_library(&config.bookmarks, &config.groups, config)?;
    let vault = read_bounded(vault_path, MAX_VAULT as u64)?;
    if vault.as_ref().is_some_and(|bytes| bytes.len() < 44) {
        return Err("Invalid encrypted vault data".into());
    }
    // Borrow public data; preserve future fields without duplicating large JSON entries.
    #[derive(Serialize)]
    struct Export<'a> {
        format: &'static str,
        version: u8,
        bookmarks: &'a [serde_json::Value],
        groups: &'a [Group],
        vault_hex: Option<String>,
    }
    let archive = Export {
        format: "BrowserDock library",
        version: 1,
        bookmarks: &config.bookmarks,
        groups: &config.groups,
        vault_hex: vault.map(|bytes| bytes.iter().map(|b| format!("{b:02x}")).collect()),
    };
    let mut writer = ArchiveWriter(Vec::new());
    serde_json::to_writer(&mut writer, &archive).map_err(|error| {
        if error.is_io() {
            "Backup exceeds the 12 MB restore limit"
        } else {
            "Cannot encode backup"
        }
    })?;
    String::from_utf8(writer.0).map_err(|_| "Cannot encode backup".into())
}
/// Save an archive through a staged, flushed file. A unique name and
/// no-clobber commit preserve every previous backup in the Downloads folder.
pub fn export_to_directory(
    config: &Config,
    vault_path: &Path,
    directory: &Path,
) -> Result<PathBuf, String> {
    let archive = export(config, vault_path)?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Cannot create backup folder {}: {error}",
            directory.display()
        )
    })?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = directory.join(format!(
        "browserdock-library-{timestamp}-{}.json",
        uuid::Uuid::new_v4()
    ));
    let mut staged = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("Cannot prepare backup in {}: {error}", directory.display()))?;
    staged
        .write_all(archive.as_bytes())
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|error| format!("Cannot write backup in {}: {error}", directory.display()))?;
    staged
        .persist_noclobber(&path)
        .map_err(|error| format!("Cannot save backup {}: {error}", path.display()))?;
    Ok(path)
}

pub fn preview(text: &str, config: &Config) -> Result<Archive, String> {
    if text.len() as u64 > MAX_FILE {
        return Err("Backup is too large".into());
    }
    let archive: Archive =
        serde_json::from_str(text).map_err(|_| "Invalid BrowserDock library backup")?;
    if archive.format != "BrowserDock library" || archive.version != 1 {
        return Err("Unsupported backup format".into());
    }
    validate_library(&archive.bookmarks, &archive.groups, config)?;
    vault_bytes(&archive)?;
    Ok(archive)
}
fn vault_bytes(archive: &Archive) -> Result<Option<Vec<u8>>, String> {
    archive
        .vault_hex
        .as_ref()
        .map(|hex| {
            if hex.len() < 88
                || hex.len() > MAX_VAULT * 2
                || hex.len() % 2 != 0
                || !hex.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid encrypted vault data".into());
            }
            (0..hex.len())
                .step_by(2)
                .map(|index| {
                    u8::from_str_radix(&hex[index..index + 2], 16)
                        .map_err(|_| "Invalid encrypted vault data".into())
                })
                .collect()
        })
        .transpose()
}
pub fn prepare_import(
    config: &Config,
    items: &[ImportItem],
    browser: &str,
    group_id: Option<&str>,
    folders: bool,
) -> Result<(Config, ImportSummary), String> {
    if items.is_empty() || items.len() > 1000 {
        return Err("Import 1–1000 bookmarks at a time".into());
    }
    if !config.browsers.iter().any(|b| b.id == browser) {
        return Err("Choose a configured browser".into());
    }
    groups::validate_target(&config.groups, group_id)?;
    let mut next = config.clone();
    let mut summary = ImportSummary {
        added: 0,
        duplicates: 0,
        groups_added: 0,
    };
    let mut typed: Vec<Bookmark> = next
        .bookmarks
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    for item in items {
        let target = if folders {
            match &item.folder {
                Some(name) => {
                    if name.trim().is_empty() || name.chars().count() > 64 {
                        return Err("Imported folder names must be 1–64 characters".into());
                    }
                    if let Some(group) = next.groups.iter().find(|g| g.name == *name) {
                        Some(group.id.clone())
                    } else {
                        let group = Group {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: name.clone(),
                            color: String::new(),
                            sort_order: next.groups.len() as u32,
                            collapsed: false,
                        };
                        let id = group.id.clone();
                        groups::save_group(&mut next.groups, group)?;
                        summary.groups_added += 1;
                        Some(id)
                    }
                }
                None => group_id.map(str::to_owned),
            }
        } else {
            group_id.map(str::to_owned)
        };
        let mut bookmark = Bookmark {
            id: uuid::Uuid::new_v4().to_string(),
            title: item.title.trim().into(),
            url: item.url.clone(),
            target_browser: browser.into(),
            tags: vec![],
            icon: String::new(),
            group_id: target,
            parent_id: None,
            sort_order: 0,
            browser_options: None,
            pinned: false,
        };
        bookmark.validate()?;
        let duplicate = typed.iter().any(|b| {
            b.url == bookmark.url
                && b.target_browser == bookmark.target_browser
                && b.group_id == bookmark.group_id
                && b.browser_options.as_ref().is_none_or(|o| {
                    o.profile.is_none() && o.container.is_none() && !o.incognito.unwrap_or(false)
                })
        });
        if duplicate {
            summary.duplicates += 1;
            continue;
        }
        if next.bookmarks.len() >= 1000 {
            return Err("Import would exceed 1000 public bookmarks".into());
        }
        bookmark.sort_order = typed
            .iter()
            .filter(|b| b.group_id == bookmark.group_id && b.parent_id.is_none())
            .map(|b| b.sort_order)
            .max()
            .map_or(0, |n| n.saturating_add(1));
        next.bookmarks
            .push(serde_json::to_value(&bookmark).map_err(|_| "Cannot prepare import")?);
        typed.push(bookmark);
        summary.added += 1;
    }
    Ok((next, summary))
}
fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid backup path")?)
        .map_err(|_| "Cannot stage backup data")?;
    file.write_all(data)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot write backup data")?;
    file.persist(path)
        .map_err(|_| "Cannot commit backup data")?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct Journal {
    directory: String,
    config_existed: bool,
    vault_existed: bool,
}
/// Before startup, roll back any interrupted two-file restore using durable snapshots.
pub fn recover_restore(config_path: &Path) -> Result<(), String> {
    let parent = config_path.parent().ok_or("Invalid config path")?;
    let journal_path = parent.join("restore-pending.json");
    let Some(bytes) = read_bounded(&journal_path, 1024)? else {
        return Ok(());
    };
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid restore journal; repair before starting BrowserDock")?;
    if !journal.directory.starts_with("restore-backup-")
        || uuid::Uuid::parse_str(&journal.directory[15..]).is_err()
    {
        return Err("Invalid restore journal directory".into());
    }
    let directory = parent.join(&journal.directory);
    let mut recovery = Vec::new();
    for (path, name, existed, max) in [
        (
            config_path.to_path_buf(),
            "config.json",
            journal.config_existed,
            MAX_FILE,
        ),
        (
            config_path.with_file_name("vault.enc"),
            "vault.enc",
            journal.vault_existed,
            MAX_VAULT as u64,
        ),
    ] {
        let bytes = if existed {
            Some(
                read_bounded(&directory.join(name), max)?
                    .ok_or("Restore recovery file is missing")?,
            )
        } else {
            None
        };
        recovery.push((path, bytes));
    }
    for (path, bytes) in recovery {
        if let Some(bytes) = bytes {
            atomic_write(&path, &bytes)?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|_| "Cannot roll back restore")?;
        }
    }
    fs::remove_file(journal_path).map_err(|_| "Cannot finish restore recovery")?;
    Ok(())
}
pub fn restore(
    config: &mut Config,
    path: &Path,
    text: &str,
    restore_vault: bool,
) -> Result<String, String> {
    ensure_no_pending_restore(path)?;
    let archive = preview(text, config)?;
    let blob = if restore_vault {
        Some(vault_bytes(&archive)?.ok_or("This backup contains no vault")?)
    } else {
        None
    };
    let mut next = config.clone();
    next.bookmarks = archive.bookmarks.clone();
    next.groups = archive.groups.clone();
    let parent = path.parent().ok_or("Invalid config path")?;
    let directory_name = format!("restore-backup-{}", uuid::Uuid::new_v4());
    let directory = parent.join(&directory_name);
    fs::create_dir(&directory).map_err(|_| "Cannot create recovery backup")?;
    let old_config = read_bounded(path, MAX_FILE)?;
    let vault_path = path.with_file_name("vault.enc");
    let old_vault = read_bounded(&vault_path, MAX_VAULT as u64)?;
    if let Some(bytes) = &old_config {
        atomic_write(&directory.join("config.json"), bytes)?;
    }
    if let Some(bytes) = &old_vault {
        atomic_write(&directory.join("vault.enc"), bytes)?;
    }
    let journal = Journal {
        directory: directory_name,
        config_existed: old_config.is_some(),
        vault_existed: old_vault.is_some(),
    };
    let journal_path = parent.join("restore-pending.json");
    atomic_write(
        &journal_path,
        &serde_json::to_vec(&journal).map_err(|_| "Cannot prepare recovery")?,
    )?;
    let result = (|| {
        if let Some(blob) = blob {
            atomic_write(&vault_path, &blob)?;
        }
        next.save_for_restore(path)?;
        fs::remove_file(&journal_path).map_err(|_| "Cannot finish restore")?;
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        return match recover_restore(path) {
            Ok(()) => Err(error),
            Err(_) => Err(
                "Restore failed; recovery is pending. Restart BrowserDock before further changes."
                    .into(),
            ),
        };
    }
    *config = next;
    Ok(directory.display().to_string())
}
