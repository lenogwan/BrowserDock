use browserdock_launcher::{
    config::Config,
    groups::{self, Group},
    organization_history::PublicHistory,
    portable::{self, ImportItem},
    vault::{Bookmark, Vault},
};
use serde_json::json;
use std::time::{Duration, Instant};
fn bookmark(id: &str, parent: Option<&str>) -> Bookmark {
    serde_json::from_value(json!({"id":id,"title":id,"url":format!("https://example.com/{id}"),"target_browser":"firefox","parent_id":parent})).unwrap()
}
fn group() -> Group {
    serde_json::from_value(json!({"id":"work","name":"Work"})).unwrap()
}
fn config() -> Config {
    Config {
        bookmarks: vec![],
        groups: vec![group()],
        ..Config::default()
    }
}
fn item(url: &str) -> ImportItem {
    ImportItem {
        title: "Imported".into(),
        url: url.into(),
        folder: Some("Work".into()),
    }
}

#[test]
fn selection_moves_whole_trees_once_and_preserves_routing() {
    let mut bookmarks = vec![
        bookmark("root", None),
        bookmark("child", Some("root")),
        bookmark("grandchild", Some("child")),
        bookmark("other", None),
    ];
    groups::move_selection(
        &mut bookmarks,
        &[group()],
        &["root".into(), "child".into(), "other".into()],
        Some("work".into()),
    )
    .unwrap();
    assert!(bookmarks
        .iter()
        .all(|b| b.group_id.as_deref() == Some("work")));
    assert_eq!(bookmarks[1].parent_id.as_deref(), Some("root"));
    assert_eq!(bookmarks[2].parent_id.as_deref(), Some("child"));
    assert_eq!(bookmarks[0].sort_order, 0);
    assert_eq!(bookmarks[3].sort_order, 1);
    let before = serde_json::to_value(&bookmarks).unwrap();
    for ids in [
        vec![],
        vec!["missing".into()],
        vec!["root".into(), "root".into()],
    ] {
        assert!(groups::move_selection(&mut bookmarks, &[group()], &ids, None).is_err());
        assert_eq!(serde_json::to_value(&bookmarks).unwrap(), before);
    }
}
#[test]
fn public_undo_restores_deleted_parent_and_unknown_fields_but_rejects_later_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut before = config();
    before.bookmarks = vec![
        serde_json::to_value(bookmark("root", None)).unwrap(),
        serde_json::to_value(bookmark("child", Some("root"))).unwrap(),
        json!({"unreadable":"keep"}),
    ];
    before.bookmarks[0]["future"] = json!(42);
    let mut after = before.clone();
    after.bookmarks.remove(0);
    after.bookmarks[0]["parent_id"] = json!(null);
    let mut history = PublicHistory::default();
    history.record(&before, &after);
    history.undo(&mut after, &path).unwrap();
    assert_eq!(after.bookmarks, before.bookmarks);
    assert!(history.undo(&mut after, &path).is_err());
    history.record(&before, &after);
    after.bookmarks.push(json!({"later":true}));
    let changed = after.bookmarks.clone();
    assert!(history.undo(&mut after, &path).is_err());
    assert_eq!(changed, after.bookmarks);
}
#[test]
fn public_undo_failed_write_can_be_retried_without_memory_change() {
    let dir = tempfile::tempdir().unwrap();
    let before = config();
    let mut after = before.clone();
    after.bookmarks.push(json!({"future":true}));
    let mut history = PublicHistory::default();
    history.record(&before, &after);
    assert!(history.undo(&mut after, dir.path()).is_err());
    assert_eq!(after.bookmarks.len(), 1);
    history
        .undo(&mut after, &dir.path().join("config.json"))
        .unwrap();
    assert!(after.bookmarks.is_empty());
}
#[test]
fn private_undo_is_encrypted_and_disappears_on_lock_and_expiry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(60));
    vault.create("test secret", now).unwrap();
    vault.save_group(group(), now).unwrap();
    vault.save(bookmark("root", None), now).unwrap();
    vault.save(bookmark("child", Some("root")), now).unwrap();
    vault.delete("root", now).unwrap();
    vault.undo(now).unwrap();
    assert_eq!(
        vault.list(now).unwrap()[1].parent_id.as_deref(),
        Some("root")
    );
    vault
        .move_selection(&["root".into()], Some("work".into()), now)
        .unwrap();
    vault.undo(now).unwrap();
    assert!(vault.list(now).unwrap()[0].group_id.is_none());
    vault.delete("root", now).unwrap();
    vault.lock();
    vault.unlock("test secret", now).unwrap();
    assert!(vault.undo(now).is_err());
    vault.delete("child", now).unwrap();
    assert!(vault.undo(now + Duration::from_secs(61)).is_err());
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes.windows(5).any(|s| s == b"child"));
}
#[test]
fn private_intervening_edit_invalidates_undo() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut vault = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(60));
    vault.create("test secret", now).unwrap();
    vault.save(bookmark("root", None), now).unwrap();
    vault.delete("root", now).unwrap();
    vault.save(bookmark("later", None), now).unwrap();
    assert!(vault.undo(now).is_err());
}
#[test]
fn import_skips_duplicates_preserves_raw_entries_and_validates_atomically() {
    let mut current = config();
    current.bookmarks.push(json!({"future":true}));
    let (next, summary) = portable::prepare_import(
        &current,
        &[item("https://example.com/"), item("https://example.com/")],
        "firefox",
        None,
        true,
    )
    .unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(summary.duplicates, 1);
    assert_eq!(summary.groups_added, 0);
    assert_eq!(next.bookmarks[0], current.bookmarks[0]);
    assert_eq!(next.bookmarks[1]["group_id"], "work");
    assert_eq!(current.bookmarks.len(), 1);
    assert!(portable::prepare_import(
        &current,
        &[item("https://example.com/"), item("file:///private")],
        "firefox",
        None,
        true
    )
    .is_err());
    assert_eq!(current.bookmarks.len(), 1);
    let (_, summary) = portable::prepare_import(
        &next,
        &[item("https://example.com/")],
        "firefox",
        None,
        true,
    )
    .unwrap();
    assert_eq!(summary.added, 0);
}
#[test]
fn backup_save_creates_a_complete_archive_and_preserves_previous_downloads() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("vault.enc");
    let encrypted = vec![0xab; 44];
    std::fs::write(&source, &encrypted).unwrap();
    let mut current = config();
    current
        .settings
        .insert("ws_token".into(), json!("pairing-secret"));
    current
        .bookmarks
        .push(serde_json::to_value(bookmark("public", None)).unwrap());
    let downloads = dir.path().join("Downloads");
    let first = portable::export_to_directory(&current, &source, &downloads).unwrap();
    assert_eq!(first.parent(), Some(downloads.as_path()));
    assert!(first
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("browserdock-library-"));
    let first_bytes = std::fs::read(&first).unwrap();
    let text = std::str::from_utf8(&first_bytes).unwrap();
    let archive = portable::preview(text, &current).unwrap();
    assert_eq!(archive.bookmarks.len(), 1);
    assert_eq!(archive.vault_hex.as_deref(), Some("ab".repeat(44).as_str()));
    assert!(!text.contains("pairing-secret"));
    current.bookmarks.clear();
    let second = portable::export_to_directory(&current, &source, &downloads).unwrap();
    assert_ne!(first, second);
    assert_eq!(std::fs::read(&first).unwrap(), first_bytes);
    assert_eq!(
        std::fs::read_dir(&downloads).unwrap().count(),
        2,
        "no staging files remain"
    );
    assert!(
        portable::preview(&std::fs::read_to_string(second).unwrap(), &current)
            .unwrap()
            .bookmarks
            .is_empty()
    );
}

