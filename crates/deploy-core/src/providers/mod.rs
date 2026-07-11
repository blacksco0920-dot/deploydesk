pub mod caddy;
pub mod cnb;
pub mod docker;
pub mod pipeline;
pub mod registry;
pub mod ssh;

use crate::model::ProviderCheck;

pub trait ProviderAdapter {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn configuration_check(&self) -> ProviderCheck;
}

pub trait PipelineProviderAdapter: ProviderAdapter {
    fn staging_event(&self) -> &'static str;
    fn production_event(&self) -> &'static str;
    fn native_staging_event(&self) -> &'static str;
    fn native_production_event(&self) -> &'static str;
    fn deployment_config_path(&self) -> &'static str;
}

pub trait RegistryProviderAdapter: ProviderAdapter {
    fn push_registry(&self) -> &str;
    fn pull_registry(&self) -> &str;
    fn push_repository(&self, image: &str) -> String;
    fn pull_repository(&self, image: &str) -> String;
}

pub trait RuntimeProviderAdapter: ProviderAdapter {}
pub trait SecretProviderAdapter: ProviderAdapter {}
pub trait DnsProviderAdapter: ProviderAdapter {}
pub trait ApprovalProviderAdapter: ProviderAdapter {}
