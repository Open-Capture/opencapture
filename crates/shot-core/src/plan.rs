//! Pure geometry: no image bytes, no browser types. Two responsibilities:
//!
//! 1. [`scroll_targets`] — what scroll positions the content script should
//!    *request*, computed once from page metrics.
//! 2. [`place_slices`] — where each captured slice's rows actually land in
//!    the output canvas, computed from what the browser *actually* reported
//!    scrolling to (which may differ from the request at the last slice, or
//!    under sub-pixel/scroll-snap interference).
//!
//! `place_slices` never leaves a gap: each slice is chained directly onto
//! the bottom of the previous one, cropping its top rows if the reported
//! scroll position implies overlap. This is a deliberate simplification —
//! see the module docs on `crop_top` below — that trades "trust the
//! requested position" for "the output is always a contiguous tiling",
//! which is the invariant proptest checks below.

use crate::error::PlanError;
use crate::types::{Placement, StitchPlan};

/// Round CSS pixels to the nearest device pixel at the given DPR.
pub fn to_device_px(css_px: f64, dpr: f64) -> u32 {
    (css_px * dpr).round().max(0.0) as u32
}

/// Scroll positions (in CSS px, measured from the top) the content script
/// should visit to cover the full page height with the given viewport
/// height. Always starts at 0.0; the last target is clamped so the final
/// viewport-sized capture doesn't scroll past the bottom of the page.
pub fn scroll_targets(
    total_height_css: f64,
    viewport_height_css: f64,
) -> Result<Vec<f64>, PlanError> {
    if !viewport_height_css.is_finite() || viewport_height_css <= 0.0 {
        return Err(PlanError::InvalidViewport);
    }
    if !total_height_css.is_finite() || total_height_css < 0.0 {
        return Err(PlanError::InvalidTotalHeight);
    }

    if total_height_css <= viewport_height_css {
        return Ok(vec![0.0]);
    }

    let max_scroll = total_height_css - viewport_height_css;
    let mut targets = Vec::new();
    let mut y = 0.0_f64;
    // Bound the loop independently of float step accumulation: the page
    // cannot need more slices than its height divided by viewport height,
    // plus a small margin for the final clamp.
    let max_slices = (total_height_css / viewport_height_css).ceil() as usize + 2;

    for _ in 0..max_slices {
        targets.push(y);
        if y >= max_scroll {
            break;
        }
        y = (y + viewport_height_css).min(max_scroll);
    }

    if *targets.last().unwrap() < max_scroll {
        targets.push(max_scroll);
    }

    Ok(targets)
}

/// One captured slice's reported scroll position and the device-pixel
/// height of its bitmap (normally constant per session — the viewport
/// height times the DPR, rounded — but read from the actual decoded bitmap
/// so a mid-session anomaly is visible in the data rather than assumed
/// away).
#[derive(Debug, Clone, Copy)]
pub struct SliceObservation {
    pub actual_scroll_css: f64,
    pub bitmap_height_dev: u32,
    pub bitmap_width_dev: u32,
}

