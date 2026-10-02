use browserdock_launcher::shortcut_bindings::{ShortcutBindings, ShortcutKind, ShortcutRegistry};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Registry {
    owned: HashMap<String, ShortcutKind>,
    unavailable: HashSet<String>,
    cannot_release: HashSet<String>,
}
impl ShortcutRegistry for Registry {
    fn register(&mut self, kind: ShortcutKind, binding: &str) -> Result<(), String> {
        if self.unavailable.contains(binding) || self.owned.contains_key(binding) {
            return Err("in use".into());
        }
        self.owned.insert(binding.into(), kind);
        Ok(())
    }
    fn unregister(&mut self, binding: &str) -> Result<(), String> {
        if self.cannot_release.contains(binding) {
            return Err("cannot release".into());
        }
        self.owned.remove(binding);
        Ok(())
    }
}
#[test]
fn swapped_global_keys_replace_their_callbacks_and_leave_escape_alone() {
    let mut registry = Registry::default();
    let mut bindings = ShortcutBindings::default();
    registry.owned.insert("Escape".into(), ShortcutKind::Panic);
    assert!(bindings
        .apply(["Ctrl+Shift+Space", "Ctrl+Alt+L"], &mut registry)
        .is_empty());
    assert!(bindings
        .apply(["Ctrl+Alt+L", "Ctrl+Shift+Space"], &mut registry)
        .is_empty());
    assert_eq!(registry.owned["Ctrl+Alt+L"], ShortcutKind::Summon);
    assert_eq!(registry.owned["Ctrl+Shift+Space"], ShortcutKind::Panic);
    assert_eq!(registry.owned["Escape"], ShortcutKind::Panic);
    assert_eq!(registry.owned.len(), 3);
}
#[test]
fn failed_activation_rolls_back_both_and_next_save_releases_actual_old_keys() {
    let mut registry = Registry::default();
    let mut bindings = ShortcutBindings::default();
    bindings.apply(["Ctrl+Shift+Space", "Ctrl+Alt+L"], &mut registry);
    registry.unavailable.insert("Ctrl+Alt+P".into());
    let notice = bindings.apply(["Ctrl+Alt+S", "Ctrl+Alt+P"], &mut registry);
    assert!(notice.contains("Panic lock"));
    assert!(notice.contains("Active summon: Ctrl+Shift+Space"));
    assert!(!registry.owned.contains_key("Ctrl+Alt+S"));
    assert_eq!(registry.owned.len(), 2);
    assert!(bindings
        .apply(["Ctrl+Alt+F8", "Ctrl+Alt+F9"], &mut registry)
        .is_empty());
    assert_eq!(registry.owned.len(), 2);
    assert!(!registry.owned.contains_key("Ctrl+Shift+Space"));
    assert!(!registry.owned.contains_key("Ctrl+Alt+L"));
    assert_eq!(registry.owned["Ctrl+Alt+F8"], ShortcutKind::Summon);
}
#[test]
fn startup_conflicts_keep_working_binding_and_can_be_retried_without_restart() {
    let mut registry = Registry::default();
    let mut bindings = ShortcutBindings::default();
    registry.unavailable.insert("Ctrl+Alt+L".into());
    assert!(!bindings
        .apply(["Ctrl+Shift+Space", "Ctrl+Alt+L"], &mut registry)
        .is_empty());
    assert_eq!(bindings.active, [Some("Ctrl+Shift+Space".into()), None]);
    registry.unavailable.clear();
    assert!(bindings
        .apply(["Ctrl+Shift+Space", "Ctrl+Alt+L"], &mut registry)
        .is_empty());
    assert_eq!(registry.owned.len(), 2);
}
#[test]
fn release_failure_restores_earlier_release_and_does_not_create_extra_bindings() {
    let mut registry = Registry::default();
    let mut bindings = ShortcutBindings::default();
    bindings.apply(["Ctrl+Shift+Space", "Ctrl+Alt+L"], &mut registry);
    registry.cannot_release.insert("Ctrl+Alt+L".into());
    assert!(bindings
        .apply(["Ctrl+Alt+F8", "Ctrl+Alt+F9"], &mut registry)
        .contains("could not be released"));
    assert_eq!(registry.owned.len(), 2);
    assert_eq!(
        bindings.active,
        [Some("Ctrl+Shift+Space".into()), Some("Ctrl+Alt+L".into())]
    );
}
