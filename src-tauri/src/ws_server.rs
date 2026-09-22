//! Local companion transport. Socket ownership stays in one task per connection;
//! callers communicate through bounded channels, never shared WebSocket sinks.
pub use crate::ws_protocol::{MatchMode, Response, Tab, TabGroupHint};
use crate::{
    routing::parse_url,
    ws_protocol::{match_score, Auth, TabSync, MAX_MESSAGE_BYTES, MAX_URL_BYTES},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch, Semaphore},
    task::JoinSet,
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{Request, Response as HandshakeResponse},
        protocol::WebSocketConfig,
        Message,
    },
};

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONNECTIONS: usize = 32;

struct Client {
    browser: String,
    tx: mpsc::Sender<Message>,
    tabs: Vec<Tab>,
    containers: Vec<Container>,
    pending: HashMap<String, oneshot::Sender<Response>>,
    snapshot: Option<TabSnapshot>,
    tab_groups: bool,
}

struct TabSnapshot {
    id: String,
    pages: usize,
    next: usize,
    started: Instant,
    tabs: Vec<Tab>,
}

#[derive(serde::Deserialize)]
struct TabPage {
    snapshot_id: String,
    page: usize,
    pages: usize,
    #[serde(flatten)]
    sync: TabSync,
}

fn request_deadline_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + REQUEST_TIMEOUT.as_millis() as u64
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub struct Container {
    pub name: String,
    #[serde(rename = "cookieStoreId")]
    pub cookie_store_id: String,
}

type Registry = Arc<Mutex<HashMap<String, Client>>>;

#[derive(Clone, Debug, Serialize)]
pub struct Instance {
    pub instance_id: String,
    pub browser: String,
    pub tabs: Vec<Tab>,
    pub containers: Vec<Container>,
}

