use browserdock_launcher::ws_server::{BoundServer, MatchMode};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    net::TcpStream,
    time::{timeout, Duration},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[cfg(unix)]
#[tokio::test]
async fn edge_without_a_window_launches_process_only_for_explicit_safe_handoff() {
    for (response, allowed) in [("ERROR_NO_BROWSER_WINDOW", true), ("ERROR_BROWSER_API", false)] {
        let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
        let mut socket = connect(server.port(), "edge", &uuid::Uuid::new_v4().to_string()).await;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("launched-url");
        let mut config = browserdock_launcher::config::Config::default();
        let edge = config.browsers.iter_mut().find(|b| b.id == "edge").unwrap();
        edge.exe_path = "/bin/sh".into();
        edge.args = vec!["-c".into(), "printf '%s' \"$2\" > \"$1\"".into(), "edge-test".into(), marker.to_str().unwrap().into()];
        let handle = server.clone();
        let task = tokio::spawn(async move {
            browserdock_launcher::dispatch::open_url(&config, Some(&handle), "http://127.0.0.1/edge-test", Some("edge"), MatchMode::Exact).await
        });
        let request = read(&mut socket).await;
        socket.send(Message::Text(json!({"id":request["id"],"status":"ERROR","result":response}).to_string())).await.unwrap();
        let outcome = task.await.unwrap();
        if allowed {
            assert_eq!(outcome.unwrap().result, "PROCESS_STARTED");
            timeout(Duration::from_secs(2), async {
                while std::fs::read_to_string(&marker).ok().as_deref() != Some("http://127.0.0.1/edge-test") {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("Edge process fallback did not receive the URL");
        } else {
            assert!(outcome.is_err());
            assert!(!marker.exists());
        }
        server.shutdown();
    }
}

#[tokio::test]
async fn focus_failure_names_the_companion_result_code() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(server.port(), "firefox", &uuid::Uuid::new_v4().to_string()).await;
    let handle = server.clone();
    let task = tokio::spawn(async move {
        handle
            .focus_or_open("firefox", "https://example.org", MatchMode::Exact)
            .await
    });
    let request = read(&mut socket).await;
    assert_eq!(request["action"], "FOCUS_OR_OPEN");
    socket.send(Message::Text(json!({"id":request["id"],"status":"ERROR","result":"ERROR_BROWSER_API"}).to_string())).await.unwrap();
    assert!(task
        .await
        .unwrap()
        .unwrap_err()
        .contains("ERROR_BROWSER_API"));
    assert!(timeout(Duration::from_millis(30), socket.next())
        .await
        .is_err());
    server.shutdown();
}

#[tokio::test]
async fn fallback_port_is_persisted_without_changing_token() {
    use browserdock_launcher::{config::Config, ws_server::start_configured};
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = occupied.local_addr().unwrap().port();
    if port == u16::MAX {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config::default();
    config.settings.insert("ws_port".into(), json!(port));
    config.settings.insert("auth_token".into(), json!(TOKEN));
    config.save(&path).unwrap();
    let server = start_configured(&mut config, &path).await.unwrap();
    let persisted = Config::load_or_create(&path).unwrap();
    assert_eq!(persisted.settings["ws_port"], server.port());
    assert!(server.port() > port);
    assert_eq!(persisted.settings["auth_token"], TOKEN);
    assert!(persisted.settings["ws_port_warning"]
        .as_str()
        .is_some_and(|warning| warning.contains("re-pair")));
    server.shutdown();
}

#[tokio::test]
async fn connected_companion_bypasses_missing_executable_and_ignores_other_instances_reply() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut chosen = connect(
        server.port(),
        "firefox",
        "00000000-0000-4000-8000-000000000001",
    )
    .await;
    let mut other = connect(server.port(), "mullvad", &uuid::Uuid::new_v4().to_string()).await;
    let mut task = {
        let server = server.clone();
        tokio::spawn(async move {
            let config = browserdock_launcher::config::Config::default();
            browserdock_launcher::dispatch::open_url(
                &config,
                Some(&server),
                "https://example.org",
                None,
                MatchMode::NewTab,
            )
            .await
        })
    };
    let request = read(&mut chosen).await;
    let reply = json!({"id":request["id"],"status":"SUCCESS","result":"OPENED_NEW_TAB","window_id":2,"tab_id":3});
    other.send(Message::Text(reply.to_string())).await.unwrap();
    assert!(timeout(Duration::from_millis(30), &mut task).await.is_err());
    chosen.send(Message::Text(reply.to_string())).await.unwrap();
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.browser_id, "firefox");
    assert_eq!(result.result, "OPENED_NEW_TAB");
}

#[tokio::test]
async fn request_timeout_does_not_send_another_request() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "firefox", &uuid::Uuid::new_v4().to_string()).await;
    let task = {
        let server = server.clone();
        tokio::spawn(async move {
            server
                .focus_or_open("firefox", "https://example.org", MatchMode::Exact)
                .await
        })
    };
    let request = read(&mut ws).await;
    assert_eq!(request["action"], "FOCUS_OR_OPEN");
    assert!(timeout(Duration::from_secs(6), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .contains("timed out"));
    assert!(timeout(Duration::from_millis(30), ws.next()).await.is_err());
    // Late responses cannot revive an expired request or affect subsequent ones.
    ws.send(Message::Text(json!({"id":request["id"],"status":"SUCCESS","result":"FOCUSED_EXISTING","window_id":2,"tab_id":3}).to_string())).await.unwrap();
    ws.send(Message::Text(json!({"action":"PING"}).to_string()))
        .await
        .unwrap();
    assert_eq!(read(&mut ws).await, json!({"action":"PONG"}));
}

