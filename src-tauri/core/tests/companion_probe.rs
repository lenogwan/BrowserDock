use browserdock_launcher::ws_server::BoundServer;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const TOKEN: &str = "ecda3360-3dc8-44d8-b21b-b35ca26bd962";

async fn connect(
    port: u16,
    browser: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .unwrap();
    socket.send(Message::Text(json!({"type":"AUTH","token":TOKEN,"browser":browser,"instance_id":uuid::Uuid::new_v4().to_string()}).to_string())).await.unwrap();
    assert!(matches!(
        socket.next().await.unwrap().unwrap(),
        Message::Text(_)
    ));
    socket
}

#[tokio::test]
async fn probe_requires_fresh_replies_from_every_selected_browser_instance() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut first = connect(server.port(), "firefox").await;
    let mut second = connect(server.port(), "firefox").await;
    let mut other = connect(server.port(), "chrome").await;
    let handle = server.clone();
    let task = tokio::spawn(async move { handle.test_connection("firefox").await });
    let Message::Ping(nonce) = first.next().await.unwrap().unwrap() else {
        panic!("Expected read-only ping")
    };
    let Message::Ping(second_nonce) = second.next().await.unwrap().unwrap() else {
        panic!("Expected read-only ping")
    };
    assert_eq!(nonce, second_nonce);
    // Another browser cannot acknowledge the selected instances' checks.
    other.send(Message::Pong(nonce.clone())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!task.is_finished());
    first.send(Message::Pong(nonce)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!task.is_finished());
    second.send(Message::Pong(second_nonce)).await.unwrap();
    assert_eq!(task.await.unwrap().unwrap(), 2);
    assert!(timeout(Duration::from_millis(30), other.next())
        .await
        .is_err());
    server.shutdown();
}

#[tokio::test]
async fn probe_reports_missing_browser_and_disconnect_without_launching() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    assert!(server
        .test_connection("custom")
        .await
        .unwrap_err()
        .contains("Unknown"));
    assert!(server
        .test_connection("firefox")
        .await
        .unwrap_err()
        .contains("No companion"));
    let mut socket = connect(server.port(), "firefox").await;
    let handle = server.clone();
    let task = tokio::spawn(async move { handle.test_connection("firefox").await });
    assert!(matches!(
        socket.next().await.unwrap().unwrap(),
        Message::Ping(_)
    ));
    drop(socket);
    assert!(task.await.unwrap().unwrap_err().contains("disconnected"));
    server.shutdown();
}

#[tokio::test]
async fn probe_times_out_and_a_later_probe_can_succeed() {
    let server = BoundServer::bind(0, TOKEN).await.unwrap().start();
    let mut socket = connect(server.port(), "edge").await;
    // Do not read: Tungstenite queues automatic pongs only when polled.
    assert!(server
        .test_connection("edge")
        .await
        .unwrap_err()
        .contains("five seconds"));
    let handle = server.clone();
    let task = tokio::spawn(async move { handle.test_connection("edge").await });
    for _ in 0..2 {
        let Message::Ping(nonce) = socket.next().await.unwrap().unwrap() else {
            panic!("Expected ping")
        };
        socket.send(Message::Pong(nonce)).await.unwrap();
    }
    assert_eq!(task.await.unwrap().unwrap(), 1);
    server.shutdown();
}
