//! Glob routing deliberately matches URL components separately: a wildcard
//! in a host must never consume a path, query string, or user information.
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoutingRule {
    pub id: String,
    pub pattern: String,
    pub target_browser: String,
    pub priority: i32,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub fn parse_url(input: &str) -> Result<Url, String> {
    if input.chars().any(char::is_control) {
        return Err("URL contains control characters".into());
    }
    let url = Url::parse(input.trim()).map_err(|_| "Enter an absolute HTTP or HTTPS URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) URLs without credentials are supported".into());
    }
    Ok(url)
}

// Greedy wildcard matching with backtracking to the most recent star.
// Constant auxiliary state; no regex compilation or exponential recursion.
fn glob(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let v: Vec<char> = value.chars().collect();
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == '?' || p[i] == v[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == '*' {
        i += 1;
    }
    i == p.len()
}

pub fn matches_pattern(pattern: &str, url: &Url) -> bool {
    let (scheme, rest) = pattern.split_once("://").unwrap_or(("*", pattern));
    let (host, suffix) = rest
        .split_once('/')
        .map_or((rest, None), |(h, p)| (h, Some(p)));
    if !glob(&scheme.to_ascii_lowercase(), url.scheme())
        || !glob(
            &host.to_ascii_lowercase(),
            &url.host_str().unwrap_or("").to_ascii_lowercase(),
        )
    {
        return false;
    }
    suffix.is_none_or(|pattern| {
        let tail = &url[url::Position::BeforePath..];
        glob(pattern, tail.strip_prefix('/').unwrap_or(tail))
    })
}

pub fn route<'a>(url: &Url, rules: &'a [RoutingRule]) -> &'a str {
    rules
        .iter()
        .filter(|rule| matches_pattern(&rule.pattern, url))
        .min_by(|a, b| a.priority.cmp(&b.priority).then(a.id.cmp(&b.id)))
        .map_or("firefox", |rule| rule.target_browser.as_str())
}
