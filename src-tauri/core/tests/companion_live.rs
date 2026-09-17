use browserdock_launcher::ws_server::{BoundServer, MatchMode};
use std::process::{Child, Command, Stdio};
use tokio::time::{timeout, Duration};

struct Client(Child);
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn production_javascript_companion_speaks_to_rust_server() {
    let token = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";
    let server = BoundServer::bind(0, token).await.unwrap().start();
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/companion-client.mjs");
    let _client = Client(
        Command::new("node")
            .arg(fixture)
            .arg(server.port().to_string())
            .arg(token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("Node.js is needed for the cross-language test"),
    );
    timeout(Duration::from_secs(5), async {
        while server
            .instances()
            .first()
            .is_none_or(|instance| instance.tabs.is_empty())
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Companion did not authenticate and sync tabs");
    let focused = server
        .focus_or_open(
            "firefox",
            "https://github.com/issues",
            MatchMode::DomainOrExact,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(focused.result, "FOCUSED_EXISTING");
    assert_eq!(focused.tab_id, Some(1));
    let opened = server
        .focus_or_open("firefox", "https://example.org/", MatchMode::Exact)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened.result, "OPENED_NEW_TAB");
    assert_eq!(opened.tab_id, Some(2));
    let forced = server
        .focus_or_open("firefox", "https://github.com/pulls", MatchMode::NewTab)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(forced.result, "OPENED_NEW_TAB");
    assert_eq!(forced.tab_id, Some(3));
    server.shutdown();
}
