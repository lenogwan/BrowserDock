use browserdock_launcher::{config::Config, options::BrowserOptions, route_details, prepare_launch_with_options};
use serde_json::json;
#[test]
fn resolution_validates_and_overrides_defaults() {
 let mut c=Config::default();
 let b=c.browsers.iter_mut().find(|b|b.id=="chrome").unwrap();
 b.extra.insert("profile".into(),json!("Default"));
 let o:BrowserOptions=serde_json::from_value(json!({"profile":"Ray","container":"work"})).unwrap();
 let d=route_details(&c,"https://example.com",Some("chrome"),Some(&o)).unwrap();
 assert_eq!(d.profile.as_deref(),Some("Ray")); assert!(d.container.is_none());
 let bad:BrowserOptions=serde_json::from_value(json!({"profile":"../secret"})).unwrap(); assert!(bad.validate().is_err());
}
#[test]
fn profile_and_private_flags_precede_url_and_extra_args_are_validated() {
 let mut c=Config::default(); let executable=std::env::current_exe().unwrap();
 let b=c.browsers.iter_mut().find(|b|b.id=="chrome").unwrap(); b.exe_path=executable.to_str().unwrap().into();
 b.extra.insert("profile".into(),json!("Profile 1")); b.extra.insert("extra_args".into(),json!(["--disable-features=Foo"]));
 let o:BrowserOptions=serde_json::from_value(json!({"incognito":true})).unwrap();
 let p=prepare_launch_with_options(&c,"https://example.com",Some("chrome"),Some(&o)).unwrap();
 let command=browserdock_launcher::build_command(&p.exe_path,&p.url,&p.args).unwrap();
 let args:Vec<_>=command.get_args().map(|s|s.to_str().unwrap()).collect();
 assert!(args.contains(&"--profile-directory=Profile 1")); assert!(args.contains(&"--incognito")); assert_eq!(args.last(),Some(&"https://example.com/"));
 c.browsers.iter_mut().find(|b|b.id=="chrome").unwrap().extra.insert("extra_args".into(),json!(["--foo;touch"])); assert!(browserdock_launcher::options::validate_browser(c.browsers.iter().find(|b|b.id=="chrome").unwrap()).is_err());
}
