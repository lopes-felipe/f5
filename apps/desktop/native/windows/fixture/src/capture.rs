//! Independent pixel assertions. Images are decoded in memory; only counts and
//! booleans leave this verifier. No helper, desktop capture or input APIs.
use base64::prelude::*;
use image::{ImageReader, RgbaImage};
use serde_json::{json, Value};
use std::io::{Read, Write};

const LIMIT: usize = 12 * 1024 * 1024;
fn rect(value: &Value, width: u32, height: u32) -> Result<(u32, u32, u32, u32), ()> {
    let number = |key| {
        value[key]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or(())
    };
    let (x, y, w, h) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    if w < 8 || h < 8 || x.checked_add(w).ok_or(())? > width || y.checked_add(h).ok_or(())? > height
    {
        return Err(());
    }
    Ok((x, y, w, h))
}
pub fn verify(pixels: &RgbaImage, value: &Value) -> Result<Value, ()> {
    let (width, height) = pixels.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32 * 1024 * 1024 {
        return Err(());
    }
    let (mut blue, mut green, mut neutral) = (0usize, 0usize, 0usize);
    let is_neutral = |p: &image::Rgba<u8>| p.0[0..3].iter().all(|v| v.abs_diff(115) <= 8);
    for p in pixels.pixels() {
        blue += usize::from(p[2] > 180 && p[0] < 55 && p[1] < 55);
        green += usize::from(p[1] > 180 && p[0] < 55 && p[2] < 55);
        neutral += usize::from(is_neutral(p));
    }
    let mut secure_masked = true;
    let mut secure_regions = 0;
    if let Some(regions) = value["secureRects"].as_array() {
        if regions.len() > 16 {
            return Err(());
        }
        for region in regions {
            let (x, y, w, h) = rect(region, width, height)?;
            secure_regions += 1;
            // Ignore filtering/JPEG edges, but require every interior pixel.
            for y in (y + 3)..(y + h - 3) {
                for x in (x + 3)..(x + w - 3) {
                    secure_masked &= is_neutral(pixels.get_pixel(x, y));
                }
            }
        }
    }
    Ok(json!({
        "width":width, "height":height, "bluePixels":blue, "greenPixels":green,
        "blueVisible":blue >= 20, "greenVisible":green >= 20, "greenAbsent":green == 0,
        "allNeutral":neutral == width as usize * height as usize,
        "secureMasked":secure_regions > 0 && secure_masked, "secureRegions":secure_regions,
    }))
}
pub fn run() -> Result<(), ()> {
    let mut input = Vec::new();
    std::io::stdin()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| ())?;
    if input.len() > LIMIT {
        return Err(());
    }
    let value: Value = serde_json::from_slice(&input).map_err(|_| ())?;
    let bytes = BASE64_STANDARD
        .decode(value["data"].as_str().ok_or(())?)
        .map_err(|_| ())?;
    let format = match value["mimeType"].as_str() {
        Some("image/jpeg") => image::ImageFormat::Jpeg,
        Some("image/png") => image::ImageFormat::Png,
        _ => return Err(()),
    };
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    let pixels = reader.decode().map_err(|_| ())?.to_rgba8();
    let result = verify(&pixels, &value)?;
    writeln!(std::io::stdout(), "{result}").map_err(|_| ())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blank_or_leaking_frames_cannot_prove_positive_and_negative_controls() {
        let mut pixels = RgbaImage::from_pixel(32, 32, image::Rgba([115, 115, 115, 255]));
        let input = json!({"secureRects":[{"x":0,"y":0,"width":16,"height":16}]});
        let blank = verify(&pixels, &input).unwrap();
        assert_eq!(blank["blueVisible"], false);
        assert_eq!(blank["secureMasked"], true);
        for x in 0..24 {
            pixels.put_pixel(x, 25, image::Rgba([0, 0, 255, 255]));
        }
        assert_eq!(verify(&pixels, &input).unwrap()["blueVisible"], true);
        pixels.put_pixel(5, 5, image::Rgba([255, 255, 255, 255]));
        assert_eq!(verify(&pixels, &input).unwrap()["secureMasked"], false);
        pixels.put_pixel(28, 28, image::Rgba([0, 255, 0, 255]));
        assert_eq!(verify(&pixels, &input).unwrap()["greenAbsent"], false);
    }
    #[test]
    fn invalid_or_missing_secure_geometry_cannot_pass_masking() {
        let pixels = RgbaImage::new(32, 32);
        assert_eq!(verify(&pixels, &json!({})).unwrap()["secureMasked"], false);
        assert!(verify(
            &pixels,
            &json!({"secureRects":[{"x":31,"y":0,"width":16,"height":16}]})
        )
        .is_err());
    }
}
