use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProjectManifest {
    #[serde(default = "manifest_version")]
    pub version: u32,
    pub project: ProjectConfig,
    pub source: SourceConfig,
    #[serde(default)]
    pub services: Vec<ServiceConfig>,
    pub environments: EnvironmentSet,
    pub providers: ProviderConfig,
    #[serde(default)]
    pub release: ReleasePolicy,
}

const fn manifest_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProjectConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub commands: ProjectCommands,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProjectCommands {
    #[serde(default = "default_install_command")]
    pub install: String,
    #[serde(default = "default_verify_commands")]
    pub verify: Vec<String>,
}

impl Default for ProjectCommands {
    fn default() -> Self {
        Self {
            install: default_install_command(),
            verify: default_verify_commands(),
        }
    }
}

fn default_install_command() -> String {
    "corepack pnpm install --frozen-lockfile".to_string()
}

fn default_verify_commands() -> Vec<String> {
    vec!["corepack pnpm build".to_string()]
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct SourceConfig {
    #[serde(default)]
    pub provider: SourceProvider,
    #[serde(default)]
    pub repository: String,
    #[serde(default = "default_integration_branch")]
    pub integration_branch: String,
    #[serde(default = "default_stable_branch")]
    pub stable_branch: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceProvider {
    #[default]
    Github,
    Cnb,
    Local,
}

fn default_integration_branch() -> String {
    "test".to_string()
}

fn default_stable_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ServiceConfig {
    pub id: String,
    pub kind: ServiceKind,
    pub image: String,
    #[serde(default = "default_context")]
    pub context: String,
    pub dockerfile: String,
    pub container_port: u16,
    pub healthcheck: HealthcheckConfig,
    #[serde(default)]
    pub migration: Option<MigrationConfig>,
    #[serde(default)]
    pub runtime_env: Vec<EnvironmentVariable>,
    #[serde(default)]
    pub build_args: BTreeMap<String, String>,
}

fn default_context() -> String {
    ".".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    Api,
    Web,
    Worker,
    Static,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HealthcheckConfig {
    #[serde(default = "default_health_path")]
    pub path: String,
    #[serde(default = "default_health_interval")]
    pub interval_seconds: u32,
    #[serde(default = "default_health_retries")]
    pub retries: u16,
}

impl Default for HealthcheckConfig {
    fn default() -> Self {
        Self {
            path: default_health_path(),
            interval_seconds: default_health_interval(),
            retries: default_health_retries(),
        }
    }
}

fn default_health_path() -> String {
    "/health".to_string()
}

const fn default_health_interval() -> u32 {
    10
}

const fn default_health_retries() -> u16 {
    12
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct MigrationConfig {
    pub command: String,
    #[serde(default = "default_true")]
    pub backup_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct EnvironmentVariable {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct EnvironmentSet {
    pub development: EnvironmentConfig,
    pub staging: EnvironmentConfig,
    pub production: EnvironmentConfig,
}

impl EnvironmentSet {
    #[must_use]
    pub fn entries(&self) -> [(EnvironmentName, &EnvironmentConfig); 3] {
        [
            (EnvironmentName::Development, &self.development),
            (EnvironmentName::Staging, &self.staging),
            (EnvironmentName::Production, &self.production),
        ]
    }

    #[must_use]
    pub fn get(&self, name: EnvironmentName) -> &EnvironmentConfig {
        match name {
            EnvironmentName::Development => &self.development,
            EnvironmentName::Staging => &self.staging,
            EnvironmentName::Production => &self.production,
        }
    }
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentName {
    Development,
    Staging,
    Production,
}

impl EnvironmentName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Staging => "staging",
            Self::Production => "production",
        }
    }

    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Development => "开发环境",
            Self::Staging => "测试环境",
            Self::Production => "生产环境",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct EnvironmentConfig {
    pub target: TargetConfig,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub auto_deploy: bool,
    #[serde(default)]
    pub approval_required: bool,
    #[serde(default)]
    pub domains: Vec<DomainRoute>,
    #[serde(default)]
    pub database: Option<DatabaseBinding>,
    #[serde(default)]
    pub redis_namespace: Option<String>,
    #[serde(default)]
    pub secrets_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct TargetConfig {
    pub kind: TargetKind,
    #[serde(default)]
    pub server: Option<String>,
    pub namespace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Local,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct DomainRoute {
    pub service: String,
    pub host: String,
    #[serde(default = "default_route_path")]
    pub path: String,
}

fn default_route_path() -> String {
    "/".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct DatabaseBinding {
    pub name: String,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProviderConfig {
    pub build: BuildProviderConfig,
    pub registry: RegistryConfig,
    #[serde(default)]
    pub reverse_proxy: ReverseProxyProvider,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct BuildProviderConfig {
    #[serde(default)]
    pub kind: BuildProviderKind,
    pub repository: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BuildProviderKind {
    #[default]
    Cnb,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegistryConfig {
    Cnb { repository: String },
    Tcr { registry: String, namespace: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReverseProxyProvider {
    #[default]
    Caddy,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ReleasePolicy {
    #[serde(default = "default_tag_template")]
    pub image_tag_template: String,
    #[serde(default)]
    pub production_mode: ProductionMode,
    #[serde(default = "default_keep_releases")]
    pub keep_releases: u16,
    #[serde(default = "default_true")]
    pub auto_rollback: bool,
    #[serde(default = "default_true")]
    pub backup_before_migration: bool,
}

impl Default for ReleasePolicy {
    fn default() -> Self {
        Self {
            image_tag_template: default_tag_template(),
            production_mode: ProductionMode::Approval,
            keep_releases: default_keep_releases(),
            auto_rollback: true,
            backup_before_migration: true,
        }
    }
}

fn default_tag_template() -> String {
    "sha-{commit}".to_string()
}

const fn default_keep_releases() -> u16 {
    5
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProductionMode {
    Automatic,
    #[default]
    Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct InspectionReport {
    pub project_root: String,
    pub project_name: String,
    pub package_manager: PackageManager,
    pub monorepo: bool,
    pub frameworks: Vec<FrameworkDetection>,
    pub services: Vec<DetectedService>,
    pub prisma_schemas: Vec<String>,
    pub dockerfiles: Vec<String>,
    pub environment_variables: Vec<DetectedEnvironmentVariable>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Bun,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct FrameworkDetection {
    pub framework: Framework,
    pub path: String,
    pub confidence: u8,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Framework {
    NestJs,
    NextJs,
    Vite,
    UniApp,
    Taro,
    Prisma,
    PnpmWorkspace,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct DetectedService {
    pub id: String,
    pub package_name: String,
    pub path: String,
    pub kind: ServiceKind,
    pub framework: Framework,
    pub dockerfile: Option<String>,
    pub suggested_port: u16,
    pub build_command: Option<String>,
    pub confidence: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct DetectedEnvironmentVariable {
    pub name: String,
    pub secret: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct DeploymentPlan {
    pub id: String,
    pub project: String,
    pub generated_at: DateTime<Utc>,
    pub environments: Vec<EnvironmentPlanSummary>,
    pub changes: Vec<FileChange>,
    pub steps: Vec<PlanStep>,
    pub user_actions: Vec<UserAction>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct EnvironmentPlanSummary {
    pub name: EnvironmentName,
    pub branch: Option<String>,
    pub target: String,
    pub automatic: bool,
    pub approval_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    pub after: String,
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeKind {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct PlanStep {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub executor: StepExecutor,
    #[serde(default)]
    pub destructive: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepExecutor {
    Local,
    Cnb,
    Server,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct UserAction {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub category: UserActionCategory,
    pub required: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserActionCategory {
    Authorization,
    Server,
    Dns,
    Secret,
    Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub required_for: String,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct SystemPreflight {
    pub operating_system: String,
    pub architecture: String,
    pub tools: Vec<ToolStatus>,
    pub ready_for_cloud_deploy: bool,
    pub ready_for_local_preview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HealthcheckResult {
    pub url: String,
    pub healthy: bool,
    pub attempts: u16,
    pub status: Option<u16>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProviderCheck {
    pub provider: String,
    pub ok: bool,
    pub summary: String,
    #[serde(default)]
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ValidationIssue {
    pub level: DiagnosticLevel,
    pub code: String,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ReleaseRecord {
    pub id: String,
    pub project: String,
    pub environment: EnvironmentName,
    pub image_digest: String,
    pub status: ReleaseStatus,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub previous_release: Option<String>,
    #[serde(default)]
    pub completed_steps: Vec<String>,
    #[serde(default)]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseStatus {
    Planned,
    Running,
    Healthy,
    Failed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RecoveryPlan {
    pub failed_release: String,
    pub resume_from: Option<String>,
    pub completed_steps: Vec<String>,
    pub rollback_release: Option<ReleaseRecord>,
}
