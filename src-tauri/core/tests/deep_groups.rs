use browserdock_launcher::{
    groups::{self, Group},
    vault::{Bookmark, Vault},
};
use serde_json::json;
use std::time::{Duration, Instant};
fn bookmark(id: &str, parent: Option<&str>) -> Bookmark {
    serde_json::from_value(json!({"id":id,"title":id,"url":"https://example.com/","target_browser":"firefox","parent_id":parent})).unwrap()
}
fn group() -> Group {
    serde_json::from_value(json!({"id":"work","name":"Work","color":"#4285f4"})).unwrap()
}
fn ids(items: &[Bookmark]) -> Vec<&str> {
    items.iter().map(|b| b.id.as_str()).collect()
}
#[test]
fn nest_reorder_unnest_and_group_sync_are_atomic() {
    let mut root = bookmark("root", None);
    root.group_id = Some("work".into());
    let mut items = vec![root, bookmark("a", None), bookmark("b", None)];
    let groups = vec![group()];
    groups::move_bookmark(&mut items, &groups, "a", None, Some(Some("root".into())), 0).unwrap();
    groups::move_bookmark(&mut items, &groups, "b", None, Some(Some("root".into())), 0).unwrap();
    assert_eq!(items[1].group_id.as_deref(), Some("work"));
    assert_eq!(items[1].sort_order, 1);
    groups::move_bookmark(&mut items, &groups, "a", None, None, 0).unwrap();
    assert_eq!(items[1].parent_id.as_deref(), Some("root"));
    assert_eq!(items[1].sort_order, 0);
    groups::move_bookmark(&mut items, &groups, "a", None, Some(None), 0).unwrap();
    assert!(items[1].parent_id.is_none());
    assert!(items[1].group_id.is_none());
    let before = serde_json::to_value(&items).unwrap();
    assert!(
        groups::move_bookmark(&mut items, &groups, "root", None, Some(Some("b".into())), 0)
            .is_err()
    );
    assert_eq!(serde_json::to_value(&items).unwrap(), before);
}
#[test]
fn parent_validation_rejects_depth_cycles_missing_scope_and_cross_group() {
    let items = vec![
        bookmark("root", None),
        bookmark("child", Some("root")),
        bookmark("grandchild", Some("child")),
    ];
    assert!(groups::validate_tree(&items).is_ok());
    for candidate in [
        bookmark("root", Some("root")),
        bookmark("new", Some("private-only")),
        bookmark("new", Some("grandchild")),
    ] {
        assert!(groups::save_bookmark(&mut items.clone(), &[], candidate).is_err());
    }
    let mut cross = items.clone();
    cross[1].group_id = Some("work".into());
    assert!(groups::validate_tree(&cross).is_err());
    let mut moving = items.clone();
    moving.push(bookmark("other", None));
    assert!(groups::move_bookmark(
        &mut moving,
        &[],
        "root",
        None,
        Some(Some("other".into())),
        0
    )
    .is_err());
    let mut looped = items.clone();
    looped[0].parent_id = Some("grandchild".into());
    assert!(groups::validate_tree(&looped).is_err());
    assert_eq!(groups::display_roots(&mut looped), 3);
    assert!(looped.iter().all(|b| b.parent_id.is_none()));
}
#[test]
fn deleting_parent_appends_children_in_sibling_order() {
    let mut items = vec![
        bookmark("root", None),
        bookmark("child", Some("root")),
        bookmark("z", Some("child")),
        bookmark("a", Some("child")),
        bookmark("sibling", Some("root")),
    ];
    groups::delete_bookmark(&mut items, "child").unwrap();
    let (tree, _) = groups::bookmark_tree(&items, &[], "root").unwrap();
    assert_eq!(ids(&tree), ["root", "sibling", "a", "z"]);
    groups::delete_bookmark(&mut items, "root").unwrap();
    assert!(items.iter().all(|b| b.parent_id.is_none()));
    assert_eq!(items.len(), 3);
}
#[test]
fn subtree_depth_first_order_caps_and_unicode_hint() {
    let mut items = vec![
        bookmark("root", None),
        bookmark("b", Some("root")),
        bookmark("a", Some("root")),
        bookmark("grandchild", Some("a")),
    ];
    items[0].title = "界".repeat(100);
    items[0].group_id = Some("work".into());
    for child in &mut items[1..] {
        child.group_id = Some("work".into());
    }
    let (tree, hint) = groups::bookmark_tree(&items, &[group()], "root").unwrap();
    assert_eq!(ids(&tree), ["root", "a", "grandchild", "b"]);
    assert_eq!(hint.name.chars().count(), 64);
    assert!(hint.valid());
    assert_eq!(hint.color.as_deref(), Some("#4285f4"));
    assert!(hint.collapsed.is_none());
    let mut many = vec![bookmark("root", None)];
    for i in 0..49 {
        many.push(bookmark(&format!("c{i}"), Some("root")));
    }
    assert_eq!(
        groups::bookmark_tree(&many, &[], "root").unwrap().0.len(),
        50
    );
    many.push(bookmark("overflow", Some("root")));
    assert!(groups::bookmark_tree(&many, &[], "root")
        .err()
        .unwrap()
        .contains("subtree"));
}
#[test]
fn public_patch_preserves_unknown_fields_and_tristate_parent_update() {
    let mut raw = vec![
        json!({"id":"child","future":{"keep":true}}),
        json!("unreadable"),
    ];
    groups::patch_organization(&mut raw, &[bookmark("child", Some("root"))]);
    assert_eq!(raw[0]["parent_id"], "root");
    assert_eq!(raw[0]["future"]["keep"], true);
    assert_eq!(raw[1], "unreadable");
    assert_eq!(groups::parent_update(&json!({})).unwrap(), None);
    assert_eq!(
        groups::parent_update(&json!({"parentId":null})).unwrap(),
        Some(None)
    );
    assert_eq!(
        groups::parent_update(&json!({"parentId":"root"})).unwrap(),
        Some(Some("root".into()))
    );
    assert!(groups::parent_update(&json!({"parentId":42})).is_err());
}
#[test]
fn changing_root_group_syncs_all_descendants() {
    let mut items = vec![
        bookmark("root", None),
        bookmark("child", Some("root")),
        bookmark("grandchild", Some("child")),
    ];
    let mut root = items[0].clone();
    root.group_id = Some("work".into());
    groups::save_bookmark(&mut items, &[group()], root).unwrap();
    assert!(items.iter().all(|b| b.group_id.as_deref() == Some("work")));
}
#[test]
fn private_tree_persists_encrypted_and_delete_reparents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.enc");
    let now = Instant::now();
    let mut vault = Vault::new(path.clone(), Duration::from_secs(300));
    vault.create("correct horse battery", now).unwrap();
    vault.save(bookmark("root", None), now).unwrap();
    vault
        .save(bookmark("private-child", Some("root")), now)
        .unwrap();
    assert!(vault
        .save(bookmark("bad", Some("public-only")), now)
        .is_err());
    vault.lock();
    vault.unlock("correct horse battery", now).unwrap();
    assert_eq!(
        vault.list(now).unwrap()[1].parent_id.as_deref(),
        Some("root")
    );
    assert!(!std::fs::read(&path)
        .unwrap()
        .windows(13)
        .any(|s| s == b"private-child"));
    vault.delete("root", now).unwrap();
    assert!(vault.list(now).unwrap()[0].parent_id.is_none());
    vault.lock();
    assert!(vault
        .move_bookmark("private-child", None, Some(None), 0, now)
        .is_err());
}
