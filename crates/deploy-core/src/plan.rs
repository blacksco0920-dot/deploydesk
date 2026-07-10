use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::error::{DeployError, Result};
use crate::manifest::validate_manifest;
use crate::model::{
    BuildProviderConfig, BuildProviderKind, DatabaseBinding, DeploymentPlan, DiagnosticLevel,
    DomainRoute, EnvironmentConfig, EnvironmentName, EnvironmentPlanSummary, EnvironmentSet,
    EnvironmentVariable, FileChange, FileChangeKind, HealthcheckConfig, InspectionReport,
    MigrationConfig, PlanStep, ProductionMode, ProjectCommands, ProjectConfig, ProjectManifest,
    ProviderConfig, RegistryConfig, ReleasePolicy, ReverseProxyProvider, ServiceConfig,
    ServiceKind, SourceConfig, SourceProvider, StepExecutor, TargetConfig, TargetKind, UserAction,
    UserActionCategory,
};
use crate::redact::redact_text;
use crate::render::render_project_files;

#[must_use]
pub fn create_default_manifest(report: &InspectionReport) -> ProjectManifest {
    let database_prefix = report.project_name.replace('-', "_");
    let prisma_schema = report.prisma_schemas.first().cloned();
    let uses_database = prisma_schema.is_some()
        || report
            .environment_variables
            .iter()
            .any(|variable| variable.name == "DATABASE_URL");
    let uses_redis = report
        .environment_variables
        .iter()
        .any(|variable| variable.name == "REDIS_URL");
    let services = report
        .services
        .iter()
        .map(|service| {
            let health_path = match service.kind {
                ServiceKind::Api => "/api/health",
                ServiceKind::Web | ServiceKind::Static => "/",
                ServiceKind::Worker => "/health",
            };
            let dockerfile = service.dockerfile.clone().unwrap_or_else(|| {
                if service.path == "." {
                    "Dockerfile".to_string()
                } else {
                    format!("{}/Dockerfile", service.path)
                }
            });
            ServiceConfig {
                id: service.id.clone(),
                kind: service.kind.clone(),
                image: format!("{}-{}", report.project_name, service.id),
                context: if report.monorepo {
                    ".".to_string()
                } else {
                    service.path.clone()
                },
                dockerfile,
                container_port: service.suggested_port,
                healthcheck: HealthcheckConfig {
                    path: health_path.to_string(),
                    ..HealthcheckConfig::default()
                },
                migration: if service.kind == ServiceKind::Api {
                    prisma_schema.as_ref().map(|schema| MigrationConfig {
                        command: format!(
                            "corepack pnpm exec prisma migrate deploy --schema {schema}"
                        ),
                        backup_required: true,
                    })
                } else {
                    None
                },
                runtime_env: environment_variables_for_service(report, service),
                build_args: BTreeMap::new(),
            }
        })
        .collect();

    ProjectManifest {
        version: 1,
        project: ProjectConfig {
            name: report.project_name.clone(),
            description: String::new(),
            commands: ProjectCommands::default(),
        },
        source: SourceConfig {
            provider: SourceProvider::Github,
            repository: format!("owner/{}", report.project_name),
            release_branch: "main".to_string(),
            integration_branch: String::new(),
            stable_branch: String::new(),
        },
        services,
        environments: EnvironmentSet {
            development: EnvironmentConfig {
                target: TargetConfig {
                    kind: TargetKind::Local,
                    server: None,
                    namespace: format!("{}-development", report.project_name),
                },
                branch: None,
                auto_deploy: false,
                approval_required: false,
                domains: Vec::new(),
                database: uses_database.then(|| DatabaseBinding {
                    name: format!("{database_prefix}_development"),
                    user: format!("{database_prefix}_development_user"),
                }),
                redis_namespace: uses_redis
                    .then(|| format!("{}:development:", report.project_name)),
                secrets_ref: Some("local-keychain://development".to_string()),
            },
            staging: EnvironmentConfig {
                target: TargetConfig {
                    kind: TargetKind::Server,
                    server: Some("staging-server".to_string()),
                    namespace: format!("{}-staging", report.project_name),
                },
                branch: None,
                auto_deploy: true,
                approval_required: false,
                domains: Vec::<DomainRoute>::new(),
                database: uses_database.then(|| DatabaseBinding {
                    name: format!("{database_prefix}_staging"),
                    user: format!("{database_prefix}_staging_user"),
                }),
                redis_namespace: uses_redis.then(|| format!("{}:staging:", report.project_name)),
                secrets_ref: Some(
                    "https://cnb.cool/replace-me/secret/-/blob/main/env.staging.yml".to_string(),
                ),
            },
            production: EnvironmentConfig {
                target: TargetConfig {
                    kind: TargetKind::Server,
                    server: Some("production-server".to_string()),
                    namespace: format!("{}-production", report.project_name),
                },
                branch: None,
                auto_deploy: false,
                approval_required: true,
                domains: Vec::<DomainRoute>::new(),
                database: uses_database.then(|| DatabaseBinding {
                    name: format!("{database_prefix}_production"),
                    user: format!("{database_prefix}_production_user"),
                }),
                redis_namespace: uses_redis.then(|| format!("{}:production:", report.project_name)),
                secrets_ref: Some(
                    "https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml".to_string(),
                ),
            },
        },
        providers: ProviderConfig {
            build: BuildProviderConfig {
                kind: BuildProviderKind::Cnb,
                repository: format!("owner/{}", report.project_name),
            },
            registry: RegistryConfig::Cnb {
                repository: format!("owner/{}", report.project_name),
            },
            reverse_proxy: ReverseProxyProvider::Caddy,
        },
        release: ReleasePolicy {
            production_mode: ProductionMode::Approval,
            ..ReleasePolicy::default()
        },
    }
}

