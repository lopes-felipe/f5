use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Report {
    pub complete: bool,
    pub errors: Vec<i32>,
}
/// windows-rs turns S_OK + a null COM interface into Error::empty (HRESULT 0).
/// That is an empty tree edge, while a failing HRESULT remains a provider error.
pub fn optional<T>(value: Result<T, i32>) -> Result<Option<T>, i32> {
    match value {
        Ok(element) => Ok(Some(element)),
        Err(0) => Ok(None),
        Err(code) => Err(code),
    }
}
/// Provider errors mark the result partial without discarding unrelated sibling
/// branches. Node/time limits stop the whole walk; depth limits stop one branch.
pub fn walk<T: Clone>(
    root: T,
    max: usize,
    budget: Duration,
    child: impl FnMut(&T) -> Result<Option<T>, i32>,
    next: impl FnMut(&T) -> Result<Option<T>, i32>,
) -> (Vec<T>, Report) {
    walk_until(root, max, budget, child, next, |_| false)
}
/// An early-stop visitor avoids touching any provider after a matching node is found.
pub fn walk_until<T: Clone>(
    root: T,
    max: usize,
    budget: Duration,
    mut child: impl FnMut(&T) -> Result<Option<T>, i32>,
    mut next: impl FnMut(&T) -> Result<Option<T>, i32>,
    mut stop: impl FnMut(&T) -> bool,
) -> (Vec<T>, Report) {
    struct Walk<'a, T, C, N, S> {
        out: Vec<T>,
        report: Report,
        max: usize,
        end: Instant,
        child: &'a mut C,
        next: &'a mut N,
        stop: &'a mut S,
        stopped: bool,
    }
    impl<T: Clone, C, N, S> Walk<'_, T, C, N, S>
    where
        C: FnMut(&T) -> Result<Option<T>, i32>,
        N: FnMut(&T) -> Result<Option<T>, i32>,
        S: FnMut(&T) -> bool,
    {
        fn limited(&mut self) -> bool {
            if self.stopped {
                return true;
            }
            if self.out.len() >= self.max || Instant::now() >= self.end {
                self.report.complete = false;
                true
            } else {
                false
            }
        }
        fn error(&mut self, code: i32) {
            self.report.complete = false;
            if self.report.errors.len() < 8 {
                self.report.errors.push(code);
            }
        }
        fn visit(&mut self, node: T, depth: usize) {
            if self.limited() {
                return;
            }
            if depth > 30 {
                self.report.complete = false;
                return;
            }
            self.out.push(node.clone());
            if (self.stop)(&node) {
                self.stopped = true;
                return;
            }
            if self.limited() {
                return;
            }
            let mut current = (self.child)(&node);
            loop {
                match current {
                    Ok(Some(element)) => {
                        self.visit(element.clone(), depth + 1);
                        if self.limited() {
                            return;
                        }
                        current = (self.next)(&element);
                    }
                    Ok(None) => return,
                    Err(code) => {
                        self.error(code);
                        return;
                    }
                }
            }
        }
    }
    let mut walk = Walk {
        out: Vec::new(),
        report: Report {
            complete: true,
            errors: Vec::new(),
        },
        max,
        end: Instant::now() + budget,
        child: &mut child,
        next: &mut next,
        stop: &mut stop,
        stopped: false,
    };
    walk.visit(root, 0);
    (walk.out, walk.report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stops_before_querying_children_or_siblings_of_a_match() {
        let (nodes, _) = walk_until(
            0,
            4000,
            Duration::from_secs(1),
            |node| {
                if *node == 0 {
                    Ok(Some(1))
                } else {
                    panic!("matched child")
                }
            },
            |_| panic!("matched sibling"),
            |node| *node == 1,
        );
        assert_eq!(nodes, vec![0, 1]);
        let (nodes, _) = walk_until(
            0,
            4000,
            Duration::from_secs(1),
            |_| panic!("root matched"),
            |_| panic!("root matched"),
            |_| true,
        );
        assert_eq!(nodes, vec![0]);
    }
    #[test]
    fn successful_null_edges_are_complete_and_real_pointer_errors_are_not_empty() {
        assert_eq!(optional::<u32>(Err(0)), Ok(None));
        assert_eq!(optional(Ok(7)), Ok(Some(7)));
        let pointer_error = 0x80004003u32 as i32;
        assert_eq!(optional::<u32>(Err(pointer_error)), Err(pointer_error));
        let (nodes, report) = walk(
            0,
            20,
            Duration::from_secs(1),
            |node| {
                if *node == 0 {
                    optional(Ok(1))
                } else {
                    optional(Err(0))
                }
            },
            |node| {
                if *node == 1 {
                    optional(Ok(2))
                } else {
                    optional(Err(0))
                }
            },
        );
        assert_eq!(nodes, vec![0, 1, 2]);
        assert!(report.complete && report.errors.is_empty());
    }
    #[test]
    fn keeps_sibling_controls_after_a_provider_branch_fails() {
        let (nodes, report) = walk(
            0,
            20,
            Duration::from_secs(1),
            |node| match node {
                0 => Ok(Some(1)),
                1 => Err(-1),
                _ => Ok(None),
            },
            |node| if *node == 1 { Ok(Some(2)) } else { Ok(None) },
        );
        assert_eq!(nodes, vec![0, 1, 2]);
        assert!(!report.complete);
        assert_eq!(report.errors, vec![-1]);
    }
    #[test]
    fn bounds_cycles_and_does_not_query_after_an_expired_budget() {
        let (nodes, report) = walk(
            0,
            1,
            Duration::from_secs(1),
            |_| panic!("node limit"),
            |_| panic!("node limit"),
        );
        assert_eq!(nodes, vec![0]);
        assert!(!report.complete);
        let (nodes, report) = walk(0, 3, Duration::from_secs(1), |_| Ok(None), |_| Ok(Some(0)));
        assert_eq!(nodes, vec![0]);
        assert!(report.complete);
        let (nodes, report) = walk(
            0,
            3,
            Duration::from_secs(1),
            |node| if *node == 0 { Ok(Some(1)) } else { Ok(None) },
            |_| Ok(Some(1)),
        );
        assert_eq!(nodes.len(), 3);
        assert!(!report.complete);
        let (nodes, report) = walk(
            0,
            10,
            Duration::ZERO,
            |_| panic!("expired"),
            |_| panic!("expired"),
        );
        assert!(nodes.is_empty());
        assert!(!report.complete);
    }
    #[test]
    fn depth_limits_preserve_other_branches_and_bound_error_storage() {
        let (nodes, report) = walk(
            0,
            100,
            Duration::from_secs(1),
            |node| {
                if *node < 90 {
                    Ok(Some(node + 1))
                } else {
                    Err(-1)
                }
            },
            |node| if *node == 1 { Ok(Some(100)) } else { Ok(None) },
        );
        assert!(nodes.contains(&100));
        assert!(!report.complete);
        assert!(nodes.len() <= 100 && report.errors.len() <= 8);
    }
}
