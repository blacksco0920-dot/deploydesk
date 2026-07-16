use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::error::{DeployError, Result};
use crate::manifest::validate_manifest;
use crate::model::{
    ApprovalProviderConfig, BuildProviderConfig, BuildProviderKind, DatabaseBinding,
    DeploymentPlan, DiagnosticLevel, DnsProviderConfig, DomainRoute, EnvironmentConfig,
    EnvironmentName, EnvironmentPlanSummary, EnvironmentSet, EnvironmentVariable, FileChange,
    FileChangeKind, Framework, HealthcheckConfig, InspectionReport, MigrationConfig,
    PackageManager, PlanBlocker, PlanStep, ProductionMode, ProjectCommands, ProjectConfig,
    ProjectManifest, ProviderConfig, RegistryConfig, ReleasePolicy, ReverseProxyProvider,
    RuntimeProviderConfig, SecretProviderConfig, ServiceConfig, ServiceKind, SourceConfig,
    SourceProvider, StepExecutor, TargetConfig, TargetKind, UserAction, UserActionCategory,
};
use crate::redact::redact_text;
use crate::render::render_project_files;

#[must_use]
pub fn create_default_manifest(report: &InspectionReport) -> ProjectManifest {
    let database_prefix = report.project_name.replace('-', "_");
    let prisma_schema = report.prisma_schemas.first().cloned();
    let mut verify_commands = report
        .prisma_schemas
        .iter()
        .map(|schema| prisma_generate_command(schema))
        .collect::<Vec<_>>();
    if report
        .services
        .iter()
        .any(|service| service.framework == Framework::NodeJs)
    {
        for command in report
            .services
            .iter()
            .filter_map(|service| service.build_command.clone())
        {
            if !verify_commands.contains(&command) {
                verify_commands.push(command);
            }
        }
    } else {
        verify_commands.push("corepack pnpm build".to_string());
    }
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
            let health_path = match (service.kind.clone(), service.framework) {
                (ServiceKind::Api, Framework::FastApi) | (ServiceKind::Worker, _) => "/health",
                (ServiceKind::Api, _) => "/api/health",
                (ServiceKind::Web | ServiceKind::Static, _) => "/",
            };
            let dockerfile = service.dockerfile.clone().unwrap_or_else(|| {
                format!(".deploydesk/generated/build/Dockerfile.{}", service.id)
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
                dockerfile: dockerfile.clone(),
                container_port: service.suggested_port,
                healthcheck: HealthcheckConfig {
                    path: health_path.to_string(),
                    command: if service.framework == Framework::FastApi {
                        Some(format!(
                            "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:{}{health_path}', timeout=4)\"",
                            service.suggested_port
                        ))
                    } else if dockerfile
                        .starts_with(".deploydesk/generated/build/Dockerfile.")
                        && matches!(
                            service.framework,
                            Framework::Vite | Framework::Taro | Framework::UniApp
                        )
                    {
                        Some(generated_static_health_command(
                            service.suggested_port,
                            health_path,
                        ))
                    } else {
                        None
                    },
                    ..HealthcheckConfig::default()
                },
                migration: if service.framework == Framework::NestJs {
                    prisma_schema.as_ref().map(|schema| MigrationConfig {
                        command: prisma_migrate_command(schema),
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
            commands: ProjectCommands {
                install: project_install_command(report),
                verify: verify_commands,
            },
        },
        source: SourceConfig {
            provider: SourceProvider::Cnb,
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
            runtime: RuntimeProviderConfig::SshDockerCompose,
            secrets: SecretProviderConfig::CnbSecretRepository,
            approval: ApprovalProviderConfig::CnbDeployment,
            dns: DnsProviderConfig::Manual,
            reverse_proxy: ReverseProxyProvider::Caddy,
        },
        release: ReleasePolicy {
            production_mode: ProductionMode::Approval,
            ..ReleasePolicy::default()
        },
    }
}

fn prisma_generate_command(schema: &str) -> String {
    let schema_path = Path::new(schema);
    let package_directory = schema_path
        .parent()
        .filter(|directory| directory.file_name().is_some_and(|name| name == "prisma"))
        .and_then(Path::parent)
        .filter(|directory| !directory.as_os_str().is_empty());
    if let Some(package_directory) = package_directory {
        let package_schema = schema_path
            .strip_prefix(package_directory)
            .unwrap_or(schema_path);
        format!(
            "corepack pnpm --dir {} exec prisma generate --schema {}",
            shell_command_argument(&package_directory.to_string_lossy()),
            shell_command_argument(&package_schema.to_string_lossy())
        )
    } else {
        format!(
            "corepack pnpm exec prisma generate --schema {}",
            shell_command_argument(schema)
        )
    }
}

fn prisma_migrate_command(schema: &str) -> String {
    format!(
        "./node_modules/.bin/prisma migrate deploy --schema {}",
        shell_command_argument(schema)
    )
}

fn shell_command_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
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
            if service.framework == Framework::NodeJs {
                return service.path == "."
                    || source_is_scoped
                    || !is_frontend_public_variable(&variable.name);
            }
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
        "# ABCDeploy 项目部署协议。这里只声明变量名，不保存真实密钥。\n",
    );
    Ok(content)
}

pub fn reconcile_detected_services(
    report: &InspectionReport,
    manifest: &mut ProjectManifest,
) -> Vec<String> {
    let defaults = create_default_manifest(report);
    if (manifest.source.repository.starts_with("owner/")
        || manifest.source.repository.contains("replace-me"))
        && manifest.providers.build.repository.contains('/')
        && !manifest.providers.build.repository.starts_with("owner/")
        && !manifest.providers.build.repository.contains("replace-me")
    {
        manifest
            .source
            .repository
            .clone_from(&manifest.providers.build.repository);
    }
    for schema in report.prisma_schemas.iter().rev() {
        let command = prisma_generate_command(schema);
        let legacy_command = format!(
            "corepack pnpm exec prisma generate --schema {}",
            shell_command_argument(schema)
        );
        if let Some(existing) = manifest
            .project
            .commands
            .verify
            .iter_mut()
            .find(|existing| **existing == legacy_command)
        {
            *existing = command;
        } else if !manifest
            .project
            .commands
            .verify
            .iter()
            .any(|existing| existing == &command || existing.contains(schema))
        {
            manifest.project.commands.verify.insert(0, command);
        }
    }
    for service in &mut manifest.services {
        let Some(migration) = &mut service.migration else {
            continue;
        };
        for schema in &report.prisma_schemas {
            let legacy = format!("corepack pnpm exec prisma migrate deploy --schema {schema}");
            if migration.command == legacy {
                migration.command = prisma_migrate_command(schema);
                break;
            }
        }
    }
    let mut added = Vec::new();
    for detected in &report.services {
        if let Some(existing) = manifest.services.iter_mut().find(|service| {
            service.id == detected.id
                || detected
                    .dockerfile
                    .as_ref()
                    .is_some_and(|dockerfile| &service.dockerfile == dockerfile)
        }) {
            let legacy_port = legacy_framework_port(detected.framework);
            if existing.container_port == legacy_port && detected.suggested_port != legacy_port {
                existing.container_port = detected.suggested_port;
            }
            if existing
                .dockerfile
                .starts_with(".deploydesk/generated/build/Dockerfile.")
                && matches!(
                    detected.framework,
                    Framework::Vite | Framework::Taro | Framework::UniApp
                )
            {
                existing.healthcheck.command = Some(generated_static_health_command(
                    existing.container_port,
                    &existing.healthcheck.path,
                ));
            }
            continue;
        }
        if detected.confidence < 95 {
            continue;
        }
        let Some(service) = defaults
            .services
            .iter()
            .find(|service| service.id == detected.id)
        else {
            continue;
        };
        manifest.services.push(service.clone());
        added.push(service.id.clone());
    }
    added
}

const fn legacy_framework_port(framework: Framework) -> u16 {
    match framework {
        Framework::NodeJs
        | Framework::NestJs
        | Framework::NextJs
        | Framework::Prisma
        | Framework::PnpmWorkspace => 3000,
        Framework::FastApi => 8000,
        Framework::Vite | Framework::UniApp | Framework::Taro => 80,
    }
}

fn project_install_command(report: &InspectionReport) -> String {
    let root = Path::new(&report.project_root);
    match report.package_manager {
        PackageManager::Pnpm if root.join("pnpm-lock.yaml").is_file() => {
            "corepack pnpm install --frozen-lockfile".to_string()
        }
        PackageManager::Pnpm => "corepack pnpm install".to_string(),
        PackageManager::Npm if root.join("package-lock.json").is_file() => "npm ci".to_string(),
        PackageManager::Npm | PackageManager::Unknown => "npm install".to_string(),
        PackageManager::Yarn if root.join("yarn.lock").is_file() => {
            "corepack yarn install --frozen-lockfile".to_string()
        }
        PackageManager::Yarn => "corepack yarn install".to_string(),
        PackageManager::Bun
            if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() =>
        {
            "npm install --global bun && bun install --frozen-lockfile".to_string()
        }
        PackageManager::Bun => "npm install --global bun && bun install".to_string(),
    }
}

fn generated_static_health_command(port: u16, path: &str) -> String {
    format!("wget -Y off -q --spider http://127.0.0.1:{port}{path}")
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
    generated.extend(render_standard_dockerfiles(report, manifest));
    let dockerignore_path = root.join(".dockerignore");
    let dockerignore_is_managed = !dockerignore_path.exists()
        || fs::read_to_string(&dockerignore_path)
            .is_ok_and(|content| content.starts_with(STANDARD_DOCKERIGNORE_HEADER));
    if dockerignore_is_managed {
        generated.push(crate::render::GeneratedFile {
            path: ".dockerignore".to_string(),
            content: standard_dockerignore(),
        });
    }
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
            detail: "授权后由 ABCDeploy 创建或选择云原生构建仓库".to_string(),
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
                detail: "ABCDeploy 会生成 DNS 记录并持续检查解析状态".to_string(),
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
        .collect::<Vec<_>>();
    let mut blockers = Vec::new();
    for service in &manifest.services {
        if !root.join(&service.dockerfile).is_file()
            && !generated_dockerfile_supported(report, service)
        {
            blockers.push(PlanBlocker {
                code: "AD-CTR-101".to_string(),
                title: format!("{} 还没有可靠的容器构建方式", service.id),
                detail: "系统没有找到项目现有 Dockerfile，也不能根据当前技术栈高置信生成。"
                    .to_string(),
                service: Some(service.id.clone()),
                resolution: "让项目编程 AI 补充生产可用的 Dockerfile，然后重新识别项目。"
                    .to_string(),
            });
        }
    }

    Ok(DeploymentPlan {
        id: plan_id,
        project: manifest.project.name.clone(),
        generated_at: Utc::now(),
        environments,
        changes,
        steps,
        user_actions,
        blockers,
        warnings,
    })
}

fn render_standard_dockerfiles(
    report: &InspectionReport,
    manifest: &ProjectManifest,
) -> Vec<crate::render::GeneratedFile> {
    manifest
        .services
        .iter()
        .filter_map(|service| {
            let detected = report
                .services
                .iter()
                .find(|candidate| candidate.id == service.id)?;
            if !service
                .dockerfile
                .starts_with(".deploydesk/generated/build/Dockerfile.")
            {
                return None;
            }
            let content = standard_dockerfile(report, detected, service)?;
            Some(crate::render::GeneratedFile {
                path: service.dockerfile.clone(),
                content,
            })
        })
        .collect()
}

const STANDARD_DOCKERIGNORE_HEADER: &str =
    "# 由 ABCDeploy 生成，减少构建上下文并阻止本地密钥进入镜像。\n";

fn standard_dockerignore() -> String {
    format!(
        "{STANDARD_DOCKERIGNORE_HEADER}{}",
        concat!(
            ".git\n",
            "**/.git\n",
            "node_modules\n",
            "**/node_modules\n",
            "dist\n",
            "**/dist\n",
            ".next\n",
            "**/.next\n",
            ".nuxt\n",
            "**/.nuxt\n",
            "coverage\n",
            "**/coverage\n",
            ".deploydesk/generated\n",
            ".deploydesk/state\n",
            ".deploydesk/backups\n",
            ".deploydesk/runtime\n",
            ".env\n",
            ".env.*\n",
            "!.env.example\n",
            "*.log\n",
        ),
    )
}

fn generated_dockerfile_supported(report: &InspectionReport, service: &ServiceConfig) -> bool {
    if !service
        .dockerfile
        .starts_with(".deploydesk/generated/build/Dockerfile.")
    {
        return false;
    }
    report
        .services
        .iter()
        .find(|candidate| candidate.id == service.id)
        .is_some_and(|detected| standard_dockerfile(report, detected, service).is_some())
}

fn standard_dockerfile(
    report: &InspectionReport,
    detected: &crate::model::DetectedService,
    service: &ServiceConfig,
) -> Option<String> {
    if detected.framework == Framework::FastApi {
        return standard_fastapi_dockerfile(detected, service);
    }
    if detected.framework == Framework::NodeJs {
        return standard_node_dockerfile(report.package_manager, detected, service);
    }
    if report.package_manager != PackageManager::Pnpm
        || !safe_package_selector(&detected.package_name)
    {
        return None;
    }
    let service_path = detected.path.trim_matches('/');
    let output_path = if service_path == "." || service_path.is_empty() {
        "/app/dist".to_string()
    } else {
        format!("/app/{service_path}/dist")
    };
    let api_service = report
        .services
        .iter()
        .find(|candidate| candidate.kind == ServiceKind::Api);
    let api_host = api_service.map_or("api", |candidate| candidate.id.as_str());
    let api_port = api_service.map_or(3000, |candidate| candidate.suggested_port);
    let header = concat!(
        "# 由 ABCDeploy 根据项目结构生成，可提交并供本地、测试和生产共同使用。\n",
        "FROM node:22-bookworm-slim AS build\n\n",
        "ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \\\n    npm_config_registry=https://registry.npmmirror.com \\\n    NO_PROXY=registry.npmmirror.com \\\n    no_proxy=registry.npmmirror.com\n\n",
        "WORKDIR /app\n",
        "RUN corepack enable \\\n    && for attempt in 1 2 3; do \\\n         HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= corepack pnpm --version && break; \\\n         test \"$attempt\" = 3 && exit 1; \\\n         sleep $((attempt * 2)); \\\n       done\n",
        "COPY . .\n",
        "RUN --mount=type=cache,target=/root/.local/share/pnpm/store \\\n    for attempt in 1 2 3; do \\\n      HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= corepack pnpm install --frozen-lockfile && break; \\\n      test \"$attempt\" = 3 && exit 1; \\\n      sleep $((attempt * 2)); \\\n    done\n",
    );
    match detected.framework {
        Framework::NestJs => Some(format!(
            "{header}RUN corepack pnpm --filter {} build \\\n    && corepack pnpm@10.26.1 --filter {} deploy --legacy --prod /opt/app\n\n\
FROM node:22-bookworm-slim AS runtime\n\n\
ENV NODE_ENV=production\n\
WORKDIR /app\n\
COPY --from=build /opt/app ./\n\
COPY --from=build {output_path} ./dist\n\
USER node\n\
EXPOSE {}\n\
CMD [\"node\", \"dist/main.js\"]\n",
            detected.package_name, detected.package_name, service.container_port
        )),
        Framework::Vite => Some(format!(
            "{header}RUN corepack pnpm --filter {} run build \\\n{}\n\n{}",
            detected.package_name,
            stage_static_output(&output_path),
            standard_static_runtime("/opt/static", service.container_port, api_host, api_port),
        )),
        Framework::Taro | Framework::UniApp => {
            if !detected
                .build_command
                .as_deref()
                .is_some_and(|command| command.contains("build:h5"))
            {
                return None;
            }
            Some(format!(
                "{header}RUN corepack pnpm --filter {} run build:h5 \\\n{}\n\n{}",
                detected.package_name,
                stage_static_output(&output_path),
                standard_static_runtime("/opt/static", service.container_port, api_host, api_port),
            ))
        }
        _ => None,
    }
}

fn standard_node_dockerfile(
    manager: PackageManager,
    detected: &crate::model::DetectedService,
    service: &ServiceConfig,
) -> Option<String> {
    let start = detected.start_command.as_deref()?;
    let start = if detected.path == "." || detected.path.is_empty() {
        format!("export PATH=\"/app/node_modules/.bin:$PATH\" && {start}")
    } else {
        format!(
            "cd {} && export PATH=\"$PWD/node_modules/.bin:/app/node_modules/.bin:$PATH\" && {start}",
            shell_command_argument(&detected.path)
        )
    };
    let command = serde_json::to_string(&["sh", "-lc", start.as_str()]).ok()?;
    let build = detected
        .build_command
        .as_deref()
        .map_or_else(String::new, |command| format!("RUN {command}\n\n"));
    let (base, install, prune, user) = match manager {
        PackageManager::Pnpm => (
            "node:22-bookworm-slim",
            "corepack enable && if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; else corepack pnpm install; fi",
            "corepack enable && corepack pnpm prune --prod",
            "node",
        ),
        PackageManager::Yarn => (
            "node:22-bookworm-slim",
            "corepack enable && if [ -f yarn.lock ]; then corepack yarn install --frozen-lockfile; else corepack yarn install; fi",
            "corepack enable && NODE_ENV=production corepack yarn install --frozen-lockfile",
            "node",
        ),
        PackageManager::Bun => (
            "oven/bun:1.2-slim",
            "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi",
            "bun install --production",
            "bun",
        ),
        PackageManager::Npm | PackageManager::Unknown => (
            "node:22-bookworm-slim",
            "if [ -f package-lock.json ]; then npm ci; else npm install; fi",
            "npm prune --omit=dev",
            "node",
        ),
    };
    Some(format!(
        "# 由 ABCDeploy 根据标准 Node.js 启动脚本生成。\n\
FROM {base} AS build\n\n\
WORKDIR /app\n\
ENV NODE_ENV=development \\\n    npm_config_registry=https://registry.npmmirror.com\n\n\
COPY . .\n\
RUN {install}\n\n\
{build}\
RUN {prune}\n\n\
FROM {base} AS runtime\n\n\
WORKDIR /app\n\
ENV NODE_ENV=production\n\
COPY --from=build /app ./\n\
USER {user}\n\
EXPOSE {}\n\
CMD {command}\n",
        service.container_port
    ))
}

fn stage_static_output(output_path: &str) -> String {
    format!(
        "    && output_index=\"$(find {output_path} -type f -name index.html -print -quit)\" \\\n    && test -n \"$output_index\" \\\n    && mkdir -p /opt/static \\\n    && cp -R \"$(dirname \"$output_index\")/.\" /opt/static/"
    )
}

fn standard_static_runtime(
    output_path: &str,
    listen_port: u16,
    api_host: &str,
    api_port: u16,
) -> String {
    format!(
        r"FROM caddy:2-alpine AS runtime

ENV LISTEN_PORT={listen_port} \
    API_HOST={api_host} \
    API_PORT={api_port}

COPY --from=build {output_path} /srv
RUN printf '%s\n' \
    ':{{$LISTEN_PORT}} {{' \
    '  encode zstd gzip' \
    '  handle /api/* {{' \
    '    reverse_proxy {{$API_HOST}}:{{$API_PORT}}' \
    '  }}' \
    '  handle {{' \
    '    root * /srv' \
    '    try_files {{path}} /index.html' \
    '    file_server' \
    '  }}' \
    '}}' > /etc/caddy/Caddyfile

EXPOSE {listen_port}
",
    )
}

fn standard_fastapi_dockerfile(
    detected: &crate::model::DetectedService,
    service: &ServiceConfig,
) -> Option<String> {
    let service_path = if detected.path == "." {
        String::new()
    } else {
        format!("{}/", detected.path.trim_matches('/'))
    };
    let start_command = detected.start_command.as_ref()?;
    let dependency_file = detected
        .dependency_file
        .as_deref()
        .filter(|path| path.ends_with("requirements.txt"))?;
    let command = serde_json::to_string(&vec!["sh", "-c", start_command]).ok()?;
    Some(format!(
        r#"# 由 ABCDeploy 根据 FastAPI 项目结构生成，可供本地、测试和生产共同使用。
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple \
    PYTHONPATH=/app/service/src

ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG http_proxy=
ARG https_proxy=

WORKDIR /app
COPY {dependency_file} /tmp/requirements.txt
RUN unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy \
    && for attempt in 1 2 3; do \
         pip install --no-cache-dir --retries 3 -r /tmp/requirements.txt && break; \
         test "$attempt" = 3 && exit 1; \
         sleep $((attempt * 2)); \
       done
COPY {service_path} /app/service
WORKDIR /app/service
EXPOSE {port}
CMD {command}
"#,
        port = service.container_port,
    ))
}

fn safe_package_selector(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'/' | b'_' | b'-' | b'.')
        })
}

