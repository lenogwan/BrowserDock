use browserdock_launcher::{config::Config, settings::Settings, window_size::{WindowSize, SizeState}};
use serde_json::json;

#[test]
fn legacy_and_malformed_window_sizes_are_tolerant() {
    let mut c = Config::default();
    c.settings.remove("window_size");
    assert_eq!(Settings::from_config(&c).window_size, WindowSize::default());
    for value in [json!(false), json!({"width":"bad","height":-7}), json!({"width":9999,"height":"bad"})] {
        c.settings.insert("window_size".into(), value);
        assert!(c.validate().is_ok());
        let (size, warning) = WindowSize::from_value(c.settings.get("window_size"));
        assert!(warning);
        assert!((280.0..=800.0).contains(&size.width));
        assert!(size.height.is_none_or(|h| h >= 56.0));
    }
}

#[test]
fn clamping_rejects_invalid_sizes_and_never_exceeds_work_area() {
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(WindowSize { width:bad, height:None }.clamped(1200.0,900.0).is_err());
        assert!(WindowSize { width:400.0, height:Some(bad) }.clamped(1200.0,900.0).is_err());
    }
    assert_eq!(WindowSize {width:100.0,height:Some(20.0)}.clamped(1200.0,900.0).unwrap(), WindowSize {width:280.0,height:Some(56.0)});
    assert_eq!(WindowSize {width:1000.0,height:Some(1500.0)}.clamped(700.0,600.0).unwrap(), WindowSize {width:700.0,height:Some(600.0)});
    assert_eq!(WindowSize {width:400.0,height:Some(200.0)}.clamped(200.0,40.0).unwrap(), WindowSize {width:200.0,height:Some(40.0)});
}

#[test]
fn manual_height_survives_views_and_strip_then_reset_refits() {
    let mut state = SizeState::new(WindowSize::default());
    assert_eq!(state.auto_fit(440.0, 900.0).unwrap(), 440.0);
    state.requested = WindowSize {width:650.0,height:Some(300.0)};
    assert_eq!(state.auto_fit(560.0, 900.0).unwrap(), 300.0);
    assert_eq!(state.auto_fit(6.0, 900.0).unwrap(), 6.0);
    assert_eq!(state.auto_fit(440.0, 900.0).unwrap(), 300.0);
    state.requested.height = None;
    assert_eq!(state.display_height(900.0), 440.0);
    assert_eq!(state.requested.width,650.0);
}

#[test]
fn collapse_overrides_manual_height_without_losing_expanded_size() {
    let requested = WindowSize { width:650.0, height:Some(700.0) };
    let mut state = SizeState::new(requested);
    // Startup is a pill even when a manual expanded height was saved.
    assert_eq!(state.display_height(900.0), 56.0);
    for _ in 0..3 {
        assert_eq!(state.auto_fit(440.0, 900.0).unwrap(), 700.0);
        assert_eq!(state.auto_fit(560.0, 900.0).unwrap(), 700.0);
        assert_eq!(state.auto_fit(56.0, 900.0).unwrap(), 56.0);
        assert_eq!(state.display_height(40.0), 40.0);
        assert_eq!(state.auto_fit(6.0, 900.0).unwrap(), 6.0);
        assert_eq!(state.auto_fit(56.0, 900.0).unwrap(), 56.0);
        assert_eq!(state.requested, requested);
    }
    // A width-only preview and commit while collapsed must keep the manual height.
    state.requested.width = 600.0;
    assert_eq!(state.display_height(900.0), 56.0);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    state.commit(&Config::default(), &path, json!({"x":100,"y":200})).unwrap();
    let saved = Settings::from_config(&Config::load_or_create(&path).unwrap()).window_size;
    assert_eq!(saved, WindowSize {width:600.0,height:Some(700.0)});
    assert_eq!(state.auto_fit(440.0, 900.0).unwrap(), 700.0);
    state.requested.height = None;
    assert_eq!(state.display_height(900.0), 440.0);
    assert_eq!(state.auto_fit(56.0, 900.0).unwrap(), 56.0);
}

#[test]
fn gesture_previews_do_not_write_and_commit_saves_size_and_position_together() {
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("config.json");
    let c=Config::default();c.save(&path).unwrap();let before=std::fs::read(&path).unwrap();
    let mut state=SizeState::new(WindowSize::default());
    for width in 400..500 { state.requested=WindowSize {width:width as f64,height:Some(350.0)}; }
    assert_eq!(std::fs::read(&path).unwrap(),before);
    let next=state.commit(&c,&path,json!({"x":100,"y":200,"snapped":true,"edge":"right"})).unwrap();
    let loaded=Config::load_or_create(&path).unwrap();
    assert_eq!(loaded.settings["window_size"]["width"],499.0);
    assert_eq!(loaded.settings["window_size"]["height"],350.0);
    assert_eq!(loaded.settings["dock_position"],next.settings["dock_position"]);
}