#[test]
fn backup_save_errors_do_not_leave_incomplete_archives() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("vault.enc");
    let downloads = dir.path().join("Downloads");
    let mut invalid = config();
    invalid.bookmarks.push(json!({"unreadable": true}));
    assert!(portable::export_to_directory(&invalid, &source, &downloads).is_err());
    assert!(!downloads.exists(), "validation happens before writing");
    std::fs::write(&downloads, b"existing file").unwrap();
    assert!(portable::export_to_directory(&config(), &source, &downloads).is_err());
    assert_eq!(std::fs::read(&downloads).unwrap(), b"existing file");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn archive_omits_credentials_and_exports_ciphertext_even_when_unlocked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(60));
    vault.create("test secret", now).unwrap();
    vault.save(bookmark("private-secret", None), now).unwrap();
    let mut current = config();
    current
        .settings
        .insert("ws_token".into(), json!("pairing-secret"));
    current
        .extra
        .insert("pairing".into(), json!("pairing-secret"));
    current.browsers[0]
        .extra
        .insert("token".into(), json!("pairing-secret"));
    current
        .bookmarks
        .push(serde_json::to_value(bookmark("public", None)).unwrap());
    current.bookmarks[0]["future"] = json!({"keep":true});
    let text = portable::export(&current, &path).unwrap();
    assert!(!text.contains("pairing-secret"));
    assert!(!text.contains("private-secret"));
    assert!(!text.contains("test secret"));
    let archive = portable::preview(&text, &current).unwrap();
    assert_eq!(archive.bookmarks.len(), 1);
    assert_eq!(archive.bookmarks[0]["future"], json!({"keep":true}));
    assert!(archive.vault_hex.is_some());
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["version"] = json!(99);
    assert!(portable::preview(&value.to_string(), &current).is_err());
    value["version"] = json!(1);
    value["vault_hex"] = json!("xx".repeat(50));
    assert!(portable::preview(&value.to_string(), &current).is_err());
}
#[test]
fn restore_keeps_machine_config_and_recovery_copies_and_preserves_optional_vault() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let vault_path = dir.path().join("vault.enc");
    let mut current = config();
    current
        .settings
        .insert("ws_token".into(), json!("keep-token"));
    current.save(&path).unwrap();
    std::fs::write(&vault_path, vec![7u8; 44]).unwrap();
    let original_config = std::fs::read(&path).unwrap();
    let mut source = config();
    source
        .bookmarks
        .push(serde_json::to_value(bookmark("imported", None)).unwrap());
    let text = portable::export(&source, &dir.path().join("absent.enc")).unwrap();
    let directory = portable::restore(&mut current, &path, &text, false).unwrap();
    assert_eq!(current.bookmarks.len(), 1);
    assert_eq!(current.settings["ws_token"], "keep-token");
    assert_eq!(
        std::fs::read(std::path::Path::new(&directory).join("config.json")).unwrap(),
        original_config
    );
    assert_eq!(std::fs::read(vault_path).unwrap(), vec![7u8; 44]);
    assert!(!dir.path().join("restore-pending.json").exists());
}
#[test]
fn startup_recovers_interrupted_restore_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let folder = format!("restore-backup-{}", uuid::Uuid::new_v4());
    std::fs::create_dir(dir.path().join(&folder)).unwrap();
    std::fs::write(
        dir.path().join(&folder).join("config.json"),
        b"old config bytes",
    )
    .unwrap();
    std::fs::write(&path, b"new config bytes").unwrap();
    std::fs::write(dir.path().join("vault.enc"), b"new vault").unwrap();
    std::fs::write(
        dir.path().join("restore-pending.json"),
        json!({"directory":folder,"config_existed":true,"vault_existed":false}).to_string(),
    )
    .unwrap();
    portable::recover_restore(&path).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"old config bytes");
    assert!(!dir.path().join("vault.enc").exists());
}
#[test]
fn encrypted_vault_restore_roundtrips_original_password_and_preserves_previous_ciphertext() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let source_path = source.path().join("vault.enc");
    let mut source_vault = Vault::new(source_path.clone(), Duration::from_secs(60));
    source_vault.create("source password", now).unwrap();
    source_vault.save(bookmark("hidden", None), now).unwrap();
    let source_bytes = std::fs::read(&source_path).unwrap();
    let text = portable::export(&config(), &source_path).unwrap();
    let path = target.path().join("config.json");
    let vault_path = target.path().join("vault.enc");
    let mut current = config();
    current.save(&path).unwrap();
    let mut old_vault = Vault::new(vault_path.clone(), Duration::from_secs(60));
    old_vault.create("old password", now).unwrap();
    old_vault.lock();
    let previous = std::fs::read(&vault_path).unwrap();
    let directory = portable::restore(&mut current, &path, &text, true).unwrap();
    assert_eq!(std::fs::read(&vault_path).unwrap(), source_bytes);
    assert_eq!(
        std::fs::read(std::path::Path::new(&directory).join("vault.enc")).unwrap(),
        previous
    );
    old_vault.unlock("source password", now).unwrap();
    assert_eq!(old_vault.list(now).unwrap()[0].id, "hidden");
}
#[test]
fn editor_moves_are_undoable_and_bad_archives_leave_files_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut vault = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(60));
    vault.create("test password", now).unwrap();
    vault.save_group(group(), now).unwrap();
    vault.save(bookmark("root", None), now).unwrap();
    let mut moved = bookmark("root", None);
    moved.group_id = Some("work".into());
    vault.save(moved, now).unwrap();
    vault.undo(now).unwrap();
    assert!(vault.list(now).unwrap()[0].group_id.is_none());
    let path = dir.path().join("config.json");
    let mut current = config();
    current.save(&path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let text = portable::export(&current, &dir.path().join("vault.enc")).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["bookmarks"] =
        json!([{"id":"bad","title":"Bad","url":"file:///private","target_browser":"firefox"}]);
    assert!(portable::restore(&mut current, &path, &value.to_string(), true).is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!dir.path().join("restore-pending.json").exists());
}
#[test]
fn failed_second_restore_commit_rolls_back_both_files_and_leaves_memory_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let vault_path = dir.path().join("vault.enc");
    let mut current = config();
    current.save(&path).unwrap();
    std::fs::write(&vault_path, vec![7u8; 44]).unwrap();
    let old_config = std::fs::read(&path).unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("vault.enc"), vec![9u8; 44]).unwrap();
    let text = portable::export(&config(), &source.path().join("vault.enc")).unwrap();
    // Force Config::save to fail after the encrypted vault replacement.
    current.version = "unsupported".into();
    let before = serde_json::to_value(&current).unwrap();
    assert!(portable::restore(&mut current, &path, &text, true).is_err());
    assert_eq!(std::fs::read(path).unwrap(), old_config);
    assert_eq!(std::fs::read(vault_path).unwrap(), vec![7u8; 44]);
    assert_eq!(serde_json::to_value(&current).unwrap(), before);
    assert!(!dir.path().join("restore-pending.json").exists());
}