#[tokio::test]
async fn compressed_snapshot_arrivals_keep_latest_and_disconnect_removes_cached_tabs() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "edge", &uuid::Uuid::new_v4().to_string()).await;
    for id in [1, 2] {
        ws.send(Message::Text(json!({"action":"TABS_SYNC","browser":"edge","tabs":[{"id":id,"url":"https://example.org","title":"Example"}]}).to_string())).await.unwrap();
    }
    ws.send(Message::Text(json!({"action":"PING"}).to_string()))
        .await
        .unwrap();
    read(&mut ws).await;
    assert_eq!(server.instances()[0].tabs[0].id, 2);
    ws.close(None).await.unwrap();
    timeout(Duration::from_secs(2), async {
        while !server.instances().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn tabs_digest_returns_deduplicated_hosts_for_indicator_polls() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "firefox", &uuid::Uuid::new_v4().to_string()).await;
    ws.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[
        {"id":1,"url":"https://github.com/pulls","title":"Pulls"},
        {"id":2,"url":"https://github.com/issues","title":"Issues"},
        {"id":3,"url":"https://example.org/","title":"Example","cookieStoreId":"firefox-container-1"},
        {"id":4,"url":"https://example.org/other","title":"Other","cookieStoreId":"firefox-container-1"},
    ]}).to_string())).await.unwrap();
    let digest = timeout(Duration::from_secs(2), async {
        loop {
            let digest = server.tabs_digest();
            if digest.iter().any(|i| !i.tabs.is_empty()) { return digest; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    assert_eq!(digest.len(), 1);
    assert_eq!(digest[0].browser, "firefox");
    assert_eq!(digest[0].tabs.len(), 2);
    assert_eq!(digest[0].tabs[0].host, "example.org");
    assert_eq!(digest[0].tabs[0].cookie_store_id.as_deref(), Some("firefox-container-1"));
    assert_eq!(digest[0].tabs[1].host, "github.com");
    assert_eq!(digest[0].tabs[1].cookie_store_id, None);
    ws.close(None).await.unwrap();
    server.shutdown();
}

#[tokio::test]
async fn rejects_web_page_origins_before_authentication() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut request = format!("ws://127.0.0.1:{}", server.port())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://example.org".parse().unwrap());
    assert!(connect_async(request).await.is_err());
    assert!(server.instances().is_empty());
}

async fn connect(port: u16, browser: &str, id: &str) -> Socket {
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .unwrap();
    ws.send(Message::Text(
        json!({"type":"AUTH","token":TOKEN,"browser":browser,"instance_id":id}).to_string(),
    ))
    .await
    .unwrap();
    let auth = read(&mut ws).await;
    assert_eq!(auth["type"], "AUTH_OK");
    assert_eq!(auth["capabilities"], json!(["paged_tabs_v1"]));
    ws
}

async fn read(ws: &mut Socket) -> Value {
    let message = timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

#[tokio::test]
async fn loopback_bind_falls_forward_when_port_is_busy() {
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = occupied.local_addr().unwrap().port();
    if port == u16::MAX {
        return;
    }
    let bound = BoundServer::bind(port, TOKEN).await.unwrap();
    assert!(bound.port() > port);
}

#[tokio::test]
async fn rejects_bad_auth_and_duplicate_active_instance() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let (mut bad, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    bad.send(Message::Text(json!({"type":"AUTH","token":"wrong","browser":"firefox","instance_id":uuid::Uuid::new_v4().to_string()}).to_string())).await.unwrap();
    let rejected = timeout(Duration::from_secs(2), bad.next()).await.unwrap();
    assert!(!matches!(rejected, Some(Ok(Message::Text(_)))));
    assert!(server.instances().is_empty());
    let id = uuid::Uuid::new_v4().to_string();
    let _first = connect(server.port(), "firefox", &id).await;
    let (mut duplicate, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    duplicate
        .send(Message::Text(
            json!({"type":"AUTH","token":TOKEN,"browser":"mullvad","instance_id":id}).to_string(),
        ))
        .await
        .unwrap();
    let rejected = timeout(Duration::from_secs(2), duplicate.next())
        .await
        .unwrap();
    assert!(!matches!(rejected, Some(Ok(Message::Text(_)))));
    assert_eq!(server.instances().len(), 1);
    assert_eq!(server.instances()[0].browser, "firefox");
    server.shutdown();
}

#[tokio::test]
async fn selects_matching_instance_without_crossing_browser_identity() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut first = connect(
        server.port(),
        "firefox",
        "00000000-0000-4000-8000-000000000001",
    )
    .await;
    let mut matched = connect(
        server.port(),
        "firefox",
        "00000000-0000-4000-8000-000000000002",
    )
    .await;
    let _mullvad = connect(
        server.port(),
        "mullvad",
        "00000000-0000-4000-8000-000000000003",
    )
    .await;
    matched.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[{"id":4,"url":"https://github.com/pulls","title":"Pulls"}]}).to_string())).await.unwrap();
    matched
        .send(Message::Text(json!({"action":"PING"}).to_string()))
        .await
        .unwrap();
    assert_eq!(read(&mut matched).await, json!({"action":"PONG"}));
    let dispatch = {
        let server = server.clone();
        tokio::spawn(async move {
            server
                .focus_or_open(
                    "firefox",
                    "https://github.com/issues",
                    MatchMode::DomainOrExact,
                )
                .await
        })
    };
    let request = read(&mut matched).await;
    assert_eq!(request["action"], "FOCUS_OR_OPEN");
    assert_eq!(request["match_mode"], "domain_or_exact");
    assert!(timeout(Duration::from_millis(30), first.next())
        .await
        .is_err());
    matched.send(Message::Text(json!({"id":request["id"],"status":"SUCCESS","result":"FOCUSED_EXISTING","window_id":9,"tab_id":4}).to_string())).await.unwrap();
    let response = dispatch.await.unwrap().unwrap().unwrap();
    assert_eq!(response.result, "FOCUSED_EXISTING");
    assert!(server
        .focus_or_open("chrome", "https://example.org", MatchMode::Exact)
        .await
        .unwrap()
        .is_none());
    server.shutdown();
    assert!(server.instances().is_empty());
}

