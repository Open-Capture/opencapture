//! wasm-bindgen surface consumed by the extension's service worker. Kept
//! deliberately thin: every function here just marshals JS values to/from
//! the pure functions in [`crate::plan`], [`crate::stitch`],
//! [`crate::encode`], and [`crate::pdf`] — no logic lives here that isn't
//! already covered by those modules' native tests.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::types::{CaptureReport, CapturedSlice, EncodedImage};

fn to_js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Scroll positions (CSS px) the content script should visit to cover the
/// full page height, given the viewport height and total page height
/// measured during the prep phase.
#[wasm_bindgen(js_name = scrollTargets)]
pub fn scroll_targets_js(
    total_height_css: f64,
    viewport_height_css: f64,
) -> Result<Vec<f64>, JsValue> {
    crate::plan::scroll_targets(total_height_css, viewport_height_css).map_err(to_js_err)
}

/// Crops a single captured PNG to a device-pixel rectangle and re-encodes
/// it — the whole of selected-area capture (one slice, no stitching plan
/// needed). Coordinates are clamped to the source image, not rejected, so
/// a selection drag that ends slightly past the viewport edge still works.
///
/// `out_width`/`out_height` are optional. Supplied, the crop is resampled to
/// exactly that size, which is what lets a user who needs a 640x360 image
/// drag a roughly-right rectangle at whatever size suits the page and still
/// get 640x360 out. Omitted, the crop keeps its natural device-pixel size.
/// Both must be given together — one on its own is ambiguous about whether
/// the other should follow the aspect ratio or stay put, so it is rejected
/// rather than guessed at.
#[wasm_bindgen(js_name = cropAndEncode)]
#[allow(clippy::too_many_arguments)]
pub fn crop_and_encode(
    png_bytes: &[u8],
    x_dev: u32,
    y_dev: u32,
    width_dev: u32,
    height_dev: u32,
    dpr: f64,
    out_width: Option<u32>,
    out_height: Option<u32>,
) -> Result<js_sys::Uint8Array, JsValue> {
    let decoded = crate::stitch::decode_png_rgba(png_bytes)
        .map_err(|message| to_js_err(format!("decoding capture for crop: {message}")))?;
    let rect = crate::crop::CropRect {
        x_dev,
        y_dev,
        width_dev,
        height_dev,
    };
    let cropped = crate::crop::crop_rgba(&decoded.rgba, decoded.width, decoded.height, rect)
        .map_err(to_js_err)?;
    let sized = match (out_width, out_height) {
        (Some(w), Some(h)) => {
            crate::scale::scale_rgba(&cropped.rgba, cropped.width, cropped.height, w, h)
                .map_err(to_js_err)?
        }
        (None, None) => cropped,
        _ => {
            return Err(to_js_err(
                "output width and height must be given together".to_string(),
            ))
        }
    };
    let segment = crate::stitch::Segment {
        width_dev: sized.width,
        height_dev: sized.height,
        rgba: sized.rgba,
    };
    let encoded = crate::encode::encode_png(&segment, dpr).map_err(to_js_err)?;
    Ok(js_sys::Uint8Array::from(encoded.png_bytes.as_slice()))
}

