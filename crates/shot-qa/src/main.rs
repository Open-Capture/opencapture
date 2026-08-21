//! QA CLI for opencapture golden assertions: PNG/PDF structural
//! inspection, sha256 hashing, band-color sampling (for the `ruler-*`
//! stitching test pages), and pixel-diff comparison. Consumed by the
//! Playwright e2e suite via subprocess so all pixel/structure logic stays
//! in one Rust implementation instead of duplicated across JS.

use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "shot-qa",
    about = "Golden-assertion QA tooling for opencapture"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print PNG width/height/color-type/bit-depth/DPI as JSON.
    PngInfo { path: PathBuf },
    /// Print PDF page count and per-page size (pt) as JSON.
    PdfInfo { path: PathBuf },
    /// Print the sha256 hex digest of a file.
    Hash { path: PathBuf },
    /// Sample one pixel per band at (x, band*band_height + y_offset) —
    /// for the ruler-NNNNN.html golden band-color assertion.
    BandSample {
        path: PathBuf,
        #[arg(long)]
        bands: u32,
        #[arg(long, default_value_t = 100)]
        band_height: u32,
        #[arg(long, default_value_t = 50)]
        x: u32,
        #[arg(long, default_value_t = 50)]
        y_offset: u32,
    },
    /// Compare two PNGs pixel-by-pixel; exits non-zero if the diff ratio
    /// exceeds --max-diff-ratio.
    Diff {
        a: PathBuf,
        b: PathBuf,
        /// Per-channel normalized (0..1) difference above which a pixel
        /// counts as different.
        #[arg(long, default_value_t = 0.1)]
        channel_threshold: f64,
        /// Fraction of differing pixels above which the command fails.
        #[arg(long, default_value_t = 0.001)]
        max_diff_ratio: f64,
    },
    /// Exit 0 if `needle` is not found anywhere in the file's raw bytes
    /// (interpreted as a UTF-8 substring search); exit 1 if found.
    AssertAbsent { path: PathBuf, needle: String },
    /// Exit 0 if `needle` is found in the file's raw bytes; exit 1 if not.
    AssertPresent { path: PathBuf, needle: String },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<ExitCode, String> {
    match command {
        Command::PngInfo { path } => png_info(&path),
        Command::PdfInfo { path } => pdf_info(&path),
        Command::Hash { path } => hash(&path),
        Command::BandSample {
            path,
            bands,
            band_height,
            x,
            y_offset,
        } => band_sample(&path, bands, band_height, x, y_offset),
        Command::Diff {
            a,
            b,
            channel_threshold,
            max_diff_ratio,
        } => diff(&a, &b, channel_threshold, max_diff_ratio),
        Command::AssertAbsent { path, needle } => assert_contains(&path, &needle, false),
        Command::AssertPresent { path, needle } => assert_contains(&path, &needle, true),
    }
}

fn read_file(path: &PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))
}

