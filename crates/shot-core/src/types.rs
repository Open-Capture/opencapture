use serde::{Deserialize, Serialize};

/// Page geometry captured once during the prep phase, before any scrolling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageMetrics {
    pub viewport_width_css: f64,
    pub viewport_height_css: f64,
    pub total_height_css: f64,
    pub dpr: f64,
}

/// One captured slice as the content script reports it: the scroll
/// position the browser actually settled at (not the one requested — see
/// `plan::place_slices`), plus the PNG bytes returned by
/// `chrome.tabs.captureVisibleTab`.
pub struct CapturedSlice {
    pub actual_scroll_css: f64,
    pub png_bytes: Vec<u8>,
}

/// A resolved placement of one slice's rows into the output canvas, in
/// device pixels. Produced by `plan::place_slices`, consumed by `stitch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub slice_index: usize,
    pub crop_top_dev: u32,
    pub canvas_y_dev: u32,
    pub rows_dev: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StitchPlan {
    pub placements: Vec<Placement>,
    pub canvas_width_dev: u32,
    pub canvas_height_dev: u32,
}

/// A half-open device-pixel row range `[start, end)` of the full stitched
/// canvas, emitted when the canvas exceeds Chrome's per-canvas size limits
/// and must be split into multiple output images.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRange {
    pub start_dev: u32,
    pub end_dev: u32,
}

impl SplitRange {
    pub fn height(&self) -> u32 {
        self.end_dev - self.start_dev
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodedImage {
    pub width_dev: u32,
    pub height_dev: u32,
    pub png_bytes: Vec<u8>,
}

/// Machine-readable summary returned to the extension UI after every
/// capture. Also the primary golden-assertion surface for the QA harness.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaptureReport {
    pub css_width: f64,
    pub css_height: f64,
    pub dpr: f64,
    pub slice_count: usize,
    pub output_width_px: u32,
    pub output_height_px: u32,
    pub output_image_count: usize,
    pub lazy_images_forced: u32,
    pub pinned_elements_handled: u32,
    pub aborted: bool,
    pub warnings: Vec<String>,
}
