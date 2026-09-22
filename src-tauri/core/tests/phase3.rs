use browserdock_launcher::{
    build_command,
    config::Config,
    detection::executable_from_command,
    prepare_launch,
    routing::{matches_pattern, parse_url, route},
};

#[test]
fn duplicate_public_ids_reject_load_and_save_without_changing_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config::default();
    config.bookmarks.push(config.bookmarks[0].clone());
    let bytes = serde_json::to_vec(&config).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert!(Config::load_or_create(&path).is_err());
    assert!(config.save(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn failed_spawn_returns_an_error() {
    assert!(browserdock_launcher::launch_browser(
        "/nonexistent/browserdock-test.exe",
        "https://example.org",
        &[]
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn real_spawn_delivers_url_as_one_final_argument() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("browser fixture");
    let output = dir.path().join("received");
    std::fs::write(
        &executable,
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" > \"$output\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    browserdock_launcher::launch_browser(
        executable.to_str().unwrap(),
        "https://example.org/?a=1&b=two",
        &[output.to_str().unwrap().into(), "-new-tab".into()],
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if std::fs::read_to_string(&output).ok().as_deref()
            == Some("-new-tab\nhttps://example.org/?a=1&b=two\n")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "browser did not receive expected arguments"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn url_batches_split_only_past_the_argv_bound() {
    let small: Vec<String> = (0..3).map(|i| format!("https://example.org/{i}")).collect();
    assert_eq!(
        browserdock_launcher::chunk_urls_for_launch("C:\\Edge\\msedge.exe", &[], &small),
        vec![small.clone()]
    );
    let big: Vec<String> = (0..3)
        .map(|i| format!("https://example.org/{i}?q={}", "x".repeat(15_000)))
        .collect();
    let chunks = browserdock_launcher::chunk_urls_for_launch("C:\\Edge\\msedge.exe", &[], &big);
    assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [1, 1, 1]);
    assert_eq!(chunks.concat(), big);
    assert!(browserdock_launcher::chunk_urls_for_launch("C:\\Edge\\msedge.exe", &[], &[]).is_empty());
}

#[cfg(unix)]
#[test]
fn multi_url_spawn_delivers_every_url_as_trailing_arguments() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("browser fixture");
    let output = dir.path().join("received");
    std::fs::write(
        &executable,
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" > \"$output\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    browserdock_launcher::launch_browser_urls(
        executable.to_str().unwrap(),
        &[
            "https://one.test/".into(),
            "https://two.test/".into(),
            "https://three.test/".into(),
        ],
        &[output.to_str().unwrap().into()],
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if std::fs::read_to_string(&output).ok().as_deref()
            == Some("https://one.test/\nhttps://two.test/\nhttps://three.test/\n")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "browser did not receive every URL as trailing arguments"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(browserdock_launcher::launch_browser_urls(
        executable.to_str().unwrap(),
        &[],
        &[]
    )
    .is_err());
    assert!(browserdock_launcher::launch_browser_urls(
        executable.to_str().unwrap(),
        &["not a url".into()],
        &[]
    )
    .is_err());
}

#[test]
fn invalid_config_save_preserves_previous_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config::load_or_create(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    config.browsers.push(config.browsers[0].clone());
    assert!(config.save(&path).is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn routes_by_priority_then_id_and_defaults_to_firefox() {
    let mut config = Config {
        routing_rules: serde_json::from_value(serde_json::json!([
            {"id":"z", "pattern":"*.google.com", "target_browser":"edge", "priority":10},
            {"id":"a", "pattern":"*://*.google.com/*", "target_browser":"chrome", "priority":10},
            {"id":"early", "pattern":"docs.google.com", "target_browser":"mullvad", "priority":20}
        ]))
        .unwrap(),
        ..Config::default()
    };
    assert_eq!(
        route(
            &parse_url("https://DOCS.GOOGLE.COM").unwrap(),
            &config.routing_rules
        ),
        "chrome"
    );
    assert_eq!(
        route(
            &parse_url("https://example.org").unwrap(),
            &config.routing_rules
        ),
        "firefox"
    );
    config.routing_rules[2].priority = 1;
    assert_eq!(
        route(
            &parse_url("https://docs.google.com").unwrap(),
            &config.routing_rules
        ),
        "mullvad"
    );
}

#[test]
fn default_edge_rule_covers_bare_host_and_subdomains() {
    let config = Config::default();
    assert_eq!(
        route(
            &parse_url("https://forbidden-site.org/path").unwrap(),
            &config.routing_rules
        ),
        "edge"
    );
    assert_eq!(
        route(
            &parse_url("https://sub.forbidden-site.org/path").unwrap(),
            &config.routing_rules
        ),
        "edge"
    );
}

#[test]
fn glob_matching_keeps_host_scheme_and_path_separate() {
    for (pattern, input, expected) in [
        ("*.GOOGLE.com", "https://docs.google.com/Case", true),
        ("*.google.com", "https://google.com/", false),
        (
            "*.google.com",
            "https://evil.org/?next=docs.google.com",
            false,
        ),
        ("*.google.com", "https://docs.google.com.evil.org/", false),
        (
            "*://docs.google.com/C?se*",
            "http://docs.google.com/Case?q=x",
            true,
        ),
        (
            "*://docs.google.com/case*",
            "https://docs.google.com/Case",
            false,
        ),
        (
            "https://docs.google.com/*",
            "http://docs.google.com/",
            false,
        ),
        ("docs.google.com", "https://docs.google.com:8443/path", true),
        ("*://*.onion/*", "http://hidden.onion", true),
    ] {
        assert_eq!(
            matches_pattern(pattern, &parse_url(input).unwrap()),
            expected,
            "{pattern}: {input}"
        );
    }
}

#[test]
fn rejects_non_web_and_ambiguous_input() {
    for input in [
        "",
        "--help",
        "file:///tmp/test",
        "javascript:alert(1)",
        "https://",
        "https://user:pass@example.org",
        "https://example.org\n--flag",
    ] {
        assert!(parse_url(input).is_err(), "{input}");
    }
}

#[test]
fn launch_preserves_argument_boundaries_and_url_last() {
    let cmd = build_command(
        "C:/Program Files/Firefox/firefox.exe",
        "https://example.org/?a=1&b=2",
        &["-new-tab".into(), "profile with spaces".into()],
    )
    .unwrap();
    let args: Vec<_> = cmd.get_args().map(|s| s.to_str().unwrap()).collect();
    assert_eq!(
        args,
        [
            "-new-tab",
            "profile with spaces",
            "https://example.org/?a=1&b=2"
        ]
    );
    assert!(build_command("browser.exe", "--profile", &[]).is_err());
}

#[test]
fn explicit_target_wins_and_missing_browser_does_not_change_identity() {
    let fixture = tempfile::NamedTempFile::new().unwrap();
    let mut config = Config::default();
    config
        .browsers
        .iter_mut()
        .find(|b| b.id == "edge")
        .unwrap()
        .exe_path = fixture.path().to_str().unwrap().into();
    let launch = prepare_launch(&config, "https://docs.google.com", Some("edge")).unwrap();
    assert_eq!(launch.browser_id, "edge");
    assert!(prepare_launch(&config, "https://example.org", Some("unknown")).is_err());
    config
        .browsers
        .iter_mut()
        .find(|b| b.id == "edge")
        .unwrap()
        .exe_path = "/nonexistent/browserdock-test.exe".into();
    assert!(prepare_launch(&config, "https://example.org", Some("edge")).is_err());
}

#[test]
fn registry_commands_extract_only_the_executable() {
    assert_eq!(
        executable_from_command(
            r#""C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1""#
        ),
        Some(r"C:\Program Files\Mozilla Firefox\firefox.exe".into())
    );
    assert_eq!(
        executable_from_command(r"C:\Program Files\Chrome\chrome.exe --single-argument %1"),
        Some(r"C:\Program Files\Chrome\chrome.exe".into())
    );
    assert_eq!(executable_from_command("cmd.exe /c chrome.exe"), None);
    assert_eq!(executable_from_command(r#""C:\broken.exe"#), None);
}

#[test]
fn config_roundtrip_preserves_token_customizations_and_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let mut config = Config::load_or_create(&path).unwrap();
    let token = config.settings["auth_token"].clone();
    assert!(uuid::Uuid::parse_str(token.as_str().unwrap()).is_ok());
    config
        .extra
        .insert("future_field".into(), serde_json::json!({"keep":true}));
    config.browsers[0].exe_path = "D:/Custom/firefox.exe".into();
    config.save(&path).unwrap();
    let loaded = Config::load_or_create(&path).unwrap();
    assert_eq!(loaded.settings["auth_token"], token);
    assert_eq!(loaded.browsers[0].exe_path, "D:/Custom/firefox.exe");
    assert_eq!(loaded.extra["future_field"]["keep"], true);
    std::fs::write(&path, b"{broken").unwrap();
    assert!(Config::load_or_create(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
}