fn environment_variables_for_service(
    report: &InspectionReport,
    service: &crate::model::DetectedService,
) -> Vec<EnvironmentVariable> {
    report
        .environment_variables
        .iter()
        .filter(|variable| {
            let source_is_scoped = service.path != "."
                && (variable.source == format!("{}/.env.example", service.path)
                    || variable.source.starts_with(&format!("{}/", service.path)));
            match service.kind {
                ServiceKind::Api | ServiceKind::Worker => {
                    source_is_scoped || !is_frontend_public_variable(&variable.name)
                }
                ServiceKind::Web | ServiceKind::Static => {
                    !variable.secret
                        && (source_is_scoped || is_frontend_public_variable(&variable.name))
                }
            }
        })
        .map(|variable| EnvironmentVariable {
            name: variable.name.clone(),
            required: true,
            secret: variable.secret,
            default: None,
            description: String::new(),
        })
        .collect()
}

fn is_frontend_public_variable(name: &str) -> bool {
    [
        "VITE_",
        "NEXT_PUBLIC_",
        "NUXT_PUBLIC_",
        "TARO_APP_",
        "VUE_APP_",
        "PUBLIC_",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

pub fn serialize_manifest(manifest: &ProjectManifest) -> Result<String> {
    let mut content = serde_yaml_ng::to_string(manifest).map_err(|source| DeployError::Yaml {
        path: "deploy.yaml".into(),
        source,
    })?;
    content.insert_str(
        0,
        "# DeployDesk 项目部署协议。这里只声明变量名，不保存真实密钥。\n",
    );
    Ok(content)
}

pub fn build_plan(
    root: &Path,
    report: &InspectionReport,
    manifest: &ProjectManifest,
) -> Result<DeploymentPlan> {
    let validation = validate_manifest(manifest);
    if !validation.valid {
        let message = validation
            .issues
            .iter()
            .filter(|issue| issue.level == DiagnosticLevel::Error)
            .map(|issue| format!("{}: {}", issue.field, issue.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(DeployError::InvalidManifest(message));
    }
    let manifest_content = serialize_manifest(manifest)?;
    let mut generated = render_project_files(manifest)?;
    generated.push(crate::render::GeneratedFile {
        path: "deploy.yaml".to_string(),
        content: manifest_content.clone(),
    });
    generated.sort_by(|left, right| left.path.cmp(&right.path));

    let mut hasher = Sha256::new();
    hasher.update(manifest_content.as_bytes());
    hasher.update(serde_json::to_vec(report).unwrap_or_default());
    let plan_id = format!("{:x}", hasher.finalize())[..16].to_string();

    let mut changes = Vec::new();
    for file in generated {
        ensure_safe_relative_path(&file.path)?;
        let path = root.join(&file.path);
        let before = fs::read_to_string(&path).ok();
        let kind = match &before {
            None => FileChangeKind::Create,
            Some(existing) if normalize_newline(existing) == normalize_newline(&file.content) => {
                FileChangeKind::Unchanged
            }
            Some(_) => FileChangeKind::Update,
        };
        changes.push(FileChange {
            path: file.path,
            kind,
            before: before.map(|content| redact_text(&content)),
            after: redact_text(&file.content),
            sensitive: false,
        });
    }

    let environments = manifest
        .environments
        .entries()
        .into_iter()
        .map(|(name, environment)| EnvironmentPlanSummary {
            name,
            branch: environment.branch.clone(),
            target: environment
                .target
                .server
                .clone()
                .unwrap_or_else(|| "本机".to_string()),
            automatic: environment.auto_deploy,
            approval_required: environment.approval_required,
        })
        .collect();

    let mut user_actions = Vec::new();
    if manifest.providers.build.repository.starts_with("owner/") {
        user_actions.push(UserAction {
            id: "connect-cnb".to_string(),
            title: "连接 CNB".to_string(),
            detail: "授权后由 DeployDesk 创建或选择云原生构建仓库".to_string(),
            category: UserActionCategory::Authorization,
            required: true,
        });
    }
    for name in [EnvironmentName::Staging, EnvironmentName::Production] {
        let environment = manifest.environments.get(name);
        user_actions.push(UserAction {
            id: format!("server-{}", name.as_str()),
            title: format!("连接{}服务器", name.display_name()),
            detail: format!(
                "验证逻辑服务器 {} 的 SSH 登录",
                environment.target.server.as_deref().unwrap_or("未配置")
            ),
            category: UserActionCategory::Server,
            required: true,
        });
        if environment.domains.is_empty() {
            user_actions.push(UserAction {
                id: format!("domain-{}", name.as_str()),
                title: format!("填写{}域名", name.display_name()),
                detail: "DeployDesk 会生成 DNS 记录并持续检查解析状态".to_string(),
                category: UserActionCategory::Dns,
                required: name == EnvironmentName::Production,
            });
        }
        user_actions.push(UserAction {
            id: format!("secrets-{}", name.as_str()),
            title: format!("配置{}密钥文件", name.display_name()),
            detail: format!(
                "按 .deploydesk/generated/{}/secret.example.yml 在 CNB Web 端填写",
                name.as_str(),
            ),
            category: UserActionCategory::Secret,
            required: true,
        });
    }
    if manifest.release.production_mode == ProductionMode::Approval {
        user_actions.push(UserAction {
            id: "approve-production".to_string(),
            title: "确认发布生产".to_string(),
            detail: "生产只拉取已在测试环境通过健康检查的同一镜像摘要".to_string(),
            category: UserActionCategory::Approval,
            required: true,
        });
    }

    let steps = vec![
        PlanStep {
            id: "write-config".to_string(),
            title: "生成部署配置".to_string(),
            detail: "写入 deploy.yaml、Compose、Caddy 和流水线配置".to_string(),
            executor: StepExecutor::Local,
            destructive: false,
        },
        PlanStep {
            id: "verify-build".to_string(),
            title: "验证并构建程序".to_string(),
            detail: "在 CNB 标准 Linux 环境执行项目验证命令".to_string(),
            executor: StepExecutor::Cnb,
            destructive: false,
        },
        PlanStep {
            id: "publish-images".to_string(),
            title: "制作不可变镜像".to_string(),
            detail: "镜像以提交版本标识，不使用 latest 作为发布依据".to_string(),
            executor: StepExecutor::Cnb,
            destructive: false,
        },
        PlanStep {
            id: "prepare-server".to_string(),
            title: "准备隔离运行环境".to_string(),
            detail: "创建环境独立网络、目录、数据库和运行配置".to_string(),
            executor: StepExecutor::Server,
            destructive: false,
        },
        PlanStep {
            id: "deploy".to_string(),
            title: "部署并验证测试候选".to_string(),
            detail: "同步配置，按摘要启动容器并等待健康检查".to_string(),
            executor: StepExecutor::Server,
            destructive: false,
        },
        PlanStep {
            id: "promote-release".to_string(),
            title: "晋级已验证镜像".to_string(),
            detail: "为通过测试的摘要创建提交唯一的验证标记".to_string(),
            executor: StepExecutor::Cnb,
            destructive: false,
        },
        PlanStep {
            id: "healthcheck".to_string(),
            title: "部署生产并验证访问".to_string(),
            detail: "生产复用同一摘要；失败时恢复上一个健康版本".to_string(),
            executor: StepExecutor::Server,
            destructive: false,
        },
    ];

    let warnings = report
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.level != DiagnosticLevel::Info)
        .map(|diagnostic| diagnostic.message.clone())
        .collect();

    Ok(DeploymentPlan {
        id: plan_id,
        project: manifest.project.name.clone(),
        generated_at: Utc::now(),
        environments,
        changes,
        steps,
        user_actions,
        warnings,
    })
}

pub fn apply_plan(root: &Path, plan: &DeploymentPlan) -> Result<Vec<String>> {
    if !root.is_dir() {
        return Err(DeployError::MissingProject(root.to_path_buf()));
    }
    let backup_root = root.join(".deploydesk/backups").join(&plan.id);
    let mut written = Vec::new();
    for change in &plan.changes {
        if change.kind == FileChangeKind::Unchanged {
            continue;
        }
        ensure_safe_relative_path(&change.path)?;
        if change.sensitive {
            return Err(DeployError::SecretLeak(change.path.clone()));
        }
        let destination = root.join(&change.path);
        if destination.exists() {
            let backup = backup_root.join(&change.path);
            if let Some(parent) = backup.parent() {
                fs::create_dir_all(parent).map_err(|source| DeployError::WriteFile {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
            fs::copy(&destination, &backup).map_err(|source| DeployError::WriteFile {
                path: backup,
                source,
            })?;
        }
        atomic_write(&destination, change.after.as_bytes())?;
        written.push(change.path.clone());
    }
    let state_path = root.join(".deploydesk/state/last-plan.json");
    let state = serde_json::to_vec_pretty(plan).map_err(|source| DeployError::Json {
        path: state_path.clone(),
        source,
    })?;
    atomic_write(&state_path, &state)?;
    Ok(written)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| DeployError::WriteFile {
        path: parent.to_path_buf(),
        source,
    })?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|source| DeployError::WriteFile {
            path: path.to_path_buf(),
            source,
        })?;
    temporary
        .write_all(contents)
        .map_err(|source| DeployError::WriteFile {
            path: path.to_path_buf(),
            source,
        })?;
    temporary
        .persist(path)
        .map_err(|error| DeployError::WriteFile {
            path: path.to_path_buf(),
            source: error.error,
        })?;
    Ok(())
}

fn ensure_safe_relative_path(value: &str) -> Result<()> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(DeployError::InvalidManifest(format!(
            "计划包含不安全路径: {value}"
        )));
    }
    Ok(())
}

fn normalize_newline(value: &str) -> String {
    value.replace("\r\n", "\n")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::scanner::inspection_fixture;

    #[test]
    fn plan_is_previewable_and_apply_creates_backups() {
        let directory = tempdir().expect("tempdir");
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);
        fs::write(directory.path().join(".cnb.yml"), "old: true\n").expect("old config");
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        assert!(
            plan.changes
                .iter()
                .any(|change| change.path == ".cnb.yml" && change.kind == FileChangeKind::Update)
        );
        assert!(
            plan.user_actions
                .iter()
                .any(|action| action.id == "approve-production")
        );
        let written = apply_plan(directory.path(), &plan).expect("apply");
        assert!(written.contains(&"deploy.yaml".to_string()));
        assert!(
            directory
                .path()
                .join(".deploydesk/backups")
                .join(&plan.id)
                .join(".cnb.yml")
                .exists()
        );
    }

    #[test]
    fn only_adds_database_and_redis_when_the_project_uses_them() {
        let mut report = inspection_fixture();
        report.prisma_schemas.clear();
        report.environment_variables.clear();
        let manifest = create_default_manifest(&report);

        for (_, environment) in manifest.environments.entries() {
            assert!(environment.database.is_none());
            assert!(environment.redis_namespace.is_none());
        }
        assert!(manifest.services[0].migration.is_none());
    }
}
