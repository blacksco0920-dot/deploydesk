use crate::model::{ProviderCheck, RegistryConfig};
use crate::providers::{ProviderAdapter, RegistryProviderAdapter};

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
        self.image_pull_reference(image, immutable_tag)
    }

    #[must_use]
    pub fn image_push_reference(&self, image: &str, immutable_tag: &str) -> String {
        format!("{}:{immutable_tag}", self.push_repository(image))
    }

    #[must_use]
    pub fn image_pull_reference(&self, image: &str, immutable_tag: &str) -> String {
        format!("{}:{immutable_tag}", self.pull_repository(image))
    }

    #[must_use]
    pub fn push_repository(&self, image: &str) -> String {
        match self.config {
            RegistryConfig::Cnb { repository } => {
                format!("docker.cnb.cool/{repository}/{image}")
            }
            RegistryConfig::Tcr {
                registry,
                namespace,
            } => format!("{registry}/{namespace}/{image}"),
            RegistryConfig::Oci {
                push_registry,
                namespace,
                ..
            } => format!("{push_registry}/{namespace}/{image}"),
        }
    }

    #[must_use]
    pub fn pull_repository(&self, image: &str) -> String {
        match self.config {
            RegistryConfig::Oci {
                push_registry,
                pull_registry,
                namespace,
                ..
            } => format!(
                "{}/{namespace}/{image}",
                pull_registry.as_deref().unwrap_or(push_registry)
            ),
            _ => self.push_repository(image),
        }
    }

    #[must_use]
    pub fn push_registry(&self) -> &str {
        match self.config {
            RegistryConfig::Cnb { .. } => "docker.cnb.cool",
            RegistryConfig::Tcr { registry, .. } => registry,
            RegistryConfig::Oci { push_registry, .. } => push_registry,
        }
    }

    #[must_use]
    pub fn pull_registry(&self) -> &str {
        match self.config {
            RegistryConfig::Oci {
                push_registry,
                pull_registry,
                ..
            } => pull_registry.as_deref().unwrap_or(push_registry),
            _ => self.push_registry(),
        }
    }

    #[must_use]
    pub fn credential_names(&self) -> (&str, &str) {
        match self.config {
            RegistryConfig::Cnb { .. } => ("CNB_USERNAME", "CNB_TOKEN"),
            RegistryConfig::Tcr { .. } => ("TCR_USERNAME", "TCR_PASSWORD"),
            RegistryConfig::Oci {
                username_variable,
                password_variable,
                ..
            } => (username_variable, password_variable),
        }
    }

    #[must_use]
    pub fn server_credential_names(&self) -> Vec<&str> {
        match self.config {
            RegistryConfig::Cnb { .. } => vec!["CNB_DEPLOY_TOKEN"],
            RegistryConfig::Tcr { .. } => vec!["TCR_USERNAME", "TCR_PASSWORD"],
            RegistryConfig::Oci {
                username_variable,
                password_variable,
                ..
            } => vec![username_variable, password_variable],
        }
    }
}

impl ProviderAdapter for RegistryProvider<'_> {
    fn id(&self) -> &'static str {
        match self.config {
            RegistryConfig::Cnb { .. } => "cnb-registry",
            RegistryConfig::Tcr { .. } => "tcr",
            RegistryConfig::Oci { .. } => "oci-registry",
        }
    }

    fn display_name(&self) -> &'static str {
        match self.config {
            RegistryConfig::Cnb { .. } => "CNB Docker 制品库",
            RegistryConfig::Tcr { .. } => "腾讯云 TCR",
            RegistryConfig::Oci { .. } => "兼容 OCI 镜像仓库",
        }
    }

    fn configuration_check(&self) -> ProviderCheck {
        let valid = match self.config {
            RegistryConfig::Cnb { repository } => repository.contains('/'),
            RegistryConfig::Tcr {
                registry,
                namespace,
            } => !registry.is_empty() && !namespace.is_empty(),
            RegistryConfig::Oci {
                provider,
                push_registry,
                namespace,
                username_variable,
                password_variable,
                ..
            } => {
                !provider.is_empty()
                    && !push_registry.is_empty()
                    && !namespace.is_empty()
                    && !username_variable.is_empty()
                    && !password_variable.is_empty()
            }
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
            code: (!valid).then(|| "AD-REG-101".to_string()),
            next_steps: if valid {
                Vec::new()
            } else {
                vec!["返回镜像仓库设置，补全仓库地址和命名空间".to_string()]
            },
            retryable: !valid,
        }
    }
}

impl RegistryProviderAdapter for RegistryProvider<'_> {
    fn push_registry(&self) -> &str {
        RegistryProvider::push_registry(self)
    }

    fn pull_registry(&self) -> &str {
        RegistryProvider::pull_registry(self)
    }

    fn push_repository(&self, image: &str) -> String {
        RegistryProvider::push_repository(self, image)
    }

    fn pull_repository(&self, image: &str) -> String {
        RegistryProvider::pull_repository(self, image)
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

        let oci = RegistryConfig::Oci {
            provider: "阿里云 ACR".to_string(),
            push_registry: "push.example.com".to_string(),
            pull_registry: Some("pull.internal.example.com".to_string()),
            namespace: "team".to_string(),
            username_variable: "ACR_USERNAME".to_string(),
            password_variable: "ACR_PASSWORD".to_string(),
        };
        let provider = RegistryProvider::new(&oci);
        assert_eq!(
            provider.image_push_reference("api", "sha-abc"),
            "push.example.com/team/api:sha-abc"
        );
        assert_eq!(
            provider.image_pull_reference("api", "sha-abc"),
            "pull.internal.example.com/team/api:sha-abc"
        );
    }
}
