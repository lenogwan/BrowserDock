use browserdock_launcher::{config::Config, settings::Settings};

#[test]
fn old_settings_preserve_hide_default_and_opaque_surface() {
    let mut config = Config::default();
    config.settings.remove("hide_on_open");
    config.settings.remove("opacity");
    let settings = Settings::from_config(&config);
    assert!(settings.hide_on_open);
    assert_eq!(settings.opacity, 1.0);
}

#[test]
fn hand_edited_opacity_clamps_but_save_rejects_invalid_values() {
    for (input, expected) in [(0.1, 0.3), (1.5, 1.0), (0.65, 0.65)] {
        let mut config = Config::default();
        config
            .settings
            .insert("opacity".into(), serde_json::json!(input));
        let mut settings = Settings::from_config(&config);
        assert_eq!(settings.opacity, expected);
        settings.opacity = input;
        assert_eq!(settings.validate().is_ok(), (0.3..=1.0).contains(&input));
    }
    let mut settings = Settings::from_config(&Config::default());
    settings.opacity = f64::NAN;
    assert_eq!(settings.validate().unwrap_err(), "Opacity must be 30–100%");
}

#[test]
fn hide_and_topmost_are_independent_and_settings_roundtrip() {
    let mut config = Config::default();
    config.settings.insert("hide_on_open".into(), false.into());
    config.settings.insert("always_on_top".into(), true.into());
    config.settings.insert("opacity".into(), 0.55.into());
    let settings = Settings::from_config(&config);
    assert!(!settings.hide_on_open);
    assert!(settings.always_on_top);
    let serialized = serde_json::to_value(settings).unwrap();
    assert_eq!(serialized["hide_on_open"], false);
    assert_eq!(serialized["opacity"], 0.55);
}

#[test]
fn themes_load_tolerantly_validate_strictly_and_roundtrip() {
    let mut config = Config::default();
    assert_eq!(Settings::from_config(&config).theme, "sage");
    for raw in [
        serde_json::Value::Null,
        serde_json::json!("dark"),
        serde_json::json!("neon"),
        serde_json::json!(42),
    ] {
        config.settings.insert("theme".into(), raw);
        assert_eq!(Settings::from_config(&config).theme, "sage");
    }
    for theme in ["sage", "nord", "amber", "tokyo", "rose"] {
        config.settings.insert("theme".into(), theme.into());
        let settings = Settings::from_config(&config);
        assert!(settings.validate().is_ok());
        assert_eq!(serde_json::to_value(&settings).unwrap()["theme"], theme);
    }
    let mut settings = Settings::from_config(&config);
    settings.theme = "neon".into();
    assert!(settings.validate().is_err());
    let mut legacy = serde_json::to_value(Settings::from_config(&Config::default())).unwrap();
    legacy.as_object_mut().unwrap().remove("theme");
    assert_eq!(
        serde_json::from_value::<Settings>(legacy).unwrap().theme,
        "sage"
    );
}
