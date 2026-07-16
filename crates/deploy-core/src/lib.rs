pub mod command;
pub mod error;
pub mod health;
pub mod journal;
pub mod manifest;
pub mod model;
pub mod plan;
pub mod preflight;
pub mod providers;
pub mod redact;
pub mod render;
pub mod scanner;

pub use command::system_command;
pub use error::{DeployError, Result};
pub use manifest::{ManifestValidation, load_manifest, parse_manifest, validate_manifest};
pub use model::*;
pub use plan::{
    apply_local_plan, apply_plan, apply_setup_plan, build_plan, create_default_manifest,
    reconcile_detected_services,
};
pub use scanner::inspect_project;

pub const PRODUCT_NAME: &str = "ABCDeploy";
pub const MANIFEST_FILE: &str = "deploy.yaml";