pub fn apply_plan(root: &Path, plan: &DeploymentPlan) -> Result<Vec<String>> {
    apply_plan_changes(
        root,
        plan,
        plan.changes.iter().collect(),
        &plan.id,
        "last-plan.json",
    )
}

/// Save deploy configuration and ABCDeploy-owned generated files without
/// replacing the repository's active CNB pipeline. The full plan is applied
/// only when the user explicitly starts a test deployment.
pub fn apply_setup_plan(root: &Path, plan: &DeploymentPlan) -> Result<Vec<String>> {
    let changes = plan
        .changes
        .iter()
        .filter(|change| change.path != ".cnb.yml")
        .collect();
    apply_plan_changes(root, plan, changes, &plan.id, "last-plan.json")
}

pub fn apply_local_plan(root: &Path, plan: &DeploymentPlan) -> Result<Vec<String>> {
    let changes = plan
        .changes
        .iter()
        .filter(|change| {
            change.path == ".deploydesk/.gitignore"
                || change.path == ".dockerignore"
                || change
                    .path
                    .starts_with(".deploydesk/generated/development/")
                || change.path.starts_with(".deploydesk/generated/build/")
        })
        .collect::<Vec<_>>();
    apply_plan_changes(
        root,
        plan,
        changes,
        &format!("{}-local", plan.id),
        "last-local-plan.json",
    )
}

