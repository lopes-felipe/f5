pub fn zoom_bounds(
    rect: (i64, i64, i64, i64),
    model: (u32, u32),
    capture: (u32, u32),
) -> Option<(u32, u32, u32, u32)> {
    let (x, y, width, height) = rect;
    if x < 0
        || y < 0
        || width <= 0
        || height <= 0
        || model.0 == 0
        || model.1 == 0
        || capture.0 == 0
        || capture.1 == 0
        || width > model.0 as i64
        || height > model.1 as i64
        || x > model.0 as i64 - width
        || y > model.1 as i64 - height
    {
        return None;
    }
    let left = (x as f64 * capture.0 as f64 / model.0 as f64).floor() as u32;
    let top = (y as f64 * capture.1 as f64 / model.1 as f64).floor() as u32;
    let right =
        (((x + width) as f64 * capture.0 as f64 / model.0 as f64).ceil() as u32).min(capture.0);
    let bottom =
        (((y + height) as f64 * capture.1 as f64 / model.1 as f64).ceil() as u32).min(capture.1);
    Some((left, top, right - left, bottom - top))
}
/// Select an action display from its explicit target or focused window, never the cursor.
pub fn action_display_index(
    requested: &str,
    window: Option<(i32, i32, i32, i32)>,
    displays: &[(&str, (i32, i32, i32, i32))],
) -> Option<usize> {
    if !requested.is_empty() {
        return displays.iter().position(|(id, _)| *id == requested);
    }
    let (left, top, right, bottom) = window?;
    if right <= left || bottom <= top {
        return None;
    }
    let x = (left as i64 + right as i64) / 2;
    let y = (top as i64 + bottom as i64) / 2;
    displays.iter().position(|(_, (l, t, r, b))| {
        x >= *l as i64 && x < *r as i64 && y >= *t as i64 && y < *b as i64
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn action_display_follows_request_or_window_and_never_defaults_arbitrarily() {
        let displays = [("left", (0, 0, 1000, 800)), ("right", (1000, 0, 2000, 800))];
        let window = Some((1200, 50, 1800, 550));
        assert_eq!(action_display_index("", window, &displays), Some(1));
        assert_eq!(action_display_index("left", window, &displays), Some(0));
        assert_eq!(action_display_index("unknown", window, &displays), None);
        assert_eq!(action_display_index("", None, &displays), None);
        assert_eq!(
            action_display_index("", Some((0, 0, 0, 0)), &displays),
            None
        );
        assert_eq!(
            action_display_index("", Some((2200, 0, 2300, 100)), &displays),
            None
        );
    }
    #[test]
    fn maps_model_rect_into_sharp_capture_pixels() {
        assert_eq!(
            zoom_bounds((100, 50, 100, 50), (1000, 500), (2000, 1000)),
            Some((200, 100, 200, 100))
        );
        assert_eq!(
            zoom_bounds((999, 499, 1, 1), (1000, 500), (2000, 1000)),
            Some((1998, 998, 2, 2))
        );
    }
    #[test]
    fn rejects_outside_and_overflowing_coordinates() {
        for rect in [
            (1000, 0, 1, 1),
            (-1, 0, 1, 1),
            (i64::MAX, 0, i64::MAX, 1),
            (0, 0, 0, 1),
        ] {
            assert_eq!(zoom_bounds(rect, (1000, 500), (2000, 1000)), None);
        }
    }
}
