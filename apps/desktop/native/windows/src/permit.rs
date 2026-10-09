use std::collections::HashSet;
use std::time::{Duration, Instant};
pub struct Permit {
    generation: u64,
    deadline: Instant,
    suspended: bool,
    cancelled: HashSet<String>,
    expired_generation: Option<u64>,
}
impl Permit {
    pub fn new() -> Self {
        Self {
            generation: 0,
            deadline: Instant::now(),
            suspended: true,
            cancelled: HashSet::new(),
            expired_generation: None,
        }
    }
    pub fn renew(&mut self, generation: u64, duration: Duration) {
        if generation < self.generation {
            return;
        }
        if Instant::now() >= self.deadline {
            self.expire();
        }
        if generation != self.generation {
            self.suspended = true;
            self.cancelled.clear();
        }
        self.generation = generation;
        self.deadline = Instant::now() + duration.min(Duration::from_secs(1));
    }
    pub fn resume(&mut self, generation: u64) {
        if generation == self.generation && Instant::now() < self.deadline {
            self.suspended = false;
        }
    }
    pub fn suspend(&mut self) {
        self.suspended = true;
    }
    pub fn cancel(&mut self, id: &str) {
        self.cancelled.insert(id.to_string());
    }
    pub fn valid(&mut self, generation: u64, id: &str) -> bool {
        if Instant::now() >= self.deadline {
            self.expire();
        }
        !self.suspended && generation == self.generation && !self.cancelled.contains(id)
    }
    fn expire(&mut self) {
        if !self.suspended {
            self.expired_generation = Some(self.generation);
        }
        self.suspended = true;
    }
    pub fn take_expired_generation(&mut self) -> Option<u64> {
        if Instant::now() >= self.deadline {
            self.expire();
        }
        self.expired_generation.take()
    }
    pub fn active(&mut self) -> bool {
        self.valid(self.generation, "")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn starts_suspended_and_never_resumes_on_renewal() {
        let mut p = Permit::new();
        p.renew(1, Duration::from_secs(1));
        assert!(!p.valid(1, "a"));
        p.resume(1);
        assert!(p.valid(1, "a"));
        p.suspend();
        p.renew(1, Duration::from_secs(1));
        assert!(!p.valid(1, "a"));
    }
    #[test]
    fn generation_and_cancel_are_authoritative() {
        let mut p = Permit::new();
        p.renew(3, Duration::from_secs(1));
        p.resume(3);
        p.cancel("a");
        assert!(!p.valid(3, "a"));
        assert!(p.valid(3, "b"));
        p.renew(2, Duration::from_secs(1));
        p.resume(2);
        assert!(!p.valid(2, "b"));
        p.renew(4, Duration::from_secs(1));
        assert!(!p.valid(4, "b"));
    }
    #[test]
    fn permit_expiry_latches() {
        let mut p = Permit::new();
        p.renew(1, Duration::from_millis(1));
        p.resume(1);
        std::thread::sleep(Duration::from_millis(5));
        assert!(!p.active());
        p.renew(1, Duration::from_secs(1));
        assert!(!p.active());
    }
    #[test]
    fn renewal_after_stall_does_not_revive_input() {
        let mut p = Permit::new();
        p.renew(1, Duration::from_millis(1));
        p.resume(1);
        std::thread::sleep(Duration::from_millis(5));
        p.renew(1, Duration::from_secs(1));
        assert!(!p.active());
        p.resume(1);
        assert!(p.active());
    }
}
