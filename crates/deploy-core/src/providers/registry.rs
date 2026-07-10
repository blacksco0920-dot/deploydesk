use crate::model::{ProviderCheck, RegistryConfig};
use crate::providers::ProviderAdapter;

pub struct RegistryProvider<'a> {
    config: &'a RegistryConfig,
}

impl<'a> RegistryProvider<'a> {
    #[must_use]
    pub const fn new(config: &'a RegistryConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub fn image_reference(&self, image: &str, immutable_tag: &str) -> String {
        match self.config {
            RegistryConfig::Cnb { repository } => {
                format!("docker.cnb.cool/{repository}/{image}:{immutable_tag}")
            }
            RegistryConfig::Tcr {
                registry,
                namespace,
            } => format!("{registry}/{namespace}/{image}:{immutable_tag}"),
        }
    }

    #[must_use]
    pub fn server_credential_names(&self) -> Vec<&'static str> {
        match self.config {
            RegistryConfig::Cnb { .. } => vec!["CNB_DEPLOY_TOKEN"],
            RegistryConfig::Tcr { .. } => vec!["TCR_USERNAME", "TCR_PASSWORD"],
        }
    }
}

impl ProviderAdapter for RegistryProvider<'_> {
    fn id(&self) -> &'static str {
        match self.config {
            RegistryConfig::Cnb { .. } => "cnb-registry",
            RegistryConfig::Tcr { .. } => "tcr",
        }
    }

    fn display_name(&self) -> &'static str {
        match self.config {
            RegistryConfig::Cnb { .. } => "CNB Docker 制品库",
            RegistryConfig::Tcr { .. } => "腾讯云 TCR",
        }
    }

    fn configuration_check(&self) -> ProviderCheck {
        let valid = match self.config {
            RegistryConfig::Cnb { repository } => repository.contains('/'),
            RegistryConfig::Tcr {
                registry,
                namespace,
            } => !registry.is_empty() && !namespace.is_empty(),
        };
        ProviderCheck {
            provider: self.id().to_string(),
            ok: valid,
            summary: if valid {
                "镜像路径配置完整".to_string()
            } else {
                "镜像仓库配置不完整".to_string()
            },
            details: self
                .server_credential_names()
                .into_iter()
                .map(|name| format!("服务器拉取凭据: {name}"))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_cnb_and_tcr_references() {
        let cnb = RegistryConfig::Cnb {
            repository: "owner/repo".to_string(),
        };
        assert_eq!(
            RegistryProvider::new(&cnb).image_reference("api", "sha-abc"),
            "docker.cnb.cool/owner/repo/api:sha-abc"
        );
        let tcr = RegistryConfig::Tcr {
            registry: "ccr.example.com".to_string(),
            namespace: "team".to_string(),
        };
        assert_eq!(
            RegistryProvider::new(&tcr).image_reference("api", "sha-abc"),
            "ccr.example.com/team/api:sha-abc"
        );
    }
}
