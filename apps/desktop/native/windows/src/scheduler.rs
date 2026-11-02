use std::collections::{HashSet, VecDeque};
use std::sync::{Condvar, Mutex};

/// A bounded pool may run different apps together, but never dispatches two
/// mutations to one app. Blocked apps do not occupy worker threads.
pub struct AppQueue<T> {
    state: Mutex<State<T>>,
    changed: Condvar,
}
struct State<T> {
    pending: VecDeque<(String, T)>,
    active: HashSet<String>,
}
impl<T> AppQueue<T> {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                pending: VecDeque::new(),
                active: HashSet::new(),
            }),
            changed: Condvar::new(),
        }
    }
    pub fn push(&self, app: String, task: T) -> Result<(), T> {
        let mut state = self.state.lock().unwrap();
        if state.pending.len() >= 32 {
            return Err(task);
        }
        state.pending.push_back((app, task));
        self.changed.notify_one();
        Ok(())
    }
    fn available(state: &mut State<T>) -> Option<(String, T)> {
        let index = state
            .pending
            .iter()
            .position(|(app, _)| !state.active.contains(app))?;
        let (app, task) = state.pending.remove(index)?;
        state.active.insert(app.clone());
        Some((app, task))
    }
    pub fn take(&self) -> (String, T) {
        let mut state = self.state.lock().unwrap();
        loop {
            if let Some(task) = Self::available(&mut state) {
                return task;
            }
            state = self.changed.wait(state).unwrap();
        }
    }
    pub fn finish(&self, app: &str) {
        self.state.lock().unwrap().active.remove(app);
        self.changed.notify_all();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serializes_each_app_without_blocking_other_apps() {
        let queue = AppQueue::new();
        queue.push("a".into(), 1).unwrap();
        queue.push("a".into(), 2).unwrap();
        queue.push("b".into(), 3).unwrap();
        assert_eq!(queue.take(), ("a".into(), 1));
        assert_eq!(queue.take(), ("b".into(), 3));
        assert!(AppQueue::available(&mut queue.state.lock().unwrap()).is_none());
        queue.finish("a");
        assert_eq!(queue.take(), ("a".into(), 2));
    }
    #[test]
    fn overload_returns_the_unaccepted_task() {
        let queue = AppQueue::new();
        for id in 0..32 {
            queue.push("a".into(), id).unwrap();
        }
        assert_eq!(queue.push("b".into(), 32), Err(32));
    }
}
