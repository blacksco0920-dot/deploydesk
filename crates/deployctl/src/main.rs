use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use clap::{Parser, Subcommand, ValueEnum};
use deploy_core::health::check_http_health;
use deploy_core::journal::DeploymentJournal;
use deploy_core::manifest::manifest_schema_json;
use deploy_core::model::{EnvironmentName, ReleaseRecord, ReleaseStatus};
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{caddy, cnb::CnbClient, docker, ssh};
use deploy_core::{
    MANIFEST_FILE, apply_plan, build_plan, create_default_manifest, inspect_project, load_manifest,
};

#[derive(Debug, Parser)]
#[command(name = "deployctl", version, about = "ABCDeploy 的跨平台部署内核")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 只读识别项目技术栈和服务
    Inspect {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// 生成默认部署配置和变更计划
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        write: bool,
    },
    /// 预览部署配置将产生的全部文件变化
    Plan {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        manifest: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// 明确确认后写入计划，原文件自动备份
    Apply {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        manifest: Option<PathBuf>,
        #[arg(long)]
        yes: bool,
    },
    /// 输出 deploy.yaml JSON Schema
    Schema {
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// 检查本机云端部署和本地预览条件
    Preflight,
    /// 执行 HTTP 健康检查
    Health {
        url: String,
        #[arg(long, default_value_t = 3)]
        retries: u16,
        #[arg(long, default_value_t = 2)]
        interval_seconds: u64,
    },
    /// 查询部署记录或生成恢复计划
    #[command(subcommand)]
    Release(ReleaseCommand),
    /// 检查本地 Provider
    #[command(subcommand)]
    Provider(ProviderCommand),
    /// 调用 CNB OpenAPI，Token 只从 `CNB_TOKEN` 读取
    #[command(subcommand)]
    Cnb(CnbCommand),
}

#[derive(Debug, Subcommand)]
enum ReleaseCommand {
    History {
        project: String,
    },
    Record {
        project: String,
        environment: CliEnvironment,
        image_digest: String,
        status: CliReleaseStatus,
        #[arg(long, value_delimiter = ',')]
        completed: Vec<String>,
        #[arg(long)]
        failure: Option<String>,
    },
    Recover {
        project: String,
        release_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum ProviderCommand {
    Docker,
    Ssh {
        #[arg(long)]
        name: String,
        #[arg(long)]
        host: String,
        #[arg(long)]
        user: String,
        #[arg(long)]
        key: PathBuf,
        #[arg(long, default_value_t = 22)]
        port: u16,
        #[arg(long)]
        host_fingerprint: Option<String>,
    },
    CaddyBootstrap {
        #[arg(long)]
        name: String,
        #[arg(long)]
        host: String,
        #[arg(long)]
        user: String,
        #[arg(long)]
        key: PathBuf,
        #[arg(long, default_value_t = 22)]
        port: u16,
        #[arg(long)]
        host_fingerprint: Option<String>,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
enum CnbCommand {
    Me,
    Repositories {
        slug: String,
    },
    #[command(name = "create-repo", about = "创建 CNB 项目仓库（默认私有）")]
    CreateRepository {
        /// CNB 组织或用户名
        #[arg(value_name = "组织")]
        slug: String,
        /// 新仓库名称
        #[arg(value_name = "仓库名")]
        name: String,
        /// 仓库说明
        #[arg(long, default_value = "", value_name = "说明")]
        description: String,
        /// 将仓库设为公开；未指定时创建私有仓库
        #[arg(long)]
        public: bool,
    },
    Settings {
        repository: String,
    },
    EnableAuto {
        repository: String,
    },
    Builds {
        repository: String,
        #[arg(long, default_value_t = 5)]
        size: u16,
    },
    Trigger {
        repository: String,
        #[arg(long, default_value = "main")]
        branch: String,
        #[arg(long, default_value = "api_trigger_abcdeploy")]
        event: String,
        #[arg(long, default_value = "ABCDeploy 手动触发")]
        title: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliEnvironment {
    Development,
    Staging,
    Production,
}

impl From<CliEnvironment> for EnvironmentName {
    fn from(value: CliEnvironment) -> Self {
        match value {
            CliEnvironment::Development => Self::Development,
            CliEnvironment::Staging => Self::Staging,
            CliEnvironment::Production => Self::Production,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliReleaseStatus {
    Planned,
    Running,
    Healthy,
    Failed,
    RolledBack,
}

impl From<CliReleaseStatus> for ReleaseStatus {
    fn from(value: CliReleaseStatus) -> Self {
        match value {
            CliReleaseStatus::Planned => Self::Planned,
            CliReleaseStatus::Running => Self::Running,
            CliReleaseStatus::Healthy => Self::Healthy,
            CliReleaseStatus::Failed => Self::Failed,
            CliReleaseStatus::RolledBack => Self::RolledBack,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { path, json } => {
            let report = inspect_project(&path)?;
            if json {
                print_json(&report)?;
            } else {
                println!("项目：{}", report.project_name);
                println!("服务：{}", report.services.len());
                for service in report.services {
                    println!(
                        "- {}  {:?}  {}  置信度 {}%",
                        service.id, service.framework, service.path, service.confidence
                    );
                }
                for diagnostic in report.diagnostics {
                    println!("{:?}：{}", diagnostic.level, diagnostic.message);
                }
            }
        }
        Command::Init { path, write } => {
            let report = inspect_project(&path)?;
            let manifest = create_default_manifest(&report);
            let plan = build_plan(&path, &report, &manifest)?;
            print_plan_summary(&plan);
            if write {
                let written = apply_plan(&path, &plan)?;
                println!("已写入 {} 个文件，原文件已备份。", written.len());
            } else {
                println!("当前仅预览。确认后使用 deployctl init --write 写入。");
            }
        }
        Command::Plan {
            path,
            manifest,
            json,
        } => {
            let report = inspect_project(&path)?;
            let manifest = load_manifest(&manifest_path(&path, manifest))?;
            let plan = build_plan(&path, &report, &manifest)?;
            if json {
                print_json(&plan)?;
            } else {
                print_plan_summary(&plan);
            }
        }
        Command::Apply {
            path,
            manifest,
            yes,
        } => {
            if !yes {
                bail!("Apply 会写入项目文件，请先查看 Plan，再加 --yes 明确确认");
            }
            let report = inspect_project(&path)?;
            let manifest = load_manifest(&manifest_path(&path, manifest))?;
            let plan = build_plan(&path, &report, &manifest)?;
            let written = apply_plan(&path, &plan)?;
            println!("计划 {} 已应用，共写入 {} 个文件。", plan.id, written.len());
        }
        Command::Schema { output } => {
            let schema = manifest_schema_json()?;
            if let Some(path) = output {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("无法创建 Schema 目录 {}", parent.display()))?;
                }
                fs::write(&path, format!("{schema}\n"))
                    .with_context(|| format!("无法写入 Schema {}", path.display()))?;
                println!("Schema 已写入 {}", path.display());
            } else {
                println!("{schema}");
            }
        }
        Command::Preflight => print_json(&system_preflight())?,
        Command::Health {
            url,
            retries,
            interval_seconds,
        } => {
            let result =
                check_http_health(&url, retries, Duration::from_secs(interval_seconds)).await?;
            print_json(&result)?;
            if !result.healthy {
                bail!("健康检查未通过");
            }
        }
        Command::Release(command) => handle_release(command)?,
        Command::Provider(command) => handle_provider(command).await?,
        Command::Cnb(command) => handle_cnb(command).await?,
    }
    Ok(())
}

fn handle_release(command: ReleaseCommand) -> Result<()> {
    match command {
        ReleaseCommand::History { project } => {
            let journal = DeploymentJournal::for_project(&project)?;
            print_json(&journal.records()?)?;
        }
        ReleaseCommand::Record {
            project,
            environment,
            image_digest,
            status,
            completed,
            failure,
        } => {
            if !image_digest.starts_with("sha256:") {
                bail!("发布记录必须使用 sha256 镜像摘要");
            }
            let journal = DeploymentJournal::for_project(&project)?;
            let previous_release = journal
                .latest_healthy(environment.into())?
                .map(|record| record.id);
            let record = ReleaseRecord {
                id: format!("release-{}", Utc::now().format("%Y%m%d%H%M%S")),
                project,
                environment: environment.into(),
                image_digest,
                status: status.into(),
                created_at: Utc::now(),
                previous_release,
                completed_steps: completed,
                failure,
            };
            journal.append(&record)?;
            print_json(&record)?;
        }
        ReleaseCommand::Recover {
            project,
            release_id,
        } => {
            let journal = DeploymentJournal::for_project(&project)?;
            print_json(&journal.recovery_plan(&release_id)?)?;
        }
    }
    Ok(())
}

async fn handle_provider(command: ProviderCommand) -> Result<()> {
    match command {
        ProviderCommand::Docker => print_json(&docker::check_engine()?)?,
        ProviderCommand::Ssh {
            name,
            host,
            user,
            key,
            port,
            host_fingerprint,
        } => {
            print_json(
                &ssh::check_connection(&ssh::SshProfile {
                    name,
                    host,
                    user,
                    port,
                    key_path: key,
                    host_fingerprint,
                })
                .await?,
            )?;
        }
        ProviderCommand::CaddyBootstrap {
            name,
            host,
            user,
            key,
            port,
            host_fingerprint,
            yes,
        } => {
            if !yes {
                bail!("Caddy 初始化会在服务器创建 ~/.deploydesk 和容器，请加 --yes 明确确认");
            }
            print_json(
                &caddy::bootstrap_server(
                    &ssh::SshProfile {
                        name,
                        host,
                        user,
                        port,
                        key_path: key,
                        host_fingerprint,
                    },
                    true,
                )
                .await?,
            )?;
        }
    }
    Ok(())
}

async fn handle_cnb(command: CnbCommand) -> Result<()> {
    let client = CnbClient::from_env()?;
    let result = match command {
        CnbCommand::Me => client.current_user().await?,
        CnbCommand::Repositories { slug } => client.repositories(&slug).await?,
        CnbCommand::CreateRepository {
            slug,
            name,
            description,
            public,
        } => {
            client
                .create_repository(&slug, &name, &description, !public)
                .await?
        }
        CnbCommand::Settings { repository } => client.build_settings(&repository).await?,
        CnbCommand::EnableAuto { repository } => client.enable_auto_trigger(&repository).await?,
        CnbCommand::Builds { repository, size } => client.recent_builds(&repository, size).await?,
        CnbCommand::Trigger {
            repository,
            branch,
            event,
            title,
        } => {
            client
                .trigger_build(&repository, &branch, &event, &title)
                .await?
        }
    };
    print_json(&result)
}

fn manifest_path(root: &Path, value: Option<PathBuf>) -> PathBuf {
    value.unwrap_or_else(|| root.join(MANIFEST_FILE))
}

fn print_plan_summary(plan: &deploy_core::model::DeploymentPlan) {
    println!("计划：{}", plan.id);
    println!("文件变化：");
    for change in &plan.changes {
        println!("- {:?} {}", change.kind, change.path);
    }
    if !plan.blockers.is_empty() {
        println!("部署前必须处理：{} 项", plan.blockers.len());
        for blocker in &plan.blockers {
            println!(
                "- {} {}：{}",
                blocker.code, blocker.title, blocker.resolution
            );
        }
    }
    println!("需要你处理：{} 项", plan.user_actions.len());
    for action in &plan.user_actions {
        println!("- {}：{}", action.title, action.detail);
    }
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).context("无法序列化输出")?
    );
    Ok(())
}
