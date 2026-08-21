//! Decodes captured PNG slices, resolves their placement via [`crate::plan`],
//! and composites the result into one or more bounded-size RGBA segments
//! (bounded by [`crate::plan::MAX_CANVAS_AREA_PX`]) ready for
//! [`crate::encode`].

use crate::error::StitchError;
use crate::plan::{self, SliceObservation};
use crate::types::CapturedSlice;

pub struct DecodedSlice {
    pub width: u32,
    pub height: u32,
    /// Tightly packed RGBA8 rows, `height` rows of `width * 4` bytes each.
    pub rgba: Vec<u8>,
}

/// A composited, bounded-size chunk of the final stitched image, in device
/// pixels. `row(i)` is `rgba[i*width*4 .. (i+1)*width*4]`.
#[derive(Debug)]
pub struct Segment {
    pub width_dev: u32,
    pub height_dev: u32,
    pub rgba: Vec<u8>,
}

pub fn decode_png_rgba(bytes: &[u8]) -> Result<DecodedSlice, String> {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let width = info.width;
    let height = info.height;
    let raw = &buf[..info.buffer_size()];

    let rgba = match info.color_type {
        png::ColorType::Rgba => raw.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(raw.len() / 3 * 4);
            for px in raw.as_chunks::<3>().0 {
                out.extend_from_slice(px);
                out.push(255);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(raw.len() * 2);
            for px in raw.as_chunks::<2>().0 {
                let (g, a) = (px[0], px[1]);
                out.extend_from_slice(&[g, g, g, a]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(raw.len() * 4);
            for &g in raw {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        other => {
            return Err(format!(
                "unsupported PNG color type after normalization: {other:?}"
            ))
        }
    };

    Ok(DecodedSlice {
        width,
        height,
        rgba,
    })
}

/// Decode every slice, resolve placement, and composite into bounded-size
/// segments. `slices` must be in scroll order (top of page first).
pub fn build_segments(
    dpr: f64,
    slices: &[CapturedSlice],
) -> Result<(crate::types::StitchPlan, Vec<Segment>), StitchError> {
    if slices.is_empty() {
        return Err(StitchError::Plan(crate::error::PlanError::NoObservations));
    }

    let mut decoded = Vec::with_capacity(slices.len());
    for (i, s) in slices.iter().enumerate() {
        let d = decode_png_rgba(&s.png_bytes).map_err(|message| StitchError::Decode {
            slice_index: i,
            message,
        })?;
        decoded.push(d);
    }

    let session_width = decoded[0].width;
    for (i, d) in decoded.iter().enumerate() {
        if d.width != session_width {
            return Err(StitchError::WidthMismatch {
                slice_index: i,
                expected: session_width,
                actual: d.width,
            });
        }
    }

    let observations: Vec<SliceObservation> = slices
        .iter()
        .zip(decoded.iter())
        .map(|(s, d)| SliceObservation {
            actual_scroll_css: s.actual_scroll_css,
            bitmap_height_dev: d.height,
            bitmap_width_dev: d.width,
        })
        .collect();

    let stitch_plan = plan::place_slices(dpr, &observations)?;
    let ranges = plan::split_ranges(stitch_plan.canvas_height_dev, stitch_plan.canvas_width_dev);

    let width = stitch_plan.canvas_width_dev as usize;
    let mut segments = Vec::with_capacity(ranges.len());

    for range in &ranges {
        let height = range.height() as usize;
        let mut rgba = vec![0u8; width * height * 4];

        for placement in &stitch_plan.placements {
            let p_start = placement.canvas_y_dev;
            let p_end = placement.canvas_y_dev + placement.rows_dev;
            let overlap_start = p_start.max(range.start_dev);
            let overlap_end = p_end.min(range.end_dev);
            if overlap_start >= overlap_end {
                continue;
            }

            let src = &decoded[placement.slice_index];
            let src_row_start = placement.crop_top_dev + (overlap_start - p_start);
            let dst_row_start = overlap_start - range.start_dev;
            let n_rows = overlap_end - overlap_start;

            let row_bytes = width * 4;
            for r in 0..n_rows {
                let src_off = (src_row_start + r) as usize * row_bytes;
                let dst_off = (dst_row_start + r) as usize * row_bytes;
                rgba[dst_off..dst_off + row_bytes]
                    .copy_from_slice(&src.rgba[src_off..src_off + row_bytes]);
            }
        }

        segments.push(Segment {
            width_dev: stitch_plan.canvas_width_dev,
            height_dev: range.height(),
            rgba,
        });
    }

    Ok((stitch_plan, segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_solid_png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let mut data = vec![0u8; (width * height * 4) as usize];
            for px in data.as_chunks_mut::<4>().0 {
                px.copy_from_slice(&rgba);
            }
            writer.write_image_data(&data).unwrap();
        }
        buf
    }

    /// Each row's red channel encodes its row index (mod 256) so a stitched
    /// buffer's row order can be verified pixel-exactly.
    fn encode_row_indexed_png(width: u32, height: u32, row_offset: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let mut data = vec![0u8; (width * height * 4) as usize];
            for row in 0..height {
                let value = ((row_offset + row) % 256) as u8;
                for col in 0..width {
                    let off = ((row * width + col) * 4) as usize;
                    data[off..off + 4].copy_from_slice(&[value, value, value, 255]);
                }
            }
            writer.write_image_data(&data).unwrap();
        }
        buf
    }

    #[test]
    fn decode_roundtrips_solid_rgba() {
        let png_bytes = encode_solid_png(4, 3, [10, 20, 30, 255]);
        let d = decode_png_rgba(&png_bytes).unwrap();
        assert_eq!(d.width, 4);
        assert_eq!(d.height, 3);
        assert_eq!(d.rgba.len(), 4 * 3 * 4);
        assert_eq!(&d.rgba[0..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn decode_converts_rgb_without_alpha() {
        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[1, 2, 3, 4, 5, 6]).unwrap();
        }
        let d = decode_png_rgba(&buf).unwrap();
        assert_eq!(d.rgba, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn build_segments_stitches_two_slices_without_duplicated_rows() {
        // Two 4x4 slices, second scrolled down by exactly its own height:
        // expect one 4x8 segment where row-index encoding is exactly 0..8,
        // no duplicated or skipped row values.
        let slice0 = encode_row_indexed_png(4, 4, 0);
        let slice1 = encode_row_indexed_png(4, 4, 4);
        let slices = vec![
            CapturedSlice {
                actual_scroll_css: 0.0,
                png_bytes: slice0,
            },
            CapturedSlice {
                actual_scroll_css: 4.0,
                png_bytes: slice1,
            },
        ];
        let (stitch_plan, segments) = build_segments(1.0, &slices).unwrap();
        assert_eq!(stitch_plan.canvas_height_dev, 8);
        assert_eq!(segments.len(), 1);
        let seg = &segments[0];
        assert_eq!(seg.height_dev, 8);
        for row in 0..8u32 {
            let off = (row * 4 * 4) as usize;
            assert_eq!(seg.rgba[off], row as u8, "row {row} has wrong value");
        }
    }

    #[test]
    fn build_segments_crops_overlap_without_duplicating_rows() {
        // slice0 covers rows [0,4) (values 0..4). slice1 requested to start
        // at row 2 (overlap of 2 rows) but its own content is rows [2,6)
        // (values 2..6) — after cropping, output should be exactly 0..6
        // with no duplicate/blank rows.
        let slice0 = encode_row_indexed_png(2, 4, 0);
        let slice1 = encode_row_indexed_png(2, 4, 2);
        let slices = vec![
            CapturedSlice {
                actual_scroll_css: 0.0,
                png_bytes: slice0,
            },
            CapturedSlice {
                actual_scroll_css: 2.0,
                png_bytes: slice1,
            },
        ];
        let (stitch_plan, segments) = build_segments(1.0, &slices).unwrap();
        assert_eq!(stitch_plan.canvas_height_dev, 6);
        let seg = &segments[0];
        for row in 0..6u32 {
            let off = (row * 2 * 4) as usize;
            assert_eq!(seg.rgba[off], row as u8, "row {row} has wrong value");
        }
    }

    #[test]
    fn build_segments_rejects_width_mismatch() {
        let slice0 = encode_solid_png(4, 4, [1, 1, 1, 255]);
        let slice1 = encode_solid_png(5, 4, [1, 1, 1, 255]);
        let slices = vec![
            CapturedSlice {
                actual_scroll_css: 0.0,
                png_bytes: slice0,
            },
            CapturedSlice {
                actual_scroll_css: 4.0,
                png_bytes: slice1,
            },
        ];
        let err = build_segments(1.0, &slices).unwrap_err();
        match err {
            StitchError::WidthMismatch {
                slice_index,
                expected,
                actual,
            } => {
                assert_eq!(slice_index, 1);
                assert_eq!(expected, 4);
                assert_eq!(actual, 5);
            }
            other => panic!("expected WidthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn build_segments_splits_tall_output_into_multiple_segments() {
        // A narrow width keeps MAX_CANVAS_DIMENSION_PX (not the area
        // budget) the binding constraint, so one row past it forces a
        // 2-way split while keeping the encoded buffer tiny — the area
        // budget is exercised separately (and much more cheaply, since it
        // doesn't need real pixel data) by plan.rs's split_ranges tests.
        let width = 10u32;
        let height = crate::plan::MAX_CANVAS_DIMENSION_PX + 1;
        let slice0 = encode_row_indexed_png(width, height, 0);
        let slices = vec![CapturedSlice {
            actual_scroll_css: 0.0,
            png_bytes: slice0,
        }];
        let (stitch_plan, segments) = build_segments(1.0, &slices).unwrap();
        assert_eq!(stitch_plan.canvas_height_dev, height);
        assert!(
            segments.len() > 1,
            "expected split into multiple segments, got {}",
            segments.len()
        );
        let total_rows: u32 = segments.iter().map(|s| s.height_dev).sum();
        assert_eq!(total_rows, height);
        // Verify row order is preserved across the segment boundary: last
        // row of segment 0 and first row of segment 1 are adjacent values.
        let seg0_last_off = ((segments[0].height_dev - 1) * width * 4) as usize;
        let seg1_first_off = 0usize;
        assert_eq!(
            segments[0].rgba[seg0_last_off],
            (segments[0].height_dev - 1) as u8
        );
        assert_eq!(
            segments[1].rgba[seg1_first_off],
            segments[0].height_dev as u8
        );
    }
}
