use browserdock_launcher::{
    config::Config,
    dispatch::group_action_guarded,
    settings::Settings,
    vault::Bookmark,
    ws_server::{BoundServer, GroupCommand, MatchMode, ServerHandle, TabGroupHint},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
const TOKEN: &str = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
fn hint() -> TabGroupHint {
    TabGroupHint {
        name: "Work".into(),
        color: Some("#4285f4".into()),
        collapsed: Some(false),
    }
}
async fn connect(server: &ServerHandle, supported: bool) -> Socket {
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    socket.send(Message::Text(json!({"type":"AUTH","token":TOKEN,"browser":"firefox","instance_id":uuid::Uuid::new_v4().to_string(),"capabilities":if supported {vec!["tab_groups_v1"]} else {vec![]}}).to_string())).await.unwrap();
    assert_eq!(read(&mut socket).await["type"], "AUTH_OK");
    socket
}
async fn read(socket: &mut Socket) -> Value {
    let message = timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}
async fn reply(socket: &mut Socket, request: &Value, result: &str) {
    let response = if result == "CLOSED_TABS" {
        json!({"id":request["id"],"status":"SUCCESS","result":result,"closed":2})
    } else if result.starts_with("ERROR_") {
        json!({"id":request["id"],"status":"ERROR","result":result})
    } else {
        json!({"id":request["id"],"status":"SUCCESS","result":result,"window_id":10,"tab_id":1})
    };
    socket
        .send(Message::Text(response.to_string()))
        .await
        .unwrap();
}
#[test]
fn hints_validate_and_legacy_settings_enable_automatic_groups() {
    let value = serde_json::to_value(hint()).unwrap();
    assert!(serde_json::from_value::<TabGroupHint>(value)
        .unwrap()
        .valid());
    let mut bad = hint();
    bad.name = " ".into();
    assert!(!bad.valid());
    bad.name = "Work".into();
    bad.color = Some("red;bad".into());
    assert!(!bad.valid());
    let mut config = Config::default();
    config.settings.remove("auto_tab_groups");
    assert!(Settings::from_config(&config).auto_tab_groups);
    config
        .settings
        .insert("auto_tab_groups".into(), json!(false));
    assert!(!Settings::from_config(&config).auto_tab_groups);
}
#[tokio::test]
async fn group_open_close_envelopes_and_focus_hint_are_correlated() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, true).await;
    for action in ["OPEN_GROUP", "CLOSE_GROUP", "FOCUS_OR_OPEN"] {
        let handle = server.clone();
        let task = tokio::spawn(async move {
            match action {
                "OPEN_GROUP" => {
                    handle
                        .open_group_tabs(
                            "firefox",
                            &["https://one.test/".into()],
                            &hint(),
                            Some("Work"),
                            None,
                        )
                        .await
                }
                "CLOSE_GROUP" => {
                    handle
                        .close_group_tabs("firefox", &hint(), Some("Work"), None)
                        .await
                }
                _ => {
                    handle
                        .focus_or_open_with_group(
                            "firefox",
                            "https://one.test/",
                            MatchMode::Exact,
                            Some("Work"),
                            None,
                            Some(&hint()),
                        )
                        .await
                }
            }
        });
        let request = read(&mut socket).await;
        assert_eq!(request["action"], action);
        if action == "CLOSE_GROUP" {
            assert!(request.get("urls").is_none());
        }
        assert_eq!(request["tab_group"]["name"], "Work");
        assert_eq!(request["container"], "Work");
        assert!(request["deadline_ms"].as_u64().unwrap() > 0);
        reply(
            &mut socket,
            &request,
            match action {
                "OPEN_GROUP" => "OPENED_GROUP",
                "CLOSE_GROUP" => "CLOSED_TABS",
                _ => "FOCUSED_EXISTING",
            },
        )
        .await;
        assert_eq!(task.await.unwrap().unwrap().unwrap().status, "SUCCESS");
    }
    server.shutdown();
}
#[tokio::test]
async fn legacy_companions_reject_batch_before_dispatch_and_warn_on_single_group_hint() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, false).await;
    assert!(server
        .open_group_tabs(
            "firefox",
            &["https://one.test/".into()],
            &hint(),
            None,
            None
        )
        .await
        .unwrap_err()
        .contains("Update"));
    assert!(timeout(Duration::from_millis(30), socket.next())
        .await
        .is_err());
    let handle = server.clone();
    let task = tokio::spawn(async move {
        handle
            .focus_or_open_with_group(
                "firefox",
                "https://one.test/",
                MatchMode::Exact,
                None,
                None,
                Some(&hint()),
            )
            .await
    });
    let request = read(&mut socket).await;
    reply(&mut socket, &request, "FOCUSED_EXISTING").await;
    assert!(task
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .note
        .unwrap()
        .contains("Update"));
    server.shutdown();
}
#[tokio::test]
async fn ambiguous_group_failure_is_not_retried() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, true).await;
    let handle = server.clone();
    let task = tokio::spawn(async move {
        handle
            .open_group_tabs(
                "firefox",
                &["https://one.test/".into()],
                &hint(),
                None,
                None,
            )
            .await
    });
    let request = read(&mut socket).await;
    reply(&mut socket, &request, "ERROR_BROWSER_API").await;
    assert!(task.await.unwrap().unwrap_err().contains("No retry"));
    assert!(timeout(Duration::from_millis(30), socket.next())
        .await
        .is_err());
    server.shutdown();
}
fn bookmark(id: &str, container: &str) -> Bookmark {
    serde_json::from_value(json!({"id":id,"title":id,"url":format!("https://{id}.test/"),"target_browser":"firefox","tags":[],"icon":"","group_id":"work","browser_options":{"container":container}})).unwrap()
}
#[tokio::test]
async fn batches_preserve_container_options_and_session_cancel_stops_subsequent_batches() {
    for cancel in [false, true] {
        let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
        let mut socket = connect(&server, true).await;
        let valid = Arc::new(AtomicBool::new(true));
        let gate = valid.clone();
        let handle = server.clone();
        let task = tokio::spawn(async move {
            group_action_guarded(
                &Config::default(),
                Some(&handle),
                &[bookmark("one", "Work"), bookmark("two", "Personal")],
                &hint(),
                None,
                false,
                Arc::new(move || gate.load(Ordering::SeqCst)),
            )
            .await
        });
        let request = read(&mut socket).await;
        assert_eq!(request["container"], "Work");
        if cancel {
            valid.store(false, Ordering::SeqCst);
        }
        reply(&mut socket, &request, "OPENED_GROUP").await;
        if cancel {
            assert!(task.await.unwrap().is_err());
            assert!(timeout(Duration::from_millis(30), socket.next())
                .await
                .is_err());
        } else {
            let request = read(&mut socket).await;
            assert_eq!(request["container"], "Personal");
            reply(&mut socket, &request, "OPENED_GROUP").await;
            assert_eq!(task.await.unwrap().unwrap().processed, 2);
        }
        server.shutdown();
    }
}
#[tokio::test]
async fn inventory_digest_preserves_distinct_native_groups_on_the_same_host() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, true).await;
    socket.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[
        {"id":1,"url":"https://one.test/a","title":"one","groupId":8,"groupTitle":"Work","groupColor":"blue","groupCollapsed":false},
        {"id":2,"url":"https://one.test/b","title":"two","groupId":9,"groupTitle":"Personal","groupColor":"green"}
    ]}).to_string())).await.unwrap();
    socket
        .send(Message::Text(json!({"action":"PING"}).to_string()))
        .await
        .unwrap();
    assert_eq!(read(&mut socket).await["action"], "PONG");
    assert_eq!(server.tabs_digest()[0].tabs.len(), 2);
    assert_eq!(server.instances()[0].tabs[0].group_id, Some(8));
    server.shutdown();
}
#[tokio::test]
async fn group_preflight_rejects_invalid_later_bookmark_without_dispatch() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, true).await;
    let mut invalid = bookmark("two", "Work");
    invalid.url = "file:///bad".into();
    assert!(group_action_guarded(
        &Config::default(),
        Some(&server),
        &[bookmark("one", "Work"), invalid],
        &hint(),
        None,
        false,
        Arc::new(|| true)
    )
    .await
    .is_err());
    assert!(timeout(Duration::from_millis(30), socket.next())
        .await
        .is_err());
    server.shutdown();
}
#[tokio::test]
async fn cancellation_sends_companion_stop_without_replaying_the_batch() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(&server, true).await;
    let valid = Arc::new(AtomicBool::new(true));
    let gate = valid.clone();
    let handle = server.clone();
    let task = tokio::spawn(async move {
        handle
            .group_tabs_guarded(
                GroupCommand {
                    browser: "firefox",
                    urls: &["https://one.test/".into()],
                    hint: &hint(),
                    container: None,
                    profile: None,
                    close: false,
                },
                Arc::new(move || gate.load(Ordering::SeqCst)),
            )
            .await
    });
    let request = read(&mut socket).await;
    valid.store(false, Ordering::SeqCst);
    let cancel = read(&mut socket).await;
    assert_eq!(cancel["action"], "CANCEL_REQUEST");
    assert_eq!(cancel["id"], request["id"]);
    assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
    server.shutdown();
}