#[tokio::test]
async fn disconnect_cleans_inventory_and_pending_requests() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "edge", &uuid::Uuid::new_v4().to_string()).await;
    let task = {
        let server = server.clone();
        tokio::spawn(async move {
            server
                .focus_or_open("edge", "https://example.org", MatchMode::NewTab)
                .await
        })
    };
    assert_eq!(read(&mut ws).await["match_mode"], "new_tab");
    ws.close(None).await.unwrap();
    assert!(timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(server.instances().is_empty());
}

#[tokio::test]
async fn missing_auth_expires_after_five_seconds() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    let result = timeout(Duration::from_secs(6), ws.next()).await.unwrap();
    assert!(!matches!(result, Some(Ok(Message::Text(_)))));
    assert!(server.instances().is_empty());
}

#[tokio::test]
async fn invalid_tab_inventory_is_rejected() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "chrome", &uuid::Uuid::new_v4().to_string()).await;
    let tabs: Vec<_> = (0..201)
        .map(|id| json!({"id":id,"url":"https://example.org/","title":"Example"}))
        .collect();
    ws.send(Message::Text(
        json!({"action":"TABS_SYNC","browser":"chrome","tabs":tabs}).to_string(),
    ))
    .await
    .unwrap();
    let result = timeout(Duration::from_secs(2), ws.next()).await.unwrap();
    assert!(!matches!(result, Some(Ok(Message::Text(_)))));
    assert!(server.instances().is_empty());
}