/// Compact poll payload for open-tab indicators: parsed, deduplicated hosts
/// instead of full tab snapshots (titles/ids never leave the backend on the
/// per-second path). The UI derives the same matches from this.
#[derive(Clone, Debug, Serialize)]
pub struct DigestTab {
    pub host: String,
    #[serde(rename = "cookieStoreId", skip_serializing_if = "Option::is_none")]
    pub cookie_store_id: Option<String>,
    #[serde(rename = "groupTitle", skip_serializing_if = "Option::is_none")]
    pub group_title: Option<String>,
    #[serde(rename = "groupColor", skip_serializing_if = "Option::is_none")]
    pub group_color: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstanceDigest {
    pub instance_id: String,
    pub browser: String,
    pub tabs: Vec<DigestTab>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub containers: Vec<Container>,
}

pub struct BoundServer {
    listener: TcpListener,
    token: String,
    port: u16,
}

impl BoundServer {
    /// Port zero is useful for isolated tests; application configuration rejects it.
    pub async fn bind(port: u16, token: &str) -> Result<Self, String> {
        if !uuid::Uuid::parse_str(token).is_ok_and(|id| id.get_version_num() == 4) {
            return Err("Companion auth_token must be a UUIDv4".into());
        }
        let mut candidate = port;
        loop {
            match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, candidate)).await {
                Ok(listener) => {
                    let port = listener
                        .local_addr()
                        .map_err(|_| "Cannot read companion port")?
                        .port();
                    return Ok(Self {
                        listener,
                        token: token.into(),
                        port,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AddrInUse && candidate < u16::MAX => {
                    candidate += 1
                }
                Err(error) => return Err(format!("Cannot bind companion listener: {error}")),
            }
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn start(self) -> ServerHandle {
        let registry = Registry::default();
        let (shutdown, receiver) = watch::channel(false);
        let error = Arc::new(Mutex::new(None));
        tokio::spawn(serve(
            self.listener,
            self.token,
            registry.clone(),
            receiver,
            error.clone(),
        ));
        ServerHandle(Arc::new(ServerInner {
            port: self.port,
            registry,
            shutdown,
            error,
        }))
    }
}

/// Persist an alternate port before accepting clients, keeping pairing settings authoritative.
pub async fn start_configured(
    config: &mut crate::config::Config,
    path: &std::path::Path,
) -> Result<ServerHandle, String> {
    let port = config
        .settings
        .get("ws_port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or("ws_port must be between 1 and 65535")? as u16;
    let token = config
        .settings
        .get("auth_token")
        .and_then(Value::as_str)
        .ok_or("Missing companion auth_token")?;
    let bound = BoundServer::bind(port, token).await?;
    if bound.port() != port {
        let mut updated = config.clone();
        updated
            .settings
            .insert("ws_port".into(), json!(bound.port()));
        updated.settings.insert(
            "ws_port_warning".into(),
            json!(format!(
                "Companion port {port} was occupied; re-pair companions to port {}.",
                bound.port()
            )),
        );
        updated.save(path)?;
        *config = updated;
        eprintln!(
            "BrowserDock companion port {port} is occupied; using {}",
            bound.port()
        );
    }
    Ok(bound.start())
}

struct ServerInner {
    port: u16,
    registry: Registry,
    shutdown: watch::Sender<bool>,
    error: Arc<Mutex<Option<String>>>,
}

impl Drop for ServerInner {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

#[derive(Clone)]
pub struct ServerHandle(Arc<ServerInner>);

pub struct GroupCommand<'a> {
    pub browser: &'a str,
    pub urls: &'a [String],
    pub hint: &'a TabGroupHint,
    pub container: Option<&'a str>,
    pub profile: Option<&'a str>,
    pub close: bool,
}

impl ServerHandle {
    pub fn error(&self) -> Option<String> {
        self.0
            .error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    pub fn port(&self) -> u16 {
        self.0.port
    }

    /// In-memory only. UI can derive open-tab indicators from these snapshots.
    pub fn instances(&self) -> Vec<Instance> {
        let registry = self
            .0
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut instances: Vec<_> = registry
            .iter()
            .map(|(id, client)| Instance {
                instance_id: id.clone(),
                browser: client.browser.clone(),
                tabs: client.tabs.clone(),
                containers: client.containers.clone(),
            })
            .collect();
        instances.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
        instances
    }

    /// Deduplicated per-instance host inventory for the UI poll loop.
    /// Unparseable tab URLs are skipped, matching indicator semantics.
    pub fn tabs_digest(&self) -> Vec<InstanceDigest> {
        let registry = self
            .0
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut digests = Vec::with_capacity(registry.len());
        for (id, client) in registry.iter() {
            let mut seen = HashSet::new();
            let mut tabs = Vec::new();
            for tab in &client.tabs {
                let Ok(url) = parse_url(&tab.url) else {
                    continue;
                };
                let Some(host) = url.host_str() else { continue };
                if seen.insert((
                    host.to_owned(),
                    tab.cookie_store_id.clone(),
                    tab.group_title.clone(),
                    tab.group_color.clone(),
                )) {
                    tabs.push(DigestTab {
                        host: host.to_owned(),
                        cookie_store_id: tab.cookie_store_id.clone(),
                        group_title: tab.group_title.clone(),
                        group_color: tab.group_color.clone(),
                    });
                }
            }
            tabs.sort_by(|a, b| a.host.cmp(&b.host));
            digests.push(InstanceDigest {
                instance_id: id.clone(),
                browser: client.browser.clone(),
                tabs,
                containers: client.containers.clone(),
            });
        }
        digests.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
        digests
    }

    pub fn shutdown(&self) {
        let _ = self.0.shutdown.send(true);
        self.0
            .registry
            .lock()
            .expect("companion registry poisoned")
            .clear();
    }

    /// None means no companion: it is safe to use process fallback. Once queued,
    /// a timeout/disconnect is ambiguous and MUST NOT cause another open request.
    pub async fn focus_or_open(
        &self,
        browser: &str,
        input: &str,
        mode: MatchMode,
    ) -> Result<Option<Response>, String> {
        self.focus_or_open_with_options(browser, input, mode, None, None)
            .await
    }

    pub async fn focus_or_open_with_options(
        &self,
        browser: &str,
        input: &str,
        mode: MatchMode,
        container: Option<&str>,
        profile: Option<&str>,
    ) -> Result<Option<Response>, String> {
        self.focus_or_open_with_group(browser, input, mode, container, profile, None)
            .await
    }

    pub async fn focus_or_open_with_group(
        &self,
        browser: &str,
        input: &str,
        mode: MatchMode,
        container: Option<&str>,
        profile: Option<&str>,
        tab_group: Option<&TabGroupHint>,
    ) -> Result<Option<Response>, String> {
        if tab_group.is_some_and(|g| !g.valid()) {
            return Err("Invalid tab group".into());
        }
        let url = parse_url(input)?;
        if url.as_str().len() > MAX_URL_BYTES {
            return Err("Companion URL exceeds 2048 bytes".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (instance_id, receiver, group_support) = {
            let mut registry = self
                .0
                .registry
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let selected = registry
                .iter()
                .filter(|(_, client)| client.browser == browser)
                .map(|(id, client)| {
                    (
                        id.clone(),
                        client
                            .tabs
                            .iter()
                            .filter(|tab| {
                                container.is_none_or(|name| {
                                    tab.cookie_store_id.as_deref() == Some(name)
                                        || client.containers.iter().any(|c| {
                                            c.name == name
                                                && tab.cookie_store_id.as_deref()
                                                    == Some(c.cookie_store_id.as_str())
                                        })
                                })
                            })
                            .map(|tab| match_score(&tab.url, &url, mode))
                            .max()
                            .unwrap_or(0),
                    )
                })
                .max_by(|(id_a, score_a), (id_b, score_b)| {
                    score_a.cmp(score_b).then(id_b.cmp(id_a))
                })
                .map(|(id, _)| id);
            let Some(instance_id) = selected else {
                return Ok(None);
            };
            // The client may disconnect between selection and use; treat a
            // vanished instance as "no companion" so callers fall back safely.
            let Some(client) = registry.get_mut(&instance_id) else {
                return Ok(None);
            };
            if client.pending.len() >= 16 {
                return Err("Companion has too many pending requests".into());
            }
            let (reply, receiver) = oneshot::channel();
            let message = Message::Text(
                json!({"id":id,"action":"FOCUS_OR_OPEN","tab_group":tab_group,"url":url.as_str(),"match_mode":mode,"container":container,"profile":profile,"deadline_ms":request_deadline_ms()})
                    .to_string(),
            );
            client
                .tx
                .try_send(message)
                .map_err(|_| "Companion is busy or disconnected")?;
            client.pending.insert(id.clone(), reply);
            (instance_id, receiver, client.tab_groups)
        };
        // Cleanup also runs if the caller cancels this future.
        let _pending = PendingGuard {
            registry: self.0.registry.clone(),
            instance_id,
            id,
        };
        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(mut response)) if response.status == "SUCCESS" => {
                if tab_group.is_some() && !group_support {
                    response.note =
                        Some("Update the companion to enable automatic tab grouping".into());
                }
                Ok(Some(response))
            }
            Ok(Ok(response)) if response.result == "ERROR_CONTAINER_NOT_FOUND" => {
                Ok(Some(response))
            }
            // The Edge companion sends this only before any tab mutation.
            // Unlike a timeout/API error, executable fallback cannot duplicate it.
            Ok(Ok(response))
                if browser == "edge" && response.result == "ERROR_NO_BROWSER_WINDOW" =>
            {
                Ok(Some(response))
            }
            Ok(Ok(response)) => Err(format!(
                "Companion could not focus or open the tab ({})",
                response.result
            )
            .into()),
            Ok(Err(_)) => {
                Err("Companion disconnected; the request may already have opened a tab".into())
            }
            Err(_) => Err("Companion timed out; the request may already have opened a tab".into()),
        }
    }

    /// Ask the companion to close tabs matching `input` (exact URL first,
    /// then hostname for `DomainOrExact`) within the container scope.
    /// Unlike focus/open there is no process fallback: `Ok(None)` means no
    /// connected instance holds a matching tab. A single attempt is made;
    /// timeouts/disconnects are reported, never retried, since the tabs may
    /// already be closed.
    pub async fn close_tabs_with_options(
        &self,
        browser: &str,
        input: &str,
        mode: MatchMode,
        container: Option<&str>,
        profile: Option<&str>,
    ) -> Result<Option<Response>, String> {
        let url = parse_url(input)?;
        if url.as_str().len() > MAX_URL_BYTES {
            return Err("Companion URL exceeds 2048 bytes".into());
        }
        if matches!(mode, MatchMode::NewTab) {
            return Err("Close requests must use exact or domain matching".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (instance_id, receiver) = {
            let mut registry = self
                .0
                .registry
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let selected = registry
                .iter()
                .filter(|(_, client)| client.browser == browser)
                .map(|(id, client)| {
                    (
                        id.clone(),
                        client
                            .tabs
                            .iter()
                            .filter(|tab| {
                                container.is_none_or(|name| {
                                    tab.cookie_store_id.as_deref() == Some(name)
                                        || client.containers.iter().any(|c| {
                                            c.name == name
                                                && tab.cookie_store_id.as_deref()
                                                    == Some(c.cookie_store_id.as_str())
                                        })
                                })
                            })
                            .map(|tab| match_score(&tab.url, &url, mode))
                            .max()
                            .unwrap_or(0),
                    )
                })
                .max_by(|(id_a, score_a), (id_b, score_b)| {
                    score_a.cmp(score_b).then(id_b.cmp(id_a))
                });
            let Some((instance_id, score)) = selected else {
                return Ok(None);
            };
            if score == 0 {
                return Ok(None);
            }
            let Some(client) = registry.get_mut(&instance_id) else {
                return Ok(None);
            };
            if client.pending.len() >= 16 {
                return Err("Companion has too many pending requests".into());
            }
            let (reply, receiver) = oneshot::channel();
            let message = Message::Text(
                json!({"id":id,"action":"CLOSE_TABS","url":url.as_str(),"match_mode":mode,"container":container,"profile":profile,"deadline_ms":request_deadline_ms()})
                    .to_string(),
            );
            client
                .tx
                .try_send(message)
                .map_err(|_| "Companion is busy or disconnected")?;
            client.pending.insert(id.clone(), reply);
            (instance_id, receiver)
        };
        let _pending = PendingGuard {
            registry: self.0.registry.clone(),
            instance_id,
            id,
        };
        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) if response.status == "SUCCESS" => Ok(Some(response)),
            Ok(Ok(response)) if response.result == "ERROR_TAB_NOT_FOUND" => Ok(Some(response)),
            Ok(Ok(response)) if response.result == "ERROR_CONTAINER_NOT_FOUND" => {
                Ok(Some(response))
            }
            Ok(Ok(_)) => Err("Companion could not close the tab".into()),
            Ok(Err(_)) => Err("Companion disconnected; the tabs may already be closed".into()),
            Err(_) => Err("Companion timed out; the tabs may already be closed".into()),
        }
    }
    pub async fn open_group_tabs(
        &self,
        browser: &str,
        urls: &[String],
        hint: &TabGroupHint,
        container: Option<&str>,
        profile: Option<&str>,
    ) -> Result<Option<Response>, String> {
        if urls.is_empty()
            || urls.len() > 50
            || urls
                .iter()
                .any(|u| u.len() > MAX_URL_BYTES || parse_url(u).is_err())
        {
            return Err("A tab group must contain 1–50 valid URLs".into());
        }
        self.group_request(
            GroupCommand {
                browser,
                urls,
                hint,
                container,
                profile,
                close: false,
            },
            None,
        )
        .await
    }

    pub async fn close_group_tabs(
        &self,
        browser: &str,
        hint: &TabGroupHint,
        container: Option<&str>,
        profile: Option<&str>,
    ) -> Result<Option<Response>, String> {
        self.group_request(
            GroupCommand {
                browser,
                urls: &[],
                hint,
                container,
                profile,
                close: true,
            },
            None,
        )
        .await
    }

    pub async fn group_tabs_guarded(
        &self,
        command: GroupCommand<'_>,
        guard: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Option<Response>, String> {
        self.group_request(command, Some(guard)).await
    }

    async fn group_request(
        &self,
        command: GroupCommand<'_>,
        guard: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<Option<Response>, String> {
        let GroupCommand {
            browser,
            urls,
            hint,
            container,
            profile,
            close,
        } = command;
        if guard.as_ref().is_some_and(|g| !g()) {
            return Err("Group action was cancelled".into());
        }
        if !close
            && (urls.is_empty()
                || urls.len() > 50
                || urls
                    .iter()
                    .any(|u| u.len() > MAX_URL_BYTES || parse_url(u).is_err()))
        {
            return Err("A tab group must contain 1–50 valid URLs".into());
        }
        if !hint.valid()
            || [container, profile]
                .into_iter()
                .flatten()
                .any(|v| !crate::options::valid_name(v))
        {
            return Err("Invalid tab group options".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (instance_id, receiver) = {
            let mut registry = self.0.registry.lock().unwrap_or_else(|e| e.into_inner());
            let selected = registry
                .iter()
                .filter(|(_, c)| c.browser == browser)
                .map(|(id, c)| {
                    (
                        id.clone(),
                        c.tabs
                            .iter()
                            .filter(|t| {
                                t.group_title.as_deref() == Some(&hint.name)
                                    && container.is_none_or(|name| {
                                        t.cookie_store_id.as_deref() == Some(name)
                                            || c.containers.iter().any(|v| {
                                                v.name == name
                                                    && t.cookie_store_id.as_deref()
                                                        == Some(&v.cookie_store_id)
                                            })
                                    })
                            })
                            .count(),
                    )
                })
                .max_by(|(a, sa), (b, sb)| sa.cmp(sb).then(b.cmp(a)));
            let Some((instance_id, _)) = selected else {
                return Ok(None);
            };
            let client = registry
                .get_mut(&instance_id)
                .ok_or("Companion disconnected")?;
            if !client.tab_groups {
                return Err("Update the companion to use group actions".into());
            }
            if client.pending.len() >= 16 {
                return Err("Companion has too many pending requests".into());
            }
            let mut message = json!({"id":id,"action":if close { "CLOSE_GROUP" } else { "OPEN_GROUP" },"tab_group":hint,"container":container,"profile":profile,"deadline_ms":request_deadline_ms()});
            if !close {
                message["urls"] = json!(urls);
            }
            let message = message.to_string();
            if message.len() > 16384 {
                return Err("Tab group request exceeds 16 KB; use a smaller group".into());
            }
            let (reply, receiver) = oneshot::channel();
            client
                .tx
                .try_send(Message::Text(message))
                .map_err(|_| "Companion is busy or disconnected")?;
            client.pending.insert(id.clone(), reply);
            (instance_id, receiver)
        };
        let _pending = PendingGuard {
            registry: self.0.registry.clone(),
            instance_id: instance_id.clone(),
            id: id.clone(),
        };
        let cancelled = async {
            loop {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if guard.as_ref().is_some_and(|g| !g()) {
                    break;
                }
            }
        };
        let result = tokio::select! {
            result = timeout(REQUEST_TIMEOUT, receiver) => result,
            _ = cancelled => {
                let registry = self.0.registry.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(client) = registry.get(&instance_id) {
                    let _ = client.tx.try_send(Message::Text(json!({"action":"CANCEL_REQUEST", "id":id}).to_string()));
                }
                return Err("Group action was cancelled; already-issued browser operations may have completed".into());
            }
        };
        match result {
            Ok(Ok(response)) if response.status == "SUCCESS" || (close && response.result == "ERROR_TAB_NOT_FOUND") => Ok(Some(response)),
            // Background-only Edge reports this before any tab mutation, so
            // opening safely falls back to a plain process launch exactly like
            // a missing companion. Closing has no fallback and keeps the error.
            Ok(Ok(response)) if !close && response.result == "ERROR_NO_BROWSER_WINDOW" => Ok(None),
            // Name the companion result code: without it every group failure
            // reports identically and the cause cannot be traced.
            Ok(Ok(response)) => Err(format!(
                "Companion could not finish the group action ({}); some tabs may have changed. No retry was made",
                response.result
            )
            .into()),
            Ok(Err(_)) => Err("Companion disconnected during the group action; some tabs may have changed. No retry was made".into()),
            Err(_) => Err("Companion timed out during the group action; some tabs may have changed. No retry was made".into()),
        }
    }
}

struct PendingGuard {
    registry: Registry,
    instance_id: String,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(client) = self
            .registry
            .lock()
            .expect("companion registry poisoned")
            .get_mut(&self.instance_id)
        {
            client.pending.remove(&self.id);
        }
    }
}

async fn serve(
    listener: TcpListener,
    token: String,
    registry: Registry,
    mut shutdown: watch::Receiver<bool>,
    error_status: Arc<Mutex<Option<String>>>,
) {
    let capacity = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        *error_status.lock().unwrap_or_else(|error| error.into_inner()) = Some(format!("Companion connection failed: {error}"));
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                *error_status.lock().unwrap_or_else(|error| error.into_inner()) = None;
                let Ok(permit) = capacity.clone().try_acquire_owned() else { continue; };
                let (token, registry, mut shutdown) = (token.clone(), registry.clone(), shutdown.clone());
                tasks.spawn(async move {
                    let _permit = permit;
                    tokio::select! {
                        biased;
                        _ = shutdown.changed() => {},
                        _ = connection(stream, &token, registry) => {},
                    }
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    registry
        .lock()
        .expect("companion registry poisoned")
        .clear();
}

// Tungstenite fixes the handshake callback's error type to an HTTP Response.
#[allow(clippy::result_large_err)]
async fn connection(stream: TcpStream, token: &str, registry: Registry) {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    let authenticated = timeout(AUTH_TIMEOUT, async {
        let mut socket = accept_hdr_async_with_config(
            stream,
            |request: &Request, response: HandshakeResponse| {
                // Ordinary web pages cannot connect even if they guess a port. Local
                // native clients may omit Origin, but still need the token.
                if let Some(origin) = request.headers().get("origin") {
                    if !origin.to_str().is_ok_and(|value| {
                        value.starts_with("chrome-extension://")
                            || value.starts_with("moz-extension://")
                    }) {
                        let mut rejected = tokio_tungstenite::tungstenite::http::Response::new(
                            Some("Forbidden".into()),
                        );
                        *rejected.status_mut() =
                            tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                        return Err(rejected);
                    }
                }
                Ok(response)
            },
            Some(config),
        )
        .await
        .ok()?;
        let Message::Text(text) = socket.next().await?.ok()? else {
            return None;
        };
        if text.len() > 4096 {
            return None;
        }
        let auth: Auth = serde_json::from_str(&text).ok()?;
        if !auth.valid(token) {
            return None;
        }
        Some((socket, auth))
    })
    .await;
    let Ok(Some((mut socket, auth))) = authenticated else {
        return;
    };
    // Canonical UUID spelling prevents aliases bypassing duplicate-ID protection.
    let Ok(instance_id) = uuid::Uuid::parse_str(&auth.instance_id).map(|id| id.to_string()) else {
        return;
    };
    let (tx, mut rx) = mpsc::channel(16);
    {
        let mut clients = registry.lock().unwrap_or_else(|error| error.into_inner());
        if clients.contains_key(&instance_id) {
            return;
        }
        clients.insert(
            instance_id.clone(),
            Client {
                browser: auth.browser.clone(),
                tx,
                tabs: vec![],
                containers: vec![],
                pending: HashMap::new(),
                snapshot: None,
                tab_groups: auth.capabilities.iter().any(|v| v == "tab_groups_v1"),
            },
        );
    }
    let _registration = Registration {
        registry: registry.clone(),
        instance_id: instance_id.clone(),
    };
    if !matches!(
        timeout(
            AUTH_TIMEOUT,
            socket.send(Message::Text(
                json!({"type":"AUTH_OK","capabilities":["paged_tabs_v1"]}).to_string()
            ))
        )
        .await,
        Ok(Ok(()))
    ) {
        return;
    }
    let mut idle_deadline = Instant::now() + IDLE_TIMEOUT;
    loop {
        tokio::select! {
            message = rx.recv() => {
                let Some(message) = message else { break; };
                if !matches!(timeout(REQUEST_TIMEOUT, socket.send(message)).await, Ok(Ok(()))) { break; }
            },
            _ = tokio::time::sleep_until(idle_deadline) => break,
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                idle_deadline = Instant::now() + IDLE_TIMEOUT;
                match message {
                    Message::Text(text) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                        if value.get("action").and_then(Value::as_str) == Some("PING") {
                            if !matches!(timeout(REQUEST_TIMEOUT, socket.send(Message::Text(json!({"action":"PONG"}).to_string()))).await, Ok(Ok(()))) { break; }
                        } else if !receive(value, &registry, &instance_id, &auth.browser) { break; }
                    },
                    Message::Ping(_) => {
                        if !matches!(timeout(REQUEST_TIMEOUT, socket.flush()).await, Ok(Ok(()))) { break; }
                    },
                    Message::Pong(_) => {},
                    _ => break,
                }
            }
        }
    }
}

struct Registration {
    registry: Registry,
    instance_id: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.registry
            .lock()
            .expect("companion registry poisoned")
            .remove(&self.instance_id);
    }
}

fn receive(value: Value, registry: &Registry, instance_id: &str, browser: &str) -> bool {
    let mut clients = registry.lock().unwrap_or_else(|error| error.into_inner());
    let Some(client) = clients.get_mut(instance_id) else {
        return false;
    };
    if value.get("action").and_then(Value::as_str) == Some("CONTAINERS_LIST") {
        let Some(value) = value.get("containers") else {
            return false;
        };
        let Ok(containers) = serde_json::from_value::<Vec<Container>>(value.clone()) else {
            return false;
        };
        if containers.len() > 200
            || containers
                .iter()
                .any(|c| c.name.len() > 128 || !crate::options::valid_name(&c.cookie_store_id))
        {
            return false;
        }
        client.containers = containers;
    } else if value.get("action").and_then(Value::as_str) == Some("TABS_SYNC_PAGE") {
        let Ok(page) = serde_json::from_value::<TabPage>(value) else {
            return false;
        };
        if !page.sync.valid(browser)
            || page.pages == 0
            || page.pages > 10
            || page.page >= page.pages
            || uuid::Uuid::parse_str(&page.snapshot_id).is_err()
            || (page.page + 1 < page.pages && page.sync.tabs.len() != 200)
            || (page.pages > 1 && page.sync.tabs.is_empty())
        {
            return false;
        }
        let now = Instant::now();
        if page.page == 0 {
            client.snapshot = Some(TabSnapshot {
                id: page.snapshot_id.clone(),
                pages: page.pages,
                next: 0,
                started: now,
                tabs: Vec::new(),
            });
        }
        let Some(snapshot) = client.snapshot.as_mut() else {
            return false;
        };
        if snapshot.id != page.snapshot_id
            || snapshot.pages != page.pages
            || snapshot.next != page.page
            || now.duration_since(snapshot.started) >= Duration::from_secs(5)
        {
            return false;
        }
        let ids: HashSet<_> = snapshot.tabs.iter().map(|t| t.id).collect();
        if page.sync.tabs.iter().any(|t| ids.contains(&t.id)) {
            return false;
        }
        snapshot.tabs.extend(page.sync.tabs);
        snapshot.next += 1;
        if snapshot.next == snapshot.pages {
            // `take()` cannot fail here: `snapshot` was just built/extended
            // above, but a missing snapshot must never panic the connection.
            let Some(snapshot) = client.snapshot.take() else {
                return false;
            };
            // Sender throttling does not guarantee spaced arrival after
            // transport/event-loop stalls. Never discard the newest snapshot.
            client.tabs = snapshot.tabs;
        }
    } else if value.get("action").and_then(Value::as_str) == Some("TABS_SYNC") {
        let Ok(sync) = serde_json::from_value::<TabSync>(value) else {
            return false;
        };
        if !sync.valid(browser) {
            return false;
        }
        client.snapshot = None;
        client.tabs = sync.tabs;
    } else {
        let Ok(reply) = serde_json::from_value::<Response>(value) else {
            return false;
        };
        if !reply.valid() {
            return false;
        }
        if let Some(pending) = client.pending.remove(&reply.id) {
            let _ = pending.send(reply);
        }
    }
    true
}
