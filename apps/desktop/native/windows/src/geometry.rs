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
#[cfg(test)]
mod tests {
    use super::*;
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