#[test]
fn pending_recovery_blocks_normal_writes_exports_and_vault_authentication() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let vault_path = dir.path().join("vault.enc");
    let now = Instant::now();
    let current = config();
    current.save(&path).unwrap();
    let mut vault = Vault::new(vault_path.clone(), Duration::from_secs(60));
    vault.create("test password", now).unwrap();
    let archive = portable::export(&current, &vault_path).unwrap();
    let config_bytes = std::fs::read(&path).unwrap();
    let vault_bytes = std::fs::read(&vault_path).unwrap();
    std::fs::write(dir.path().join("restore-pending.json"), b"pending recovery").unwrap();
    assert!(current.save(&path).is_err());
    assert!(Config::load_or_create(&path).is_err());
    assert!(vault.save(bookmark("new", None), now).is_err());
    assert!(portable::export(&current, &vault_path).is_err());
    let request = serde_json::from_value(
        json!({"action":"CAPTURE_GROUPS","id":"ecda3360-3dc8-44d8-b21b-b35ca26bd962"}),
    )
    .unwrap();
    assert!(browserdock_launcher::capture::capture_public(
        &mut current.clone(),
        &path,
        "firefox",
        &request,
        now + Duration::from_secs(5)
    )
    .unwrap_err()
    .contains("Restart BrowserDock"));
    assert!(vault.unlock("test password", now).is_err());
    assert!(vault.status(now).locked);
    let mut missing = Vault::new(dir.path().join("missing.enc"), Duration::from_secs(60));
    assert!(missing.create("test password", now).is_err());
    assert!(!dir.path().join("missing.enc").exists());
    assert!(portable::restore(&mut current.clone(), &path, &archive, true).is_err());
    assert_eq!(std::fs::read(path).unwrap(), config_bytes);
    assert_eq!(std::fs::read(vault_path).unwrap(), vault_bytes);
    std::fs::remove_file(dir.path().join("restore-pending.json")).unwrap();
    current.save(&dir.path().join("config.json")).unwrap();
    vault.unlock("test password", now).unwrap();
}
#[test]
fn a_running_restore_refuses_pending_recovery_without_rewriting_files_or_memory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let vault_path = dir.path().join("vault.enc");
    let mut current = config();
    current
        .settings
        .insert("auth_token".into(), json!("in-memory-token"));
    current.save(&path).unwrap();
    let text = portable::export(&current, &vault_path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let before = serde_json::to_value(&current).unwrap();
    let folder = format!("restore-backup-{}", uuid::Uuid::new_v4());
    std::fs::create_dir(dir.path().join(&folder)).unwrap();
    let mut previous = current.clone();
    previous
        .settings
        .insert("auth_token".into(), json!("recovered-token"));
    std::fs::write(
        dir.path().join(&folder).join("config.json"),
        serde_json::to_vec(&previous).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("restore-pending.json"),
        json!({"directory":folder,"config_existed":true,"vault_existed":false}).to_string(),
    )
    .unwrap();
    assert!(portable::restore(&mut current, &path, &text, false).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(serde_json::to_value(&current).unwrap(), before);
    assert!(dir.path().join("restore-pending.json").exists());
    portable::recover_restore(&path).unwrap();
    assert_eq!(
        Config::load_or_create(&path).unwrap().settings["auth_token"],
        "recovered-token"
    );
}
#[test]
fn exporting_preserved_future_fields_cannot_produce_an_unrestorable_oversized_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mut current = config();
    let mut value = serde_json::to_value(bookmark("public", None)).unwrap();
    value["future"] = json!("x".repeat(12 * 1024 * 1024));
    current.bookmarks.push(value);
    assert!(portable::export(&current, &dir.path().join("vault.enc")).is_err());
}
#[test]
fn missing_recovery_source_cannot_partially_replace_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let vault_path = dir.path().join("vault.enc");
    let folder = format!("restore-backup-{}", uuid::Uuid::new_v4());
    std::fs::create_dir(dir.path().join(&folder)).unwrap();
    std::fs::write(
        dir.path().join(&folder).join("config.json"),
        b"previous config",
    )
    .unwrap();
    std::fs::write(&path, b"current config").unwrap();
    std::fs::write(&vault_path, b"current vault").unwrap();
    std::fs::write(
        dir.path().join("restore-pending.json"),
        json!({"directory":folder,"config_existed":true,"vault_existed":true}).to_string(),
    )
    .unwrap();
    assert!(portable::recover_restore(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"current config");
    assert_eq!(std::fs::read(&vault_path).unwrap(), b"current vault");
    assert!(dir.path().join("restore-pending.json").exists());
}
