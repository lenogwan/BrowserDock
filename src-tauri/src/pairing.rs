//! One-click companion pairing without exposing the bearer token to the webview.
//!
//! The frontend never receives `auth_token`: it only invokes backend commands
//! that copy a pairing code to the OS clipboard or write pairing files to
//! disk. The extension options page imports either artifact, so users never
//! open `config.json` by hand.
//!
//! Wire format (shared with `extension/src/options.js`):
//! - File: pretty JSON `{"browser","token","port","includePrivate"}`.
//! - Code: `BD1.<base64url_nopad(json)>` — a single line safe for clipboard.

use crate::config::Config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const PAIRING_CODE_PREFIX: &str = "BD1.";
pub const BROWSERS: [&str; 4] = ["firefox", "mullvad", "chrome", "edge"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingPayload {
    pub browser: String,
    pub token: String,
    pub port: u16,
    #[serde(rename = "includePrivate", default)]
    pub include_private: bool,
}

pub fn valid_browser(id: &str) -> bool {
    BROWSERS.contains(&id)
}

/// Mullvad is always private: its default export opts into private tabs so the
/// dock sees a non-empty inventory. Every other browser defaults to opted out.
pub fn default_include_private(browser: &str) -> bool {
    browser == "mullvad"
}

fn auth_parts(config: &Config) -> Result<(String, u16), String> {
    let token = config
        .settings
        .get("auth_token")
        .and_then(Value::as_str)
        .ok_or("Missing companion auth_token")?;
    if !uuid::Uuid::parse_str(token).is_ok_and(|id| id.get_version_num() == 4) {
        return Err("Companion auth_token must be a UUIDv4".into());
    }
    let port = config
        .settings
        .get("ws_port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or("ws_port must be between 1 and 65535")? as u16;
    Ok((token.to_owned(), port))
}

pub fn pairing_payload(
    config: &Config,
    browser_id: &str,
    include_private: Option<bool>,
) -> Result<PairingPayload, String> {
    if !valid_browser(browser_id) {
        return Err("Choose firefox, mullvad, chrome or edge".into());
    }
    let (token, port) = auth_parts(config)?;
    Ok(PairingPayload {
        browser: browser_id.into(),
        token,
        port,
        include_private: include_private.unwrap_or_else(|| default_include_private(browser_id)),
    })
}

fn b64_encode(raw: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((raw.len() + 2) / 3 * 4);
    for chunk in raw.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

fn b64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut values = Vec::with_capacity(text.len());
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("Pairing code is not valid base64url".into()),
        };
        values.push(value);
    }
    if values.len() % 4 == 1 {
        return Err("Pairing code has invalid length".into());
    }
    let mut out = Vec::with_capacity(values.len() / 4 * 3);
    for chunk in values.chunks(4) {
        let n = match chunk.len() {
            4 => (u32::from(chunk[0]) << 18)
                | (u32::from(chunk[1]) << 12)
                | (u32::from(chunk[2]) << 6)
                | u32::from(chunk[3]),
            3 => {
                (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12) | (u32::from(chunk[2]) << 6)
            }
            2 => (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12),
            _ => return Err("Pairing code has invalid length".into()),
        };
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Single-line clipboard code. Never returned to the webview — the backend
/// copies it straight to the OS clipboard.
pub fn pairing_code(
    config: &Config,
    browser_id: &str,
    include_private: Option<bool>,
) -> Result<String, String> {
    let payload = pairing_payload(config, browser_id, include_private)?;
    let raw = serde_json::to_vec(&payload).map_err(|_| "Cannot encode pairing code")?;
    Ok(format!("{PAIRING_CODE_PREFIX}{}", b64_encode(&raw)))
}

/// Parse a pasted code or raw JSON file body. Shared validation with the
/// extension options page: browser allowlist, UUIDv4 token, 1–65535 port.
pub fn parse_pairing_input(text: &str) -> Result<PairingPayload, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Paste a pairing code or pairing file first".into());
    }
    let json_text = if let Some(encoded) = trimmed.strip_prefix(PAIRING_CODE_PREFIX) {
        let raw = b64_decode(encoded.trim())?;
        String::from_utf8(raw).map_err(|_| "Pairing code is not valid UTF-8 JSON")?
    } else {
        trimmed.into()
    };
    let payload: PairingPayload =
        serde_json::from_str(&json_text).map_err(|_| "Pairing data is not valid JSON")?;
    validate_payload(&payload)?;
    Ok(payload)
}