/// Resolve where each slice's rows land in the output canvas. See module
/// docs for the chaining rule. Width is taken from the first observation;
/// callers are expected to have already verified all slices share the same
/// width (a mismatch mid-session means the page resized, which is an abort
/// condition upstream, not something this function silently repairs).
pub fn place_slices(dpr: f64, observations: &[SliceObservation]) -> Result<StitchPlan, PlanError> {
    if !dpr.is_finite() || dpr <= 0.0 {
        return Err(PlanError::InvalidDpr);
    }
    if observations.is_empty() {
        return Err(PlanError::NoObservations);
    }
    for (i, obs) in observations.iter().enumerate() {
        if obs.bitmap_height_dev == 0 {
            return Err(PlanError::InvalidBitmapHeight { slice_index: i });
        }
    }

    let canvas_width_dev = observations[0].bitmap_width_dev;
    let mut placements = Vec::with_capacity(observations.len());
    let mut canvas_bottom_dev: u32 = 0;

    let last_index = observations.len() - 1;

    for (i, obs) in observations.iter().enumerate() {
        let y_dev = to_device_px(obs.actual_scroll_css, dpr);
        let crop_top_dev = canvas_bottom_dev
            .saturating_sub(y_dev)
            .min(obs.bitmap_height_dev);
        let rows_dev = obs.bitmap_height_dev - crop_top_dev;

        if i == last_index {
            // The final slice is painted whole, over the tail it shares with
            // the one before it, ending exactly where the canvas ends.
            //
            // Its own new rows are usually very few: the last scroll position
            // is clamped to the bottom of the page, so it repeats almost all
            // of the previous slice. That is fine for page content, which is
            // identical in both — but not for anything shown only on this
            // slice. A dock pinned to the bottom of the window is drawn once,
            // here, and cropping this slice to its new rows clipped it to
            // whatever those few rows happened to cover: measured on a real
            // page, 28 rows of a 1440-row panel.
            //
            // Painting it whole costs nothing (the overlap is the same
            // pixels) and lets a bottom-pinned element arrive intact.
            let final_height = canvas_bottom_dev + rows_dev;
            placements.push(Placement {
                slice_index: i,
                crop_top_dev: 0,
                canvas_y_dev: final_height.saturating_sub(obs.bitmap_height_dev),
                rows_dev: obs.bitmap_height_dev,
            });
            canvas_bottom_dev = final_height;
            continue;
        }

        if rows_dev == 0 {
            // Fully redundant slice (duplicate scroll position, or a
            // rounding coincidence) — contributes nothing, but is kept out
            // of `placements` rather than recorded as a zero-height entry
            // so downstream consumers never see a no-op placement.
            continue;
        }

        placements.push(Placement {
            slice_index: i,
            crop_top_dev,
            canvas_y_dev: canvas_bottom_dev,
            rows_dev,
        });
        canvas_bottom_dev += rows_dev;
    }

    Ok(StitchPlan {
        placements,
        canvas_width_dev,
        canvas_height_dev: canvas_bottom_dev,
    })
}

/// Chrome's real 2D canvas limits (verified, not estimated): 32,767px on
/// any single dimension, and a hard area ceiling of 268,435,456px
/// (2^28) — exceeding either makes the canvas silently unusable (draw
/// calls become no-ops). Set with a safety margin below both: this value
/// also bounds the editor's on-screen `<canvas>` (a real DOM element,
/// genuinely subject to these limits), not just the in-memory RGBA
/// buffers this module computes for.
pub const MAX_CANVAS_DIMENSION_PX: u32 = 30_000;
/// Segment-area budget: bounds how large a single in-memory RGBA buffer
/// `stitch::build_segments` will ever materialize (`area * 4` bytes) and
/// the editor's on-screen canvas pixel count, with a safety margin below
/// Chrome's real 268,435,456px area ceiling (100M px -> 400MB RGBA worst
/// case, comfortable for a one-shot background-service-worker task).
/// Previously set far more conservatively (24M), which made this — not
/// `MAX_CANVAS_DIMENSION_PX` — the binding constraint for ordinary-length
/// pages at 2x+ device pixel ratio, splitting normal single-page captures
/// into multiple PNGs unnecessarily.
pub const MAX_CANVAS_AREA_PX: u64 = 100_000_000;

