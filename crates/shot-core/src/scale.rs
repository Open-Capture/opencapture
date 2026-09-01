//! Resampling a selection to an exact output size.
//!
//! Selected-area capture crops whatever rectangle the user dragged, which
//! lands on whatever pixel size that rectangle happened to be. When the user
//! has a size they actually need — "this has to come out 640x360" — the crop
//! is resampled to exactly that, so the selection only has to get the
//! *framing* right and never the pixel count.
//!
//! Bilinear rather than nearest: a screenshot scaled by a non-integer factor
//! with nearest-neighbour drops and doubles whole rows of text, which looks
//! broken in a way a slight softness does not.

use crate::crop::CroppedImage;
use crate::error::StitchError;

/// Resamples an RGBA bitmap to exactly `dst_width x dst_height`.
///
/// Returns the source unchanged when it is already the requested size, so
/// asking for the size you already have costs nothing and — more importantly
/// — cannot soften the image by resampling it through an identity transform.
pub fn scale_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    dst_width: u32,
    dst_height: u32,
) -> Result<CroppedImage, StitchError> {
    if width == 0 || height == 0 {
        return Err(StitchError::Encode("cannot scale an empty image".into()));
    }
    if dst_width == 0 || dst_height == 0 {
        return Err(StitchError::Encode(
            "output size must be at least 1x1 pixel".into(),
        ));
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected {
        return Err(StitchError::Encode(
            "source bitmap is smaller than its stated dimensions".into(),
        ));
    }

    if dst_width == width && dst_height == height {
        return Ok(CroppedImage {
            width,
            height,
            rgba: rgba.to_vec(),
        });
    }

    let mut out = vec![0u8; dst_width as usize * dst_height as usize * 4];
    let x_ratio = width as f64 / dst_width as f64;
    let y_ratio = height as f64 / dst_height as f64;
    let max_x = width - 1;
    let max_y = height - 1;

    for dy in 0..dst_height {
        // Sample from pixel centres, not corners. Using `dy * ratio` instead
        // biases every sample toward the top-left, which shifts the whole
        // image by up to half a pixel — visible as a drift when a capture is
        // scaled down a long way.
        let src_y = ((dy as f64 + 0.5) * y_ratio - 0.5).max(0.0);
        let y0 = (src_y.floor() as u32).min(max_y);
        let y1 = (y0 + 1).min(max_y);
        let wy = src_y - y0 as f64;

        for dx in 0..dst_width {
            let src_x = ((dx as f64 + 0.5) * x_ratio - 0.5).max(0.0);
            let x0 = (src_x.floor() as u32).min(max_x);
            let x1 = (x0 + 1).min(max_x);
            let wx = src_x - x0 as f64;

            let off = |x: u32, y: u32| (y as usize * width as usize + x as usize) * 4;
            let (p00, p10, p01, p11) = (off(x0, y0), off(x1, y0), off(x0, y1), off(x1, y1));
            let dst_off = (dy as usize * dst_width as usize + dx as usize) * 4;

            for channel in 0..4 {
                let top = rgba[p00 + channel] as f64 * (1.0 - wx) + rgba[p10 + channel] as f64 * wx;
                let bottom =
                    rgba[p01 + channel] as f64 * (1.0 - wx) + rgba[p11 + channel] as f64 * wx;
                let value = top * (1.0 - wy) + bottom * wy;
                out[dst_off + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    Ok(CroppedImage {
        width: dst_width,
        height: dst_height,
        rgba: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .copied()
            .cycle()
            .take((width * height * 4) as usize)
            .collect()
    }

    #[test]
    fn identity_size_returns_the_source_untouched() {
        let src = solid(4, 3, [10, 20, 30, 255]);
        let out = scale_rgba(&src, 4, 3, 4, 3).unwrap();
        assert_eq!(out.rgba, src, "an identity scale must not resample");
    }

    #[test]
    fn a_solid_colour_survives_any_scale() {
        // Bilinear weights sum to 1, so a flat field must come out flat —
        // this catches weight bugs that a gradient would hide.
        let src = solid(7, 5, [200, 100, 50, 255]);
        let out = scale_rgba(&src, 7, 5, 19, 11).unwrap();
        assert_eq!(out.width, 19);
        assert_eq!(out.height, 11);
        for pixel in out.rgba.as_chunks::<4>().0 {
            assert_eq!(pixel, &[200, 100, 50, 255]);
        }
    }

    #[test]
    fn halving_a_two_by_two_averages_it() {
        let src = vec![
            0, 0, 0, 255, // black
            255, 255, 255, 255, // white
            255, 255, 255, 255, // white
            0, 0, 0, 255, // black
        ];
        let out = scale_rgba(&src, 2, 2, 1, 1).unwrap();
        // Two black and two white pixels average to mid grey.
        assert_eq!(out.rgba[0..3], [128, 128, 128]);
        assert_eq!(out.rgba[3], 255);
    }

    #[test]
    fn upscaling_keeps_the_corners_anchored() {
        // The extreme corners are pure source pixels at any scale; if the
        // sample mapping is off, they bleed toward their neighbours.
        let src = vec![
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
            0, 0, 255, 255, // blue
            255, 255, 0, 255, // yellow
        ];
        let out = scale_rgba(&src, 2, 2, 8, 8).unwrap();
        let px = |x: usize, y: usize| &out.rgba[(y * 8 + x) * 4..(y * 8 + x) * 4 + 4];
        assert_eq!(px(0, 0), [255, 0, 0, 255]);
        assert_eq!(px(7, 0), [0, 255, 0, 255]);
        assert_eq!(px(0, 7), [0, 0, 255, 255]);
        assert_eq!(px(7, 7), [255, 255, 0, 255]);
    }

    #[test]
    fn rejects_empty_sources_and_targets() {
        let src = solid(2, 2, [1, 2, 3, 4]);
        assert!(scale_rgba(&src, 0, 2, 4, 4).is_err());
        assert!(scale_rgba(&src, 2, 2, 0, 4).is_err());
        assert!(scale_rgba(&src, 2, 2, 4, 0).is_err());
    }

    #[test]
    fn rejects_a_bitmap_shorter_than_its_dimensions() {
        assert!(scale_rgba(&[0, 0, 0, 255], 4, 4, 2, 2).is_err());
    }

    proptest! {
        #[test]
        fn output_is_always_exactly_the_requested_size(
            w in 1u32..24, h in 1u32..24, dw in 1u32..40, dh in 1u32..40,
        ) {
            let src = solid(w, h, [9, 9, 9, 255]);
            let out = scale_rgba(&src, w, h, dw, dh).unwrap();
            prop_assert_eq!(out.width, dw);
            prop_assert_eq!(out.height, dh);
            prop_assert_eq!(out.rgba.len(), (dw * dh * 4) as usize);
        }
    }
}