pub fn validate_payload(payload: &PairingPayload) -> Result<(), String> {
    if !valid_browser(&payload.browser) {
        return Err("Choose firefox, mullvad, chrome or edge".into());
    }
    if !uuid::Uuid::parse_str(&payload.token).is_ok_and(|id| id.get_version_num() == 4) {
        return Err("Pairing token must be a UUIDv4".into());
    }
    if payload.port == 0 {
        return Err("Pairing port must be between 1 and 65535".into());
    }
    Ok(())
}

pub fn pairing_file_name(browser_id: &str) -> String {
    format!("browserdock-pairing-{browser_id}.json")
}

pub fn pairing_dir() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pairing"))
}

pub fn stable_companion_dir() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("companion"))
}

/// Browser-local extensions page opened by the backend launcher.
pub fn extension_page_url(browser_id: &str) -> Result<&'static str, String> {
    match browser_id {
        "chrome" => Ok("chrome://extensions"),
        "edge" => Ok("edge://extensions"),
        "firefox" | "mullvad" => Ok("about:debugging#/runtime/this-firefox"),
        _ => Err("Choose firefox, mullvad, chrome or edge".into()),
    }
}

/// Write one JSON pairing file per browser. Returns the file paths only —
/// callers must never log the file contents (they hold the bearer token).
///
/// Files are created with owner-only permissions on Unix (`0o600`); on
/// Windows the user's profile directory ACL applies. Delete the `pairing/`
/// folder after importing — the files are bearer credentials.
pub fn export_pairing_files(
    config: &Config,
    dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create pairing folder: {e}"))?;
    let mut written = Vec::with_capacity(BROWSERS.len());
    for browser_id in BROWSERS {
        let payload = pairing_payload(config, browser_id, None)?;
        let body = serde_json::to_string_pretty(&json!({
            "browser": payload.browser,
            "token": payload.token,
            "port": payload.port,
            "includePrivate": payload.include_private,
        }))
        .map_err(|_| "Cannot encode pairing file")?;
        let path = dir.join(pairing_file_name(browser_id));
        write_private_file(&path, format!("{body}\n"))?;
        written.push(path);
    }
    written.sort();
    Ok(written)
}

/// Owner-only file write for bearer-token material. Best-effort hardening:
/// the OS profile ACL remains the real boundary on Windows.
fn write_private_file(path: &Path, body: String) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Cannot write pairing file: {e}"))?;
    file.write_all(body.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("Cannot write pairing file: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let mut config = Config::default();
        config.settings.insert(
            "auth_token".into(),
            Value::String("7d8bab34-411a-48ee-ae6c-8b1b1b110951".into()),
        );
        config.settings.insert("ws_port".into(), json!(49222));
        config
    }

    #[test]
    fn code_roundtrips_per_browser() {
        let config = config();
        for browser in BROWSERS {
            let code = pairing_code(&config, browser, None).unwrap();
            assert!(code.starts_with(PAIRING_CODE_PREFIX));
            assert!(!code.contains('\n'));
            let parsed = parse_pairing_input(&code).unwrap();
            assert_eq!(parsed.browser, browser);
            assert_eq!(parsed.port, 49222);
            assert_eq!(
                parsed.include_private,
                browser == "mullvad",
                "mullvad defaults to private opt-in"
            );
        }
    }

    #[test]
    fn explicit_private_flag_wins() {
        let config = config();
        let parsed = parse_pairing_input(&pairing_code(&config, "chrome", Some(true)).unwrap()).unwrap();
        assert!(parsed.include_private);
    }

    #[test]
    fn rejects_unknown_browser_bad_token_and_bad_port() {
        let config = config();
        assert!(pairing_code(&config, "safari", None).is_err());
        assert!(parse_pairing_input("BD1.!!!").is_err());
        assert!(parse_pairing_input(r#"{"browser":"chrome","token":"bad","port":1}"#).is_err());
        assert!(parse_pairing_input(r#"{"browser":"chrome","token":"7d8bab34-411a-48ee-ae6c-8b1b1b110951","port":0}"#).is_err());
        let mut bad = config.clone();
        bad.settings.insert("auth_token".into(), Value::String("bad".into()));
        assert!(pairing_code(&bad, "chrome", None).is_err());
    }

    #[test]
    fn export_writes_four_files() {
        let config = config();
        let dir = tempfile::tempdir().unwrap();
        let files = export_pairing_files(&config, dir.path()).unwrap();
        assert_eq!(files.len(), 4);
        for path in &files {
            let payload: PairingPayload =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            validate_payload(&payload).unwrap();
        }
    }
}
