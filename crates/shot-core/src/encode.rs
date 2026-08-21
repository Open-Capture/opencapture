//! PNG encoding of stitched [`crate::stitch::Segment`]s, including a `pHYs`
//! chunk so downstream tools (and the OS file preview) report the correct
//! physical DPI for retina captures instead of treating every export as
//! 96dpi.

use crate::error::StitchError;
use crate::stitch::Segment;
use crate::types::EncodedImage;

const CSS_DPI: f64 = 96.0;
const METERS_PER_INCH: f64 = 0.0254;

/// Device pixels per meter, for the PNG `pHYs` chunk, at the given DPR.
fn pixels_per_meter(dpr: f64) -> u32 {
    let device_dpi = CSS_DPI * dpr;
    (device_dpi / METERS_PER_INCH).round() as u32
}

pub fn encode_png(segment: &Segment, dpr: f64) -> Result<EncodedImage, StitchError> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, segment.width_dev, segment.height_dev);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let ppm = pixels_per_meter(dpr);
        encoder.set_pixel_dims(Some(png::PixelDimensions {
            xppu: ppm,
            yppu: ppm,
            unit: png::Unit::Meter,
        }));
        let mut writer = encoder
            .write_header()
            .map_err(|e| StitchError::Encode(e.to_string()))?;
        writer
            .write_image_data(&segment.rgba)
            .map_err(|e| StitchError::Encode(e.to_string()))?;
    }
    Ok(EncodedImage {
        width_dev: segment.width_dev,
        height_dev: segment.height_dev,
        png_bytes: bytes,
    })
}

pub fn encode_segments(segments: &[Segment], dpr: f64) -> Result<Vec<EncodedImage>, StitchError> {
    segments.iter().map(|s| encode_png(s, dpr)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stitch::decode_png_rgba;

    fn solid_segment(width: u32, height: u32, rgba: [u8; 4]) -> Segment {
        let mut data = vec![0u8; (width * height * 4) as usize];
        for px in data.as_chunks_mut::<4>().0 {
            px.copy_from_slice(&rgba);
        }
        Segment {
            width_dev: width,
            height_dev: height,
            rgba: data,
        }
    }

    #[test]
    fn encode_roundtrips_through_decode() {
        let seg = solid_segment(8, 6, [200, 100, 50, 255]);
        let encoded = encode_png(&seg, 2.0).unwrap();
        assert_eq!(encoded.width_dev, 8);
        assert_eq!(encoded.height_dev, 6);
        let decoded = decode_png_rgba(&encoded.png_bytes).unwrap();
        assert_eq!(decoded.width, 8);
        assert_eq!(decoded.height, 6);
        assert_eq!(decoded.rgba, seg.rgba);
    }

    #[test]
    fn encode_is_deterministic() {
        let seg = solid_segment(16, 16, [1, 2, 3, 255]);
        let a = encode_png(&seg, 1.5).unwrap();
        let b = encode_png(&seg, 1.5).unwrap();
        assert_eq!(
            a.png_bytes, b.png_bytes,
            "identical input must produce byte-identical PNG output"
        );
    }

    #[test]
    fn pixels_per_meter_matches_known_dpi_values() {
        // dpr 1.0 -> 96 CSS dpi -> ~3779.53 px/m
        assert_eq!(pixels_per_meter(1.0), 3780);
        // dpr 2.0 -> 192 dpi -> ~7559.06 px/m
        assert_eq!(pixels_per_meter(2.0), 7559);
    }

    #[test]
    fn encode_segments_handles_empty_and_multiple() {
        assert_eq!(encode_segments(&[], 1.0).unwrap().len(), 0);
        let segs = vec![
            solid_segment(2, 2, [0, 0, 0, 255]),
            solid_segment(2, 2, [255, 255, 255, 255]),
        ];
        let encoded = encode_segments(&segs, 1.0).unwrap();
        assert_eq!(encoded.len(), 2);
        assert_ne!(encoded[0].png_bytes, encoded[1].png_bytes);
    }
}
