use crate::model::ProviderCheck;
use crate::providers::{PipelineProviderAdapter, ProviderAdapter};

pub struct CnbPipelineProvider;

impl ProviderAdapter for CnbPipelineProvider {
    fn id(&self) -> &'static str {
        "cnb-pipeline"
    }

    fn display_name(&self) -> &'static str {
        "CNB 云原生构建"
    }

    fn configuration_check(&self) -> ProviderCheck {
        ProviderCheck {
            provider: self.id().to_string(),
            ok: true,
            summary: "CNB 流水线适配器可用".to_string(),
            details: vec!["支持自动测试部署、桌面确认和 CNB 原生 Tag 部署".to_string()],
            code: None,
            next_steps: Vec::new(),
            retryable: false,
        }
    }
}

impl PipelineProviderAdapter for CnbPipelineProvider {
    fn staging_event(&self) -> &'static str {
        "api_trigger_staging"
    }

    fn production_event(&self) -> &'static str {
        "api_trigger_production"
    }

    fn native_staging_event(&self) -> &'static str {
        "tag_deploy.staging"
    }

    fn native_production_event(&self) -> &'static str {
        "tag_deploy.production"
    }

    fn deployment_config_path(&self) -> &'static str {
        ".cnb/tag_deploy.yml"
    }
}
