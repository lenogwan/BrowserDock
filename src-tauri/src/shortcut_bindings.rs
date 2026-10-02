//! Tracks actual native registrations, including rollback after OS conflicts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortcutKind {
    Summon,
    Panic,
}
impl ShortcutKind {
    fn index(self) -> usize {
        if self == Self::Summon {
            0
        } else {
            1
        }
    }
    fn label(self) -> &'static str {
        if self == Self::Summon {
            "Summon"
        } else {
            "Panic lock"
        }
    }
}
pub trait ShortcutRegistry {
    fn register(&mut self, kind: ShortcutKind, binding: &str) -> Result<(), String>;
    fn unregister(&mut self, binding: &str) -> Result<(), String>;
}
#[derive(Default, Debug)]
pub struct ShortcutBindings {
    pub active: [Option<String>; 2],
}
impl ShortcutBindings {
    fn restore(&mut self, previous: &[Option<String>; 2], registry: &mut impl ShortcutRegistry) {
        for kind in [ShortcutKind::Summon, ShortcutKind::Panic] {
            let i = kind.index();
            if let Some(binding) = &previous[i] {
                if self.active[i].is_none() && registry.register(kind, binding).is_ok() {
                    self.active[i] = Some(binding.clone());
                }
            }
        }
    }
    pub fn apply(&mut self, desired: [&str; 2], registry: &mut impl ShortcutRegistry) -> String {
        if self
            .active
            .iter()
            .zip(desired)
            .all(|(active, desired)| active.as_deref() == Some(desired))
        {
            return String::new();
        }
        let previous = self.active.clone();
        // Release the bindings we actually own, which may differ from config
        // after an earlier failed activation. Escape is never included here.
        for i in 0..2 {
            if let Some(binding) = &self.active[i] {
                if registry.unregister(binding).is_err() {
                    self.restore(&previous, registry);
                    return self.notice("Previous Windows shortcuts could not be released. Restart BrowserDock to retry.");
                }
                self.active[i] = None;
            }
        }
        let mut failures = Vec::new();
        for kind in [ShortcutKind::Summon, ShortcutKind::Panic] {
            let i = kind.index();
            if registry.register(kind, desired[i]).is_ok() {
                self.active[i] = Some(desired[i].into());
            } else {
                failures.push(kind.label());
            }
        }
        if failures.is_empty() {
            return String::new();
        }
        if previous.iter().any(Option::is_some) {
            for i in 0..2 {
                if let Some(binding) = &self.active[i] {
                    if registry.unregister(binding).is_ok() {
                        self.active[i] = None;
                    }
                }
            }
            self.restore(&previous, registry);
        }
        self.notice(&format!("{} shortcut could not be activated; another app may hold it. Restart BrowserDock to retry the saved keys.", failures.join(" and ")))
    }
    fn notice(&self, problem: &str) -> String {
        format!(
            "{problem} Active summon: {}; active panic lock: {}. Tray controls remain available.",
            self.active[0].as_deref().unwrap_or("unavailable"),
            self.active[1].as_deref().unwrap_or("unavailable")
        )
    }
}
