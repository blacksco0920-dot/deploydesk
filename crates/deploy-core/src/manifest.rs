use std::collections::HashSet;
use std::fs;
use std::path::Path;

use regex::Regex;
use schemars::schema_for;
use serde::{Deserialize, Serialize};

use crate::error::{DeployError, Result};
use crate::model::{
    DiagnosticLevel, EnvironmentName, ProductionMode, ProjectManifest, TargetKind, ValidationIssue,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestValidation {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

pub fn load_manifest(path: &Path) -> Result<ProjectManifest> {
    let raw = fs::read_to_string(path).map_err(|source| DeployError::ReadFile {
        path: path.to_path_buf(),
        source,
    })?;
    parse_manifest(&raw, path)
}

pub fn parse_manifest(raw: &str, source_path: &Path) -> Result<ProjectManifest> {
    serde_yaml_ng::from_str(raw).map_err(|source| DeployError::Yaml {
        path: source_path.to_path_buf(),
        source,
    })
}

pub fn manifest_schema_json() -> Result<String> {
    serde_json::to_string_pretty(&schema_for!(ProjectManifest)).map_err(|source| {
        DeployError::Json {
            path: Path::new("deploy.schema.json").to_path_buf(),
            source,
        }
    })
}

#[must_use]
pub fn validate_manifest(manifest: &ProjectManifest) -> ManifestValidation {
    let mut issues = Vec::new();
    let slug = Regex::new(r"^[a-z0-9][a-z0-9-]{1,62}$").expect("valid slug regex");
    let env_name = Regex::new(r"^[A-Z][A-Z0-9_]*$").expect("valid env regex");
    let repository =
        Regex::new(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+$").expect("valid repository regex");
    let hostname = Regex::new(
        r"^(?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$",
    )
    .expect("valid hostname regex");
    let image_tag =
        Regex::new(r"^[A-Za-z0-9._-]*\{commit\}[A-Za-z0-9._-]*$").expect("valid image tag regex");

    if manifest.version != 1 {
        error(
            &mut issues,
            "unsupported_version",
            "version",
            "当前仅支持 deploy.yaml version: 1",
        );
    }
    if !slug.is_match(&manifest.project.name) {
        error(
            &mut issues,
            "invalid_project_name",
            "project.name",
            "项目名只能包含小写字母、数字和连字符，长度为 2-63",
        );
    }
    if manifest.source.integration_branch == manifest.source.stable_branch {
        error(
            &mut issues,
            "branch_collision",
            "source",
            "集成分支和稳定分支不能相同",
        );
    }
    for (field, branch) in [
        (
            "source.integration_branch",
            &manifest.source.integration_branch,
        ),
        ("source.stable_branch", &manifest.source.stable_branch),
    ] {
        if unsafe_branch(branch) {
            error(
                &mut issues,
                "invalid_branch",
                field,
                "分支名包含 Git 不允许或可能影响流水线的字符",
            );
        }
    }
    if !repository.is_match(&manifest.providers.build.repository) {
        error(
            &mut issues,
            "invalid_build_repository",
            "providers.build.repository",
            "CNB 仓库应填写 owner/repository 格式",
        );
    }
    match &manifest.providers.registry {
        crate::model::RegistryConfig::Cnb { repository: value } => {
            if !repository.is_match(value) {
                error(
                    &mut issues,
                    "invalid_registry_repository",
                    "providers.registry.repository",
                    "CNB 制品库应填写 owner/repository 格式",
                );
            }
        }
        crate::model::RegistryConfig::Tcr {
            registry,
            namespace,
        } => {
            if !hostname.is_match(registry) || !slug.is_match(namespace) {
                error(
                    &mut issues,
                    "invalid_tcr_registry",
                    "providers.registry",
                    "TCR 只填写仓库主机名和小写命名空间",
                );
            }
        }
    }
    if manifest.services.is_empty() {
        error(
            &mut issues,
            "missing_services",
            "services",
            "至少需要声明一个可部署服务",
        );
    }

    let mut service_ids = HashSet::new();
    for (index, service) in manifest.services.iter().enumerate() {
        let field = format!("services[{index}]");
        if !slug.is_match(&service.id) {
            error(
                &mut issues,
                "invalid_service_id",
                &format!("{field}.id"),
                "服务 ID 只能包含小写字母、数字和连字符",
            );
        }
        if !slug.is_match(&service.image) {
            error(
                &mut issues,
                "invalid_image_name",
                &format!("{field}.image"),
                "镜像名只能包含小写字母、数字和连字符",
            );
        }
        if !service_ids.insert(service.id.as_str()) {
            error(
                &mut issues,
                "duplicate_service",
                &format!("{field}.id"),
                "服务 ID 不能重复",
            );
        }
        if service.container_port == 0 {
            error(
                &mut issues,
                "invalid_port",
                &format!("{field}.container_port"),
                "容器端口必须大于 0",
            );
        }
        if unsafe_relative_path(&service.context) || unsafe_relative_path(&service.dockerfile) {
            error(
                &mut issues,
                "unsafe_path",
                &field,
                "构建路径必须位于项目目录内",
            );
        }
        if !service.healthcheck.path.starts_with('/') {
            error(
                &mut issues,
                "invalid_health_path",
                &format!("{field}.healthcheck.path"),
                "健康检查路径必须以 / 开头",
            );
        }
        for variable in &service.runtime_env {
            if !env_name.is_match(&variable.name) {
                error(
                    &mut issues,
                    "invalid_env_name",
                    &format!("{field}.runtime_env.{}", variable.name),
                    "环境变量名格式不正确",
                );
            }
            if variable.secret && variable.default.is_some() {
                error(
                    &mut issues,
                    "secret_default",
                    &format!("{field}.runtime_env.{}", variable.name),
                    "敏感变量只能声明名称，不能在 deploy.yaml 中保存默认值",
                );
            }
        }
        for (key, value) in &service.build_args {
            if !env_name.is_match(key) {
                error(
                    &mut issues,
                    "invalid_build_arg_name",
                    &format!("{field}.build_args.{key}"),
                    "构建参数名必须使用大写环境变量格式",
                );
            }
            if looks_secret(key) && !value.is_empty() {
                error(
                    &mut issues,
                    "secret_build_arg",
                    &format!("{field}.build_args.{key}"),
                    "疑似敏感信息不能作为构建参数写入配置",
                );
            }
        }
    }

    validate_environment(
        &mut issues,
        manifest,
        EnvironmentName::Development,
        &service_ids,
        &hostname,
        &slug,
    );
    validate_environment(
        &mut issues,
        manifest,
        EnvironmentName::Staging,
        &service_ids,
        &hostname,
        &slug,
    );
    validate_environment(
        &mut issues,
        manifest,
        EnvironmentName::Production,
        &service_ids,
        &hostname,
        &slug,
    );

    let staging = &manifest.environments.staging;
    let production = &manifest.environments.production;
    if staging.target.namespace == production.target.namespace {
        error(
            &mut issues,
            "shared_namespace",
            "environments",
            "测试和生产环境必须使用不同的容器命名空间",
        );
    }
    if let (Some(staging_db), Some(production_db)) = (&staging.database, &production.database)
        && staging_db.name == production_db.name
    {
        error(
            &mut issues,
            "shared_database",
            "environments.production.database.name",
            "测试和生产环境不能使用同一个数据库",
        );
    }
    if staging.secrets_ref.is_some() && staging.secrets_ref == production.secrets_ref {
        error(
            &mut issues,
            "shared_secrets",
            "environments.production.secrets_ref",
            "测试和生产环境不能引用同一份密钥文件",
        );
    }
    match manifest.release.production_mode {
        ProductionMode::Automatic if production.approval_required => warning(
            &mut issues,
            "approval_ignored",
            "environments.production.approval_required",
            "生产策略为 automatic，approval_required 将被忽略",
        ),
        ProductionMode::Approval if !production.approval_required => error(
            &mut issues,
            "approval_required",
            "environments.production.approval_required",
            "生产策略为 approval 时必须开启生产审批",
        ),
        _ => {}
    }
    if !image_tag.is_match(&manifest.release.image_tag_template) {
        error(
            &mut issues,
            "mutable_image_tag",
            "release.image_tag_template",
            "镜像标签必须包含 {commit}，不能使用 latest 作为发布依据",
        );
    }
    if manifest.release.keep_releases < 2 {
        error(
            &mut issues,
            "insufficient_history",
            "release.keep_releases",
            "至少保留两个发布版本才能回滚",
        );
    }

    ManifestValidation {
        valid: !issues
            .iter()
            .any(|issue| issue.level == DiagnosticLevel::Error),
        issues,
    }
}

fn validate_environment(
    issues: &mut Vec<ValidationIssue>,
    manifest: &ProjectManifest,
    name: EnvironmentName,
    service_ids: &HashSet<&str>,
    hostname: &Regex,
    slug: &Regex,
) {
    let environment = manifest.environments.get(name);
    let prefix = format!("environments.{}", name.as_str());
    match (&environment.target.kind, name) {
        (TargetKind::Local, EnvironmentName::Development) => {}
        (TargetKind::Server, EnvironmentName::Staging | EnvironmentName::Production) => {
            if environment
                .target
                .server
                .as_deref()
                .unwrap_or_default()
                .is_empty()
            {
                error(
                    issues,
                    "missing_server",
                    &format!("{prefix}.target.server"),
                    "远程环境必须绑定逻辑服务器名称",
                );
            }
            if !slug.is_match(environment.target.server.as_deref().unwrap_or_default()) {
                error(
                    issues,
                    "invalid_server_name",
                    &format!("{prefix}.target.server"),
                    "逻辑服务器名称只能包含小写字母、数字和连字符",
                );
            }
            match environment.secrets_ref.as_deref() {
                Some(reference)
                    if reference.starts_with("https://cnb.cool/")
                        && reference.contains("/-/blob/") =>
                {
                    if reference.contains("replace-me") {
                        warning(
                            issues,
                            "placeholder_secrets",
                            &format!("{prefix}.secrets_ref"),
                            "部署前需要替换为真实的 CNB 密钥文件地址",
                        );
                    }
                }
                _ => error(
                    issues,
                    "invalid_secrets_ref",
                    &format!("{prefix}.secrets_ref"),
                    "远程环境必须引用 https://cnb.cool/.../-/blob/... 格式的密钥文件",
                ),
            }
        }
        _ => error(
            issues,
            "invalid_target_kind",
            &format!("{prefix}.target.kind"),
            "开发环境应为 local，测试和生产环境应为 server",
        ),
    }
    if environment.target.namespace.trim().is_empty() {
        error(
            issues,
            "missing_namespace",
            &format!("{prefix}.target.namespace"),
            "每个环境必须有独立命名空间",
        );
    }
    for route in &environment.domains {
        if !service_ids.contains(route.service.as_str()) {
            error(
                issues,
                "unknown_route_service",
                &format!("{prefix}.domains"),
                "域名路由引用了不存在的服务",
            );
        }
        if !hostname.is_match(&route.host) {
            error(
                issues,
                "invalid_domain",
                &format!("{prefix}.domains.{}", route.host),
                "域名只填写主机名，不要包含协议和路径",
            );
        }
        if !route.path.starts_with('/') || route.path.contains(['\r', '\n']) {
            error(
                issues,
                "invalid_route_path",
                &format!("{prefix}.domains.{}.path", route.host),
                "路由路径必须以 / 开头且只能占一行",
            );
        }
    }
}

fn unsafe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn unsafe_branch(value: &str) -> bool {
    value.is_empty()
        || value.chars().any(char::is_whitespace)
        || value.contains("..")
        || value.contains("@{")
        || value.starts_with(['-', '.', '/'])
        || value.ends_with(['.', '/'])
        || value.to_ascii_lowercase().ends_with(".lock")
        || value.contains(['~', '^', ':', '?', '*', '[', '\\'])
}

fn looks_secret(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["PASSWORD", "TOKEN", "SECRET", "PRIVATE_KEY", "API_KEY"]
        .iter()
        .any(|part| upper.contains(part))
}

fn error(issues: &mut Vec<ValidationIssue>, code: &str, field: &str, message: &str) {
    issues.push(ValidationIssue {
        level: DiagnosticLevel::Error,
        code: code.to_string(),
        field: field.to_string(),
        message: message.to_string(),
    });
}

fn warning(issues: &mut Vec<ValidationIssue>, code: &str, field: &str, message: &str) {
    issues.push(ValidationIssue {
        level: DiagnosticLevel::Warning,
        code: code.to_string(),
        field: field.to_string(),
        message: message.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::create_default_manifest;
    use crate::scanner::inspection_fixture;

    #[test]
    fn default_manifest_is_valid() {
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);
        let validation = validate_manifest(&manifest);
        assert!(validation.valid, "issues: {:?}", validation.issues);
    }

    #[test]
    fn rejects_secret_defaults_and_shared_databases() {
        let report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        manifest.services[0].runtime_env[0].secret = true;
        manifest.services[0].runtime_env[0].default = Some("do-not-store".to_string());
        manifest.environments.production.database = manifest.environments.staging.database.clone();
        let validation = validate_manifest(&manifest);
        assert!(!validation.valid);
        assert!(
            validation
                .issues
                .iter()
                .any(|issue| issue.code == "secret_default")
        );
        assert!(
            validation
                .issues
                .iter()
                .any(|issue| issue.code == "shared_database")
        );
    }

    #[test]
    fn rejects_pipeline_injection_and_unsafe_remote_references() {
        let report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        manifest.release.image_tag_template = "sha-{commit};curl".to_string();
        manifest.providers.build.repository = "owner/repo\necho injected".to_string();
        manifest.environments.staging.secrets_ref = Some("file:///tmp/secrets".to_string());
        manifest
            .environments
            .staging
            .domains
            .push(crate::model::DomainRoute {
                service: "api".to_string(),
                host: "api.example.com\nimport bad".to_string(),
                path: "/".to_string(),
            });

        let validation = validate_manifest(&manifest);
        let codes = validation
            .issues
            .iter()
            .map(|issue| issue.code.as_str())
            .collect::<HashSet<_>>();
        assert!(!validation.valid);
        assert!(codes.contains("mutable_image_tag"));
        assert!(codes.contains("invalid_build_repository"));
        assert!(codes.contains("invalid_secrets_ref"));
        assert!(codes.contains("invalid_domain"));
    }
}