#[tokio::test]
async fn container_inventory_routes_to_correct_instance_and_preserves_option_fields() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut first = connect(server.port(), "firefox", "00000000-0000-4000-8000-000000000001").await;
    let mut second = connect(server.port(), "firefox", "00000000-0000-4000-8000-000000000002").await;
    for (socket, store) in [(&mut first, "firefox-default"), (&mut second, "firefox-container-1")] {
        socket.send(Message::Text(json!({"action":"CONTAINERS_LIST","containers":[{"name":"work","cookieStoreId":"firefox-container-1"}]}).to_string())).await.unwrap();
        socket.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[{"id":7,"url":"https://example.org/","title":"Example","cookieStoreId":store}]}).to_string())).await.unwrap();
        socket.send(Message::Text(json!({"action":"PING"}).to_string())).await.unwrap(); read(socket).await;
    }
    let config = browserdock_launcher::config::Config::default();
    assert_eq!(browserdock_launcher::browser_profiles(&config, Some(&server), "firefox").await, vec!["work"]);
    let task = {let server=server.clone(); tokio::spawn(async move {server.focus_or_open_with_options("firefox","https://example.org/",MatchMode::Exact,Some("work"),None).await})};
    let request=read(&mut second).await; assert_eq!(request["container"],"work");
    second.send(Message::Text(json!({"id":request["id"],"status":"ERROR","result":"ERROR_CONTAINER_NOT_FOUND"}).to_string())).await.unwrap();
    assert_eq!(task.await.unwrap().unwrap().unwrap().result,"ERROR_CONTAINER_NOT_FOUND");
    assert!(timeout(Duration::from_millis(30), first.next()).await.is_err());
}

