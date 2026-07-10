pub mod caddy;
pub mod cnb;
pub mod docker;
pub mod registry;
pub mod ssh;

use crate::model::ProviderCheck;

pub trait ProviderAdapter {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn configuration_check(&self) -> ProviderCheck;
}
