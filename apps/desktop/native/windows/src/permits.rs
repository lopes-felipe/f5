use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Foreground,
    App(String),
    Takeover(String),
}
impl Scope {
    pub fn decode(value: &Value) -> Option<Self> {
        if value.is_null() {
            return Some(Self::Foreground);
        }
        let app = value["appId"].as_str().filter(|id| !id.is_empty());
        match value["kind"].as_str()? {
            "foreground" => Some(Self::Foreground),
            "app" => Some(Self::App(app?.to_owned())),
            "takeover" => Some(Self::Takeover(app?.to_owned())),
            _ => None,
        }
    }
    pub fn app(&self) -> Option<&str> {
        match self {
            Self::Foreground => None,
            Self::App(id) | Self::Takeover(id) => Some(id),
        }
    }
    pub fn background(&self) -> bool {
        matches!(self, Self::App(_))
    }
    pub fn conflicts(&self, other: &Self) -> bool {
        matches!(self, Self::Foreground)
            || matches!(other, Self::Foreground)
            || matches!((self, other), (Self::Takeover(_), Self::Takeover(_)))
            || self.app() == other.app()
    }
    pub fn allows(&self, delivery: &str, op: &str, app: &str, action: &str) -> bool {
        if delivery == "background" {
            return matches!(self, Self::App(id) if id == app)
                && match op {
                    "status" | "listApps" | "resolveApps" | "inspect" | "screenshot" | "zoom"
                    | "type" | "openApp" => true,
                    "elementAction" => matches!(action, "press" | "setValue"),
                    _ => false,
                };
        }
        match self {
            Self::Foreground => true,
            Self::App(_) => false,
            Self::Takeover(id) => app.is_empty() || id == app,
        }
    }
}
struct Entry {
    deadline: Instant,
    suspended: bool,
    scope: Scope,
    cancelled: HashSet<String>,
}
/// Expiry latches and scopes are immutable. A floor bounds retirement tombstones
/// without allowing delayed messages to recreate old generations.
pub struct Permits {
    entries: HashMap<u64, Entry>,
    retired: VecDeque<u64>,
    retired_set: HashSet<u64>,
    floor: u64,
    expired: VecDeque<u64>,
}
impl Permits {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            retired: VecDeque::new(),
            retired_set: HashSet::new(),
            floor: 0,
            expired: VecDeque::new(),
        }
    }
    pub fn renew(&mut self, generation: u64, duration: Duration, scope: Option<Scope>) {
        self.expire();
        if generation == 0 || self.retired_set.contains(&generation) {
            return;
        }
        if let Some(entry) = self.entries.get_mut(&generation) {
            if scope.as_ref().is_some_and(|scope| *scope != entry.scope) {
                entry.suspended = true;
                return;
            }
            entry.deadline = Instant::now() + duration.min(Duration::from_secs(1));
        } else if generation > self.floor && self.entries.len() < 128 {
            if let Some(scope) = scope {
                self.entries.insert(
                    generation,
                    Entry {
                        deadline: Instant::now() + duration.min(Duration::from_secs(1)),
                        suspended: true,
                        scope,
                        cancelled: HashSet::new(),
                    },
                );
            }
        }
    }
    pub fn resume(&mut self, generation: u64, scope: Option<&Scope>) {
        self.expire();
        let Some(entry) = self.entries.get(&generation) else {
            return;
        };
        if Instant::now() >= entry.deadline
            || scope.is_some_and(|scope| *scope != entry.scope)
            || self.entries.iter().any(|(id, other)| {
                *id != generation && !other.suspended && other.scope.conflicts(&entry.scope)
            })
        {
            return;
        }
        self.entries.get_mut(&generation).unwrap().suspended = false;
    }
    pub fn suspend(&mut self, generation: Option<u64>) {
        for (id, entry) in &mut self.entries {
            if generation.is_none_or(|generation| generation == *id) {
                entry.suspended = true;
            }
        }
    }
    pub fn retire(&mut self, generation: u64) {
        self.entries.remove(&generation);
        if generation > self.floor && self.retired_set.insert(generation) {
            self.retired.push_back(generation);
            if self.retired.len() > 1024 {
                let old = self.retired.pop_front().unwrap();
                self.retired_set.remove(&old);
                self.floor = self.floor.max(old);
            }
        }
    }
    pub fn cancel(&mut self, generation: Option<u64>, id: &str) {
        for (key, entry) in &mut self.entries {
            if generation.is_none_or(|generation| generation == *key) {
                if entry.cancelled.len() >= 1024 {
                    entry.suspended = true;
                } else {
                    entry.cancelled.insert(id.to_owned());
                }
            }
        }
    }
    pub fn valid(&mut self, generation: u64, id: &str) -> bool {
        self.expire();
        self.entries.get(&generation).is_some_and(|entry| {
            !entry.suspended && Instant::now() < entry.deadline && !entry.cancelled.contains(id)
        })
    }
    fn expire(&mut self) {
        let now = Instant::now();
        for (generation, entry) in &mut self.entries {
            if now >= entry.deadline && !entry.suspended {
                entry.suspended = true;
                self.expired.push_back(*generation);
            }
        }
    }
    pub fn take_expired_generation(&mut self) -> Option<u64> {
        self.expire();
        self.expired.pop_front()
    }
    pub fn active(&mut self) -> bool {
        self.expire();
        self.entries
            .values()
            .any(|e| !e.suspended && Instant::now() < e.deadline)
    }
    pub fn scopes(&mut self) -> Vec<(u64, Scope)> {
        self.expire();
        self.entries
            .iter()
            .filter(|(_, e)| !e.suspended)
            .map(|(id, e)| (*id, e.scope.clone()))
            .collect()
    }
    pub fn scope(&self, generation: u64) -> Option<&Scope> {
        self.entries.get(&generation).map(|e| &e.scope)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn arm(p: &mut Permits, id: u64, scope: Scope) {
        p.renew(id, Duration::from_secs(1), Some(scope.clone()));
        p.resume(id, Some(&scope));
    }
    #[test]
    fn independent_apps_and_selective_stop() {
        let mut p = Permits::new();
        arm(&mut p, 1, Scope::App("a".into()));
        arm(&mut p, 2, Scope::App("b".into()));
        assert!(p.valid(1, "r") && p.valid(2, "r"));
        assert!(p.scope(1).unwrap().background());
        assert_eq!(p.scopes().len(), 2);
        p.suspend(Some(1));
        assert!(!p.valid(1, "r") && p.valid(2, "r"));
        p.suspend(None);
        assert!(!p.active());
    }
    #[test]
    fn scopes_cannot_change_or_conflict() {
        let mut p = Permits::new();
        arm(&mut p, 1, Scope::App("a".into()));
        arm(&mut p, 2, Scope::App("a".into()));
        arm(&mut p, 3, Scope::Foreground);
        assert!(!p.valid(2, "r") && !p.valid(3, "r"));
        p.renew(1, Duration::from_secs(1), Some(Scope::Foreground));
        p.resume(1, Some(&Scope::Foreground));
        assert!(!p.valid(1, "r"));
    }
    #[test]
    fn cancellation_and_retirement_reject_delayed_messages() {
        let mut p = Permits::new();
        arm(&mut p, 1, Scope::Foreground);
        p.cancel(None, "r");
        assert!(!p.valid(1, "r") && p.valid(1, "other"));
        p.retire(1);
        arm(&mut p, 1, Scope::Foreground);
        assert!(!p.valid(1, "other"));
        for id in 2..1100 {
            p.retire(id);
        }
        arm(&mut p, 1, Scope::Foreground);
        assert!(!p.active());
    }
    #[test]
    fn expiry_requires_explicit_resume() {
        let mut p = Permits::new();
        arm(&mut p, 1, Scope::Foreground);
        p.entries.get_mut(&1).unwrap().deadline = Instant::now();
        p.renew(1, Duration::from_secs(1), None);
        assert_eq!(p.take_expired_generation(), Some(1));
        assert!(!p.valid(1, "r"));
        p.resume(1, None);
        assert!(p.valid(1, "r"));
    }
    #[test]
    fn background_rejects_coordinate_and_cross_app_input() {
        let scope = Scope::App("a".into());
        for op in ["click", "key", "move", "drag", "scroll", "activateApp"] {
            assert!(!scope.allows("background", op, "a", ""));
        }
        assert!(scope.allows("background", "elementAction", "a", "press"));
        assert!(!scope.allows("background", "elementAction", "a", "focus"));
        assert!(!scope.allows("background", "type", "b", ""));
        assert!(!scope.allows("foreground", "type", "a", ""));
        assert!(Scope::decode(&serde_json::json!({"kind":"unknown"})).is_none());
    }
}
