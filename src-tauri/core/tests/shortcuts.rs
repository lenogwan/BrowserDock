use browserdock_launcher::{
    config::Config,
    settings::{canonical_shortcut, default_dock_shortcuts, Settings},
};

#[test]
fn shortcuts_default_for_old_config_and_roundtrip_partial_customization() {
    let mut config = Config::default();
    let mut settings = Settings::from_config(&config);
    assert_eq!(settings.dock_shortcuts, default_dock_shortcuts());
    assert!(settings.validate().is_ok());
    config.settings.insert(
        "dock_shortcuts".into(),
        serde_json::json!({"new_tab":"alt+ctrl+keyn"}),
    );
    settings = Settings::from_config(&config);
    assert_eq!(settings.dock_shortcuts["new_tab"], "Ctrl+Alt+N");
    assert_eq!(settings.dock_shortcuts["hide"], "Escape");
    assert!(settings.validate().is_ok());
    assert_eq!(
        serde_json::from_value::<Settings>(serde_json::to_value(&settings).unwrap())
            .unwrap()
            .dock_shortcuts,
        settings.dock_shortcuts
    );
    let mut legacy = serde_json::to_value(settings).unwrap();
    legacy.as_object_mut().unwrap().remove("dock_shortcuts");
    assert_eq!(
        serde_json::from_value::<Settings>(legacy)
            .unwrap()
            .dock_shortcuts,
        default_dock_shortcuts()
    );
}

#[test]
fn settings_reject_shortcut_conflicts_reserved_keys_and_unknown_actions() {
    for bad in [
        "Tab",
        "Ctrl+A",
        "Ctrl+C",
        "Ctrl+V",
        "Ctrl+X",
        "Ctrl+Z",
        "Ctrl+ArrowLeft",
        "Ctrl+Shift+ArrowLeft",
        "Ctrl+Backspace",
        "Shift+Delete",
        "Shift+A",
        "Space",
        "Ctrl+Escape",
        "",
        "Ctrl+Ctrl+K",
        "Enter",
        "Ctrl+Alt+L",
        "Alt+1",
    ] {
        let mut settings = Settings::from_config(&Config::default());
        settings.dock_shortcuts.insert("new_tab".into(), bad.into());
        assert!(settings.validate().is_err(), "{bad}");
    }
    let mut settings = Settings::from_config(&Config::default());
    settings
        .dock_shortcuts
        .insert("unknown".into(), "Ctrl+K".into());
    assert!(settings.validate().is_err());
    settings.dock_shortcuts = default_dock_shortcuts();
    settings.global_shortcut = "Ctrl+Alt+L".into();
    assert!(settings.validate().is_err());
    settings.global_shortcut = "Control+Shift+Space".into();
    assert!(settings.validate().is_ok());
    settings
        .dock_shortcuts
        .insert("hide".into(), "Ctrl+H".into());
    assert!(settings.validate().is_ok());
}

#[test]
fn malformed_saved_shortcuts_fall_back_and_keys_are_canonical() {
    let mut config = Config::default();
    for raw in [
        serde_json::json!(null),
        serde_json::json!({"new_tab":"N"}),
        serde_json::json!({"new_tab":"Enter"}),
        serde_json::json!({"new_tab":42}),
    ] {
        config.settings.insert("dock_shortcuts".into(), raw);
        assert_eq!(
            Settings::from_config(&config).dock_shortcuts,
            default_dock_shortcuts()
        );
    }
    assert_eq!(
        canonical_shortcut("shift+control+KeyN").as_deref(),
        Some("Ctrl+Shift+N")
    );
    assert_eq!(
        canonical_shortcut("Meta+Digit2").as_deref(),
        Some("Super+2")
    );
    assert_eq!(canonical_shortcut("Ctrl+F01"), None);
    config
        .settings
        .insert("global_shortcut".into(), serde_json::json!("Escape"));
    config
        .settings
        .insert("panic_shortcut".into(), serde_json::json!("Tab"));
    let safe = Settings::from_config(&config);
    assert_eq!(safe.global_shortcut, "Ctrl+Shift+Space");
    assert_eq!(safe.panic_shortcut, "Ctrl+Alt+L");
}
