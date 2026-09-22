use browserdock_launcher::vault::{Bookmark, Vault};
use std::time::{Duration, Instant};
fn bookmark() -> Bookmark {
    Bookmark {
        id: "private-1".into(),
        title: "Secret bookmark".into(),
        url: "https://private.example/hidden".into(),
        target_browser: "mullvad".into(),
        tags: vec!["secret".into()],
        icon: String::new(),
        group_id: None,
        parent_id: None,
        sort_order: 0,
        browser_options: None,
        pinned: false,
    }
}
#[test]
fn encrypted_roundtrip_and_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(300));
    vault.create("correct horse battery", now).unwrap();
    vault.save(bookmark(), now).unwrap();
    let blob = std::fs::read(&path).unwrap();
    assert!(blob.len() > 44);
    assert!(!blob.windows(7).any(|b| b == b"private"));
    vault.lock();
    assert!(vault.list(now).is_err());
    vault.unlock("correct horse battery", now).unwrap();
    assert_eq!(vault.list(now).unwrap()[0].title, "Secret bookmark");
    vault.delete("private-1", now).unwrap();
    vault.lock();
    vault.unlock("correct horse battery", now).unwrap();
    assert!(vault.list(now).unwrap().is_empty());
}
#[test]
fn rejects_weak_secrets_and_existing_vault() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(300));
    let n = Instant::now();
    for secret in ["short", "123456789", "１２３４５６７８"] {
        assert!(v.create(secret, n).is_err());
    }
    v.create("valid secret", n).unwrap();
    assert!(v.create("replacement secret", n).is_err());
    v.lock();
    v.unlock("valid secret", n).unwrap();
}
#[test]
fn tampering_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let n = Instant::now();
    let mut v = Vault::new(path.clone(), Duration::from_secs(300));
    v.create("valid secret", n).unwrap();
    v.lock();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[28] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(v.unlock("valid secret", n).is_err());
    assert!(v.list(n).is_err());
}
#[test]
fn lockout_and_inactivity_are_backend_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(10));
    let n = Instant::now();
    v.create("valid secret", n).unwrap();
    v.lock();
    for _ in 0..3 {
        assert!(v.unlock("wrong secret", n).is_err());
    }
    assert!(v
        .unlock("valid secret", n + Duration::from_secs(29))
        .is_err());
    let later = n + Duration::from_secs(31);
    v.unlock("valid secret", later).unwrap();
    assert_eq!(v.list(later + Duration::from_secs(9)).unwrap().len(), 0);
    assert!(v.list(later + Duration::from_secs(10)).is_err());
    v.unlock("valid secret", later + Duration::from_secs(11))
        .unwrap();
    v.activity(later + Duration::from_secs(19));
    assert!(!v.expire(later + Duration::from_secs(25)));
    assert!(v.expire(later + Duration::from_secs(29)));
}
#[test]
fn failed_save_keeps_previous_contents_and_nonce_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let n = Instant::now();
    let mut v = Vault::new(path.clone(), Duration::from_secs(300));
    v.create("valid secret", n).unwrap();
    let before = std::fs::read(&path).unwrap();
    v.save(bookmark(), n).unwrap();
    let after = std::fs::read(&path).unwrap();
    assert_ne!(&before[16..28], &after[16..28]);
    let mut bad = bookmark();
    bad.url = "file:///secret".into();
    assert!(v.save(bad, n).is_err());
    assert_eq!(std::fs::read(path).unwrap(), after);
    assert_eq!(v.list(n).unwrap().len(), 1);
}

#[test]
fn expiry_notification_survives_activity_before_timer() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(1));
    let n = Instant::now();
    v.create("valid secret", n).unwrap();
    v.activity(n + Duration::from_secs(2));
    assert!(!v.expire(n + Duration::from_secs(3)));
    assert!(v.take_lock_event());
    assert!(!v.take_lock_event());
}

#[test]
fn old_expiration_cannot_report_a_new_session_locked() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::new(dir.path().join("vault.enc"), Duration::from_secs(1));
    let n = Instant::now();
    v.create("valid secret", n).unwrap();
    v.activity(n + Duration::from_secs(2));
    v.unlock("valid secret", n + Duration::from_secs(3))
        .unwrap();
    assert!(!v.take_lock_event());
    assert!(!v.status(n + Duration::from_secs(3)).locked);
}
#[test]
fn disk_failure_does_not_commit_private_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("active");
    let moved = dir.path().join("preserved");
    let path = parent.join("vault.enc");
    let n = Instant::now();
    let mut v = Vault::new(path.clone(), Duration::from_secs(300));
    v.create("valid secret", n).unwrap();
    let before = std::fs::read(&path).unwrap();
    std::fs::rename(&parent, &moved).unwrap();
    std::fs::write(&parent, b"blocked").unwrap();
    assert!(v.save(bookmark(), n).is_err());
    assert!(v.list(n).unwrap().is_empty());
    assert_eq!(std::fs::read(moved.join("vault.enc")).unwrap(), before);
}
#[test]
fn pin_survives_vault_roundtrip_and_legacy_entries_default_unpinned() {
    // Legacy payloads without `pinned` must still deserialize as unpinned.
    let legacy: Bookmark = serde_json::from_value(
        serde_json::json!({"id":"legacy","title":"Legacy","url":"https://example.org","target_browser":"firefox"}),
    )
    .unwrap();
    assert!(!legacy.pinned);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path, Duration::from_secs(300));
    vault.create("correct horse battery", now).unwrap();
    let mut pinned = bookmark();
    pinned.pinned = true;
    vault.save(pinned, now).unwrap();
    assert!(vault.list(now).unwrap()[0].pinned);
}
