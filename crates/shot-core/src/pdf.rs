//! Multi-page PDF export: one page per [`crate::types::EncodedImage`]
//! (already split to fit output-image size limits by
//! [`crate::stitch::build_segments`]), each page sized in points to match
//! the image's CSS pixel dimensions so the PDF prints at 1:1 physical size.

use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref};

use crate::error::StitchError;
use crate::types::EncodedImage;

const POINTS_PER_CSS_PX: f32 = 72.0 / 96.0;

pub fn build_pdf(images: &[EncodedImage], dpr: f64) -> Result<Vec<u8>, StitchError> {
    if images.is_empty() {
        return Err(StitchError::Encode("no images to export".into()));
    }

    let mut pdf = Pdf::new();
    let mut alloc = Ref::new(1);
    let mut next_id = || {
        let id = alloc;
        alloc = Ref::new(alloc.get() + 1);
        id
    };

    let catalog_id = next_id();
    let page_tree_id = next_id();

    struct PageIds {
        page_id: Ref,
        image_id: Ref,
        content_id: Ref,
    }

    let page_ids: Vec<PageIds> = images
        .iter()
        .map(|_| PageIds {
            page_id: next_id(),
            image_id: next_id(),
            content_id: next_id(),
        })
        .collect();

    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id)
        .kids(page_ids.iter().map(|p| p.page_id))
        .count(page_ids.len() as i32);

    for (img, ids) in images.iter().zip(page_ids.iter()) {
        let decoded = crate::stitch::decode_png_rgba(&img.png_bytes).map_err(|message| {
            StitchError::Encode(format!("re-decoding PNG for PDF export: {message}"))
        })?;

        // Screenshots are always fully opaque; drop the alpha channel
        // rather than emitting an SMask nobody needs.
        let mut rgb = Vec::with_capacity(decoded.rgba.len() / 4 * 3);
        for px in decoded.rgba.as_chunks::<4>().0 {
            rgb.extend_from_slice(&px[..3]);
        }

        let compressed = deflate(&rgb);
        let mut image_xobject = pdf.image_xobject(ids.image_id, &compressed);
        image_xobject.filter(Filter::FlateDecode);
        image_xobject.width(decoded.width as i32);
        image_xobject.height(decoded.height as i32);
        image_xobject.color_space().device_rgb();
        image_xobject.bits_per_component(8);
        image_xobject.finish();

        let width_pt = (img.width_dev as f64 / dpr) as f32 * POINTS_PER_CSS_PX;
        let height_pt = (img.height_dev as f64 / dpr) as f32 * POINTS_PER_CSS_PX;

        let image_name = Name(b"Im0");
        let mut content = Content::new();
        content.save_state();
        content.transform([width_pt, 0.0, 0.0, height_pt, 0.0, 0.0]);
        content.x_object(image_name);
        content.restore_state();
        pdf.stream(ids.content_id, &content.finish());

        let mut page = pdf.page(ids.page_id);
        page.media_box(Rect::new(0.0, 0.0, width_pt, height_pt));
        page.parent(page_tree_id);
        page.contents(ids.content_id);
        page.resources().x_objects().pair(image_name, ids.image_id);
        page.finish();
    }

    Ok(pdf.finish())
}

fn deflate(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder
        .write_all(data)
        .expect("in-memory write cannot fail");
    encoder.finish().expect("in-memory finish cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_solid_png(width: u32, height: u32, rgba: [u8; 4]) -> EncodedImage {
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
        EncodedImage {
            width_dev: width,
            height_dev: height,
            png_bytes: buf,
        }
    }

    #[test]
    fn build_pdf_single_page_has_correct_page_count() {
        let img = encode_solid_png(200, 100, [10, 20, 30, 255]);
        let bytes = build_pdf(&[img], 1.0).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let doc = lopdf_load(&bytes);
        assert_eq!(doc.get_pages().len(), 1);
    }

    #[test]
    fn build_pdf_multi_page_matches_image_count_and_sizes() {
        let img1 = encode_solid_png(400, 200, [1, 1, 1, 255]);
        let img2 = encode_solid_png(400, 300, [2, 2, 2, 255]);
        let bytes = build_pdf(&[img1, img2], 2.0).unwrap();
        let doc = lopdf_load(&bytes);
        let pages = doc.get_pages();
        assert_eq!(pages.len(), 2);

        // At dpr 2.0: page 1 is 400x200 device px -> 200x100 css px -> pt =
        // css * 0.75 -> 150x75pt. page 2: 400x300 dev -> 200x150 css -> 150x112.5pt.
        let mut sizes: Vec<(f64, f64)> = pages
            .values()
            .map(|&id| {
                let page = doc.get_object(id).unwrap().as_dict().unwrap();
                let media_box = page.get(b"MediaBox").unwrap().as_array().unwrap();
                let w = media_box[2].as_float().unwrap() as f64;
                let h = media_box[3].as_float().unwrap() as f64;
                (w, h)
            })
            .collect();
        sizes.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        assert!((sizes[0].0 - 150.0).abs() < 0.5);
        assert!((sizes[0].1 - 75.0).abs() < 0.5);
        assert!((sizes[1].1 - 112.5).abs() < 0.5);
    }

    #[test]
    fn build_pdf_rejects_empty_input() {
        assert!(build_pdf(&[], 1.0).is_err());
    }

    fn lopdf_load(bytes: &[u8]) -> lopdf::Document {
        lopdf::Document::load_mem(bytes).expect("lopdf must be able to parse our own PDF output")
    }
}
