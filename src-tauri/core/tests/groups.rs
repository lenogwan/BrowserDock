use browserdock_launcher::{
    config::Config,
    groups::{self, Group},
    vault::{Bookmark, Vault},
};
use serde_json::json;
use std::time::{Duration, Instant};
fn bookmark(id: &str) -> Bookmark {
    serde_json::from_value(
        json!({"id":id,"title":id,"url":"https://example.org","target_browser":"firefox"}),
    )
    .unwrap()
}
fn group(id: &str, order: u32) -> Group {
    serde_json::from_value(json!({"id":id,"name":id,"sort_order":order})).unwrap()
}
#[test]
fn group_moves_renumber_and_delete_preserves_bookmarks() {
    let mut groups = vec![];
    groups::save_group(&mut groups, group("work", 0)).unwrap();
    let mut bookmarks = vec![bookmark("a"), bookmark("b"), bookmark("c")];
    groups::move_bookmark(&mut bookmarks, &groups, "b", Some("work".into()), 99).unwrap();
    groups::move_bookmark(&mut bookmarks, &groups, "c", Some("work".into()), 0).unwrap();
    assert_eq!(bookmarks[1].sort_order, 1);
    assert_eq!(bookmarks[2].sort_order, 0);
    assert!(
        groups::move_bookmark(&mut bookmarks, &groups, "a", Some("missing".into()), 0).is_err()
    );
    groups::delete_group(&mut groups, &mut bookmarks, "work").unwrap();
    assert_eq!(bookmarks.len(), 3);
    assert!(bookmarks.iter().all(|b| b.group_id.is_none()));
    let mut orders: Vec<_> = bookmarks.iter().map(|b| b.sort_order).collect();
    orders.sort();
    assert_eq!(orders, vec![0, 1, 2]);
}
#[test]
fn migration_backs_up_original_and_preserves_unknown_bookmarks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut original = serde_json::to_value(Config::default()).unwrap();
    original["version"] = json!("1.0.0");
    original.as_object_mut().unwrap().remove("groups");
    original["settings"]
        .as_object_mut()
        .unwrap()
        .remove("opacity");
    original["settings"]
        .as_object_mut()
        .unwrap()
        .remove("hide_on_open");
    original["future"] = json!({"keep":true});
    original["bookmarks"] =
        json!([{"id":"unrecognized","future":42,"target_browser":"missing"},"opaque"]);
    let bytes = serde_json::to_vec(&original).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let config = Config::load_or_create(&path).unwrap();
    assert_eq!(config.version, "1.1.0");
    assert_eq!(config.bookmarks[0]["future"], 42);
    assert_eq!(config.bookmarks[1], "opaque");
    assert_eq!(config.extra["future"]["keep"], true);
    assert_eq!(config.settings["opacity"], 1.0);
    assert_eq!(config.settings["hide_on_open"], true);
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("config.json.bak.")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(backups[0].path()).unwrap(), bytes);
    Config::load_or_create(&path).unwrap();
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}
#[test]
fn private_groups_encrypt_and_legacy_array_upgrades_on_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let secret = "correct horse battery";
    let salt = browserdock_launcher::crypto::salt();
    let key = browserdock_launcher::crypto::derive(secret, &salt).unwrap();
    let legacy = serde_json::to_vec(&vec![bookmark("private")]).unwrap();
    let blob = browserdock_launcher::crypto::encrypt(&legacy, &key, &salt).unwrap();
    std::fs::write(&path, &blob).unwrap();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(300));
    vault.unlock(secret, now).unwrap();
    assert!(vault.groups(now).unwrap().is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), blob);
    vault.save_group(group("sensitive-group", 0), now).unwrap();
    vault
        .move_bookmark("private", Some("sensitive-group".into()), 0, now)
        .unwrap();
    vault.lock();
    assert!(vault.groups(now).is_err());
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.windows(15).any(|b| b == b"sensitive-group"));
    let plain = browserdock_launcher::crypto::decrypt(&bytes, &key).unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(payload["version"], 2);
    vault.unlock(secret, now).unwrap();
    assert_eq!(vault.groups(now).unwrap().len(), 1);
    vault.delete_group("sensitive-group", now).unwrap();
    assert!(vault.list(now).unwrap()[0].group_id.is_none());
}

#[test]
fn group_limits_and_reorder_are_validated_without_partial_mutation() {
    let mut groups: Vec<_> = (0..50).map(|i| group(&format!("group-{i}"), i)).collect();
    assert!(groups::save_group(&mut groups, group("overflow", 0)).is_err());
    assert_eq!(groups.len(), 50);
    let mut renamed = group("group-49", 0);
    renamed.name = "Renamed".into();
    groups::save_group(&mut groups, renamed).unwrap();
    assert_eq!(groups[0].id, "group-49");
    assert_eq!(groups[0].name, "Renamed");
    assert!(groups
        .iter()
        .enumerate()
        .all(|(i, g)| g.sort_order == i as u32));
    let mut invalid = group("invalid", 0);
    invalid.color = "red".into();
    assert!(invalid.validate().is_err());
    invalid.color = "#b8edc9".into();
    invalid.name = "界".repeat(64);
    assert!(invalid.validate().is_ok());
    invalid.name.push('界');
    assert!(invalid.validate().is_err());
}

#[test]
fn failed_private_group_write_keeps_memory_and_original_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("storage");
    std::fs::create_dir(&parent).unwrap();
    let path = parent.join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(300));
    vault.create("correct horse battery", now).unwrap();
    let original = std::fs::read(&path).unwrap();
    let preserved = dir.path().join("preserved");
    std::fs::rename(&parent, &preserved).unwrap();
    std::fs::write(&parent, b"not a directory").unwrap();
    assert!(vault.save_group(group("private", 0), now).is_err());
    assert!(vault.groups(now).unwrap().is_empty());
    assert_eq!(
        std::fs::read(preserved.join("vault.enc")).unwrap(),
        original
    );
}
