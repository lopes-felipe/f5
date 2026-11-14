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
/// UI frameworks whose item containers clip their items, so an off-screen item draws
/// nothing. Web content (Chromium reports "Chrome", Firefox "Gecko") is excluded: a
/// positioned or top-layer descendant of an off-screen item can still render on screen.
pub fn lists_rendered_children(framework: &str) -> bool {
    matches!(framework, "Win32" | "WinForm" | "WPF" | "XAML" | "DirectUI")
}
/// An item container's child may be skipped only when the provider reports it off-screen
/// and its own bounds (left, top, right, bottom) miss the container's by more than 1 px.
/// An unknown flag or unreadable bounds keep the child, so a stale or wrong `IsOffscreen`
/// cannot hide a drawn item.
pub fn offscreen_child_skippable(
    offscreen: Option<bool>,
    bounds: Option<(i32, i32, i32, i32)>,
    container: (i32, i32, i32, i32),
) -> bool {
    let (Some(true), Some((left, top, right, bottom))) = (offscreen, bounds) else {
        return false;
    };
    let width = right.min(container.2) - left.max(container.0);
    let height = bottom.min(container.3) - top.max(container.1);
    width <= 1 || height <= 1
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
    child: impl FnMut(&T) -> Result<Option<T>, i32>,
    next: impl FnMut(&T) -> Result<Option<T>, i32>,
    stop: impl FnMut(&T) -> bool,
) -> (Vec<T>, Report) {
    walk_inner(root, max, budget, child, next, |_| None, stop)
}
/// Like `walk`, but `list_children` may enumerate a node's children in one call:
/// `Some(Ok(children))` visits them in order under the same limits, `Some(Err(code))`
/// records a provider error for that node, and `None` uses the first-child/next-sibling
/// walk.
pub fn walk_with_lists<T: Clone>(
    root: T,
    max: usize,
    budget: Duration,
    child: impl FnMut(&T) -> Result<Option<T>, i32>,
    next: impl FnMut(&T) -> Result<Option<T>, i32>,
    list_children: impl FnMut(&T) -> Option<Result<Vec<T>, i32>>,
) -> (Vec<T>, Report) {
    walk_inner(root, max, budget, child, next, list_children, |_| false)
}
fn walk_inner<T: Clone>(
    root: T,
    max: usize,
    budget: Duration,
    mut child: impl FnMut(&T) -> Result<Option<T>, i32>,
    mut next: impl FnMut(&T) -> Result<Option<T>, i32>,
    mut list: impl FnMut(&T) -> Option<Result<Vec<T>, i32>>,
    mut stop: impl FnMut(&T) -> bool,
) -> (Vec<T>, Report) {
    struct Walk<'a, T, C, N, L, S> {
        out: Vec<T>,
        report: Report,
        max: usize,
        end: Instant,
        child: &'a mut C,
        next: &'a mut N,
        list: &'a mut L,
        stop: &'a mut S,
        stopped: bool,
    }
    impl<T: Clone, C, N, L, S> Walk<'_, T, C, N, L, S>
    where
        C: FnMut(&T) -> Result<Option<T>, i32>,
        N: FnMut(&T) -> Result<Option<T>, i32>,
        L: FnMut(&T) -> Option<Result<Vec<T>, i32>>,
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
            match (self.list)(&node) {
                Some(Ok(children)) => {
                    for element in children {
                        self.visit(element, depth + 1);
                        if self.limited() {
                            return;
                        }
                    }
                    return;
                }
                Some(Err(code)) => {
                    self.error(code);
                    return;
                }
                None => {}
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
        list: &mut list,
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
    /// Window 0 > [list 1 > listed [10, 11 > 20, 12], button 2]. Only node 1 is listed;
    /// every other node, including listed children, uses the sibling walk.
    fn listed_walk(
        max: usize,
        budget: Duration,
        listed: Result<Vec<u32>, i32>,
    ) -> (Vec<u32>, Report) {
        walk_with_lists(
            0u32,
            max,
            budget,
            |node| match node {
                0 => Ok(Some(1)),
                1 => panic!("listed node walked by sibling"),
                11 => Ok(Some(20)),
                _ => Ok(None),
            },
            |node| match node {
                1 => Ok(Some(2)),
                10 | 12 => panic!("listed child walked by sibling"),
                _ => Ok(None),
            },
            |node| (*node == 1).then(|| listed.clone()),
        )
    }
    #[test]
    fn listed_children_are_visited_in_order_before_later_siblings() {
        let (nodes, report) = listed_walk(100, Duration::from_secs(1), Ok(vec![10, 11, 12]));
        assert_eq!(nodes, vec![0, 1, 10, 11, 20, 12, 2]);
        assert!(report.complete && report.errors.is_empty());
        let (nodes, report) = listed_walk(100, Duration::from_secs(1), Ok(vec![]));
        assert_eq!(nodes, vec![0, 1, 2]);
        assert!(report.complete);
    }
    #[test]
    fn a_listing_error_is_partial_but_keeps_later_siblings() {
        let (nodes, report) = listed_walk(100, Duration::from_secs(1), Err(-5));
        assert_eq!(nodes, vec![0, 1, 2]);
        assert!(!report.complete);
        assert_eq!(report.errors, vec![-5]);
    }
    #[test]
    fn listed_children_share_the_node_and_time_limits() {
        let (nodes, report) = listed_walk(3, Duration::from_secs(1), Ok(vec![10, 11, 12]));
        assert_eq!(nodes, vec![0, 1, 10]);
        assert!(!report.complete);
        let (nodes, report) = listed_walk(10, Duration::ZERO, Ok(vec![10, 11, 12]));
        assert!(nodes.is_empty());
        assert!(!report.complete);
    }
    #[test]
    fn only_native_frameworks_list_rendered_children() {
        for framework in ["Win32", "WinForm", "WPF", "XAML", "DirectUI"] {
            assert!(lists_rendered_children(framework), "{framework}");
        }
        for framework in ["Chrome", "Gecko", "", "win32", "Unknown"] {
            assert!(!lists_rendered_children(framework), "{framework}");
        }
    }
    #[test]
    fn a_child_is_skipped_only_when_reported_offscreen_and_outside_the_container() {
        let list = (0, 100, 400, 700);
        // Scrolled below, virtualized with empty bounds, or touching the edge by 1 px.
        assert!(offscreen_child_skippable(
            Some(true),
            Some((0, 900, 400, 930)),
            list
        ));
        assert!(offscreen_child_skippable(
            Some(true),
            Some((0, 0, 0, 0)),
            list
        ));
        assert!(offscreen_child_skippable(
            Some(true),
            Some((0, 699, 400, 729)),
            list
        ));
        // A drawn row the provider wrongly reports off-screen is still walked.
        assert!(!offscreen_child_skippable(
            Some(true),
            Some((0, 300, 400, 330)),
            list
        ));
        assert!(!offscreen_child_skippable(
            Some(true),
            Some((0, 690, 400, 720)),
            list
        ));
        // Unknown flag or bounds, or on-screen: always walked.
        assert!(!offscreen_child_skippable(
            None,
            Some((0, 900, 400, 930)),
            list
        ));
        assert!(!offscreen_child_skippable(Some(true), None, list));
        assert!(!offscreen_child_skippable(
            Some(false),
            Some((0, 900, 400, 930)),
            list
        ));
    }
    #[test]
    fn unlisted_nodes_keep_the_sibling_walk() {
        let (nodes, report) = walk_with_lists(
            0u32,
            100,
            Duration::from_secs(1),
            |node| if *node == 0 { Ok(Some(1)) } else { Ok(None) },
            |node| if *node == 1 { Ok(Some(2)) } else { Ok(None) },
            |_| None,
        );
        assert_eq!(nodes, vec![0, 1, 2]);
        assert!(report.complete);
    }
}
