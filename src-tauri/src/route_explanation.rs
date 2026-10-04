use crate::{config::Config, groups, options, routing, vault::Bookmark, RouteDetails};
use serde::Serialize;
use zeroize::Zeroize;
#[derive(Serialize)]
pub struct Explanation {
    pub details: RouteDetails,
    pub steps: Vec<String>,
}
impl Drop for Explanation {
    fn drop(&mut self) {
        self.steps.zeroize();
        self.details.browser_id.zeroize();
        self.details.profile.zeroize();
        self.details.container.zeroize();
    }
}
pub fn explain(
    config: &Config,
    url: &str,
    override_id: Option<&str>,
    bookmark: Option<&Bookmark>,
    scope: &[Bookmark],
) -> Result<Explanation, String> {
    let input = bookmark.map_or(url, |b| b.url.as_str());
    let chosen = override_id.or_else(|| bookmark.map(|b| b.target_browser.as_str()));
    let overrides = bookmark.and_then(|b| b.browser_options.as_ref());
    let details = crate::route_details(config, input, chosen, overrides)?;
    let parsed = routing::parse_url(input)?;
    let rule = if chosen.is_none() {
        config
            .routing_rules
            .iter()
            .filter(|r| routing::matches_pattern(&r.pattern, &parsed))
            .min_by(|a, b| a.priority.cmp(&b.priority).then(a.id.cmp(&b.id)))
    } else {
        None
    };
    let mut steps = vec![];
    if override_id.is_some() {
        steps.push(format!(
            "Your current browser override selects {}.",
            details.browser_id
        ));
    } else if let Some(bookmark) = bookmark {
        steps.push(format!(
            "This bookmark is saved to open with {}.",
            bookmark.target_browser
        ));
        if bookmark.parent_id.is_some() {
            let root = groups::effective_routing(bookmark, scope);
            let own = bookmark.browser_options.as_ref();
            let inherited = root.browser_options.as_ref();
            let follows = bookmark.target_browser == root.target_browser
                && own.and_then(|o| o.profile.as_ref())
                    == inherited.and_then(|o| o.profile.as_ref())
                && own.and_then(|o| o.container.as_ref())
                    == inherited.and_then(|o| o.container.as_ref());
            steps.push(if follows { "Its browser, profile and container follow the top-level parent bookmark." } else { "It retains custom settings for a single open. Opening its subtree or group uses the top-level parent's browser, profile and container." }.into());
        }
        if bookmark.group_id.is_some() {
            steps.push(
                "The group organizes bookmarks; each top-level bookmark determines its browser."
                    .into(),
            );
        }
    } else if let Some(rule) = rule {
        steps.push(format!(
            "Routing rule {} matches {} (priority {}).",
            rule.id, rule.pattern, rule.priority
        ));
    } else {
        steps.push("No routing rule matches; Firefox is the default browser.".into());
    }
    let browser = config
        .browsers
        .iter()
        .find(|b| b.id == details.browser_id)
        .ok_or("Browser is not configured")?;
    options::defaults(browser)?;
    let rule_options = rule.map(options::rule_options).transpose()?.flatten();
    for (label, value) in [
        ("Profile", &details.profile),
        ("Container", &details.container),
    ] {
        if let Some(value) = value {
            let source = if overrides.is_some_and(|o| {
                if label == "Profile" {
                    o.profile.as_ref()
                } else {
                    o.container.as_ref()
                }
                .is_some_and(|v| !v.is_empty())
            }) {
                "bookmark"
            } else if rule_options.as_ref().is_some_and(|o| {
                if label == "Profile" {
                    o.profile.as_ref()
                } else {
                    o.container.as_ref()
                }
                .is_some_and(|v| !v.is_empty())
            }) {
                "routing rule"
            } else {
                "browser defaults"
            };
            steps.push(format!("{label}: {value}, from {source}."));
        }
    }
    if details.incognito {
        steps.push("Opens a new private window and bypasses existing-tab reuse.".into());
    } else if details.profile.is_some() {
        steps.push("A profile hint applies to process launches; a connected companion does not identify its browser profile.".into());
    }
    Ok(Explanation { details, steps })
}
