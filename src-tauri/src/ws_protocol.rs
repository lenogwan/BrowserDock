use crate::routing::parse_url;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use subtle::ConstantTimeEq;

pub const MAX_URL_BYTES: usize = 2048;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    #[default]
    DomainOrExact,
    Exact,
    NewTab,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Tab {
    pub id: i64,
    pub url: String,
    pub title: String,
    #[serde(default, rename = "cookieStoreId", skip_serializing_if = "Option::is_none")]
    pub cookie_store_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Response {
    pub id: String,
    pub status: String,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Tab count for `CLOSE_TABS` replies; absent for focus/open replies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<u32>,
}

impl Response {
    pub fn valid(&self) -> bool {
        self.id.len() <= 64
            && match self.status.as_str() {
                "SUCCESS" => {
                    (matches!(self.result.as_str(), "FOCUSED_EXISTING" | "OPENED_NEW_TAB")
                        && self.window_id.is_some_and(|id| id >= 0)
                        && self.tab_id.is_some_and(|id| id >= 0))
                        || (self.result == "CLOSED_TABS"
                            && self.closed.is_some_and(|n| n >= 1)
                            && self.window_id.is_none()
                            && self.tab_id.is_none())
                }
                "ERROR" => self.result.starts_with("ERROR_") && self.result.len() <= 64,
                _ => false,
            }
    }
}

#[derive(Deserialize)]
pub struct Auth {
    #[serde(rename = "type")]
    kind: String,
    token: String,
    pub browser: String,
    pub instance_id: String,
}

impl Auth {
    pub fn valid(&self, expected: &str) -> bool {
        // Token length is public (UUID); equal-length comparisons are constant time.
        let token_matches = bool::from(self.token.as_bytes().ct_eq(expected.as_bytes()));
        token_matches
            && self.kind == "AUTH"
            && matches!(
                self.browser.as_str(),
                "firefox" | "mullvad" | "chrome" | "edge"
            )
            && uuid::Uuid::parse_str(&self.instance_id).is_ok_and(|id| id.get_version_num() == 4)
    }
}

#[derive(Deserialize)]
pub struct TabSync {
    pub browser: String,
    pub tabs: Vec<Tab>,
}

impl TabSync {
    pub fn valid(&self, browser: &str) -> bool {
        let mut ids = HashSet::new();
        self.browser == browser
            && self.tabs.len() <= 200
            && self.tabs.iter().all(|tab| {
                tab.id >= 0
                    && ids.insert(tab.id)
                    && tab.url.len() <= MAX_URL_BYTES
                    && tab.title.chars().count() <= 256
                    && tab.cookie_store_id.as_ref().is_none_or(|v| crate::options::valid_name(v))
                    && parse_url(&tab.url).is_ok()
            })
    }
}

pub fn match_score(candidate: &str, target: &url::Url, mode: MatchMode) -> u8 {
    if matches!(mode, MatchMode::NewTab) {
        return 0;
    }
    let Ok(candidate) = parse_url(candidate) else {
        return 0;
    };
    if &candidate == target {
        2
    } else if matches!(mode, MatchMode::DomainOrExact) && candidate.host_str() == target.host_str()
    {
        1
    } else {
        0
    }
}
