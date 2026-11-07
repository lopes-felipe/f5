/// Text is never cached. Missing cached/live password status is secure.
/// Recheck after reading as well, so a password transition cannot escape in a result.
pub fn read_text<T>(
    cached_password: Option<bool>,
    mut live_password: impl FnMut() -> Option<bool>,
    read: impl FnOnce() -> Option<T>,
) -> Option<T> {
    if cached_password != Some(false) || live_password() != Some(false) {
        return None;
    }
    let value = read();
    if live_password() != Some(false) {
        return None;
    }
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_changes_fail_closed_before_and_after_materialization() {
        for cached in [None, Some(true)] {
            assert!(read_text::<String>(
                cached,
                || panic!("cached secure"),
                || panic!("must not read")
            )
            .is_none());
        }
        for live in [None, Some(true)] {
            assert!(
                read_text::<String>(Some(false), || live, || panic!("must not read")).is_none()
            );
        }
        let mut calls = 0;
        assert!(read_text(
            Some(false),
            || {
                calls += 1;
                Some(calls > 1)
            },
            || Some("sentinel")
        )
        .is_none());
        assert_eq!(
            read_text(Some(false), || Some(false), || Some("safe")),
            Some("safe")
        );
    }
}
