use browserdock_launcher::{
    capture::{capture_public, CaptureRequest},
    config::Config,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn save(id: &str, extra: Value) -> CaptureRequest {
    let mut value = json!({"action":"CAPTURE_SAVE","id":id,"title":" Example ","url":"https://example.com/","group_id":null,"incognito":false,"container":null});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
const ID: &str = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";

#[test]
fn capture_commits_atomically_preserves_unknown_entries_and_deduplicates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config {
        bookmarks: vec![
            json!({"future":true}),
            json!({"id":"existing","title":"Other","url":"https://other.example/","target_browser":"firefox","future":42}),
        ],
        ..Config::default()
    };
    config.extra.insert("future".into(), json!({"keep":true}));
    let request = save(ID, json!({"container":"firefox-container-2"}));
    assert_eq!(
        capture_public(&mut config, &path, "firefox", &request, deadline()).unwrap()["result"],
        "SAVED"
    );
    assert_eq!(config.bookmarks.len(), 3);
    assert_eq!(config.bookmarks[0]["future"], true);
    assert_eq!(config.bookmarks[1]["future"], 42);
    let captured = &config.bookmarks[2];
    assert_eq!(captured["title"], "Example");
    assert_eq!(
        captured["browser_options"]["container"],
        "firefox-container-2"
    );
    assert_eq!(captured["target_browser"], "firefox");
    assert!(captured["parent_id"].is_null());
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(
        capture_public(&mut config, &path, "firefox", &request, deadline()).unwrap()["result"],
        "ALREADY_SAVED"
    );
    let other_id = save(
        "e8d741e8-460a-42bb-aea9-27d54a8e8542",
        json!({"container":"firefox-container-2","title":"Changed"}),
    );
    assert_eq!(
        capture_public(&mut config, &path, "firefox", &other_id, deadline()).unwrap()["result"],
        "ALREADY_SAVED"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(config.bookmarks.len(), 3);
}

#[test]
fn rejected_capture_never_mutates_memory_or_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config::default();
    config.save(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let original = serde_json::to_value(&config).unwrap();
    for extra in [
        json!({"incognito":true}),
        json!({"url":"https://user:secret@example.com/"}),
        json!({"url":"file:///private"}),
        json!({"group_id":"missing"}),
        json!({"title":" "}),
        json!({"id":"not-a-uuid"}),
        json!({"container":"bad;name"}),
    ] {
        assert!(
            capture_public(&mut config, &path, "firefox", &save(ID, extra), deadline()).is_err()
        );
    }
    assert!(capture_public(
        &mut config,
        &path,
        "chrome",
        &save(ID, json!({"container":"firefox-container-2"})),
        deadline()
    )
    .is_err());
    assert!(capture_public(
        &mut config,
        &path,
        "unknown",
        &save(ID, json!({})),
        deadline()
    )
    .is_err());
    assert!(capture_public(
        &mut config,
        &path,
        "firefox",
        &save(ID, json!({})),
        Instant::now()
    )
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(serde_json::to_value(&config).unwrap(), original);
}

#[test]
fn failed_disk_write_preserves_memory_and_id_collision_does_not_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    let original = serde_json::to_value(&config).unwrap();
    assert!(capture_public(
        &mut config,
        dir.path(),
        "firefox",
        &save(ID, json!({})),
        deadline()
    )
    .is_err());
    assert_eq!(serde_json::to_value(&config).unwrap(), original);
    config.bookmarks.push(json!({"id":ID,"future":true}));
    assert!(capture_public(
        &mut config,
        &dir.path().join("config.json"),
        "firefox",
        &save(ID, json!({})),
        deadline()
    )
    .is_err());
}

#[test]
fn group_list_is_public_and_save_checks_current_group() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config { groups: serde_json::from_value(json!([{"id":"work","name":"Work","sort_order":2},{"id":"home","name":"Home","sort_order":0}])).unwrap(), ..Config::default() };
    let request: CaptureRequest =
        serde_json::from_value(json!({"action":"CAPTURE_GROUPS","id":ID})).unwrap();
    assert_eq!(
        capture_public(&mut config, &path, "firefox", &request, deadline()).unwrap(),
        json!({"groups":[{"id":"home","name":"Home"},{"id":"work","name":"Work"}]})
    );
    assert!(!path.exists());
    let request = save(ID, json!({"group_id":"work"}));
    assert_eq!(
        capture_public(&mut config, &path, "firefox", &request, deadline()).unwrap()["result"],
        "SAVED"
    );
    assert_eq!(
        config
            .bookmarks
            .iter()
            .find(|bookmark| bookmark["id"] == ID)
            .unwrap()["group_id"],
        "work"
    );
    config.groups.clear();
    assert!(capture_public(&mut config, &path, "firefox", &request, deadline()).is_err());
}

#[tokio::test]
async fn authenticated_transport_negotiates_capture_and_uses_connection_browser() {
    use browserdock_launcher::ws_server::BoundServer;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    let server = BoundServer::bind(0, ID).await.unwrap().start();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut initial = Config::default();
    initial.bookmarks.clear();
    let config = std::sync::Arc::new(std::sync::Mutex::new(initial));
    let shared = config.clone();
    server.set_capture_handler(std::sync::Arc::new(move |browser, request, deadline| {
        capture_public(
            &mut shared.lock().unwrap(),
            &path,
            browser,
            request,
            deadline,
        )
    }));
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    socket.send(Message::Text(json!({"type":"AUTH","token":ID,"browser":"edge","instance_id":uuid::Uuid::new_v4().to_string()}).to_string())).await.unwrap();
    let Message::Text(auth) = socket.next().await.unwrap().unwrap() else {
        panic!("Expected AUTH_OK")
    };
    assert!(
        serde_json::from_str::<Value>(&auth).unwrap()["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("capture_public_v1"))
    );
    let request = json!({"action":"CAPTURE_SAVE","id":ID,"title":"Captured","url":"https://example.com/","group_id":null,"incognito":false,"container":null});
    socket
        .send(Message::Text(request.to_string()))
        .await
        .unwrap();
    let Message::Text(reply) = socket.next().await.unwrap().unwrap() else {
        panic!("Expected capture result")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&reply).unwrap(),
        json!({"action":"CAPTURE_RESULT","id":ID,"ok":true,"payload":{"result":"SAVED"}})
    );
    assert_eq!(
        config.lock().unwrap().bookmarks[0]["target_browser"],
        "edge"
    );
    // The browser identity cannot be supplied in a capture frame.
    let mut spoofed = request;
    spoofed["browser"] = json!("firefox");
    socket
        .send(Message::Text(spoofed.to_string()))
        .await
        .unwrap();
    assert!(!matches!(socket.next().await, Some(Ok(Message::Text(_)))));
    assert_eq!(config.lock().unwrap().bookmarks.len(), 1);
    server.shutdown();
}

#[test]
fn capture_enforces_public_limit_including_unreadable_entries_but_allows_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config {
        bookmarks: vec![json!({"future":true}); 999],
        ..Config::default()
    };
    config.bookmarks.push(json!({"id":"existing","title":"Example","url":"https://example.com/","target_browser":"firefox"}));
    config.save(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let before = config.bookmarks.clone();
    assert_eq!(
        capture_public(
            &mut config,
            &path,
            "firefox",
            &save(ID, json!({})),
            deadline()
        )
        .unwrap()["result"],
        "ALREADY_SAVED"
    );
    assert!(capture_public(
        &mut config,
        &path,
        "firefox",
        &save(ID, json!({"url":"https://new.example/"})),
        deadline()
    )
    .is_err());
    assert_eq!(config.bookmarks, before);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
