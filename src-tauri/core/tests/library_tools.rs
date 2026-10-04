use browserdock_launcher::{
    capture::{capture_public, CaptureRequest},
    config::Config,
    library_tools::{self, CleanupSelection, TabSelection},
    route_explanation,
    ws_server::{PublicTab, PublicTabs},
};
use serde_json::json;
use std::time::{Duration, Instant};
fn config() -> Config {
    let mut c = Config::default();
    c.bookmarks.clear();
    c
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn batch(items: serde_json::Value) -> CaptureRequest {
    serde_json::from_value(json!({"action":"CAPTURE_BATCH","id":"acda3360-3dc8-44d3-b4c6-2a3498e59f8d","group_id":null,"items":items})).unwrap()
}
fn item(id: &str, url: &str) -> serde_json::Value {
    json!({"id":id,"title":"Page","url":url,"container":null})
}
const A: &str = "acda3360-3dc8-44d3-b4c6-2a3498e59f8a";
const B: &str = "acda3360-3dc8-44d3-b4c6-2a3498e59f8b";
#[test]
fn batch_is_atomic_deduplicated_and_preserves_unknown_entries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut c = config();
    c.bookmarks.push(json!({"id":"legacy","future":true}));
    c.extra.insert("future".into(), json!(42));
    let result = capture_public(
        &mut c,
        &path,
        "firefox",
        &batch(json!([
            item(A, "https://a.test/"),
            item(B, "https://a.test/")
        ])),
        deadline(),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"result":"BATCH_SAVED","added":1,"duplicates":1})
    );
    assert_eq!(c.bookmarks.len(), 2);
    assert_eq!(c.extra["future"], 42);
    let before = std::fs::read(&path).unwrap();
    let memory = serde_json::to_value(&c).unwrap();
    assert!(capture_public(
        &mut c,
        &path,
        "firefox",
        &batch(json!([item(A, "https://a.test/"), item(B, "file:///bad")])),
        deadline()
    )
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(serde_json::to_value(&c).unwrap(), memory);
}
#[test]
fn batch_rejects_expired_oversized_and_duplicate_ids_before_disk_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut c = config();
    for values in [
        json!([]),
        json!([item(A, "https://a.test/"), item(A, "https://b.test/")]),
        json!(vec![item(A, "https://a.test/"); 51]),
    ] {
        assert!(capture_public(&mut c, &path, "firefox", &batch(values), deadline()).is_err());
        assert!(c.bookmarks.is_empty());
        assert!(!path.exists());
    }
    assert!(capture_public(
        &mut c,
        &path,
        "firefox",
        &batch(json!([item(A, "https://a.test/")])),
        Instant::now() - Duration::from_secs(1)
    )
    .is_err());
}
fn fresh() -> Vec<PublicTabs> {
    vec![PublicTabs {
        instance_id: "instance".into(),
        browser: "firefox".into(),
        tabs: vec![
            PublicTab {
                id: 1,
                title: "Work".into(),
                url: "https://a.test/".into(),
                container: Some("firefox-container-1".into()),
                incognito: false,
            },
            PublicTab {
                id: 2,
                title: "Again".into(),
                url: "https://a.test/".into(),
                container: Some("firefox-container-1".into()),
                incognito: false,
            },
        ],
    }]
}
fn selection(id: i64) -> TabSelection {
    TabSelection {
        instance_id: "instance".into(),
        tab_id: id,
        url: "https://a.test/".into(),
        container: Some("firefox-container-1".into()),
    }
}
#[test]
fn workspace_revalidates_public_tabs_and_preserves_browser_container_and_backup() {
    let c = config();
    let (next, id, added) =
        library_tools::prepare_workspace(&c, " Research ", &[selection(1), selection(2)], &fresh())
            .unwrap();
    assert_eq!(added, 1);
    assert_eq!(next.groups[0].name, "Research");
    assert_eq!(next.bookmarks[0]["group_id"], id);
    assert_eq!(next.bookmarks[0]["target_browser"], "firefox");
    assert_eq!(
        next.bookmarks[0]["browser_options"]["container"],
        "firefox-container-1"
    );
    assert_eq!(next.bookmarks[0]["browser_options"]["incognito"], false);
    assert_eq!(next.bookmarks[0]["tags"], json!(["workspace"]));
    let dir = tempfile::tempdir().unwrap();
    let backup =
        browserdock_launcher::portable::export(&next, &dir.path().join("vault.enc")).unwrap();
    let preview = browserdock_launcher::portable::preview(&backup, &c).unwrap();
    assert_eq!(preview.bookmarks.len(), 1);
    assert_eq!(preview.groups[0].id, id);
    let mut stale = selection(1);
    stale.url = "https://changed.test/".into();
    assert!(library_tools::prepare_workspace(&c, "Research", &[stale], &fresh()).is_err());
    let mut tabs = fresh();
    tabs[0].tabs[0].incognito = true;
    assert!(library_tools::prepare_workspace(&c, "Research", &[selection(1)], &tabs).is_err());
    tabs[0].tabs.clear();
    assert!(library_tools::prepare_workspace(&c, "Research", &[selection(1)], &tabs).is_err());
    assert!(library_tools::prepare_workspace(
        &c,
        "Research",
        &[selection(1), selection(1)],
        &fresh()
    )
    .is_err());
}
fn bookmark(id: &str, parent: Option<&str>) -> serde_json::Value {
    json!({"id":id,"title":id,"url":"https://a.test/","target_browser":"firefox","tags":[],"icon":"","group_id":null,"parent_id":parent})
}
#[test]
fn cleanup_preserves_roots_with_children_unknown_data_and_rechecks_selection() {
    let mut c = config();
    c.bookmarks = vec![
        bookmark("first", None),
        bookmark("parent", None),
        bookmark("leaf", Some("parent")),
        json!({"id":"future","group_id":"occupied","unreadable":true}),
    ];
    c.groups = serde_json::from_value(
        json!([{"id":"empty","name":"Empty"},{"id":"occupied","name":"Occupied"}]),
    )
    .unwrap();
    let issues = library_tools::inspect(&c, &[]);
    assert!(issues
        .iter()
        .any(|i| i.id == "parent" && i.kind == "duplicate" && !i.removable));
    assert!(!issues
        .iter()
        .any(|i| i.id == "occupied" && i.kind == "empty_group"));
    let invalid = CleanupSelection {
        kind: "duplicate".into(),
        id: "parent".into(),
    };
    assert!(library_tools::prepare_cleanup(&c, &[invalid]).is_err());
    let next = library_tools::prepare_cleanup(
        &c,
        &[
            CleanupSelection {
                kind: "duplicate".into(),
                id: "leaf".into(),
            },
            CleanupSelection {
                kind: "empty_group".into(),
                id: "empty".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(next.bookmarks.len(), 3);
    assert_eq!(next.bookmarks[2], c.bookmarks[3]);
    assert_eq!(next.groups.len(), 1);
    assert!(library_tools::prepare_cleanup(
        &next,
        &[CleanupSelection {
            kind: "duplicate".into(),
            id: "leaf".into()
        }]
    )
    .is_err());
}
#[test]
fn explanation_agrees_with_launch_for_rules_overrides_defaults_and_bookmarks() {
    let mut c = config();
    c.browsers[0]
        .extra
        .insert("container".into(), json!("Work"));
    let fallback = route_explanation::explain(&c, "https://a.test/", None, None, &[]).unwrap();
    assert_eq!(fallback.details.browser_id, "firefox");
    assert!(fallback.steps.iter().any(|s| s.contains("default browser")));
    assert!(fallback
        .steps
        .iter()
        .any(|s| s.contains("browser defaults")));
    let rule =
        route_explanation::explain(&c, "https://mail.google.com/a", None, None, &[]).unwrap();
    assert_eq!(rule.details.browser_id, "chrome");
    assert!(rule.steps.iter().any(|s| s.contains("rule-1")));
    let overridden =
        route_explanation::explain(&c, "https://mail.google.com/a", Some("edge"), None, &[])
            .unwrap();
    assert_eq!(overridden.details.browser_id, "edge");
    assert!(overridden.steps[0].contains("override"));
    let b = serde_json::from_value(bookmark("bookmark", None)).unwrap();
    let explained =
        route_explanation::explain(&c, "https://mail.google.com/a", None, Some(&b), &[]).unwrap();
    assert_eq!(explained.details.browser_id, "firefox");
    assert!(explained.steps[0].contains("saved"));
}

#[test]
fn cleanup_never_orphans_unreadable_children() {
    let mut c = config();
    c.bookmarks = vec![
        bookmark("first", None),
        bookmark("duplicate", None),
        json!({"id":"unknown","parent_id":"duplicate","future":true}),
    ];
    assert!(
        !library_tools::inspect(&c, &[])
            .iter()
            .find(|i| i.kind == "duplicate" && i.id == "duplicate")
            .unwrap()
            .removable
    );
    assert!(library_tools::prepare_cleanup(
        &c,
        &[CleanupSelection {
            kind: "duplicate".into(),
            id: "duplicate".into()
        }]
    )
    .is_err());
}
#[test]
fn workspace_capacity_counts_unique_destinations_and_keeps_browser_identities_separate() {
    let mut c = config();
    c.bookmarks = (0..999)
        .map(|i| json!({"id":format!("raw-{i}"),"future":true}))
        .collect();
    assert_eq!(
        library_tools::prepare_workspace(&c, "Research", &[selection(1), selection(2)], &fresh())
            .unwrap()
            .2,
        1
    );
    let mut tabs = fresh();
    tabs.push(PublicTabs {
        instance_id: "edge".into(),
        browser: "edge".into(),
        tabs: vec![PublicTab {
            id: 3,
            title: "Edge".into(),
            url: "https://a.test/".into(),
            container: None,
            incognito: false,
        }],
    });
    let edge = TabSelection {
        instance_id: "edge".into(),
        tab_id: 3,
        url: "https://a.test/".into(),
        container: None,
    };
    assert!(
        library_tools::prepare_workspace(&c, "Research", &[selection(1), edge.clone()], &tabs)
            .is_err()
    );
    let (next, _, added) =
        library_tools::prepare_workspace(&config(), "Research", &[selection(1), edge], &tabs)
            .unwrap();
    assert_eq!(added, 2);
    assert_eq!(next.bookmarks[1]["target_browser"], "edge");
}
#[test]
fn batch_disk_failure_and_capacity_failure_keep_memory_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = config();
    let before = serde_json::to_value(&c).unwrap();
    assert!(capture_public(
        &mut c,
        dir.path(),
        "firefox",
        &batch(json!([item(A, "https://a.test/")])),
        deadline()
    )
    .is_err());
    assert_eq!(serde_json::to_value(&c).unwrap(), before);
    c.bookmarks = (0..1000)
        .map(|i| json!({"id":format!("raw-{i}"),"future":true}))
        .collect();
    let before = serde_json::to_value(&c).unwrap();
    assert!(capture_public(
        &mut c,
        &dir.path().join("config.json"),
        "firefox",
        &batch(json!([item(A, "https://a.test/")])),
        deadline()
    )
    .is_err());
    assert_eq!(serde_json::to_value(&c).unwrap(), before);
}