/// Split `[0, total_height_dev)` into contiguous row ranges, each within
/// Chrome's canvas dimension and area limits for the given width. Used both
/// for auto-splitting PNG exports and for paginating the PDF export.
pub fn split_ranges(total_height_dev: u32, width_dev: u32) -> Vec<crate::types::SplitRange> {
    use crate::types::SplitRange;

    if total_height_dev == 0 || width_dev == 0 {
        return Vec::new();
    }

    let max_height_by_area = (MAX_CANVAS_AREA_PX / width_dev as u64).max(1) as u32;
    let segment_height = MAX_CANVAS_DIMENSION_PX.min(max_height_by_area).max(1);

    let mut ranges = Vec::new();
    let mut start = 0_u32;
    while start < total_height_dev {
        let end = (start + segment_height).min(total_height_dev);
        ranges.push(SplitRange {
            start_dev: start,
            end_dev: end,
        });
        start = end;
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn scroll_targets_short_page_is_single_slice() {
        let targets = scroll_targets(500.0, 900.0).unwrap();
        assert_eq!(targets, vec![0.0]);
    }

    #[test]
    fn scroll_targets_exact_multiple() {
        let targets = scroll_targets(1800.0, 900.0).unwrap();
        assert_eq!(targets, vec![0.0, 900.0]);
    }

    #[test]
    fn scroll_targets_rejects_bad_input() {
        assert_eq!(scroll_targets(100.0, 0.0), Err(PlanError::InvalidViewport));
        assert_eq!(
            scroll_targets(-1.0, 100.0),
            Err(PlanError::InvalidTotalHeight)
        );
        assert_eq!(
            scroll_targets(f64::NAN, 100.0),
            Err(PlanError::InvalidTotalHeight)
        );
    }

    #[test]
    fn place_slices_simple_contiguous() {
        let obs = [
            SliceObservation {
                actual_scroll_css: 0.0,
                bitmap_height_dev: 1800,
                bitmap_width_dev: 2560,
            },
            SliceObservation {
                actual_scroll_css: 900.0,
                bitmap_height_dev: 1800,
                bitmap_width_dev: 2560,
            },
        ];
        let plan = place_slices(2.0, &obs).unwrap();
        assert_eq!(plan.canvas_height_dev, 3600);
        assert_eq!(plan.placements.len(), 2);
        assert_eq!(plan.placements[0].canvas_y_dev, 0);
        assert_eq!(plan.placements[0].crop_top_dev, 0);
        assert_eq!(plan.placements[1].canvas_y_dev, 1800);
        assert_eq!(plan.placements[1].crop_top_dev, 0);
    }

    #[test]
    fn place_slices_crops_overlap_on_clamped_last_slice() {
        // Page is 1300 CSS px tall, viewport 900 -> scroll_targets gives
        // [0.0, 400.0] (clamped). At dpr 1: slice 0 covers device rows
        // [0,900), slice 1 requested 400 -> naive placement would start at
        // 400 and overlap [400,900) with slice 0. Expect it cropped so the
        // canvas stays contiguous with no duplicated rows.
        let obs = [
            SliceObservation {
                actual_scroll_css: 0.0,
                bitmap_height_dev: 900,
                bitmap_width_dev: 1280,
            },
            SliceObservation {
                actual_scroll_css: 400.0,
                bitmap_height_dev: 900,
                bitmap_width_dev: 1280,
            },
        ];
        let plan = place_slices(1.0, &obs).unwrap();
        // The canvas is the same height it always was: the last slice adds its
        // 400 new rows and nothing more.
        assert_eq!(plan.canvas_height_dev, 1300);
        // But it is painted whole, over the 500 rows it shares with the slice
        // before it, so anything drawn only on this slice — a dock pinned to
        // the bottom of the window — arrives intact instead of clipped to the
        // new rows. The shared rows are the same pixels either way.
        assert_eq!(plan.placements[1].crop_top_dev, 0);
        assert_eq!(plan.placements[1].canvas_y_dev, 400);
        assert_eq!(plan.placements[1].rows_dev, 900);
        // And it still ends exactly at the bottom of the canvas.
        assert_eq!(
            plan.placements[1].canvas_y_dev + plan.placements[1].rows_dev,
            plan.canvas_height_dev
        );
    }

    #[test]
    fn place_slices_drops_fully_redundant_duplicate_slice() {
        let obs = [
            SliceObservation {
                actual_scroll_css: 0.0,
                bitmap_height_dev: 900,
                bitmap_width_dev: 1280,
            },
            SliceObservation {
                actual_scroll_css: 0.0,
                bitmap_height_dev: 900,
                bitmap_width_dev: 1280,
            },
        ];
        let plan = place_slices(1.0, &obs).unwrap();
        // A duplicate final slice adds no rows, so the canvas is unchanged —
        // but it is still painted, entirely over the first, because it is the
        // one carrying whatever is shown only on the last slice.
        assert_eq!(plan.canvas_height_dev, 900);
        let last = plan.placements.last().unwrap();
        assert_eq!(last.canvas_y_dev, 0);
        assert_eq!(last.rows_dev, 900);
    }

    #[test]
    fn place_slices_rejects_bad_input() {
        assert_eq!(place_slices(0.0, &[]), Err(PlanError::InvalidDpr));
        assert_eq!(place_slices(1.0, &[]), Err(PlanError::NoObservations));
        let bad = [SliceObservation {
            actual_scroll_css: 0.0,
            bitmap_height_dev: 0,
            bitmap_width_dev: 100,
        }];
        assert_eq!(
            place_slices(1.0, &bad),
            Err(PlanError::InvalidBitmapHeight { slice_index: 0 })
        );
    }

    #[test]
    fn split_ranges_within_budget_is_one_range() {
        let ranges = split_ranges(3600, 2560);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start_dev, 0);
        assert_eq!(ranges[0].end_dev, 3600);
    }

    #[test]
    fn split_ranges_splits_tall_canvas() {
        let ranges = split_ranges(100_000, 2560);
        assert!(ranges.len() > 1);
        // contiguous, no gap/overlap, covers exactly [0, total)
        assert_eq!(ranges[0].start_dev, 0);
        for w in ranges.windows(2) {
            assert_eq!(w[0].end_dev, w[1].start_dev);
        }
        assert_eq!(ranges.last().unwrap().end_dev, 100_000);
        for r in &ranges {
            assert!(r.height() <= MAX_CANVAS_DIMENSION_PX);
            assert!((r.height() as u64) * (2560_u64) <= MAX_CANVAS_AREA_PX);
        }
    }

    proptest! {
        #[test]
        fn prop_scroll_targets_cover_page(
            total in 0.0f64..200_000.0,
            viewport in 1.0f64..5000.0,
        ) {
            let targets = scroll_targets(total, viewport).unwrap();
            prop_assert!(!targets.is_empty());
            prop_assert_eq!(targets[0], 0.0);
            // strictly increasing (no duplicate/backwards targets)
            for w in targets.windows(2) {
                prop_assert!(w[1] > w[0]);
            }
            // every target stays within [0, total]; last slice + viewport
            // reaches (or exceeds, for a short page) the bottom.
            for &t in &targets {
                prop_assert!(t >= 0.0);
                prop_assert!(t <= total + 1e-6);
            }
            let last = *targets.last().unwrap();
            prop_assert!(last + viewport >= total - 1e-6);
            // no step skips content: consecutive targets are at most one
            // viewport-height apart.
            for w in targets.windows(2) {
                prop_assert!(w[1] - w[0] <= viewport + 1e-6);
            }
        }

        #[test]
        fn prop_place_slices_tiles_with_no_gap_or_overlap(
            dpr in prop_oneof![Just(1.0), Just(1.25), Just(1.5), Just(2.0), Just(3.0)],
            n in 1usize..30,
            viewport_css in 400.0f64..2000.0,
            noise in prop::collection::vec(-3.0f64..3.0, 0..30),
        ) {
            let bitmap_h = to_device_px(viewport_css, dpr).max(1);
            let mut obs = Vec::with_capacity(n);
            for i in 0..n {
                let base = i as f64 * viewport_css;
                let jitter = noise.get(i).copied().unwrap_or(0.0);
                obs.push(SliceObservation {
                    actual_scroll_css: (base + jitter).max(0.0),
                    bitmap_height_dev: bitmap_h,
                    bitmap_width_dev: 1280,
                });
            }
            let plan = place_slices(dpr, &obs).unwrap();

            // Every row of the canvas is painted by something, and the
            // placements reach the bottom exactly.
            //
            // Not "no overlap" any more: the final slice is painted whole,
            // over the tail it shares with the one before it, so that anything
            // drawn only on that slice arrives intact. Gaps are still
            // forbidden — a gap is a missing strip of page.
            let (last, rest) = plan.placements.split_last().unwrap();
            let mut expected_y = 0u32;
            for p in rest {
                prop_assert_eq!(p.canvas_y_dev, expected_y);
                prop_assert!(p.rows_dev > 0);
                expected_y += p.rows_dev;
            }
            // The last one may start earlier than where the others left off,
            // but never later — that would leave a gap.
            prop_assert!(last.canvas_y_dev <= expected_y);
            prop_assert_eq!(last.canvas_y_dev + last.rows_dev, plan.canvas_height_dev);

            // Every placement's crop stays within the source bitmap.
            for p in &plan.placements {
                prop_assert!(p.crop_top_dev + p.rows_dev <= bitmap_h);
            }
        }

        #[test]
        fn prop_split_ranges_tile_exactly(
            total in 0u32..500_000,
            width in 1u32..5000,
        ) {
            let ranges = split_ranges(total, width);
            if total == 0 {
                prop_assert!(ranges.is_empty());
            } else {
                prop_assert_eq!(ranges[0].start_dev, 0);
                prop_assert_eq!(ranges.last().unwrap().end_dev, total);
                for w in ranges.windows(2) {
                    prop_assert_eq!(w[0].end_dev, w[1].start_dev);
                }
                for r in &ranges {
                    prop_assert!(r.end_dev > r.start_dev);
                    prop_assert!(r.height() <= MAX_CANVAS_DIMENSION_PX);
                    prop_assert!((r.height() as u64) * (width as u64) <= MAX_CANVAS_AREA_PX);
                }
            }
        }
    }
}