#[tokio::test]
async fn close_tabs_request_closes_matches_and_reports_not_found_without_retry() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "firefox", &uuid::Uuid::new_v4().to_string()).await;
    ws.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[
        {"id":1,"url":"https://example.org/a","title":"A"},
        {"id":2,"url":"https://example.org/b","title":"B"},
    ]}).to_string())).await.unwrap();
    timeout(Duration::from_secs(2), async {
        loop {
            if server.instances().iter().any(|i| i.tabs.len() == 2) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let task = { let server = server.clone(); tokio::spawn(async move {
        server.close_tabs_with_options("firefox", "https://example.org/a", MatchMode::DomainOrExact, None, None).await
    })};
    let request = read(&mut ws).await;
    assert_eq!(request["action"], "CLOSE_TABS");
    assert_eq!(request["url"], "https://example.org/a");
    ws.send(Message::Text(json!({"id":request["id"],"status":"SUCCESS","result":"CLOSED_TABS","closed":2}).to_string())).await.unwrap();
    let response = task.await.unwrap().unwrap().expect("close must resolve");
    assert_eq!(response.result, "CLOSED_TABS");
    assert_eq!(response.closed, Some(2));
    // Nothing matching: no request is sent at all, so nothing can double-close.
    let none = server.close_tabs_with_options("firefox", "https://other.test/", MatchMode::DomainOrExact, None, None).await.unwrap();
    assert!(none.is_none());
    assert!(timeout(Duration::from_millis(30), ws.next()).await.is_err());
    ws.close(None).await.unwrap();
    server.shutdown();
}

#[cfg(unix)]
#[tokio::test]
async fn incognito_bypasses_companion_and_disconnected_container_returns_note() {
    use browserdock_launcher::{config::Config, options::BrowserOptions, dispatch::open_url_with_options};
    let server=BoundServer::bind(0,TOKEN).await.unwrap().start();
    let mut socket=connect(server.port(),"firefox",&uuid::Uuid::new_v4().to_string()).await;
    let mut config=Config::default(); config.browsers.iter_mut().find(|b|b.id=="firefox").unwrap().exe_path="/bin/true".into();
    let private=BrowserOptions {profile:None,container:None,incognito:Some(true)};
    assert_eq!(open_url_with_options(&config,Some(&server),"https://example.org/",None,MatchMode::Exact,Some(&private)).await.unwrap().result,"PROCESS_STARTED");
    assert!(timeout(Duration::from_millis(30),socket.next()).await.is_err());
    let container=BrowserOptions {profile:None,container:Some("work".into()),incognito:None};
    assert_eq!(open_url_with_options(&config,None,"https://example.org/",None,MatchMode::Exact,Some(&container)).await.unwrap().note.as_deref(),Some("Container needs companion; opened normally"));
}

#[tokio::test]
async fn cancelled_private_request_cannot_dispatch_or_fallback_after_container_error() {
    use browserdock_launcher::{config::Config, options::BrowserOptions, dispatch::open_url_with_options_guarded};
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    let server=BoundServer::bind(0,TOKEN).await.unwrap().start();
    let mut socket=connect(server.port(),"firefox",&uuid::Uuid::new_v4().to_string()).await;
    let options=BrowserOptions {profile:None,container:Some("work".into()),incognito:None};
    assert_eq!(open_url_with_options_guarded(&Config::default(),Some(&server),"https://example.org/",None,MatchMode::Exact,Some(&options),Arc::new(||false)).await.unwrap_err(),"Launch was cancelled");
    assert!(timeout(Duration::from_millis(30),socket.next()).await.is_err());
    let valid=Arc::new(AtomicBool::new(true));
    let task={let valid=valid.clone();let server=server.clone();tokio::spawn(async move {open_url_with_options_guarded(&Config::default(),Some(&server),"https://example.org/",None,MatchMode::Exact,Some(&options),Arc::new(move||valid.load(Ordering::SeqCst))).await})};
    let request=read(&mut socket).await;
    valid.store(false,Ordering::SeqCst);
    socket.send(Message::Text(json!({"id":request["id"],"status":"ERROR","result":"ERROR_CONTAINER_NOT_FOUND"}).to_string())).await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(),"Launch was cancelled");
}

#[tokio::test]
async fn paged_inventory_commits_atomically_and_routes_beyond_first_page() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut ws = connect(server.port(), "chrome", &uuid::Uuid::new_v4().to_string()).await;
    let snapshot = uuid::Uuid::new_v4().to_string();
    let tabs: Vec<_> = (0..200).map(|id| json!({"id":id,"url":format!("https://tab{id}.example/"),"title":"Tab"})).collect();
    ws.send(Message::Text(json!({"action":"TABS_SYNC_PAGE","browser":"chrome","snapshot_id":snapshot,"page":0,"pages":2,"tabs":tabs}).to_string())).await.unwrap();
    ws.send(Message::Text(json!({"action":"PING"}).to_string())).await.unwrap();
    assert_eq!(read(&mut ws).await["action"], "PONG");
    assert!(server.instances()[0].tabs.is_empty());
    ws.send(Message::Text(json!({"action":"TABS_SYNC_PAGE","browser":"chrome","snapshot_id":snapshot,"page":1,"pages":2,"tabs":[{"id":200,"url":"https://last.example/","title":"Last"}]}).to_string())).await.unwrap();
    ws.send(Message::Text(json!({"action":"PING"}).to_string())).await.unwrap();
    read(&mut ws).await;
    assert_eq!(server.instances()[0].tabs.len(), 201);
    let task = { let server = server.clone(); tokio::spawn(async move {
        server.close_tabs_with_options("chrome", "https://last.example/", MatchMode::Exact, None, None).await
    }) };
    let request = read(&mut ws).await;
    assert!(request["deadline_ms"].as_u64().unwrap() > 0);
    ws.send(Message::Text(json!({"id":request["id"],"status":"SUCCESS","result":"CLOSED_TABS","closed":1}).to_string())).await.unwrap();
    assert!(task.await.unwrap().unwrap().is_some());
    server.shutdown();
}

#[tokio::test]
async fn paged_inventory_rejects_out_of_order_and_oversized_page_counts() {
    for (page, pages) in [(1, 2), (0, 11)] {
        let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
        let mut ws = connect(server.port(), "chrome", &uuid::Uuid::new_v4().to_string()).await;
        ws.send(Message::Text(json!({"action":"TABS_SYNC_PAGE","browser":"chrome","snapshot_id":uuid::Uuid::new_v4().to_string(),"page":page,"pages":pages,"tabs":[]}).to_string())).await.unwrap();
        let result = timeout(Duration::from_secs(2), ws.next()).await.unwrap();
        assert!(!matches!(result, Some(Ok(Message::Text(_)))));
        server.shutdown();
    }
}