fn png_info(path: &PathBuf) -> Result<ExitCode, String> {
    let bytes = read_file(path)?;
    let decoder = png::Decoder::new(bytes.as_slice());
    let reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    let dpi = info.pixel_dims.map(|d| {
        // xppu/yppu are px per meter when unit == Meter.
        let scale = if d.unit == png::Unit::Meter {
            0.0254
        } else {
            1.0
        };
        (d.xppu as f64 * scale, d.yppu as f64 * scale)
    });
    let out = serde_json::json!({
        "width": info.width,
        "height": info.height,
        "colorType": format!("{:?}", info.color_type),
        "bitDepth": format!("{:?}", info.bit_depth),
        "dpi": dpi,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    Ok(ExitCode::SUCCESS)
}

fn pdf_info(path: &PathBuf) -> Result<ExitCode, String> {
    let doc = lopdf::Document::load(path).map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    let mut page_sizes = Vec::new();
    for id in pages.values() {
        let page = doc
            .get_object(*id)
            .map_err(|e| e.to_string())?
            .as_dict()
            .map_err(|e| e.to_string())?;
        let media_box = page
            .get(b"MediaBox")
            .map_err(|e| e.to_string())?
            .as_array()
            .map_err(|e| e.to_string())?;
        let vals: Vec<f64> = media_box
            .iter()
            .map(|o| {
                o.as_float()
                    .map(|f| f as f64)
                    .or_else(|_| o.as_i64().map(|i| i as f64))
            })
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        page_sizes.push(serde_json::json!({
            "widthPt": vals[2] - vals[0],
            "heightPt": vals[3] - vals[1],
        }));
    }
    let out = serde_json::json!({
        "pageCount": pages.len(),
        "pages": page_sizes,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    Ok(ExitCode::SUCCESS)
}

fn hash(path: &PathBuf) -> Result<ExitCode, String> {
    let bytes = read_file(path)?;
    let digest = Sha256::digest(&bytes);
    println!("{}", hex::encode(digest));
    Ok(ExitCode::SUCCESS)
}

fn band_sample(
    path: &PathBuf,
    bands: u32,
    band_height: u32,
    x: u32,
    y_offset: u32,
) -> Result<ExitCode, String> {
    let bytes = read_file(path)?;
    let decoded = shot_core::stitch::decode_png_rgba(&bytes)?;
    let mut samples = Vec::with_capacity(bands as usize);
    for band in 0..bands {
        let y = band * band_height + y_offset;
        if y >= decoded.height || x >= decoded.width {
            return Err(format!(
                "band {band} sample point ({x},{y}) is outside the {}x{} image",
                decoded.width, decoded.height
            ));
        }
        let off = ((y * decoded.width + x) * 4) as usize;
        let px = &decoded.rgba[off..off + 4];
        samples.push(
            serde_json::json!({ "band": band, "r": px[0], "g": px[1], "b": px[2], "a": px[3] }),
        );
    }
    println!("{}", serde_json::to_string_pretty(&samples).unwrap());
    Ok(ExitCode::SUCCESS)
}

fn diff(
    a: &PathBuf,
    b: &PathBuf,
    channel_threshold: f64,
    max_diff_ratio: f64,
) -> Result<ExitCode, String> {
    let bytes_a = read_file(a)?;
    let bytes_b = read_file(b)?;
    let img_a = shot_core::stitch::decode_png_rgba(&bytes_a)?;
    let img_b = shot_core::stitch::decode_png_rgba(&bytes_b)?;

    if img_a.width != img_b.width || img_a.height != img_b.height {
        let out = serde_json::json!({
            "sizeMismatch": true,
            "a": {"width": img_a.width, "height": img_a.height},
            "b": {"width": img_b.width, "height": img_b.height},
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        return Ok(ExitCode::FAILURE);
    }

    let total_pixels = (img_a.width as u64) * (img_a.height as u64);
    let channel_limit = (channel_threshold.clamp(0.0, 1.0) * 255.0) as i32;
    let mut diff_pixels: u64 = 0;
    for (pa, pb) in img_a
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .zip(img_b.rgba.as_chunks::<4>().0)
    {
        let differs = (0..4).any(|i| (pa[i] as i32 - pb[i] as i32).abs() > channel_limit);
        if differs {
            diff_pixels += 1;
        }
    }
    let diff_ratio = diff_pixels as f64 / total_pixels as f64;
    let passed = diff_ratio <= max_diff_ratio;

    let out = serde_json::json!({
        "width": img_a.width,
        "height": img_a.height,
        "totalPixels": total_pixels,
        "diffPixels": diff_pixels,
        "diffRatio": diff_ratio,
        "maxDiffRatio": max_diff_ratio,
        "passed": passed,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    Ok(if passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn assert_contains(path: &PathBuf, needle: &str, expect_present: bool) -> Result<ExitCode, String> {
    let bytes = read_file(path)?;
    let found = find_subslice(&bytes, needle.as_bytes());
    let ok = found == expect_present;
    let out = serde_json::json!({ "needle": needle, "found": found, "expected": expect_present, "passed": ok });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    Ok(if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return needle.is_empty();
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}