/// Builds a single-page PDF from one already-encoded PNG (e.g. the
/// editor's current canvas after crop/annotation) — the single-image
/// counterpart to `imagesToPdf` below. `dpr` must match the image's
/// device-pixel ratio so the PDF page prints at the correct physical size
/// (see `pdf::build_pdf`).
#[wasm_bindgen(js_name = pngToPdf)]
pub fn png_to_pdf(png_bytes: &[u8], dpr: f64) -> Result<js_sys::Uint8Array, JsValue> {
    let decoded = crate::stitch::decode_png_rgba(png_bytes)
        .map_err(|message| to_js_err(format!("decoding image for PDF export: {message}")))?;
    let image = EncodedImage {
        width_dev: decoded.width,
        height_dev: decoded.height,
        png_bytes: png_bytes.to_vec(),
    };
    let bytes = crate::pdf::build_pdf(std::slice::from_ref(&image), dpr).map_err(to_js_err)?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

/// Builds a multi-page PDF from already-encoded PNGs — the stateless
/// counterpart to the old `CaptureSession::exportPdf` (removed): a
/// `CaptureSession` is a live wasm object that can't survive the
/// background service worker being evicted (MV3 suspends it after ~30s
/// idle), so "export the last capture as PDF" has to be rebuildable from
/// plain persisted bytes instead of a still-alive session. `images` is a
/// JS array of `Uint8Array`s, one per already-stitched output PNG (in the
/// common case, just one).
#[wasm_bindgen(js_name = imagesToPdf)]
pub fn images_to_pdf(images: js_sys::Array, dpr: f64) -> Result<js_sys::Uint8Array, JsValue> {
    let mut decoded_images = Vec::with_capacity(images.length() as usize);
    for value in images.iter() {
        let bytes = js_sys::Uint8Array::new(&value).to_vec();
        let decoded = crate::stitch::decode_png_rgba(&bytes)
            .map_err(|message| to_js_err(format!("decoding image for PDF export: {message}")))?;
        decoded_images.push(EncodedImage {
            width_dev: decoded.width,
            height_dev: decoded.height,
            png_bytes: bytes,
        });
    }
    let bytes = crate::pdf::build_pdf(&decoded_images, dpr).map_err(to_js_err)?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FinishOptions {
    lazy_images_forced: u32,
    pinned_elements_handled: u32,
    warnings: Vec<String>,
}

/// Accumulates captured slice PNGs for one capture session, then stitches
/// and encodes them on `finish()`. One `CaptureSession` per capture — not
/// reused across captures.
#[wasm_bindgen]
pub struct CaptureSession {
    dpr: f64,
    slices: Vec<CapturedSlice>,
}

#[wasm_bindgen]
impl CaptureSession {
    #[wasm_bindgen(constructor)]
    pub fn new(dpr: f64) -> CaptureSession {
        console_error_panic_hook::set_once();
        CaptureSession {
            dpr,
            slices: Vec::new(),
        }
    }

    /// Record one captured slice. `actual_scroll_css` is
    /// `window.scrollY` read back *after* scrolling settled — not the
    /// requested target — since that's what makes stitching robust to
    /// clamped/sub-pixel scroll positions (see `plan::place_slices`).
    #[wasm_bindgen(js_name = pushSlice)]
    pub fn push_slice(&mut self, actual_scroll_css: f64, png_bytes: &[u8]) {
        self.slices.push(CapturedSlice {
            actual_scroll_css,
            png_bytes: png_bytes.to_vec(),
        });
    }

    #[wasm_bindgen(js_name = sliceCount)]
    pub fn slice_count(&self) -> usize {
        self.slices.len()
    }

    /// Stitches and encodes all pushed slices. `options_json` carries
    /// content-script-side counters (`lazyImagesForced`,
    /// `pinnedElementsHandled`, `warnings`) that only the DOM side can know.
    /// Returns `{ report, images: Uint8Array[] }` — PDF export (see
    /// `imagesToPdf` above) runs on those returned bytes directly rather
    /// than on `self`, so it works even after this session object itself
    /// is gone (e.g. the background service worker got evicted).
    pub fn finish(&mut self, options_json: &str) -> Result<JsValue, JsValue> {
        let options: FinishOptions = serde_json::from_str(options_json).map_err(to_js_err)?;

        let (stitch_plan, segments) =
            crate::stitch::build_segments(self.dpr, &self.slices).map_err(to_js_err)?;
        let images = crate::encode::encode_segments(&segments, self.dpr).map_err(to_js_err)?;

        let report = CaptureReport {
            css_width: stitch_plan.canvas_width_dev as f64 / self.dpr,
            css_height: stitch_plan.canvas_height_dev as f64 / self.dpr,
            dpr: self.dpr,
            slice_count: self.slices.len(),
            output_width_px: stitch_plan.canvas_width_dev,
            output_height_px: stitch_plan.canvas_height_dev,
            output_image_count: images.len(),
            lazy_images_forced: options.lazy_images_forced,
            pinned_elements_handled: options.pinned_elements_handled,
            aborted: false,
            warnings: options.warnings,
        };

        let out = js_sys::Object::new();
        let report_js = serde_wasm_bindgen::to_value(&report).map_err(to_js_err)?;
        js_sys::Reflect::set(&out, &JsValue::from_str("report"), &report_js)?;

        let images_arr = js_sys::Array::new();
        for img in &images {
            images_arr.push(&js_sys::Uint8Array::from(img.png_bytes.as_slice()));
        }
        js_sys::Reflect::set(&out, &JsValue::from_str("images"), &images_arr)?;

        Ok(out.into())
    }
}
