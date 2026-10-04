use browserdock_launcher::ws_server::{BoundServer, ServerHandle};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};
const TOKEN: &str = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";
async fn connect(
    server: &ServerHandle,
    capable: bool,
) -> (
    String,
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    let id = uuid::Uuid::new_v4().to_string();
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", server.port()))
        .await
        .unwrap();
    socket.send(Message::Text(json!({"type":"AUTH","token":TOKEN,"browser":"firefox","instance_id":id,"capabilities":if capable {vec!["public_tabs_v1"]} else {vec![]}}).to_string())).await.unwrap();
    socket.next().await.unwrap().unwrap();
    (id, socket)
}
async fn next(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("Expected read request")
    };
    serde_json::from_str(&text).unwrap()
}
fn reply(id: &str, private: bool) -> Value {
    json!({"action":"PUBLIC_TABS_RESULT","id":id,"ok":true,"tabs":[{"id":1,"title":"Public page","url":"https://a.test/","container":null,"incognito":private}]})
}
#[tokio::test]
async fn public_review_is_fresh_instance_scoped_and_read_only() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let (id, mut socket) = connect(&server, true).await;
    let (_other, mut other) = connect(&server, true).await;
    socket.send(Message::Text(json!({"action":"TABS_SYNC","browser":"firefox","tabs":[{"id":99,"title":"Cached","url":"https://cached.test/"}]}).to_string())).await.unwrap();
    let handle = server.clone();
    let task = tokio::spawn(async move { handle.public_tabs(&id).await });
    let request = next(&mut socket).await;
    assert_eq!(request["action"], "LIST_PUBLIC_TABS");
    other
        .send(Message::Text(
            reply(request["id"].as_str().unwrap(), false).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!task.is_finished());
    socket
        .send(Message::Text(
            reply(request["id"].as_str().unwrap(), false).to_string(),
        ))
        .await
        .unwrap();
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.tabs[0].url, "https://a.test/");
    assert_eq!(result.browser, "firefox");
    server.shutdown();
}
#[tokio::test]
async fn public_review_rejects_old_companions_and_private_replies() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let (id, _legacy) = connect(&server, false).await;
    assert!(server
        .public_tabs(&id)
        .await
        .err()
        .unwrap()
        .contains("Update"));
    let (id, mut socket) = connect(&server, true).await;
    let handle = server.clone();
    let task = tokio::spawn(async move { handle.public_tabs(&id).await });
    let request = next(&mut socket).await;
    socket
        .send(Message::Text(
            reply(request["id"].as_str().unwrap(), true).to_string(),
        ))
        .await
        .unwrap();
    assert!(task.await.unwrap().is_err());
    server.shutdown();
}
