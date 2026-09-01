pub mod crop;
pub mod encode;
pub mod error;
pub mod pdf;
pub mod plan;
pub mod scale;
pub mod stitch;
pub mod types;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use error::{PlanError, StitchError};
pub use types::{
    CaptureReport, CapturedSlice, EncodedImage, PageMetrics, Placement, SplitRange, StitchPlan,
};