fn apply_plan_changes(
    root: &Path,
    plan: &DeploymentPlan,
    changes: Vec<&FileChange>,
    backup_id: &str,
    state_filename: &str,
) -> Result<Vec<String>> {
    if !root.is_dir() {
        return Err(DeployError::MissingProject(root.to_path_buf()));
    }
    let backup_root = root.join(".deploydesk/backups").join(backup_id);
    let mut written = Vec::new();
    for change in changes {
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
    let state_path = root.join(".deploydesk/state").join(state_filename);
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
    use crate::scanner::{inspect_project, inspection_fixture};

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
    fn setup_save_preserves_an_existing_cnb_pipeline() {
        let directory = tempdir().expect("tempdir");
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);
        fs::write(directory.path().join(".cnb.yml"), "legacy: pipeline\n")
            .expect("legacy pipeline");
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");

        let written = apply_setup_plan(directory.path(), &plan).expect("save setup");

        assert!(!written.contains(&".cnb.yml".to_string()));
        assert_eq!(
            fs::read_to_string(directory.path().join(".cnb.yml")).expect("pipeline"),
            "legacy: pipeline\n"
        );
        assert!(directory.path().join("deploy.yaml").is_file());
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
        assert_eq!(
            manifest.project.commands.verify,
            vec!["corepack pnpm build"]
        );
    }

    #[test]
    fn generates_prisma_client_before_build_validation() {
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);

        assert_eq!(
            manifest.project.commands.verify,
            vec![
                "corepack pnpm --dir 'apps/api' exec prisma generate --schema 'prisma/schema.prisma'",
                "corepack pnpm build",
            ]
        );
    }

    #[test]
    fn local_apply_never_writes_remote_deployment_files() {
        let directory = tempdir().expect("tempdir");
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");

        let written = apply_local_plan(directory.path(), &plan).expect("local apply");
        assert!(
            written
                .iter()
                .any(|path| path.ends_with("development/docker-compose.yml"))
        );
        assert!(!directory.path().join("deploy.yaml").exists());
        assert!(!directory.path().join(".cnb.yml").exists());
        assert!(
            !directory
                .path()
                .join(".deploydesk/generated/production/docker-compose.yml")
                .exists()
        );
    }

    #[test]
    fn updates_only_abcdeploy_owned_dockerignore_files() {
        let directory = tempdir().expect("tempdir");
        let report = inspection_fixture();
        let manifest = create_default_manifest(&report);
        fs::write(
            directory.path().join(".dockerignore"),
            format!("{STANDARD_DOCKERIGNORE_HEADER}node_modules\n"),
        )
        .expect("old managed dockerignore");

        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let managed = plan
            .changes
            .iter()
            .find(|change| change.path == ".dockerignore")
            .expect("managed dockerignore update");
        assert_eq!(managed.kind, FileChangeKind::Update);
        assert!(managed.after.contains(".deploydesk/generated\n"));
        assert!(managed.after.contains(".deploydesk/state\n"));

        let custom_directory = tempdir().expect("custom tempdir");
        fs::write(
            custom_directory.path().join(".dockerignore"),
            "custom-build-output\n",
        )
        .expect("custom dockerignore");
        let custom_plan = build_plan(custom_directory.path(), &report, &manifest).expect("plan");
        assert!(
            custom_plan
                .changes
                .iter()
                .all(|change| change.path != ".dockerignore")
        );
    }

    #[test]
    fn generates_a_reviewable_standard_dockerfile_for_supported_projects() {
        let directory = tempdir().expect("tempdir");
        let mut report = inspection_fixture();
        report.services[0].dockerfile = None;
        report.dockerfiles.clear();
        let manifest = create_default_manifest(&report);
        assert_eq!(
            manifest.services[0].dockerfile,
            ".deploydesk/generated/build/Dockerfile.api"
        );

        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.api"))
            .expect("generated Dockerfile");
        assert!(
            dockerfile
                .after
                .contains("FROM node:22-bookworm-slim AS build")
        );
        assert!(
            dockerfile
                .after
                .contains("pnpm --filter @example/api build")
        );
        assert!(
            dockerfile
                .after
                .contains("pnpm@10.26.1 --filter @example/api deploy --legacy --prod /opt/app")
        );
        assert!(dockerfile.after.contains("NO_PROXY=registry.npmmirror.com"));
        assert!(dockerfile.after.contains("USER node"));
    }

    #[test]
    fn generates_a_runnable_node_dockerfile_without_requiring_a_framework() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("src")).expect("source directory");
        fs::write(
            directory.path().join("package.json"),
            r#"{
              "name":"plain-node-service",
              "private":true,
              "scripts":{
                "dev":"node src/server.js",
                "start":"node src/server.js"
              }
            }"#,
        )
        .expect("package");
        fs::write(
            directory.path().join("src/server.js"),
            "require('node:http').createServer((_req, res) => res.end('ok')).listen(process.env.PORT || 3000);\n",
        )
        .expect("server");
        fs::write(
            directory.path().join(".env.example"),
            "PORT=3000\nDATABASE_URL=\nADMIN_PASSWORD=\n",
        )
        .expect("environment");

        let report = inspect_project(directory.path()).expect("inspection");
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.plain-node-service"))
            .expect("generated Node.js Dockerfile");

        assert_eq!(manifest.project.commands.install, "npm install");
        assert!(manifest.project.commands.verify.is_empty());
        assert_eq!(manifest.services[0].healthcheck.path, "/");
        assert_eq!(
            manifest.services[0]
                .runtime_env
                .iter()
                .map(|variable| variable.name.as_str())
                .collect::<Vec<_>>(),
            ["ADMIN_PASSWORD", "DATABASE_URL", "PORT"]
        );
        assert!(plan.blockers.is_empty());
        assert!(
            dockerfile
                .after
                .contains("FROM node:22-bookworm-slim AS build")
        );
        assert!(dockerfile.after.contains("npm prune --omit=dev"));
        assert!(dockerfile.after.contains(
            "ENV NODE_ENV=development \\\n    npm_config_registry=https://registry.npmmirror.com"
        ));
        assert!(!dockerfile.after.lines().any(|line| line.starts_with('+')));
        assert!(!dockerfile.after.contains("npm run build"));
        assert!(dockerfile.after.contains("EXPOSE 3000"));
        assert!(dockerfile.after.contains("/app/node_modules/.bin:$PATH"));
        assert!(dockerfile.after.contains("node src/server.js"));
        assert!(!dockerfile.after.contains("npm run start"));
    }

    #[test]
    fn builds_a_node_project_inside_the_generated_image_when_declared() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("src")).expect("source directory");
        fs::write(
            directory.path().join("package.json"),
            r#"{
              "name":"compiled-node-service",
              "private":true,
              "scripts":{
                "build":"node scripts/build.js",
                "start":"node dist/server.js"
              }
            }"#,
        )
        .expect("package");

        let report = inspect_project(directory.path()).expect("inspection");
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.compiled-node-service"))
            .expect("generated Node.js Dockerfile");

        assert_eq!(manifest.project.commands.verify, ["npm run build"]);
        assert!(dockerfile.after.contains("RUN npm run build"));
        assert!(dockerfile.after.contains("node dist/server.js"));
        assert!(!dockerfile.after.contains("npm run start"));
        assert!(
            dockerfile.after.find("RUN npm run build")
                < dockerfile.after.find("RUN npm prune --omit=dev")
        );
        assert!(
            dockerfile.after.find("RUN npm prune --omit=dev")
                < dockerfile
                    .after
                    .find("FROM node:22-bookworm-slim AS runtime")
        );
    }

    #[test]
    fn generates_workspace_aware_commands_for_a_plain_node_service() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/api")).expect("service directory");
        fs::write(
            directory.path().join("package.json"),
            r#"{"name":"workspace-root","private":true}"#,
        )
        .expect("root package");
        fs::write(
            directory.path().join("pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
        )
        .expect("workspace");
        fs::write(
            directory.path().join("apps/api/package.json"),
            r#"{
              "name":"@audit/api",
              "private":true,
              "scripts":{
                "build":"node build.js",
                "start":"node dist/server.js"
              }
            }"#,
        )
        .expect("service package");
        fs::write(
            directory.path().join(".env.example"),
            "DATABASE_URL=\nVITE_PUBLIC_SITE_NAME=\n",
        )
        .expect("root environment");
        fs::write(
            directory.path().join("apps/api/.env.example"),
            "PORT=4600\nADMIN_PASSWORD=\n",
        )
        .expect("service environment");

        let report = inspect_project(directory.path()).expect("inspection");
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.api"))
            .expect("generated Node.js Dockerfile");

        assert_eq!(manifest.services[0].context, ".");
        assert_eq!(
            manifest.services[0]
                .runtime_env
                .iter()
                .map(|variable| variable.name.as_str())
                .collect::<Vec<_>>(),
            ["ADMIN_PASSWORD", "DATABASE_URL", "PORT"]
        );
        assert_eq!(manifest.project.commands.install, "corepack pnpm install");
        assert_eq!(
            manifest.project.commands.verify,
            ["corepack pnpm --dir 'apps/api' run build"]
        );
        assert!(
            dockerfile
                .after
                .contains("RUN corepack pnpm --dir 'apps/api' run build")
        );
        assert!(dockerfile.after.contains("cd 'apps/api'"));
        assert!(dockerfile.after.contains("$PWD/node_modules/.bin"));
        assert!(dockerfile.after.contains("node dist/server.js"));
        assert!(!dockerfile.after.contains("pnpm --dir 'apps/api' run start"));
    }

    #[test]
    fn uses_strict_package_installs_only_when_a_lockfile_exists() {
        let cases = [
            (
                "pnpm@10.0.0",
                "pnpm-lock.yaml",
                "corepack pnpm install",
                "corepack pnpm install --frozen-lockfile",
            ),
            ("npm@10.0.0", "package-lock.json", "npm install", "npm ci"),
            (
                "yarn@4.0.0",
                "yarn.lock",
                "corepack yarn install",
                "corepack yarn install --frozen-lockfile",
            ),
            (
                "bun@1.2.0",
                "bun.lock",
                "npm install --global bun && bun install",
                "npm install --global bun && bun install --frozen-lockfile",
            ),
        ];

        for (declared, lockfile, unlocked_command, locked_command) in cases {
            let directory = tempdir().expect("tempdir");
            fs::write(
                directory.path().join("package.json"),
                format!(
                    r#"{{
                      "name":"package-manager-audit",
                      "private":true,
                      "packageManager":"{declared}",
                      "scripts":{{"start":"node server.js"}}
                    }}"#
                ),
            )
            .expect("package");

            let unlocked = inspect_project(directory.path()).expect("unlocked inspection");
            assert_eq!(
                create_default_manifest(&unlocked).project.commands.install,
                unlocked_command,
                "{declared} without {lockfile}"
            );

            fs::write(directory.path().join(lockfile), "").expect("lockfile");
            let locked = inspect_project(directory.path()).expect("locked inspection");
            assert_eq!(
                create_default_manifest(&locked).project.commands.install,
                locked_command,
                "{declared} with {lockfile}"
            );
        }
    }

    #[test]
    fn reconciles_a_new_fastapi_service_without_duplicating_it() {
        let mut report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        report.services.push(crate::model::DetectedService {
            id: "ocr".to_string(),
            package_name: "ocr".to_string(),
            path: "apps/ocr".to_string(),
            kind: ServiceKind::Api,
            framework: Framework::FastApi,
            dockerfile: Some("apps/ocr/Dockerfile".to_string()),
            suggested_port: 8000,
            build_command: None,
            start_command: Some(
                "uvicorn finagent_ocr.main:app --host 0.0.0.0 --port 8000".to_string(),
            ),
            dependency_file: Some("apps/ocr/requirements.txt".to_string()),
            confidence: 99,
        });

        assert_eq!(reconcile_detected_services(&report, &mut manifest), ["ocr"]);
        assert!(reconcile_detected_services(&report, &mut manifest).is_empty());
        let ocr = manifest
            .services
            .iter()
            .find(|service| service.id == "ocr")
            .expect("reconciled OCR service");
        assert_eq!(ocr.container_port, 8000);
        assert_eq!(ocr.healthcheck.path, "/health");
        assert!(ocr.healthcheck.command.as_deref().is_some_and(|command| {
            command.contains("python -c") && command.contains("127.0.0.1:8000/health")
        }));
        assert!(ocr.migration.is_none());
        assert_eq!(manifest.services.len(), 2);
    }

    #[test]
    fn reconciles_prisma_generation_into_an_existing_manifest_once() {
        let report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        manifest.project.commands.verify = vec!["corepack pnpm build".to_string()];

        reconcile_detected_services(&report, &mut manifest);
        reconcile_detected_services(&report, &mut manifest);

        assert_eq!(
            manifest.project.commands.verify,
            vec![
                "corepack pnpm --dir 'apps/api' exec prisma generate --schema 'prisma/schema.prisma'",
                "corepack pnpm build",
            ]
        );
    }

    #[test]
    fn reconciles_the_source_repository_after_cnb_setup() {
        let report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        manifest.providers.build.repository = "demo/finagent".to_string();

        reconcile_detected_services(&report, &mut manifest);

        assert_eq!(manifest.source.repository, "demo/finagent");
    }

    #[test]
    fn upgrades_the_legacy_root_prisma_command_for_workspace_packages() {
        let report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        manifest.project.commands.verify = vec![
            "corepack pnpm exec prisma generate --schema 'apps/api/prisma/schema.prisma'"
                .to_string(),
            "corepack pnpm build".to_string(),
        ];
        manifest.services[0]
            .migration
            .as_mut()
            .expect("Prisma migration")
            .command =
            "corepack pnpm exec prisma migrate deploy --schema apps/api/prisma/schema.prisma"
                .to_string();

        reconcile_detected_services(&report, &mut manifest);
        reconcile_detected_services(&report, &mut manifest);

        assert_eq!(
            manifest.project.commands.verify,
            vec![
                "corepack pnpm --dir 'apps/api' exec prisma generate --schema 'prisma/schema.prisma'",
                "corepack pnpm build",
            ]
        );
        assert_eq!(
            manifest.services[0]
                .migration
                .as_ref()
                .expect("Prisma migration")
                .command,
            "./node_modules/.bin/prisma migrate deploy --schema 'apps/api/prisma/schema.prisma'"
        );
    }

    #[test]
    fn reconciles_a_generated_default_port_with_the_dockerfile_port() {
        let mut report = inspection_fixture();
        let mut manifest = create_default_manifest(&report);
        assert_eq!(manifest.services[0].container_port, 3000);
        report.services[0].suggested_port = 3300;

        reconcile_detected_services(&report, &mut manifest);

        assert_eq!(manifest.services[0].container_port, 3300);
    }

    #[test]
    fn generates_fastapi_dockerfile_only_for_requirements_projects() {
        let directory = tempdir().expect("tempdir");
        let mut report = inspection_fixture();
        report.package_manager = PackageManager::Unknown;
        report.prisma_schemas.clear();
        report.services = vec![crate::model::DetectedService {
            id: "api".to_string(),
            package_name: "api".to_string(),
            path: ".".to_string(),
            kind: ServiceKind::Api,
            framework: Framework::FastApi,
            dockerfile: None,
            suggested_port: 8000,
            build_command: None,
            start_command: Some("uvicorn main:app --host 0.0.0.0 --port 8000".to_string()),
            dependency_file: Some("requirements.txt".to_string()),
            confidence: 99,
        }];
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.api"))
            .expect("generated FastAPI Dockerfile");
        assert!(dockerfile.after.contains("FROM python:3.12-slim-bookworm"));
        assert!(dockerfile.after.contains("COPY requirements.txt"));
        assert!(dockerfile.after.contains("uvicorn main:app"));

        report.services[0].dependency_file = Some("pyproject.toml".to_string());
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("fallback plan");
        assert!(
            !plan
                .changes
                .iter()
                .any(|change| change.path.ends_with("Dockerfile.api"))
        );
        assert_eq!(plan.blockers.len(), 1);
        assert_eq!(plan.blockers[0].code, "AD-CTR-101");
        assert_eq!(plan.blockers[0].service.as_deref(), Some("api"));
    }

    #[test]
    fn generates_a_static_container_for_taro_h5_projects() {
        let directory = tempdir().expect("tempdir");
        let mut report = inspection_fixture();
        report.prisma_schemas.clear();
        report.services = vec![crate::model::DetectedService {
            id: "mobile".to_string(),
            package_name: "@sample/mobile".to_string(),
            path: "apps/mobile".to_string(),
            kind: ServiceKind::Static,
            framework: Framework::Taro,
            dockerfile: None,
            suggested_port: 80,
            build_command: Some("corepack pnpm run build:h5".to_string()),
            start_command: None,
            dependency_file: Some("apps/mobile/package.json".to_string()),
            confidence: 98,
        }];
        let manifest = create_default_manifest(&report);
        let generated = directory
            .path()
            .join(".deploydesk/generated/build/Dockerfile.mobile");
        fs::create_dir_all(generated.parent().expect("generated parent"))
            .expect("create generated directory");
        fs::write(
            &generated,
            "# 由 ABCDeploy 根据项目结构生成，可提交并供本地、测试和生产共同使用。\nFROM busybox:1.36 AS runtime\n",
        )
        .expect("write legacy generated Dockerfile");
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");

        assert!(plan.blockers.is_empty());
        let dockerfile = plan
            .changes
            .iter()
            .find(|change| change.path.ends_with("Dockerfile.mobile"))
            .expect("generated Taro Dockerfile");
        assert!(
            dockerfile
                .after
                .contains("pnpm --filter @sample/mobile run build:h5")
        );
        assert!(
            dockerfile
                .after
                .contains("find /app/apps/mobile/dist -type f -name index.html -print -quit")
        );
        assert!(
            dockerfile
                .after
                .contains("cp -R \"$(dirname \"$output_index\")/.\" /opt/static/")
        );
        assert!(
            dockerfile
                .after
                .contains("COPY --from=build /opt/static /srv")
        );
        assert!(dockerfile.after.contains("FROM caddy:2-alpine AS runtime"));
        assert!(dockerfile.after.contains("/etc/caddy/Caddyfile"));
        assert!(dockerfile.after.contains("handle /api/*"));
        assert!(
            dockerfile
                .after
                .contains("reverse_proxy {$API_HOST}:{$API_PORT}")
        );
        assert!(dockerfile.after.contains("root * /srv"));
        assert!(dockerfile.after.contains("try_files {path} /index.html"));
        assert!(!dockerfile.after.to_ascii_lowercase().contains("nginx"));
        let compose = plan
            .changes
            .iter()
            .find(|change| {
                change
                    .path
                    .ends_with("generated/development/docker-compose.yml")
            })
            .expect("development compose");
        assert!(
            compose
                .after
                .contains("wget -Y off -q --spider http://127.0.0.1:80/")
        );
        assert!(compose.after.contains("interval: 2s"));
        assert!(compose.after.contains("timeout: 2s"));
        assert!(compose.after.contains("retries: 15"));
        assert!(compose.after.contains("start_period: 1s"));
    }

    #[test]
    fn generated_vite_web_uses_the_caddy_healthcheck() {
        let directory = tempdir().expect("tempdir");
        let mut report = inspection_fixture();
        report.prisma_schemas.clear();
        report.services = vec![crate::model::DetectedService {
            id: "web".to_string(),
            package_name: "@sample/web".to_string(),
            path: "apps/web".to_string(),
            kind: ServiceKind::Web,
            framework: Framework::Vite,
            dockerfile: None,
            suggested_port: 80,
            build_command: Some("corepack pnpm run build".to_string()),
            start_command: None,
            dependency_file: Some("apps/web/package.json".to_string()),
            confidence: 98,
        }];
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");
        let compose = plan
            .changes
            .iter()
            .find(|change| {
                change
                    .path
                    .ends_with("generated/development/docker-compose.yml")
            })
            .expect("development compose");

        assert!(
            compose
                .after
                .contains("wget -Y off -q --spider http://127.0.0.1:80/")
        );
        assert!(!compose.after.contains("node -e"));
        assert!(compose.after.contains("start_period: 1s"));
    }

    #[test]
    fn does_not_guess_a_server_container_for_native_taro_projects() {
        let directory = tempdir().expect("tempdir");
        let mut report = inspection_fixture();
        report.prisma_schemas.clear();
        report.services = vec![crate::model::DetectedService {
            id: "miniapp".to_string(),
            package_name: "@sample/miniapp".to_string(),
            path: "apps/miniapp".to_string(),
            kind: ServiceKind::Static,
            framework: Framework::Taro,
            dockerfile: None,
            suggested_port: 80,
            build_command: Some("corepack pnpm run build".to_string()),
            start_command: None,
            dependency_file: Some("apps/miniapp/package.json".to_string()),
            confidence: 98,
        }];
        let manifest = create_default_manifest(&report);
        let plan = build_plan(directory.path(), &report, &manifest).expect("plan");

        assert!(
            !plan
                .changes
                .iter()
                .any(|change| change.path.ends_with("Dockerfile.miniapp"))
        );
        assert_eq!(plan.blockers.len(), 1);
        assert_eq!(plan.blockers[0].code, "AD-CTR-101");
    }
}
