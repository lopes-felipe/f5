use image::RgbaImage;

#[derive(Clone, Copy)]
pub struct CaptureRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// PrintWindow supplies full-window BGRA pixels. Only the visible DWM frame is
/// composited, in global physical-pixel space. The caller authorizes the owner
/// immediately before capture; this routine never reads desktop pixels.
pub fn composite_window(
    canvas: &mut RgbaImage,
    display: CaptureRect,
    full: CaptureRect,
    frame: CaptureRect,
    pixels: &[u8],
) -> bool {
    let width = i64::from(full.right) - i64::from(full.left);
    let height = i64::from(full.bottom) - i64::from(full.top);
    if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
        return false;
    }
    if pixels.len() as u64 != width as u64 * height as u64 * 4 {
        return false;
    }
    let zero_alpha = pixels.chunks_exact(4).all(|pixel| pixel[3] == 0);
    let left = full.left.max(frame.left).max(display.left);
    let top = full.top.max(frame.top).max(display.top);
    let right = full.right.min(frame.right).min(display.right);
    let bottom = full.bottom.min(frame.bottom).min(display.bottom);
    for global_y in top..bottom {
        for global_x in left..right {
            let x = (i64::from(global_x) - i64::from(display.left)) as u32;
            let y = (i64::from(global_y) - i64::from(display.top)) as u32;
            if x >= canvas.width() || y >= canvas.height() {
                continue;
            }
            let offset = (((i64::from(global_y) - i64::from(full.top)) * width
                + i64::from(global_x)
                - i64::from(full.left))
                * 4) as usize;
            let alpha = if zero_alpha { 255 } else { pixels[offset + 3] } as u32;
            let dest = canvas.get_pixel_mut(x, y);
            for (index, src) in [pixels[offset + 2], pixels[offset + 1], pixels[offset]]
                .iter()
                .enumerate()
            {
                dest[index] =
                    ((*src as u32 * alpha + dest[index] as u32 * (255 - alpha)) / 255) as u8;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> CaptureRect {
        CaptureRect {
            left,
            top,
            right,
            bottom,
        }
    }
    #[test]
    fn invisible_borders_do_not_shift_or_crop_visible_controls() {
        let mut canvas = RgbaImage::from_pixel(3, 3, Rgba([115, 115, 115, 255]));
        let mut source = vec![0; 5 * 5 * 4];
        for y in 1..4 {
            for x in 1..4 {
                let offset = (y * 5 + x) * 4;
                source[offset..offset + 4].copy_from_slice(&[x as u8, y as u8, 200, 255]);
            }
        }
        assert!(composite_window(
            &mut canvas,
            rect(100, 100, 103, 103),
            rect(99, 99, 104, 104),
            rect(100, 100, 103, 103),
            &source
        ));
        assert_eq!(*canvas.get_pixel(0, 0), Rgba([200, 1, 1, 255]));
        assert_eq!(*canvas.get_pixel(2, 2), Rgba([200, 3, 3, 255]));
    }
    #[test]
    fn back_to_front_alpha_and_negative_monitor_origins() {
        let mut canvas = RgbaImage::from_pixel(2, 1, Rgba([115, 115, 115, 255]));
        let display = rect(-2, -1, 0, 0);
        assert!(composite_window(
            &mut canvas,
            display,
            display,
            display,
            &[255, 0, 0, 0, 255, 0, 0, 0]
        ));
        assert!(composite_window(
            &mut canvas,
            display,
            rect(-1, -1, 0, 0),
            display,
            &[0, 0, 255, 128]
        ));
        assert_eq!(*canvas.get_pixel(0, 0), Rgba([0, 0, 255, 255]));
        assert_eq!(*canvas.get_pixel(1, 0), Rgba([128, 0, 127, 255]));
    }
    #[test]
    fn malformed_capture_keeps_neutral_canvas() {
        let mut canvas = RgbaImage::from_pixel(2, 1, Rgba([115, 115, 115, 255]));
        let display = rect(0, 0, 2, 1);
        assert!(!composite_window(
            &mut canvas,
            display,
            display,
            display,
            &[0; 4]
        ));
        assert!(canvas.pixels().all(|pixel| pixel.0 == [115, 115, 115, 255]));
    }
}
