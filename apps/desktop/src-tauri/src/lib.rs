#![allow(clippy::needless_pass_by_value)] // Tauri IPC commands intentionally deserialize owned arguments and managed state.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write as _};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use deploy_core::error::DeployError;
use deploy_core::manifest::{ManifestValidation, validate_manifest};
use deploy_core::model::{
    DeploymentPlan, DnsProviderHint, DomainRoute, EnvironmentConfig, EnvironmentName, Framework,
    InspectionReport, PackageManager, ProjectManifest, ProviderCheck, PublicRouteStatus,
    RegistryConfig, ServiceKind, SystemPreflight,
};
use deploy_core::plan::serialize_manifest;
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{
    caddy,
    cnb::{
        CnbBuildRecord, CnbClient, build_records, build_revision, build_serial,
        missing_permission_scopes, summarize_build_status,
    },
    docker,
    registry::RegistryProvider,
    ssh,
};
use deploy_core::redact::redact_text;
use deploy_core::render::{
    caddy_partial_route_activation_script, render_deployment_path_bundle, render_project_files,
};
use deploy_core::{
    MANIFEST_FILE, apply_local_plan, apply_plan, apply_setup_plan, build_plan,
    create_default_manifest, inspect_project, load_manifest, parse_manifest,
    reconcile_detected_services, system_command,
};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh_key::{
    Algorithm, HashAlg, LineEnding, PrivateKey,
    rand_core::{OsRng, RngCore},
};
use tauri::{Manager, State};
use zeroize::{Zeroize, Zeroizing};

mod workspace;

use workspace::{
    CNB_SOURCE_CONNECTION_ID, ConfigProfile, ConnectionResource, DeploymentArtifact,
    DeploymentAttempt, DeploymentPath, DeploymentPathInput, DeploymentRun, ProjectAdoptionRecord,
    ProjectConnectionBindings, ProjectEnvironment, ProjectProfileBinding, ProjectRelinkIdentity,
    ProjectVersion, RecentProject, ServerResource, TCR_REGISTRY_CONNECTION_ID, VersionValidation,
    WorkspaceState, project_storage_id,
};

const KEYRING_SERVICE: &str = "cloud.finagent.abcdeploy";
const LEGACY_KEYRING_SERVICE: &str = "com.deploydesk.desktop";
const TCR_SECRET_PREFIX: &str = "registry.tcr.v2";
const CNB_ACCOUNT_CACHE_KEY: &str = "cnb.account.summary";
const CNB_KEYCHAIN_UNAVAILABLE_ERROR: &str =
    "AD-CNB-108：无法读取系统密钥库中的 CNB 授权，请重新打开应用；仍未恢复时更新 CNB 授权";
const CNB_LOGIN_MISSING_ERROR: &str = "CNB 登录已失效，请重新连接后继续";
const LOCAL_POSTGRES_PROFILE_ID: &str = "profile-local-postgres";
const LOCAL_REDIS_PROFILE_ID: &str = "profile-local-redis";
const REMOTE_INFRA_NETWORK: &str = "abcdeploy-infra";
static SECRET_CACHE: OnceLock<Mutex<BTreeMap<String, Zeroizing<String>>>> = OnceLock::new();
static PREVIEW_TUNNELS: OnceLock<Mutex<BTreeMap<String, PreviewTunnelProcess>>> = OnceLock::new();
static LOCAL_START_PROCESSES: OnceLock<Mutex<BTreeMap<String, Option<u32>>>> = OnceLock::new();
static LOCAL_START_CANCELLED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
static KEYCHAIN_WRITE_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

struct PreviewTunnelProcess {
    child: Child,
    known_hosts_path: PathBuf,
}

struct LocalStartTask {
    key: String,
}

impl LocalStartTask {
    fn begin(root: &Path) -> Result<Self, String> {
        let key = root.to_string_lossy().into_owned();
        let mut processes = LOCAL_START_PROCESSES
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .map_err(|_| "AD-LOC-105：无法读取本机启动任务状态，请重新尝试".to_string())?;
        if processes.contains_key(&key) {
            return Err("AD-LOC-119：这个项目已经在启动，请等待完成或先停止本次启动".to_string());
        }
        processes.insert(key.clone(), None);
        drop(processes);
        if let Ok(mut cancelled) = LOCAL_START_CANCELLED
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            cancelled.remove(&key);
        }
        Ok(Self { key })
    }
}

impl Drop for LocalStartTask {
    fn drop(&mut self) {
        if let Ok(mut processes) = LOCAL_START_PROCESSES
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
        {
            processes.remove(&self.key);
        }
        if let Ok(mut cancelled) = LOCAL_START_CANCELLED
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            cancelled.remove(&self.key);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePreview {
    inspection: InspectionReport,
    manifest_yaml: String,
    validation: ManifestValidation,
    plan: DeploymentPlan,
    manifest_exists: bool,
    adoption: ProjectAdoptionPreview,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectAdoptionPreview {
    mode: String,
    detected: bool,
    repository: Option<String>,
    pipeline_exists: bool,
    history_import_after: Option<String>,
    fresh_draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelinkProjectResult {
    path: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    plan_id: String,
    written_files: Vec<String>,
    backup_directory: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStatus {
    key: String,
    stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CnbAccount {
    connected: bool,
    display_name: String,
    username: String,
    default_namespace: String,
    namespaces: Vec<CnbNamespace>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CnbNamespace {
    path: String,
    display_name: String,
    access_role: String,
    can_create_repository: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CnbRepositoryResult {
    repository: String,
    visibility: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerConnectionInput {
    name: String,
    host: String,
    user: String,
    port: u16,
    key_path: String,
    host_fingerprint: Option<String>,
}

impl ServerConnectionInput {
    fn profile(&self) -> ssh::SshProfile {
        ssh::SshProfile {
            name: self.name.clone(),
            host: self.host.clone(),
            user: self.user.clone(),
            port: self.port,
            key_path: PathBuf::from(&self.key_path),
            host_fingerprint: self.host_fingerprint.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineIdentityResult {
    created: bool,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RouteConflict {
    host: String,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteConflictCheck {
    conflicts: Vec<RouteConflict>,
    takeover_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerRouteProblemKind {
    Takeover,
    Repair,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerRouteProblem {
    kind: ServerRouteProblemKind,
    host: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSecretStatus {
    environment: String,
    variable: String,
    stored: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigFile {
    environment: String,
    filename: String,
    source_files: Vec<String>,
    content: String,
    template_content: String,
    required_variables: Vec<String>,
    stored: bool,
    authorization_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigStatus {
    environment: String,
    filename: String,
    stored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigSyncStatus {
    stored: bool,
    synchronized: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExistingProjectConfig {
    source_files: Vec<String>,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigProfileInput {
    id: Option<String>,
    kind: String,
    provider: String,
    name: String,
    #[serde(default = "default_profile_scope")]
    scope: String,
    values: BTreeMap<String, String>,
    secret_fields: Vec<String>,
    secrets: BTreeMap<String, String>,
    is_default: bool,
}

fn default_profile_scope() -> String {
    "any".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigRecommendation {
    content: String,
    applied_profiles: Vec<String>,
    filled_variables: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalEnvWriteResult {
    path: String,
    written: bool,
    requires_confirmation: bool,
    backup_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPreviewService {
    id: String,
    kind: String,
    build_strategy: String,
    dockerfile: String,
    host_port: Option<usize>,
    url: Option<String>,
    running: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPreviewStatus {
    state: String,
    message: String,
    compose_path: String,
    env_ready: bool,
    services: Vec<LocalPreviewService>,
    written_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDevelopmentSupport {
    available: bool,
    service_count: usize,
    message: String,
}

struct LocalDevelopmentService {
    id: String,
    command: String,
    container_port: u16,
    build_target: Option<String>,
    volumes: Vec<serde_json::Value>,
    health_command: String,
}

#[derive(Debug, PartialEq, Eq)]
struct ManagedLocalPortOwner {
    container_id: String,
    project: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalInfrastructureStatus {
    state: String,
    message: String,
    postgres_running: bool,
    redis_running: bool,
    postgres_port: u16,
    redis_port: u16,
    profiles_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CnbSecretBundle {
    environment: String,
    filename: String,
    file_url: String,
    content: String,
    missing_variables: Vec<String>,
    deploy_key_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CnbProjectSetup {
    repository: String,
    created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSyncResult {
    repository: String,
    branch: String,
    commit_sha: String,
    committed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagingPreviewTunnel {
    url: String,
    service: String,
}

struct PipelineIdentityMaterial {
    keyring_key: String,
    private_key: Zeroizing<String>,
    public_key: String,
    fingerprint: String,
    created: bool,
}

#[tauri::command]
fn get_preflight() -> SystemPreflight {
    system_preflight()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn open_project(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspacePreview, String> {
    open_project_preview(PathBuf::from(path), state.inner())
}

fn open_project_preview(root: PathBuf, state: &WorkspaceState) -> Result<WorkspacePreview, String> {
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_exists = manifest_path.is_file();
    let pipeline_exists = root.join(".cnb.yml").is_file();
    let detected = manifest_exists || pipeline_exists;
    let mut recorded_manifest = if manifest_exists {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    if manifest_exists {
        reconcile_detected_services(&inspection, &mut recorded_manifest);
    }
    let repository_hint = repository_identity(&recorded_manifest.providers.build.repository)
        .or_else(|| {
            git_stdout(&root, &["remote", "get-url", "origin"])
                .ok()
                .and_then(|origin| repository_identity(&origin))
        });
    let identity_fingerprint = inspection_identity_fingerprint(&inspection);
    state.remember_project_with_identity(
        &root,
        &inspection.project_name,
        manifest_exists,
        inspection.services.len(),
        repository_hint.as_deref(),
        Some(&identity_fingerprint),
    )?;
    let adoption = state.initialize_project_adoption(&root, detected)?;
    let fresh_draft = adoption.fresh_draft;
    let manifest = if fresh_draft {
        // A reset is a local workflow reset, not permission to overwrite or
        // delete the checked-in deployment manifest. Present a new in-memory
        // draft and keep the recorded manifest solely as adoption evidence.
        create_default_manifest(&inspection)
    } else {
        recorded_manifest
    };
    let validation = validate_manifest(&manifest);
    let manifest_yaml = serialize_manifest(&manifest).map_err(public_error)?;
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    Ok(WorkspacePreview {
        inspection,
        manifest_yaml,
        validation,
        plan,
        // During a reset the checked-in file remains untouched as adoption
        // evidence, but it is not the active ABCDeploy setup. Expose that
        // distinction through `freshDraft` + `detected` instead of making the
        // frontend treat the old file as an already completed setup.
        manifest_exists: manifest_exists && !fresh_draft,
        adoption: adoption_preview(
            adoption,
            detected,
            repository_hint,
            pipeline_exists,
            fresh_draft,
        ),
    })
}

fn adoption_preview(
    adoption: ProjectAdoptionRecord,
    detected: bool,
    repository: Option<String>,
    pipeline_exists: bool,
    fresh_draft: bool,
) -> ProjectAdoptionPreview {
    ProjectAdoptionPreview {
        mode: adoption.mode,
        detected,
        repository,
        pipeline_exists,
        history_import_after: adoption.history_import_after,
        fresh_draft,
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn continue_existing_deployment(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspacePreview, String> {
    let root = PathBuf::from(path);
    state.continue_existing_deployment(&root)?;
    open_project_preview(root, state.inner())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn reset_project_deployment(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspacePreview, String> {
    let root = PathBuf::from(path);
    state.reset_project_deployment(&root)?;
    open_project_preview(root, state.inner())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned paths.
fn relink_project(
    old_path: String,
    new_path: String,
    state: State<'_, WorkspaceState>,
) -> Result<RelinkProjectResult, String> {
    let old_root = PathBuf::from(&old_path);
    if old_root.is_dir() {
        return Err("原项目目录仍然存在，可以直接打开，不需要重新关联".to_string());
    }
    let selected_root = PathBuf::from(&new_path);
    let inspection = inspect_project(&selected_root).map_err(public_error)?;
    let root = PathBuf::from(&inspection.project_root);
    let identity = state.project_relink_identity(&old_root)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_exists = manifest_path.is_file();

    let mut selected_repositories = BTreeSet::new();
    if manifest_exists {
        let manifest = load_manifest(&manifest_path).map_err(public_error)?;
        if let Some(repository) = repository_identity(&manifest.providers.build.repository) {
            selected_repositories.insert(repository);
        }
    }
    if let Ok(origin) = git_stdout(&root, &["remote", "get-url", "origin"])
        && let Some(repository) = repository_identity(&origin)
    {
        selected_repositories.insert(repository);
    }

    validate_project_relink(
        &identity,
        &inspection.project_name,
        inspection.services.len(),
        &inspection_identity_fingerprint(&inspection),
        &selected_repositories,
    )?;

    let path = state.relink_project(
        &old_root,
        &root,
        &inspection.project_name,
        manifest_exists,
        inspection.services.len(),
    )?;
    Ok(RelinkProjectResult {
        path,
        name: inspection.project_name,
    })
}

fn validate_project_relink(
    identity: &ProjectRelinkIdentity,
    selected_name: &str,
    selected_service_count: usize,
    selected_fingerprint: &str,
    selected_repositories: &BTreeSet<String>,
) -> Result<(), String> {
    if let Some(expected_repository) = identity.repository.as_deref().and_then(repository_identity)
    {
        if selected_repositories.is_empty() {
            return Err("所选文件夹缺少原项目的代码仓库信息，无法确认它就是原项目".to_string());
        }
        if !selected_repositories.contains(&expected_repository) {
            return Err("所选文件夹属于另一个代码仓库，请重新选择原项目".to_string());
        }
    } else if let Some(expected_fingerprint) = identity.fingerprint.as_deref() {
        if expected_fingerprint != selected_fingerprint {
            return Err("所选文件夹的项目结构与原记录不一致，请重新选择".to_string());
        }
    } else if identity.name != selected_name
        || identity.service_count != u32::try_from(selected_service_count).unwrap_or(u32::MAX)
    {
        return Err("所选文件夹的项目名称或服务结构与原记录不一致，请重新选择".to_string());
    }
    Ok(())
}

fn inspection_identity_fingerprint(inspection: &InspectionReport) -> String {
    let mut evidence = inspection
        .services
        .iter()
        .map(|service| {
            format!(
                "{}|{:?}|{:?}",
                service.path, service.kind, service.framework
            )
        })
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        evidence.extend(
            inspection
                .frameworks
                .iter()
                .map(|framework| format!("{}|{:?}", framework.path, framework.framework)),
        );
    }
    evidence.sort();
    let mut digest = Sha256::new();
    digest.update(format!(
        "{:?}|{}|",
        inspection.package_manager, inspection.monorepo
    ));
    for item in evidence {
        digest.update(item.as_bytes());
        digest.update(b"\0");
    }
    format!("{:x}", digest.finalize())
}

#[tauri::command]
fn preview_manifest(
    path: String,
    manifest_yaml: String,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspacePreview, String> {
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest =
        parse_manifest(&manifest_yaml, Path::new(MANIFEST_FILE)).map_err(public_error)?;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("部署配置仍有必填项或隔离问题，请先处理校验结果".to_string());
    }
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    let manifest_exists = root.join(MANIFEST_FILE).is_file();
    let pipeline_exists = root.join(".cnb.yml").is_file();
    let detected = manifest_exists || pipeline_exists;
    let adoption = state.project_adoption(&root)?;
    let fresh_draft = adoption.fresh_draft;
    let repository = repository_identity(&manifest.providers.build.repository);
    Ok(WorkspacePreview {
        inspection,
        manifest_yaml,
        validation,
        plan,
        manifest_exists: manifest_exists && !fresh_draft,
        adoption: adoption_preview(adoption, detected, repository, pipeline_exists, fresh_draft),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn apply_manifest(
    path: String,
    manifest_yaml: String,
    confirmed: bool,
    state: State<'_, WorkspaceState>,
) -> Result<ApplyResult, String> {
    if !confirmed {
        return Err("写入前必须查看并确认部署计划".to_string());
    }
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest =
        parse_manifest(&manifest_yaml, Path::new(MANIFEST_FILE)).map_err(public_error)?;
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    let written_files = apply_plan(&root, &plan).map_err(public_error)?;
    state.mark_project_fresh_draft_saved(&root)?;
    state.set_project_step(&root, "workspace")?;
    Ok(ApplyResult {
        plan_id: plan.id.clone(),
        written_files,
        backup_directory: root
            .join(".deploydesk/backups")
            .join(&plan.id)
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn save_manifest_draft(
    path: String,
    manifest_yaml: String,
    state: State<'_, WorkspaceState>,
) -> Result<ApplyResult, String> {
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest =
        parse_manifest(&manifest_yaml, Path::new(MANIFEST_FILE)).map_err(public_error)?;
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;

    // Configuration screens save frequently. They must never replace a project's
    // working pipeline before the user explicitly starts the first test deployment.
    // The full apply path still writes `.cnb.yml` immediately before source sync.
    let written_files = apply_setup_plan(&root, &plan).map_err(public_error)?;
    state.mark_project_fresh_draft_saved(&root)?;
    state.set_project_step(&root, "workspace")?;
    Ok(ApplyResult {
        plan_id: plan.id.clone(),
        written_files,
        backup_directory: root
            .join(".deploydesk/backups")
            .join(&plan.id)
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_recent_projects(state: State<'_, WorkspaceState>) -> Result<Vec<RecentProject>, String> {
    state.list_projects()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn save_project_step(
    path: String,
    step: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    state.set_project_step(Path::new(&path), &step)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn forget_project(path: String, state: State<'_, WorkspaceState>) -> Result<bool, String> {
    state.remove_project(Path::new(&path))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_servers(state: State<'_, WorkspaceState>) -> Result<Vec<ServerResource>, String> {
    state.list_servers()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn get_project_server(
    path: String,
    environment: String,
    state: State<'_, WorkspaceState>,
) -> Result<Option<ServerResource>, String> {
    state.server_for_project(Path::new(&path), &environment)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn bind_project_server(
    path: String,
    environment: String,
    server: ServerConnectionInput,
    state: State<'_, WorkspaceState>,
) -> Result<ServerResource, String> {
    state.bind_project_server(Path::new(&path), &environment, &server.profile())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn get_app_setting(
    key: String,
    state: State<'_, WorkspaceState>,
) -> Result<Option<String>, String> {
    state.setting(&key)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri deserializes the requested keys.
fn get_app_settings(
    keys: Vec<String>,
    state: State<'_, WorkspaceState>,
) -> Result<BTreeMap<String, String>, String> {
    if keys.len() > 256
        || keys
            .iter()
            .any(|key| key.is_empty() || key.len() > 512 || key.chars().any(char::is_control))
    {
        return Err("批量读取的应用设置名称不正确".to_string());
    }
    let unique = keys
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    state.settings(&unique)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn set_app_setting(
    key: String,
    value: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    state.set_setting(&key, &value)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StoredCredentialPresence {
    Present,
    Missing,
    Unavailable,
}

fn stored_credential_presence(key: &str) -> StoredCredentialPresence {
    match read_keyring_secret_without_prompt(key) {
        Ok(mut value) => {
            let presence = if value.is_empty() {
                StoredCredentialPresence::Missing
            } else {
                StoredCredentialPresence::Present
            };
            value.zeroize();
            presence
        }
        Err(error) if error == "missing" => StoredCredentialPresence::Missing,
        Err(_) => StoredCredentialPresence::Unavailable,
    }
}

fn reconcile_compat_connections(state: &WorkspaceState) -> Result<(), String> {
    let account = cached_cnb_account(state);
    let cnb_present = stored_credential_presence("cnb-token");
    let existing_cnb = state
        .list_connections(Some("source"))?
        .into_iter()
        .find(|connection| connection.id == CNB_SOURCE_CONNECTION_ID);
    let cnb_exists = existing_cnb.is_some();
    if account.is_some() || cnb_present == StoredCredentialPresence::Present || cnb_exists {
        let mut metadata =
            BTreeMap::from([("endpoint".to_string(), "https://cnb.cool".to_string())]);
        let name = if let Some(account) = account.as_ref() {
            if !account.username.is_empty() {
                metadata.insert("username".to_string(), account.username.clone());
            }
            if !account.default_namespace.is_empty() {
                metadata.insert("namespace".to_string(), account.default_namespace.clone());
            }
            format!(
                "CNB · {}",
                account.display_name.chars().take(60).collect::<String>()
            )
        } else {
            existing_cnb
                .as_ref()
                .map_or_else(|| "CNB".to_string(), |connection| connection.name.clone())
        };
        let status = match cnb_present {
            StoredCredentialPresence::Present
                if existing_cnb
                    .as_ref()
                    .is_some_and(|connection| connection.status == "ready") =>
            {
                "ready"
            }
            StoredCredentialPresence::Present => "configured",
            StoredCredentialPresence::Missing => "needs_authorization",
            StoredCredentialPresence::Unavailable => existing_cnb
                .as_ref()
                .map_or("unknown", |connection| connection.status.as_str()),
        };
        state.upsert_compat_connection(
            CNB_SOURCE_CONNECTION_ID,
            "source",
            "cnb",
            &name,
            Some("cnb-token"),
            &metadata,
            &[
                "repositories".to_string(),
                "builds".to_string(),
                "automation".to_string(),
            ],
            status,
            None,
        )?;
    }

    let settings = state.settings(&[
        "registry.mode".to_string(),
        "registry.tcr.namespace".to_string(),
        "registry.tcr.v2.verified-endpoint".to_string(),
    ])?;
    let username_present = stored_credential_presence("registry.tcr.v2.username");
    let password_present = stored_credential_presence("registry.tcr.v2.password");
    let existing_tcr = state
        .list_connections(Some("registry"))?
        .into_iter()
        .find(|connection| connection.id == TCR_REGISTRY_CONNECTION_ID);
    let tcr_exists = existing_tcr.is_some();
    let has_tcr_fact = settings
        .get("registry.mode")
        .is_some_and(|value| value == "tcr")
        || settings
            .get("registry.tcr.namespace")
            .is_some_and(|value| !value.trim().is_empty())
        || settings
            .get("registry.tcr.v2.verified-endpoint")
            .is_some_and(|value| valid_registry_host(value))
        || username_present == StoredCredentialPresence::Present
        || password_present == StoredCredentialPresence::Present
        || tcr_exists;
    if has_tcr_fact {
        let endpoint = settings
            .get("registry.tcr.v2.verified-endpoint")
            .map(String::as_str)
            .filter(|value| valid_registry_host(value))
            .unwrap_or("ccr.ccs.tencentyun.com");
        let mut metadata = BTreeMap::from([("endpoint".to_string(), endpoint.to_string())]);
        if let Some(namespace) = settings
            .get("registry.tcr.namespace")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && value.len() <= 240)
        {
            metadata.insert("namespace".to_string(), namespace.to_string());
        }
        let status = match (username_present, password_present) {
            (StoredCredentialPresence::Present, StoredCredentialPresence::Present)
                if existing_tcr
                    .as_ref()
                    .is_some_and(|connection| connection.status == "ready") =>
            {
                "ready"
            }
            (StoredCredentialPresence::Present, StoredCredentialPresence::Present) => "configured",
            (StoredCredentialPresence::Unavailable, _)
            | (_, StoredCredentialPresence::Unavailable) => existing_tcr
                .as_ref()
                .map_or("unknown", |connection| connection.status.as_str()),
            _ => "needs_authorization",
        };
        state.upsert_compat_connection(
            TCR_REGISTRY_CONNECTION_ID,
            "registry",
            "tcr",
            "腾讯云 TCR",
            Some("registry.tcr.v2.password"),
            &metadata,
            &["push".to_string(), "pull".to_string()],
            status,
            None,
        )?;
    }
    Ok(())
}

fn mark_cnb_connection_ready(state: &WorkspaceState, account: &CnbAccount) -> Result<(), String> {
    let mut metadata = BTreeMap::from([("endpoint".to_string(), "https://cnb.cool".to_string())]);
    if !account.username.trim().is_empty() {
        metadata.insert("username".to_string(), account.username.trim().to_string());
    }
    if !account.default_namespace.trim().is_empty() {
        metadata.insert(
            "namespace".to_string(),
            account.default_namespace.trim().to_string(),
        );
    }
    let display_name = account
        .display_name
        .trim()
        .chars()
        .take(60)
        .collect::<String>();
    let name = if display_name.is_empty() {
        "CNB".to_string()
    } else {
        format!("CNB · {display_name}")
    };
    let checked_at = Utc::now().to_rfc3339();
    state.upsert_compat_connection(
        CNB_SOURCE_CONNECTION_ID,
        "source",
        "cnb",
        &name,
        Some("cnb-token"),
        &metadata,
        &[
            "repositories".to_string(),
            "builds".to_string(),
            "automation".to_string(),
        ],
        "ready",
        Some(&checked_at),
    )
}

fn reconcile_project_connection_bindings(
    path: &Path,
    state: &WorkspaceState,
) -> Result<(), String> {
    let manifest_path = path.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Ok(());
    }
    let manifest = load_manifest(&manifest_path).map_err(public_error)?;
    if !state.connection_exists(CNB_SOURCE_CONNECTION_ID)? {
        let metadata = BTreeMap::from([
            ("endpoint".to_string(), "https://cnb.cool".to_string()),
            (
                "repository".to_string(),
                manifest.providers.build.repository.clone(),
            ),
        ]);
        state.upsert_compat_connection(
            CNB_SOURCE_CONNECTION_ID,
            "source",
            "cnb",
            "CNB",
            Some("cnb-token"),
            &metadata,
            &[
                "repositories".to_string(),
                "builds".to_string(),
                "automation".to_string(),
            ],
            "needs_authorization",
            None,
        )?;
    }
    state.bind_project_source_connection(path, Some(CNB_SOURCE_CONNECTION_ID))?;

    if let RegistryConfig::Tcr {
        registry,
        namespace,
    } = &manifest.providers.registry
    {
        let existing = state
            .list_connections(Some("registry"))?
            .into_iter()
            .find(|connection| connection.id == TCR_REGISTRY_CONNECTION_ID);
        let mut metadata = existing
            .as_ref()
            .map(|connection| connection.metadata.clone())
            .unwrap_or_default();
        metadata.insert("endpoint".to_string(), registry.clone());
        metadata.insert("namespace".to_string(), namespace.clone());
        state.upsert_compat_connection(
            TCR_REGISTRY_CONNECTION_ID,
            "registry",
            "tcr",
            "腾讯云 TCR",
            Some("registry.tcr.v2.password"),
            &metadata,
            &["push".to_string(), "pull".to_string()],
            existing
                .as_ref()
                .map_or("needs_authorization", |connection| {
                    connection.status.as_str()
                }),
            existing
                .as_ref()
                .and_then(|connection| connection.last_checked_at.as_deref()),
        )?;
        for environment in ["staging", "production"] {
            state.bind_project_registry_connection(
                path,
                environment,
                Some(TCR_REGISTRY_CONNECTION_ID),
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_connections(
    kind: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<ConnectionResource>, String> {
    reconcile_compat_connections(state.inner())?;
    let kind = kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    state.list_connections(kind)
}

#[tauri::command]
fn get_project_connection_bindings(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProjectConnectionBindings, String> {
    let path = PathBuf::from(path);
    reconcile_compat_connections(state.inner())?;
    if state.project_adoption(&path)?.mode == "managed" {
        reconcile_project_connection_bindings(&path, state.inner())?;
    }
    state.project_connection_bindings(&path)
}

#[tauri::command]
fn list_deployment_paths(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentPath>, String> {
    state.list_deployment_paths(Path::new(&path))
}

#[tauri::command]
fn list_deployment_path_runs(
    path_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_deployment_path_runs(&path_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn save_deployment_path(
    input: DeploymentPathInput,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentPath, String> {
    reconcile_compat_connections(state.inner())?;
    state.save_deployment_path(input)
}

#[tauri::command]
fn delete_deployment_path(
    project_path: String,
    path_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    state.delete_deployment_path(Path::new(&project_path), &path_id)
}

#[tauri::command]
async fn redeploy_deployment_path_version(
    path_id: String,
    source_run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let path = state.deployment_path_by_id(&path_id)?;
    let source = state
        .list_deployment_path_runs(&path_id)?
        .into_iter()
        .find(|run| run.id == source_run_id)
        .ok_or_else(|| "所选版本不属于当前部署线路".to_string())?;
    if source.status != "success" || source.artifacts.is_empty() || source.commit_sha.is_none() {
        return Err("只有已经上线并验证通过的完整版本才能重新部署".to_string());
    }
    let mut run = state.create_deployment_run(
        Path::new(&path.project_path),
        &source.project_name,
        "deployment",
        &source.repository,
        &source.branch,
    )?;
    run.commit_sha.clone_from(&source.commit_sha);
    run.source_title.clone_from(&source.source_title);
    run.source_run_id = Some(source.id);
    run.candidate_tag.clone_from(&source.candidate_tag);
    run.artifacts.clone_from(&source.artifacts);
    run.status = "running".to_string();
    run.current_stage = "deploy".to_string();
    run.message = "正在把所选历史版本重新部署到运行服务器".to_string();
    run.completed_steps = vec!["build".to_string(), "registry".to_string()];
    state.save_deployment_run(&run)?;
    state.bind_deployment_path_run(&path_id, &run.id)?;
    state.begin_deployment_attempt(&run.id)?;
    if let Err(message) = deploy_deployment_path_to_server(&run, &path, state.inner()).await {
        pause_deployment_path_after_deploy_error(&mut run, &message);
        state.save_deployment_run(&run)?;
        return Ok(run);
    }
    verify_deployment_path(&mut run, &path, state.inner()).await?;
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_config_profiles(state: State<'_, WorkspaceState>) -> Result<Vec<ConfigProfile>, String> {
    let mut profiles = state.list_config_profiles()?;
    for profile in &mut profiles {
        profile.configured_secret_fields = profile
            .secret_fields
            .iter()
            .filter(|field| {
                read_keyring_secret_without_prompt(&config_profile_secret_key(&profile.id, field))
                    .is_ok_and(|mut value| {
                        let configured = !value.is_empty();
                        value.zeroize();
                        configured
                    })
            })
            .cloned()
            .collect();
    }
    Ok(profiles)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned input.
fn save_config_profile(
    mut input: ConfigProfileInput,
    state: State<'_, WorkspaceState>,
) -> Result<ConfigProfile, String> {
    input.kind = input.kind.trim().to_ascii_lowercase();
    input.provider = input.provider.trim().to_ascii_lowercase();
    input.name = input.name.trim().to_string();
    input.scope = input.scope.trim().to_ascii_lowercase();
    input.secret_fields.sort();
    input.secret_fields.dedup();
    if !matches!(
        input.kind.as_str(),
        "ai" | "database" | "redis" | "dns" | "registry" | "custom"
    ) || !valid_config_identifier(&input.provider)
        || !matches!(input.scope.as_str(), "any" | "local" | "remote")
        || input.name.is_empty()
        || input.name.len() > 80
        || input.name.chars().any(char::is_control)
        || input.values.len() > 40
        || input.secret_fields.len() > 40
        || input
            .values
            .keys()
            .chain(input.secret_fields.iter())
            .any(|field| !valid_config_identifier(field))
    {
        return Err("配置中心连接的名称或字段格式不正确".to_string());
    }
    let id = input.id.unwrap_or_else(|| {
        let seed = format!(
            "{}:{}:{}:{}",
            input.kind,
            input.provider,
            input.name,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let mut digest = Sha256::new();
        digest.update(seed.as_bytes());
        let digest = format!("{:x}", digest.finalize());
        format!("profile-{}", &digest[..24])
    });
    if !valid_config_identifier(&id) {
        return Err("配置中心连接编号格式不正确".to_string());
    }
    let existing = state.config_profile(&id)?;
    if existing
        .as_ref()
        .is_some_and(|profile| profile.kind != input.kind)
    {
        return Err("已有连接不能修改为其他类型，请新建连接".to_string());
    }
    let existing_profiles = state.list_config_profiles()?;
    let is_default = input.is_default
        || !existing_profiles
            .iter()
            .any(|profile| profile.kind == input.kind && profile.scope == input.scope)
        || existing.as_ref().is_some_and(|profile| {
            profile.is_default
                && !existing_profiles.iter().any(|candidate| {
                    candidate.kind == input.kind
                        && candidate.scope == input.scope
                        && candidate.id != profile.id
                        && candidate.is_default
                })
        });
    for field in input.secrets.keys() {
        if !input.secret_fields.contains(field) {
            return Err("敏感配置字段与连接模板不一致".to_string());
        }
    }
    for (field, value) in &mut input.secrets {
        if value.is_empty() {
            continue;
        }
        let result = write_keyring_secret(&config_profile_secret_key(&id, field), value);
        value.zeroize();
        result?;
    }
    let profile = ConfigProfile {
        id,
        kind: input.kind,
        provider: input.provider,
        name: input.name,
        scope: input.scope,
        values: input.values,
        secret_fields: input.secret_fields,
        configured_secret_fields: Vec::new(),
        is_default,
        updated_at: Utc::now().to_rfc3339(),
    };
    state.save_config_profile(&profile)?;
    list_config_profiles(state)?
        .into_iter()
        .find(|candidate| candidate.id == profile.id)
        .ok_or_else(|| "连接保存后无法读取，请重新尝试".to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn delete_config_profile(id: String, state: State<'_, WorkspaceState>) -> Result<bool, String> {
    let Some(profile) = state.config_profile(&id)? else {
        return Ok(false);
    };
    for field in profile.secret_fields {
        delete_keyring_secret(&config_profile_secret_key(&id, &field))?;
    }
    state.remove_config_profile(&id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn bind_config_profile(
    path: String,
    environment: String,
    kind: String,
    profile_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProjectProfileBinding, String> {
    state.bind_config_profile(Path::new(&path), &environment, &kind, &profile_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn list_config_profile_bindings(
    path: String,
    environment: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<ProjectProfileBinding>, String> {
    state.config_profile_bindings(Path::new(&path), &environment)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn set_environment_config_bindings(
    path: String,
    environment: String,
    profile_ids: Vec<String>,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<ProjectProfileBinding>, String> {
    state.set_environment_config_bindings(Path::new(&path), &environment, &profile_ids)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn recommend_runtime_config(
    path: String,
    environment: String,
    profile_ids: Vec<String>,
    content: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<RuntimeConfigRecommendation, String> {
    let runtime_environment = parse_runtime_environment(&environment)?;
    let stored_content = if content.is_none() {
        Some(load_runtime_config(
            path.clone(),
            environment.clone(),
            true,
        )?)
    } else {
        None
    };
    let all_profiles = list_config_profiles(state)?;
    let selected = if profile_ids.is_empty() {
        all_profiles
            .iter()
            .filter(|profile| {
                profile.is_default && profile_scope_supports(profile, runtime_environment)
            })
            .collect::<Vec<_>>()
    } else {
        profile_ids
            .iter()
            .map(|id| {
                all_profiles
                    .iter()
                    .find(|profile| &profile.id == id)
                    .ok_or_else(|| "所选配置中心连接已不存在".to_string())
                    .and_then(|profile| {
                        profile_scope_supports(profile, runtime_environment)
                            .then_some(profile)
                            .ok_or_else(|| "所选连接不适用于当前运行环境".to_string())
                    })
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut suggestions = BTreeMap::new();
    let mut applied_profiles = Vec::new();
    for profile in selected {
        let profile_values =
            runtime_values_from_profile(profile, Path::new(&path), runtime_environment)?;
        if !profile_values.is_empty() {
            suggestions.extend(profile_values);
            applied_profiles.push(profile.name.clone());
        }
    }
    let source = content
        .as_deref()
        .or_else(|| {
            stored_content
                .as_ref()
                .map(|current| current.content.as_str())
        })
        .ok_or_else(|| "无法读取当前运行配置".to_string())?;
    for variable in empty_runtime_variables(source) {
        if internal_runtime_secret(&variable) && !suggestions.contains_key(&variable) {
            let value = load_or_generate_runtime_secret(Path::new(&path), &environment, &variable)?;
            suggestions.insert(variable, value.to_string());
        }
    }
    let (content, filled_variables) = fill_empty_runtime_values(source, &suggestions);
    Ok(RuntimeConfigRecommendation {
        content,
        applied_profiles,
        filled_variables,
    })
}

fn profile_scope_supports(profile: &ConfigProfile, environment: EnvironmentName) -> bool {
    profile.scope == "any"
        || (profile.scope == "local" && environment == EnvironmentName::Development)
        || (profile.scope == "remote" && environment != EnvironmentName::Development)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned command arguments.
fn write_local_env(
    path: String,
    content: String,
    overwrite: bool,
) -> Result<LocalEnvWriteResult, String> {
    write_project_local_env(Path::new(&path), &content, overwrite)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects app and managed state by value.
async fn get_local_infrastructure_status(
    app: tauri::AppHandle,
) -> Result<LocalInfrastructureStatus, String> {
    let directory = app.path().app_data_dir().map_err(public_error)?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<WorkspaceState>();
        local_infrastructure_status(&directory, &state)
    })
    .await
    .map_err(|_| "AD-INF-101：读取本机运行依赖状态时任务意外中断".to_string())?
}

#[tauri::command]
async fn prepare_local_infrastructure(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<LocalInfrastructureStatus, String> {
    let directory = app.path().app_data_dir().map_err(public_error)?;
    let infra_directory = directory.join("local-infrastructure");
    fs::create_dir_all(&infra_directory).map_err(public_error)?;
    let compose_path = infra_directory.join("docker-compose.yml");
    fs::write(&compose_path, local_infrastructure_compose()).map_err(public_error)?;

    let postgres_port = local_infrastructure_port(
        &state,
        "local.infra.postgres.port",
        55_432,
        "abcdeploy-local-postgres",
    )?;
    let redis_port = local_infrastructure_port(
        &state,
        "local.infra.redis.port",
        56_379,
        "abcdeploy-local-redis",
    )?;
    let postgres_password = local_infrastructure_secret("local.infra.postgres.password")?;
    let redis_password = local_infrastructure_secret("local.infra.redis.password")?;
    let command_directory = infra_directory.clone();
    let command_compose = compose_path.clone();
    let postgres_secret = postgres_password.clone();
    let redis_secret = redis_password.clone();
    let output = tokio::task::spawn_blocking(move || {
        system_command("docker")
            .current_dir(command_directory)
            .args(["compose", "-f"])
            .arg(command_compose)
            .args(["up", "-d", "--wait", "--wait-timeout", "180"])
            .env("POSTGRES_PORT", postgres_port.to_string())
            .env("REDIS_PORT", redis_port.to_string())
            .env("POSTGRES_USER", "abcdeploy")
            .env("POSTGRES_PASSWORD", postgres_secret.as_str())
            .env("REDIS_PASSWORD", redis_secret.as_str())
            .output()
    })
    .await
    .map_err(|_| "AD-INF-101：本机基础服务启动任务意外中断".to_string())?
    .map_err(|error| format!("AD-INF-101：无法运行 Docker：{}", public_error(error)))?;
    if !output.status.success() {
        return Err(local_infrastructure_failure(&output));
    }
    save_local_infrastructure_profiles(
        &state,
        postgres_port,
        redis_port,
        &postgres_password,
        &redis_password,
    )?;
    local_infrastructure_status(&directory, &state)
}

#[tauri::command]
fn prepare_local_preview(path: String) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, plan) = local_project_plan(&root)?;
    let written_files = apply_local_plan(&root, &plan).map_err(public_error)?;
    Ok(local_preview_status(
        &root,
        &inspection,
        &manifest,
        written_files,
    ))
}

#[tauri::command]
fn get_local_development_support(path: String) -> Result<LocalDevelopmentSupport, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, _) = local_project_plan(&root)?;
    let services = local_development_services(&root, &inspection, &manifest);
    let runnable_count = manifest.services.len();
    let available = runnable_count > 0 && services.len() == runnable_count;
    Ok(LocalDevelopmentSupport {
        available,
        service_count: services.len(),
        message: if available {
            "修改代码后会自动重启后端或刷新网页，仅影响本机运行。".to_string()
        } else {
            "项目没有为全部服务提供可靠的开发命令，继续使用稳定运行。".to_string()
        },
    })
}

#[tauri::command]
fn prepare_local_development(path: String) -> Result<LocalDevelopmentSupport, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, plan) = local_project_plan(&root)?;
    apply_local_plan(&root, &plan).map_err(public_error)?;
    let services = local_development_services(&root, &inspection, &manifest);
    if services.len() != manifest.services.len() {
        return Err("AD-LOC-115：项目没有为全部服务提供可靠的开发命令，请使用稳定运行".to_string());
    }
    write_local_development_compose(&root, &inspection, &manifest)?;
    Ok(LocalDevelopmentSupport {
        available: true,
        service_count: services.len(),
        message: format!(
            "已为 {} 个服务准备自动刷新，仅影响本机运行。",
            services.len()
        ),
    })
}

#[tauri::command]
async fn start_local_preview(
    state: State<'_, WorkspaceState>,
    path: String,
    development_mode: bool,
) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, plan) = local_project_plan(&root)?;
    let written_files = apply_local_plan(&root, &plan).map_err(public_error)?;
    if !root.join(".env").is_file() {
        return Err(
            "AD-LOC-104：项目还没有 .env，请先保存本地配置并点击“生成项目 .env”".to_string(),
        );
    }
    write_container_runtime_env(&root)?;
    let runnable_services = runnable_local_service_ids(&local_preview_status(
        &root,
        &inspection,
        &manifest,
        Vec::new(),
    ));
    if runnable_services.is_empty() {
        return Err(
            "AD-LOC-111：项目没有可以安全启动的服务，请先让开发工具补充运行配置".to_string(),
        );
    }
    let compose_path = if development_mode {
        write_local_development_compose(&root, &inspection, &manifest)?
    } else {
        local_compose_path(&root)
    };
    ensure_local_service_ports_available(&root, &inspection, &manifest, &runnable_services)?;
    let local_task = LocalStartTask::begin(&root)?;
    let task_key = local_task.key.clone();
    let build_services = if development_mode {
        local_development_build_services(&root, &inspection, &manifest)
    } else {
        runnable_services.clone()
    };
    if !development_mode || !build_services.is_empty() {
        let use_public_generated_images =
            services_use_public_generated_dockerfiles(&manifest, &build_services);
        let preferred_clear_proxy = preferred_local_build_clear_proxy(&state);
        let build_root = root.clone();
        let build_compose = compose_path.clone();
        let initial_services = build_services.clone();
        let build_task_key = task_key.clone();
        let build_result = tokio::task::spawn_blocking(move || {
            run_local_compose_build_with_recovery(
                &build_root,
                &build_compose,
                &build_task_key,
                preferred_clear_proxy,
                false,
                &initial_services,
                use_public_generated_images,
            )
        })
        .await
        .map_err(|_| "AD-LOC-105：本地容器任务意外中断，请重新尝试".to_string())?
        .map_err(local_command_error)?;
        remember_local_build_proxy_mode(&state, &build_result);
        if !build_result.output.status.success() {
            return Err(local_build_failure(&build_result.output));
        }
    }

    let root_for_command = root.clone();
    let compose_for_command = compose_path.clone();
    let up_task_key = task_key.clone();
    let services_to_start = runnable_services.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = system_command("docker");
        command
            .current_dir(&root_for_command)
            .args(["compose", "-f"])
            .arg(&compose_for_command)
            .args(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
        command.args(services_to_start);
        run_tracked_local_command(&up_task_key, &mut command, local_start_command_limits())
    })
    .await
    .map_err(|_| "AD-LOC-105：本地容器启动任务意外中断".to_string())?
    .map_err(local_command_error)?;
    if !output.status.success() {
        return Err(local_start_failure(&output));
    }
    Ok(local_preview_status(
        &root,
        &inspection,
        &manifest,
        written_files,
    ))
}

#[tauri::command]
async fn start_local_preview_service(
    state: State<'_, WorkspaceState>,
    path: String,
    service_id: String,
    development_mode: bool,
) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, plan) = local_project_plan(&root)?;
    if !manifest
        .services
        .iter()
        .any(|service| service.id == service_id)
    {
        return Err("AD-LOC-114：找不到要启动的项目服务，请重新识别项目".to_string());
    }
    let written_files = apply_local_plan(&root, &plan).map_err(public_error)?;
    if !root.join(".env").is_file() {
        return Err("AD-LOC-104：项目还没有 .env，请先保存本机配置".to_string());
    }
    write_container_runtime_env(&root)?;
    let compose_path = if development_mode {
        write_local_development_compose(&root, &inspection, &manifest)?
    } else {
        local_compose_path(&root)
    };
    ensure_local_service_ports_available(
        &root,
        &inspection,
        &manifest,
        std::slice::from_ref(&service_id),
    )?;
    let local_task = LocalStartTask::begin(&root)?;
    let task_key = local_task.key.clone();
    let build_services = if development_mode {
        local_development_build_services(&root, &inspection, &manifest)
            .into_iter()
            .filter(|candidate| candidate == &service_id)
            .collect::<Vec<_>>()
    } else {
        vec![service_id.clone()]
    };
    if !build_services.is_empty() {
        let use_public_generated_images =
            services_use_public_generated_dockerfiles(&manifest, &build_services);
        let preferred_clear_proxy = preferred_local_build_clear_proxy(&state);
        let build_root = root.clone();
        let build_compose = compose_path.clone();
        let build_task_key = task_key.clone();
        let build_result = tokio::task::spawn_blocking(move || {
            run_local_compose_build_with_recovery(
                &build_root,
                &build_compose,
                &build_task_key,
                preferred_clear_proxy,
                true,
                &build_services,
                use_public_generated_images,
            )
        })
        .await
        .map_err(|_| "AD-LOC-105：本地服务构建任务意外中断".to_string())?
        .map_err(local_command_error)?;
        remember_local_build_proxy_mode(&state, &build_result);
        if !build_result.output.status.success() {
            return Err(local_build_failure(&build_result.output));
        }
    }
    let root_for_command = root.clone();
    let compose_for_command = compose_path.clone();
    let up_task_key = task_key.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = system_command("docker");
        command
            .current_dir(root_for_command)
            .args(["compose", "-f"])
            .arg(compose_for_command)
            .args(["up", "-d", "--no-build"]);
        command
            .args(["--wait", "--wait-timeout", "180"])
            .arg(service_id);
        run_tracked_local_command(&up_task_key, &mut command, local_start_command_limits())
    })
    .await
    .map_err(|_| "AD-LOC-105：本地服务启动任务意外中断".to_string())?
    .map_err(local_command_error)?;
    if !output.status.success() {
        return Err(local_start_failure(&output));
    }
    Ok(local_preview_status(
        &root,
        &inspection,
        &manifest,
        written_files,
    ))
}

#[tauri::command]
fn get_local_preview_status(path: String) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let (inspection, manifest, plan) = local_project_plan(&root)?;
    Ok(planned_local_preview_status(
        &root,
        &inspection,
        &manifest,
        &plan,
        Vec::new(),
    ))
}

#[tauri::command]
fn cancel_local_preview_start(path: String) -> Result<bool, String> {
    let key = PathBuf::from(path).to_string_lossy().into_owned();
    let active = LOCAL_START_PROCESSES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "AD-LOC-105：无法读取本机启动任务状态，请重新尝试".to_string())?
        .contains_key(&key);
    if !active {
        return Ok(false);
    }
    LOCAL_START_CANCELLED
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| "AD-LOC-105：无法停止本机启动任务，请重新尝试".to_string())?
        .insert(key);
    Ok(true)
}

#[tauri::command]
fn stop_managed_local_port_owner(port: u16) -> Result<String, String> {
    let owner = managed_local_port_owner(port).ok_or_else(|| {
        format!("AD-LOC-116：本机端口 {port} 仍被其他程序占用，请关闭占用程序后重新启动")
    })?;
    let output = system_command("docker")
        .args(["stop", &owner.container_id])
        .output()
        .map_err(|_| "AD-LOC-121：无法自动停止占用端口的本机服务，请稍后重试".to_string())?;
    if !output.status.success() {
        return Err("AD-LOC-121：无法自动停止占用端口的本机服务，请稍后重试".to_string());
    }
    Ok(owner.project)
}

#[tauri::command]
async fn stop_local_preview(path: String) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let mut manifest = if manifest_path.is_file() {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    reconcile_detected_services(&inspection, &mut manifest);
    let compose_path = local_compose_path(&root);
    if compose_path.is_file() {
        let root_for_command = root.clone();
        let compose_for_command = compose_path.clone();
        let output = tokio::task::spawn_blocking(move || {
            system_command("docker")
                .current_dir(&root_for_command)
                .args(["compose", "-f"])
                .arg(&compose_for_command)
                .args(["down", "--remove-orphans"])
                .output()
        })
        .await
        .map_err(|_| "AD-LOC-108：停止本地容器时任务意外中断".to_string())?
        .map_err(|error| format!("AD-LOC-106：无法运行 Docker：{}", public_error(error)))?;
        if !output.status.success() {
            return Err("AD-LOC-109：本地容器没有全部停止，请检查 Docker 状态".to_string());
        }
    }
    Ok(local_preview_status(
        &root,
        &inspection,
        &manifest,
        Vec::new(),
    ))
}

#[tauri::command]
async fn stop_local_preview_service(
    path: String,
    service_id: String,
) -> Result<LocalPreviewStatus, String> {
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let mut manifest = if manifest_path.is_file() {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    reconcile_detected_services(&inspection, &mut manifest);
    if !manifest
        .services
        .iter()
        .any(|service| service.id == service_id)
    {
        return Err("AD-LOC-114：找不到要停止的项目服务，请重新识别项目".to_string());
    }
    let compose_path = local_compose_path(&root);
    if compose_path.is_file() {
        let root_for_command = root.clone();
        let compose_for_command = compose_path.clone();
        let output = tokio::task::spawn_blocking(move || {
            system_command("docker")
                .current_dir(root_for_command)
                .args(["compose", "-f"])
                .arg(compose_for_command)
                .arg("stop")
                .arg(service_id)
                .output()
        })
        .await
        .map_err(|_| "AD-LOC-108：停止本地服务时任务意外中断".to_string())?
        .map_err(|error| format!("AD-LOC-106：无法运行 Docker：{}", public_error(error)))?;
        if !output.status.success() {
            return Err("AD-LOC-109：本地服务没有停止，请检查 Docker 状态".to_string());
        }
    }
    Ok(local_preview_status(
        &root,
        &inspection,
        &manifest,
        Vec::new(),
    ))
}

#[tauri::command]
async fn set_local_infrastructure_service(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    service: String,
    running: bool,
) -> Result<LocalInfrastructureStatus, String> {
    if !matches!(service.as_str(), "postgres" | "redis") {
        return Err("AD-INF-106：找不到要控制的本机基础服务".to_string());
    }
    let directory = app.path().app_data_dir().map_err(public_error)?;
    let infra_directory = directory.join("local-infrastructure");
    let compose_path = infra_directory.join("docker-compose.yml");
    if !compose_path.is_file() {
        return Err("AD-INF-107：请先自动准备本机运行依赖".to_string());
    }
    let postgres_port = local_infrastructure_port(
        &state,
        "local.infra.postgres.port",
        55_432,
        "abcdeploy-local-postgres",
    )?;
    let redis_port = local_infrastructure_port(
        &state,
        "local.infra.redis.port",
        56_379,
        "abcdeploy-local-redis",
    )?;
    let postgres_password = local_infrastructure_secret("local.infra.postgres.password")?;
    let redis_password = local_infrastructure_secret("local.infra.redis.password")?;
    let output = tokio::task::spawn_blocking(move || {
        let mut command = system_command("docker");
        command
            .current_dir(infra_directory)
            .args(["compose", "-f"])
            .arg(compose_path);
        if running {
            command.args(["up", "-d", "--wait", "--wait-timeout", "180"]);
        } else {
            command.arg("stop");
        }
        command
            .arg(service)
            .env("POSTGRES_PORT", postgres_port.to_string())
            .env("REDIS_PORT", redis_port.to_string())
            .env("POSTGRES_USER", "abcdeploy")
            .env("POSTGRES_PASSWORD", postgres_password.as_str())
            .env("REDIS_PASSWORD", redis_password.as_str())
            .output()
    })
    .await
    .map_err(|_| "AD-INF-101：本机基础服务任务意外中断".to_string())?
    .map_err(|error| format!("AD-INF-101：无法运行 Docker：{}", public_error(error)))?;
    if !output.status.success() {
        return Err(local_infrastructure_failure(&output));
    }
    local_infrastructure_status(&directory, &state)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn create_deployment_task(
    path: String,
    environment: String,
    source_run_id: Option<String>,
    deployment_path_id: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    create_deployment_task_inner(
        path,
        environment,
        source_run_id,
        deployment_path_id,
        state.inner(),
    )
}

fn create_deployment_task_inner(
    path: String,
    environment: String,
    source_run_id: Option<String>,
    deployment_path_id: Option<String>,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    if !matches!(
        environment.as_str(),
        "staging" | "production" | "deployment"
    ) {
        return Err("部署任务类型不正确".to_string());
    }
    let root = PathBuf::from(&path);
    if environment == "deployment"
        && let Some(active) = state
            .list_active_deployment_runs()?
            .into_iter()
            .find(|run| run.environment == "deployment" && run.project_path == path)
    {
        if let Some(expected_path_id) = deployment_path_id.as_deref()
            && state
                .deployment_path_for_run(&active.id)
                .is_ok_and(|bound| bound.id == expected_path_id)
        {
            return Ok(active);
        }
        return Err("这个项目的另一条线路正在上线，请等待完成后再开始新的线路".to_string());
    }
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let mut run = state.create_deployment_run(
        &root,
        &manifest.project.name,
        &environment,
        &manifest.providers.build.repository,
        &manifest.source.release_branch,
    )?;
    run.source_run_id = source_run_id;
    run.completed_steps.clear();
    run.current_stage = "prepare".to_string();
    run.message = if environment == "production" {
        "正式发布任务已保存，正在核对目标环境".to_string()
    } else if environment == "deployment" {
        "上线任务已保存，正在准备当前本地项目".to_string()
    } else {
        "测试部署任务已保存，正在准备代码和运行环境".to_string()
    };
    state.save_deployment_run(&run)?;
    if let Some(path_id) = deployment_path_id.as_deref() {
        state.bind_deployment_path_run(path_id, &run.id)?;
    }
    Ok(run)
}

#[tauri::command]
fn begin_deployment_attempt(
    task_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentAttempt, String> {
    state.begin_deployment_attempt(&task_id)
}

#[tauri::command]
fn list_deployment_attempts(
    task_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentAttempt>, String> {
    state.list_deployment_attempts(&task_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn pause_deployment_task(
    run_id: String,
    current_stage: String,
    issue_code: String,
    message: String,
    action_kind: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let allowed_stage = matches!(
        current_stage.as_str(),
        "prepare" | "prepare-server" | "write-config" | "sync-source" | "trigger-build"
    );
    let allowed_action = matches!(
        action_kind.as_str(),
        "retry-staging-preparation"
            | "retry-production-preparation"
            | "deployment-path-preparation-retry"
    );
    if !allowed_stage || !allowed_action {
        return Err("部署任务恢复位置不正确".to_string());
    }
    let mut run = state.deployment_run(&run_id)?;
    if matches!(run.status.as_str(), "success" | "cancelled") {
        return Err("已经结束的部署任务不能改成等待处理".to_string());
    }
    run.status = "needs_action".to_string();
    run.current_stage = current_stage;
    run.issue_code = Some(if issue_code.starts_with("AD-") {
        issue_code
    } else {
        "AD-APP-001".to_string()
    });
    run.action_kind = Some(action_kind);
    run.action_url = None;
    run.message = public_error(message);
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

#[tauri::command]
fn prepare_deployment_path_retry(
    run_id: String,
    repaired_node: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    prepare_deployment_path_retry_inner(run_id, repaired_node, state.inner())
}

fn prepare_deployment_path_retry_inner(
    run_id: String,
    repaired_node: String,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    let mut run = state.deployment_run(&run_id)?;
    if run.environment != "deployment" || run.status != "needs_action" {
        return Err("当前上线任务不在等待修复状态".to_string());
    }
    let label = match repaired_node.as_str() {
        "local" => {
            run.current_stage = "local".to_string();
            "本地项目"
        }
        "build" => {
            run.current_stage = "build".to_string();
            "构建服务"
        }
        "registry" => {
            run.current_stage = "registry".to_string();
            "版本仓库"
        }
        "server" => {
            // Existing artifacts must be copied to a newly selected server;
            // a repaired address/server therefore resumes at deploy, not at a
            // passive public check.
            run.current_stage = if run.artifacts.is_empty() {
                "server".to_string()
            } else {
                "deploy".to_string()
            };
            "运行服务器"
        }
        "routes" => {
            // Public routing is an independent reconciliation step. When only
            // the address changes, keep the already-running immutable images
            // and resume at verification instead of recreating containers.
            run.current_stage = "server".to_string();
            "访问地址"
        }
        _ => return Err("要继续的线路节点不正确".to_string()),
    };
    run.issue_code = None;
    run.action_kind = Some("deployment-path-retry".to_string());
    run.action_url = None;
    run.message = format!("{label}的新配置已经验证，点击“继续上线”后从这里继续");
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn start_staging_deployment(
    path: String,
    expected_revision: Option<String>,
    prefer_push_build: bool,
    task_id: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("部署配置仍有必填项或隔离问题，请先处理校验结果".to_string());
    }
    let mut run = if let Some(task_id) = task_id {
        let run = state.deployment_run(&task_id)?;
        if run.environment != "staging" || run.project_path != path {
            return Err("保存的部署任务与当前项目不一致".to_string());
        }
        run
    } else {
        state.create_deployment_run(
            &root,
            &manifest.project.name,
            "staging",
            &manifest.providers.build.repository,
            &manifest.source.release_branch,
        )?
    };
    run.repository
        .clone_from(&manifest.providers.build.repository);
    run.branch.clone_from(&manifest.source.release_branch);
    run.commit_sha = checked_git_revision(expected_revision.as_deref())?;
    run.source_title = run
        .commit_sha
        .as_deref()
        .and_then(|revision| local_git_title(&root, revision));
    run.status = "queued".to_string();
    run.current_stage = "trigger-build".to_string();
    run.action_kind = None;
    run.action_url = None;
    run.issue_code = None;
    run.message = "代码版本已保存，正在请求 CNB 开始构建".to_string();
    run.updated_at = Utc::now().to_rfc3339();
    // 完整 SHA 必须在任何远程构建触发前落库。即使进程在 CNB 接受
    // 请求后退出，重启时仍能按同一 SHA 找回同一个任务。
    state.save_deployment_run(&run)?;
    state.begin_deployment_attempt(&run.id)?;
    state.set_project_step(&root, "deploying")?;
    if cloud_setup_required(&manifest) {
        run.status = "needs_action".to_string();
        run.current_stage = "cloud-setup".to_string();
        run.issue_code = Some("AD-CNB-201".to_string());
        run.action_kind = Some("cloud-setup".to_string());
        run.action_url = Some("https://cnb.cool/new/repos".to_string());
        run.message = "还差一次 CNB 保护配置；完成后会从这里继续，不会重复准备服务器".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    }
    trigger_cnb_run(run, "api_trigger_staging", None, prefer_push_build, &state).await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn start_deployment_path(
    path: String,
    expected_revision: String,
    task_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    start_deployment_path_inner(path, expected_revision, task_id, state.inner()).await
}

async fn start_deployment_path_inner(
    path: String,
    expected_revision: String,
    task_id: String,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("项目设置还有必填项，请先完成本地项目节点".to_string());
    }
    let mut run = state.deployment_run(&task_id)?;
    if run.environment != "deployment" || run.project_path != path {
        return Err("保存的上线任务与当前部署线路不一致".to_string());
    }
    let revision = checked_git_revision(Some(&expected_revision))?
        .ok_or_else(|| "无法确认本次本地项目快照".to_string())?;
    run.repository
        .clone_from(&manifest.providers.build.repository);
    run.branch.clone_from(&manifest.source.release_branch);
    run.commit_sha = Some(revision.clone());
    run.source_title = local_git_title(&root, &revision);
    run.status = "queued".to_string();
    run.current_stage = "build".to_string();
    run.action_kind = Some("deployment-path-build".to_string());
    run.action_url = None;
    run.issue_code = None;
    run.message = "当前本地项目已经同步，构建服务正在生成可运行版本".to_string();
    run.completed_steps = vec!["snapshot-source".to_string(), "sync-source".to_string()];
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    state.begin_deployment_attempt(&run.id)?;
    trigger_cnb_run(
        run,
        "api_trigger_deployment_path_build",
        Some(&revision),
        true,
        state,
    )
    .await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn resume_staging_deployment(
    run_id: String,
    expected_revision: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let mut run = state.deployment_run(&run_id)?;
    if run.environment != "staging" || run.action_kind.as_deref() != Some("cloud-setup") {
        return Err("这次部署当前不在持续部署配置步骤".to_string());
    }
    let manifest = load_manifest(Path::new(&run.project_path).join(MANIFEST_FILE).as_path())
        .map_err(public_error)?;
    if cloud_setup_required(&manifest) {
        return Err("CNB 仓库或两套环境密钥文件尚未配置完整".to_string());
    }
    run.repository
        .clone_from(&manifest.providers.build.repository);
    run.branch.clone_from(&manifest.source.release_branch);
    run.commit_sha = checked_git_revision(expected_revision.as_deref())?;
    run.source_title = run
        .commit_sha
        .as_deref()
        .and_then(|revision| local_git_title(Path::new(&run.project_path), revision));
    run.status = "queued".to_string();
    run.current_stage = "prepare".to_string();
    run.action_kind = None;
    run.action_url = None;
    run.message = "持续部署连接已完成，正在请求 CNB 构建".to_string();
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    state.begin_deployment_attempt(&run.id)?;
    trigger_cnb_run(run, "api_trigger_staging", None, true, &state).await
}

fn cloud_setup_required(manifest: &deploy_core::model::ProjectManifest) -> bool {
    manifest.providers.build.repository.contains("replace-me")
        || manifest.providers.build.repository.starts_with("owner/")
        || [
            manifest.environments.staging.secrets_ref.as_deref(),
            manifest.environments.production.secrets_ref.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|reference| reference.contains("replace-me"))
        || manifest.environments.staging.secrets_ref.is_none()
        || manifest.environments.production.secrets_ref.is_none()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn promote_production_deployment(
    source_run_id: String,
    task_id: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let source = state.deployment_run(&source_run_id)?;
    if source.environment != "staging" || source.status != "success" {
        return Err("只有健康检查通过的测试版本才能发布生产".to_string());
    }
    let revision = source.commit_sha.clone().ok_or_else(|| {
        "这次测试部署缺少完整版本标识，不能安全发布生产，请重新部署测试".to_string()
    })?;
    if source.artifacts.is_empty() {
        return Err("AD-REL-201: 尚未读取到测试环境的实际版本，请重新检查服务器连接".to_string());
    }
    let mut run = if let Some(task_id) = task_id {
        let run = state.deployment_run(&task_id)?;
        if run.environment != "production" || run.project_path != source.project_path {
            return Err("保存的正式发布任务与当前版本不一致".to_string());
        }
        run
    } else {
        state.create_deployment_run(
            Path::new(&source.project_path),
            &source.project_name,
            "production",
            &source.repository,
            &source.branch,
        )?
    };
    run.repository.clone_from(&source.repository);
    run.branch.clone_from(&source.branch);
    run.commit_sha = Some(revision.clone());
    run.source_title.clone_from(&source.source_title);
    run.source_run_id = Some(source.id);
    run.candidate_tag = source.candidate_tag;
    state.save_deployment_run(&run)?;
    state.begin_deployment_attempt(&run.id)?;
    trigger_cnb_run(
        run,
        "api_trigger_production",
        Some(&revision),
        false,
        &state,
    )
    .await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn refresh_deployment(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let run = state.deployment_run(&run_id)?;
    if run.environment == "deployment" {
        return refresh_deployment_path(run, state.inner()).await;
    }
    let mut run = run;
    if matches!(run.status.as_str(), "success" | "failed" | "cancelled") {
        if run.status == "success" {
            if run.artifacts.is_empty() {
                finalize_successful_deployment(&mut run, &state).await;
            } else {
                verify_deployed_services(&mut run, &state).await?;
                if run.status == "success"
                    && (run.environment == "production"
                        || run.action_kind.as_deref() != Some("local-preview"))
                {
                    // 正式地址可能在部署后被共享 Caddy 的旧配置重新占用。
                    // 即使 HTTPS 仍能打开，也必须重新确认它仍指向本次发布。
                    verify_public_routes(&mut run, &state).await?;
                }
            }
            run.updated_at = Utc::now().to_rfc3339();
            state.save_deployment_run(&run)?;
        }
        return Ok(run);
    }
    if deployment_needs_public_route_recheck(run.action_kind.as_deref()) {
        verify_public_routes(&mut run, &state).await?;
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    }
    if run.status == "needs_action"
        && run.current_stage == "healthcheck"
        && !run.artifacts.is_empty()
    {
        verify_deployed_services(&mut run, &state).await?;
        if run.status == "success"
            && (run.environment == "production"
                || run.action_kind.as_deref() != Some("local-preview"))
        {
            verify_public_routes(&mut run, &state).await?;
        }
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    }
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            let (issue_code, message) = cnb_keyring_issue(&error);
            run.status = "needs_action".to_string();
            run.issue_code = Some(issue_code.to_string());
            run.message = message.to_string();
            run.updated_at = Utc::now().to_rfc3339();
            state.save_deployment_run(&run)?;
            return Ok(run);
        }
    };
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let serial = if let Some(serial) = run.build_serial.clone() {
        serial
    } else if let Some(revision) = run.commit_sha.as_deref() {
        match recover_triggered_build(&client, &run.repository, revision, &run.environment, 3).await
        {
            Ok(Some(serial)) => {
                run.build_serial = Some(serial.clone());
                run.status = "running".to_string();
                run.current_stage = "build".to_string();
                run.issue_code = None;
                run.action_kind = None;
                run.action_url = None;
                run.message = "已从 CNB 最近构建中恢复本次任务".to_string();
                serial
            }
            Ok(None) => {
                run.status = "needs_action".to_string();
                run.issue_code = Some("AD-CNB-202".to_string());
                run.message = if run.environment == "production" {
                    "CNB 没有创建与测试通过版本匹配的生产任务，请重新发布".to_string()
                } else {
                    "CNB 没有创建与当前提交匹配的测试任务，请重新部署".to_string()
                };
                run.updated_at = Utc::now().to_rfc3339();
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
            Err(message) if message.contains("repo-cnb-history:r") => {
                apply_cnb_history_permission_fallback(&mut run);
                run.updated_at = Utc::now().to_rfc3339();
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
            Err(message) => return Err(message),
        }
    } else {
        run.status = "needs_action".to_string();
        run.issue_code = Some("AD-CNB-202".to_string());
        run.message = "本次部署缺少可用于恢复 CNB 任务的提交标识".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    };
    match client.build_status(&run.repository, &serial).await {
        Ok(payload) => {
            if let Some(revision) = build_revision(&payload) {
                run.commit_sha = Some(revision);
            }
            update_run_from_cnb(&mut run, &payload);
            if run.status == "failed"
                && let Some(pipeline_id) = summarize_build_status(&payload).pipeline_ids.first()
                && let Ok(log) = client.runner_log(&run.repository, pipeline_id).await
            {
                apply_runner_log_diagnostic(&mut run, &log);
                enrich_unhealthy_container_diagnostic(&mut run, &state).await;
            }
        }
        Err(error) => {
            let message = cnb_public_error(error);
            if message.contains("repo-cnb-history:r") {
                apply_cnb_history_permission_fallback(&mut run);
            } else {
                run.status = if message.starts_with("AD-CNB-103") {
                    "needs_action".to_string()
                } else {
                    "failed".to_string()
                };
                run.issue_code = Some(if message.starts_with("AD-CNB-103") {
                    "AD-CNB-103".to_string()
                } else {
                    "AD-CNB-204".to_string()
                });
                run.message = message;
            }
        }
    }
    if run.status == "success" {
        finalize_successful_deployment(&mut run, &state).await;
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    if run.status == "success" && run.environment == "staging" {
        state.set_project_step(Path::new(&run.project_path), "workspace")?;
    }
    Ok(run)
}

/// Continues one user-visible deployment path. CNB only builds an immutable
/// candidate; the desktop owns registry promotion, server mutation and the
/// final public check so a build service can never silently choose a runtime
/// target.
async fn refresh_deployment_path(
    mut run: DeploymentRun,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    let path = state.deployment_path_for_run(&run.id)?;
    if path.project_path != run.project_path {
        return Err("上线任务与部署线路不属于同一个项目".to_string());
    }
    if matches!(run.status.as_str(), "failed" | "cancelled") {
        return Ok(run);
    }
    if run.status == "needs_action" {
        // A user-initiated continuation is a new real attempt. The task and
        // immutable build stay the same, while the repaired node bindings are
        // frozen into a fresh append-only attempt before external work resumes.
        state.begin_deployment_attempt(&run.id)?;
    }

    // Once the immutable artifacts exist, refresh means “continue from the
    // server”, never “build another version”. This is what makes a repaired
    // domain or server connection resume the same task.
    if !run.artifacts.is_empty() {
        if run.status != "success" && run.current_stage == "deploy" {
            match deploy_deployment_path_to_server(&run, &path, state).await {
                Ok(()) => {}
                Err(message) => {
                    pause_deployment_path_after_deploy_error(&mut run, &message);
                    state.save_deployment_run(&run)?;
                    return Ok(run);
                }
            }
        }
        verify_deployment_path(&mut run, &path, state).await?;
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    }

    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            let (issue_code, message) = cnb_keyring_issue(&error);
            pause_deployment_path(
                &mut run,
                "build",
                issue_code,
                "deployment-path-build-connection",
                message,
            );
            state.save_deployment_run(&run)?;
            return Ok(run);
        }
    };
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let serial = if let Some(serial) = run.build_serial.clone() {
        serial
    } else if let Some(revision) = run.commit_sha.as_deref() {
        match recover_triggered_build(&client, &run.repository, revision, "deployment", 4).await {
            Ok(Some(serial)) => {
                run.build_serial = Some(serial.clone());
                serial
            }
            Ok(None) => {
                pause_deployment_path(
                    &mut run,
                    "build",
                    "AD-CNB-202",
                    "deployment-path-build-retry",
                    "构建服务还没有找到这次本地项目快照，请重新开始上线",
                );
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
            Err(message) if message.contains("repo-cnb-history:r") => {
                pause_deployment_path(
                    &mut run,
                    "build",
                    "AD-CNB-103",
                    "deployment-path-build-connection",
                    "构建已开始，但当前授权无法读取结果；更新构建服务授权后可以继续同一次上线",
                );
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
            Err(message) => return Err(message),
        }
    } else {
        pause_deployment_path(
            &mut run,
            "local",
            "AD-GIT-102",
            "deployment-path-source-retry",
            "这次上线缺少本地项目快照，请重新开始上线",
        );
        state.save_deployment_run(&run)?;
        return Ok(run);
    };

    match client.build_status(&run.repository, &serial).await {
        Ok(payload) => {
            if let Some(revision) = build_revision(&payload) {
                run.commit_sha = Some(revision);
            }
            update_run_from_cnb(&mut run, &payload);
            if run.status == "failed" {
                if let Some(pipeline_id) = summarize_build_status(&payload).pipeline_ids.first()
                    && let Ok(log) = client.runner_log(&run.repository, pipeline_id).await
                {
                    apply_runner_log_diagnostic(&mut run, &log);
                }
                run.updated_at = Utc::now().to_rfc3339();
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
            if run.status != "success" {
                run.current_stage = "build".to_string();
                run.message = "构建服务正在生成可运行版本".to_string();
                run.updated_at = Utc::now().to_rfc3339();
                state.save_deployment_run(&run)?;
                return Ok(run);
            }
        }
        Err(error) => {
            let message = cnb_public_error(error);
            let issue = if message.contains("repo-cnb-history:r") {
                "AD-CNB-103"
            } else {
                "AD-CNB-204"
            };
            pause_deployment_path(
                &mut run,
                "build",
                issue,
                "deployment-path-build-connection",
                &message,
            );
            state.save_deployment_run(&run)?;
            return Ok(run);
        }
    }

    run.status = "running".to_string();
    run.current_stage = "registry".to_string();
    run.issue_code = None;
    run.action_kind = None;
    run.action_url = None;
    run.message = "可运行版本已经生成，正在保存到版本仓库".to_string();
    run.completed_steps = vec![
        "snapshot-source".to_string(),
        "sync-source".to_string(),
        "build".to_string(),
    ];
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;

    match transfer_deployment_path_artifacts(&run, &path, state).await {
        Ok(artifacts) => run.artifacts = artifacts,
        Err(message) => {
            pause_deployment_path(
                &mut run,
                "registry",
                "AD-REG-201",
                "deployment-path-registry-retry",
                &message,
            );
            state.save_deployment_run(&run)?;
            return Ok(run);
        }
    }
    run.current_stage = "deploy".to_string();
    run.message = "版本已经安全保存，正在更新运行服务器".to_string();
    run.completed_steps.push("registry".to_string());
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;

    if let Err(message) = deploy_deployment_path_to_server(&run, &path, state).await {
        pause_deployment_path_after_deploy_error(&mut run, &message);
        state.save_deployment_run(&run)?;
        return Ok(run);
    }
    verify_deployment_path(&mut run, &path, state).await?;
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

fn pause_deployment_path(
    run: &mut DeploymentRun,
    stage: &str,
    issue_code: &str,
    action_kind: &str,
    message: &str,
) {
    run.status = "needs_action".to_string();
    run.current_stage = stage.to_string();
    run.issue_code = Some(issue_code.to_string());
    run.action_kind = Some(action_kind.to_string());
    run.action_url = None;
    run.message = redact_text(message);
    run.updated_at = Utc::now().to_rfc3339();
}

fn pause_deployment_path_after_deploy_error(run: &mut DeploymentRun, message: &str) {
    let (coded_issue, detail) = split_deployment_error(message)
        .map_or((None, message.trim()), |(code, detail)| {
            (Some(code), detail)
        });
    if coded_issue == Some("AD-SRV-206") {
        pause_deployment_path(
            run,
            "server",
            "AD-SRV-206",
            "deployment-path-route-takeover",
            detail,
        );
        return;
    }
    if message.contains("container ") && message.contains(" is unhealthy") {
        pause_deployment_path(
            run,
            "deploy",
            "AD-CTR-201",
            "deployment-path-image-update",
            "项目服务没有正常启动，需要检查当前版本的运行方式",
        );
        return;
    }
    let server_issue = [
        "AD-SRV-205",
        "AD-SRV-207",
        "AD-SRV-209",
        "AD-SRV-210",
        "AD-SRV-211",
    ]
    .into_iter()
    .find(|code| coded_issue == Some(*code));
    let issue_code = coded_issue.unwrap_or("AD-DEP-201");
    let visible_message = if coded_issue.is_some() {
        detail
    } else {
        "服务器没有完成本次更新，已经完成的步骤仍然保留"
    };
    pause_deployment_path(
        run,
        server_issue.map_or("deploy", |_| "server"),
        issue_code,
        "deployment-path-retry",
        visible_message,
    );
}

fn split_deployment_error(message: &str) -> Option<(&str, &str)> {
    let message = message.trim();
    let (code, detail) = message
        .split_once('：')
        .or_else(|| message.split_once(':'))?;
    let mut parts = code.split('-');
    let valid = parts.next() == Some("AD")
        && parts.next().is_some_and(|group| {
            !group.is_empty() && group.bytes().all(|byte| byte.is_ascii_uppercase())
        })
        && parts.next().is_some_and(|number| {
            number.len() == 3 && number.bytes().all(|byte| byte.is_ascii_digit())
        })
        && parts.next().is_none();
    valid.then(|| (code, detail.trim()))
}

fn deployment_path_profile(
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<ssh::SshProfile, String> {
    let server_id = path
        .server_id
        .as_deref()
        .ok_or_else(|| "请先在线路中选择运行服务器".to_string())?;
    let server = state.server_by_id(server_id)?;
    if !server.key_path_exists {
        return Err("运行服务器的 SSH 私钥已移动，请重新选择".to_string());
    }
    Ok(ssh::SshProfile {
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        key_path: PathBuf::from(server.key_path),
        host_fingerprint: server.host_fingerprint,
    })
}

async fn verified_deployment_path_profile(
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<ssh::SshProfile, String> {
    let profile = deployment_path_profile(path, state)?;
    let expected = profile
        .host_fingerprint
        .as_deref()
        .ok_or_else(|| "请重新验证运行服务器的身份指纹".to_string())?;
    let identity = ssh::probe_host_identity(&profile)
        .await
        .map_err(public_error)?;
    if identity.fingerprint != expected {
        return Err("运行服务器身份指纹已变化，已停止上线".to_string());
    }
    Ok(profile)
}

fn deployment_path_routes(path: &DeploymentPath) -> Vec<DomainRoute> {
    path.routes
        .iter()
        .map(|route| DomainRoute {
            service: route.service.clone(),
            host: route.host.clone(),
            path: route.path.clone(),
        })
        .collect()
}

fn scoped_postgres_identifier(value: &str, path_id: &str) -> String {
    let suffix = path_id
        .strip_prefix("path-")
        .unwrap_or(path_id)
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    let suffix = if suffix.is_empty() { "line" } else { &suffix };
    let keep = 63_usize.saturating_sub(suffix.len() + 1);
    let base = value.chars().take(keep).collect::<String>();
    format!("{base}_{suffix}")
}

fn deployment_path_manifest(
    run: &DeploymentRun,
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<ProjectManifest, String> {
    let mut manifest = deployment_manifest(run)?;
    let registry_connection_id = path
        .registry_connection_id
        .as_deref()
        .ok_or_else(|| "请先在线路中选择版本仓库".to_string())?;
    let registry_connection = state.connection_by_id(registry_connection_id)?;
    if registry_connection.kind != "registry" {
        return Err("所选连接不是版本仓库，请重新选择".to_string());
    }
    if registry_connection.status != "ready" {
        return Err("版本仓库连接尚未验证，请重新连接后继续".to_string());
    }
    manifest.providers.registry = match registry_connection.provider.as_str() {
        "tcr" => {
            let registry = registry_connection
                .metadata
                .get("endpoint")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| valid_registry_host(value))
                .ok_or_else(|| "版本仓库连接缺少有效地址，请重新连接".to_string())?;
            let namespace = registry_connection
                .metadata
                .get("namespace")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| valid_registry_namespace(value))
                .ok_or_else(|| "版本仓库连接缺少有效命名空间，请重新连接".to_string())?;
            RegistryConfig::Tcr {
                registry: registry.to_string(),
                namespace: namespace.to_string(),
            }
        }
        "cnb" => {
            let repository = registry_connection
                .metadata
                .get("repository")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| validate_repository_slug(value).is_ok())
                .unwrap_or(&manifest.providers.build.repository);
            RegistryConfig::Cnb {
                repository: repository.to_string(),
            }
        }
        _ => return Err("当前版本仓库类型暂不支持这条部署线路".to_string()),
    };
    let environment = &mut manifest.environments.production;
    if let Some(database) = environment.database.as_mut() {
        database.name = scoped_postgres_identifier(&database.name, &path.id);
        database.user = scoped_postgres_identifier(&database.user, &path.id);
    }
    if let Some(namespace) = environment.redis_namespace.as_mut() {
        *namespace = format!("{}:{}", namespace.trim_end_matches(':'), path.id);
    }
    environment.domains = deployment_path_routes(path);
    environment.secrets_ref = None;
    Ok(manifest)
}

async fn deployment_path_runtime_content(
    run: &DeploymentRun,
    path: &DeploymentPath,
    manifest: &ProjectManifest,
    profile: &ssh::SshProfile,
) -> Result<Zeroizing<String>, String> {
    let root = Path::new(&run.project_path);
    let key = runtime_config_key(root, &path.id)?;
    let mut stored_runtime = false;
    let template = runtime_config_template(root, EnvironmentName::Production)?.0;
    let mut content = match read_keyring_secret(&key) {
        Ok(value) if !value.trim().is_empty() => {
            stored_runtime = true;
            value
        }
        Ok(mut value) => {
            value.zeroize();
            template.clone()
        }
        Err(error) if error == "missing" => template.clone(),
        Err(error) => return Err(error),
    };
    let original = Zeroizing::new(content.clone());
    let path_managed_variables = deployment_path_managed_runtime_variables(manifest);
    let required_variables = required_runtime_variables(manifest, EnvironmentName::Production)
        .into_iter()
        .filter(|variable| !path_managed_variables.contains(variable))
        .collect::<Vec<_>>();
    content = ensure_runtime_template_variables(content, &required_variables);
    // A persisted deployment line may predate newly discovered non-secret
    // defaults in .env.example. Reuse those safe project defaults without
    // making the user re-enter them, while never importing secret values or
    // local-only addresses into a server runtime.
    let secret_variables = manifest
        .services
        .iter()
        .flat_map(|service| &service.runtime_env)
        .filter(|variable| variable.secret)
        .map(|variable| variable.name.clone())
        .collect::<BTreeSet<_>>();
    let safe_defaults = runtime_defaults(&template, &secret_variables);
    let (merged, _) = fill_managed_runtime_dependencies(&content, &safe_defaults);
    content.zeroize();
    content = merged;
    // Internal signing/session secrets do not represent an external account
    // and should never become a setup chore for a beginner. Generate them once
    // per deployment line, keep them in the system keychain, and reuse the
    // same value on subsequent releases. Provider credentials remain explicit
    // and are never synthesized here.
    let mut generated_secrets = BTreeMap::new();
    for variable in empty_runtime_variables(&content) {
        if internal_runtime_secret(&variable) {
            let value = load_or_generate_runtime_secret(root, &path.id, &variable)?;
            generated_secrets.insert(variable, value.to_string());
        }
    }
    if !generated_secrets.is_empty() {
        let (filled, _) = fill_empty_runtime_values(&content, &generated_secrets);
        for value in generated_secrets.values_mut() {
            value.zeroize();
        }
        content.zeroize();
        content = filled;
    }
    let mut managed_variables = Vec::new();
    if manifest.environments.production.database.is_some() {
        managed_variables.push("DATABASE_URL".to_string());
        for variable in ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"] {
            if required_variables
                .iter()
                .any(|required| required == variable)
            {
                managed_variables.push(variable.to_string());
            }
        }
    }
    if manifest.environments.production.redis_namespace.is_some() {
        managed_variables.push("REDIS_URL".to_string());
    }
    // A saved URL proves only what this line used last time; it does not prove
    // that a newly selected or rebuilt server still has the corresponding
    // database and cache containers. Reconcile the target server on every
    // deployment. The operation is idempotent and reuses healthy services.
    let managed = ensure_remote_runtime_dependencies_scoped(
        root,
        &path.id,
        &manifest.environments.production,
        profile,
    )
    .await?;
    let (filled, _) = replace_managed_runtime_dependencies(
        &content,
        &managed,
        &managed_variables.into_iter().collect(),
    );
    content.zeroize();
    content = filled;
    let missing =
        missing_runtime_variables(&content, &required_variables, EnvironmentName::Production);
    if !missing.is_empty() {
        content.zeroize();
        return Err(format!(
            "运行服务器还缺少 {} 项必要配置：{}",
            missing.len(),
            missing.join("、")
        ));
    }
    if !stored_runtime || content != original.as_str() {
        write_keyring_secret(&key, &content)?;
    }
    Ok(Zeroizing::new(content))
}

fn deployment_path_registry_credentials(
    registry: &RegistryConfig,
) -> Result<(Zeroizing<String>, Zeroizing<String>), String> {
    match registry {
        RegistryConfig::Cnb { .. } => Ok((
            Zeroizing::new("cnb".to_string()),
            Zeroizing::new(resolve_cnb_token(String::new())?),
        )),
        RegistryConfig::Tcr { .. } => Ok((
            Zeroizing::new(read_keyring_secret("registry.tcr.v2.username")?),
            Zeroizing::new(read_keyring_secret("registry.tcr.v2.password")?),
        )),
        RegistryConfig::Oci { .. } => Ok((
            Zeroizing::new(read_keyring_secret("registry.oci.username")?),
            Zeroizing::new(read_keyring_secret("registry.oci.password")?),
        )),
    }
}

async fn transfer_deployment_path_artifacts(
    run: &DeploymentRun,
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<Vec<DeploymentArtifact>, String> {
    let manifest = deployment_path_manifest(run, path, state)?;
    let profile = verified_deployment_path_profile(path, state).await?;
    let revision = checked_git_revision(run.commit_sha.as_deref())?
        .ok_or_else(|| "无法确认要保存的构建版本".to_string())?;
    let immutable_tag = manifest
        .release
        .image_tag_template
        .replace("{commit}", &revision);
    if immutable_tag.is_empty()
        || immutable_tag.len() > 128
        || !immutable_tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("项目生成的版本标识格式不正确".to_string());
    }
    let source_token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let (registry_user, registry_password) =
        deployment_path_registry_credentials(&manifest.providers.registry)?;
    let registry = RegistryProvider::new(&manifest.providers.registry);
    let persistent_config = format!(".deploydesk/registry/{}", path.id);
    let mut script = format!(
        r#"set -eu
umask 077
SOURCE_CONFIG="$(mktemp -d "$HOME/.deploydesk-source-registry.XXXXXX")"
PERSISTENT_CONFIG="$HOME/{persistent_config}"
mkdir -p "$PERSISTENT_CONFIG"
chmod 700 "$PERSISTENT_CONFIG"
trap 'rm -rf "$SOURCE_CONFIG"' EXIT
printf '%s' {source_token} | base64 -d | docker --config "$SOURCE_CONFIG" login docker.cnb.cool --username cnb --password-stdin >/dev/null 2>&1
printf '%s' {registry_password} | base64 -d | docker --config "$PERSISTENT_CONFIG" login {push_registry} --username {registry_user} --password-stdin >/dev/null 2>&1
"#,
        persistent_config = persistent_config,
        source_token = shell_quote(&BASE64.encode(source_token.as_bytes())),
        registry_password = shell_quote(&BASE64.encode(registry_password.as_bytes())),
        push_registry = shell_quote(registry.push_registry()),
        registry_user = shell_quote(registry_user.as_str()),
    );
    if registry.pull_registry() != registry.push_registry() {
        writeln!(
            &mut script,
            "printf '%s' {} | base64 -d | docker --config \"$PERSISTENT_CONFIG\" login {} --username {} --password-stdin >/dev/null 2>&1",
            shell_quote(&BASE64.encode(registry_password.as_bytes())),
            shell_quote(registry.pull_registry()),
            shell_quote(registry_user.as_str()),
        )
        .expect("writing to a String is infallible");
    }
    for service in &manifest.services {
        let source = format!(
            "docker.cnb.cool/{}/{}:{immutable_tag}",
            manifest.providers.build.repository.to_ascii_lowercase(),
            service.image.to_ascii_lowercase(),
        );
        let push = registry.image_push_reference(&service.image, &immutable_tag);
        let pull_repository = registry.pull_repository(&service.image);
        if source == push {
            writeln!(
                &mut script,
                r#"docker --config "$SOURCE_CONFIG" pull {source} >/dev/null
DIGEST="$(docker image inspect {source} --format '{{{{range .RepoDigests}}}}{{{{println .}}}}{{{{end}}}}' 2>/dev/null | sed -n 's/.*@\(sha256:[0-9a-f]\{{64\}}\)$/\1/p' | tail -n 1)"
case "$DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo '版本仓库没有返回不可变镜像摘要' >&2; exit 1 ;; esac
printf 'ABCDEPLOY_ARTIFACT\t%s\t%s\t%s\n' {service} {pull_repository} "$DIGEST""#,
                source = shell_quote(&source),
                service = shell_quote(&service.id),
                pull_repository = shell_quote(&pull_repository),
            )
            .expect("writing to a String is infallible");
        } else {
            writeln!(
                &mut script,
                r#"docker --config "$SOURCE_CONFIG" pull {source} >/dev/null
docker tag {source} {push}
PUSH_OUTPUT="$(docker --config "$PERSISTENT_CONFIG" push {push} 2>&1)" || {{ printf '%s\n' "$PUSH_OUTPUT" >&2; exit 1; }}
DIGEST="$(printf '%s\n' "$PUSH_OUTPUT" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{{64\}}\).*/\1/p' | tail -n 1)"
if [ -z "$DIGEST" ]; then
  DIGEST="$(docker image inspect {push} --format '{{{{range .RepoDigests}}}}{{{{println .}}}}{{{{end}}}}' 2>/dev/null | sed -n 's/.*@\(sha256:[0-9a-f]\{{64\}}\)$/\1/p' | tail -n 1)"
fi
case "$DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo '版本仓库没有返回不可变镜像摘要' >&2; exit 1 ;; esac
printf 'ABCDEPLOY_ARTIFACT\t%s\t%s\t%s\n' {service} {pull_repository} "$DIGEST""#,
            source = shell_quote(&source),
            push = shell_quote(&push),
            service = shell_quote(&service.id),
            pull_repository = shell_quote(&pull_repository),
            )
            .expect("writing to a String is infallible");
        }
    }
    let output = ssh::execute(
        &profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_mins(30),
    )
    .await
    .map_err(public_error);
    script.zeroize();
    let output = output?;
    if output.exit_status != Some(0) {
        return Err(redact_text(&output.stderr)
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("版本没有保存到版本仓库")
            .to_string());
    }
    let mut artifacts = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            (fields.next()? == "ABCDEPLOY_ARTIFACT").then(|| DeploymentArtifact {
                service: fields.next().unwrap_or_default().to_string(),
                image: fields.next().unwrap_or_default().to_string(),
                digest: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect::<Vec<_>>();
    artifacts.sort_by(|left, right| left.service.cmp(&right.service));
    if artifacts.len() != manifest.services.len()
        || artifacts.iter().any(|artifact| {
            artifact.service.is_empty()
                || artifact.image.is_empty()
                || artifact.digest.len() != 71
                || !artifact.digest.starts_with("sha256:")
                || !artifact.digest[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("版本仓库返回的镜像摘要不完整，已停止更新服务器".to_string());
    }
    Ok(artifacts)
}

async fn deploy_deployment_path_to_server(
    run: &DeploymentRun,
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<(), String> {
    let manifest = deployment_path_manifest(run, path, state)?;
    let profile = verified_deployment_path_profile(path, state).await?;
    let caddy_check = caddy::bootstrap_server(&profile, true)
        .await
        .map_err(public_error)?;
    if !caddy_check.ok {
        return Err(provider_check_failure(&caddy_check));
    }
    state.remember_checked_server(&profile)?;
    let runtime = deployment_path_runtime_content(run, path, &manifest, &profile).await?;
    let routes = deployment_path_routes(path);
    let bundle =
        render_deployment_path_bundle(&manifest, &path.id, &routes).map_err(public_error)?;
    let revision = checked_git_revision(run.commit_sha.as_deref())?
        .ok_or_else(|| "无法确认要部署的项目版本".to_string())?;
    let release_id = manifest
        .release
        .image_tag_template
        .replace("{commit}", &revision);
    let mut release = format!("DEPLOYDESK_RELEASE_ID={release_id}\n");
    for service in &manifest.services {
        let artifact = run
            .artifacts
            .iter()
            .find(|artifact| artifact.service == service.id)
            .ok_or_else(|| format!("版本仓库缺少服务 {} 的镜像", service.id))?;
        writeln!(
            &mut release,
            "DEPLOYDESK_{}_IMAGE={}@{}",
            service.id.replace('-', "_").to_ascii_uppercase(),
            artifact.image,
            artifact.digest,
        )
        .expect("writing to a String is infallible");
    }
    let registry_directory = format!(".deploydesk/registry/{}", path.id);
    let mut script = format!(
        r#"set -eu
umask 077
export DOCKER_CONFIG="$HOME/{registry_directory}"
test -d "$DOCKER_CONFIG" || {{ echo '版本仓库登录信息尚未同步到运行服务器' >&2; exit 1; }}
REMOTE_DIRECTORY="$HOME/{remote_directory}"
RUNTIME_FILE="$HOME/{runtime_path}"
mkdir -p "$REMOTE_DIRECTORY" "$(dirname "$RUNTIME_FILE")"
docker network inspect {network} >/dev/null 2>&1 || docker network create {network} >/dev/null
printf '%s' {compose} | base64 -d >"$REMOTE_DIRECTORY/docker-compose.yml.next"
printf '%s' {caddy} | base64 -d >"$REMOTE_DIRECTORY/Caddyfile.next"
printf '%s' {runtime} | base64 -d >"$RUNTIME_FILE.next"
chmod 600 "$RUNTIME_FILE.next"
mv -f "$RUNTIME_FILE.next" "$RUNTIME_FILE"
cp "$RUNTIME_FILE" "$REMOTE_DIRECTORY/.runtime.env.next"
printf '%s' {release} | base64 -d >"$REMOTE_DIRECTORY/.release.env.next"
chmod 600 "$REMOTE_DIRECTORY/.runtime.env.next" "$REMOTE_DIRECTORY/.release.env.next"
{deploy_script}
"#,
        registry_directory = registry_directory,
        remote_directory = bundle.remote_directory,
        runtime_path = bundle.runtime_config_path,
        network = shell_quote(&bundle.network),
        compose = shell_quote(&BASE64.encode(bundle.compose.as_bytes())),
        caddy = shell_quote(&BASE64.encode(bundle.caddy.as_bytes())),
        runtime = shell_quote(&BASE64.encode(runtime.as_bytes())),
        release = shell_quote(&BASE64.encode(release.as_bytes())),
        deploy_script = bundle.deploy_script,
    );
    let output = ssh::execute(
        &profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_mins(25),
    )
    .await
    .map_err(public_error);
    script.zeroize();
    release.zeroize();
    let output = output?;
    if output.exit_status != Some(0) {
        let message = redact_text(&output.stderr)
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("运行服务器没有完成更新")
            .to_string();
        return Err(message);
    }
    if let Some(host) = output.stdout.lines().find_map(|line| {
        line.strip_prefix("ROUTE_TAKEOVER_REQUIRED\t")
            .map(str::trim)
            .filter(|host| !host.is_empty())
    }) {
        return Err(deployment_path_route_takeover_error(host));
    }
    if let Some(host) =
        activate_deployment_path_routes(&profile, &bundle.route_activation_script).await?
    {
        return Err(deployment_path_route_takeover_error(&host));
    }
    Ok(())
}

fn provider_check_failure(check: &ProviderCheck) -> String {
    let code = check.code.as_deref().unwrap_or("AD-SRV-299");
    format!("{code}：{}", check.summary)
}

async fn activate_deployment_path_routes(
    profile: &ssh::SshProfile,
    script: &str,
) -> Result<Option<String>, String> {
    if script.trim().is_empty() {
        return Ok(None);
    }
    let output = ssh::execute(
        profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_mins(5),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(redact_text(&output.stderr)
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("AD-SRV-209：访问地址没有安全加载到统一 Caddy")
            .to_string());
    }
    Ok(output.stdout.lines().find_map(|line| {
        line.strip_prefix("ROUTE_TAKEOVER_REQUIRED\t")
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(ToString::to_string)
    }))
}

fn deployment_path_route_takeover_error(host: &str) -> String {
    format!(
        "AD-SRV-206：{}",
        deployment_path_route_takeover_message(host)
    )
}

fn deployment_path_route_takeover_message(host: &str) -> String {
    format!(
        "{host} 仍由服务器原有 Caddy 配置占用；应用已更新，但需要在运行服务器节点确认接管该地址"
    )
}

async fn verify_deployment_path(
    run: &mut DeploymentRun,
    path: &DeploymentPath,
    state: &WorkspaceState,
) -> Result<(), String> {
    let manifest = deployment_path_manifest(run, path, state)?;
    let profile = verified_deployment_path_profile(path, state).await?;
    let namespace = format!("{}-{}", manifest.project.name, path.id);
    let expected = manifest
        .services
        .iter()
        .map(|service| {
            let container = format!("{namespace}-{}-1", service.id);
            if !safe_runtime_identifier(&service.id) || !safe_runtime_identifier(&container) {
                return Err("项目服务名称不安全，已停止检查运行服务器".to_string());
            }
            Ok((service.id.clone(), container))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let command = expected
        .iter()
        .map(|(service, container)| {
            format!(
                "if status=$(docker inspect --format '{{{{.State.Status}}}}' {} 2>/dev/null); then health=$(docker inspect --format '{{{{if .State.Health}}}}{{{{.State.Health.Status}}}}{{{{else}}}}none{{{{end}}}}' {} 2>/dev/null || printf 'missing'); image=$(docker inspect --format '{{{{.Config.Image}}}}' {} 2>/dev/null || printf 'missing'); printf '%s\\t%s\\t%s\\t%s\\n' {} \"$status\" \"$health\" \"$image\"; else printf '%s\\tmissing\\tmissing\\tmissing\\n' {}; fi",
                shell_quote(container),
                shell_quote(container),
                shell_quote(container),
                shell_quote(service),
                shell_quote(service),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let output = ssh::execute(&profile, &command, None, Duration::from_secs(30))
        .await
        .map_err(public_error)?;
    if output.exit_status != Some(0) {
        pause_deployment_path(
            run,
            "deploy",
            "AD-CTR-201",
            "deployment-path-retry",
            "没有完成运行服务检查，请重新验证服务器连接后继续",
        );
        return Ok(());
    }
    let states = parse_deployed_service_states(&output.stdout, &expected);
    if let Some(problem) = states.iter().find(|state| {
        state.status != "running" || !matches!(state.health.as_str(), "healthy" | "none")
    }) {
        pause_deployment_path(
            run,
            "deploy",
            "AD-CTR-201",
            "deployment-path-retry",
            &format!("运行服务 {} 启动后还没有通过健康检查", problem.service),
        );
        return Ok(());
    }
    if let Some(problem) = states.iter().find(|state| {
        let expected_image = run
            .artifacts
            .iter()
            .find(|artifact| artifact.service == state.service)
            .map(|artifact| format!("{}@{}", artifact.image, artifact.digest));
        state.image.as_deref() != expected_image.as_deref()
    }) {
        pause_deployment_path(
            run,
            "deploy",
            "AD-REL-101",
            "deployment-path-retry",
            &format!(
                "运行服务 {} 还不是本次上线的版本，系统将继续更新服务器",
                problem.service
            ),
        );
        return Ok(());
    }

    let routes = deployment_path_routes(path);
    if routes.is_empty() {
        pause_deployment_path(
            run,
            "server",
            "AD-NET-201",
            "deployment-path-route-check",
            "运行服务已经启动，还需要填写一个项目访问地址",
        );
        return Ok(());
    }
    let bundle =
        render_deployment_path_bundle(&manifest, &path.id, &routes).map_err(public_error)?;
    match activate_deployment_path_routes(&profile, &bundle.route_activation_script).await {
        Ok(Some(host)) => {
            pause_deployment_path(
                run,
                "server",
                "AD-SRV-206",
                "deployment-path-route-takeover",
                &deployment_path_route_takeover_message(&host),
            );
            return Ok(());
        }
        Ok(None) => {}
        Err(message) => {
            pause_deployment_path_after_deploy_error(run, &message);
            return Ok(());
        }
    }
    let checks = collect_public_route_statuses(&routes, Some(&profile.host)).await;
    run.route_checks.clone_from(&checks);
    if let Some(failure) = checks.iter().find(|check| !check.reachable) {
        pause_deployment_path(
            run,
            "server",
            "AD-NET-201",
            "deployment-path-route-check",
            &format!("运行服务已经启动，访问地址还未就绪：{}", failure.message),
        );
        return Ok(());
    }
    run.status = "success".to_string();
    run.current_stage = "complete".to_string();
    run.issue_code = None;
    run.action_kind = None;
    run.action_url = checks.first().map(|check| check.url.clone());
    run.message = format!(
        "上线完成，{} 个运行服务和 {} 个访问地址均已验证",
        expected.len(),
        checks.len()
    );
    run.completed_steps = vec![
        "snapshot-source".to_string(),
        "sync-source".to_string(),
        "build".to_string(),
        "registry".to_string(),
        "server".to_string(),
        "public".to_string(),
    ];
    Ok(())
}

fn deployment_needs_public_route_recheck(action_kind: Option<&str>) -> bool {
    matches!(
        action_kind,
        Some("route-check" | "route-repair" | "route-takeover")
    )
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn open_staging_preview_tunnel(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<StagingPreviewTunnel, String> {
    let mut run = state.deployment_run(&run_id)?;
    let route_blocked = run.action_kind.as_deref() == Some("route-check")
        && run.issue_code.as_deref() == Some("AD-NET-201");
    let reopening_preview =
        run.status == "success" && run.action_kind.as_deref() == Some("local-preview");
    if run.environment != "staging" || (!route_blocked && !reopening_preview) {
        return Err("当前测试版本不需要本机安全预览".to_string());
    }
    if run.artifacts.is_empty() {
        return Err("测试版本尚未完成服务器验证，请先重新检查当前部署".to_string());
    }
    let manifest = deployment_manifest(&run)?;
    let environment = &manifest.environments.staging;
    let service = manifest
        .services
        .iter()
        .find(|service| matches!(service.kind, ServiceKind::Web | ServiceKind::Static))
        .or_else(|| {
            manifest
                .services
                .iter()
                .find(|service| service.kind != ServiceKind::Worker)
        })
        .ok_or_else(|| "没有找到可以打开的测试服务".to_string())?;
    let container = format!("{}-{}-1", environment.target.namespace, service.id);
    if !safe_runtime_identifier(&container) {
        return Err("测试服务容器名称不安全，已停止创建预览通道".to_string());
    }
    let profile = deployment_server_profile(&run, &state)?;
    let remote_command = format!(
        "docker inspect --format '{{{{range .NetworkSettings.Networks}}}}{{{{println .IPAddress}}}}{{{{end}}}}' {} | sed -n '/./{{p;q;}}'",
        shell_quote(&container)
    );
    let output = ssh::execute(&profile, &remote_command, None, Duration::from_secs(20))
        .await
        .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err("无法读取测试服务的安全预览地址，请重新检查测试版运行状态后重试".to_string());
    }
    let remote_ip = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .and_then(|line| line.parse::<IpAddr>().ok())
        .ok_or_else(|| "测试服务还没有可访问的容器网络地址".to_string())?;
    let local_listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法分配本机预览端口：{error}"))?;
    let local_port = local_listener.local_addr().map_err(public_error)?.port();
    drop(local_listener);

    let identity = ssh::probe_host_identity(&profile)
        .await
        .map_err(public_error)?;
    if profile.host_fingerprint.as_deref() != Some(identity.fingerprint.as_str()) {
        return Err("服务器身份指纹已变化，已停止创建预览通道".to_string());
    }
    let known_hosts_path = std::env::temp_dir().join(format!(
        "abcdeploy-preview-{}.known-hosts",
        &project_storage_id(Path::new(&run.project_path))[..24]
    ));
    write_preview_known_hosts(&known_hosts_path, &profile, &identity.public_key)?;
    let forward = format!(
        "127.0.0.1:{local_port}:{remote_ip}:{}",
        service.container_port
    );
    let mut command = system_command("ssh");
    command
        .arg("-N")
        .arg("-i")
        .arg(&profile.key_path)
        .arg("-p")
        .arg(profile.port.to_string())
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ExitOnForwardFailure=yes"])
        .args(["-o", "ServerAliveInterval=20"])
        .args(["-o", "ServerAliveCountMax=3"])
        .args(["-o", "StrictHostKeyChecking=yes"])
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            known_hosts_path.to_string_lossy()
        ))
        .arg("-L")
        .arg(&forward)
        .arg(format!("{}@{}", profile.user, profile.host))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本机安全预览：{error}"))?;
    let local_address = SocketAddr::from(([127, 0, 0, 1], local_port));
    let mut ready = false;
    for _ in 0..12 {
        if child.try_wait().map_err(public_error)?.is_some() {
            break;
        }
        if TcpStream::connect_timeout(&local_address, Duration::from_millis(250)).is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(&known_hosts_path);
        return Err("本机安全预览没有及时建立，请确认 SSH 连接后重试".to_string());
    }
    replace_preview_tunnel(
        &run.project_path,
        PreviewTunnelProcess {
            child,
            known_hosts_path,
        },
    );

    run.status = "success".to_string();
    run.current_stage = "complete".to_string();
    run.issue_code = None;
    run.action_kind = Some("local-preview".to_string());
    run.action_url = None;
    run.message = "测试环境已通过服务器健康检查，并已通过本机安全通道打开".to_string();
    if !run.completed_steps.iter().any(|step| step == "healthcheck") {
        run.completed_steps.push("healthcheck".to_string());
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(StagingPreviewTunnel {
        url: format!("http://127.0.0.1:{local_port}"),
        service: service.id.clone(),
    })
}

fn write_preview_known_hosts(
    path: &Path,
    profile: &ssh::SshProfile,
    public_key: &str,
) -> Result<(), String> {
    if public_key.contains(['\r', '\n'])
        || !(public_key.starts_with("ssh-")
            || public_key.starts_with("ecdsa-")
            || public_key.starts_with("sk-"))
    {
        return Err("服务器公钥格式不正确，已停止创建预览通道".to_string());
    }
    let host = if profile.port == 22 {
        profile.host.clone()
    } else {
        format!("[{}]:{}", profile.host, profile.port)
    };
    let content = format!("{host} {public_key}\n");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(public_error)?;
    file.write_all(content.as_bytes()).map_err(public_error)
}

fn replace_preview_tunnel(project_path: &str, tunnel: PreviewTunnelProcess) {
    let Ok(mut tunnels) = PREVIEW_TUNNELS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
    else {
        return;
    };
    if let Some(mut previous) = tunnels.insert(project_path.to_string(), tunnel) {
        let _ = previous.child.kill();
        let _ = previous.child.wait();
        let _ = fs::remove_file(previous.known_hosts_path);
    }
}

fn stop_preview_tunnels() {
    let Some(tunnels) = PREVIEW_TUNNELS.get() else {
        return;
    };
    let Ok(mut tunnels) = tunnels.lock() else {
        return;
    };
    for (_, mut tunnel) in std::mem::take(&mut *tunnels) {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
        let _ = fs::remove_file(tunnel.known_hosts_path);
    }
}

fn apply_cnb_history_permission_fallback(run: &mut DeploymentRun) {
    run.status = "needs_action".to_string();
    run.current_stage = "build".to_string();
    run.issue_code = Some("AD-CNB-103".to_string());
    run.action_kind = Some("cnb-builds".to_string());
    run.action_url = Some(format!("https://cnb.cool/{}/-/build/logs", run.repository));
    run.message =
        "代码已推送并由 CNB 自动构建；当前授权无法读取构建结果，可前往 CNB 查看或补充“构建记录读取”权限"
            .to_string();
}

async fn finalize_successful_deployment(run: &mut DeploymentRun, state: &WorkspaceState) {
    let verifying_existing = run.action_kind.as_deref() == Some("verify-existing-deployment");
    let manifest = match deployment_manifest(run) {
        Ok(manifest) => manifest,
        Err(error) => {
            run.status = "needs_action".to_string();
            run.current_stage = "healthcheck".to_string();
            run.issue_code = Some("AD-REL-101".to_string());
            run.message = format!("应用已部署，但无法核对发布记录：{}", public_error(error));
            return;
        }
    };
    if let Some(revision) = &run.commit_sha {
        let candidate = manifest
            .release
            .candidate_tag_template
            .replace("{commit}", revision);
        run.candidate_tag = Some(candidate);
        run.action_url = Some(format!("https://cnb.cool/{}/-/tags", run.repository));
    }
    match capture_deployment_artifacts(run, &manifest, state).await {
        Ok(artifacts) => run.artifacts = artifacts,
        Err(message) => {
            run.status = "needs_action".to_string();
            run.current_stage = "verify-release".to_string();
            run.action_kind = Some(if verifying_existing {
                "verify-existing-deployment".to_string()
            } else {
                "verify-release".to_string()
            });
            run.issue_code = Some("AD-REL-201".to_string());
            run.message = if verifying_existing {
                "已发现已有部署；请重新验证这个环境的服务器连接，核对当前运行版本".to_string()
            } else {
                message
            };
            return;
        }
    }
    if run.environment == "production" {
        let Some(source_id) = run.source_run_id.as_deref() else {
            run.status = "needs_action".to_string();
            run.current_stage = "verify-release".to_string();
            run.action_kind = Some("artifact-mismatch".to_string());
            run.issue_code = Some("AD-REL-301".to_string());
            run.message = "生产发布缺少测试来源记录，已停止把它标记为可验证版本".to_string();
            return;
        };
        match state.deployment_run(source_id) {
            Ok(source) if same_artifact_digests(&source.artifacts, &run.artifacts) => {}
            Ok(_) => {
                run.status = "needs_action".to_string();
                run.current_stage = "verify-release".to_string();
                run.action_kind = Some("artifact-mismatch".to_string());
                run.issue_code = Some("AD-REL-301".to_string());
                run.message =
                    "生产环境镜像摘要与测试通过版本不一致，已停止确认本次发布".to_string();
                return;
            }
            Err(error) => {
                run.status = "needs_action".to_string();
                run.current_stage = "verify-release".to_string();
                run.action_kind = Some("artifact-mismatch".to_string());
                run.issue_code = Some("AD-REL-301".to_string());
                run.message = format!("无法读取测试来源记录：{error}");
                return;
            }
        }
    }
    run.issue_code = None;
    if let Err(message) = verify_public_routes(run, state).await {
        pause_public_route_inspection(run, &message);
    }
}

fn pause_public_route_inspection(run: &mut DeploymentRun, message: &str) {
    run.status = "needs_action".to_string();
    run.current_stage = "healthcheck".to_string();
    run.action_kind = Some("route-check".to_string());
    run.action_url = None;
    run.issue_code = Some("AD-NET-202".to_string());
    run.message = format!(
        "服务已经部署；这次地址检查没有完成：{}。网络恢复后会自动继续",
        redact_text(message)
    );
    run.completed_steps.retain(|step| step != "healthcheck");
}

async fn capture_deployment_artifacts(
    run: &DeploymentRun,
    manifest: &deploy_core::model::ProjectManifest,
    state: &WorkspaceState,
) -> Result<Vec<DeploymentArtifact>, String> {
    let server = state
        .server_for_project(Path::new(&run.project_path), &run.environment)?
        .ok_or_else(|| {
            "服务器部署已完成，但本机还没有这个环境的连接记录；请重新验证服务器后刷新".to_string()
        })?;
    if !server.key_path_exists {
        return Err("服务器连接使用的 SSH 私钥已移动，请重新选择安全凭据".to_string());
    }
    let profile = ssh::SshProfile {
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        key_path: PathBuf::from(server.key_path),
        host_fingerprint: server.host_fingerprint,
    };
    let remote_directory = format!(
        ".deploydesk/apps/{}/{}",
        manifest.project.name, run.environment
    );
    let command = format!(
        "set -eu; cd \"$HOME\"/{}; test -f .release.env; sed -n '/^DEPLOYDESK_[A-Z0-9_]*_IMAGE=/p' .release.env",
        shell_quote(&remote_directory)
    );
    let output = ssh::execute(&profile, &command, None, Duration::from_secs(30))
        .await
        .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err("服务器上没有找到本次不可变镜像记录，请检查部署日志后重试".to_string());
    }
    parse_deployment_artifacts(&output.stdout, manifest)
}

fn parse_deployment_artifacts(
    release_env: &str,
    manifest: &deploy_core::model::ProjectManifest,
) -> Result<Vec<DeploymentArtifact>, String> {
    let mut artifacts = Vec::with_capacity(manifest.services.len());
    for service in &manifest.services {
        let key = format!(
            "DEPLOYDESK_{}_IMAGE=",
            service.id.replace('-', "_").to_ascii_uppercase()
        );
        let value = release_env
            .lines()
            .find_map(|line| line.strip_prefix(&key))
            .ok_or_else(|| format!("服务器发布记录缺少服务 {} 的镜像摘要", service.id))?;
        let (image, digest_hex) = value
            .rsplit_once("@sha256:")
            .ok_or_else(|| format!("服务 {} 的镜像不是不可变摘要", service.id))?;
        if image.is_empty()
            || image.chars().any(char::is_whitespace)
            || digest_hex.len() != 64
            || !digest_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!("服务 {} 的镜像摘要格式不正确", service.id));
        }
        artifacts.push(DeploymentArtifact {
            service: service.id.clone(),
            image: image.to_string(),
            digest: format!("sha256:{digest_hex}"),
        });
    }
    artifacts.sort_by(|left, right| left.service.cmp(&right.service));
    Ok(artifacts)
}

fn same_artifact_digests(left: &[DeploymentArtifact], right: &[DeploymentArtifact]) -> bool {
    left.len() == right.len()
        && left.iter().all(|artifact| {
            right.iter().any(|candidate| {
                candidate.service == artifact.service && candidate.digest == artifact.digest
            })
        })
}

#[derive(Debug, PartialEq, Eq)]
struct DeployedServiceState {
    service: String,
    container: String,
    status: String,
    health: String,
    image: Option<String>,
}

fn parse_deployed_service_states(
    output: &str,
    expected: &[(String, String)],
) -> Vec<DeployedServiceState> {
    let reported = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().split('\t');
            let service = fields.next()?.trim();
            let status = fields.next()?.trim();
            let health = fields.next()?.trim();
            let image = fields
                .next()
                .map(str::trim)
                .filter(|image| !image.is_empty() && *image != "missing")
                .map(ToString::to_string);
            if service.is_empty() || status.is_empty() || health.is_empty() {
                return None;
            }
            Some((
                service.to_string(),
                (status.to_string(), health.to_string(), image),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    expected
        .iter()
        .map(|(service, container)| {
            let (status, health, image) = reported
                .get(service)
                .cloned()
                .unwrap_or_else(|| ("missing".to_string(), "missing".to_string(), None));
            DeployedServiceState {
                service: service.clone(),
                container: container.clone(),
                status,
                health,
                image,
            }
        })
        .collect()
}

fn apply_deployed_service_states(run: &mut DeploymentRun, states: &[DeployedServiceState]) {
    let problem = states.iter().find(|state| {
        state.status != "running" || !matches!(state.health.as_str(), "healthy" | "none")
    });
    if let Some(problem) = problem {
        run.status = "needs_action".to_string();
        run.current_stage = "healthcheck".to_string();
        run.issue_code = Some("AD-CTR-201".to_string());
        run.message = format!("服务容器 {} 启动后未通过健康检查", problem.container);
        run.completed_steps.retain(|step| step != "healthcheck");
        return;
    }
    run.status = "success".to_string();
    run.current_stage = "complete".to_string();
    run.issue_code = None;
    run.message = if run.environment == "production" {
        "正式版服务仍在服务器运行".to_string()
    } else {
        "测试版仍在服务器运行".to_string()
    };
    if !run.completed_steps.iter().any(|step| step == "healthcheck") {
        run.completed_steps.push("healthcheck".to_string());
    }
}

async fn verify_deployed_services(
    run: &mut DeploymentRun,
    state: &WorkspaceState,
) -> Result<(), String> {
    let manifest = deployment_manifest(run)?;
    let environment = parse_deploy_environment(&run.environment)?;
    let namespace = &manifest.environments.get(environment).target.namespace;
    let expected = manifest
        .services
        .iter()
        .map(|service| {
            let container = format!("{namespace}-{}-1", service.id);
            if !safe_runtime_identifier(&service.id) || !safe_runtime_identifier(&container) {
                return Err("项目服务名称不安全，已停止检查服务器运行状态".to_string());
            }
            Ok((service.id.clone(), container))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let command = expected
        .iter()
        .map(|(service, container)| {
            format!(
                "if status=$(docker inspect --format '{{{{.State.Status}}}}' {} 2>/dev/null); then health=$(docker inspect --format '{{{{if .State.Health}}}}{{{{.State.Health.Status}}}}{{{{else}}}}none{{{{end}}}}' {} 2>/dev/null || printf 'missing'); printf '%s\\t%s\\t%s\\n' {} \"$status\" \"$health\"; else printf '%s\\tmissing\\tmissing\\n' {}; fi",
                shell_quote(container),
                shell_quote(container),
                shell_quote(service),
                shell_quote(service),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let profile = deployment_server_profile(run, state)?;
    let output = ssh::execute(&profile, &command, None, Duration::from_secs(30))
        .await
        .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err("服务器运行状态检查没有完成，请确认服务器连接后重试".to_string());
    }
    let states = parse_deployed_service_states(&output.stdout, &expected);
    apply_deployed_service_states(run, &states);
    if run.status != "success" {
        enrich_unhealthy_container_diagnostic(run, state).await;
    }
    Ok(())
}

async fn verify_public_routes(
    run: &mut DeploymentRun,
    state: &WorkspaceState,
) -> Result<(), String> {
    let manifest = match deployment_routing_manifest(run) {
        Ok(manifest) => manifest,
        Err(error) => {
            run.status = "needs_action".to_string();
            run.action_url = None;
            run.completed_steps.retain(|step| step != "healthcheck");
            if let Some(reason) = error.strip_prefix("AD-REL-204：") {
                run.current_stage = "prepare-config".to_string();
                run.action_kind = Some("redeploy-test".to_string());
                run.issue_code = Some("AD-REL-204".to_string());
                run.message = format!("当前正式版本不包含项目新增的服务：{reason}");
            } else {
                run.current_stage = "healthcheck".to_string();
                run.action_kind = Some("route-check".to_string());
                run.issue_code = Some("AD-NET-201".to_string());
                run.message = format!(
                    "应用已部署，但无法读取公网路由配置：{}",
                    public_error(error)
                );
            }
            return Ok(());
        }
    };
    let Ok(environment) = parse_deploy_environment(&run.environment) else {
        return Ok(());
    };
    let routes = &manifest.environments.get(environment).domains;
    if routes.is_empty() {
        // An empty, validated routing manifest is an authoritative result,
        // unlike an inspection failure. Remove stale address rows only here.
        run.route_checks.clear();
        mark_public_routes_ready(run);
        return Ok(());
    }
    let route_problems = match check_server_route_activation(run, &manifest, state).await {
        Ok(problems) => problems,
        Err(message) => {
            return Err(message);
        }
    };
    let expected_target = state
        .server_for_project(Path::new(&run.project_path), &run.environment)
        .ok()
        .flatten()
        .map(|server| server.host);
    let mut checks = collect_public_route_statuses(routes, expected_target.as_deref()).await;
    if route_problems.is_empty()
        && let Some(message) = interrupted_route_check_message(&checks)
    {
        return Err(message);
    }
    overlay_server_route_problems(&mut checks, &route_problems);
    run.route_checks.clone_from(&checks);
    if apply_server_route_problems(run, &route_problems) {
        // Status refreshes are strictly read-only. Opening a project or
        // polling a healthy deployment must never rewrite shared Caddy
        // configuration. The explicit repair/takeover actions own mutations.
        return Ok(());
    }
    apply_public_route_checks(run, &checks);
    Ok(())
}

#[tauri::command]
async fn check_deployment_routes(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<PublicRouteStatus>, String> {
    let mut run = state.deployment_run(&run_id)?;
    verify_public_routes(&mut run, state.inner()).await?;
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run.route_checks)
}

#[tauri::command]
async fn retry_deployment_certificates(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<PublicRouteStatus>, String> {
    let mut run = state.deployment_run(&run_id)?;
    if run.environment != "production"
        || run.action_kind.as_deref() != Some("route-check")
        || run.artifacts.is_empty()
    {
        return Err("当前任务不需要重新申请正式地址证书".to_string());
    }
    let manifest = deployment_routing_manifest(&run)?;
    let environment = parse_deploy_environment(&run.environment)?;
    let routes = &manifest.environments.get(environment).domains;
    if routes.is_empty() {
        return Err("当前正式版本没有配置访问地址".to_string());
    }
    let expected_target = state
        .server_for_project(Path::new(&run.project_path), &run.environment)?
        .map(|server| server.host);
    let mut initial = collect_public_route_statuses(routes, expected_target.as_deref()).await;
    let route_problems = match check_server_route_activation(&run, &manifest, state.inner()).await {
        Ok(problems) => problems,
        Err(message) => return Err(message),
    };
    if route_problems.is_empty()
        && let Some(message) = interrupted_route_check_message(&initial)
    {
        return Err(message);
    }
    overlay_server_route_problems(&mut initial, &route_problems);
    run.route_checks.clone_from(&initial);
    if !apply_server_route_problems(&mut run, &route_problems) {
        apply_public_route_checks(&mut run, &initial);
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;

    if !route_problems.is_empty() {
        return Ok(initial);
    }
    if initial.iter().all(|check| check.reachable) {
        return Ok(initial);
    }
    if !certificate_retry_allowed(&initial) {
        // DNS、域名策略或应用错误不能通过重载 Caddy 证书解决。返回逐地址
        // 结果供页面展示，但严格不触碰服务器配置。
        return Ok(initial);
    }

    force_reload_caddy_for_certificates(&run, &manifest, state.inner()).await?;

    // Certificate authorities normally finish within seconds after DNS becomes
    // visible. Keep the explicit user action alive for at most 45 seconds, but
    // stop immediately if every route is ready or the failure changes layer.
    let deadline = Instant::now() + Duration::from_secs(45);
    let final_checks = loop {
        let checks = collect_public_route_statuses(routes, expected_target.as_deref()).await;
        let waiting_only_for_certificate = checks
            .iter()
            .filter(|check| !check.reachable)
            .all(|check| check.phase == "https");
        if checks.iter().all(|check| check.reachable)
            || !waiting_only_for_certificate
            || Instant::now() >= deadline
        {
            break checks;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    };
    run.route_checks.clone_from(&final_checks);
    apply_public_route_checks(&mut run, &final_checks);
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(final_checks)
}

fn certificate_retry_allowed(checks: &[PublicRouteStatus]) -> bool {
    checks.iter().any(|check| !check.reachable)
        && checks
            .iter()
            .filter(|check| !check.reachable)
            .all(|check| check.phase == "https")
}

async fn force_reload_caddy_for_certificates(
    run: &DeploymentRun,
    manifest: &deploy_core::model::ProjectManifest,
    state: &WorkspaceState,
) -> Result<(), String> {
    let environment = parse_deploy_environment(&run.environment)?;
    let hosts = manifest
        .environments
        .get(environment)
        .domains
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    let site_name = format!("{}-{}.caddy", manifest.project.name, run.environment);
    let profile = deployment_server_profile(run, state)?;
    let host_payload = format!("{}\n", hosts.join("\n"));
    let encoded_hosts = BASE64.encode(host_payload.as_bytes());
    let script = caddy_certificate_reload_script(&site_name, &encoded_hosts, &profile.host);
    let output = ssh::execute(
        &profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_secs(75),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(format!(
            "没有完成证书重试：{}",
            redact_text(&output.stderr)
                .lines()
                .last()
                .unwrap_or("统一 Caddy 没有返回检查结果")
        ));
    }
    Ok(())
}

fn caddy_certificate_reload_script(
    site_name: &str,
    encoded_hosts: &str,
    expected_target: &str,
) -> String {
    format!(
        r#"set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 60 9 || {{ echo '同一服务器正在执行其他部署操作' >&2; exit 75; }}
HOSTS_FILE="$(mktemp)"
EXPECTED_IPS_FILE="$(mktemp)"
HOST_IPS_FILE="$(mktemp)"
trap 'rm -f "$HOSTS_FILE" "$EXPECTED_IPS_FILE" "$HOST_IPS_FILE" "${{ACTIVE_CONFIG:-}}" "${{VALIDATE_LOG:-}}"' EXIT
printf '%s' {encoded_hosts} | base64 --decode >"$HOSTS_FILE"
EXPECTED_TARGET={expected_target}
getent ahosts "$EXPECTED_TARGET" | awk '{{print $1}}' | sort -u >"$EXPECTED_IPS_FILE"
test -s "$EXPECTED_IPS_FILE" || {{ echo '无法重新确认绑定服务器的地址，已停止证书重试' >&2; exit 1; }}
while IFS= read -r host; do
  [ -n "$host" ] || continue
  getent ahosts "$host" | awk '{{print $1}}' | sort -u >"$HOST_IPS_FILE"
  test -s "$HOST_IPS_FILE" || {{ echo "$host 当前没有可用的 DNS 解析，已停止证书重试" >&2; exit 1; }}
  awk 'NR==FNR {{ expected[$1]=1; next }} expected[$1] {{ matched=1 }} END {{ exit matched ? 0 : 1 }}' "$EXPECTED_IPS_FILE" "$HOST_IPS_FILE" || {{ echo "$host 不再指向绑定服务器，已停止证书重试" >&2; exit 1; }}
done <"$HOSTS_FILE"
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || true)"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || true)"
test -n "$CADDY_CONTAINER" || {{ echo '统一 Caddy 尚未完成连接' >&2; exit 1; }}
case "$CADDY_SITE_DIRECTORY" in /*) ;; *) echo '统一 Caddy 路由目录无效' >&2; exit 1 ;; esac
docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 || {{ echo '统一 Caddy 当前没有运行' >&2; exit 1; }}
SITE_NAME={site_name}
SITE_FILE="$CADDY_SITE_DIRECTORY/$SITE_NAME"
test -f "$SITE_FILE" || {{ echo '当前项目的 Caddy 路由文件不存在' >&2; exit 1; }}
ACTIVE_CONFIG="$(mktemp)"
VALIDATE_LOG="$(mktemp)"
docker exec "$CADDY_CONTAINER" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$ACTIVE_CONFIG" 2>/dev/null || {{ echo '无法读取统一 Caddy 当前配置' >&2; exit 1; }}
while IFS= read -r host; do
  [ -n "$host" ] || continue
  grep -Fq -- "$host" "$ACTIVE_CONFIG" || {{ echo "$host 还没有加载到统一 Caddy" >&2; exit 1; }}
done <"$HOSTS_FILE"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$VALIDATE_LOG" 2>&1; then
  tail -n 1 "$VALIDATE_LOG" >&2
  exit 1
fi
docker exec "$CADDY_CONTAINER" caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
"#,
        encoded_hosts = shell_quote(encoded_hosts),
        expected_target = shell_quote(expected_target),
        site_name = shell_quote(site_name),
    )
}

async fn collect_public_route_statuses(
    routes: &[deploy_core::model::DomainRoute],
    expected_target: Option<&str>,
) -> Vec<PublicRouteStatus> {
    let expected_target = expected_target.map(str::to_string);
    let route_inputs = routes
        .iter()
        .map(|route| (route.host.clone(), route.path.clone()))
        .collect::<Vec<_>>();
    let mut tasks = tokio::task::JoinSet::new();
    for (position, (host, path)) in route_inputs.iter().cloned().enumerate() {
        let target = expected_target.clone();
        tasks.spawn(async move {
            let status = deploy_core::health::check_public_route_status_for_target(
                &host,
                &path,
                target.as_deref(),
            )
            .await;
            (position, status)
        });
    }
    let mut checks = vec![None; route_inputs.len()];
    while let Some(result) = tasks.join_next().await {
        if let Ok((position, status)) = result
            && let Some(slot) = checks.get_mut(position)
        {
            *slot = Some(status);
        }
    }
    checks
        .into_iter()
        .enumerate()
        .map(|(position, status)| {
            status.unwrap_or_else(|| {
                let host = route_inputs[position].0.clone();
                let path = route_inputs[position].1.clone();
                interrupted_public_route_status(&host, &path)
            })
        })
        .collect()
}

fn interrupted_route_check_message(checks: &[PublicRouteStatus]) -> Option<String> {
    let interrupted = checks
        .iter()
        .filter(|check| !check.reachable && check.phase == "check")
        .map(|check| check.message.trim())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>();
    if interrupted.is_empty() {
        None
    } else if interrupted.len() == 1 {
        Some(interrupted[0].to_string())
    } else {
        Some(format!(
            "{} 个地址检查没有完成：{}",
            interrupted.len(),
            interrupted.join("；")
        ))
    }
}

fn interrupted_public_route_status(host: &str, path: &str) -> PublicRouteStatus {
    let scheme = if host.to_ascii_lowercase().ends_with(".sslip.io") {
        "http"
    } else {
        "https"
    };
    let route_path = if path.starts_with('/') { path } else { "/" };
    PublicRouteStatus {
        host: host.to_string(),
        url: format!("{scheme}://{host}{route_path}"),
        phase: "check".to_string(),
        reachable: false,
        http_status: None,
        message: format!("{host} 的地址检查被中断，请重新检查"),
    }
}

async fn check_server_route_activation(
    run: &DeploymentRun,
    manifest: &deploy_core::model::ProjectManifest,
    state: &WorkspaceState,
) -> Result<Vec<ServerRouteProblem>, String> {
    let environment = parse_deploy_environment(&run.environment)?;
    let routes = &manifest.environments.get(environment).domains;
    if routes.is_empty() {
        return Ok(Vec::new());
    }
    let route_targets = routes
        .iter()
        .map(|route| {
            let service = manifest
                .services
                .iter()
                .find(|service| service.id == route.service)
                .ok_or_else(|| format!("正式地址引用了不存在的服务 {}", route.service))?;
            Ok(format!(
                "{}\t{}-{}-{}:{}",
                route.host,
                manifest.project.name,
                run.environment,
                service.id,
                service.container_port
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let profile = deployment_server_profile(run, state)?;
    let site_name = format!("{}-{}.caddy", manifest.project.name, run.environment);
    let script = server_route_activation_script(&site_name, &route_targets);
    let output = ssh::execute(
        &profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_secs(25),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(format!(
            "无法确认服务器上的统一 Caddy：{}",
            redact_text(&output.stderr)
                .lines()
                .last()
                .unwrap_or("服务器没有返回检查结果")
        ));
    }
    let problems = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            match fields.next()? {
                "ABCDEPLOY_ROUTE_CONFLICT" => {
                    let host = fields.next().unwrap_or("正式地址");
                    let actual = fields.next().unwrap_or("旧服务");
                    let expected = fields.next().unwrap_or("本次发布");
                    Some(ServerRouteProblem {
                        kind: ServerRouteProblemKind::Takeover,
                        host: host.to_string(),
                        message: format!(
                            "{host} 仍由旧服务 {actual} 提供，需要确认后切换到新版本 {expected}"
                        ),
                    })
                }
                "ABCDEPLOY_ROUTE_MISMATCH" => {
                    let host = fields.next().unwrap_or("正式地址");
                    let actual = fields.next().unwrap_or("其他服务");
                    let expected = fields.next().unwrap_or("本次发布");
                    Some(ServerRouteProblem {
                        kind: ServerRouteProblemKind::Repair,
                        host: host.to_string(),
                        message: format!(
                            "{host} 的地址配置仍指向 {actual}，需要恢复到新版本 {expected}"
                        ),
                    })
                }
                "ABCDEPLOY_ROUTE_MISSING" => {
                    let host = fields.next().unwrap_or("正式地址");
                    Some(ServerRouteProblem {
                        kind: ServerRouteProblemKind::Repair,
                        host: host.to_string(),
                        message: format!("{host} 已解析，但服务器尚未启用这个访问地址"),
                    })
                }
                _ => None,
            }
        })
        .collect();
    Ok(problems)
}

fn caddy_route_declared_shell_function() -> &'static str {
    r#"route_declared_in_file() {
  awk -v target_host="$1" '
    BEGIN {
      target=tolower(target_host);
      sub(/^https?:\/\//, "", target);
      sub(/:(80|443)$/, "", target);
      sub(/\.$/, "", target);
      depth=0;
      found=0;
    }
    {
      open_line=$0; close_line=$0;
      opens=gsub(/\{/, "{", open_line); closes=gsub(/\}/, "}", close_line);
      if (depth == 0 && index($0, "{") > 0) {
        header=$0;
        sub(/\{.*/, "", header);
        gsub(/[[:space:]]/, "", header);
        count=split(header, labels, ",");
        for (i=1; i<=count; i++) {
          candidate=tolower(labels[i]);
          sub(/^https?:\/\//, "", candidate);
          sub(/:(80|443)$/, "", candidate);
          sub(/\.$/, "", candidate);
          if (candidate == target) found=1;
        }
      }
      depth += opens - closes;
    }
    END { exit found ? 0 : 1 }
  ' "$2"
}"#
}

fn caddy_main_route_rewrite_shell_function() -> &'static str {
    r#"rewrite_caddy_main_routes() {
  awk -v hosts_file="$1" '
    function normalize(value, normalized) {
      normalized=tolower(value);
      sub(/^https?:\/\//, "", normalized);
      sub(/:(80|443)$/, "", normalized);
      sub(/\.$/, "", normalized);
      return normalized;
    }
    function trim(value) {
      sub(/^[[:space:]]+/, "", value);
      sub(/[[:space:]]+$/, "", value);
      return value;
    }
    BEGIN {
      while ((getline host < hosts_file) > 0) targets[normalize(host)]=1;
      close(hosts_file);
      depth=0;
      skip=0;
    }
    {
      original=$0;
      open_line=$0; close_line=$0;
      opens=gsub(/\{/, "{", open_line); closes=gsub(/\}/, "}", close_line);
      rewritten=0;
      if (!skip && depth == 0 && index($0, "{") > 0) {
        header=$0;
        sub(/\{.*/, "", header);
        count=split(header, labels, ",");
        remaining="";
        matched=0;
        for (i=1; i<=count; i++) {
          label=trim(labels[i]);
          if (label != "" && targets[normalize(label)]) {
            matched=1;
          } else if (label != "") {
            remaining=(remaining == "" ? label : remaining ", " label);
          }
        }
        if (matched && remaining == "") {
          skip=1;
        } else if (matched) {
          indent=$0;
          sub(/[^[:space:]].*/, "", indent);
          suffix=$0;
          sub(/^[^\{]*\{/, "{", suffix);
          print indent remaining " " suffix;
          rewritten=1;
        }
      }
      if (!skip && !rewritten) print original;
      depth += opens - closes;
      if (skip && depth == 0) skip=0;
    }
  ' "$2" >"$3"
}"#
}

fn server_route_activation_script(site_name: &str, route_targets: &[String]) -> String {
    let route_payload = if route_targets.is_empty() {
        String::new()
    } else {
        format!("{}\n", route_targets.join("\n"))
    };
    let encoded_routes = BASE64.encode(route_payload.as_bytes());
    let route_declared = caddy_route_declared_shell_function();
    format!(
        r#"set -eu
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || true)"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || true)"
test -n "$CADDY_CONTAINER" || {{ echo '统一 Caddy 尚未完成连接' >&2; exit 1; }}
case "$CADDY_SITE_DIRECTORY" in /*) ;; *) echo '统一 Caddy 路由目录无效' >&2; exit 1 ;; esac
docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 || {{ echo '统一 Caddy 当前没有运行' >&2; exit 1; }}
SITE_NAME={site_name}
SITE_FILE="$CADDY_SITE_DIRECTORY/$SITE_NAME"
MAIN_FILE="$(mktemp)"
ACTIVE_CONFIG="$(mktemp)"
ROUTES_FILE="$(mktemp)"
trap 'rm -f "$MAIN_FILE" "$ACTIVE_CONFIG" "$ROUTES_FILE"' EXIT
printf '%s' {encoded_routes} | base64 --decode >"$ROUTES_FILE"
docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile >"$MAIN_FILE" || {{ echo '无法读取统一 Caddy 主配置' >&2; exit 1; }}
docker exec "$CADDY_CONTAINER" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$ACTIVE_CONFIG" 2>/dev/null || {{ echo '无法读取统一 Caddy 当前配置' >&2; exit 1; }}
block_target() {{
  awk -v target_host="$1" '
    BEGIN {{
      target=tolower(target_host);
      sub(/^https?:\/\//, "", target);
      sub(/:(80|443)$/, "", target);
      sub(/\.$/, "", target);
      depth=0;
    }}
    {{
      open_line=$0; close_line=$0;
      opens=gsub(/\{{/, "{{", open_line); closes=gsub(/\}}/, "}}", close_line);
      if (!inside && depth == 0 && index($0, "{{") > 0) {{
        header=$0;
        sub(/\{{.*/, "", header);
        gsub(/[[:space:]]/, "", header);
        count=split(header, labels, ",");
        for (i=1; i<=count; i++) {{
          site_host=tolower(labels[i]);
          sub(/^https?:\/\//, "", site_host);
          sub(/:(80|443)$/, "", site_host);
          sub(/\.$/, "", site_host);
          if (site_host == target) inside=1;
        }}
      }}
      if (inside && $1 == "reverse_proxy") {{ print $2; exit }}
      depth += opens - closes;
      if (inside && depth == 0) exit;
    }}
  ' "$2"
}}
{route_declared}
while IFS="$(printf '\t')" read -r host expected; do
  [ -n "$host" ] || continue
  if route_declared_in_file "$host" "$MAIN_FILE"; then
    main_target="$(block_target "$host" "$MAIN_FILE")"
    [ -n "$main_target" ] || main_target='已有 Caddy 配置'
    printf 'ABCDEPLOY_ROUTE_CONFLICT\t%s\t%s\t%s\n' "$host" "$main_target" "$expected"
    continue
  fi
  if [ ! -f "$SITE_FILE" ]; then
    printf 'ABCDEPLOY_ROUTE_MISSING\t%s\tfile\t%s\n' "$host" "$expected"
    continue
  fi
  if ! route_declared_in_file "$host" "$SITE_FILE"; then
    printf 'ABCDEPLOY_ROUTE_MISSING\t%s\tfile\t%s\n' "$host" "$expected"
    continue
  fi
  site_target="$(block_target "$host" "$SITE_FILE")"
  if [ -z "$site_target" ]; then
    printf 'ABCDEPLOY_ROUTE_MISMATCH\t%s\t%s\t%s\n' "$host" '未识别上游服务' "$expected"
  elif [ "$site_target" != "$expected" ]; then
    printf 'ABCDEPLOY_ROUTE_MISMATCH\t%s\t%s\t%s\n' "$host" "$site_target" "$expected"
  elif ! grep -Fq -- "$host" "$ACTIVE_CONFIG" || ! grep -Fq -- "$expected" "$ACTIVE_CONFIG"; then
    printf 'ABCDEPLOY_ROUTE_MISSING\t%s\tactive\t%s\n' "$host" "$expected"
  fi
done <"$ROUTES_FILE"
"#,
        encoded_routes = shell_quote(&encoded_routes),
        site_name = shell_quote(site_name),
        route_declared = route_declared,
    )
}

fn deployment_server_profile(
    run: &DeploymentRun,
    state: &WorkspaceState,
) -> Result<ssh::SshProfile, String> {
    let server = state
        .server_for_project(Path::new(&run.project_path), &run.environment)?
        .ok_or_else(|| "没有找到这个环境的服务器连接，请重新选择服务器".to_string())?;
    if !server.key_path_exists {
        return Err("服务器连接使用的 SSH 私钥已移动，请重新选择安全凭据".to_string());
    }
    Ok(ssh::SshProfile {
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        key_path: PathBuf::from(server.key_path),
        host_fingerprint: server.host_fingerprint,
    })
}

fn deployment_manifest(run: &DeploymentRun) -> Result<deploy_core::model::ProjectManifest, String> {
    let root = Path::new(&run.project_path);
    let revision = checked_git_revision(run.commit_sha.as_deref())?
        .ok_or_else(|| "本次部署缺少可用于读取配置快照的提交标识".to_string())?;
    let object = format!("{revision}:{MANIFEST_FILE}");
    let raw = git_stdout(root, &["show", &object])?;
    parse_manifest(&raw, &root.join(MANIFEST_FILE)).map_err(public_error)
}

fn deployment_routing_manifest(
    run: &DeploymentRun,
) -> Result<deploy_core::model::ProjectManifest, String> {
    let root = Path::new(&run.project_path);
    let deployed = deployment_manifest(run)?;
    validate_deployment_routing_manifest(&deployed, "已部署版本")?;
    let current = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    validate_deployment_routing_manifest(&current, "当前项目")?;
    if current.project.name != deployed.project.name {
        return Err("当前项目配置与已部署版本不属于同一个项目".to_string());
    }
    let environment = parse_deploy_environment(&run.environment)?;
    let deployed_services = deployed
        .services
        .iter()
        .map(|service| service.id.as_str())
        .collect::<BTreeSet<_>>();
    if let Some(route) = current
        .environments
        .get(environment)
        .domains
        .iter()
        .find(|route| !deployed_services.contains(route.service.as_str()))
    {
        return Err(format!(
            "AD-REL-204：{}，请先部署包含它的新测试版本",
            route.service
        ));
    }
    Ok(current)
}

fn validate_deployment_routing_manifest(
    manifest: &deploy_core::model::ProjectManifest,
    source: &str,
) -> Result<(), String> {
    let validation = validate_manifest(manifest);
    if validation.valid {
        return Ok(());
    }
    let reason = validation
        .issues
        .iter()
        .find(|issue| matches!(issue.level, deploy_core::model::DiagnosticLevel::Error))
        .map_or("部署配置不合法", |issue| issue.message.as_str());
    Err(format!("{source}的 deploy.yaml 未通过安全校验：{reason}"))
}

fn overlay_server_route_problems(
    checks: &mut [PublicRouteStatus],
    problems: &[ServerRouteProblem],
) {
    for problem in problems {
        let Some(check) = checks
            .iter_mut()
            .find(|check| check.host.eq_ignore_ascii_case(&problem.host))
        else {
            continue;
        };
        check.phase = match problem.kind {
            ServerRouteProblemKind::Takeover => "route-conflict",
            ServerRouteProblemKind::Repair => "route-missing",
        }
        .to_string();
        check.reachable = false;
        check.http_status = None;
        check.message.clone_from(&problem.message);
    }
}

fn apply_server_route_problems(run: &mut DeploymentRun, problems: &[ServerRouteProblem]) -> bool {
    let takeover = problems
        .iter()
        .filter(|problem| problem.kind == ServerRouteProblemKind::Takeover)
        .collect::<Vec<_>>();
    if !takeover.is_empty() {
        let mut message = takeover
            .iter()
            .map(|problem| problem.message.as_str())
            .collect::<Vec<_>>()
            .join("；");
        let repairs = problems
            .iter()
            .filter(|problem| problem.kind == ServerRouteProblemKind::Repair)
            .count();
        if repairs > 0 {
            let _ = write!(
                message,
                "；另外 {repairs} 个未冲突地址尚未启用，可以先单独恢复，不影响正在使用的旧服务"
            );
        }
        apply_server_route_takeover_problem(run, &message);
        return true;
    }
    let repairs = problems
        .iter()
        .filter(|problem| problem.kind == ServerRouteProblemKind::Repair)
        .map(|problem| problem.message.as_str())
        .collect::<Vec<_>>();
    if repairs.is_empty() {
        return false;
    }
    apply_server_route_problem(run, &repairs.join("；"));
    true
}

fn apply_public_route_checks(run: &mut DeploymentRun, checks: &[PublicRouteStatus]) {
    let failures = checks
        .iter()
        .filter(|check| !check.reachable)
        .collect::<Vec<_>>();
    if let Some(failure) = failures.first() {
        run.status = "needs_action".to_string();
        run.current_stage = "healthcheck".to_string();
        run.action_kind = Some("route-check".to_string());
        run.action_url = None;
        run.issue_code = Some("AD-NET-201".to_string());
        run.completed_steps.retain(|step| step != "healthcheck");
        run.message = if failures.len() == 1 {
            format!("应用已经部署成功，访问地址暂未就绪：{}", failure.message)
        } else {
            let details = failures
                .iter()
                .map(|check| check.message.trim())
                .collect::<Vec<_>>()
                .join("；");
            format!(
                "应用已经部署成功，{} 个访问地址暂未就绪：{details}",
                failures.len()
            )
        };
        return;
    }
    if !checks.is_empty() {
        run.message = if run.environment == "production" {
            "生产环境已按测试通过的同一镜像摘要发布，域名和 HTTPS 可访问".to_string()
        } else {
            "测试环境部署完成，域名和 HTTPS 可访问".to_string()
        };
    }
    mark_public_routes_ready(run);
}

fn apply_server_route_problem(run: &mut DeploymentRun, message: &str) {
    run.status = "needs_action".to_string();
    run.current_stage = "prepare-server".to_string();
    run.action_kind = Some("route-repair".to_string());
    run.action_url = None;
    run.issue_code = Some("AD-SRV-209".to_string());
    run.completed_steps.retain(|step| step != "healthcheck");
    run.message = format!("应用容器已经部署，但正式地址没有生效：{message}");
}

fn apply_server_route_takeover_problem(run: &mut DeploymentRun, message: &str) {
    run.status = "needs_action".to_string();
    run.current_stage = "prepare-server".to_string();
    run.action_kind = Some("route-takeover".to_string());
    run.action_url = None;
    run.issue_code = Some("AD-SRV-206".to_string());
    run.completed_steps.retain(|step| step != "healthcheck");
    run.message = format!("应用容器已经部署，但正式地址仍指向旧服务：{message}");
}

fn mark_public_routes_ready(run: &mut DeploymentRun) {
    run.status = "success".to_string();
    run.current_stage = "complete".to_string();
    run.action_kind = None;
    run.issue_code = None;
    if !run.completed_steps.iter().any(|step| step == "healthcheck") {
        run.completed_steps.push("healthcheck".to_string());
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn list_deployment_runs(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_deployment_runs(Path::new(&path))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn list_project_environments(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<ProjectEnvironment>, String> {
    state.list_project_environments(Path::new(&path))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn list_project_versions(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<ProjectVersion>, String> {
    state.list_project_versions(Path::new(&path))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn list_version_validations(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<VersionValidation>, String> {
    state.list_version_validations(Path::new(&path))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn set_version_validation(
    path: String,
    run_id: String,
    validation_state: String,
    state: State<'_, WorkspaceState>,
) -> Result<VersionValidation, String> {
    state.set_version_validation(Path::new(&path), &run_id, &validation_state)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_active_deployment_runs(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_active_deployment_runs()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_attention_deployment_runs(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_attention_deployment_runs()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_recent_successful_deployment_runs(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_recent_successful_deployment_runs()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn sync_external_deployments(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    let root = PathBuf::from(&path);
    let adoption = state.project_adoption(&root)?;
    if adoption.mode == "pending" {
        return Err("AD-ADOPT-101：请先选择继续管理已有部署或重新设置部署".to_string());
    }
    if adoption.fresh_draft {
        return Err("AD-ADOPT-102：请先确认新的部署设置，再检查后续构建".to_string());
    }
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let payload = client
        .recent_builds(&manifest.providers.build.repository, 30)
        .await
        .map_err(cnb_build_history_error)?;
    let mut records = ordered_build_records(&payload);
    let latest_success_serials = latest_success_serials_by_environment(&records);
    let mut imported = Vec::new();
    let mut diagnosed_failure = false;
    for record in records.drain(..) {
        // `deploydesk-production` 只是把已验证提交转换为生产自定义事件，
        // 自身不部署测试环境。历史同步不能把这条 push 误记为新的测试版。
        if is_production_approval_build(&record) {
            if let Some(mut run) = state.deployment_run_by_serial_for_project(
                &root,
                &manifest.providers.build.repository,
                &record.serial,
            )? {
                apply_version_title(&mut run, &record, &root);
                run.status = "cancelled".to_string();
                run.current_stage = "complete".to_string();
                run.action_kind = Some("production-approval".to_string());
                run.issue_code = None;
                run.message = "生产审批已完成，此记录不计为测试部署".to_string();
                run.updated_at = Utc::now().to_rfc3339();
                state.save_deployment_run(&run)?;
                imported.push(run);
            }
            continue;
        }
        let Some(environment) = build_environment_for_event(&record.event) else {
            continue;
        };
        let is_latest_success = record.status == "success"
            && latest_success_serials
                .get(environment)
                .is_some_and(|serial| serial == &record.serial);
        let record_started_at = record
            .created_at
            .as_deref()
            .filter(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
            .map(ToString::to_string);
        if let Some(mut run) = state.deployment_run_by_serial_for_project(
            &root,
            &manifest.providers.build.repository,
            &record.serial,
        )? {
            // The deployment-path workflow owns its task from the local snapshot
            // through registry transfer, server mutation and the final route
            // check.  The legacy CNB-history importer only knows that the remote
            // build finished; treating that as a complete environment deployment
            // overwrites the live path task with `verify-existing-deployment`
            // before the desktop can transfer the immutable images to TCR.
            //
            // Keep returning the row so callers can refresh their local list, but
            // never let the legacy importer mutate a run already bound to a path.
            if deployment_path_owns_history_reconciliation(
                environment,
                state.deployment_path_for_run(&run.id).is_ok(),
            ) {
                imported.push(run);
                continue;
            }
            apply_version_title(&mut run, &record, &root);
            // 旧版本先插入本机时间再更新 CNB 时间，但 SQLite 的 upsert 曾没有更新
            // started_at，导致数月前的失败记录排在刚成功的版本前面。每次后台同步都
            // 用 CNB 原始时间修正；运行中的任务也顺便收敛到远端最终状态。
            if let Some(started_at) = record_started_at {
                run.started_at = started_at;
            }
            let status_changed = matches!(run.status.as_str(), "queued" | "running")
                || (run.status == "failed" && record.status == "success")
                || (run.status == "needs_action" && record.status != "success");
            if status_changed {
                apply_history_status(&mut run, &record.status);
                run.message = synced_history_message(environment, &run.status);
            }
            if environment == "production"
                && let Some(revision) = record.revision.as_deref()
                && let Some(source) = state.successful_staging_run_by_revision(&root, revision)?
            {
                // A production record may have been imported before its
                // staging source in an older app version. Reconcile the link
                // on every sync instead of leaving it permanently unresolved.
                run.source_run_id = Some(source.id);
            }
            let should_verify_existing = record.status == "success"
                && is_latest_success
                && (status_changed
                    || run.artifacts.is_empty()
                    || matches!(
                        run.action_kind.as_deref(),
                        Some("verify-existing-deployment" | "artifact-mismatch")
                    ));
            if should_verify_existing {
                apply_history_status(&mut run, &record.status);
                run.action_kind = Some("verify-existing-deployment".to_string());
                finalize_successful_deployment(&mut run, &state).await;
                if run.status == "success" && environment == "production" {
                    run.message = "已同步手机端完成的正式发布，并核对同一镜像摘要".to_string();
                }
            }
            if run.status == "failed" && !diagnosed_failure {
                enrich_failed_cnb_run(&client, &mut run, &state).await;
                diagnosed_failure = true;
            }
            run.updated_at = Utc::now().to_rfc3339();
            state.save_deployment_run(&run)?;
            imported.push(run);
            continue;
        }
        let started_at = if adoption.mode == "fresh" {
            let Some(started_at) = record_started_at else {
                // A provider record without a trustworthy creation time could
                // predate the local reset. Fresh mode is conservative and
                // never guesses that such a record is new.
                continue;
            };
            let Some(cutoff) = adoption.history_import_after.as_deref() else {
                continue;
            };
            let Ok(started) = chrono::DateTime::parse_from_rfc3339(&started_at) else {
                continue;
            };
            let Ok(cutoff) = chrono::DateTime::parse_from_rfc3339(cutoff) else {
                continue;
            };
            if started <= cutoff {
                continue;
            }
            started_at
        } else {
            record_started_at.unwrap_or_else(|| Utc::now().to_rfc3339())
        };
        let mut run = state.deployment_run_draft(
            &root,
            &manifest.project.name,
            environment,
            &manifest.providers.build.repository,
            &manifest.source.release_branch,
        )?;
        run.commit_sha = record.revision.clone();
        apply_version_title(&mut run, &record, &root);
        run.build_serial = Some(record.serial);
        run.candidate_tag = record
            .source_ref
            .as_deref()
            .and_then(safe_candidate_tag)
            .map(ToString::to_string)
            .or_else(|| {
                record.revision.as_ref().map(|revision| {
                    manifest
                        .release
                        .candidate_tag_template
                        .replace("{commit}", revision)
                })
            });
        if environment == "production" {
            run.source_run_id = if let Some(revision) = record.revision.as_deref() {
                state
                    .successful_staging_run_by_revision(&root, revision)?
                    .map(|source| source.id)
            } else {
                None
            };
        }
        run.started_at = started_at;
        run.updated_at.clone_from(&run.started_at);
        apply_history_status(&mut run, &record.status);
        run.message = synced_history_message(environment, &run.status);
        if run.status == "failed" && !diagnosed_failure {
            enrich_failed_cnb_run(&client, &mut run, &state).await;
            diagnosed_failure = true;
        }
        if run.status == "success" && is_latest_success {
            // This successful deployment was discovered remotely rather than
            // started by the current local task. If the server binding is not
            // available yet, present it as an existing deployment awaiting
            // verification instead of as a newly failed release.
            run.action_kind = Some("verify-existing-deployment".to_string());
            finalize_successful_deployment(&mut run, &state).await;
            if run.status == "success" && environment == "production" {
                run.message = "已同步手机端完成的正式发布，并核对同一镜像摘要".to_string();
            }
        } else if run.status == "success"
            && environment == "production"
            && run.source_run_id.is_none()
        {
            // Historic CNB success is still useful deployment history, but a
            // production row without its staging source cannot safely become
            // an immutable version pointer.
            run.status = "needs_action".to_string();
            run.current_stage = "verify-release".to_string();
            run.action_kind = Some("verify-existing-deployment".to_string());
            run.issue_code = Some("AD-REL-301".to_string());
            run.message = "历史正式发布已导入，但缺少对应的测试版本，暂未核对".to_string();
        }
        state.save_deployment_run(&run)?;
        imported.push(run);
    }
    imported.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(imported)
}

fn ordered_build_records(payload: &serde_json::Value) -> Vec<CnbBuildRecord> {
    let mut records = build_records(payload);
    records.sort_by(|left, right| {
        let left_time = left
            .created_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
        let right_time = right
            .created_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
        left_time
            .cmp(&right_time)
            .then_with(|| {
                build_record_environment_order(left).cmp(&build_record_environment_order(right))
            })
            .then_with(|| left.serial.cmp(&right.serial))
    });
    records
}

fn build_record_environment_order(record: &CnbBuildRecord) -> u8 {
    match build_environment_for_event(&record.event) {
        Some("deployment") => 0,
        Some("staging") => 1,
        Some("production") => 2,
        _ => 3,
    }
}

fn deployment_path_owns_history_reconciliation(
    environment: &str,
    bound_to_deployment_path: bool,
) -> bool {
    environment == "deployment" && bound_to_deployment_path
}

fn latest_success_serials_by_environment(
    records: &[CnbBuildRecord],
) -> BTreeMap<&'static str, String> {
    let mut result = BTreeMap::new();
    for record in records {
        if record.status != "success" || is_production_approval_build(record) {
            continue;
        }
        if let Some(environment) = build_environment_for_event(&record.event) {
            result.insert(environment, record.serial.clone());
        }
    }
    result
}

fn synced_history_message(environment: &str, status: &str) -> String {
    let label = match environment {
        "production" => "正式发布",
        "staging" => "测试部署",
        _ => "上线版本",
    };
    if status == "success" {
        match environment {
            "production" => "已同步手机端完成的正式发布".to_string(),
            "staging" => "已同步 CNB 完成的测试部署".to_string(),
            _ => "已同步构建服务完成的上线版本".to_string(),
        }
    } else if matches!(status, "running" | "queued") {
        format!("已同步 CNB 页面触发的{label}任务")
    } else {
        format!("CNB 页面触发的{label}任务未完成")
    }
}

fn safe_candidate_tag(value: &str) -> Option<&str> {
    let value = value
        .trim()
        .strip_prefix("refs/tags/")
        .unwrap_or(value.trim());
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    .then_some(value)
}

fn build_environment_for_event(event: &str) -> Option<&'static str> {
    match event {
        "push" | "git_push" | "api_trigger_deployment_path_build" => Some("deployment"),
        "api_trigger_staging" | "tag_deploy.staging" => Some("staging"),
        "api_trigger_production" | "tag_deploy.production" => Some("production"),
        _ => None,
    }
}

fn is_production_approval_build(record: &CnbBuildRecord) -> bool {
    matches!(record.event.as_str(), "push" | "git_push")
        && record.source_ref.as_deref() == Some("deploydesk-production")
}

fn apply_history_status(run: &mut DeploymentRun, status: &str) {
    match status {
        "success" => {
            run.status = "success".to_string();
            run.current_stage = "complete".to_string();
            run.issue_code = None;
            run.completed_steps = vec![
                "write-config".to_string(),
                "verify-build".to_string(),
                "publish-images".to_string(),
                "prepare-server".to_string(),
                "deploy".to_string(),
                "verify-release".to_string(),
                "healthcheck".to_string(),
            ];
        }
        "error" | "failed" => {
            run.status = "failed".to_string();
            // Build history alone does not say whether the failure happened
            // before or after a server was touched. Keep the neutral build
            // stage until the status and redacted runner log are inspected.
            run.current_stage = "build".to_string();
            run.issue_code = Some("AD-BLD-201".to_string());
        }
        "waiting" | "pending" | "queued" => {
            run.status = "queued".to_string();
            run.current_stage = "prepare".to_string();
        }
        _ => {
            run.status = "running".to_string();
            run.current_stage = "deploy".to_string();
        }
    }
}

async fn trigger_cnb_run(
    mut run: DeploymentRun,
    event: &str,
    revision: Option<&str>,
    prefer_push_build: bool,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    if run.commit_sha.is_none() && run.environment == "staging" {
        run.commit_sha = local_git_revision(Path::new(&run.project_path));
    }
    let expected_revision = run.commit_sha.clone();
    let result = async {
        let token = Zeroizing::new(resolve_cnb_token(String::new())?);
        let client = CnbClient::new(token.as_str()).map_err(public_error)?;
        if prefer_push_build
            && let Some(expected_revision) = expected_revision.as_deref()
            && let Some(serial) = recover_triggered_build(
                &client,
                &run.repository,
                expected_revision,
                &run.environment,
                5,
            )
            .await?
        {
            return Ok::<(Option<String>, bool), String>((Some(serial), true));
        }
        let response = client
            .trigger_build_at_revision(
                &run.repository,
                &run.branch,
                event,
                &format!("ABCDeploy · {} · {}", run.project_name, run.environment),
                revision,
            )
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error)
                if event == "api_trigger_production"
                    && matches!(&error, DeployError::CnbApi { status: 403, .. }) =>
            {
                let Some(expected_revision) = expected_revision.as_deref() else {
                    return Err("正式发布缺少已验证的完整提交标识".to_string());
                };
                push_production_approval_branch(
                    Path::new(&run.project_path),
                    &run.repository,
                    expected_revision,
                    token.as_str(),
                )?;
                let serial = recover_triggered_build(
                    &client,
                    &run.repository,
                    expected_revision,
                    "production",
                    15,
                )
                .await?;
                return Ok::<(Option<String>, bool), String>((serial, false));
            }
            Err(error)
                if matches!(event, "api_trigger_staging" | "api_trigger_deployment_path_build")
                    && prefer_push_build
                    && matches!(&error, DeployError::CnbApi { status: 403, .. }) =>
            {
                let trigger_error = cnb_public_error(error);
                let Some(expected_revision) = expected_revision.as_deref() else {
                    return Err(trigger_error);
                };
                if let Some(serial) = recover_triggered_build(
                    &client,
                    &run.repository,
                    expected_revision,
                    &run.environment,
                    5,
                )
                .await?
                {
                    return Ok::<(Option<String>, bool), String>((Some(serial), true));
                }
                return Err(
                    "CNB 没有找到这次提交的自动构建，当前令牌也不能主动开始构建。请在 CNB 令牌中补充 repo-cnb-trigger:rw，然后返回“服务连接”重新保存"
                        .to_string(),
                );
            }
            Err(error) => return Err(cnb_public_error(error)),
        };
        if let Some(revision) = build_revision(&response) {
            run.commit_sha = Some(revision);
        }
        let serial = if let Some(serial) = build_serial(&response) {
            Some(serial)
        } else if let Some(expected_revision) = expected_revision.as_deref() {
            recover_triggered_build(
                &client,
                &run.repository,
                expected_revision,
                &run.environment,
                5,
            )
            .await?
        } else {
            None
        };
        Ok::<(Option<String>, bool), String>((serial, false))
    }
    .await;

    match result {
        Ok((serial, recovered_from_push)) => {
            let missing_serial = serial.is_none();
            run.build_serial = serial;
            run.status = if missing_serial {
                "needs_action".to_string()
            } else {
                "running".to_string()
            };
            run.current_stage = if missing_serial {
                "prepare".to_string()
            } else {
                "build".to_string()
            };
            run.action_kind = None;
            run.action_url = None;
            run.issue_code = missing_serial.then(|| "AD-CNB-202".to_string());
            run.message = if missing_serial {
                if run.environment == "production" {
                    "CNB 没有创建与测试通过版本匹配的生产任务，请重新发布".to_string()
                } else {
                    "CNB 没有创建与当前提交匹配的测试任务，请重新部署".to_string()
                }
            } else if recovered_from_push {
                "代码推送已自动开始 CNB 构建，无需补充令牌权限".to_string()
            } else {
                "CNB 已开始构建，关闭应用后也可以继续查看".to_string()
            };
        }
        Err(message) => {
            let permission_error = message.starts_with("AD-CNB-103");
            let history_permission_error = message.contains("repo-cnb-history:r");
            run.status = if permission_error || message.contains("重新连接") {
                "needs_action".to_string()
            } else {
                "failed".to_string()
            };
            run.issue_code = Some(if permission_error {
                "AD-CNB-103".to_string()
            } else if message.contains("重新连接") {
                "AD-CNB-101".to_string()
            } else {
                "AD-CNB-203".to_string()
            });
            run.message = if history_permission_error {
                "代码已推送并由 CNB 自动构建；当前授权无法读取构建结果，可前往 CNB 查看或补充“构建记录读取”权限"
                    .to_string()
            } else if permission_error {
                "CNB 授权缺少“触发构建”权限，请更新授权后重新发布".to_string()
            } else {
                message
            };
            if history_permission_error {
                run.current_stage = "build".to_string();
                run.action_kind = Some("cnb-builds".to_string());
                run.action_url = Some(format!("https://cnb.cool/{}/-/build/logs", run.repository));
            }
        }
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

fn local_git_revision(root: &Path) -> Option<String> {
    git_stdout(root, &["rev-parse", "HEAD"])
        .ok()
        .and_then(|value| checked_git_revision(Some(&value)).ok().flatten())
}

fn local_git_title(root: &Path, revision: &str) -> Option<String> {
    checked_git_revision(Some(revision)).ok().flatten()?;
    git_stdout(root, &["show", "-s", "--format=%s", revision])
        .ok()
        .and_then(|title| readable_version_title(&title))
}

fn apply_version_title(run: &mut DeploymentRun, record: &CnbBuildRecord, root: &Path) {
    if let Some(title) = readable_version_title(&record.title).or_else(|| {
        run.commit_sha
            .as_deref()
            .and_then(|revision| local_git_title(root, revision))
    }) {
        run.source_title = Some(title);
    }
}

fn readable_version_title(title: &str) -> Option<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    if matches!(
        title.to_ascii_lowercase().as_str(),
        "api custom event" | "custom event" | "api trigger" | "cnb custom event" | "manual trigger"
    ) {
        return None;
    }
    let title = title
        .split_once(':')
        .filter(|(prefix, _)| {
            let prefix = prefix.trim().to_ascii_lowercase();
            ["feat", "fix", "perf", "refactor", "chore", "docs", "test"]
                .iter()
                .any(|kind| {
                    prefix == *kind
                        || prefix
                            .strip_prefix(kind)
                            .is_some_and(|scope| scope.starts_with('(') && scope.ends_with(')'))
                })
        })
        .map_or(title.as_str(), |(_, rest)| rest.trim());
    let friendly = match title.to_ascii_lowercase().as_str() {
        "initialize project for abcdeploy" => "初始化 ABCDeploy 项目",
        "configure abcdeploy deployment" => "完成首次上线配置",
        "update abcdeploy deployment" | "update abcdeploy deployment config" => "更新上线配置",
        _ => title,
    };
    Some(friendly.chars().take(120).collect())
}

fn push_production_approval_branch(
    root: &Path,
    repository: &str,
    revision: &str,
    token: &str,
) -> Result<(), String> {
    validate_repository_slug(repository)?;
    checked_git_revision(Some(revision))?;
    let pipeline = git_stdout(root, &["show", &format!("{revision}:.cnb.yml")])?;
    if !pipeline.contains("deploydesk-production:") || !pipeline.contains("type: cnb:apply") {
        return Err("当前测试版本还没有安全的生产审批通道，请先重新部署一次测试版".to_string());
    }
    let credentials = Zeroizing::new(format!("cnb:{token}"));
    let authorization = Zeroizing::new(format!(
        "Authorization: Basic {}",
        BASE64.encode(credentials.as_bytes())
    ));
    let remote = format!("https://cnb.cool/{repository}.git");
    let current = git_stdout_with_authorization(
        root,
        &["ls-remote", &remote, "refs/heads/deploydesk-production"],
        authorization.as_str(),
        "读取生产审批分支",
    )?;
    let expected_remote = current
        .split_whitespace()
        .next()
        .filter(|value| matches!(value.len(), 40 | 64))
        .unwrap_or("");
    let lease = format!("--force-with-lease=refs/heads/deploydesk-production:{expected_remote}");
    let refspec = format!("{revision}:refs/heads/deploydesk-production");
    let mut push = system_command("git");
    push.current_dir(root)
        .arg("push")
        .arg(&lease)
        .arg(remote)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://cnb.cool/.extraHeader")
        .env("GIT_CONFIG_VALUE_0", authorization.as_str())
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL");
    run_git_command(push, "提交生产审批")
}

fn checked_git_revision(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("CNB 构建提交标识格式不正确".to_string());
    }
    Ok(Some(value.to_string()))
}

async fn recover_triggered_build(
    client: &CnbClient,
    repository: &str,
    expected_revision: &str,
    environment: &str,
    attempts: usize,
) -> Result<Option<String>, String> {
    for attempt in 0..attempts {
        let payload = client
            .recent_builds(repository, 20)
            .await
            .map_err(cnb_build_history_error)?;
        if let Some(serial) = build_serial_for_revision(&payload, expected_revision, environment) {
            return Ok(Some(serial));
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    Ok(None)
}

fn build_serial_for_revision(
    payload: &serde_json::Value,
    expected_revision: &str,
    environment: &str,
) -> Option<String> {
    build_records(payload)
        .into_iter()
        .find(|record| {
            if record.revision.as_deref() != Some(expected_revision) {
                return false;
            }
            build_environment_for_event(&record.event) == Some(environment)
                || (environment == "staging"
                    && matches!(record.event.as_str(), "push" | "git_push"))
        })
        .map(|record| record.serial)
}

fn update_run_from_cnb(run: &mut DeploymentRun, payload: &serde_json::Value) {
    let summary = summarize_build_status(payload);
    let current = summary
        .active_stages
        .first()
        .cloned()
        .or_else(|| summary.error_stages.first().cloned());
    match summary.status.as_str() {
        "success" => {
            run.status = "success".to_string();
            run.current_stage = "complete".to_string();
            run.action_kind = None;
            run.action_url = None;
            run.issue_code = None;
            run.message = if run.environment == "production" {
                "生产环境已按测试通过的同一镜像摘要发布".to_string()
            } else {
                "测试环境部署完成并通过健康检查".to_string()
            };
            run.completed_steps = vec![
                "write-config".to_string(),
                "verify-build".to_string(),
                "publish-images".to_string(),
                "prepare-server".to_string(),
                "deploy".to_string(),
                "healthcheck".to_string(),
            ];
        }
        "error" | "failed" => {
            run.status = "failed".to_string();
            run.current_stage = stage_key(current.as_deref());
            run.issue_code = Some("AD-BLD-201".to_string());
            run.message = current.map_or_else(
                || "CNB 构建失败，请查看经过脱敏的技术日志".to_string(),
                |stage| format!("{stage}未完成，可以从这个阶段重试"),
            );
        }
        "waiting" | "pending" | "queued" => {
            run.issue_code = None;
            if let Some(stage) = current {
                run.status = "running".to_string();
                run.current_stage = stage_key(Some(&stage));
                run.message = format!("正在执行：{stage}");
            } else {
                run.status = "queued".to_string();
                run.message = "CNB 正在分配构建资源".to_string();
            }
        }
        _ => {
            run.status = "running".to_string();
            run.issue_code = None;
            run.current_stage = stage_key(current.as_deref());
            run.message = current.map_or_else(
                || "CNB 正在执行部署流程".to_string(),
                |stage| format!("正在执行：{stage}"),
            );
        }
    }
}

async fn enrich_failed_cnb_run(
    client: &CnbClient,
    run: &mut DeploymentRun,
    state: &WorkspaceState,
) {
    let Some(serial) = run.build_serial.as_deref() else {
        return;
    };
    let Ok(payload) = client.build_status(&run.repository, serial).await else {
        return;
    };
    update_run_from_cnb(run, &payload);
    if run.status != "failed" {
        return;
    }
    if let Some(pipeline_id) = summarize_build_status(&payload).pipeline_ids.first()
        && let Ok(log) = client.runner_log(&run.repository, pipeline_id).await
    {
        apply_runner_log_diagnostic(run, &log);
        enrich_unhealthy_container_diagnostic(run, state).await;
    }
}

fn apply_runner_log_diagnostic(run: &mut DeploymentRun, log: &str) {
    let normalized_log = log.to_ascii_lowercase();
    if normalized_log.contains("err_pnpm_no_lockfile")
        || (normalized_log.contains("frozen-lockfile")
            && normalized_log.contains("pnpm-lock.yaml")
            && normalized_log.contains("absent"))
    {
        run.current_stage = "build".to_string();
        run.issue_code = Some("AD-PKG-201".to_string());
        run.message = "项目缺少依赖锁定文件，ABCDeploy 会先补齐后再重新部署".to_string();
        return;
    }
    if normalized_log.contains("pg_dump:")
        && normalized_log.contains("database")
        && normalized_log.contains("does not exist")
    {
        apply_missing_remote_database_diagnostic(run);
        return;
    }
    for line in log.lines().rev() {
        let visible_line = runner_log_message(line);
        let normalized = visible_line.to_ascii_lowercase();
        if visible_line.starts_with("AD-DB-204")
            || (normalized.contains("pg_dump:")
                && normalized.contains("database")
                && normalized.contains("does not exist"))
        {
            apply_missing_remote_database_diagnostic(run);
            return;
        }
        if let Some((_, remainder)) = visible_line.split_once("container ")
            && let Some((container, _)) = remainder.split_once(" is unhealthy")
            && safe_runtime_identifier(container)
        {
            run.current_stage = "healthcheck".to_string();
            run.issue_code = Some("AD-CTR-201".to_string());
            run.message = format!("服务容器 {container} 启动后未通过健康检查");
            return;
        }
        if let Some((_, missing)) = visible_line.split_once("缺少密钥仓库字段：") {
            let fields = missing.trim();
            if !fields.is_empty()
                && fields.len() <= 512
                && fields.bytes().all(|byte| {
                    byte.is_ascii_uppercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b',' | b' ' | b'-')
                })
            {
                run.current_stage = "prepare".to_string();
                run.issue_code = Some("AD-CFG-201".to_string());
                run.message = format!("测试环境配置还缺少：{fields}");
                return;
            }
        }
        if normalized.contains("permission denied (publickey") {
            run.current_stage = "prepare-server".to_string();
            run.issue_code = Some("AD-SSH-201".to_string());
            run.message = "CNB 无法使用已保存的 SSH 凭据登录目标服务器".to_string();
            return;
        }
        if normalized.contains("no space left on device") {
            run.current_stage = "prepare-server".to_string();
            run.issue_code = Some("AD-SRV-208".to_string());
            run.message = "目标服务器磁盘空间不足，测试环境没有继续更新".to_string();
            return;
        }
        if (normalized.contains("/etc/caddy/caddyfile")
            || normalized.contains("/etc/nginx/templates"))
            && (normalized.contains("no such file")
                || normalized.contains("nonexistent directory")
                || normalized.contains("can't create"))
        {
            run.current_stage = "build".to_string();
            run.issue_code = Some("AD-CTR-202".to_string());
            run.message = "网页容器配置目录缺失，ABCDeploy 需要重新生成部署文件".to_string();
            return;
        }
        if normalized.contains("pull access denied")
            || normalized.contains("unauthorized: authentication required")
        {
            run.current_stage = "publish".to_string();
            run.issue_code = Some("AD-IMG-201".to_string());
            run.message = "目标环境无法读取本次构建的容器镜像".to_string();
            return;
        }
        for code in ["AD-SRV-205", "AD-SRV-206", "AD-SRV-207"] {
            if let Some(message) = visible_line.strip_prefix(code) {
                let message = message.trim_start_matches(['：', ':', ' ']).trim();
                if message.contains(">&2") || message.contains("'\"'\"'") {
                    continue;
                }
                run.current_stage = "prepare-server".to_string();
                run.issue_code = Some(code.to_string());
                run.message = if code == "AD-SRV-206" {
                    "正式地址正在被服务器上的旧版本使用，请确认是否切换到新版本".to_string()
                } else if message.is_empty() {
                    "统一 Caddy 路由没有安全更新".to_string()
                } else {
                    message.to_string()
                };
                return;
            }
        }
    }
}

fn apply_missing_remote_database_diagnostic(run: &mut DeploymentRun) {
    run.current_stage = "cloud-setup".to_string();
    run.issue_code = Some("AD-DB-204".to_string());
    run.action_kind = Some("cloud-config".to_string());
    run.action_url = None;
    run.message = "测试数据库还没有准备好，请重新生成测试配置后继续部署".to_string();
}

fn runner_log_message(line: &str) -> &str {
    let line = line.trim();
    if line.starts_with('[')
        && let Some((_, message)) = line.split_once("] ")
    {
        return message.trim_start();
    }
    line
}

async fn enrich_unhealthy_container_diagnostic(run: &mut DeploymentRun, state: &WorkspaceState) {
    if run.issue_code.as_deref() != Some("AD-CTR-201") {
        return;
    }
    let Some(container) = run
        .message
        .strip_prefix("服务容器 ")
        .and_then(|message| message.strip_suffix(" 启动后未通过健康检查"))
        .filter(|container| safe_runtime_identifier(container))
    else {
        return;
    };
    let Ok(profile) = deployment_server_profile(run, state) else {
        return;
    };
    let command = format!("docker logs --tail 120 {} 2>&1", shell_quote(container));
    let Ok(output) = ssh::execute(&profile, &command, None, Duration::from_secs(20)).await else {
        return;
    };
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    apply_container_log_diagnostic(run, &combined);
}

fn apply_container_log_diagnostic(run: &mut DeploymentRun, log: &str) {
    let normalized = log.to_ascii_lowercase();
    if normalized.contains("rewrite or internal redirection cycle") {
        run.issue_code = Some("AD-WEB-201".to_string());
        run.message = "网页容器的首页回退规则发生循环，ABCDeploy 需要重新生成部署文件".to_string();
        return;
    }
    if let Some(module) = log.lines().rev().find_map(|line| {
        line.split_once("Cannot find module '")
            .and_then(|(_, remainder)| remainder.split_once('\'').map(|(module, _)| module))
            .filter(|module| {
                !module.is_empty()
                    && module.len() <= 128
                    && module.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric()
                            || matches!(byte, b'@' | b'/' | b'.' | b'_' | b'-')
                    })
            })
    }) {
        run.issue_code = Some("AD-APP-201".to_string());
        run.message = format!("服务缺少运行依赖 {module}，请补充项目依赖后重新部署");
        return;
    }
    if normalized.contains("p1000") || normalized.contains("authentication failed against database")
    {
        run.issue_code = Some("AD-DB-201".to_string());
        run.message = "服务无法通过数据库身份验证，请检查测试环境数据库配置".to_string();
        return;
    }
    if normalized.contains("p1001")
        || (normalized.contains("econnrefused")
            && (normalized.contains("postgres") || normalized.contains("database")))
    {
        run.issue_code = Some("AD-DB-202".to_string());
        run.message = "服务暂时无法连接测试数据库，请检查数据库状态和网络".to_string();
        return;
    }
    if normalized.contains("econnrefused") && normalized.contains("redis") {
        run.issue_code = Some("AD-CACHE-201".to_string());
        run.message = "服务暂时无法连接测试缓存，请检查 Redis 状态和网络".to_string();
        return;
    }
    if normalized.contains("eaddrinuse") {
        run.issue_code = Some("AD-APP-202".to_string());
        run.message = "服务监听端口已被占用，请检查项目启动端口配置".to_string();
    }
}

fn safe_runtime_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn stage_key(stage: Option<&str>) -> String {
    let stage = stage.unwrap_or("");
    if stage.contains("候选版本") || stage.contains("镜像摘要") {
        "verify-release"
    } else if (stage.contains("测试环境") || stage.contains("生产环境"))
        && (stage.contains("部署") || stage.contains("验证"))
    {
        "deploy"
    } else if stage.contains("准备安全部署工具") {
        "prepare"
    } else if stage.contains("安装") || stage.contains("验证") || stage.contains("构建") {
        "build"
    } else if stage.contains("上传") || stage.contains("镜像") {
        "publish"
    } else if stage.contains("服务器") {
        "prepare-server"
    } else if stage.contains("健康") {
        "healthcheck"
    } else if stage.contains("部署") || stage.contains("环境") {
        "deploy"
    } else {
        "build"
    }
    .to_string()
}

#[tauri::command]
fn check_docker() -> Result<ProviderCheck, String> {
    docker::check_engine().map_err(public_error)
}

#[tauri::command]
fn discover_ssh_identities() -> Vec<ssh::SshIdentity> {
    ssh::discover_identities()
}

#[tauri::command]
fn generate_ssh_identity() -> Result<ssh::GeneratedSshIdentity, String> {
    ssh::generate_managed_identity().map_err(public_error)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn check_server(
    name: String,
    host: String,
    user: String,
    key_path: String,
    port: u16,
    host_fingerprint: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<ProviderCheck, String> {
    let profile = ssh::SshProfile {
        name,
        host,
        user,
        port,
        key_path: PathBuf::from(key_path),
        host_fingerprint,
    };
    let result = ssh::check_connection(&profile)
        .await
        .map_err(public_error)?;
    if result.ok {
        state.remember_checked_server(&profile)?;
    }
    Ok(result)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::too_many_arguments)] // Tauri IPC deserializes flat, owned arguments.
async fn install_server_key_with_password(
    name: String,
    host: String,
    user: String,
    key_path: String,
    port: u16,
    host_fingerprint: Option<String>,
    password: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProviderCheck, String> {
    let password = Zeroizing::new(password);
    if password.is_empty() || password.len() > 1024 {
        return Err("AD-SSH-105：请填写有效的服务器登录密码".to_string());
    }
    let profile = ssh::SshProfile {
        name,
        host,
        user,
        port,
        key_path: PathBuf::from(key_path),
        host_fingerprint,
    };
    let result = ssh::install_public_key_with_password(&profile, password)
        .await
        .map_err(public_error)?;
    if result.ok {
        state.remember_checked_server(&profile)?;
    }
    Ok(result)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::too_many_arguments)] // Tauri IPC deserializes flat, owned arguments.
async fn bootstrap_server_caddy(
    name: String,
    host: String,
    user: String,
    key_path: String,
    port: u16,
    host_fingerprint: Option<String>,
    confirmed: bool,
    state: State<'_, WorkspaceState>,
) -> Result<ProviderCheck, String> {
    let profile = ssh::SshProfile {
        name,
        host,
        user,
        port,
        key_path: PathBuf::from(key_path),
        host_fingerprint,
    };
    let result = caddy::bootstrap_server(&profile, confirmed)
        .await
        .map_err(public_error)?;
    if result.ok {
        state.remember_checked_server(&profile)?;
    }
    Ok(result)
}

#[tauri::command]
async fn inspect_server_route_conflicts(
    path: String,
    environment: String,
    server: ServerConnectionInput,
) -> Result<RouteConflictCheck, String> {
    let environment_name = parse_deploy_environment(&environment)?;
    let manifest =
        load_manifest(&PathBuf::from(&path).join(MANIFEST_FILE)).map_err(public_error)?;
    validate_deployment_routing_manifest(&manifest, "当前项目")?;
    let hosts = manifest
        .environments
        .get(environment_name)
        .domains
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    if hosts.is_empty() {
        return Ok(RouteConflictCheck {
            conflicts: Vec::new(),
            takeover_available: false,
        });
    }
    let host_arguments = hosts
        .iter()
        .map(|host| shell_quote(host))
        .collect::<Vec<_>>()
        .join(" ");
    let site_name = format!("{}-{environment}.caddy", manifest.project.name);
    let route_declared = caddy_route_declared_shell_function();
    let script = format!(
        r#"set -eu
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name")"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory")"
MAIN_FILE="$(docker inspect --format '{{{{range .Mounts}}}}{{{{if eq .Destination "/etc/caddy/Caddyfile"}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}' "$CADDY_CONTAINER")"
test -n "$MAIN_FILE" && test -f "$MAIN_FILE"
ACTIVE_MAIN_FILE="$(mktemp)"
trap 'rm -f "$ACTIVE_MAIN_FILE"' EXIT
docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile >"$ACTIVE_MAIN_FILE"
SITE_NAME={site_name}
TARGET_SITE="$CADDY_SITE_DIRECTORY/$SITE_NAME"
{route_declared}
for host in {host_arguments}; do
  if route_declared_in_file "$host" "$ACTIVE_MAIN_FILE"; then
    printf 'ABCDEPLOY_ROUTE_CONFLICT\t%s\tmain\n' "$host"
    continue
  fi
  for file in "$CADDY_SITE_DIRECTORY"/*.caddy; do
    [ -f "$file" ] || continue
    [ "$file" = "$TARGET_SITE" ] && continue
    if route_declared_in_file "$host" "$file"; then
      printf 'ABCDEPLOY_ROUTE_CONFLICT\t%s\tmanaged\n' "$host"
      break
    fi
  done
done
"#,
        site_name = shell_quote(&site_name),
    );
    let output = ssh::execute(
        &server.profile(),
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_secs(20),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(format!(
            "无法检查正式地址：{}",
            redact_text(&output.stderr)
                .lines()
                .next()
                .unwrap_or("服务器没有返回检查结果")
        ));
    }
    let conflicts = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            (fields.next()? == "ABCDEPLOY_ROUTE_CONFLICT").then(|| RouteConflict {
                host: fields.next().unwrap_or_default().to_string(),
                source: fields.next().unwrap_or("managed").to_string(),
            })
        })
        .collect::<Vec<_>>();
    let takeover_available =
        !conflicts.is_empty() && conflicts.iter().all(|item| item.source == "main");
    Ok(RouteConflictCheck {
        conflicts,
        takeover_available,
    })
}

#[tauri::command]
async fn take_over_server_routes(
    path: String,
    environment: String,
    server: ServerConnectionInput,
    confirmed: bool,
) -> Result<ProviderCheck, String> {
    if !confirmed {
        return Err("接管现有地址前必须明确确认".to_string());
    }
    let environment_name = parse_deploy_environment(&environment)?;
    let manifest =
        load_manifest(&PathBuf::from(&path).join(MANIFEST_FILE)).map_err(public_error)?;
    validate_deployment_routing_manifest(&manifest, "当前项目")?;
    let hosts = manifest
        .environments
        .get(environment_name)
        .domains
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    if hosts.is_empty() {
        return Err("正式环境还没有配置地址".to_string());
    }
    let site_name = format!("{}-{environment}.caddy", manifest.project.name);
    let caddy_path = format!(
        ".deploydesk/generated/{}/Caddyfile",
        environment_name.as_str()
    );
    let caddy = render_project_files(&manifest)
        .map_err(public_error)?
        .into_iter()
        .find(|file| file.path == caddy_path)
        .ok_or_else(|| "无法生成当前正式地址的 Caddy 路由".to_string())?
        .content;
    take_over_caddy_routes(&server.profile(), &hosts, &site_name, &caddy).await
}

async fn take_over_caddy_routes(
    profile: &ssh::SshProfile,
    hosts: &[String],
    site_name: &str,
    caddy: &str,
) -> Result<ProviderCheck, String> {
    let encoded_hosts = BASE64.encode(format!("{}\n", hosts.join("\n")).as_bytes());
    let encoded_caddy = BASE64.encode(caddy.as_bytes());
    let route_declared = caddy_route_declared_shell_function();
    let rewrite_main_routes = caddy_main_route_rewrite_shell_function();
    let script = format!(
        r#"set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 60 9 || {{ echo '同一服务器正在执行其他部署操作' >&2; exit 75; }}
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name")"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory")"
MAIN_FILE="$(docker inspect --format '{{{{range .Mounts}}}}{{{{if eq .Destination "/etc/caddy/Caddyfile"}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}' "$CADDY_CONTAINER")"
SITE_NAME={site_name}
SITE_FILE="$CADDY_SITE_DIRECTORY/$SITE_NAME"
test -n "$MAIN_FILE" && test -f "$MAIN_FILE" && test -w "$MAIN_FILE"
WORK_DIR="$(mktemp -d "$HOME/.deploydesk/caddy/takeover.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
printf '%s' {encoded_hosts} | base64 --decode >"$WORK_DIR/hosts"
{route_declared}
# The UI inspects conflicts before confirmation, but the server state can change in between.
# Recheck managed project routes while holding the deployment lock and fail before any write.
while IFS= read -r host; do
  [ -n "$host" ] || continue
  for file in "$CADDY_SITE_DIRECTORY"/*.caddy; do
    [ -f "$file" ] || continue
    [ "$file" = "$SITE_FILE" ] && continue
    if route_declared_in_file "$host" "$file"; then
      echo "地址 $host 已由其他项目管理，未修改服务器配置" >&2
      exit 1
    fi
  done
done <"$WORK_DIR/hosts"
cp "$MAIN_FILE" "$WORK_DIR/main.host.original"
docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile >"$WORK_DIR/main.container.original"
if [ -f "$SITE_FILE" ]; then cp "$SITE_FILE" "$WORK_DIR/site.original"; fi
{rewrite_main_routes}
rewrite_caddy_main_routes "$WORK_DIR/hosts" "$WORK_DIR/main.container.original" "$WORK_DIR/main.next"
printf '%s' {encoded_caddy} | base64 --decode >"$WORK_DIR/site.next"
sync_main_config() {{
  container_source="$1"
  host_source="$2"
  cat "$host_source" >"$MAIN_FILE"
  if docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile | cmp -s "$container_source" -; then
    return 0
  fi

  # 历史版本可能替换过单文件挂载的宿主 inode，导致容器继续读取已删除的旧文件。
  # 先把配置放进容器已有的持久化 /config 卷；若当前挂载尚未指向它，再在原
  # mount namespace 中热修复绑定。整个过程不重启 Caddy，也不会重建其他项目。
  docker exec "$CADDY_CONTAINER" mkdir -p /config/abcdeploy
  docker exec -i "$CADDY_CONTAINER" sh -c 'cat > /config/abcdeploy/Caddyfile' <"$container_source"
  if docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile | cmp -s "$container_source" -; then
    return 0
  fi
  command -v nsenter >/dev/null 2>&1 || return 1
  sudo -n true >/dev/null 2>&1 || return 1
  caddy_pid="$(docker inspect --format '{{{{.State.Pid}}}}' "$CADDY_CONTAINER")"
  test -n "$caddy_pid" && test "$caddy_pid" != "0" || return 1
  sudo -n nsenter -t "$caddy_pid" -m -r -- umount /etc/caddy/Caddyfile
  sudo -n nsenter -t "$caddy_pid" -m -r -- sh -c 'test -e /etc/caddy/Caddyfile || touch /etc/caddy/Caddyfile'
  sudo -n nsenter -t "$caddy_pid" -m -r -- mount --bind /config/abcdeploy/Caddyfile /etc/caddy/Caddyfile
  sudo -n nsenter -t "$caddy_pid" -m -r -- mount -o remount,bind,ro /config/abcdeploy/Caddyfile /etc/caddy/Caddyfile
  docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile | cmp -s "$container_source" -
}}
restore() {{
  sync_main_config "$WORK_DIR/main.container.original" "$WORK_DIR/main.host.original"
  if [ -f "$WORK_DIR/site.original" ]; then cp "$WORK_DIR/site.original" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
}}
if ! sync_main_config "$WORK_DIR/main.next" "$WORK_DIR/main.next"; then
  restore >/dev/null 2>&1 || true
  echo 'AD-SRV-206：统一 Caddy 使用了失效的只读单文件挂载，自动热修复没有完成' >&2
  exit 1
fi
cp "$WORK_DIR/site.next" "$SITE_FILE"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$WORK_DIR/validate.log" 2>&1; then
  DIAGNOSTIC="$(tail -n 1 "$WORK_DIR/validate.log" | tr '\n' ' ')"
  restore
  echo "AD-SRV-206：接管地址后的配置校验失败，已恢复原配置：$DIAGNOSTIC" >&2
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  restore
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo '接管地址时 Caddy 重载失败，已恢复原配置' >&2
  exit 1
fi
BACKUP_DIR="$HOME/.deploydesk/caddy/backups/$(date -u +%Y%m%dT%H%M%SZ)-$SITE_NAME"
mkdir -p "$BACKUP_DIR"
cp "$WORK_DIR/main.container.original" "$BACKUP_DIR/Caddyfile"
cp "$WORK_DIR/main.host.original" "$BACKUP_DIR/Caddyfile.host"
if [ -f "$WORK_DIR/site.original" ]; then cp "$WORK_DIR/site.original" "$BACKUP_DIR/$SITE_NAME"; fi
"#,
        encoded_caddy = shell_quote(&encoded_caddy),
        encoded_hosts = shell_quote(&encoded_hosts),
        site_name = shell_quote(site_name),
    );
    let output = ssh::execute(
        profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_secs(45),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(format!(
            "没有完成地址接管：{}",
            redact_text(&output.stderr)
                .lines()
                .last()
                .unwrap_or("服务器操作失败，原配置已保留")
        ));
    }
    Ok(ProviderCheck {
        provider: "caddy".to_string(),
        ok: true,
        summary: "现有地址已安全切换到 ABCDeploy 管理".to_string(),
        details: vec![format!("已接管：{}", hosts.join("、"))],
        code: None,
        next_steps: vec!["继续当前上线任务，完成访问地址核对".to_string()],
        retryable: false,
    })
}

#[tauri::command]
async fn take_over_deployment_path_routes(
    run_id: String,
    confirmed: bool,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    take_over_deployment_path_routes_inner(run_id, confirmed, state.inner()).await
}

async fn take_over_deployment_path_routes_inner(
    run_id: String,
    confirmed: bool,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    if !confirmed {
        return Err("接管现有地址前必须明确确认".to_string());
    }
    let mut run = state.deployment_run(&run_id)?;
    if run.environment != "deployment" {
        return Err("这不是当前上线线路的任务".to_string());
    }
    if run.issue_code.as_deref() != Some("AD-SRV-206")
        || run.action_kind.as_deref() != Some("deployment-path-route-takeover")
    {
        return Err("当前上线任务没有需要接管的服务器地址".to_string());
    }
    let path = state.deployment_path_for_run(&run.id)?;
    let manifest = deployment_path_manifest(&run, &path, state)?;
    let profile = verified_deployment_path_profile(&path, state).await?;
    let routes = deployment_path_routes(&path);
    let root_routes = routes
        .iter()
        .filter(|route| route.path == "/")
        .cloned()
        .collect::<Vec<_>>();
    let mut hosts = root_routes
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    hosts.sort();
    hosts.dedup();
    if hosts.is_empty() {
        return Err("当前上线线路没有需要接管的整站地址".to_string());
    }
    let bundle =
        render_deployment_path_bundle(&manifest, &path.id, &root_routes).map_err(public_error)?;
    state.begin_deployment_attempt(&run.id)?;
    if let Err(message) =
        take_over_caddy_routes(&profile, &hosts, &bundle.site_name, &bundle.caddy).await
    {
        run.message = redact_text(&message);
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Err(message);
    }

    run.status = "running".to_string();
    run.current_stage = "server".to_string();
    run.issue_code = None;
    run.action_kind = None;
    run.action_url = None;
    run.message = "现有访问地址已安全接管，正在核对公网结果".to_string();
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    verify_deployment_path(&mut run, &path, state).await?;
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

#[tauri::command]
async fn reapply_deployment_routes(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProviderCheck, String> {
    let run = state.deployment_run(&run_id)?;
    apply_deployment_routes(&run, &state).await
}

#[tauri::command]
async fn detect_dns_provider(host: String) -> Option<DnsProviderHint> {
    deploy_core::health::detect_dns_provider(&host).await
}

async fn apply_deployment_routes(
    run: &DeploymentRun,
    state: &WorkspaceState,
) -> Result<ProviderCheck, String> {
    if run.artifacts.is_empty() {
        return Err("AD-REL-201：尚未确认服务器上的实际版本，请重新检查正式版运行状态".to_string());
    }
    // 镜像摘要仍以候选提交为准；域名和 Caddy 路由使用当前项目设置，
    // 允许测试通过后再补齐正式地址，而不要求为了一个域名重新构建镜像。
    let manifest = deployment_routing_manifest(run)?;
    let environment = parse_deploy_environment(&run.environment)?;
    let hosts = manifest
        .environments
        .get(environment)
        .domains
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    if hosts.is_empty() {
        return Err("当前发布版本没有配置公网地址".to_string());
    }
    let caddy_path = format!(".deploydesk/generated/{}/Caddyfile", environment.as_str());
    let caddy = render_project_files(&manifest)
        .map_err(public_error)?
        .into_iter()
        .find(|file| file.path == caddy_path)
        .ok_or_else(|| "无法生成本次发布版本的 Caddy 路由".to_string())?
        .content;
    let profile = deployment_server_profile(run, state)?;
    let host_arguments = hosts
        .iter()
        .map(|host| shell_quote(host))
        .collect::<Vec<_>>()
        .join(" ");
    let site_name = format!("{}-{}.caddy", manifest.project.name, run.environment);
    let network = format!("deploydesk-{}-{}", manifest.project.name, run.environment);
    let remote_directory = format!(
        ".deploydesk/apps/{}/{}",
        manifest.project.name, run.environment
    );
    let encoded_caddy = BASE64.encode(caddy.as_bytes());
    let partial_route_script = caddy_partial_route_activation_script(&hosts);
    let script = format!(
        r#"set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 60 9 || {{ echo '同一服务器正在执行其他部署操作' >&2; exit 75; }}
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || true)"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || true)"
test -n "$CADDY_CONTAINER" || {{ echo 'AD-SRV-205：统一 Caddy 尚未完成连接' >&2; exit 1; }}
case "$CADDY_SITE_DIRECTORY" in /*) ;; *) echo 'AD-SRV-205：统一 Caddy 路由目录无效' >&2; exit 1 ;; esac
test -d "$CADDY_SITE_DIRECTORY" && test -w "$CADDY_SITE_DIRECTORY" || {{ echo 'AD-SRV-205：统一 Caddy 路由目录不可写' >&2; exit 1; }}
docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 || {{ echo 'AD-SRV-203：统一 Caddy 当前没有运行' >&2; exit 1; }}
MAIN_FILE="$(docker inspect --format '{{{{range .Mounts}}}}{{{{if eq .Destination "/etc/caddy/Caddyfile"}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}' "$CADDY_CONTAINER")"
test -n "$MAIN_FILE" && test -f "$MAIN_FILE" || {{ echo 'AD-SRV-205：无法定位统一 Caddy 主配置' >&2; exit 1; }}
APP_DIRECTORY="$HOME/{remote_directory}"
APP_FILE="$APP_DIRECTORY/Caddyfile"
SITE_FILE="$CADDY_SITE_DIRECTORY/{site_name}"
mkdir -p "$APP_DIRECTORY"
WORK_DIR="$(mktemp -d "$HOME/.deploydesk/caddy/reapply.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
printf '%s' {encoded_caddy} | base64 --decode >"$WORK_DIR/Caddyfile.next"
CANDIDATE_FILE="$WORK_DIR/Caddyfile.next"
FILTERED_SITE_FILE="$WORK_DIR/Caddyfile.filtered"
MAIN_CONFIG_FILE="$WORK_DIR/Caddyfile.main"
ROUTE_CONFLICTS_FILE="$WORK_DIR/conflicts"
FILTER_HOSTS_FILE="$WORK_DIR/filter-hosts"
{partial_route_script}
[ -f "$APP_FILE" ] && cp "$APP_FILE" "$WORK_DIR/app.original" || true
[ -f "$SITE_FILE" ] && cp "$SITE_FILE" "$WORK_DIR/site.original" || true
restore() {{
  if [ -f "$WORK_DIR/app.original" ]; then cp "$WORK_DIR/app.original" "$APP_FILE"; else rm -f "$APP_FILE"; fi
  if [ -f "$WORK_DIR/site.original" ]; then cp "$WORK_DIR/site.original" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
}}
cp "$WORK_DIR/Caddyfile.next" "$APP_FILE"
cp "$FILTERED_SITE_FILE" "$SITE_FILE"
docker network inspect {network} >/dev/null 2>&1 || {{ restore; echo 'AD-SRV-204：项目网络不存在，请重新发布版本' >&2; exit 1; }}
docker network connect {network} "$CADDY_CONTAINER" 2>/dev/null || true
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  restore
  echo 'AD-SRV-206：地址配置校验失败，已恢复原路由' >&2
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  restore
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo 'AD-SRV-207：统一 Caddy 重载失败，已恢复原路由' >&2
  exit 1
fi
docker exec "$CADDY_CONTAINER" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$WORK_DIR/active.json" 2>/dev/null || {{ restore; docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true; echo 'AD-SRV-209：无法确认新地址是否生效' >&2; exit 1; }}
for host in {host_arguments}; do
  if ! grep -Fq -- "$host" "$WORK_DIR/active.json"; then
    restore
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    echo "AD-SRV-209：统一 Caddy 尚未加载 $host，请检查主配置是否导入路由目录" >&2
    exit 1
  fi
done
while IFS="$(printf '\t')" read -r host source; do
  if [ "$source" = "main" ]; then
    printf 'ROUTE_TAKEOVER_REQUIRED\t%s\n' "$host"
  fi
done <"$ROUTE_CONFLICTS_FILE"
"#,
        encoded_caddy = shell_quote(&encoded_caddy),
        network = shell_quote(&network),
        remote_directory = remote_directory,
        partial_route_script = partial_route_script,
    );
    let output = ssh::execute(
        &profile,
        "bash -s",
        Some(script.as_bytes()),
        Duration::from_mins(1),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(redact_text(&output.stderr)
            .lines()
            .last()
            .unwrap_or("重新应用地址失败，原路由已保留")
            .to_string());
    }
    let takeover_hosts = output
        .stdout
        .lines()
        .filter_map(|line| line.strip_prefix("ROUTE_TAKEOVER_REQUIRED\t"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(ProviderCheck {
        provider: "caddy".to_string(),
        ok: true,
        summary: if takeover_hosts.is_empty() {
            "正式地址已重新应用".to_string()
        } else {
            format!(
                "未冲突的正式地址已恢复，{} 个旧地址等待确认切换",
                takeover_hosts.len()
            )
        },
        details: hosts,
        code: None,
        next_steps: (!takeover_hosts.is_empty())
            .then(|| "确认接管仍由旧服务使用的地址".to_string())
            .into_iter()
            .collect(),
        retryable: false,
    })
}

#[tauri::command]
async fn prepare_pipeline_identity(
    path: String,
    server: ServerConnectionInput,
) -> Result<PipelineIdentityResult, String> {
    let profile = server.profile();
    if profile.host_fingerprint.is_none() {
        return Err("请先完成服务器身份验证".to_string());
    }
    let material = pipeline_identity(Path::new(&path), true)?;
    let script = format!(
        "set -eu\numask 077\nmkdir -p \"$HOME/.ssh\"\ntouch \"$HOME/.ssh/authorized_keys\"\nchmod 700 \"$HOME/.ssh\"\nchmod 600 \"$HOME/.ssh/authorized_keys\"\nDEPLOY_KEY={}\ngrep -qxF \"$DEPLOY_KEY\" \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' \"$DEPLOY_KEY\" >> \"$HOME/.ssh/authorized_keys\"\n",
        shell_quote(&material.public_key)
    );
    let output = ssh::execute(
        &profile,
        "sh -s",
        Some(script.as_bytes()),
        Duration::from_secs(30),
    )
    .await
    .map_err(public_error)?;
    if output.exit_status != Some(0) {
        return Err(format!(
            "无法为持续部署安装专用公钥：{}",
            redact_text(&output.stderr)
                .lines()
                .next()
                .unwrap_or("远程操作失败")
        ));
    }
    if material.created {
        write_keyring_secret(&material.keyring_key, material.private_key.as_str())?;
    }
    Ok(PipelineIdentityResult {
        created: material.created,
        fingerprint: material.fingerprint,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn runtime_secret_status(
    path: String,
    environment: String,
    variable: String,
) -> Result<RuntimeSecretStatus, String> {
    let key = runtime_secret_key(Path::new(&path), &environment, &variable)?;
    let stored = match read_keyring_secret(&key) {
        Ok(mut value) => {
            let stored = !value.is_empty();
            value.zeroize();
            stored
        }
        Err(error) if error == "missing" => false,
        Err(error) => return Err(error),
    };
    Ok(RuntimeSecretStatus {
        environment,
        variable,
        stored,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn store_runtime_secret(
    path: String,
    environment: String,
    variable: String,
    mut value: String,
) -> Result<RuntimeSecretStatus, String> {
    if value.is_empty() {
        return Err("配置值不能为空".to_string());
    }
    let key = runtime_secret_key(Path::new(&path), &environment, &variable)?;
    let result = write_keyring_secret(&key, &value);
    value.zeroize();
    result?;
    Ok(RuntimeSecretStatus {
        environment,
        variable,
        stored: true,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn generate_runtime_secret(
    path: String,
    environment: String,
    variable: String,
) -> Result<RuntimeSecretStatus, String> {
    let key = runtime_secret_key(Path::new(&path), &environment, &variable)?;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        write!(&mut value, "{byte:02x}").expect("writing to a String is infallible");
    }
    bytes.zeroize();
    let result = write_keyring_secret(&key, &value);
    value.zeroize();
    result?;
    Ok(RuntimeSecretStatus {
        environment,
        variable,
        stored: true,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn load_runtime_config(
    path: String,
    environment: String,
    authorize: bool,
) -> Result<RuntimeConfigFile, String> {
    let environment_name = parse_runtime_environment(&environment)?;
    let root = PathBuf::from(path);
    let (template_content, source_files, required_variables) =
        runtime_config_template(&root, environment_name)?;
    let key = runtime_config_key(&root, &environment)?;
    let read_result = if authorize {
        read_keyring_secret(&key)
    } else {
        read_keyring_secret_without_prompt(&key)
    };
    let local_content = (environment_name == EnvironmentName::Development)
        .then(|| fs::read_to_string(root.join(".env")).ok())
        .flatten()
        .filter(|value| !value.trim().is_empty());
    let (content, stored, authorization_required) = match read_result {
        Ok(value) if !value.is_empty() => (
            if environment_name == EnvironmentName::Development {
                value
            } else {
                remote_runtime_content(&value, &BTreeSet::new(), false)
            },
            true,
            false,
        ),
        Ok(mut value) => {
            value.zeroize();
            local_content.clone().map_or_else(
                || (template_content.clone(), false, false),
                |value| (value, true, false),
            )
        }
        Err(error) if error == "missing" => local_content.clone().map_or_else(
            || (template_content.clone(), false, false),
            |value| (value, true, false),
        ),
        Err(_) if !authorize => local_content.map_or_else(
            || (template_content.clone(), false, true),
            |value| (value, true, false),
        ),
        Err(error) => return Err(error),
    };
    Ok(RuntimeConfigFile {
        filename: runtime_config_filename(&environment),
        environment,
        source_files,
        content,
        template_content,
        required_variables,
        stored,
        authorization_required,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn load_existing_project_config(
    path: String,
    environment: String,
) -> Result<ExistingProjectConfig, String> {
    let environment = parse_deploy_environment(&environment)?;
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("项目目录无法读取：{error}"))?;
    let candidates = match environment {
        EnvironmentName::Staging => [".env", ".env.local", ".env.production", ".env.staging"],
        EnvironmentName::Production => [".env", ".env.local", ".env.staging", ".env.production"],
        EnvironmentName::Development => unreachable!("deploy environment excludes development"),
    };
    let mut source_files = Vec::new();
    let mut sections = Vec::new();
    for relative in candidates {
        let candidate = root.join(relative);
        if !candidate.is_file() {
            continue;
        }
        let metadata = fs::metadata(&candidate).map_err(public_error)?;
        if metadata.len() > 1024 * 1024 {
            return Err(format!("项目现有配置 {relative} 过大，已停止读取"));
        }
        let content = fs::read_to_string(&candidate).map_err(public_error)?;
        if content.contains('\0') {
            return Err(format!("项目现有配置 {relative} 包含无效字符"));
        }
        source_files.push(relative.to_string());
        sections.push(format!(
            "# ===== 项目已有配置：{relative} =====\n{}",
            content.trim_end_matches(['\r', '\n'])
        ));
    }
    if source_files.is_empty() {
        return Err("项目中没有可复用的 .env 配置".to_string());
    }
    Ok(ExistingProjectConfig {
        source_files,
        content: format!("{}\n", sections.join("\n\n")),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn store_runtime_config(
    path: String,
    environment: String,
    mut content: String,
) -> Result<RuntimeConfigStatus, String> {
    if content.trim().is_empty() {
        return Err("运行配置文件不能为空".to_string());
    }
    if content.contains('\0') {
        return Err("运行配置文件包含无效字符".to_string());
    }
    let key = runtime_config_key(Path::new(&path), &environment)?;
    let result = write_keyring_secret(&key, &content);
    content.zeroize();
    result?;
    Ok(RuntimeConfigStatus {
        filename: runtime_config_filename(&environment),
        environment,
        stored: true,
    })
}

#[tauri::command]
async fn runtime_config_sync_status(
    path: String,
    environment: String,
    server: ServerConnectionInput,
) -> Result<RuntimeConfigSyncStatus, String> {
    let environment_name = parse_deploy_environment(&environment)?;
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let runtime_file_key = runtime_config_key(&root, &environment)?;
    let mut content = match read_keyring_secret_without_prompt(&runtime_file_key) {
        Ok(value) if !value.is_empty() => value,
        Ok(mut value) => {
            value.zeroize();
            return Ok(RuntimeConfigSyncStatus {
                stored: false,
                synchronized: false,
            });
        }
        Err(error) if error == "missing" => {
            return Ok(RuntimeConfigSyncStatus {
                stored: false,
                synchronized: false,
            });
        }
        Err(error) => return Err(error),
    };
    let profile = verified_server_profile(&server).await?;
    let destination = remote_runtime_config_path(&manifest.project.name, environment_name);
    let command = format!(
        "if [ -f {destination} ]; then sha256sum {destination} | awk '{{print $1}}'; fi",
        destination = shell_quote(&destination),
    );
    let output = ssh::execute(&profile, &command, None, Duration::from_secs(20))
        .await
        .map_err(public_error)?;
    if output.exit_status != Some(0) {
        content.zeroize();
        return Ok(RuntimeConfigSyncStatus {
            stored: true,
            synchronized: false,
        });
    }
    let mut digest = Sha256::new();
    digest.update(content.as_bytes());
    let expected = format!("{:x}", digest.finalize());
    content.zeroize();
    Ok(RuntimeConfigSyncStatus {
        stored: true,
        synchronized: output.stdout.trim() == expected,
    })
}

#[tauri::command]
async fn sync_runtime_config_to_server(
    path: String,
    environment: String,
    server: ServerConnectionInput,
) -> Result<RuntimeConfigSyncStatus, String> {
    let environment_name = parse_deploy_environment(&environment)?;
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let profile = verified_server_profile(&server).await?;
    let environment_config = manifest.environments.get(environment_name);
    let managed_dependencies =
        ensure_remote_runtime_dependencies(&root, environment_name, environment_config, &profile)
            .await?;
    let runtime_file_key = runtime_config_key(&root, &environment)?;
    let mut content = match read_keyring_secret(&runtime_file_key) {
        Ok(value) if !value.is_empty() => value,
        Ok(mut value) => {
            value.zeroize();
            return Err("请先保存运行配置".to_string());
        }
        Err(error) if error == "missing" => return Err("请先保存运行配置".to_string()),
        Err(error) => return Err(error),
    };
    let (filled, _) = fill_managed_runtime_dependencies(&content, &managed_dependencies);
    content.zeroize();
    content = filled;
    let missing = missing_runtime_variables(
        &content,
        &required_runtime_variables(&manifest, environment_name),
        environment_name,
    );
    if !missing.is_empty() {
        content.zeroize();
        return Err(format!("还有 {} 项必填配置没有值", missing.len()));
    }
    write_keyring_secret(&runtime_file_key, &content)?;
    let result =
        persist_remote_runtime_config(&profile, &manifest.project.name, environment_name, &content)
            .await;
    content.zeroize();
    result?;
    Ok(RuntimeConfigSyncStatus {
        stored: true,
        synchronized: true,
    })
}

#[tauri::command]
async fn prepare_cnb_secret_bundle(
    path: String,
    environment: String,
    secret_repository: String,
    server: ServerConnectionInput,
) -> Result<CnbSecretBundle, String> {
    validate_repository_slug(&secret_repository)?;
    let environment_name = parse_deploy_environment(&environment)?;
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let profile = server.profile();
    let expected_fingerprint = profile
        .host_fingerprint
        .as_deref()
        .ok_or_else(|| "请先完成服务器身份验证".to_string())?;
    let host_identity = ssh::probe_host_identity(&profile)
        .await
        .map_err(public_error)?;
    if host_identity.fingerprint != expected_fingerprint {
        return Err("服务器身份指纹已变化，已停止生成持续部署配置".to_string());
    }
    let environment_config = manifest.environments.get(environment_name);
    let managed_dependencies =
        ensure_remote_runtime_dependencies(&root, environment_name, environment_config, &profile)
            .await?;
    let material = pipeline_identity(&root, false)?;
    let prefix = environment.to_ascii_uppercase();
    let host_label = if profile.port == 22 {
        profile.host.clone()
    } else {
        format!("[{}]:{}", profile.host, profile.port)
    };
    let mut values = BTreeMap::from([
        (format!("{prefix}_SERVER_HOST"), profile.host.clone()),
        (format!("{prefix}_SERVER_PORT"), profile.port.to_string()),
        (format!("{prefix}_SERVER_USER"), profile.user.clone()),
        (
            format!("{prefix}_SERVER_SSH_KEY"),
            material.private_key.to_string(),
        ),
        (
            format!("{prefix}_SERVER_KNOWN_HOSTS"),
            format!("{host_label} {}", host_identity.public_key),
        ),
    ]);
    let mut missing_variables = Vec::new();
    let required_variables = required_runtime_variables(&manifest, environment_name);
    let runtime_file_key = runtime_config_key(&root, &environment)?;
    let has_runtime_file = match read_keyring_secret(&runtime_file_key) {
        Ok(value) if !value.is_empty() => {
            let (value, _) = fill_managed_runtime_dependencies(&value, &managed_dependencies);
            write_keyring_secret(&runtime_file_key, &value)?;
            missing_variables.extend(missing_runtime_variables(
                &value,
                &required_variables,
                environment_name,
            ));
            values.insert(format!("{prefix}_RUNTIME_ENV_FILE"), value);
            true
        }
        Ok(mut value) => {
            value.zeroize();
            false
        }
        Err(error) if error == "missing" => false,
        Err(error) => return Err(error),
    };
    if !has_runtime_file {
        // Compatibility for projects configured before whole-file runtime settings.
        let mut variables = BTreeMap::new();
        for variable in manifest
            .services
            .iter()
            .flat_map(|service| &service.runtime_env)
        {
            variables
                .entry(variable.name.clone())
                .or_insert_with(|| variable.default.clone());
        }
        if environment_config.database.is_some() {
            variables.entry("DATABASE_URL".to_string()).or_insert(None);
        }
        if environment_config.redis_namespace.is_some() {
            variables.entry("REDIS_URL".to_string()).or_insert(None);
        }
        for (variable, default) in variables {
            let key = runtime_secret_key(&root, &environment, &variable)?;
            let value = match read_keyring_secret(&key) {
                Ok(value) if !value.is_empty() => Some(value),
                Ok(mut value) => {
                    value.zeroize();
                    None
                }
                Err(error) if error == "missing" => default,
                Err(error) => return Err(error),
            };
            let value = value.and_then(|value| {
                managed_dependencies
                    .get(&variable)
                    .filter(|_| remote_runtime_value_invalid(&value))
                    .cloned()
                    .or(Some(value))
            });
            let value = value.or_else(|| managed_dependencies.get(&variable).cloned());
            if let Some(value) = value {
                values.insert(format!("{prefix}_{variable}"), value);
            } else {
                values.insert(format!("{prefix}_{variable}"), String::new());
                missing_variables.push(variable);
            }
        }
    }
    if !matches!(manifest.providers.registry, RegistryConfig::Cnb { .. }) {
        let provider = RegistryProvider::new(&manifest.providers.registry);
        let (username, password) = provider.credential_names();
        let key_prefix = if matches!(manifest.providers.registry, RegistryConfig::Tcr { .. }) {
            TCR_SECRET_PREFIX
        } else {
            "registry.oci"
        };
        for (field, key) in [
            (username, format!("{key_prefix}.username")),
            (password, format!("{key_prefix}.password")),
        ] {
            match read_keyring_secret(&key) {
                Ok(value) if !value.is_empty() => {
                    values.insert(field.to_string(), value);
                }
                Ok(mut value) => {
                    value.zeroize();
                    missing_variables.push(field.to_string());
                }
                Err(error) if error == "missing" => {
                    missing_variables.push(field.to_string());
                }
                Err(error) => return Err(error),
            }
        }
    }
    missing_variables.sort();
    missing_variables.dedup();
    if missing_variables.is_empty()
        && let Some(runtime_content) = values.get(&format!("{prefix}_RUNTIME_ENV_FILE"))
    {
        persist_remote_runtime_config(
            &profile,
            &manifest.project.name,
            environment_name,
            runtime_content,
        )
        .await?;
    }
    let mut content = serde_yaml_ng::to_string(&values).map_err(public_error)?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 在本机生成，仅粘贴到 CNB 密钥仓库 Web 编辑器。\n",
    );
    // A single CNB Secret repository can safely serve multiple projects as long
    // as each generated file has a project-scoped name. Existing manifests keep
    // their old references; only newly generated bundles use this convention.
    let filename = cnb_secret_filename(&manifest.project.name, &environment);
    Ok(CnbSecretBundle {
        environment,
        file_url: format!("https://cnb.cool/{secret_repository}/-/blob/main/{filename}"),
        filename,
        content,
        missing_variables,
        deploy_key_fingerprint: material.fingerprint,
    })
}

async fn persist_remote_runtime_config(
    profile: &ssh::SshProfile,
    project: &str,
    environment: EnvironmentName,
    content: &str,
) -> Result<(), String> {
    if content.trim().is_empty() || content.contains('\0') {
        return Err("远程运行配置内容无效，已停止同步".to_string());
    }
    let directory = format!(".deploydesk/runtime-config/{project}");
    let destination = remote_runtime_config_path(project, environment);
    let temporary = format!("{destination}.next");
    let command = format!(
        "set -eu\numask 077\ninstall -d -m 700 {directory}\ncat > {temporary}\nchmod 600 {temporary}\nmv {temporary} {destination}",
        directory = shell_quote(&directory),
        temporary = shell_quote(&temporary),
        destination = shell_quote(&destination),
    );
    ssh::execute(
        profile,
        &command,
        Some(content.as_bytes()),
        Duration::from_secs(30),
    )
    .await
    .map_err(public_error)?;
    Ok(())
}

fn remote_runtime_config_path(project: &str, environment: EnvironmentName) -> String {
    format!(
        ".deploydesk/runtime-config/{project}/{}.env",
        environment.as_str()
    )
}

async fn verified_server_profile(
    server: &ServerConnectionInput,
) -> Result<ssh::SshProfile, String> {
    let profile = server.profile();
    let expected_fingerprint = profile
        .host_fingerprint
        .as_deref()
        .ok_or_else(|| "请先完成服务器身份验证".to_string())?;
    let host_identity = ssh::probe_host_identity(&profile)
        .await
        .map_err(public_error)?;
    if host_identity.fingerprint != expected_fingerprint {
        return Err("服务器身份指纹已变化，已停止同步运行配置".to_string());
    }
    Ok(profile)
}

async fn ensure_remote_runtime_dependencies(
    root: &Path,
    environment: EnvironmentName,
    config: &EnvironmentConfig,
    profile: &ssh::SshProfile,
) -> Result<BTreeMap<String, String>, String> {
    ensure_remote_runtime_dependencies_scoped(root, environment.as_str(), config, profile).await
}

async fn ensure_remote_runtime_dependencies_scoped(
    root: &Path,
    scope: &str,
    config: &EnvironmentConfig,
    profile: &ssh::SshProfile,
) -> Result<BTreeMap<String, String>, String> {
    let needs_postgres = config.database.is_some();
    let needs_redis = config.redis_namespace.is_some();
    if !needs_postgres && !needs_redis {
        return Ok(BTreeMap::new());
    }

    let (database_name, database_user) = config.database.as_ref().map_or_else(
        || (String::new(), String::new()),
        |database| (database.name.clone(), database.user.clone()),
    );
    for value in [&database_name, &database_user] {
        if !value.is_empty() && !safe_postgres_identifier(value) {
            return Err("AD-INF-201：项目声明的远程数据库名称不安全，已停止准备".to_string());
        }
    }

    let mut database_password = needs_postgres
        .then(|| {
            local_infrastructure_secret(&format!(
                "remote.database.{}.{}",
                &project_storage_id(root)[..24],
                scope
            ))
        })
        .transpose()?;
    let server_id = remote_server_id(profile);
    let mut postgres_admin_password =
        local_infrastructure_secret(&format!("remote.infrastructure.{server_id}.postgres"))?;
    let mut redis_password =
        local_infrastructure_secret(&format!("remote.infrastructure.{server_id}.redis"))?;

    let substitutions = [
        ("__NETWORK__", REMOTE_INFRA_NETWORK.to_string()),
        (
            "__POSTGRES_FLAG__",
            if needs_postgres { "1" } else { "0" }.to_string(),
        ),
        (
            "__REDIS_FLAG__",
            if needs_redis { "1" } else { "0" }.to_string(),
        ),
        ("__DB_NAME__", BASE64.encode(database_name.as_bytes())),
        ("__DB_USER__", BASE64.encode(database_user.as_bytes())),
        (
            "__DB_PASSWORD__",
            BASE64.encode(
                database_password
                    .as_ref()
                    .map_or(&[][..], |value| value.as_bytes()),
            ),
        ),
        (
            "__POSTGRES_ADMIN_PASSWORD__",
            BASE64.encode(postgres_admin_password.as_bytes()),
        ),
        (
            "__REDIS_PASSWORD__",
            BASE64.encode(redis_password.as_bytes()),
        ),
    ];
    let mut script = REMOTE_DEPENDENCY_SCRIPT.to_string();
    for (placeholder, value) in substitutions {
        script = script.replace(placeholder, &value);
    }
    let output = ssh::execute(
        profile,
        "sh -s",
        Some(script.as_bytes()),
        Duration::from_mins(12),
    )
    .await
    .map_err(public_error)?;
    script.zeroize();
    postgres_admin_password.zeroize();
    redis_password.zeroize();
    if output.exit_status != Some(0) {
        database_password.iter_mut().for_each(Zeroize::zeroize);
        let message = redact_text(&output.stderr);
        return Err(remote_dependency_error(&message));
    }
    let fields = output
        .stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<BTreeMap<_, _>>();
    let mut values = BTreeMap::new();
    if needs_postgres {
        let host = fields
            .get("POSTGRES_HOST")
            .copied()
            .filter(|value| valid_remote_container_name(value))
            .ok_or_else(|| "AD-INF-202：服务器没有返回可用的 PostgreSQL 地址".to_string())?;
        let password = database_password
            .as_deref()
            .ok_or_else(|| "AD-INF-202：无法读取环境数据库凭据".to_string())?;
        values.insert(
            "DATABASE_URL".to_string(),
            format!(
                "postgresql://{}:{}@{}:5432/{}",
                database_user,
                url_encode_userinfo(password),
                host,
                database_name
            ),
        );
        values.insert("POSTGRES_DB".to_string(), database_name.clone());
        values.insert("POSTGRES_USER".to_string(), database_user.clone());
        values.insert("POSTGRES_PASSWORD".to_string(), password.clone());
    }
    if needs_redis {
        let host = fields
            .get("REDIS_HOST")
            .copied()
            .filter(|value| valid_remote_container_name(value))
            .ok_or_else(|| "AD-INF-202：服务器没有返回可用的 Redis 地址".to_string())?;
        let encoded_password = fields
            .get("REDIS_PASSWORD_B64")
            .copied()
            .unwrap_or_default();
        let mut password = BASE64
            .decode(encoded_password)
            .map_err(|_| "AD-INF-202：服务器返回的 Redis 凭据格式无效".to_string())?;
        let database = remote_redis_database_for_scope(root, scope);
        let url = if password.is_empty() {
            format!("redis://{host}:6379/{database}")
        } else {
            let password_text = std::str::from_utf8(&password)
                .map_err(|_| "AD-INF-202：服务器返回的 Redis 凭据无法读取".to_string())?;
            format!(
                "redis://:{}@{host}:6379/{database}",
                url_encode_userinfo(password_text)
            )
        };
        password.zeroize();
        values.insert("REDIS_URL".to_string(), url);
    }
    database_password.iter_mut().for_each(Zeroize::zeroize);
    Ok(values)
}

const REMOTE_DEPENDENCY_SCRIPT: &str = r#"set -eu
NETWORK='__NETWORK__'
NEEDS_POSTGRES='__POSTGRES_FLAG__'
NEEDS_REDIS='__REDIS_FLAG__'
mkdir -p "$HOME/.deploydesk/locks"
exec 8>"$HOME/.deploydesk/locks/runtime-dependencies.lock"
flock -w 900 8 || { echo 'AD-INF-202：服务器正在准备另一组运行依赖，请稍后继续' >&2; exit 75; }
decode() { printf '%s' "$1" | base64 -d; }
pull_with_timeout() {
  candidate="$1"
  if command -v timeout >/dev/null 2>&1; then
    timeout 150 docker pull "$candidate" >/dev/null 2>&1
  else
    docker pull "$candidate" >/dev/null 2>&1
  fi
}
resolve_runtime_image() {
  component="$1"
  digest="$2"
  local_image="$3"
  shift 3
  if docker image inspect "$local_image" >/dev/null 2>&1; then
    RESOLVED_IMAGE="$local_image"
    return 0
  fi
  for repository in "$@"; do
    candidate="$repository@$digest"
    if pull_with_timeout "$candidate"; then
      docker tag "$candidate" "$local_image"
      RESOLVED_IMAGE="$local_image"
      return 0
    fi
  done
  echo "AD-INF-202：服务器暂时无法下载${component}运行组件；系统已尝试国内来源" >&2
  return 1
}
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

if [ "$NEEDS_POSTGRES" = 1 ]; then
  POSTGRES_CONTAINER=''
  for candidate in abcdeploy-postgres infra-postgres; do
    if docker inspect "$candidate" >/dev/null 2>&1; then POSTGRES_CONTAINER="$candidate"; break; fi
  done
  if [ -z "$POSTGRES_CONTAINER" ]; then
    POSTGRES_ADMIN_PASSWORD="$(decode '__POSTGRES_ADMIN_PASSWORD__')"
    POSTGRES_DIGEST='sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
    POSTGRES_LOCAL_IMAGE='abcdeploy/runtime-postgres:16-57c72fd2a128e416'
    resolve_runtime_image '数据库' "$POSTGRES_DIGEST" "$POSTGRES_LOCAL_IMAGE" \
      'mirror.ccs.tencentyun.com/library/postgres' \
      'm.daocloud.io/docker.io/library/postgres' \
      'postgres' || exit 1
    POSTGRES_IMAGE="$RESOLVED_IMAGE"
    docker volume create abcdeploy-postgres-data >/dev/null
    if ! docker run -d --name abcdeploy-postgres --restart unless-stopped \
      --network "$NETWORK" -e POSTGRES_PASSWORD="$POSTGRES_ADMIN_PASSWORD" \
      -v abcdeploy-postgres-data:/var/lib/postgresql/data "$POSTGRES_IMAGE" >/dev/null; then
      echo 'AD-INF-203：服务器数据库没有完成启动' >&2
      exit 1
    fi
    POSTGRES_CONTAINER=abcdeploy-postgres
  fi
  docker start "$POSTGRES_CONTAINER" >/dev/null 2>&1 || { echo 'AD-INF-203：服务器数据库无法重新启动' >&2; exit 1; }
  docker network connect "$NETWORK" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  if ! docker network inspect "$NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -Fx -- "$POSTGRES_CONTAINER" >/dev/null; then
    echo 'AD-INF-203：服务器数据库无法连接项目运行网络' >&2
    exit 1
  fi
  ready=0
  for _ in $(seq 1 45); do
    if docker exec -u postgres "$POSTGRES_CONTAINER" pg_isready -d postgres >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ] || { echo 'AD-INF-203：PostgreSQL 启动后未能就绪' >&2; exit 1; }
  DB_NAME="$(decode '__DB_NAME__')"
  DB_USER="$(decode '__DB_USER__')"
  DB_PASSWORD="$(decode '__DB_PASSWORD__')"
  docker exec -i -u postgres "$POSTGRES_CONTAINER" psql -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$abcdeploy\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '$DB_USER', '$DB_PASSWORD');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '$DB_USER', '$DB_PASSWORD');
  END IF;
END
\$abcdeploy\$;
SELECT format('CREATE DATABASE %I OWNER %I', '$DB_NAME', '$DB_USER')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB_NAME') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', '$DB_NAME', '$DB_USER') \gexec
SQL
  printf 'POSTGRES_HOST=%s\n' "$POSTGRES_CONTAINER"
fi

if [ "$NEEDS_REDIS" = 1 ]; then
  REDIS_PASSWORD="$(decode '__REDIS_PASSWORD__')"
  REDIS_CONTAINER=''
  for candidate in abcdeploy-redis infra-redis; do
    if docker inspect "$candidate" >/dev/null 2>&1; then REDIS_CONTAINER="$candidate"; break; fi
  done
  if [ -z "$REDIS_CONTAINER" ]; then
    REDIS_DIGEST='sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'
    REDIS_LOCAL_IMAGE='abcdeploy/runtime-redis:7-6ab0b6e738177933'
    resolve_runtime_image '缓存' "$REDIS_DIGEST" "$REDIS_LOCAL_IMAGE" \
      'mirror.ccs.tencentyun.com/library/redis' \
      'm.daocloud.io/docker.io/library/redis' \
      'redis' || exit 1
    REDIS_IMAGE="$RESOLVED_IMAGE"
    docker volume create abcdeploy-redis-data >/dev/null
    if ! docker run -d --name abcdeploy-redis --restart unless-stopped --network "$NETWORK" \
      -v abcdeploy-redis-data:/data "$REDIS_IMAGE" \
      redis-server --appendonly yes --requirepass "$REDIS_PASSWORD" >/dev/null; then
      echo 'AD-INF-204：服务器缓存服务没有完成启动' >&2
      exit 1
    fi
    REDIS_CONTAINER=abcdeploy-redis
  fi
  docker start "$REDIS_CONTAINER" >/dev/null 2>&1 || { echo 'AD-INF-204：服务器缓存服务无法重新启动' >&2; exit 1; }
  docker network connect "$NETWORK" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  if ! docker network inspect "$NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -Fx -- "$REDIS_CONTAINER" >/dev/null; then
    echo 'AD-INF-204：服务器缓存服务无法连接项目运行网络' >&2
    exit 1
  fi
  ready=0
  for _ in $(seq 1 30); do
    if [ -n "$REDIS_PASSWORD" ]; then
      docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1 && ready=1 && break
    else
      docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1 && ready=1 && break
    fi
    sleep 1
  done
  [ "$ready" = 1 ] || { echo 'AD-INF-204：Redis 已存在但认证方式无法自动识别' >&2; exit 1; }
  printf 'REDIS_HOST=%s\n' "$REDIS_CONTAINER"
  printf 'REDIS_PASSWORD_B64=%s\n' "$(printf '%s' "$REDIS_PASSWORD" | base64 | tr -d '\n')"
fi
"#;

fn remote_dependency_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("AD-") && (line.contains('：') || line.contains(':')))
        .or_else(|| {
            stderr
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or("AD-INF-202：服务器运行依赖准备失败")
        .to_string()
}

fn safe_postgres_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && value.as_bytes()[0].is_ascii_lowercase()
}

fn valid_remote_container_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn remote_server_id(profile: &ssh::SshProfile) -> String {
    let mut digest = Sha256::new();
    digest.update(profile.host.as_bytes());
    digest.update(profile.port.to_be_bytes());
    let digest = format!("{:x}", digest.finalize());
    digest[..24].to_string()
}

fn remote_redis_database_for_scope(root: &Path, scope: &str) -> u8 {
    let mut digest = Sha256::new();
    digest.update(project_storage_id(root).as_bytes());
    digest.update(scope.as_bytes());
    let bytes = digest.finalize();
    (bytes[0] % 15) + 1
}

fn url_encode_userinfo(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String is infallible");
        }
    }
    encoded
}

fn ensure_runtime_template_variables(mut content: String, required: &[String]) -> String {
    let existing = content
        .lines()
        .filter_map(|line| {
            let left = line.split_once('=')?.0;
            let key = left
                .trim()
                .strip_prefix("export ")
                .unwrap_or_else(|| left.trim())
                .trim();
            valid_environment_variable(key).then(|| key.to_string())
        })
        .collect::<BTreeSet<_>>();
    let missing = required
        .iter()
        .filter(|variable| !existing.contains(*variable))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return content;
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if !content.is_empty() {
        content.push_str("\n# ABCDeploy 检测到的必要配置\n");
    }
    for variable in missing {
        writeln!(&mut content, "{variable}=").expect("writing to a String is infallible");
    }
    content
}

fn runtime_defaults(
    content: &str,
    secret_variables: &BTreeSet<String>,
) -> BTreeMap<String, String> {
    content
        .lines()
        .filter_map(|line| {
            let (left, raw_value) = line.split_once('=')?;
            let key = left
                .trim()
                .strip_prefix("export ")
                .unwrap_or_else(|| left.trim())
                .trim();
            let value = raw_value.trim().trim_matches(['\'', '"']);
            if !valid_environment_variable(key)
                || secret_variables.contains(key)
                || value.is_empty()
                || remote_runtime_value_invalid(raw_value)
            {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn postgres_runtime_url(value: &str) -> bool {
    let value = value.trim().trim_matches(['\'', '"']);
    value.starts_with("postgresql://") || value.starts_with("postgres://")
}

fn fill_managed_runtime_dependencies(
    content: &str,
    suggestions: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    let mut filled = Vec::new();
    let mut seen_suggestions = BTreeSet::new();
    let mut output = content
        .lines()
        .map(|line| {
            let Some((left, raw_value)) = line.split_once('=') else {
                return line.to_string();
            };
            let key = left
                .trim()
                .strip_prefix("export ")
                .unwrap_or_else(|| left.trim())
                .trim();
            let Some(suggestion) = suggestions.get(key) else {
                return line.to_string();
            };
            seen_suggestions.insert(key.to_string());
            let value = raw_value.trim().trim_matches(['\'', '"']);
            let wrong_managed_protocol = key == "DATABASE_URL"
                && postgres_runtime_url(suggestion)
                && !postgres_runtime_url(value);
            if !value.is_empty()
                && !remote_runtime_value_invalid(raw_value)
                && !wrong_managed_protocol
            {
                return line.to_string();
            }
            filled.push(key.to_string());
            format!("{left}={}", dotenv_value(suggestion))
        })
        .collect::<Vec<_>>()
        .join("\n");
    for (key, suggestion) in suggestions {
        if seen_suggestions.contains(key) {
            continue;
        }
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        writeln!(&mut output, "{key}={}", dotenv_value(suggestion))
            .expect("writing to a String is infallible");
        filled.push(key.clone());
    }
    if content.ends_with('\n') && !output.ends_with('\n') {
        output.push('\n');
    }
    (output, filled)
}

fn replace_managed_runtime_dependencies(
    content: &str,
    suggestions: &BTreeMap<String, String>,
    managed_keys: &BTreeSet<String>,
) -> (String, Vec<String>) {
    let mut replaced = Vec::new();
    let mut seen = BTreeSet::new();
    let mut output = content
        .lines()
        .map(|line| {
            let Some((left, _)) = line.split_once('=') else {
                return line.to_string();
            };
            let key = left
                .trim()
                .strip_prefix("export ")
                .unwrap_or_else(|| left.trim())
                .trim();
            if !managed_keys.contains(key) {
                return line.to_string();
            }
            let Some(suggestion) = suggestions.get(key) else {
                return line.to_string();
            };
            seen.insert(key.to_string());
            replaced.push(key.to_string());
            format!("{left}={}", dotenv_value(suggestion))
        })
        .collect::<Vec<_>>()
        .join("\n");
    for key in managed_keys {
        if seen.contains(key) {
            continue;
        }
        let Some(suggestion) = suggestions.get(key) else {
            continue;
        };
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        writeln!(&mut output, "{key}={}", dotenv_value(suggestion))
            .expect("writing to a String is infallible");
        replaced.push(key.clone());
    }
    if content.ends_with('\n') && !output.ends_with('\n') {
        output.push('\n');
    }
    (output, replaced)
}

#[tauri::command]
async fn rollback_environment(
    path: String,
    environment: String,
    server: ServerConnectionInput,
    confirmed: bool,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    if !confirmed {
        return Err("回滚前必须明确确认目标环境".to_string());
    }
    parse_deploy_environment(&environment)?;
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let rollback_source = if environment == "production" {
        Some(
            state
                .production_rollback_source_run(&root)?
                .ok_or_else(|| {
                    "本机没有可核对的上一生产版本，已停止回滚以免切换到未知镜像".to_string()
                })?,
        )
    } else {
        None
    };
    let mut run = state.create_deployment_run(
        &root,
        &manifest.project.name,
        &environment,
        &manifest.providers.build.repository,
        &manifest.source.release_branch,
    )?;
    if let Some(source) = &rollback_source {
        run.commit_sha.clone_from(&source.commit_sha);
        run.source_title.clone_from(&source.source_title);
        run.source_run_id = Some(source.id.clone());
        run.candidate_tag.clone_from(&source.candidate_tag);
    }
    run.status = "running".to_string();
    run.current_stage = "rollback".to_string();
    run.message = format!(
        "正在把{}恢复到上一健康版本",
        if environment == "production" {
            "生产环境"
        } else {
            "测试环境"
        }
    );
    run.completed_steps.clear();
    state.save_deployment_run(&run)?;

    let script = rollback_script(&manifest.project.name, &environment);
    let profile = server.profile();
    match ssh::execute(
        &profile,
        "sh -s",
        Some(script.as_bytes()),
        Duration::from_mins(5),
    )
    .await
    {
        Ok(output) if output.exit_status == Some(0) => {
            let release = output
                .stdout
                .lines()
                .find_map(|line| line.strip_prefix("ROLLED_BACK_TO="))
                .unwrap_or("上一健康版本");
            run.status = "success".to_string();
            run.current_stage = "complete".to_string();
            run.message = format!("已安全回滚到 {release}");
            run.completed_steps = vec!["rollback".to_string(), "healthcheck".to_string()];
            if environment == "production" {
                finalize_successful_deployment(&mut run, &state).await;
                if run.status == "success" {
                    run.message = format!("已安全回滚到 {release}，并核对为历史测试通过版本");
                }
            }
        }
        Ok(output) => {
            run.status = "failed".to_string();
            run.message = redact_text(&output.stderr)
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("回滚未完成，已尝试恢复回滚前版本")
                .to_string();
        }
        Err(error) => {
            run.status = "failed".to_string();
            run.message = public_error(error);
        }
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(run)
}

fn rollback_script(project_name: &str, environment: &str) -> String {
    let remote_directory = format!("$HOME/.deploydesk/apps/{project_name}/{environment}");
    format!(
        r#"set -eu
cd "{remote_directory}"
test -f docker-compose.yml
test -f .runtime.env
test -f .release.env
current_release="$(sed -n 's/^DEPLOYDESK_RELEASE_ID=//p' .release.env | head -n 1)"
previous_file=""
for candidate in $(ls -1t .history/*.env 2>/dev/null || true); do
  candidate_release="$(basename "$candidate" .env)"
  if [ "$candidate_release" != "$current_release" ]; then
    previous_file="$candidate"
    break
  fi
done
test -n "$previous_file" || {{ echo '没有可回滚的上一健康版本' >&2; exit 2; }}
cp .release.env .release.env.before-rollback
cp "$previous_file" .release.env
chmod 600 .release.env
compose='docker compose --env-file .release.env -f docker-compose.yml'
if $compose config --quiet && $compose pull && $compose up -d --remove-orphans --wait --wait-timeout 180; then
  rolled_back_to="$(basename "$previous_file" .env)"
  printf 'ROLLED_BACK_TO=%s\n' "$rolled_back_to"
else
  rollback_status=$?
  cp .release.env.before-rollback .release.env
  $compose pull || true
  $compose up -d --remove-orphans --wait --wait-timeout 180 || true
  exit "$rollback_status"
fi
"#
    )
}

#[tauri::command]
async fn secret_status(key: String, authorize: Option<bool>) -> Result<SecretStatus, String> {
    let authorize = authorize.unwrap_or(false);
    let read = tauri::async_runtime::spawn_blocking(move || {
        validate_secret_key(&key)?;
        let read_result = if authorize {
            read_keyring_secret(&key)
        } else {
            read_keyring_secret_without_prompt(&key)
        };
        let stored = match read_result {
            Ok(mut value) => {
                let stored = !value.is_empty();
                value.zeroize();
                stored
            }
            Err(error) if error == "missing" => false,
            Err(_) if !authorize => false,
            Err(error) => return Err(public_error(error)),
        };
        Ok(SecretStatus { key, stored })
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), read)
        .await
        .map_err(|_| "读取已保存凭据超时，请重新填写用户名和访问密码".to_string())?
        .map_err(public_error)?
}

#[tauri::command]
async fn store_secret(key: String, value: String) -> Result<SecretStatus, String> {
    let permit = tokio::time::timeout(Duration::from_secs(5), KEYCHAIN_WRITE_GATE.acquire())
        .await
        .map_err(|_| "系统密钥库正在处理上一项操作，请重新启动客户端后再试".to_string())?
        .map_err(public_error)?;
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut value = value;
        validate_secret_key(&key)?;
        if value.is_empty() {
            return Err("密钥不能为空".to_string());
        }
        let result = write_keyring_secret(&key, &value);
        value.zeroize();
        result?;
        Ok(SecretStatus { key, stored: true })
    });
    tokio::time::timeout(Duration::from_secs(8), write)
        .await
        .map_err(|_| "系统密钥库没有响应，请重新启动客户端后再试".to_string())?
        .map_err(public_error)?
}

#[tauri::command]
fn delete_secret(key: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
    delete_keyring_secret(&key)?;
    Ok(SecretStatus { key, stored: false })
}

fn registry_check(
    ok: bool,
    summary: &str,
    code: Option<&str>,
    next_steps: Vec<String>,
    retryable: bool,
) -> ProviderCheck {
    ProviderCheck {
        provider: "registry".to_string(),
        ok,
        summary: summary.to_string(),
        details: Vec::new(),
        code: code.map(ToString::to_string),
        next_steps,
        retryable,
    }
}

fn valid_registry_host(value: &str) -> bool {
    let value = value.trim();
    value.len() <= 253
        && value.split('.').count() >= 2
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 63
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && segment
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && segment
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
        })
}

fn valid_registry_namespace(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 100
        && value == value.to_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn check_registry_login(
    registry: &str,
    username: &str,
    password: &str,
) -> Result<ProviderCheck, String> {
    let registry = registry.trim();
    let username = username.trim();
    if !valid_registry_host(registry) {
        return Err("AD-REG-101：项目版本保存位置地址格式不正确".to_string());
    }
    if username.is_empty() || password.is_empty() {
        return Ok(registry_check(
            false,
            "登录信息还没有填写完整",
            Some("AD-REG-102"),
            vec!["填写登录用户名和访问密码后重新验证".to_string()],
            false,
        ));
    }

    // Docker login normally writes into ~/.docker/config.json. Use an isolated
    // one-shot config directory so credential validation never changes the
    // user's existing Docker login state. The password is sent only on stdin.
    let check_directory = std::env::temp_dir().join(format!(
        "abcdeploy-registry-check-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&check_directory).map_err(public_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Err(error) = fs::set_permissions(&check_directory, fs::Permissions::from_mode(0o700))
        {
            let _ = fs::remove_dir_all(&check_directory);
            return Err(public_error(error));
        }
    }
    let mut command = system_command("docker");
    command
        .args(["--config"])
        .arg(&check_directory)
        .args([
            "login",
            registry,
            "--username",
            username,
            "--password-stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        let _ = fs::remove_dir_all(&check_directory);
        return Ok(registry_check(
            false,
            "本机暂时无法验证镜像仓库",
            Some("AD-REG-103"),
            vec!["确认 Docker Desktop 已安装，然后重新验证".to_string()],
            true,
        ));
    };
    let write_result = match child.stdin.take() {
        Some(mut stdin) => stdin
            .write_all(password.as_bytes())
            .and_then(|()| stdin.write_all(b"\n")),
        None => Err(std::io::Error::other("无法安全提交镜像仓库密码")),
    };
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&check_directory);
        return Err(public_error(error));
    }

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < Duration::from_secs(20) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_dir_all(&check_directory);
                return Err(public_error(error));
            }
        }
    };
    let _ = fs::remove_dir_all(&check_directory);
    match status {
        Some(status) if status.success() => Ok(registry_check(
            true,
            "镜像仓库登录信息可用",
            None,
            Vec::new(),
            false,
        )),
        Some(_) => Ok(registry_check(
            false,
            "镜像仓库没有接受这组登录信息",
            Some("AD-REG-102"),
            vec!["重新获取登录用户名和访问密码后再试".to_string()],
            false,
        )),
        None => Ok(registry_check(
            false,
            "连接镜像仓库超时",
            Some("AD-REG-103"),
            vec!["检查本机网络后重新验证".to_string()],
            true,
        )),
    }
}

#[tauri::command]
async fn check_registry_credentials(
    registry: String,
    username: String,
    password: String,
) -> Result<ProviderCheck, String> {
    let check = tauri::async_runtime::spawn_blocking(move || {
        let password = Zeroizing::new(password);
        check_registry_login(&registry, &username, password.as_str())
    });
    tokio::time::timeout(Duration::from_secs(25), check)
        .await
        .map_err(|_| "镜像仓库验证超时，请检查网络后重试".to_string())?
        .map_err(public_error)?
}

fn optional_keyring_secret(key: &str) -> Result<Option<Zeroizing<String>>, String> {
    match read_keyring_secret(key) {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(error) if error == "missing" => Ok(None),
        Err(error) => Err(error),
    }
}

fn restore_keyring_secret(key: &str, value: Option<&Zeroizing<String>>) -> Result<(), String> {
    if let Some(value) = value {
        write_keyring_secret(key, value.as_str())
    } else {
        match delete_keyring_secret(key) {
            Ok(()) => Ok(()),
            Err(error) if error == "missing" => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[tauri::command]
async fn replace_registry_credentials(
    registry: String,
    secret_prefix: String,
    username: String,
    password: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProviderCheck, String> {
    if !matches!(secret_prefix.as_str(), TCR_SECRET_PREFIX | "registry.oci") {
        return Err("镜像仓库凭据类型不正确".to_string());
    }
    let registry_for_connection = registry.clone();
    let is_tcr = secret_prefix == TCR_SECRET_PREFIX;
    let permit = tokio::time::timeout(Duration::from_secs(5), KEYCHAIN_WRITE_GATE.acquire())
        .await
        .map_err(|_| "系统密钥库正在处理上一项操作，请稍后再试".to_string())?
        .map_err(public_error)?;
    let replace = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let username = Zeroizing::new(username.trim().to_string());
        let password = Zeroizing::new(password);
        let check = check_registry_login(&registry, username.as_str(), password.as_str())?;
        if !check.ok {
            return Ok(check);
        }

        let username_key = format!("{secret_prefix}.username");
        let password_key = format!("{secret_prefix}.password");
        let previous_username = optional_keyring_secret(&username_key)?;
        let previous_password = optional_keyring_secret(&password_key)?;

        write_keyring_secret(&username_key, username.as_str())?;
        if let Err(error) = write_keyring_secret(&password_key, password.as_str()) {
            // 两个字段必须作为一组生效。第二项写入失败时恢复旧值，避免
            // 留下“新用户名 + 旧密码”的混合连接。
            let username_restore =
                restore_keyring_secret(&username_key, previous_username.as_ref());
            let password_restore =
                restore_keyring_secret(&password_key, previous_password.as_ref());
            if username_restore.is_err() || password_restore.is_err() {
                return Err(
                    "AD-REG-104：新登录信息没有完整保存，旧连接恢复也未完成，请重新填写后验证"
                        .to_string(),
                );
            }
            return Err(error);
        }
        Ok(check)
    });
    let result = tokio::time::timeout(Duration::from_secs(40), replace)
        .await
        .map_err(|_| "验证并保存镜像仓库登录信息超时，请重新尝试".to_string())?
        .map_err(public_error)??;
    if result.ok && is_tcr {
        let namespace = state
            .setting("registry.tcr.namespace")?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut metadata = BTreeMap::from([("endpoint".to_string(), registry_for_connection)]);
        if let Some(namespace) = namespace {
            metadata.insert("namespace".to_string(), namespace);
        }
        let checked_at = Utc::now().to_rfc3339();
        state.upsert_compat_connection(
            TCR_REGISTRY_CONNECTION_ID,
            "registry",
            "tcr",
            "腾讯云 TCR",
            Some("registry.tcr.v2.password"),
            &metadata,
            &["push".to_string(), "pull".to_string()],
            "ready",
            Some(&checked_at),
        )?;
    }
    Ok(result)
}

#[tauri::command]
async fn check_saved_registry_credentials(
    registry: String,
    secret_prefix: String,
) -> Result<ProviderCheck, String> {
    if !matches!(secret_prefix.as_str(), TCR_SECRET_PREFIX | "registry.oci") {
        return Err("镜像仓库凭据类型不正确".to_string());
    }
    let check = tauri::async_runtime::spawn_blocking(move || {
        let username = match read_keyring_secret(&format!("{secret_prefix}.username")) {
            Ok(value) => Zeroizing::new(value),
            Err(error) if error == "missing" => {
                return Ok(registry_check(
                    false,
                    "没有找到可复用的镜像仓库登录信息",
                    Some("AD-REG-102"),
                    vec!["重新填写登录用户名和访问密码后验证".to_string()],
                    false,
                ));
            }
            Err(error) => return Err(error),
        };
        let password = match read_keyring_secret(&format!("{secret_prefix}.password")) {
            Ok(value) => Zeroizing::new(value),
            Err(error) if error == "missing" => {
                return Ok(registry_check(
                    false,
                    "没有找到可复用的镜像仓库登录信息",
                    Some("AD-REG-102"),
                    vec!["重新填写登录用户名和访问密码后验证".to_string()],
                    false,
                ));
            }
            Err(error) => return Err(error),
        };
        check_registry_login(&registry, username.as_str(), password.as_str())
    });
    tokio::time::timeout(Duration::from_secs(30), check)
        .await
        .map_err(|_| "读取并验证已保存的镜像仓库凭据超时".to_string())?
        .map_err(public_error)?
}

#[tauri::command]
async fn connect_cnb(
    token: String,
    persist: bool,
    repository: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<CnbAccount, String> {
    let token = Zeroizing::new(token);
    if let Some(repository) = repository
        .as_deref()
        .map(str::trim)
        .filter(|repository| !repository.is_empty())
    {
        // The repository is context for the setup screen, not part of account
        // authentication. A token that can identify its user and groups is a
        // valid replacement even when that repository does not expose build
        // history to it (for example because the token is repository-scoped).
        validate_repository_slug(repository)?;
    }
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let account = fetch_cnb_account(&client).await?;
    // Persist the newly verified identity before any repository capability is
    // needed. Repository-specific capabilities are checked by the operation
    // that actually needs them, with an operation-specific recovery path.
    if persist {
        write_keyring_secret("cnb-token", token.as_str())?;
    } else {
        cache_secret("cnb-token", token.as_str());
    }
    // Once the token is durable (or cached for this session), a failure to
    // update non-secret SQLite metadata must not make the UI claim that the
    // replacement token was not saved. Both summaries are reconstructable
    // from the saved token on the next connection check.
    save_cnb_connection_metadata_best_effort(
        || remember_cnb_account(state.inner(), &account),
        || mark_cnb_connection_ready(state.inner(), &account),
    );
    Ok(account)
}

fn save_cnb_connection_metadata_best_effort<Remember, Mark>(remember: Remember, mark: Mark)
where
    Remember: FnOnce() -> Result<(), String>,
    Mark: FnOnce() -> Result<(), String>,
{
    let _ = remember();
    // Keep attempting the first-class connection row even if the legacy
    // account summary failed; neither metadata write changes token validity.
    let _ = mark();
}

#[tauri::command]
async fn get_cnb_account(state: State<'_, WorkspaceState>) -> Result<CnbAccount, String> {
    // 先恢复不含令牌的账号摘要。macOS 在应用冷启动、UI 尚未完全可交互时
    // 可能暂时拒绝密钥库读取；连接页不应因此要求用户重复粘贴令牌。
    // 真正创建仓库、同步代码和触发构建仍会读取令牌并执行远端校验。
    if let Some(account) = cached_cnb_account(state.inner()) {
        return Ok(account);
    }
    // This command is only called from the explicit CNB setup screen. A normal
    // keychain read is required here because macOS can report an existing item as
    // missing while UI interaction is globally disabled immediately after launch.
    // The app is consistently development-signed, so an already-authorized item
    // does not prompt again; real failures remain visible to the setup screen.
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) if error == "missing" => {
            let _ = state.set_setting(CNB_ACCOUNT_CACHE_KEY, "");
            return Ok(CnbAccount {
                connected: false,
                display_name: "尚未连接".to_string(),
                username: String::new(),
                default_namespace: String::new(),
                namespaces: Vec::new(),
            });
        }
        Err(error) => return Err(cnb_keyring_issue(&error).1.to_string()),
    };
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let account = fetch_cnb_account(&client).await?;
    remember_cnb_account(state.inner(), &account)?;
    Ok(account)
}

async fn fetch_cnb_account(client: &CnbClient) -> Result<CnbAccount, String> {
    let request = async {
        let (user, groups) = tokio::try_join!(client.current_user(), client.user_groups())
            .map_err(cnb_public_error)?;
        Ok::<CnbAccount, String>(cnb_account_from_responses(&user, &groups))
    };
    tokio::time::timeout(Duration::from_secs(12), request)
        .await
        .map_err(|_| "AD-CNB-102：读取代码平台账号超时，请检查网络后重试".to_string())?
}

fn remember_cnb_account(state: &WorkspaceState, account: &CnbAccount) -> Result<(), String> {
    let summary = serde_json::to_string(account).map_err(public_error)?;
    state.set_setting(CNB_ACCOUNT_CACHE_KEY, &summary)
}

fn cached_cnb_account(state: &WorkspaceState) -> Option<CnbAccount> {
    state
        .setting(CNB_ACCOUNT_CACHE_KEY)
        .ok()
        .flatten()
        .and_then(|summary| serde_json::from_str::<CnbAccount>(&summary).ok())
        .filter(|account| account.connected && !account.default_namespace.is_empty())
}

fn cnb_account_from_responses(user: &serde_json::Value, groups: &serde_json::Value) -> CnbAccount {
    let username = ["username", "slug", "login", "name"]
        .into_iter()
        .find_map(|key| user.get(key).and_then(serde_json::Value::as_str))
        .unwrap_or("CNB 用户")
        .to_string();
    let display_name = ["nickname", "name", "username", "slug"]
        .into_iter()
        .find_map(|key| user.get(key).and_then(serde_json::Value::as_str))
        .unwrap_or(&username)
        .to_string();
    let namespaces = cnb_namespaces(groups);
    let default_namespace = namespaces
        .first()
        .map(|namespace| namespace.path.clone())
        .unwrap_or_default();
    CnbAccount {
        connected: true,
        display_name,
        username,
        default_namespace,
        namespaces,
    }
}

fn cnb_namespaces(groups: &serde_json::Value) -> Vec<CnbNamespace> {
    let mut namespaces = cnb_collection(groups)
        .iter()
        .filter_map(|group| {
            let path = group.get("path")?.as_str()?.trim();
            if !valid_cnb_namespace(path) {
                return None;
            }
            let access_role = group
                .get("access_role")
                .or_else(|| group.get("accessRole"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let normalized_role = access_role.to_ascii_lowercase();
            let can_create_repository = !group
                .get("freeze")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && matches!(
                    normalized_role.as_str(),
                    "owner" | "administrator" | "admin" | "master"
                );
            let display_name = ["remark", "name"]
                .into_iter()
                .filter_map(|key| group.get(key).and_then(serde_json::Value::as_str))
                .map(str::trim)
                .find(|value| !value.is_empty())
                .unwrap_or(path)
                .to_string();
            Some(CnbNamespace {
                path: path.to_string(),
                display_name,
                access_role,
                can_create_repository,
            })
        })
        .collect::<Vec<_>>();
    namespaces.sort_by(|left, right| {
        right
            .can_create_repository
            .cmp(&left.can_create_repository)
            .then_with(|| {
                left.path
                    .to_ascii_lowercase()
                    .cmp(&right.path.to_ascii_lowercase())
            })
    });
    namespaces.dedup_by(|left, right| left.path.eq_ignore_ascii_case(&right.path));
    namespaces
}

fn cnb_collection(value: &serde_json::Value) -> &[serde_json::Value] {
    value
        .as_array()
        .or_else(|| value.get("data").and_then(serde_json::Value::as_array))
        .or_else(|| {
            value
                .pointer("/data/list")
                .and_then(serde_json::Value::as_array)
        })
        .or_else(|| {
            value
                .pointer("/data/items")
                .and_then(serde_json::Value::as_array)
        })
        .map_or(&[], Vec::as_slice)
}

fn existing_cnb_repository(
    repositories: &serde_json::Value,
    namespace: &str,
    requested_name: &str,
) -> Option<String> {
    let requested_name = requested_name.trim();
    cnb_collection(repositories).iter().find_map(|repository| {
        let path = repository.get("path").and_then(serde_json::Value::as_str)?;
        let name = repository
            .get("name")
            .and_then(serde_json::Value::as_str)
            .or_else(|| path.rsplit('/').next())?;
        let (repository_namespace, repository_name) = path.rsplit_once('/')?;
        if name.eq_ignore_ascii_case(requested_name)
            && repository_name.eq_ignore_ascii_case(requested_name)
            && repository_namespace.eq_ignore_ascii_case(namespace.trim())
            && validate_repository_slug(path).is_ok()
        {
            Some(path.to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
async fn create_cnb_repository(
    token: String,
    slug: String,
    name: String,
    description: String,
    private_repo: bool,
) -> Result<CnbRepositoryResult, String> {
    let token = resolve_cnb_token(token)?;
    let client = CnbClient::new(token).map_err(cnb_public_error)?;
    client
        .create_repository(&slug, &name, &description, private_repo)
        .await
        .map_err(cnb_public_error)?;
    Ok(CnbRepositoryResult {
        repository: format!("{}/{}", slug.trim(), name.trim()),
        visibility: if private_repo { "private" } else { "public" }.to_string(),
    })
}

#[tauri::command]
async fn ensure_cnb_repository(slug: String, name: String) -> Result<CnbProjectSetup, String> {
    if !valid_cnb_namespace(slug.trim()) || !valid_repository_segment(name.trim()) {
        return Err("AD-CNB-105：CNB 组织或仓库名称格式不正确".to_string());
    }
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let namespaces = client.user_groups().await.map_err(cnb_public_error)?;
    let namespace = cnb_namespaces(&namespaces)
        .into_iter()
        .find(|namespace| namespace.path.eq_ignore_ascii_case(slug.trim()))
        .ok_or_else(|| {
            "AD-CNB-104：所选 CNB 组织不存在或当前账号无权使用，请重新连接后选择可用组织"
                .to_string()
        })?;
    let repositories = client
        .repositories(&namespace.path)
        .await
        .map_err(cnb_public_error)?;
    if let Some(repository) = existing_cnb_repository(&repositories, &namespace.path, &name) {
        return Ok(CnbProjectSetup {
            repository,
            created: false,
        });
    }
    if !namespace.can_create_repository {
        return Err(
            "AD-CNB-103：当前账号在所选 CNB 组织中没有创建仓库权限，请让组织管理员创建或提升权限"
                .to_string(),
        );
    }
    let created = match client
        .create_repository(
            &namespace.path,
            &name,
            "由 ABCDeploy 管理的私有构建仓库",
            true,
        )
        .await
    {
        Ok(_) => true,
        Err(DeployError::CnbApi { status: 409, .. }) => false,
        Err(error) => return Err(cnb_public_error(error)),
    };
    let repository = if created {
        format!("{}/{}", namespace.path, name.trim())
    } else {
        let repositories = client
            .repositories(&namespace.path)
            .await
            .map_err(cnb_public_error)?;
        existing_cnb_repository(&repositories, &namespace.path, &name).ok_or_else(|| {
            "AD-CNB-106：CNB 已存在同名仓库，但当前账号无法读取，请检查仓库权限".to_string()
        })?
    };
    Ok(CnbProjectSetup {
        repository,
        created,
    })
}

#[tauri::command]
async fn enable_cnb_auto_trigger(repository: String) -> Result<ProviderCheck, String> {
    validate_repository_slug(&repository)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    client
        .enable_auto_trigger(&repository)
        .await
        .map_err(cnb_public_error)?;
    Ok(ProviderCheck {
        provider: "cnb-auto-trigger".to_string(),
        ok: true,
        summary: "CNB 自动构建已开启".to_string(),
        details: vec!["发布分支的新提交会自动进入测试环境".to_string()],
        code: None,
        next_steps: Vec::new(),
        retryable: false,
    })
}

#[tauri::command]
async fn check_cnb_repository_access(repository: String) -> Result<ProviderCheck, String> {
    validate_repository_slug(&repository)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    client
        .recent_builds(&repository, 1)
        .await
        .map_err(cnb_build_history_error)?;
    Ok(ProviderCheck {
        provider: "cnb-repository".to_string(),
        ok: true,
        summary: "CNB 仓库可用".to_string(),
        details: Vec::new(),
        code: None,
        next_steps: Vec::new(),
        retryable: false,
    })
}

#[tauri::command]
async fn check_cnb_secret_repository_access(repository: String) -> Result<ProviderCheck, String> {
    validate_repository_slug(&repository)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let exists = client
        .repository_exists(&repository)
        .await
        .map_err(cnb_public_error)?;
    Ok(ProviderCheck {
        provider: "cnb-secret-repository".to_string(),
        ok: exists,
        summary: if exists {
            "CNB 安全位置可用"
        } else {
            "CNB 安全位置尚未创建"
        }
        .to_string(),
        details: Vec::new(),
        code: (!exists).then(|| "AD-CNB-204".to_string()),
        next_steps: if exists {
            Vec::new()
        } else {
            vec!["重新打开 CNB 创建页面，完成后继续".to_string()]
        },
        retryable: !exists,
    })
}

#[tauri::command]
fn sync_project_to_cnb(
    path: String,
    repository: String,
    branch: String,
    allow_uncommitted: bool,
    task_id: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<SourceSyncResult, String> {
    sync_project_to_cnb_inner(
        path,
        repository,
        branch,
        allow_uncommitted,
        task_id,
        state.inner(),
    )
}

fn sync_project_to_cnb_inner(
    path: String,
    repository: String,
    branch: String,
    allow_uncommitted: bool,
    task_id: Option<String>,
    state: &WorkspaceState,
) -> Result<SourceSyncResult, String> {
    validate_repository_slug(&repository)?;
    validate_git_branch(&branch)?;
    let root = PathBuf::from(path);
    let root = root
        .canonicalize()
        .map_err(|error| format!("项目目录无法读取：{error}"))?;
    let generated_lockfile = ensure_dependency_lockfile(&root)?;
    let initialized = ensure_git_repository_for_sync(&root, &branch)?;
    let mut allowed = deployment_owned_paths(&root);
    if let Some(lockfile) = generated_lockfile {
        allowed.push(lockfile);
    }
    let status = git_stdout(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    let unrelated = status
        .lines()
        .filter_map(status_path)
        .filter(|path| {
            !allowed.iter().any(|allowed| allowed == path)
                && !is_deployment_owned_path(path)
                && !is_deployment_internal_path(path)
        })
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !unrelated.is_empty() && !allow_uncommitted {
        let examples = unrelated
            .iter()
            .take(3)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("、");
        let remaining = unrelated.len().saturating_sub(3);
        let suffix = if remaining > 0 {
            format!("等 {} 个文件", unrelated.len())
        } else {
            String::new()
        };
        return Err(format!(
            "AD-GIT-101：发现尚未提交的项目文件：{examples}{suffix}。为避免部署旧代码，已暂停同步"
        ));
    }

    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let credentials = Zeroizing::new(format!("cnb:{}", token.as_str()));
    let authorization = Zeroizing::new(format!(
        "Authorization: Basic {}",
        BASE64.encode(credentials.as_bytes())
    ));
    let remote = format!("https://cnb.cool/{repository}.git");
    let snapshot_parent = cnb_snapshot_parent(&root, &remote, &branch, authorization.as_str())?;
    let (commit_sha, snapshot_created) =
        create_deployment_git_snapshot(&root, &allowed, snapshot_parent.as_deref())?;
    let committed = initialized || snapshot_created;
    if let Some(task_id) = task_id {
        let mut run = state.deployment_run(&task_id)?;
        let task_root = Path::new(&run.project_path)
            .canonicalize()
            .map_err(|error| format!("项目目录无法读取：{error}"))?;
        if !matches!(run.environment.as_str(), "staging" | "deployment") || task_root != root {
            return Err("保存的部署任务与即将同步的项目不一致".to_string());
        }
        run.repository.clone_from(&repository);
        run.branch.clone_from(&branch);
        run.commit_sha = Some(commit_sha.clone());
        run.source_title = local_git_title(&root, &commit_sha);
        run.status = "queued".to_string();
        run.current_stage = "sync-source".to_string();
        run.issue_code = None;
        run.action_kind = None;
        run.message = if run.environment == "deployment" {
            "当前本地项目已经生成独立快照，正在同步到构建服务".to_string()
        } else {
            "完整代码版本已保存，正在同步到 CNB".to_string()
        };
        run.updated_at = Utc::now().to_rfc3339();
        // push 可能自动触发构建，因此必须先保存完整 SHA。
        state.save_deployment_run(&run)?;
    }

    let refspec = format!("{commit_sha}:refs/heads/{branch}");
    let mut push = system_command("git");
    push.current_dir(&root)
        .arg("push")
        .arg(remote)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://cnb.cool/.extraHeader")
        .env("GIT_CONFIG_VALUE_0", authorization.as_str())
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL");
    run_git_command(push, "同步代码到 CNB")?;
    Ok(SourceSyncResult {
        repository,
        branch,
        commit_sha,
        committed,
    })
}

fn ensure_dependency_lockfile(root: &Path) -> Result<Option<String>, String> {
    if !root.join("package.json").is_file() {
        return Ok(None);
    }
    let inspection = inspect_project(root).map_err(public_error)?;
    let (lockfile, program, arguments): (&str, &str, &[&str]) = match inspection.package_manager {
        PackageManager::Pnpm => (
            "pnpm-lock.yaml",
            "corepack",
            &["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
        ),
        PackageManager::Npm => (
            "package-lock.json",
            "npm",
            &["install", "--package-lock-only", "--ignore-scripts"],
        ),
        PackageManager::Yarn => (
            "yarn.lock",
            "corepack",
            &["yarn", "install", "--ignore-scripts"],
        ),
        PackageManager::Bun => (
            "bun.lock",
            "bun",
            &["install", "--lockfile-only", "--ignore-scripts"],
        ),
        PackageManager::Unknown => return Ok(None),
    };
    if root.join(lockfile).is_file()
        || (inspection.package_manager == PackageManager::Bun && root.join("bun.lockb").is_file())
    {
        return Ok(None);
    }

    let output = system_command(program)
        .current_dir(root)
        .args(arguments)
        .env("CI", "false")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .output()
        .map_err(|error| format!("AD-PKG-202：无法启动依赖版本准备：{error}"))?;
    if !output.status.success() || !root.join(lockfile).is_file() {
        return Err(
            "AD-PKG-202：项目还没有依赖锁定文件，ABCDeploy 自动补齐时没有成功；请检查网络后重试"
                .to_string(),
        );
    }
    Ok(Some(lockfile.to_string()))
}

fn git_repository_root(root: &Path) -> Result<Option<PathBuf>, String> {
    let output = system_command("git")
        .current_dir(root)
        .args(["rev-parse", "--show-toplevel"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| git_launch_error("读取 Git 项目", &error))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout);
        return PathBuf::from(path.trim())
            .canonicalize()
            .map(Some)
            .map_err(public_error);
    }
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    if details.contains("not a git repository") {
        return Ok(None);
    }
    Err(git_failure("读取 Git 项目", &output.stdout, &output.stderr))
}

fn ensure_initial_gitignore(root: &Path) -> Result<(), String> {
    const MARKER: &str = "# ABCDeploy 本机和密钥文件";
    let path = root.join(".gitignore");
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    if content.lines().any(|line| line.trim() == MARKER) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(concat!(
        "\n# ABCDeploy 本机和密钥文件\n",
        ".env\n",
        ".env.*\n",
        "!.env.example\n",
        "!.env.*.example\n",
        "!.env.sample\n",
        "!.env.*.sample\n",
        "!.env.template\n",
        "!.env.*.template\n",
        "*.pem\n",
        "*.key\n",
        "*.p12\n",
        "*.pfx\n",
        "id_rsa\n",
        "id_ed25519\n",
        ".DS_Store\n",
    ));
    fs::write(path, content).map_err(public_error)
}

fn git_head_exists(root: &Path) -> Result<bool, String> {
    let status = system_command("git")
        .current_dir(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| git_launch_error("检查项目版本", &error))?;
    Ok(status.success())
}

fn ensure_git_repository_for_sync(root: &Path, branch: &str) -> Result<bool, String> {
    let root = root.canonicalize().map_err(public_error)?;
    let repository_root = git_repository_root(&root)?;
    if let Some(repository_root) = repository_root.as_ref()
        && repository_root != &root
    {
        return Err("AD-GIT-103：当前目录属于另一个代码项目，请选择最外层的项目目录".to_string());
    }

    if repository_root.is_none() {
        let mut init = system_command("git");
        init.current_dir(&root).args(["init", "--quiet"]);
        run_git_command(init, "初始化代码项目")?;

        let reference = format!("refs/heads/{branch}");
        let mut set_branch = system_command("git");
        set_branch
            .current_dir(&root)
            .args(["symbolic-ref", "HEAD", &reference]);
        run_git_command(set_branch, "设置默认代码分支")?;
    }

    if git_head_exists(&root)? {
        return Ok(false);
    }

    ensure_initial_gitignore(&root)?;
    let mut add = system_command("git");
    add.current_dir(&root).args(["add", "--all", "--", "."]);
    run_git_command(add, "准备首次代码版本")?;

    let staged = system_command("git")
        .current_dir(&root)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|error| git_launch_error("检查首次代码版本", &error))?;
    if staged.success() {
        return Err("AD-GIT-104：项目目录中没有可以发布的代码文件".to_string());
    }

    let mut commit = system_command("git");
    commit.current_dir(&root).args([
        "-c",
        "user.name=ABCDeploy",
        "-c",
        "user.email=abcdeploy@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "chore: initialize project for ABCDeploy",
    ]);
    run_git_command(commit, "创建首次代码版本")?;
    Ok(true)
}

/// Creates a detached commit from the current working tree with a temporary
/// Git index. The user's branch, staging area and local changes stay exactly
/// where they were; the returned commit is pushed directly to the managed CNB
/// branch. This is the product contract behind “上线当前本地项目”.
fn create_deployment_git_snapshot(
    root: &Path,
    deployment_owned_paths: &[String],
    parent_override: Option<&str>,
) -> Result<(String, bool), String> {
    let temporary = tempfile::tempdir().map_err(public_error)?;
    let index = temporary.path().join("index");
    let index_value = index.to_string_lossy().into_owned();
    let run = |arguments: &[&str], action: &str| -> Result<std::process::Output, String> {
        let output = system_command("git")
            .current_dir(root)
            .args(arguments)
            .env("GIT_INDEX_FILE", &index_value)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_TRACE")
            .env_remove("GIT_TRACE_CURL")
            .output()
            .map_err(|error| git_launch_error(action, &error))?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(git_failure(action, &output.stdout, &output.stderr))
        }
    };

    run(&["read-tree", "HEAD"], "准备独立上线快照")?;
    run(&["add", "--all", "--", "."], "收集当前本地项目")?;
    if !deployment_owned_paths.is_empty() {
        let mut command = system_command("git");
        command
            .current_dir(root)
            .args(["add", "--force", "--"])
            .args(deployment_owned_paths)
            .env("GIT_INDEX_FILE", &index_value)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_TRACE")
            .env_remove("GIT_TRACE_CURL");
        run_git_command(command, "收集 ABCDeploy 生成文件")?;
    }

    let listed = run(&["ls-files", "-z"], "检查上线快照中的文件")?;
    let sensitive = listed
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter(|path| sensitive_deployment_snapshot_path(path))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for paths in sensitive.chunks(100) {
        let mut command = system_command("git");
        command
            .current_dir(root)
            .args(["rm", "-r", "--cached", "--ignore-unmatch", "--"])
            .args(paths)
            .env("GIT_INDEX_FILE", &index_value)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_TRACE")
            .env_remove("GIT_TRACE_CURL");
        run_git_command(command, "从上线快照排除本机密钥")?;
    }

    let tree = String::from_utf8_lossy(&run(&["write-tree"], "生成上线快照")?.stdout)
        .trim()
        .to_string();
    let parent = if let Some(parent) = parent_override {
        checked_git_revision(Some(parent))?
            .ok_or_else(|| "AD-GIT-105：无法读取 CNB 上一次上线快照".to_string())?
    } else {
        checked_git_revision(Some(&git_stdout(root, &["rev-parse", "HEAD"])?))?
            .ok_or_else(|| "AD-GIT-105：无法读取当前代码版本".to_string())?
    };
    let parent_tree_expression = format!("{parent}^{{tree}}");
    let current_tree = git_stdout(root, &["rev-parse", &parent_tree_expression])?
        .trim()
        .to_string();
    if tree == current_tree {
        return Ok((parent, false));
    }
    let output = system_command("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=ABCDeploy",
            "-c",
            "user.email=abcdeploy@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &tree,
            "-p",
            &parent,
            "-m",
            "chore: ABCDeploy deployment snapshot",
        ])
        .env("GIT_INDEX_FILE", &index_value)
        .env("GIT_AUTHOR_NAME", "ABCDeploy")
        .env("GIT_AUTHOR_EMAIL", "abcdeploy@localhost")
        .env("GIT_COMMITTER_NAME", "ABCDeploy")
        .env("GIT_COMMITTER_EMAIL", "abcdeploy@localhost")
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL")
        .output()
        .map_err(|error| git_launch_error("保存独立上线快照", &error))?;
    if !output.status.success() {
        return Err(git_failure(
            "保存独立上线快照",
            &output.stdout,
            &output.stderr,
        ));
    }
    let revision = checked_git_revision(Some(&String::from_utf8_lossy(&output.stdout)))?
        .ok_or_else(|| "AD-GIT-105：独立上线快照没有返回完整版本".to_string())?;
    Ok((revision, true))
}

/// Returns the parent for a new detached deployment snapshot without changing
/// the user's branch. A remote-only tip is reusable only when it is an exact
/// `ABCDeploy` snapshot; arbitrary CNB-side commits are never overwritten.
fn cnb_snapshot_parent(
    root: &Path,
    remote: &str,
    branch: &str,
    authorization: &str,
) -> Result<Option<String>, String> {
    let remote_ref = format!("refs/heads/{branch}");
    let mut list = system_command("git");
    list.current_dir(root)
        .args(["ls-remote", "--heads", remote, &remote_ref])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://cnb.cool/.extraHeader")
        .env("GIT_CONFIG_VALUE_0", authorization)
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL");
    let listed = list
        .output()
        .map_err(|error| git_launch_error("检查 CNB 部署分支", &error))?;
    if !listed.status.success() {
        return Err(git_failure(
            "检查 CNB 部署分支",
            &listed.stdout,
            &listed.stderr,
        ));
    }
    let Some(remote_tip) = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .find_map(|revision| checked_git_revision(Some(revision)).ok().flatten())
    else {
        return Ok(None);
    };
    let local_head = checked_git_revision(Some(&git_stdout(root, &["rev-parse", "HEAD"])?))?
        .ok_or_else(|| "AD-GIT-105：无法读取当前代码版本".to_string())?;
    if remote_tip == local_head {
        return Ok(None);
    }

    let mut fetch = system_command("git");
    fetch
        .current_dir(root)
        .args([
            "fetch",
            "--quiet",
            "--no-tags",
            "--depth=1",
            remote,
            &remote_ref,
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://cnb.cool/.extraHeader")
        .env("GIT_CONFIG_VALUE_0", authorization)
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL");
    run_git_command(fetch, "读取 CNB 上一次上线快照")?;

    let ancestor = system_command("git")
        .current_dir(root)
        .args(["merge-base", "--is-ancestor", &remote_tip, &local_head])
        .status()
        .map_err(|error| git_launch_error("核对 CNB 部署分支", &error))?;
    if ancestor.success() {
        return Ok(None);
    }
    let metadata = git_stdout(
        root,
        &["show", "-s", "--format=%an%x00%ae%x00%s", &remote_tip],
    )?;
    let mut fields = metadata.trim_end().split('\0');
    let managed = fields.next() == Some("ABCDeploy")
        && fields.next() == Some("abcdeploy@localhost")
        && fields.next() == Some("chore: ABCDeploy deployment snapshot");
    if !managed {
        return Err(
            "AD-GIT-102：CNB 部署分支包含非 ABCDeploy 更新，已停止覆盖；请先同步代码后重试"
                .to_string(),
        );
    }
    Ok(Some(remote_tip))
}

fn sensitive_deployment_snapshot_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if is_deployment_internal_path(&normalized) {
        return true;
    }
    let file = normalized.rsplit('/').next().unwrap_or(&normalized);
    let lower = file.to_ascii_lowercase();
    if lower == ".env"
        || (lower.starts_with(".env.")
            && !matches!(
                lower.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ))
    {
        return true;
    }
    let sensitive_extension = Path::new(file)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["pem", "key", "p12", "pfx"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        });
    matches!(lower.as_str(), "id_rsa" | "id_ed25519") || sensitive_extension
}

#[cfg(test)]
fn stage_deployment_owned_files(root: &Path, paths: &[String]) -> Result<(), String> {
    let mut add = system_command("git");
    // 项目常见的 `build/` 忽略规则也会命中
    // `.deploydesk/generated/build/`。这些路径由 ABCDeploy 生成并明确纳入部署
    // 快照，因此需要强制暂存，避免流水线拿到只引用 Dockerfile、却没有
    // Dockerfile 本身的不完整提交。
    add.current_dir(root).args(["add", "--force", "--"]);
    add.args(paths);
    run_git_command(add, "暂存部署配置")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoredCnbToken<'a> {
    Present(&'a str),
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CnbTokenResolutionError {
    StoredCredentialUnavailable,
}

fn resolve_cnb_token_sources(
    provided: &str,
    stored: StoredCnbToken<'_>,
    environment: Option<&str>,
    git_credential: Option<&str>,
) -> Result<Option<String>, CnbTokenResolutionError> {
    if let Some(token) = [provided]
        .into_iter()
        .map(str::trim)
        .find(|token| !token.is_empty())
        .map(ToString::to_string)
    {
        return Ok(Some(token));
    }

    match stored {
        StoredCnbToken::Present(token) if !token.trim().is_empty() => {
            return Ok(Some(token.trim().to_string()));
        }
        StoredCnbToken::Unavailable => {
            return Err(CnbTokenResolutionError::StoredCredentialUnavailable);
        }
        StoredCnbToken::Present(_) | StoredCnbToken::Missing => {}
    }

    Ok([environment, git_credential]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|token| !token.is_empty())
        .map(ToString::to_string))
}

fn cnb_keyring_issue(error: &str) -> (&'static str, &'static str) {
    if error == "missing" {
        ("AD-CNB-101", CNB_LOGIN_MISSING_ERROR)
    } else {
        ("AD-CNB-108", CNB_KEYCHAIN_UNAVAILABLE_ERROR)
    }
}

fn resolve_cnb_token(mut provided: String) -> Result<String, String> {
    // Do not touch the system keychain when the current UI action already
    // supplied a token. Besides being faster, this prevents an unrelated
    // keychain availability error from rejecting a valid replacement token.
    if let Some(token) = resolve_cnb_token_sources(&provided, StoredCnbToken::Missing, None, None)
        .expect("a missing stored token cannot fail")
    {
        provided.zeroize();
        return Ok(token);
    }
    provided.zeroize();

    // A token successfully saved by the connection screen is cached in the
    // same process and must outrank stale shell or Git credentials.
    if let Some(cached) = cached_secret("cnb-token") {
        let cached = Zeroizing::new(cached);
        if !cached.trim().is_empty() {
            return Ok(cached.trim().to_string());
        }
    }

    let (stored, stored_unavailable) = match read_keyring_secret_without_prompt("cnb-token") {
        Ok(token) => (Some(Zeroizing::new(token)), false),
        Err(error) if error == "missing" => (None, false),
        Err(_) => (None, true),
    };
    let environment = std::env::var("CNB_TOKEN").ok();
    let stored_source = if stored_unavailable {
        StoredCnbToken::Unavailable
    } else {
        stored.as_deref().map_or(StoredCnbToken::Missing, |token| {
            StoredCnbToken::Present(token.as_str())
        })
    };
    let selected = resolve_cnb_token_sources("", stored_source, environment.as_deref(), None)
        .map_err(|_| CNB_KEYCHAIN_UNAVAILABLE_ERROR.to_string())?;
    if let Some(token) = selected {
        return Ok(token);
    }

    let git_credential = read_cnb_git_credential().ok();
    resolve_cnb_token_sources("", StoredCnbToken::Missing, None, git_credential.as_deref())
        .expect("a missing stored token cannot fail")
        .ok_or_else(|| "AD-CNB-101：CNB 登录状态已失效，请返回连接步骤重新授权".to_string())
}

fn read_cnb_git_credential() -> Result<String, String> {
    let mut child = system_command("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法读取系统 Git 凭据".to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "无法读取系统 Git 凭据".to_string())?
        .write_all(b"protocol=https\nhost=cnb.cool\n\n")
        .map_err(|_| "无法读取系统 Git 凭据".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "无法读取系统 Git 凭据".to_string())?;
    if !output.status.success() {
        return Err("系统 Git 凭据中没有 CNB 授权".to_string());
    }
    let content = Zeroizing::new(
        String::from_utf8(output.stdout).map_err(|_| "CNB Git 凭据格式无效".to_string())?,
    );
    let password = content
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "系统 Git 凭据中没有 CNB 授权".to_string())?;
    cache_secret("cnb-token", password);
    Ok(password.to_string())
}

fn pipeline_identity(root: &Path, allow_create: bool) -> Result<PipelineIdentityMaterial, String> {
    let project_id = project_storage_id(root);
    let keyring_key = format!("pipeline-key.{}", &project_id[..24]);
    let (private_key, created) = match read_keyring_secret(&keyring_key) {
        Ok(value) => (Zeroizing::new(value), false),
        Err(error) if error == "missing" && allow_create => {
            let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(public_error)?;
            let encoded = key.to_openssh(LineEnding::LF).map_err(public_error)?;
            (Zeroizing::new(encoded.to_string()), true)
        }
        Err(error) if error == "missing" => {
            return Err("请先创建 ABCDeploy 持续部署专用连接".to_string());
        }
        Err(error) => return Err(error),
    };
    let parsed = PrivateKey::from_openssh(private_key.as_bytes())
        .map_err(|error| format!("持续部署身份无法读取，请重新创建：{}", public_error(error)))?;
    let encoded_public = parsed.public_key().to_openssh().map_err(public_error)?;
    let fingerprint = parsed.public_key().fingerprint(HashAlg::Sha256).to_string();
    Ok(PipelineIdentityMaterial {
        keyring_key,
        private_key,
        public_key: format!("{encoded_public} abcdeploy-{}", &project_id[..12]),
        fingerprint,
        created,
    })
}

fn runtime_secret_key(root: &Path, environment: &str, variable: &str) -> Result<String, String> {
    parse_runtime_environment(environment)?;
    if variable.is_empty()
        || variable.len() > 128
        || !variable
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("环境变量名称格式不正确".to_string());
    }
    let mut variable_digest = Sha256::new();
    variable_digest.update(variable.as_bytes());
    let variable_id = format!("{:x}", variable_digest.finalize());
    Ok(format!(
        "runtime.{}.{}.{}",
        &project_storage_id(root)[..16],
        environment,
        &variable_id[..16]
    ))
}

fn runtime_config_key(root: &Path, environment: &str) -> Result<String, String> {
    parse_runtime_environment(environment)?;
    // Whole-file runtime settings used to share the first-generation account
    // name. Those Keychain items may still be bound to an ad-hoc development
    // signature and updating them can summon SecurityAgent on every rebuild.
    // A new account name creates one stable, app-signed item without changing
    // CNB, SSH or registry credentials that already work.
    Ok(format!(
        "runtime-file-v2.{}.{}",
        &project_storage_id(root)[..24],
        environment
    ))
}

fn runtime_config_filename(environment: &str) -> String {
    format!(".env.{environment}")
}

fn cnb_secret_filename(project: &str, environment: &str) -> String {
    format!("env.{project}.{environment}.yml")
}

fn runtime_config_template(
    root: &Path,
    environment: EnvironmentName,
) -> Result<(String, Vec<String>, Vec<String>), String> {
    let inspection = inspect_project(root).map_err(public_error)?;
    let canonical_root = PathBuf::from(&inspection.project_root);
    let manifest_path = canonical_root.join(MANIFEST_FILE);
    let mut manifest = if manifest_path.exists() {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    reconcile_detected_services(&inspection, &mut manifest);
    let required_variables = required_runtime_variables(&manifest, environment);
    let secret_variables = inspection
        .environment_variables
        .iter()
        .filter(|variable| variable.secret)
        .map(|variable| variable.name.clone())
        .collect::<BTreeSet<_>>();
    let prepare_content = |content: String| {
        let content = if environment == EnvironmentName::Development {
            content
        } else {
            remote_runtime_content(&content, &secret_variables, true)
        };
        ensure_runtime_template_variables(content, &required_variables)
    };
    let mut sections = Vec::new();
    for relative in &inspection.environment_files {
        let path = canonical_root.join(relative);
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("无法读取配置模板 {relative}：{error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(format!("配置模板不在项目目录内：{relative}"));
        }
        let content = fs::read_to_string(&canonical)
            .map_err(|error| format!("无法读取配置模板 {relative}：{error}"))?;
        sections.push((relative.clone(), content));
    }

    if sections.is_empty() {
        let generated_path = format!(
            ".deploydesk/generated/{}/.env.example",
            environment.as_str()
        );
        let generated = render_project_files(&manifest)
            .map_err(public_error)?
            .into_iter()
            .find(|file| file.path == generated_path)
            .ok_or_else(|| "无法生成运行配置模板".to_string())?;
        return Ok((
            prepare_content(generated.content),
            Vec::new(),
            required_variables,
        ));
    }

    let source_files = sections
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    if sections.len() == 1 {
        return Ok((
            prepare_content(sections.remove(0).1),
            source_files,
            required_variables,
        ));
    }

    let mut content = String::new();
    for (index, (path, section)) in sections.into_iter().enumerate() {
        if index > 0 {
            content.push('\n');
        }
        writeln!(&mut content, "# ===== 来源文件：{path} =====")
            .expect("writing to a String is infallible");
        content.push_str(section.trim_end_matches(['\r', '\n']));
        content.push('\n');
    }
    Ok((prepare_content(content), source_files, required_variables))
}

fn remote_runtime_content(
    content: &str,
    secret_variables: &BTreeSet<String>,
    clear_secrets: bool,
) -> String {
    let mut sanitized = content
        .lines()
        .map(|line| {
            let Some((left, raw_value)) = line.split_once('=') else {
                return line.to_string();
            };
            let key = left
                .trim()
                .strip_prefix("export ")
                .unwrap_or_else(|| left.trim())
                .trim();
            if !valid_environment_variable(key) {
                return line.to_string();
            }
            if key == "NODE_ENV" {
                return format!("{left}=production");
            }
            if (clear_secrets && secret_variables.contains(key))
                || remote_runtime_value_invalid(raw_value)
            {
                return format!("{left}=");
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    if content.ends_with('\n') {
        sanitized.push('\n');
    }
    sanitized
}

fn remote_runtime_value_invalid(raw_value: &str) -> bool {
    let value = raw_value
        .trim()
        .trim_matches(['\'', '"'])
        .to_ascii_lowercase();
    value.contains("localhost")
        || value.contains("127.0.0.1")
        || value.contains("[::1]")
        || value.contains("change-me")
        || value.contains("replace-me")
}

fn required_runtime_variables(
    manifest: &deploy_core::ProjectManifest,
    environment: EnvironmentName,
) -> Vec<String> {
    let mut variables = manifest
        .services
        .iter()
        // A static image has already baked Vite/Taro/UniApp variables into
        // its assets. Asking for them again on the server cannot change that
        // image and creates a false deployment blocker.
        .filter(|service| service.kind != deploy_core::model::ServiceKind::Static)
        .flat_map(|service| &service.runtime_env)
        .filter(|variable| variable.required)
        .map(|variable| variable.name.clone())
        .collect::<Vec<_>>();
    let environment_config = manifest.environments.get(environment);
    if environment_config.database.is_some() {
        variables.push("DATABASE_URL".to_string());
    }
    if environment_config.redis_namespace.is_some() {
        variables.push("REDIS_URL".to_string());
    }
    variables.sort();
    variables.dedup();
    variables
}

fn deployment_path_managed_runtime_variables(
    manifest: &deploy_core::ProjectManifest,
) -> BTreeSet<String> {
    const OCR_URL_VARIABLE: &str = "PP_OCRV6_TINY_URL";
    let has_ocr = manifest.services.iter().any(|service| service.id == "ocr");
    if has_ocr
        && manifest.services.iter().any(|service| {
            service
                .runtime_env
                .iter()
                .any(|variable| variable.name == OCR_URL_VARIABLE)
        })
    {
        BTreeSet::from([OCR_URL_VARIABLE.to_string()])
    } else {
        BTreeSet::new()
    }
}

fn parse_runtime_environment(value: &str) -> Result<EnvironmentName, String> {
    match value {
        "development" => Ok(EnvironmentName::Development),
        "staging" => Ok(EnvironmentName::Staging),
        "production" => Ok(EnvironmentName::Production),
        value if valid_deployment_path_scope(value) => Ok(EnvironmentName::Production),
        _ => Err("项目运行环境名称不正确".to_string()),
    }
}

fn parse_deploy_environment(value: &str) -> Result<EnvironmentName, String> {
    match value {
        "staging" => Ok(EnvironmentName::Staging),
        "production" => Ok(EnvironmentName::Production),
        value if valid_deployment_path_scope(value) => Ok(EnvironmentName::Production),
        _ => Err("持续部署密钥只能用于测试或生产环境".to_string()),
    }
}

fn valid_deployment_path_scope(value: &str) -> bool {
    value.starts_with("path-")
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn config_profile_secret_key(profile_id: &str, field: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(field.as_bytes());
    let field_id = format!("{:x}", digest.finalize());
    format!("profile.{profile_id}.{}", &field_id[..16])
}

fn valid_config_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn runtime_values_from_profile(
    profile: &ConfigProfile,
    project_path: &Path,
    environment: EnvironmentName,
) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    match (profile.kind.as_str(), profile.provider.as_str()) {
        ("ai", "minimax") => {
            values.insert("AI_PROVIDER".to_string(), "minimax".to_string());
            copy_profile_value(profile, "base_url", "MINIMAX_BASE_URL", &mut values);
            copy_profile_value(profile, "model", "MINIMAX_MODEL", &mut values);
            copy_profile_secret(profile, "api_key", "MINIMAX_API_KEY", &mut values)?;
        }
        ("database", "abcdeploy_local_postgres") => {
            let Some(mut password) = read_config_profile_secret(profile, "password")? else {
                return Ok(values);
            };
            let database = local_database_name(project_path, environment);
            ensure_local_postgres_database(&database)?;
            let host = profile
                .values
                .get("host")
                .map_or("127.0.0.1", String::as_str);
            let port = profile.values.get("port").map_or("55432", String::as_str);
            let user = profile
                .values
                .get("user")
                .map_or("abcdeploy", String::as_str);
            values.insert(
                "DATABASE_URL".to_string(),
                format!(
                    "postgresql://{user}:{}@{host}:{port}/{database}",
                    password.as_str()
                ),
            );
            password.zeroize();
        }
        ("redis", "abcdeploy_local_redis") => {
            let Some(mut password) = read_config_profile_secret(profile, "password")? else {
                return Ok(values);
            };
            let host = profile
                .values
                .get("host")
                .map_or("127.0.0.1", String::as_str);
            let port = profile.values.get("port").map_or("56379", String::as_str);
            values.insert(
                "REDIS_URL".to_string(),
                format!("redis://:{}@{host}:{port}/0", password.as_str()),
            );
            password.zeroize();
        }
        ("database", _) => {
            copy_profile_secret(profile, "url", "DATABASE_URL", &mut values)?;
        }
        ("redis", _) => {
            copy_profile_secret(profile, "url", "REDIS_URL", &mut values)?;
        }
        ("custom", _) => {
            if let (Some(variable), Some(value)) = (
                profile.values.get("env_name"),
                profile.values.get("env_value"),
            ) && valid_environment_variable(variable)
                && !value.is_empty()
            {
                values.insert(variable.clone(), value.clone());
            }
            for field in &profile.secret_fields {
                if valid_environment_variable(field) {
                    copy_profile_secret(profile, field, field, &mut values)?;
                }
            }
        }
        _ => {}
    }
    Ok(values)
}

fn read_config_profile_secret(
    profile: &ConfigProfile,
    field: &str,
) -> Result<Option<Zeroizing<String>>, String> {
    if !profile
        .secret_fields
        .iter()
        .any(|candidate| candidate == field)
    {
        return Ok(None);
    }
    match read_keyring_secret(&config_profile_secret_key(&profile.id, field)) {
        Ok(value) if !value.is_empty() => Ok(Some(Zeroizing::new(value))),
        Ok(_) => Ok(None),
        Err(error) if error == "missing" => Ok(None),
        Err(error) => Err(error),
    }
}

fn local_database_name(project_path: &Path, environment: EnvironmentName) -> String {
    let mut digest = Sha256::new();
    digest.update(
        project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf())
            .to_string_lossy()
            .as_bytes(),
    );
    let digest = format!("{:x}", digest.finalize());
    format!("abc_{}_{}", &digest[..16], environment.as_str())
}

fn ensure_local_postgres_database(database: &str) -> Result<(), String> {
    if !database
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("AD-INF-105：本机数据库名称不安全，已停止创建".to_string());
    }
    let query = format!("SELECT 1 FROM pg_database WHERE datname = '{database}'");
    let exists = system_command("docker")
        .args([
            "exec",
            "abcdeploy-local-postgres",
            "psql",
            "-U",
            "abcdeploy",
            "-d",
            "postgres",
            "-tAc",
            &query,
        ])
        .output()
        .map_err(|error| format!("AD-INF-101：无法检查本机数据库：{}", public_error(error)))?;
    if exists.status.success() && String::from_utf8_lossy(&exists.stdout).trim() == "1" {
        return Ok(());
    }
    let created = system_command("docker")
        .args([
            "exec",
            "abcdeploy-local-postgres",
            "createdb",
            "-U",
            "abcdeploy",
            database,
        ])
        .output()
        .map_err(|error| format!("AD-INF-101：无法创建本机数据库：{}", public_error(error)))?;
    if created.status.success() {
        Ok(())
    } else {
        Err("AD-INF-105：无法为当前项目创建隔离的本机数据库".to_string())
    }
}

fn copy_profile_value(
    profile: &ConfigProfile,
    field: &str,
    variable: &str,
    values: &mut BTreeMap<String, String>,
) {
    if let Some(value) = profile.values.get(field).filter(|value| !value.is_empty()) {
        values.insert(variable.to_string(), value.clone());
    }
}

fn copy_profile_secret(
    profile: &ConfigProfile,
    field: &str,
    variable: &str,
    values: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    if !profile
        .secret_fields
        .iter()
        .any(|candidate| candidate == field)
    {
        return Ok(());
    }
    match read_keyring_secret(&config_profile_secret_key(&profile.id, field)) {
        Ok(mut value) => {
            if !value.is_empty() {
                values.insert(variable.to_string(), value.clone());
            }
            value.zeroize();
            Ok(())
        }
        Err(error) if error == "missing" => Ok(()),
        Err(error) => Err(error),
    }
}

fn empty_runtime_variables(content: &str) -> Vec<String> {
    let mut variables = content
        .lines()
        .filter_map(|line| {
            let normalized = line
                .trim_start()
                .strip_prefix("export ")
                .unwrap_or_else(|| line.trim_start());
            let (raw_key, raw_value) = normalized.split_once('=')?;
            let key = raw_key.trim();
            (valid_environment_variable(key) && matches!(raw_value.trim(), "" | "\"\"" | "''"))
                .then(|| key.to_string())
        })
        .collect::<Vec<_>>();
    variables.sort();
    variables.dedup();
    variables
}

fn missing_runtime_variables(
    content: &str,
    required: &[String],
    environment: EnvironmentName,
) -> Vec<String> {
    let configured = content
        .lines()
        .filter_map(|line| {
            let normalized = line
                .trim_start()
                .strip_prefix("export ")
                .unwrap_or_else(|| line.trim_start());
            let (raw_key, raw_value) = normalized.split_once('=')?;
            let key = raw_key.trim();
            valid_environment_variable(key).then(|| {
                let value = raw_value.trim();
                let normalized = value.trim_matches(['\'', '"']);
                (
                    key.to_string(),
                    !matches!(value, "" | "\"\"" | "''")
                        && (environment == EnvironmentName::Development
                            || (key == "NODE_ENV" && normalized != "development")
                            || (key != "NODE_ENV" && !remote_runtime_value_invalid(value))),
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    required
        .iter()
        .filter(|variable| configured.get(*variable) != Some(&true))
        .cloned()
        .collect()
}

fn internal_runtime_secret(variable: &str) -> bool {
    [
        "JWT_SECRET",
        "AUTH_TOKEN_SECRET",
        "SESSION_SECRET",
        "COOKIE_SECRET",
        "ENCRYPTION_KEY",
        "SECRET_KEY",
    ]
    .iter()
    .any(|suffix| variable == *suffix || variable.ends_with(&format!("_{suffix}")))
}

fn load_or_generate_runtime_secret(
    root: &Path,
    environment: &str,
    variable: &str,
) -> Result<Zeroizing<String>, String> {
    let key = runtime_secret_key(root, environment, variable)?;
    match read_keyring_secret(&key) {
        Ok(value) if !value.is_empty() => Ok(Zeroizing::new(value)),
        Ok(mut value) => {
            value.zeroize();
            generate_runtime_secret_value(&key)
        }
        Err(error) if error == "missing" => generate_runtime_secret_value(&key),
        Err(error) => Err(error),
    }
}

fn generate_runtime_secret_value(key: &str) -> Result<Zeroizing<String>, String> {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        write!(&mut value, "{byte:02x}").expect("writing to a String is infallible");
    }
    bytes.zeroize();
    write_keyring_secret(key, &value)?;
    Ok(Zeroizing::new(value))
}

fn fill_empty_runtime_values(
    content: &str,
    suggestions: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    let mut output = String::with_capacity(content.len());
    let mut filled = Vec::new();
    for line in content.split_inclusive('\n') {
        let (body, newline) = line.strip_suffix('\n').map_or((line, ""), |body| {
            (body.strip_suffix('\r').unwrap_or(body), "\n")
        });
        let normalized = body
            .trim_start()
            .strip_prefix("export ")
            .unwrap_or(body.trim_start());
        let Some((raw_key, raw_value)) = normalized.split_once('=') else {
            output.push_str(line);
            continue;
        };
        let key = raw_key.trim();
        let value = raw_value.trim();
        let Some(suggestion) = suggestions.get(key) else {
            output.push_str(line);
            continue;
        };
        if !valid_environment_variable(key) || !matches!(value, "" | "\"\"" | "''") {
            output.push_str(line);
            continue;
        }
        let assignment_offset = body.len() - normalized.len();
        let equals_offset = normalized.find('=').unwrap_or_default();
        output.push_str(&body[..=(assignment_offset + equals_offset)]);
        output.push_str(&dotenv_value(suggestion));
        output.push_str(newline);
        filled.push(key.to_string());
    }
    if !content.is_empty() && !content.ends_with('\n') && output.ends_with('\n') {
        output.pop();
    }
    (output, filled)
}

fn valid_environment_variable(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_uppercase() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
}

fn dotenv_value(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn write_project_local_env(
    root: &Path,
    content: &str,
    overwrite: bool,
) -> Result<LocalEnvWriteResult, String> {
    if !root.is_dir() {
        return Err("AD-LOC-101：项目目录不存在，请重新选择项目".to_string());
    }
    if content.trim().is_empty() || content.contains('\0') {
        return Err("AD-LOC-102：本地运行配置为空或包含无效字符".to_string());
    }
    let tracked = system_command("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--error-unmatch", "--", ".env"])
        .output()
        .is_ok_and(|output| output.status.success());
    if tracked {
        return Err("AD-LOC-103：项目正在跟踪 .env，请先从 Git 中移除真实配置再生成".to_string());
    }
    let target = root.join(".env");
    let existing = fs::read_to_string(&target).ok();
    if existing.as_deref() == Some(content) {
        return Ok(LocalEnvWriteResult {
            path: target.to_string_lossy().into_owned(),
            written: false,
            requires_confirmation: false,
            backup_path: None,
        });
    }
    if existing.is_some() && !overwrite {
        return Ok(LocalEnvWriteResult {
            path: target.to_string_lossy().into_owned(),
            written: false,
            requires_confirmation: true,
            backup_path: None,
        });
    }
    let backup_path = if let Some(existing) = existing {
        let backup_directory = root.join(".deploydesk/backups/local-env");
        fs::create_dir_all(&backup_directory).map_err(public_error)?;
        let backup = backup_directory.join(format!("{}.env", Utc::now().format("%Y%m%d%H%M%S%3f")));
        fs::write(&backup, existing).map_err(public_error)?;
        Some(backup.to_string_lossy().into_owned())
    } else {
        None
    };
    let temporary = root.join(".env.abcdeploy.tmp");
    fs::write(&temporary, content).map_err(public_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(public_error)?;
    }
    fs::rename(&temporary, &target).map_err(public_error)?;
    ensure_local_env_ignored(root)?;
    Ok(LocalEnvWriteResult {
        path: target.to_string_lossy().into_owned(),
        written: true,
        requires_confirmation: false,
        backup_path,
    })
}

fn write_container_runtime_env(root: &Path) -> Result<(), String> {
    let content = fs::read_to_string(root.join(".env"))
        .map_err(|error| format!("AD-LOC-102：无法读取项目 .env：{}", public_error(error)))?;
    let runtime_directory = root.join(".deploydesk/runtime");
    fs::create_dir_all(&runtime_directory).map_err(public_error)?;
    let target = runtime_directory.join("development.env");
    let temporary = runtime_directory.join("development.env.tmp");
    fs::write(&temporary, container_runtime_env(&content)).map_err(public_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(public_error)?;
    }
    fs::rename(temporary, target).map_err(public_error)
}

fn container_runtime_env(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    for line in content.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let newline = if line.ends_with('\n') { "\n" } else { "" };
        let assignment = body
            .trim_start()
            .strip_prefix("export ")
            .unwrap_or_else(|| body.trim_start());
        let Some((key, value)) = assignment.split_once('=') else {
            output.push_str(line);
            continue;
        };
        if !matches!(key.trim(), "DATABASE_URL" | "REDIS_URL") {
            output.push_str(line);
            continue;
        }
        let adapted = value
            .replace("@127.0.0.1:", "@host.docker.internal:")
            .replace("@localhost:", "@host.docker.internal:")
            .replace("//127.0.0.1:", "//host.docker.internal:")
            .replace("//localhost:", "//host.docker.internal:");
        let value_offset = body.len().saturating_sub(value.len());
        output.push_str(&body[..value_offset]);
        output.push_str(&adapted);
        output.push_str(newline);
    }
    output
}

fn local_project_plan(
    root: &Path,
) -> Result<
    (
        InspectionReport,
        deploy_core::ProjectManifest,
        DeploymentPlan,
    ),
    String,
> {
    let inspection = inspect_project(root).map_err(public_error)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let mut manifest = if manifest_path.is_file() {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    reconcile_detected_services(&inspection, &mut manifest);
    let plan = build_plan(root, &inspection, &manifest).map_err(public_error)?;
    Ok((inspection, manifest, plan))
}

fn local_infrastructure_compose() -> &'static str {
    r#"name: abcdeploy-local-infrastructure

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: abcdeploy-local-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      TZ: Asia/Shanghai
    ports:
      - "127.0.0.1:${POSTGRES_PORT}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 30

  redis:
    image: redis:7-alpine
    container_name: abcdeploy-local-redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--requirepass", "${REDIS_PASSWORD}"]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      TZ: Asia/Shanghai
    ports:
      - "127.0.0.1:${REDIS_PORT}:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a $${REDIS_PASSWORD} ping | grep -q PONG"]
      interval: 5s
      timeout: 5s
      retries: 30

volumes:
  postgres-data:
  redis-data:
"#
}

fn local_infrastructure_port(
    state: &WorkspaceState,
    setting: &str,
    preferred: u16,
    container_name: &str,
) -> Result<u16, String> {
    if let Some(port) = state
        .setting(setting)?
        .and_then(|value| value.parse::<u16>().ok())
        && (local_container_exists(container_name)
            || std::net::TcpListener::bind(("127.0.0.1", port)).is_ok())
    {
        return Ok(port);
    }
    let port = (preferred..=preferred.saturating_add(50))
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .ok_or_else(|| "AD-INF-103：本机没有可用于基础服务的空闲端口".to_string())?;
    state.set_setting(setting, &port.to_string())?;
    Ok(port)
}

fn local_container_exists(name: &str) -> bool {
    system_command("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            &format!("name=^/{name}$"),
            "--format",
            "{{.Names}}",
        ])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|candidate| candidate.trim() == name)
        })
}

fn local_infrastructure_secret(key: &str) -> Result<Zeroizing<String>, String> {
    match read_keyring_secret(key) {
        Ok(value) if !value.is_empty() => Ok(Zeroizing::new(value)),
        Ok(_) => generate_local_infrastructure_secret(key),
        Err(error) if error == "missing" => generate_local_infrastructure_secret(key),
        Err(error) => Err(error),
    }
}

fn generate_local_infrastructure_secret(key: &str) -> Result<Zeroizing<String>, String> {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(64);
    for byte in &bytes {
        write!(&mut value, "{byte:02x}").expect("writing to a String is infallible");
    }
    bytes.zeroize();
    write_keyring_secret(key, &value)?;
    Ok(Zeroizing::new(value))
}

fn save_local_infrastructure_profiles(
    state: &WorkspaceState,
    postgres_port: u16,
    redis_port: u16,
    postgres_password: &Zeroizing<String>,
    redis_password: &Zeroizing<String>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let postgres = ConfigProfile {
        id: LOCAL_POSTGRES_PROFILE_ID.to_string(),
        kind: "database".to_string(),
        provider: "abcdeploy_local_postgres".to_string(),
        name: "ABCDeploy 本机 PostgreSQL".to_string(),
        scope: "local".to_string(),
        values: BTreeMap::from([
            ("host".to_string(), "127.0.0.1".to_string()),
            ("port".to_string(), postgres_port.to_string()),
            ("user".to_string(), "abcdeploy".to_string()),
        ]),
        secret_fields: vec!["password".to_string()],
        configured_secret_fields: Vec::new(),
        is_default: true,
        updated_at: now.clone(),
    };
    let redis = ConfigProfile {
        id: LOCAL_REDIS_PROFILE_ID.to_string(),
        kind: "redis".to_string(),
        provider: "abcdeploy_local_redis".to_string(),
        name: "ABCDeploy 本机 Redis".to_string(),
        scope: "local".to_string(),
        values: BTreeMap::from([
            ("host".to_string(), "127.0.0.1".to_string()),
            ("port".to_string(), redis_port.to_string()),
        ]),
        secret_fields: vec!["password".to_string()],
        configured_secret_fields: Vec::new(),
        is_default: true,
        updated_at: now,
    };
    write_keyring_secret(
        &config_profile_secret_key(LOCAL_POSTGRES_PROFILE_ID, "password"),
        postgres_password,
    )?;
    write_keyring_secret(
        &config_profile_secret_key(LOCAL_REDIS_PROFILE_ID, "password"),
        redis_password,
    )?;
    state.save_config_profile(&postgres)?;
    state.save_config_profile(&redis)
}

fn local_infrastructure_status(
    app_data: &Path,
    state: &WorkspaceState,
) -> Result<LocalInfrastructureStatus, String> {
    let compose_exists = app_data
        .join("local-infrastructure/docker-compose.yml")
        .is_file();
    let postgres_port = state
        .setting("local.infra.postgres.port")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(55_432);
    let redis_port = state
        .setting("local.infra.redis.port")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(56_379);
    let profiles_ready = state.config_profile(LOCAL_POSTGRES_PROFILE_ID)?.is_some()
        && state.config_profile(LOCAL_REDIS_PROFILE_ID)?.is_some();
    if !compose_exists {
        return Ok(LocalInfrastructureStatus {
            state: "not_prepared".to_string(),
            message: "本机数据库和 Redis 尚未准备".to_string(),
            postgres_running: false,
            redis_running: false,
            postgres_port,
            redis_port,
            profiles_ready,
        });
    }
    let Some((postgres_running, redis_running)) = local_container_readiness() else {
        return Ok(LocalInfrastructureStatus {
            state: "unavailable".to_string(),
            message: "Docker 当前不可用，启动 Docker Desktop 后可以继续".to_string(),
            postgres_running: false,
            redis_running: false,
            postgres_port,
            redis_port,
            profiles_ready,
        });
    };
    let (status, message) = if postgres_running && redis_running {
        ("running", "本机数据库和 Redis 运行正常")
    } else if postgres_running || redis_running {
        ("partial", "部分本机基础服务仍在启动")
    } else {
        ("stopped", "本机基础服务已停止，可以重新启动")
    };
    Ok(LocalInfrastructureStatus {
        state: status.to_string(),
        message: message.to_string(),
        postgres_running,
        redis_running,
        postgres_port,
        redis_port,
        profiles_ready,
    })
}

fn local_container_readiness() -> Option<(bool, bool)> {
    let output = system_command("docker")
        .args([
            "ps",
            "-a",
            "--filter",
            "name=^/abcdeploy-local-",
            "--format",
            "{{.Names}}\t{{.State}}\t{{.Status}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(parse_local_container_readiness(&text))
}

fn parse_local_container_readiness(text: &str) -> (bool, bool) {
    let ready = |name: &str| {
        text.lines().any(|line| {
            let mut fields = line.splitn(3, '\t');
            let container = fields.next().unwrap_or_default();
            let state = fields.next().unwrap_or_default();
            let status = fields.next().unwrap_or_default();
            container == name
                && state == "running"
                && !status.contains("(unhealthy)")
                && !status.contains("(health: starting)")
        })
    };
    (
        ready("abcdeploy-local-postgres"),
        ready("abcdeploy-local-redis"),
    )
}

fn local_infrastructure_failure(output: &std::process::Output) -> String {
    let details = compose_output_text(output).to_ascii_lowercase();
    if details.contains("port is already allocated") || details.contains("address already in use") {
        "AD-INF-103：本机基础服务端口被其他程序占用".to_string()
    } else if details.contains("pull access denied")
        || details.contains("failed to resolve")
        || details.contains("connection refused")
        || details.contains("timeout")
    {
        "AD-INF-102：基础服务镜像下载失败，请检查网络后重试".to_string()
    } else {
        "AD-INF-104：本机数据库或 Redis 没有正常启动".to_string()
    }
}

fn local_development_services(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &ProjectManifest,
) -> Vec<LocalDevelopmentService> {
    let mut result = Vec::new();
    for service in &manifest.services {
        let Some(detected) = inspection
            .services
            .iter()
            .find(|candidate| candidate.id == service.id)
        else {
            continue;
        };
        let dockerfile = root.join(&service.dockerfile);
        let dockerfile_content = fs::read_to_string(&dockerfile).unwrap_or_default();
        let normalized_dockerfile = dockerfile_content.to_ascii_uppercase();
        let generated = service
            .dockerfile
            .starts_with(".deploydesk/generated/build/Dockerfile.");
        if !generated && !normalized_dockerfile.contains("WORKDIR /APP") {
            continue;
        }

        let mut volumes = development_source_volumes(root, detected);
        if volumes.is_empty() {
            continue;
        }
        let (command, container_port, build_target, health_command) = if detected.framework
            == Framework::FastApi
        {
            let Some(start) = detected.start_command.as_deref() else {
                continue;
            };
            (
                if start.contains("--reload") {
                    start.to_string()
                } else {
                    format!("{start} --reload")
                },
                service.container_port,
                None,
                format!(
                    "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:{}{}', timeout=4)\"",
                    service.container_port, service.healthcheck.path
                ),
            )
        } else {
            let package_path = root.join(&detected.path).join("package.json");
            let package: serde_json::Value = fs::read_to_string(&package_path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default();
            let scripts = package
                .get("scripts")
                .and_then(serde_json::Value::as_object);
            let candidates: &[&str] = match detected.framework {
                Framework::NestJs => &["start:dev", "dev"],
                Framework::Taro | Framework::UniApp => &["dev:h5", "dev"],
                Framework::NextJs | Framework::Vite => &["dev"],
                _ => &["dev", "start:dev"],
            };
            let Some(script) = candidates
                .iter()
                .find(|candidate| scripts.is_some_and(|items| items.contains_key(**candidate)))
            else {
                continue;
            };
            let script_value = scripts
                .and_then(|items| items.get(*script))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let mut command =
                development_package_command(inspection.package_manager, &detected.path, script);
            if matches!(
                detected.framework,
                Framework::Vite | Framework::Taro | Framework::UniApp
            ) && !script_value.contains("--host")
            {
                command.push_str(" -- --host 0.0.0.0");
            }
            if detected.framework == Framework::NextJs
                && !script_value.contains("--hostname")
                && !script_value.contains("-H ")
            {
                command.push_str(" -- --hostname 0.0.0.0");
            }
            let container_port =
                development_script_port(script_value).unwrap_or(match detected.framework {
                    Framework::Vite | Framework::Taro | Framework::UniApp => 5173,
                    _ => service.container_port,
                });
            let build_target = (generated
                || normalized_dockerfile.contains(" AS BUILD")
                || normalized_dockerfile.contains(" AS BUILDER"))
            .then(|| {
                if normalized_dockerfile.contains(" AS BUILDER") {
                    "builder".to_string()
                } else {
                    "build".to_string()
                }
            });
            let Some(build_target) = build_target else {
                continue;
            };
            volumes.extend(development_shared_package_volumes(root));
            (
                command,
                container_port,
                Some(build_target),
                format!(
                    "node -e \"fetch('http://127.0.0.1:{}{}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
                    container_port, service.healthcheck.path
                ),
            )
        };
        result.push(LocalDevelopmentService {
            id: service.id.clone(),
            command,
            container_port,
            build_target,
            volumes,
            health_command,
        });
    }
    result
}

fn development_package_command(
    manager: PackageManager,
    package_path: &str,
    script: &str,
) -> String {
    let directory = shell_quote(&format!("/app/{}", package_path.trim_matches('/')));
    match manager {
        PackageManager::Pnpm => format!(
            "corepack pnpm --config.verify-deps-before-run=warn --dir {directory} run {script}"
        ),
        PackageManager::Yarn => format!("corepack yarn --cwd {directory} {script}"),
        PackageManager::Bun => format!("bun --cwd {directory} run {script}"),
        PackageManager::Npm | PackageManager::Unknown => {
            format!("npm --prefix {directory} run {script}")
        }
    }
}

fn development_script_port(command: &str) -> Option<u16> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if let Some(value) = part.strip_prefix("--port=") {
            return value.parse().ok();
        }
        if *part == "--port"
            && let Some(value) = parts.get(index + 1)
            && let Ok(port) = value.parse()
        {
            return Some(port);
        }
    }
    None
}

fn development_source_volumes(
    root: &Path,
    detected: &deploy_core::model::DetectedService,
) -> Vec<serde_json::Value> {
    let service_root = root.join(&detected.path);
    let mut paths = Vec::new();
    if detected.framework == Framework::FastApi {
        let source = service_root.join("src");
        if source.is_dir() {
            paths.push((source, "/app/src".to_string()));
        }
    } else {
        for name in ["src", "public"] {
            let source = service_root.join(name);
            if source.exists() {
                paths.push((
                    source,
                    format!("/app/{}/{name}", detected.path.trim_matches('/')),
                ));
            }
        }
        for name in [
            "index.html",
            "vite.config.ts",
            "vite.config.js",
            "nest-cli.json",
        ] {
            let source = service_root.join(name);
            if source.is_file() {
                paths.push((
                    source,
                    format!("/app/{}/{name}", detected.path.trim_matches('/')),
                ));
            }
        }
    }
    paths
        .into_iter()
        .map(|(source, target)| development_bind_mount(&source, &target))
        .collect()
}

fn development_shared_package_volumes(root: &Path) -> Vec<serde_json::Value> {
    let packages = root.join("packages");
    let Ok(entries) = fs::read_dir(packages) else {
        return Vec::new();
    };
    entries
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let source = entry.path().join("src");
            if !source.is_dir() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            Some(development_bind_mount(
                &source,
                &format!("/app/packages/{name}/src"),
            ))
        })
        .collect()
}

fn development_bind_mount(source: &Path, target: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "bind",
        "source": source.to_string_lossy(),
        "target": target,
    })
}

fn write_local_development_compose(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &ProjectManifest,
) -> Result<PathBuf, String> {
    let services = local_development_services(root, inspection, manifest);
    if services.len() != manifest.services.len() {
        return Err("AD-LOC-115：项目没有为全部服务提供可靠的开发命令，请使用稳定运行".to_string());
    }
    let base_path = local_compose_path(root);
    let raw = fs::read_to_string(&base_path).map_err(public_error)?;
    let mut compose: serde_json::Value = serde_yaml_ng::from_str(&raw).map_err(public_error)?;
    let compose_services = compose
        .get_mut("services")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "AD-LOC-115：本机运行配置缺少服务定义".to_string())?;
    for service in services {
        let value = compose_services
            .get_mut(&service.id)
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| format!("AD-LOC-115：找不到服务 {} 的本机配置", service.id))?;
        if let Some(target) = service.build_target {
            value
                .get_mut("build")
                .and_then(serde_json::Value::as_object_mut)
                .ok_or_else(|| "AD-LOC-115：开发模式缺少镜像构建配置".to_string())?
                .insert("target".to_string(), serde_json::Value::String(target));
        }
        value.insert(
            "command".to_string(),
            serde_json::json!(["sh", "-lc", service.command]),
        );
        value.insert("working_dir".to_string(), serde_json::json!("/app"));
        value.insert("init".to_string(), serde_json::json!(true));
        value.insert(
            "volumes".to_string(),
            serde_json::Value::Array(service.volumes),
        );
        if let Some(ports) = value
            .get_mut("ports")
            .and_then(serde_json::Value::as_array_mut)
            && let Some(port) = ports.first_mut()
            && let Some(current) = port.as_str()
            && let Some((host, _)) = current.rsplit_once(':')
        {
            *port = serde_json::json!(format!("{host}:{}", service.container_port));
        }
        if let Some(environment) = value
            .get_mut("environment")
            .and_then(serde_json::Value::as_object_mut)
        {
            environment.insert("CHOKIDAR_USEPOLLING".to_string(), serde_json::json!("true"));
            environment.insert("WATCHPACK_POLLING".to_string(), serde_json::json!("true"));
            environment.insert(
                "WATCHFILES_FORCE_POLLING".to_string(),
                serde_json::json!("true"),
            );
        }
        if let Some(healthcheck) = value
            .get_mut("healthcheck")
            .and_then(serde_json::Value::as_object_mut)
        {
            healthcheck.insert(
                "test".to_string(),
                serde_json::json!(["CMD-SHELL", service.health_command]),
            );
            healthcheck.insert("start_period".to_string(), serde_json::json!("45s"));
        }
    }
    let directory = root.join(".deploydesk/runtime/development");
    fs::create_dir_all(&directory).map_err(public_error)?;
    let path = directory.join("docker-compose.development.yml");
    let mut content = serde_yaml_ng::to_string(&compose).map_err(public_error)?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 生成，仅用于本机开发调试，不参与测试或正式发布。\n",
    );
    fs::write(&path, content).map_err(public_error)?;
    Ok(path)
}

fn local_development_build_services(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &ProjectManifest,
) -> Vec<String> {
    let services = local_development_services(root, inspection, manifest);
    let namespace = &manifest.environments.development.target.namespace;
    services
        .into_iter()
        .filter(|service| {
            if service.build_target.is_some() {
                return true;
            }
            let image = format!("{namespace}-{}", service.id);
            !system_command("docker")
                .args(["image", "inspect", &image])
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .map(|service| service.id)
        .collect()
}

fn local_compose_path(root: &Path) -> PathBuf {
    root.join(".deploydesk/generated/development/docker-compose.yml")
}

#[derive(Clone, Copy)]
struct LocalCommandLimits {
    idle: Duration,
    total: Duration,
}

fn local_build_command_limits() -> LocalCommandLimits {
    LocalCommandLimits {
        idle: Duration::from_mins(3),
        total: Duration::from_mins(30),
    }
}

fn local_start_command_limits() -> LocalCommandLimits {
    LocalCommandLimits {
        idle: Duration::from_secs(210),
        total: Duration::from_mins(4),
    }
}

fn local_start_cancelled(task_key: &str) -> bool {
    LOCAL_START_CANCELLED
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .is_ok_and(|cancelled| cancelled.contains(task_key))
}

fn set_local_start_pid(task_key: &str, pid: Option<u32>) -> std::io::Result<()> {
    let mut processes = LOCAL_START_PROCESSES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| std::io::Error::other("local start task state is unavailable"))?;
    if let Some(active) = processes.get_mut(task_key) {
        *active = pid;
    }
    Ok(())
}

fn terminate_local_process_group(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let _ = system_command("kill")
            .arg(signal)
            .arg("--")
            .arg(format!("-{pid}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut command = system_command("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let _ = command.status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = (pid, force);
}

fn stop_local_start_processes() {
    let pids = LOCAL_START_PROCESSES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map(|mut processes| {
            let pids = processes.values().flatten().copied().collect::<Vec<_>>();
            processes.clear();
            pids
        })
        .unwrap_or_default();
    for pid in pids {
        terminate_local_process_group(pid, true);
    }
    if let Ok(mut cancelled) = LOCAL_START_CANCELLED
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
    {
        cancelled.clear();
    }
}

fn capture_local_command_output<R: Read + Send + 'static>(
    mut reader: R,
    buffer: Arc<Mutex<Vec<u8>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 8 * 1024];
        while let Ok(read) = reader.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let Ok(mut bytes) = buffer.lock() else {
                break;
            };
            bytes.extend_from_slice(&chunk[..read]);
        }
    })
}

fn local_command_output_len(stdout: &Arc<Mutex<Vec<u8>>>, stderr: &Arc<Mutex<Vec<u8>>>) -> usize {
    stdout.lock().map_or(0, |bytes| bytes.len()) + stderr.lock().map_or(0, |bytes| bytes.len())
}

fn run_tracked_local_command(
    task_key: &str,
    command: &mut Command,
    limits: LocalCommandLimits,
) -> std::io::Result<std::process::Output> {
    if local_start_cancelled(task_key) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "local start was cancelled",
        ));
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    if let Err(error) = set_local_start_pid(task_key, Some(pid)) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let stdout_reader = child
        .stdout
        .take()
        .map(|reader| capture_local_command_output(reader, Arc::clone(&stdout)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|reader| capture_local_command_output(reader, Arc::clone(&stderr)));
    let started = Instant::now();
    let mut last_activity = started;
    let mut output_len = 0;
    let stopped = loop {
        if local_start_cancelled(task_key) {
            break Some(std::io::ErrorKind::Interrupted);
        }
        if child.try_wait()?.is_some() {
            break None;
        }
        let next_output_len = local_command_output_len(&stdout, &stderr);
        if next_output_len != output_len {
            output_len = next_output_len;
            last_activity = Instant::now();
        }
        if started.elapsed() >= limits.total || last_activity.elapsed() >= limits.idle {
            break Some(std::io::ErrorKind::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    if stopped.is_some() {
        terminate_local_process_group(pid, false);
        for _ in 0..10 {
            if child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if child.try_wait()?.is_none() {
            terminate_local_process_group(pid, true);
            let _ = child.kill();
        }
    }
    let status = child.wait()?;
    let _ = set_local_start_pid(task_key, None);
    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    if let Some(kind) = stopped {
        let message = if kind == std::io::ErrorKind::TimedOut {
            "docker command stopped after making no progress"
        } else {
            "local start was cancelled"
        };
        return Err(std::io::Error::new(kind, message));
    }
    let stdout = stdout
        .lock()
        .map_or_else(|_| Vec::new(), |bytes| bytes.clone());
    let stderr = stderr
        .lock()
        .map_or_else(|_| Vec::new(), |bytes| bytes.clone());
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn local_command_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::TimedOut => {
            "AD-LOC-117：Docker 下载或构建长时间没有进展，已自动停止；请检查 Docker 网络后重试"
                .to_string()
        }
        std::io::ErrorKind::Interrupted => {
            "AD-LOC-118：本次启动已停止，已经运行的其他服务不会受影响".to_string()
        }
        _ => format!("AD-LOC-106：无法启动 Docker：{}", public_error(error)),
    }
}

struct LocalBuildResult {
    output: std::process::Output,
    clear_proxy: bool,
    switched_mode: bool,
}

fn preferred_local_build_clear_proxy(state: &WorkspaceState) -> bool {
    state
        .setting("local.build.clear-proxy")
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

fn remember_local_build_proxy_mode(state: &WorkspaceState, result: &LocalBuildResult) {
    if result.switched_mode
        && (result.output.status.success()
            || !looks_like_dependency_network_failure(&result.output))
    {
        let _ = state.set_setting(
            "local.build.clear-proxy",
            if result.clear_proxy { "true" } else { "false" },
        );
    }
}

fn local_build_proxy_attempts(preferred_clear_proxy: bool) -> [bool; 2] {
    [preferred_clear_proxy, !preferred_clear_proxy]
}

fn run_local_compose_build_with_recovery(
    root: &Path,
    compose_path: &Path,
    task_key: &str,
    preferred_clear_proxy: bool,
    with_dependencies: bool,
    services: &[String],
    use_public_generated_images: bool,
) -> std::io::Result<LocalBuildResult> {
    run_local_build_with_recovery(preferred_clear_proxy, |clear_proxy| {
        run_local_compose_build(
            root,
            compose_path,
            task_key,
            clear_proxy,
            with_dependencies,
            services,
            use_public_generated_images,
        )
    })
}

fn run_local_build_with_recovery(
    preferred_clear_proxy: bool,
    mut attempt: impl FnMut(bool) -> std::io::Result<std::process::Output>,
) -> std::io::Result<LocalBuildResult> {
    let [initial_mode, fallback_mode] = local_build_proxy_attempts(preferred_clear_proxy);
    let initial = attempt(initial_mode)?;
    if initial.status.success() || !looks_like_dependency_network_failure(&initial) {
        return Ok(LocalBuildResult {
            output: initial,
            clear_proxy: initial_mode,
            switched_mode: false,
        });
    }
    let fallback = attempt(fallback_mode)?;
    Ok(LocalBuildResult {
        output: fallback,
        clear_proxy: fallback_mode,
        switched_mode: true,
    })
}

fn run_local_compose_build(
    root: &Path,
    compose_path: &Path,
    task_key: &str,
    clear_proxy: bool,
    with_dependencies: bool,
    services: &[String],
    use_public_generated_images: bool,
) -> std::io::Result<std::process::Output> {
    let mut command = system_command("docker");
    if use_public_generated_images {
        configure_public_docker_access(&mut command);
    }
    command
        .current_dir(root)
        .args(["compose", "-f"])
        .arg(compose_path)
        .arg("build");
    if with_dependencies {
        command.arg("--with-dependencies");
    }
    if clear_proxy {
        command.args([
            "--build-arg",
            "HTTP_PROXY=",
            "--build-arg",
            "HTTPS_PROXY=",
            "--build-arg",
            "http_proxy=",
            "--build-arg",
            "https_proxy=",
        ]);
    }
    command.args(services);
    run_tracked_local_command(task_key, &mut command, local_build_command_limits())
}

fn services_use_public_generated_dockerfiles(
    manifest: &ProjectManifest,
    services: &[String],
) -> bool {
    !services.is_empty()
        && services.iter().all(|service_id| {
            manifest.services.iter().any(|service| {
                service.id == *service_id
                    && service
                        .dockerfile
                        .starts_with(".deploydesk/generated/build/Dockerfile.")
            })
        })
}

fn configure_public_docker_access(command: &mut Command) {
    let Some(host) = local_docker_engine_host() else {
        return;
    };
    let plugin_dirs = public_docker_cli_plugin_dirs();
    if plugin_dirs.is_empty() {
        return;
    }
    let config_dir =
        std::env::temp_dir().join(format!("abcdeploy-public-docker-{}", std::process::id()));
    let config = serde_json::json!({ "cliPluginsExtraDirs": plugin_dirs });
    if fs::create_dir_all(&config_dir).is_err()
        || fs::write(
            config_dir.join("config.json"),
            config.to_string().as_bytes(),
        )
        .is_err()
    {
        return;
    }
    command
        .env("DOCKER_CONFIG", config_dir)
        .env("DOCKER_HOST", host);
}

fn public_docker_cli_plugin_dirs() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(config_dir) = std::env::var_os("DOCKER_CONFIG") {
        candidates.push(PathBuf::from(config_dir).join("cli-plugins"));
    } else if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        candidates.push(PathBuf::from(home).join(".docker/cli-plugins"));
    }
    candidates.extend([
        PathBuf::from("/Applications/Docker.app/Contents/Resources/cli-plugins"),
        PathBuf::from("/usr/local/lib/docker/cli-plugins"),
        PathBuf::from("/usr/local/libexec/docker/cli-plugins"),
        PathBuf::from("/usr/lib/docker/cli-plugins"),
    ]);
    candidates
        .into_iter()
        .filter(|path| path.is_dir())
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn local_docker_engine_host() -> Option<String> {
    let output = system_command("docker")
        .args([
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let host = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (host.starts_with("unix://") || host.starts_with("npipe://")).then_some(host)
}

fn compose_output_text(output: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn looks_like_dependency_network_failure(output: &std::process::Output) -> bool {
    looks_like_dependency_network_text(&compose_output_text(output))
}

fn looks_like_dependency_network_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "econnrefused",
        "econnreset",
        "enotfound",
        "etimedout",
        "connection refused",
        "performing the request",
        "network timeout",
        "network is unreachable",
        "temporary failure in name resolution",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn local_build_failure(output: &std::process::Output) -> String {
    let details = compose_output_text(output);
    let lower = details.to_ascii_lowercase();
    if looks_like_dependency_network_text(&details) {
        "AD-LOC-110：项目依赖下载失败，已自动切换下载方式重试；请检查网络后再试".to_string()
    } else if lower.contains("dockerfile")
        && (lower.contains("no such file") || lower.contains("failed to read"))
    {
        "AD-LOC-111：有服务缺少可用的 Dockerfile，请返回运行方案确认构建方式".to_string()
    } else {
        format!("AD-LOC-112：{}", local_build_failure_summary(&details))
    }
}

fn local_build_failure_summary(details: &str) -> String {
    let service = failed_local_build_target(details).map_or_else(
        || "项目服务".to_string(),
        |target| local_build_target_label(&target),
    );
    let mut typescript_issues = BTreeSet::new();
    let mut missing_modules = BTreeSet::new();

    for line in details.lines() {
        if let Some(error_at) = line.find("error TS") {
            let prefix = &line[..error_at];
            let signature_at = ["apps/", "packages/", "src/"]
                .iter()
                .filter_map(|marker| prefix.rfind(marker))
                .max()
                .unwrap_or(error_at);
            typescript_issues.insert(line[signature_at..].trim().to_string());
        }
        if let Some(module) = quoted_value_after(line, "Cannot find module '")
            && module.len() <= 120
            && module
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "@/_-.".contains(character))
        {
            missing_modules.insert(module.to_string());
        }
    }

    if !typescript_issues.is_empty() {
        let issue_count = typescript_issues.len();
        if !missing_modules.is_empty() {
            let modules = missing_modules.into_iter().collect::<Vec<_>>().join("、");
            return format!(
                "{service}没有构建成功：发现 {issue_count} 个 TypeScript 编译问题，其中缺少项目模块 {modules}"
            );
        }
        return format!("{service}没有构建成功：发现 {issue_count} 个 TypeScript 编译问题");
    }

    if !missing_modules.is_empty() {
        let modules = missing_modules.into_iter().collect::<Vec<_>>().join("、");
        return format!("{service}没有构建成功：缺少项目模块 {modules}");
    }

    format!("{service}没有通过代码构建")
}

fn failed_local_build_target(details: &str) -> Option<String> {
    details.lines().rev().find_map(|line| {
        let marker_at = line.find("target ")? + "target ".len();
        let target = line[marker_at..].split(':').next()?.trim();
        (!target.is_empty()
            && target.len() <= 80
            && target
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character)))
        .then(|| target.to_string())
    })
}

fn local_build_target_label(target: &str) -> String {
    let lower = target.to_ascii_lowercase();
    if lower == "api" || lower.contains("backend") || lower.contains("server") {
        format!("后端服务（{target}）")
    } else if lower.contains("web")
        || lower.contains("front")
        || lower.contains("h5")
        || lower.contains("miniapp")
    {
        format!("网页服务（{target}）")
    } else if lower.contains("worker") || lower.contains("job") {
        format!("后台任务（{target}）")
    } else {
        format!("服务 {target}")
    }
}

fn quoted_value_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let start = line.find(marker)? + marker.len();
    let value = &line[start..];
    let end = value.find('\'')?;
    Some(&value[..end])
}

fn local_start_failure(output: &std::process::Output) -> String {
    let details = compose_output_text(output).to_ascii_lowercase();
    if details.contains("port is already allocated") || details.contains("address already in use") {
        "AD-LOC-116：项目要使用的本机端口已经被其他程序占用，关闭占用程序后再启动".to_string()
    } else {
        "AD-LOC-113：容器已经构建，但服务没有全部通过运行检查".to_string()
    }
}

fn ensure_local_service_ports_available(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &ProjectManifest,
    requested_services: &[String],
) -> Result<(), String> {
    let current = local_preview_status(root, inspection, manifest, Vec::new());
    for (index, service) in manifest.services.iter().enumerate() {
        if (!requested_services.is_empty() && !requested_services.contains(&service.id))
            || service.kind == ServiceKind::Worker
            || current
                .services
                .iter()
                .any(|candidate| candidate.id == service.id && candidate.running)
        {
            continue;
        }
        let port = deploy_core::render::local_service_host_port(service, index);
        let port_number =
            u16::try_from(port).map_err(|_| format!("AD-LOC-116：本机端口 {port} 超出可用范围"))?;
        if TcpListener::bind(("127.0.0.1", port_number)).is_err() {
            if let Some(owner) = managed_local_port_owner(port_number) {
                return Err(format!(
                    "AD-LOC-120：项目 {} 正在使用本项目需要的 {port} 端口",
                    owner.project
                ));
            }
            return Err(format!(
                "AD-LOC-116：本机端口 {port} 已被其他程序占用，关闭占用程序后再启动"
            ));
        }
    }
    Ok(())
}

fn managed_local_port_owner(port: u16) -> Option<ManagedLocalPortOwner> {
    let filter = format!("publish={port}");
    let format = concat!(
        "{{.ID}}\t",
        "{{.Label \"deploydesk.project\"}}\t",
        "{{.Label \"deploydesk.environment\"}}"
    );
    let output = system_command("docker")
        .args(["ps", "--filter", &filter, "--format", format])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_managed_local_port_owner(&String::from_utf8_lossy(&output.stdout))
}

fn parse_managed_local_port_owner(value: &str) -> Option<ManagedLocalPortOwner> {
    value.lines().find_map(|line| {
        let mut fields = line.splitn(3, '\t');
        let container_id = fields.next()?.trim();
        let project = fields.next()?.trim();
        let environment = fields.next()?.trim();
        if environment != "development"
            || !(6..=64).contains(&container_id.len())
            || !container_id
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            || project.is_empty()
            || project.chars().any(char::is_control)
        {
            return None;
        }
        Some(ManagedLocalPortOwner {
            container_id: container_id.to_string(),
            project: project.chars().take(80).collect(),
        })
    })
}

fn local_preview_status(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &deploy_core::ProjectManifest,
    written_files: Vec<String>,
) -> LocalPreviewStatus {
    let compose_path = local_compose_path(root);
    let running_services = if compose_path.is_file() {
        system_command("docker")
            .current_dir(root)
            .args(["compose", "-f"])
            .arg(&compose_path)
            .args(["ps", "--services", "--filter", "status=running"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
    } else {
        Some(Vec::new())
    };
    let services = manifest
        .services
        .iter()
        .enumerate()
        .map(|(index, service)| {
            let detected = inspection
                .services
                .iter()
                .find(|candidate| candidate.id == service.id);
            let host_port = (service.kind != deploy_core::ServiceKind::Worker)
                .then(|| deploy_core::render::local_service_host_port(service, index));
            let build_strategy = if detected.and_then(|item| item.dockerfile.as_ref()).is_some() {
                "existing"
            } else if service
                .dockerfile
                .starts_with(".deploydesk/generated/build/Dockerfile.")
                && root.join(&service.dockerfile).is_file()
            {
                "generated"
            } else {
                "needs_input"
            };
            LocalPreviewService {
                id: service.id.clone(),
                kind: match &service.kind {
                    deploy_core::ServiceKind::Api => "api",
                    deploy_core::ServiceKind::Web => "web",
                    deploy_core::ServiceKind::Worker => "worker",
                    deploy_core::ServiceKind::Static => "static",
                }
                .to_string(),
                build_strategy: build_strategy.to_string(),
                dockerfile: service.dockerfile.clone(),
                host_port,
                url: host_port.map(|port| format!("http://127.0.0.1:{port}")),
                running: running_services
                    .as_ref()
                    .is_some_and(|running| running.iter().any(|id| id == &service.id)),
            }
        })
        .collect::<Vec<_>>();
    let running_count = services.iter().filter(|service| service.running).count();
    let (state, message) = if running_services.is_none() {
        (
            "unavailable",
            "Docker 当前不可用，启动 Docker Desktop 后可以继续",
        )
    } else if running_count == services.len() && !services.is_empty() {
        ("running", "本地容器均已通过运行检查")
    } else if running_count > 0 {
        ("partial", "部分本地服务仍在启动或需要处理")
    } else if compose_path.is_file() {
        ("stopped", "本地容器预览尚未启动")
    } else {
        ("not_prepared", "本地容器方案尚未生成")
    };
    LocalPreviewStatus {
        state: state.to_string(),
        message: message.to_string(),
        compose_path: compose_path.to_string_lossy().into_owned(),
        env_ready: root.join(".env").is_file(),
        services,
        written_files,
    }
}

fn runnable_local_service_ids(status: &LocalPreviewStatus) -> Vec<String> {
    status
        .services
        .iter()
        .filter(|service| service.build_strategy != "needs_input")
        .map(|service| service.id.clone())
        .collect()
}

fn planned_local_preview_status(
    root: &Path,
    inspection: &InspectionReport,
    manifest: &deploy_core::ProjectManifest,
    plan: &DeploymentPlan,
    written_files: Vec<String>,
) -> LocalPreviewStatus {
    let mut status = local_preview_status(root, inspection, manifest, written_files);
    let blocked_services = plan
        .blockers
        .iter()
        .filter(|blocker| blocker.code == "AD-CTR-101")
        .filter_map(|blocker| blocker.service.clone())
        .collect::<BTreeSet<_>>();
    apply_planned_local_build_strategies(&mut status, &blocked_services);
    status
}

fn apply_planned_local_build_strategies(
    status: &mut LocalPreviewStatus,
    blocked_services: &BTreeSet<String>,
) {
    for service in &mut status.services {
        if service.build_strategy == "needs_input" && !blocked_services.contains(&service.id) {
            service.build_strategy = "generated".to_string();
        }
    }
}

fn ensure_local_env_ignored(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    let already_ignored = content
        .lines()
        .any(|line| matches!(line.trim(), ".env" | "/.env" | ".env*" | ".env.*" | "*.env"));
    if already_ignored {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n# ABCDeploy 本地运行配置\n.env\n");
    fs::write(path, content).map_err(public_error)
}

fn validate_repository_slug(value: &str) -> Result<(), String> {
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() < 2
        || segments
            .iter()
            .any(|segment| !valid_repository_segment(segment))
    {
        return Err("CNB 密钥仓库应填写为 所属组织/仓库名".to_string());
    }
    Ok(())
}

fn valid_cnb_namespace(value: &str) -> bool {
    let segments = value.split('/').collect::<Vec<_>>();
    !segments.is_empty()
        && segments.len() <= 20
        && segments
            .iter()
            .all(|segment| valid_repository_segment(segment))
}

fn valid_repository_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn write_keyring_secret(key: &str, value: &str) -> Result<(), String> {
    validate_secret_key(key)?;
    if value.is_empty() {
        return Err("密钥不能为空".to_string());
    }
    Entry::new(KEYRING_SERVICE, key)
        .map_err(public_error)?
        .set_password(value)
        .map_err(public_error)?;
    cache_secret(key, value);
    Ok(())
}

fn delete_keyring_secret(key: &str) -> Result<(), String> {
    validate_secret_key(key)?;
    evict_cached_secret(key);
    for service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
        let entry = Entry::new(service, key).map_err(public_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(public_error(error)),
        }
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn validate_git_branch(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with(['-', '/', '.'])
        || value.ends_with(['/', '.'])
        || value.contains("..")
        || value.contains("//")
        || value.contains("@{")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        return Err("发布分支名称格式不正确".to_string());
    }
    Ok(())
}

fn deployment_owned_paths(root: &Path) -> Vec<String> {
    [
        "deploy.yaml",
        ".cnb.yml",
        ".cnb/tag_deploy.yml",
        ".github/workflows/sync-cnb.yml",
        ".dockerignore",
        ".deploydesk/.gitignore",
        ".deploydesk/generated",
    ]
    .into_iter()
    .filter(|path| root.join(path).exists())
    .map(ToString::to_string)
    .collect()
}

fn is_deployment_owned_path(path: &str) -> bool {
    matches!(
        path,
        "deploy.yaml"
            | ".cnb.yml"
            | ".cnb/tag_deploy.yml"
            | ".github/workflows/sync-cnb.yml"
            | ".dockerignore"
            | ".deploydesk/.gitignore"
    ) || path.starts_with(".deploydesk/generated/")
}

fn is_deployment_internal_path(path: &str) -> bool {
    [
        ".deploydesk/backups/",
        ".deploydesk/runtime/",
        ".deploydesk/state/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn status_path(line: &str) -> Option<&str> {
    let path = line.get(3..)?.trim();
    path.rsplit_once(" -> ")
        .map_or(Some(path), |(_, destination)| Some(destination))
}

fn git_stdout(root: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = system_command("git")
        .current_dir(root)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| git_launch_error("读取 Git 项目", &error))?;
    if !output.status.success() {
        return Err(git_failure("读取 Git 项目", &output.stdout, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn repository_identity(value: &str) -> Option<String> {
    let value = value.lines().next()?.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let repository = if let Some(index) = lower.find("cnb.cool/") {
        &value[index + "cnb.cool/".len()..]
    } else if let Some(index) = lower.find("cnb.cool:") {
        &value[index + "cnb.cool:".len()..]
    } else if !value.contains("://") && !value.contains('@') && !value.contains(':') {
        value
    } else {
        return None;
    };
    let repository = repository
        .split(['?', '#'])
        .next()?
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or(repository.trim_matches('/'));
    let segments = repository.split('/').collect::<Vec<_>>();
    if segments.len() < 2
        || repository.contains("replace-me")
        || repository.starts_with("owner/")
        || !segments
            .iter()
            .all(|segment| valid_repository_segment(segment))
    {
        return None;
    }
    Some(repository.to_string())
}

fn git_stdout_with_authorization(
    root: &Path,
    arguments: &[&str],
    authorization: &str,
    action: &str,
) -> Result<String, String> {
    let output = system_command("git")
        .current_dir(root)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://cnb.cool/.extraHeader")
        .env("GIT_CONFIG_VALUE_0", authorization)
        .env_remove("GIT_TRACE")
        .env_remove("GIT_TRACE_CURL")
        .output()
        .map_err(|error| git_launch_error(action, &error))?;
    if !output.status.success() {
        return Err(git_failure(action, &output.stdout, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_git_command(mut command: Command, action: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| git_launch_error(action, &error))?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_failure(action, &output.stdout, &output.stderr))
}

fn git_launch_error(action: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "当前电脑未安装 Git，请先通过编程工具安装 Git 后重试".to_string()
    } else {
        format!("{action}无法启动：{error}")
    }
}

fn git_failure(action: &str, stdout: &[u8], stderr: &[u8]) -> String {
    let message = redact_text(&format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    ));
    let normalized = message.to_ascii_lowercase();
    if action == "同步代码到 CNB"
        && (normalized.contains("non-fast-forward")
            || normalized.contains("fetch first")
            || normalized.contains("[rejected]"))
    {
        return "AD-GIT-102：CNB 部署分支已有更新，当前代码不能安全覆盖；请先同步分支后重试"
            .to_string();
    }
    let summary = message
        .lines()
        .find(|line| {
            let line = line.trim_start().to_ascii_lowercase();
            line.starts_with("fatal:")
                || line.starts_with("error:")
                || line.contains("[rejected]")
                || line.contains("permission denied")
        })
        .or_else(|| {
            message.lines().find(|line| {
                let line = line.trim();
                !line.is_empty() && !line.to_ascii_lowercase().starts_with("to ")
            })
        })
        .unwrap_or("Git 返回未知错误");
    format!("{action}未完成：{}", summary.trim())
}

fn read_keyring_secret(key: &str) -> Result<String, String> {
    validate_secret_key(key)?;
    if let Some(value) = cached_secret(key) {
        return Ok(value);
    }

    let current = Entry::new(KEYRING_SERVICE, key).map_err(public_error)?;
    match current.get_password() {
        Ok(value) => {
            cache_secret(key, &value);
            return Ok(value);
        }
        Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(public_error(error)),
    }

    let legacy = Entry::new(LEGACY_KEYRING_SERVICE, key).map_err(public_error)?;
    match legacy.get_password() {
        Ok(mut value) => {
            current.set_password(&value).map_err(public_error)?;
            cache_secret(key, &value);
            let migrated = value.clone();
            value.zeroize();
            Ok(migrated)
        }
        Err(keyring::Error::NoEntry) => Err("missing".to_string()),
        Err(error) => Err(public_error(error)),
    }
}

#[cfg(target_os = "macos")]
fn read_keyring_secret_without_prompt(key: &str) -> Result<String, String> {
    use security_framework::os::macos::keychain::SecKeychain;

    static KEYCHAIN_INTERACTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _operation = KEYCHAIN_INTERACTION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "无法安全读取本机钥匙串".to_string())?;
    let _interaction = SecKeychain::disable_user_interaction().map_err(public_error)?;
    read_keyring_secret(key)
}

#[cfg(not(target_os = "macos"))]
fn read_keyring_secret_without_prompt(key: &str) -> Result<String, String> {
    read_keyring_secret(key)
}

fn secret_cache() -> &'static Mutex<BTreeMap<String, Zeroizing<String>>> {
    SECRET_CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn cached_secret(key: &str) -> Option<String> {
    secret_cache()
        .lock()
        .ok()?
        .get(key)
        .map(|value| value.as_str().to_owned())
}

fn cache_secret(key: &str, value: &str) {
    if let Ok(mut cache) = secret_cache().lock() {
        cache.insert(key.to_string(), Zeroizing::new(value.to_string()));
    }
}

fn evict_cached_secret(key: &str) {
    if let Ok(mut cache) = secret_cache().lock() {
        cache.remove(key);
    }
}

fn validate_secret_key(key: &str) -> Result<(), String> {
    if !(2..=80).contains(&key.len())
        || !key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("密钥标识格式不正确".to_string());
    }
    Ok(())
}

fn public_error(error: impl std::fmt::Display) -> String {
    redact_text(&error.to_string())
}

fn cnb_public_error(error: DeployError) -> String {
    if let DeployError::CnbApi {
        status: 403,
        message,
    } = &error
    {
        let scopes = missing_permission_scopes(message);
        if scopes.len() == 1 && scopes[0] == "repo-cnb-history:r" {
            return "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）".to_string();
        }
        if scopes.len() == 1 && scopes[0] == "repo-cnb-trigger:rw" {
            return "AD-CNB-103：CNB 授权缺少“触发构建”权限（repo-cnb-trigger:rw）".to_string();
        }
        if !scopes.is_empty() {
            return format!("AD-CNB-103：CNB 授权缺少以下权限：{}", scopes.join("、"));
        }
    }

    let (code, message) = match error {
        DeployError::MissingCredential(_) | DeployError::CnbApi { status: 401, .. } => {
            ("AD-CNB-101", "CNB 登录状态已失效，请返回连接步骤重新授权")
        }
        DeployError::Http(error) if error.status().is_some_and(|status| status.as_u16() == 429) => {
            ("AD-CNB-107", "CNB 请求过于频繁，请稍后重新尝试")
        }
        DeployError::Http(_) => ("AD-CNB-102", "暂时无法连接 CNB，请检查网络后重试"),
        DeployError::CnbApi { status: 403, .. } => (
            "AD-CNB-103",
            "CNB 拒绝当前操作；令牌的授权范围或使用范围可能不适用于当前资源，请检查授权设置",
        ),
        DeployError::CnbApi { status: 404, .. } => {
            ("AD-CNB-104", "CNB 中找不到所选组织或仓库，请重新选择组织")
        }
        DeployError::CnbApi {
            status: 400 | 422, ..
        }
        | DeployError::InvalidManifest(_) => {
            ("AD-CNB-105", "CNB 拒绝了当前组织或仓库配置，请检查名称")
        }
        DeployError::CnbApi { status: 409, .. } => {
            ("AD-CNB-106", "CNB 已存在同名资源，但当前账号无法正常读取")
        }
        DeployError::CnbApi { status: 429, .. } => {
            ("AD-CNB-107", "CNB 请求过于频繁，请稍后重新尝试")
        }
        DeployError::CnbApi { status, .. } if status >= 500 => {
            ("AD-CNB-102", "CNB 服务暂时不可用，请稍后重试")
        }
        _ => ("AD-CNB-199", "CNB 服务请求没有完成，请稍后重试"),
    };
    format!("{code}：{message}")
}

fn cnb_build_history_error(error: DeployError) -> String {
    match error {
        DeployError::CnbApi {
            status: 403,
            message,
        } if message.contains("repo-cnb-history:r") => {
            "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）".to_string()
        }
        DeployError::CnbApi { status: 403, .. } => {
            "AD-CNB-103：CNB 拒绝读取这个仓库的构建记录；令牌的授权范围（scope）或使用范围可能不匹配当前仓库，请检查 CNB 授权设置"
                .to_string()
        }
        other => cnb_public_error(other),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotDeploymentEvidence {
    project: String,
    deployment_path_id: String,
    task_id: String,
    status: String,
    build_serial: Option<String>,
    commit_sha: Option<String>,
    artifacts: Vec<DeploymentArtifact>,
    public_urls: Vec<String>,
}

/// Runs the same path engine as the desktop UI for a real-project acceptance
/// pilot. This intentionally lives behind a hidden binary argument: it is a
/// local QA entry point, not a second deployment implementation or a user
/// workflow. Output contains only immutable identifiers and public URLs.
pub fn run_pilot_validation_cli(project_path: &str) -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位当前用户目录".to_string())?;
    let database = home
        .join("Library")
        .join("Application Support")
        .join("cloud.finagent.abcdeploy")
        .join("workspace.sqlite3");
    let state = WorkspaceState::open(&database)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(public_error)?;
    let evidence = runtime.block_on(run_pilot_validation(PathBuf::from(project_path), &state))?;
    let output = serde_json::to_string_pretty(&evidence).map_err(public_error)?;
    println!("{output}");
    Ok(())
}

async fn run_pilot_validation(
    root: PathBuf,
    state: &WorkspaceState,
) -> Result<PilotDeploymentEvidence, String> {
    let root = root.canonicalize().map_err(public_error)?;
    if !root.join(MANIFEST_FILE).is_file() {
        return Err("试点项目缺少 deploy.yaml".to_string());
    }
    reconcile_compat_connections(state)?;
    open_project_preview(root.clone(), state)?;
    if state.project_adoption(&root)?.mode == "pending" {
        state.continue_existing_deployment(&root)?;
    }

    let inspection = inspect_project(&root).map_err(public_error)?;
    let mut manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    reconcile_detected_services(&inspection, &mut manifest);
    let (namespace, repository_name) = manifest
        .providers
        .build
        .repository
        .split_once('/')
        .ok_or_else(|| "构建仓库格式不正确".to_string())?;
    let setup = ensure_cnb_repository(namespace.to_string(), repository_name.to_string()).await?;
    manifest
        .providers
        .build
        .repository
        .clone_from(&setup.repository);
    if manifest.source.repository.starts_with("owner/")
        || manifest.source.repository.contains("replace-me")
    {
        manifest.source.repository.clone_from(&setup.repository);
    }
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("试点项目的部署配置没有通过校验".to_string());
    }
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    apply_plan(&root, &plan).map_err(public_error)?;
    state.mark_project_fresh_draft_saved(&root)?;
    state.set_project_step(&root, "workspace")?;

    // The pilot must exercise the same line that the user sees in the UI.
    // Creating a hidden parallel line would let it take over the same public
    // host while the visible line still reported an older version as online.
    let existing = state
        .list_deployment_paths(&root)?
        .into_iter()
        .find(|path| path.name == "上线")
        .or_else(|| state.list_deployment_paths(&root).ok()?.into_iter().next())
        .ok_or_else(|| "请先在客户端创建并配置一条可见的上线线路".to_string())?;
    if existing.routes.is_empty() {
        return Err("请先在线路的运行服务器节点设置访问地址".to_string());
    }
    let source_id = existing
        .source_connection_id
        .as_deref()
        .ok_or_else(|| "请先在线路中选择构建服务".to_string())?;
    let source = state.connection_by_id(source_id)?;
    if source.kind != "source" || source.provider != "cnb" || source.status != "ready" {
        return Err("线路当前选择的构建服务尚未验证".to_string());
    }
    let registry_id = existing
        .registry_connection_id
        .as_deref()
        .ok_or_else(|| "请先在线路中选择版本仓库".to_string())?;
    let registry = state.connection_by_id(registry_id)?;
    if registry.kind != "registry" || registry.status != "ready" {
        return Err("线路当前选择的版本仓库尚未验证".to_string());
    }
    let server_id = existing
        .server_id
        .as_deref()
        .ok_or_else(|| "请先在线路中选择运行服务器".to_string())?;
    let server = state.server_by_id(server_id)?;
    if !server.key_path_exists || server.host_fingerprint.is_none() {
        return Err("线路当前选择的运行服务器尚未验证".to_string());
    }
    let path = state.save_deployment_path(DeploymentPathInput {
        id: Some(existing.id.clone()),
        project_path: root.to_string_lossy().into_owned(),
        name: existing.name.clone(),
        source_connection_id: Some(source.id),
        registry_connection_id: Some(registry.id),
        server_id: Some(server.id),
        config_profile_ids: existing.config_profile_ids.clone(),
        address: existing.address.clone(),
        routes: existing.routes.clone(),
        state: Some("ready".to_string()),
        last_run_id: existing.last_run_id.clone(),
        last_successful_revision: existing.last_successful_revision,
    })?;
    seed_pilot_runtime_config(&root, &path.id)?;

    let profile = verified_deployment_path_profile(&path, state).await?;
    let caddy_check = caddy::bootstrap_server(&profile, true)
        .await
        .map_err(public_error)?;
    if !caddy_check.ok {
        return Err(caddy_check.summary);
    }
    state.remember_checked_server(&profile)?;

    // A repaired address resumes the same immutable task. This is the same
    // continuation rule as the visible UI: completed build/registry work is
    // retained, only the server node gets a fresh append-only attempt.
    if let Some(last_run_id) = path.last_run_id.as_deref()
        && let Ok(previous) = state.deployment_run(last_run_id)
        && matches!(previous.status.as_str(), "queued" | "running")
    {
        let run = await_pilot_deployment(&manifest.project.name, previous, state).await?;
        return Ok(pilot_evidence(manifest.project.name, path.id, run));
    }
    if let Some(last_run_id) = path.last_run_id.as_deref()
        && let Ok(previous) = state.deployment_run(last_run_id)
        && previous.status == "needs_action"
        && !previous.artifacts.is_empty()
        && pilot_can_resume_existing_artifacts(&previous)
    {
        let prepared =
            prepare_deployment_path_retry_inner(previous.id, "server".to_string(), state)?;
        // The visible “继续上线” button invokes refresh after a repaired node
        // has been selected. The pilot must exercise that exact continuation
        // boundary as well instead of treating the prepared needs-action
        // record as a terminal error.
        let run = refresh_deployment_path(prepared, state).await?;
        let run = await_pilot_deployment(&manifest.project.name, run, state).await?;
        return Ok(pilot_evidence(manifest.project.name, path.id, run));
    }

    let task = create_deployment_task_inner(
        root.to_string_lossy().into_owned(),
        "deployment".to_string(),
        None,
        Some(path.id.clone()),
        state,
    )?;
    state.begin_deployment_attempt(&task.id)?;
    let source = sync_project_to_cnb_inner(
        root.to_string_lossy().into_owned(),
        manifest.providers.build.repository.clone(),
        manifest.source.release_branch.clone(),
        true,
        Some(task.id.clone()),
        state,
    )?;
    let run = start_deployment_path_inner(
        root.to_string_lossy().into_owned(),
        source.commit_sha,
        task.id,
        state,
    )
    .await?;
    let run = await_pilot_deployment(&manifest.project.name, run, state).await?;
    Ok(pilot_evidence(manifest.project.name, path.id, run))
}

fn pilot_can_resume_existing_artifacts(run: &DeploymentRun) -> bool {
    let unhealthy_container =
        run.message.contains("container ") && run.message.contains(" is unhealthy");
    let artifact_failure = run.issue_code.as_deref().is_some_and(|code| {
        ["AD-BLD-", "AD-PKG-", "AD-IMG-", "AD-CTR-"]
            .iter()
            .any(|prefix| code.starts_with(prefix))
    });
    !unhealthy_container && !artifact_failure
}

async fn await_pilot_deployment(
    project_name: &str,
    mut run: DeploymentRun,
    state: &WorkspaceState,
) -> Result<DeploymentRun, String> {
    let started = Instant::now();
    let mut retries = 0_u8;
    let mut last_progress = String::new();
    loop {
        let progress = format!("{}:{}", run.status, run.current_stage);
        if progress != last_progress {
            eprintln!("ABCDeploy pilot {project_name} {progress}");
            last_progress = progress;
        }
        match run.status.as_str() {
            "success" => break,
            "needs_action"
                if run.action_kind.as_deref() == Some("deployment-path-route-takeover") =>
            {
                run = take_over_deployment_path_routes_inner(run.id, true, state).await?;
                continue;
            }
            "needs_action" if run.action_kind.as_deref() == Some("deployment-path-route-check") => {
                if retries >= 12 {
                    return Err(run.message);
                }
                retries += 1;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            "failed" | "cancelled" | "needs_action" => return Err(run.message),
            "queued" | "running" => {
                tokio::time::sleep(Duration::from_secs(8)).await;
            }
            _ => return Err("上线任务返回了无法识别的状态".to_string()),
        }
        if started.elapsed() > Duration::from_mins(90) {
            return Err("试点上线超过 90 分钟，已停止本次验收".to_string());
        }
        run = refresh_deployment_path(run, state).await?;
    }
    Ok(run)
}

fn pilot_evidence(
    project: String,
    deployment_path_id: String,
    run: DeploymentRun,
) -> PilotDeploymentEvidence {
    PilotDeploymentEvidence {
        project,
        deployment_path_id,
        task_id: run.id,
        status: run.status,
        build_serial: run.build_serial,
        commit_sha: run.commit_sha,
        artifacts: run.artifacts,
        public_urls: run
            .route_checks
            .into_iter()
            .filter(|check| check.reachable)
            .map(|check| check.url)
            .collect(),
    }
}

fn seed_pilot_runtime_config(root: &Path, path_id: &str) -> Result<(), String> {
    let target_key = runtime_config_key(root, path_id)?;
    let mut content = match read_keyring_secret(&target_key) {
        Ok(value) if !value.trim().is_empty() => Zeroizing::new(value),
        Ok(mut value) => {
            value.zeroize();
            Zeroizing::new(String::new())
        }
        Err(error) if error == "missing" => Zeroizing::new(String::new()),
        Err(error) => return Err(error),
    };
    if content.trim().is_empty() {
        for scope in ["production", "staging", "development"] {
            let key = runtime_config_key(root, scope)?;
            if let Ok(mut value) = read_keyring_secret(&key)
                && !value.trim().is_empty()
            {
                *content = remote_runtime_content(&value, &BTreeSet::new(), false);
                value.zeroize();
                break;
            }
        }
    }
    if content.trim().is_empty() {
        for filename in [".env.production", ".env.staging", ".env"] {
            let path = root.join(filename);
            if let Ok(mut value) = fs::read_to_string(path)
                && !value.trim().is_empty()
            {
                *content = remote_runtime_content(&value, &BTreeSet::new(), false);
                value.zeroize();
                break;
            }
        }
    }

    if !content.trim().is_empty() {
        write_keyring_secret(&target_key, &content)?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
            #[cfg(target_os = "macos")]
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            let state = WorkspaceState::open(&data_directory.join("workspace.sqlite3"))
                .map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_preflight,
            open_project,
            continue_existing_deployment,
            reset_project_deployment,
            relink_project,
            list_recent_projects,
            save_project_step,
            forget_project,
            list_servers,
            get_project_server,
            bind_project_server,
            get_app_setting,
            get_app_settings,
            set_app_setting,
            list_connections,
            get_project_connection_bindings,
            list_deployment_paths,
            list_deployment_path_runs,
            save_deployment_path,
            delete_deployment_path,
            redeploy_deployment_path_version,
            list_config_profiles,
            save_config_profile,
            delete_config_profile,
            bind_config_profile,
            list_config_profile_bindings,
            set_environment_config_bindings,
            recommend_runtime_config,
            write_local_env,
            get_local_infrastructure_status,
            prepare_local_infrastructure,
            set_local_infrastructure_service,
            prepare_local_preview,
            get_local_development_support,
            prepare_local_development,
            start_local_preview,
            start_local_preview_service,
            cancel_local_preview_start,
            stop_managed_local_port_owner,
            get_local_preview_status,
            stop_local_preview,
            stop_local_preview_service,
            create_deployment_task,
            begin_deployment_attempt,
            list_deployment_attempts,
            pause_deployment_task,
            prepare_deployment_path_retry,
            start_staging_deployment,
            start_deployment_path,
            resume_staging_deployment,
            promote_production_deployment,
            refresh_deployment,
            check_deployment_routes,
            retry_deployment_certificates,
            open_staging_preview_tunnel,
            list_deployment_runs,
            list_project_environments,
            list_project_versions,
            list_version_validations,
            set_version_validation,
            list_active_deployment_runs,
            list_attention_deployment_runs,
            list_recent_successful_deployment_runs,
            sync_external_deployments,
            preview_manifest,
            apply_manifest,
            save_manifest_draft,
            check_docker,
            discover_ssh_identities,
            generate_ssh_identity,
            check_server,
            install_server_key_with_password,
            bootstrap_server_caddy,
            inspect_server_route_conflicts,
            take_over_server_routes,
            take_over_deployment_path_routes,
            reapply_deployment_routes,
            detect_dns_provider,
            prepare_pipeline_identity,
            runtime_secret_status,
            store_runtime_secret,
            generate_runtime_secret,
            load_runtime_config,
            load_existing_project_config,
            store_runtime_config,
            runtime_config_sync_status,
            sync_runtime_config_to_server,
            prepare_cnb_secret_bundle,
            rollback_environment,
            secret_status,
            store_secret,
            delete_secret,
            check_registry_credentials,
            replace_registry_credentials,
            check_saved_registry_credentials,
            connect_cnb,
            get_cnb_account,
            create_cnb_repository,
            ensure_cnb_repository,
            check_cnb_repository_access,
            check_cnb_secret_repository_access,
            enable_cnb_auto_trigger,
            sync_project_to_cnb,
        ])
        .build(tauri::generate_context!())
        .expect("ABCDeploy failed to build");

    app.run(|app_handle, event| {
        #[cfg(not(target_os = "macos"))]
        let _ = app_handle;
        if let tauri::RunEvent::Exit = &event {
            stop_preview_tunnels();
            stop_local_start_processes();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
            && let Some(window) = app_handle.get_webview_window("main")
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::{fmt::Write as _, fs, path::Path, process::Command};

    use base64::Engine as _;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        BASE64, CNB_ACCOUNT_CACHE_KEY, CNB_KEYCHAIN_UNAVAILABLE_ERROR, CnbBuildRecord,
        CnbTokenResolutionError, DeploymentArtifact, DeploymentPath, DeploymentRun,
        LocalPreviewService, LocalPreviewStatus, ProjectRelinkIdentity, REMOTE_DEPENDENCY_SCRIPT,
        RegistryConfig, ServerRouteProblem, ServerRouteProblemKind, StoredCnbToken, WorkspaceState,
        apply_container_log_diagnostic, apply_deployed_service_states,
        apply_planned_local_build_strategies, apply_public_route_checks,
        apply_runner_log_diagnostic, apply_server_route_problem, apply_server_route_problems,
        apply_server_route_takeover_problem, apply_version_title, build_environment_for_event,
        build_serial_for_revision, cache_secret, cached_cnb_account, cached_secret,
        caddy_certificate_reload_script, caddy_main_route_rewrite_shell_function,
        caddy_route_declared_shell_function, certificate_retry_allowed, cloud_setup_required,
        cnb_account_from_responses, cnb_build_history_error, cnb_keyring_issue, cnb_public_error,
        cnb_secret_filename, container_runtime_env, create_deployment_git_snapshot,
        deployment_manifest, deployment_needs_public_route_recheck, deployment_owned_paths,
        deployment_path_managed_runtime_variables, deployment_path_manifest,
        deployment_path_owns_history_reconciliation, deployment_routing_manifest,
        ensure_git_repository_for_sync, ensure_runtime_template_variables, evict_cached_secret,
        existing_cnb_repository, fill_empty_runtime_values, fill_managed_runtime_dependencies,
        git_failure, git_stdout, internal_runtime_secret, interrupted_public_route_status,
        interrupted_route_check_message, is_deployment_internal_path, is_deployment_owned_path,
        is_production_approval_build, latest_success_serials_by_environment,
        load_existing_project_config, local_build_failure_summary, local_build_proxy_attempts,
        local_database_name, local_git_title, local_infrastructure_compose, local_start_failure,
        looks_like_dependency_network_text, ordered_build_records, overlay_server_route_problems,
        parse_deployed_service_states, parse_deployment_artifacts, parse_local_container_readiness,
        parse_managed_local_port_owner, pause_deployment_path_after_deploy_error,
        pause_public_route_inspection, pilot_can_resume_existing_artifacts,
        prepare_deployment_path_retry_inner, provider_check_failure, readable_version_title,
        remember_cnb_account, remote_dependency_error, replace_managed_runtime_dependencies,
        repository_identity, required_runtime_variables, resolve_cnb_token_sources,
        rollback_script, run_git_command, run_local_build_with_recovery,
        runnable_local_service_ids, runtime_config_key, runtime_config_template, runtime_defaults,
        runtime_secret_key, safe_postgres_identifier, same_artifact_digests,
        save_cnb_connection_metadata_best_effort, serialize_manifest,
        server_route_activation_script, services_use_public_generated_dockerfiles,
        split_deployment_error, stage_deployment_owned_files, stage_key, system_command,
        update_run_from_cnb, url_encode_userinfo, valid_registry_host,
        validate_deployment_routing_manifest, validate_git_branch, validate_project_relink,
        validate_repository_slug, verify_public_routes, write_project_local_env,
    };
    use deploy_core::error::DeployError;
    use deploy_core::model::{EnvironmentName, PackageManager, ProviderCheck, PublicRouteStatus};

    fn run() -> DeploymentRun {
        DeploymentRun {
            id: "run-1".to_string(),
            project_path: "/tmp/sample".to_string(),
            project_name: "sample".to_string(),
            environment: "staging".to_string(),
            status: "running".to_string(),
            current_stage: "build".to_string(),
            build_serial: Some("42".to_string()),
            commit_sha: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            source_title: Some("让版本更容易识别".to_string()),
            source_run_id: None,
            candidate_tag: None,
            artifacts: Vec::new(),
            route_checks: Vec::new(),
            action_kind: None,
            action_url: None,
            issue_code: None,
            repository: "owner/sample".to_string(),
            branch: "main".to_string(),
            message: String::new(),
            completed_steps: vec!["write-config".to_string()],
            started_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn bulk_local_start_skips_services_without_a_reliable_build() {
        let service = |id: &str, build_strategy: &str| LocalPreviewService {
            id: id.to_string(),
            kind: "web".to_string(),
            build_strategy: build_strategy.to_string(),
            dockerfile: format!("Dockerfile.{id}"),
            host_port: Some(4300),
            url: None,
            running: false,
        };
        let status = LocalPreviewStatus {
            state: "stopped".to_string(),
            message: String::new(),
            compose_path: "/tmp/compose.yml".to_string(),
            env_ready: true,
            services: vec![
                service("api", "existing"),
                service("web", "generated"),
                service("toolbox", "needs_input"),
            ],
            written_files: Vec::new(),
        };

        assert_eq!(
            runnable_local_service_ids(&status),
            vec!["api".to_string(), "web".to_string()]
        );
    }

    #[test]
    fn unhealthy_image_requires_an_update_instead_of_redeploying_the_same_artifacts() {
        let mut deployment = run();
        deployment.artifacts.push(DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example/api".to_string(),
            digest: format!("sha256:{}", "a".repeat(64)),
        });
        pause_deployment_path_after_deploy_error(
            &mut deployment,
            "container sample-api-1 is unhealthy",
        );

        assert_eq!(deployment.issue_code.as_deref(), Some("AD-CTR-201"));
        assert_eq!(
            deployment.action_kind.as_deref(),
            Some("deployment-path-image-update")
        );
        assert!(!pilot_can_resume_existing_artifacts(&deployment));
    }

    #[test]
    fn remote_dependency_errors_prefer_the_stable_coded_line() {
        let stderr = "Unable to find image 'postgres:16-alpine' locally\n\
            request to registry-1.docker.io timed out\n\
            AD-INF-202：服务器暂时无法下载数据库运行组件；系统已尝试国内来源\n";

        assert_eq!(
            remote_dependency_error(stderr),
            "AD-INF-202：服务器暂时无法下载数据库运行组件；系统已尝试国内来源"
        );
        assert_eq!(
            split_deployment_error(&remote_dependency_error(stderr)),
            Some((
                "AD-INF-202",
                "服务器暂时无法下载数据库运行组件；系统已尝试国内来源"
            ))
        );
    }

    #[test]
    fn remote_runtime_images_use_pinned_domestic_fallbacks() {
        for component in ["postgres", "redis"] {
            assert!(
                REMOTE_DEPENDENCY_SCRIPT
                    .contains(&format!("mirror.ccs.tencentyun.com/library/{component}"))
            );
            assert!(
                REMOTE_DEPENDENCY_SCRIPT
                    .contains(&format!("m.daocloud.io/docker.io/library/{component}"))
            );
        }
        assert!(
            REMOTE_DEPENDENCY_SCRIPT.contains(
                "sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
            )
        );
        assert!(
            REMOTE_DEPENDENCY_SCRIPT.contains(
                "sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99"
            )
        );
        assert!(!REMOTE_DEPENDENCY_SCRIPT.contains(" postgres:16-alpine"));
        assert!(!REMOTE_DEPENDENCY_SCRIPT.contains(" redis:7-alpine"));
        assert!(
            REMOTE_DEPENDENCY_SCRIPT.contains("runtime-dependencies.lock"),
            "shared infrastructure setup must be serialized on one server"
        );
        assert!(REMOTE_DEPENDENCY_SCRIPT.contains("docker start \"$POSTGRES_CONTAINER\""));
        assert!(REMOTE_DEPENDENCY_SCRIPT.contains("docker start \"$REDIS_CONTAINER\""));
        assert!(
            REMOTE_DEPENDENCY_SCRIPT.contains(
                "docker network inspect \"$NETWORK\" --format '{{range .Containers}}{{println .Name}}{{end}}'"
            )
        );
    }

    #[test]
    fn runtime_dependency_failures_resume_the_same_server_deploy() {
        let mut deployment = run();
        deployment.environment = "deployment".to_string();
        pause_deployment_path_after_deploy_error(
            &mut deployment,
            "AD-INF-202：服务器暂时无法下载数据库运行组件；系统已尝试国内来源",
        );

        assert_eq!(deployment.current_stage, "deploy");
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-INF-202"));
        assert_eq!(
            deployment.action_kind.as_deref(),
            Some("deployment-path-retry")
        );
        assert_eq!(
            deployment.message,
            "服务器暂时无法下载数据库运行组件；系统已尝试国内来源"
        );
    }

    #[test]
    fn unknown_server_errors_are_not_misclassified_as_route_conflicts() {
        let mut deployment = run();
        pause_deployment_path_after_deploy_error(
            &mut deployment,
            "unexpected remote command failure",
        );

        assert_eq!(deployment.current_stage, "deploy");
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-DEP-201"));
        assert!(!deployment.message.contains("remote command"));
    }

    #[test]
    fn route_reconciliation_failures_resume_without_redeploying_the_application() {
        let mut deployment = run();
        deployment.environment = "deployment".to_string();
        pause_deployment_path_after_deploy_error(
            &mut deployment,
            "AD-SRV-209：访问地址配置尚未加载，已保留运行中的服务",
        );

        assert_eq!(deployment.current_stage, "server");
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-SRV-209"));
        assert_eq!(
            deployment.action_kind.as_deref(),
            Some("deployment-path-retry")
        );
    }

    #[test]
    fn pre_deploy_server_failures_do_not_skip_the_version_update() {
        let mut deployment = run();
        deployment.environment = "deployment".to_string();
        pause_deployment_path_after_deploy_error(&mut deployment, "AD-SRV-208：服务器磁盘空间不足");

        assert_eq!(deployment.current_stage, "deploy");
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-SRV-208"));
    }

    #[test]
    fn provider_failures_keep_the_bootstrap_error_code() {
        let check = ProviderCheck {
            provider: "caddy".to_string(),
            ok: false,
            summary: "服务器暂时无法下载统一访问组件".to_string(),
            details: Vec::new(),
            code: Some("AD-SRV-212".to_string()),
            next_steps: Vec::new(),
            retryable: true,
        };

        assert_eq!(
            provider_check_failure(&check),
            "AD-SRV-212：服务器暂时无法下载统一访问组件"
        );
    }

    #[test]
    fn local_status_reports_files_the_plan_can_reliably_generate_as_runnable() {
        let service = |id: &str| LocalPreviewService {
            id: id.to_string(),
            kind: "web".to_string(),
            build_strategy: "needs_input".to_string(),
            dockerfile: format!(".deploydesk/generated/build/Dockerfile.{id}"),
            host_port: Some(4300),
            url: None,
            running: false,
        };
        let mut status = LocalPreviewStatus {
            state: "not_prepared".to_string(),
            message: String::new(),
            compose_path: "/tmp/compose.yml".to_string(),
            env_ready: false,
            services: vec![service("api"), service("toolbox")],
            written_files: Vec::new(),
        };

        apply_planned_local_build_strategies(&mut status, &BTreeSet::from(["toolbox".to_string()]));

        assert_eq!(status.services[0].build_strategy, "generated");
        assert_eq!(status.services[1].build_strategy, "needs_input");
    }

    #[test]
    fn registry_validation_accepts_hosts_but_rejects_urls_and_paths() {
        assert!(valid_registry_host("ccr.ccs.tencentyun.com"));
        assert!(valid_registry_host("registry.example.com"));
        assert!(!valid_registry_host("https://ccr.ccs.tencentyun.com"));
        assert!(!valid_registry_host("ccr.ccs.tencentyun.com/team"));
        assert!(!valid_registry_host("-registry.example.com"));
        assert!(!valid_registry_host("registry-.example.com"));
        assert!(!valid_registry_host("localhost"));
    }

    #[test]
    fn moved_project_recovery_requires_the_same_repository_identity() {
        assert_eq!(
            repository_identity("git@cnb.cool:team/sample.git\n").as_deref(),
            Some("team/sample")
        );
        assert_eq!(
            repository_identity("https://cnb.cool/team/sample.git").as_deref(),
            Some("team/sample")
        );
        assert!(repository_identity("https://example.com/team/sample.git").is_none());

        let identity = ProjectRelinkIdentity {
            name: "sample".to_string(),
            service_count: 2,
            storage_id: "a".repeat(64),
            repository: Some("team/sample".to_string()),
            fingerprint: None,
        };
        assert!(
            validate_project_relink(
                &identity,
                "renamed-folder",
                4,
                "different-structure",
                &BTreeSet::from(["team/sample".to_string()]),
            )
            .is_ok()
        );
        assert!(
            validate_project_relink(
                &identity,
                "sample",
                2,
                "same-structure",
                &BTreeSet::from(["other/project".to_string()]),
            )
            .expect_err("reject another repository")
            .contains("另一个代码仓库")
        );
        assert!(
            validate_project_relink(&identity, "sample", 2, "same-structure", &BTreeSet::new())
                .expect_err("reject missing identity")
                .contains("无法确认")
        );

        let local_only = ProjectRelinkIdentity {
            repository: None,
            fingerprint: Some("same-structure".to_string()),
            ..identity
        };
        assert!(
            validate_project_relink(
                &local_only,
                "renamed-project",
                5,
                "same-structure",
                &BTreeSet::new(),
            )
            .is_ok()
        );
        assert!(
            validate_project_relink(
                &local_only,
                "sample",
                2,
                "different-structure",
                &BTreeSet::new(),
            )
            .is_err()
        );
    }

    #[test]
    fn keeps_a_short_single_line_title_for_people_to_recognize_versions() {
        assert_eq!(
            readable_version_title("  修复登录页\n并优化加载速度  ").as_deref(),
            Some("修复登录页 并优化加载速度")
        );
        assert_eq!(readable_version_title("   "), None);
        assert_eq!(readable_version_title("API custom event"), None);
        assert_eq!(
            readable_version_title("initialize project for ABCDeploy").as_deref(),
            Some("初始化 ABCDeploy 项目")
        );
        assert_eq!(
            readable_version_title("fix: 修复登录页").as_deref(),
            Some("修复登录页")
        );
        assert_eq!(
            readable_version_title("feat(home): 增加数据看板").as_deref(),
            Some("增加数据看板")
        );
        assert_eq!(
            readable_version_title("chore: configure ABCDeploy deployment").as_deref(),
            Some("完成首次上线配置")
        );
        assert_eq!(
            readable_version_title(&"改".repeat(140))
                .expect("title")
                .chars()
                .count(),
            120
        );
    }

    #[test]
    fn adds_the_cnb_change_summary_to_an_existing_version_record() {
        let mut deployment = run();
        deployment.source_title = None;
        let record = CnbBuildRecord {
            serial: "42".to_string(),
            event: "push".to_string(),
            status: "success".to_string(),
            revision: deployment.commit_sha.clone(),
            source_ref: Some("main".to_string()),
            title: "fix(home): 修复首页加载问题".to_string(),
            created_at: None,
        };
        apply_version_title(&mut deployment, &record, Path::new("/not-needed"));
        assert_eq!(deployment.source_title.as_deref(), Some("修复首页加载问题"));
    }

    #[test]
    fn recovers_a_version_title_from_local_git_history() {
        let project = tempdir().expect("temp project");
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "abcdeploy@example.com"],
            vec!["config", "user.name", "ABCDeploy Test"],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(project.path())
                    .args(args)
                    .status()
                    .expect("run git")
                    .success()
            );
        }
        fs::write(project.path().join("README.md"), "test\n").expect("write readme");
        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args(["add", "README.md"])
                .status()
                .expect("add")
                .success()
        );
        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args(["commit", "-q", "-m", "修复登录并优化首页速度"])
                .status()
                .expect("commit")
                .success()
        );
        let revision = String::from_utf8(
            Command::new("git")
                .current_dir(project.path())
                .args(["rev-parse", "HEAD"])
                .output()
                .expect("revision")
                .stdout,
        )
        .expect("utf8 revision");
        assert_eq!(
            local_git_title(project.path(), revision.trim()).as_deref(),
            Some("修复登录并优化首页速度")
        );
    }

    #[test]
    fn local_infrastructure_is_loopback_only_and_project_databases_are_isolated() {
        let compose = local_infrastructure_compose();
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(compose).expect("valid Compose YAML");
        assert!(compose.contains("127.0.0.1:${POSTGRES_PORT}:5432"));
        assert!(compose.contains("127.0.0.1:${REDIS_PORT}:6379"));
        assert!(!compose.contains("password="));

        let first = local_database_name(Path::new("/tmp/project-a"), EnvironmentName::Development);
        let second = local_database_name(Path::new("/tmp/project-b"), EnvironmentName::Development);
        let production =
            local_database_name(Path::new("/tmp/project-a"), EnvironmentName::Production);
        assert_ne!(first, second);
        assert_ne!(first, production);
        assert!(
            first
                .bytes()
                .all(|byte| { byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' })
        );
    }

    #[test]
    fn reads_all_local_infrastructure_states_from_one_docker_listing() {
        let output = concat!(
            "abcdeploy-local-redis\trunning\tUp 2 hours (healthy)\n",
            "abcdeploy-local-postgres\trunning\tUp 2 hours (health: starting)\n",
        );
        assert_eq!(parse_local_container_readiness(output), (false, true));
        assert_eq!(
            parse_local_container_readiness(
                "abcdeploy-local-postgres\texited\tExited (0) 1 minute ago\n"
            ),
            (false, false)
        );
    }

    #[test]
    fn container_runtime_uses_the_host_gateway_without_changing_other_env_values() {
        let source = concat!(
            "# project config\n",
            "DATABASE_URL=postgresql://user:secret@127.0.0.1:55432/app\n",
            "REDIS_URL=\"redis://:secret@localhost:56379/0\"\n",
            "CALLBACK_URL=http://127.0.0.1:3000/callback\n",
        );
        let adapted = container_runtime_env(source);
        assert!(adapted.contains("@host.docker.internal:55432/app"));
        assert!(adapted.contains("@host.docker.internal:56379/0"));
        assert!(adapted.contains("CALLBACK_URL=http://127.0.0.1:3000/callback"));
        assert!(adapted.starts_with("# project config\n"));
    }

    #[test]
    fn maps_cnb_stages_to_resumable_product_state() {
        let mut deployment = run();
        update_run_from_cnb(
            &mut deployment,
            &json!({
                "status": "running",
                "pipelinesStatus": {
                    "pipeline": {"stages": [{"name": "部署测试环境", "status": "running"}]}
                }
            }),
        );
        assert_eq!(deployment.status, "running");
        assert_eq!(deployment.current_stage, "deploy");
        assert!(deployment.message.contains("部署测试环境"));

        update_run_from_cnb(&mut deployment, &json!({"status": "success"}));
        assert_eq!(deployment.status, "success");
        assert_eq!(deployment.current_stage, "complete");
        assert!(
            deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
        assert_eq!(stage_key(Some("上传镜像")), "publish");
        assert_eq!(stage_key(Some("在测试环境验证生产候选")), "deploy");
        assert_eq!(stage_key(Some("标记已验证镜像摘要")), "verify-release");
        assert_eq!(
            stage_key(Some("创建可在手机发布的候选版本")),
            "verify-release"
        );
        assert_eq!(stage_key(Some("准备安全部署工具")), "prepare");

        update_run_from_cnb(
            &mut deployment,
            &json!({
                "status": "pending",
                "pipelinesStatus": {
                    "pipeline": {"stages": [{"name": "构建并上传 api", "status": "start"}]}
                }
            }),
        );
        assert_eq!(deployment.status, "running");
        assert_eq!(deployment.current_stage, "build");
        assert_eq!(deployment.message, "正在执行：构建并上传 api");
    }

    #[test]
    fn live_server_checks_only_keep_a_release_healthy_when_every_service_is_ready() {
        let expected = vec![
            ("api".to_string(), "sample-staging-api-1".to_string()),
            ("web".to_string(), "sample-staging-web-1".to_string()),
        ];
        let healthy = parse_deployed_service_states(
            "api\trunning\thealthy\tregistry.example/api@sha256:abc\nweb\trunning\tnone\tregistry.example/web@sha256:def\n",
            &expected,
        );
        assert_eq!(
            healthy[0].image.as_deref(),
            Some("registry.example/api@sha256:abc")
        );
        let mut deployment = run();
        deployment.status = "success".to_string();
        deployment.current_stage = "complete".to_string();
        deployment.action_kind = Some("local-preview".to_string());
        deployment.completed_steps.push("healthcheck".to_string());
        apply_deployed_service_states(&mut deployment, &healthy);
        assert_eq!(deployment.status, "success");
        assert_eq!(deployment.message, "测试版仍在服务器运行");
        assert_eq!(
            deployment.action_kind.as_deref(),
            Some("local-preview"),
            "a live check must not remove the secure preview entry point"
        );

        let missing = parse_deployed_service_states("api\trunning\thealthy\n", &expected);
        apply_deployed_service_states(&mut deployment, &missing);
        assert_eq!(deployment.status, "needs_action");
        assert_eq!(deployment.current_stage, "healthcheck");
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-CTR-201"));
        assert!(deployment.message.contains("sample-staging-web-1"));
        assert!(
            !deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
    }

    #[test]
    fn turns_runner_logs_into_actionable_safe_error_codes() {
        let mut deployment = run();
        apply_runner_log_diagnostic(
            &mut deployment,
            "[00:05:19] container finagent-staging-h5-1 is unhealthy\n",
        );
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-CTR-201"));
        assert_eq!(deployment.current_stage, "healthcheck");
        assert!(deployment.message.contains("finagent-staging-h5-1"));

        let mut missing_config = run();
        apply_runner_log_diagnostic(
            &mut missing_config,
            "缺少密钥仓库字段：STAGING_DATABASE_URL, STAGING_REDIS_URL\n",
        );
        assert_eq!(missing_config.issue_code.as_deref(), Some("AD-CFG-201"));
        assert!(missing_config.message.contains("STAGING_DATABASE_URL"));

        let mut missing_lockfile = run();
        apply_runner_log_diagnostic(
            &mut missing_lockfile,
            "ERR_PNPM_NO_LOCKFILE Cannot install with frozen-lockfile because pnpm-lock.yaml is absent\n",
        );
        assert_eq!(missing_lockfile.issue_code.as_deref(), Some("AD-PKG-201"));
        assert_eq!(missing_lockfile.current_stage, "build");
        assert!(missing_lockfile.message.contains("依赖锁定文件"));

        let mut missing_database = run();
        apply_runner_log_diagnostic(
            &mut missing_database,
            "AD-DB-204：远程数据库尚未准备，请在客户端重新生成当前环境的云端安全配置\n",
        );
        assert_eq!(missing_database.issue_code.as_deref(), Some("AD-DB-204"));
        assert_eq!(
            missing_database.action_kind.as_deref(),
            Some("cloud-config")
        );
        assert_eq!(missing_database.current_stage, "cloud-setup");
        assert!(missing_database.action_url.is_none());

        let mut raw_missing_database = run();
        apply_runner_log_diagnostic(
            &mut raw_missing_database,
            "[00:09:03 +334ms] pg_dump: error: FATAL: database \"example_staging\" does not exist\n",
        );
        assert_eq!(
            raw_missing_database.issue_code.as_deref(),
            Some("AD-DB-204")
        );

        let mut echoed_shell = run();
        apply_runner_log_diagnostic(
            &mut echoed_shell,
            "echo 'AD-SRV-207：Caddy 重载失败，已恢复原路由' >&2\n",
        );
        assert_eq!(echoed_shell.issue_code, None);

        let mut echoed_shell_after_database_error = run();
        apply_runner_log_diagnostic(
            &mut echoed_shell_after_database_error,
            "[00:09:03] pg_dump: error: database \"example_staging\" does not exist\necho 'AD-SRV-207：Caddy 重载失败，已恢复原路由' >&2\n",
        );
        assert_eq!(
            echoed_shell_after_database_error.issue_code.as_deref(),
            Some("AD-DB-204")
        );

        let mut missing_caddy_config_directory = run();
        apply_runner_log_diagnostic(
            &mut missing_caddy_config_directory,
            "/bin/sh: can't create /etc/caddy/Caddyfile: nonexistent directory\n",
        );
        assert_eq!(
            missing_caddy_config_directory.issue_code.as_deref(),
            Some("AD-CTR-202")
        );
        assert!(
            missing_caddy_config_directory
                .message
                .contains("重新生成部署文件")
        );

        let mut legacy_nginx_template_directory = run();
        apply_runner_log_diagnostic(
            &mut legacy_nginx_template_directory,
            "/bin/sh: can't create /etc/nginx/templates/default.conf.template: nonexistent directory\n",
        );
        assert_eq!(
            legacy_nginx_template_directory.issue_code.as_deref(),
            Some("AD-CTR-202")
        );

        let mut unsafe_name = run();
        apply_runner_log_diagnostic(
            &mut unsafe_name,
            "container token=must-not-appear is unhealthy\n",
        );
        assert_eq!(unsafe_name.issue_code, None);
        assert!(!unsafe_name.message.contains("must-not-appear"));
    }

    #[test]
    fn turns_container_logs_into_safe_user_facing_causes() {
        let mut missing_dependency = run();
        apply_container_log_diagnostic(
            &mut missing_dependency,
            "Error: Cannot find module 'express'\nDATABASE_URL=must-not-appear\n",
        );
        assert_eq!(missing_dependency.issue_code.as_deref(), Some("AD-APP-201"));
        assert!(missing_dependency.message.contains("express"));
        assert!(!missing_dependency.message.contains("must-not-appear"));

        let mut database = run();
        apply_container_log_diagnostic(
            &mut database,
            "PrismaClientInitializationError: Authentication failed against database server (P1000)",
        );
        assert_eq!(database.issue_code.as_deref(), Some("AD-DB-201"));
        assert!(!database.message.to_ascii_lowercase().contains("password"));

        let mut web_route_cycle = run();
        apply_container_log_diagnostic(
            &mut web_route_cycle,
            "rewrite or internal redirection cycle while internally redirecting to /index.html",
        );
        assert_eq!(web_route_cycle.issue_code.as_deref(), Some("AD-WEB-201"));
        assert!(web_route_cycle.message.contains("重新生成部署文件"));

        let mut cache = run();
        apply_container_log_diagnostic(&mut cache, "Redis client ECONNREFUSED 10.0.0.2:6379");
        assert_eq!(cache.issue_code.as_deref(), Some("AD-CACHE-201"));
    }

    #[test]
    fn reads_and_compares_immutable_artifacts_from_server_release_records() {
        let manifest = deploy_core::parse_manifest(
            r"
version: 1
project: { name: sample }
source: { provider: cnb, repository: team/sample, release_branch: main }
services:
  - id: api
    kind: api
    image: sample-api
    context: .
    dockerfile: Dockerfile
    container_port: 3000
    healthcheck: { path: /health }
environments:
  development:
    target: { kind: local, namespace: sample-development }
  staging:
    target: { kind: server, server: default, namespace: sample-staging }
  production:
    target: { kind: server, server: default, namespace: sample-production }
providers:
  build: { kind: cnb, repository: team/sample }
  registry: { kind: tcr, registry: registry.example.com, namespace: team }
",
            Path::new("deploy.yaml"),
        )
        .expect("manifest fixture");
        let mut release = String::new();
        for (index, service) in manifest.services.iter().enumerate() {
            let variable = service.id.replace('-', "_").to_ascii_uppercase();
            writeln!(
                release,
                "DEPLOYDESK_{variable}_IMAGE=registry.example.com/team/{}@sha256:{:064x}",
                service.image,
                index + 1
            )
            .expect("write fixture");
        }
        let artifacts =
            parse_deployment_artifacts(&release, &manifest).expect("parse release artifacts");
        assert_eq!(artifacts.len(), manifest.services.len());
        assert!(same_artifact_digests(&artifacts, &artifacts));

        let mut changed = artifacts.clone();
        changed[0].digest = format!("sha256:{:064x}", 99);
        assert!(!same_artifact_digests(&artifacts, &changed));
        assert!(parse_deployment_artifacts("DEPLOYDESK_API_IMAGE=latest", &manifest).is_err());
    }

    #[test]
    fn runtime_values_are_partitioned_without_exposing_names_or_paths() {
        let first = tempdir().expect("temp project");
        let second = tempdir().expect("second temp project");
        let staging =
            runtime_secret_key(first.path(), "staging", "JWT_SECRET").expect("valid runtime key");
        let production = runtime_secret_key(first.path(), "production", "JWT_SECRET")
            .expect("valid runtime key");
        let development = runtime_secret_key(first.path(), "development", "JWT_SECRET")
            .expect("valid local runtime key");
        let other_project =
            runtime_secret_key(second.path(), "staging", "JWT_SECRET").expect("valid runtime key");

        assert_ne!(staging, production);
        assert_ne!(staging, development);
        assert_ne!(staging, other_project);
        assert!(!staging.contains("JWT_SECRET"));
        assert!(!staging.contains(&first.path().to_string_lossy().to_string()));
        assert!(runtime_secret_key(first.path(), "staging", "unsafe-name").is_err());
    }

    #[test]
    fn keeps_unlocked_secrets_only_in_the_current_app_session() {
        let key = "test-session-secret-cache";
        evict_cached_secret(key);
        assert_eq!(cached_secret(key), None);

        cache_secret(key, "temporary-value");
        assert_eq!(cached_secret(key).as_deref(), Some("temporary-value"));

        evict_cached_secret(key);
        assert_eq!(cached_secret(key), None);
    }

    #[test]
    fn runtime_config_preserves_the_project_template_verbatim() {
        let project = tempdir().expect("temp project");
        let template = "# 第三方服务\nUNKNOWN_SETTING=keep-me\nEMPTY=\n";
        fs::write(project.path().join(".env.example"), template).expect("write template");

        let (content, sources, required) =
            runtime_config_template(project.path(), deploy_core::model::EnvironmentName::Staging)
                .expect("load runtime template");

        assert_eq!(content, template);
        assert_eq!(sources, [".env.example"]);
        assert!(required.is_empty());
        let staging = runtime_config_key(project.path(), "staging").expect("staging key");
        let production = runtime_config_key(project.path(), "production").expect("production key");
        assert_ne!(staging, production);
        assert!(staging.starts_with("runtime-file-v2."));
        assert!(!staging.contains(&project.path().to_string_lossy().to_string()));
    }

    #[test]
    fn runtime_template_adds_new_manifest_requirements_without_overwriting_values() {
        let prepared = ensure_runtime_template_variables(
            "NODE_ENV=production\nDATABASE_URL=postgresql://db/app\n".to_string(),
            &[
                "NODE_ENV".to_string(),
                "DATABASE_URL".to_string(),
                "AUTH_TOKEN_SECRET".to_string(),
            ],
        );

        assert_eq!(prepared.matches("NODE_ENV=").count(), 1);
        assert!(prepared.contains("DATABASE_URL=postgresql://db/app"));
        assert!(prepared.contains("# ABCDeploy 检测到的必要配置"));
        assert!(prepared.ends_with("AUTH_TOKEN_SECRET=\n"));
    }

    #[test]
    fn remote_runtime_config_clears_local_and_secret_example_values() {
        let project = tempdir().expect("temp project");
        let template = concat!(
            "NODE_ENV=development\n",
            "DATABASE_URL=postgresql://user:pass@localhost/app\n",
            "API_TOKEN=example-secret\n",
            "PUBLIC_API_URL=https://api.example.test\n",
        );
        fs::write(project.path().join(".env.example"), template).expect("write template");

        let (development, _, _) = runtime_config_template(
            project.path(),
            deploy_core::model::EnvironmentName::Development,
        )
        .expect("development template");
        let (staging, _, _) =
            runtime_config_template(project.path(), deploy_core::model::EnvironmentName::Staging)
                .expect("staging template");

        assert_eq!(development, template);
        assert!(staging.contains("NODE_ENV=production"));
        assert!(staging.contains("DATABASE_URL=\n"));
        assert!(staging.contains("API_TOKEN=\n"));
        assert!(staging.contains("PUBLIC_API_URL=https://api.example.test"));
    }

    #[test]
    fn runtime_config_reports_missing_required_variables() {
        let required = vec!["DATABASE_URL".to_string()];

        assert_eq!(
            super::missing_runtime_variables(
                "DATABASE_URL=\n",
                &required,
                EnvironmentName::Staging,
            ),
            ["DATABASE_URL"]
        );
        assert!(
            super::missing_runtime_variables(
                "DATABASE_URL=postgresql://db\n",
                &required,
                EnvironmentName::Staging,
            )
            .is_empty()
        );
        assert_eq!(
            super::missing_runtime_variables(
                "DATABASE_URL=postgresql://localhost/app\n",
                &required,
                EnvironmentName::Staging,
            ),
            ["DATABASE_URL"]
        );
    }

    #[test]
    fn only_internal_application_secrets_are_safe_to_generate() {
        for variable in [
            "AUTH_TOKEN_SECRET",
            "JWT_SECRET",
            "FINAGENT_SESSION_SECRET",
            "COOKIE_SECRET",
            "ENCRYPTION_KEY",
        ] {
            assert!(internal_runtime_secret(variable), "{variable}");
        }
        for variable in [
            "MINIMAX_API_KEY",
            "TCR_PASSWORD",
            "CNB_TOKEN",
            "DATABASE_URL",
        ] {
            assert!(!internal_runtime_secret(variable), "{variable}");
        }
    }

    #[test]
    fn static_build_variables_do_not_block_server_runtime() {
        let project = tempdir().expect("project");
        fs::create_dir_all(project.path().join("src")).expect("source directory");
        fs::write(
            project.path().join("package.json"),
            r#"{"name":"sample-web","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"vite":"1"}}"#,
        )
        .expect("package manifest");
        fs::write(project.path().join("src/main.ts"), "export {};\n").expect("entrypoint");
        fs::write(
            project.path().join(".env.example"),
            "VITE_API_BASE_URL=/api\n",
        )
        .expect("environment example");

        let inspection = deploy_core::inspect_project(project.path()).expect("inspection");
        let manifest = deploy_core::create_default_manifest(&inspection);
        assert!(manifest.services.iter().any(|service| {
            service.kind == deploy_core::model::ServiceKind::Static
                && service
                    .runtime_env
                    .iter()
                    .any(|variable| variable.name == "VITE_API_BASE_URL")
        }));
        assert!(
            !required_runtime_variables(&manifest, EnvironmentName::Production)
                .contains(&"VITE_API_BASE_URL".to_string())
        );
    }

    #[test]
    fn deployment_path_does_not_ask_users_for_managed_ocr_service_urls() {
        let project = tempdir().expect("project");
        fs::write(
            project.path().join("package.json"),
            r#"{"name":"sample-api","scripts":{"start":"node server.js"}}"#,
        )
        .expect("package manifest");
        fs::write(project.path().join("server.js"), "process.exit(0);\n").expect("entrypoint");
        let inspection = deploy_core::inspect_project(project.path()).expect("inspection");
        let mut manifest = deploy_core::create_default_manifest(&inspection);
        manifest.services[0]
            .runtime_env
            .push(deploy_core::model::EnvironmentVariable {
                name: "PP_OCRV6_TINY_URL".to_string(),
                required: true,
                secret: false,
                default: None,
                description: String::new(),
            });
        let mut ocr = manifest.services[0].clone();
        ocr.id = "ocr".to_string();
        ocr.image = "sample-ocr".to_string();
        ocr.container_port = 8000;
        ocr.runtime_env.clear();
        manifest.services.push(ocr);

        assert_eq!(
            deployment_path_managed_runtime_variables(&manifest),
            BTreeSet::from(["PP_OCRV6_TINY_URL".to_string()])
        );
        manifest.services.retain(|service| service.id != "ocr");
        assert!(deployment_path_managed_runtime_variables(&manifest).is_empty());
    }

    #[test]
    fn shared_cnb_secret_repository_uses_project_scoped_filenames() {
        assert_eq!(
            cnb_secret_filename("wxseo", "staging"),
            "env.wxseo.staging.yml"
        );
        assert_eq!(
            cnb_secret_filename("swifteng", "production"),
            "env.swifteng.production.yml"
        );
    }

    #[test]
    fn validates_cnb_repositories_and_release_branches() {
        for repository in ["team/project", "abc_1/project.name", "parent/team/project"] {
            assert!(validate_repository_slug(repository).is_ok());
        }
        for repository in [
            "project",
            "team/project name",
            "../project",
            "team//project",
        ] {
            assert!(validate_repository_slug(repository).is_err());
        }
        for branch in ["main", "release/v1.2", "feature_123"] {
            assert!(validate_git_branch(branch).is_ok());
        }
        for branch in [
            "",
            "-force",
            "../main",
            "main..next",
            "main@{1}",
            "main name",
        ] {
            assert!(validate_git_branch(branch).is_err());
        }
    }

    #[test]
    fn uses_cnb_organization_namespace_instead_of_login_username() {
        let account = cnb_account_from_responses(
            &json!({
                "username": "cnb.boxuDF6MQHA",
                "nickname": "马成龙"
            }),
            &json!({
                "data": [
                    {
                        "path": "read-only-team",
                        "name": "只读团队",
                        "access_role": "Guest",
                        "freeze": false
                    },
                    {
                        "path": "blacksco0920",
                        "name": "blacksco0920",
                        "access_role": "Owner",
                        "freeze": false
                    }
                ]
            }),
        );

        assert_eq!(account.username, "cnb.boxuDF6MQHA");
        assert_eq!(account.default_namespace, "blacksco0920");
        assert_eq!(account.namespaces[0].path, "blacksco0920");
        assert!(account.namespaces[0].can_create_repository);
    }

    #[test]
    fn caches_only_the_non_secret_cnb_account_summary() {
        let directory = tempdir().expect("temp app data");
        let state = WorkspaceState::open(&directory.path().join("workspace.sqlite3"))
            .expect("workspace state");
        let account = cnb_account_from_responses(
            &json!({
                "username": "cnb.user",
                "nickname": "示例用户"
            }),
            &json!({
                "data": [{
                    "path": "example-team",
                    "name": "示例团队",
                    "access_role": "Owner",
                    "freeze": false
                }]
            }),
        );

        remember_cnb_account(&state, &account).expect("remember account");

        assert_eq!(cached_cnb_account(&state), Some(account));
        let stored = state
            .setting(CNB_ACCOUNT_CACHE_KEY)
            .expect("read setting")
            .expect("cached account");
        assert!(!stored.to_ascii_lowercase().contains("token"));
        assert!(!stored.contains("secret"));

        state
            .set_setting(CNB_ACCOUNT_CACHE_KEY, "not-json")
            .expect("store invalid legacy value");
        assert_eq!(cached_cnb_account(&state), None);
    }

    #[test]
    fn reuses_existing_cnb_repository_case_insensitively() {
        let repositories = json!({
            "data": [
                {"name": "FinAgent", "path": "blacksco0920/FinAgent"},
                {"name": "other", "path": "blacksco0920/other"}
            ]
        });

        assert_eq!(
            existing_cnb_repository(&repositories, "blacksco0920", "finagent").as_deref(),
            Some("blacksco0920/FinAgent")
        );
    }

    #[test]
    fn maps_cnb_api_failures_without_exposing_raw_response_bodies() {
        let message = cnb_public_error(DeployError::CnbApi {
            status: 404,
            message: r#"{"errcode":5,"errmsg":"Resource not found."}"#.to_string(),
        });

        assert_eq!(
            message,
            "AD-CNB-104：CNB 中找不到所选组织或仓库，请重新选择组织"
        );
        assert!(!message.contains("Resource not found"));

        let permission = cnb_public_error(DeployError::CnbApi {
            status: 403,
            message: r#"{"errmsg":"Missing required scopes: repo-cnb-trigger:rw"}"#.to_string(),
        });
        assert_eq!(
            permission,
            "AD-CNB-103：CNB 授权缺少“触发构建”权限（repo-cnb-trigger:rw）"
        );
        assert!(!permission.contains("Missing required scopes"));

        let build_detail = cnb_public_error(DeployError::CnbApi {
            status: 403,
            message: r#"{"errmsg":"Missing required scopes: repo-code:rw, repo-cnb-detail:r","repository":"private-name"}"#
                .to_string(),
        });
        assert_eq!(
            build_detail,
            "AD-CNB-103：CNB 授权缺少以下权限：repo-code:rw、repo-cnb-detail:r"
        );
        assert!(!build_detail.contains("private-name"));

        let history = cnb_build_history_error(DeployError::CnbApi {
            status: 403,
            message: "[NO_RIGHT]Token scope not match".to_string(),
        });
        assert_eq!(
            history,
            "AD-CNB-103：CNB 拒绝读取这个仓库的构建记录；令牌的授权范围（scope）或使用范围可能不匹配当前仓库，请检查 CNB 授权设置"
        );

        let explicit_history = cnb_build_history_error(DeployError::CnbApi {
            status: 403,
            message: "权限不足。缺少授权范围：repo-cnb-history:r。".to_string(),
        });
        assert_eq!(
            explicit_history,
            "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）"
        );
    }

    #[test]
    fn cnb_token_selection_prefers_current_ui_then_saved_connection() {
        assert_eq!(
            resolve_cnb_token_sources(
                "  ui-token  ",
                StoredCnbToken::Unavailable,
                Some("environment-token"),
                Some("git-token")
            )
            .expect("provided token must short-circuit unavailable storage")
            .as_deref(),
            Some("ui-token")
        );
        assert_eq!(
            resolve_cnb_token_sources(
                "",
                StoredCnbToken::Present(" saved-token "),
                Some("environment-token"),
                Some("git-token")
            )
            .expect("stored token")
            .as_deref(),
            Some("saved-token")
        );
        assert_eq!(
            resolve_cnb_token_sources(
                "",
                StoredCnbToken::Missing,
                Some("environment-token"),
                Some("git-token")
            )
            .expect("missing storage may fall back")
            .as_deref(),
            Some("environment-token")
        );
        assert_eq!(
            resolve_cnb_token_sources(
                "",
                StoredCnbToken::Present("  "),
                Some("  "),
                Some(" git-token ")
            )
            .expect("empty storage may fall back")
            .as_deref(),
            Some("git-token")
        );
        assert_eq!(
            resolve_cnb_token_sources(
                "",
                StoredCnbToken::Unavailable,
                Some("stale-environment-token"),
                Some("stale-git-token")
            ),
            Err(CnbTokenResolutionError::StoredCredentialUnavailable)
        );
        assert_eq!(
            CNB_KEYCHAIN_UNAVAILABLE_ERROR,
            "AD-CNB-108：无法读取系统密钥库中的 CNB 授权，请重新打开应用；仍未恢复时更新 CNB 授权"
        );
    }

    #[test]
    fn cnb_keyring_failures_use_safe_distinct_issue_codes() {
        assert_eq!(
            cnb_keyring_issue("missing"),
            ("AD-CNB-101", "CNB 登录已失效，请重新连接后继续")
        );
        let raw_error = "User interaction is not allowed for account secret-token";
        let unavailable = cnb_keyring_issue(raw_error);
        assert_eq!(unavailable.0, "AD-CNB-108");
        assert_eq!(unavailable.1, CNB_KEYCHAIN_UNAVAILABLE_ERROR);
        assert!(!unavailable.1.contains(raw_error));
        assert!(!unavailable.1.contains("secret-token"));
    }

    #[test]
    fn cnb_connection_metadata_failures_do_not_reject_a_saved_token() {
        let remember_attempted = Cell::new(false);
        let mark_attempted = Cell::new(false);
        save_cnb_connection_metadata_best_effort(
            || {
                remember_attempted.set(true);
                Err("summary database unavailable".to_string())
            },
            || {
                mark_attempted.set(true);
                Err("connection database unavailable".to_string())
            },
        );
        assert!(remember_attempted.get());
        assert!(mark_attempted.get());
    }

    #[test]
    fn only_generated_deployment_files_are_owned() {
        for path in [
            "deploy.yaml",
            ".cnb.yml",
            ".cnb/tag_deploy.yml",
            ".github/workflows/sync-cnb.yml",
            ".dockerignore",
            ".deploydesk/.gitignore",
            ".deploydesk/generated/staging/Caddyfile",
        ] {
            assert!(is_deployment_owned_path(path), "{path}");
        }
        for path in [
            "src/App.tsx",
            ".env",
            ".github/workflows/release.yml",
            ".deploydesk/backups/plan/deploy.yaml",
        ] {
            assert!(!is_deployment_owned_path(path), "{path}");
        }
        for path in [
            ".deploydesk/backups/plan/deploy.yaml",
            ".deploydesk/runtime/staging/.runtime.env",
            ".deploydesk/state/last-plan.json",
        ] {
            assert!(is_deployment_internal_path(path), "{path}");
        }
        assert!(!is_deployment_internal_path(
            ".deploydesk/generated/staging/Caddyfile"
        ));
    }

    #[test]
    fn deployment_snapshot_contains_working_tree_without_mutating_user_git_state() {
        let project = tempfile::tempdir().expect("project");
        fs::write(project.path().join("app.txt"), "old\n").expect("app");
        fs::write(project.path().join("legacy.pem"), "private\n").expect("legacy secret");
        let mut init = system_command("git");
        init.current_dir(project.path()).args(["init", "--quiet"]);
        run_git_command(init, "init").expect("init");
        let mut add = system_command("git");
        add.current_dir(project.path()).args(["add", "--all"]);
        run_git_command(add, "add").expect("add");
        let mut commit = system_command("git");
        commit.current_dir(project.path()).args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "-m",
            "initial",
        ]);
        run_git_command(commit, "commit").expect("commit");

        fs::write(project.path().join("app.txt"), "current\n").expect("change app");
        fs::write(project.path().join("new.txt"), "new\n").expect("new file");
        fs::write(project.path().join(".env"), "TOKEN=do-not-push\n").expect("env");
        fs::write(project.path().join("staged.txt"), "staged\n").expect("staged file");
        let mut stage = system_command("git");
        stage
            .current_dir(project.path())
            .args(["add", "staged.txt"]);
        run_git_command(stage, "stage").expect("stage");
        fs::write(project.path().join("staged.txt"), "working\n").expect("working file");

        let head_before = git_stdout(project.path(), &["rev-parse", "HEAD"]).expect("head");
        let index_before =
            git_stdout(project.path(), &["diff", "--cached", "--binary"]).expect("index");
        let (snapshot, created) =
            create_deployment_git_snapshot(project.path(), &[], None).expect("snapshot");
        assert!(created);
        assert_eq!(
            git_stdout(project.path(), &["rev-parse", "HEAD"]).expect("head after"),
            head_before
        );
        assert_eq!(
            git_stdout(project.path(), &["diff", "--cached", "--binary"]).expect("index after"),
            index_before
        );
        assert_eq!(
            git_stdout(project.path(), &["show", &format!("{snapshot}:app.txt")])
                .expect("snapshot app"),
            "current\n"
        );
        assert_eq!(
            git_stdout(project.path(), &["show", &format!("{snapshot}:staged.txt")])
                .expect("snapshot staged"),
            "working\n"
        );
        assert!(
            system_command("git")
                .current_dir(project.path())
                .args(["cat-file", "-e", &format!("{snapshot}:.env")])
                .status()
                .is_ok_and(|status| !status.success())
        );
        assert!(
            system_command("git")
                .current_dir(project.path())
                .args(["cat-file", "-e", &format!("{snapshot}:legacy.pem")])
                .status()
                .is_ok_and(|status| !status.success())
        );
    }

    #[test]
    fn deployment_snapshots_continue_from_a_verified_remote_snapshot_parent() {
        let project = tempfile::tempdir().expect("project");
        fs::write(project.path().join("app.txt"), "initial\n").expect("app");
        let mut init = system_command("git");
        init.current_dir(project.path()).args(["init", "--quiet"]);
        run_git_command(init, "init").expect("init");
        let mut add = system_command("git");
        add.current_dir(project.path()).args(["add", "--all"]);
        run_git_command(add, "add").expect("add");
        let mut commit = system_command("git");
        commit.current_dir(project.path()).args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "-m",
            "initial",
        ]);
        run_git_command(commit, "commit").expect("commit");

        fs::write(project.path().join("app.txt"), "snapshot one\n").expect("first change");
        let (first, first_created) =
            create_deployment_git_snapshot(project.path(), &[], None).expect("first snapshot");
        assert!(first_created);
        let (unchanged, unchanged_created) =
            create_deployment_git_snapshot(project.path(), &[], Some(&first))
                .expect("unchanged snapshot");
        assert_eq!(unchanged, first);
        assert!(!unchanged_created);

        fs::write(project.path().join("app.txt"), "snapshot two\n").expect("second change");
        let (second, second_created) =
            create_deployment_git_snapshot(project.path(), &[], Some(&first))
                .expect("second snapshot");
        assert!(second_created);
        assert_eq!(
            git_stdout(project.path(), &["show", "-s", "--format=%P", &second])
                .expect("parent")
                .trim(),
            first
        );
        assert_eq!(
            git_stdout(project.path(), &["show", &format!("{second}:app.txt")])
                .expect("second content"),
            "snapshot two\n"
        );
    }

    #[test]
    fn maps_diverged_cnb_pushes_to_a_recoverable_error() {
        let message = git_failure(
            "同步代码到 CNB",
            b"",
            b"To https://cnb.cool/team/project.git\n ! [rejected] HEAD -> main (non-fast-forward)\nerror: failed to push some refs\n",
        );

        assert!(message.starts_with("AD-GIT-102"));
        assert!(!message.contains("https://"));
    }

    #[test]
    fn uses_git_stdout_when_stderr_only_contains_the_remote_destination() {
        let message = git_failure(
            "同步代码到 CNB",
            b"remote: branch protection denied this update\n",
            b"To https://cnb.cool/team/project.git\n",
        );

        assert_eq!(
            message,
            "同步代码到 CNB未完成：remote: branch protection denied this update"
        );
        assert!(!message.contains("https://"));
    }

    #[test]
    fn includes_cnb_deployment_approval_in_the_automatic_commit() {
        let project = tempdir().expect("temp project");
        fs::create_dir_all(project.path().join(".cnb")).expect("create cnb directory");
        fs::write(
            project.path().join(".cnb/tag_deploy.yml"),
            "deployments: []\n",
        )
        .expect("write deployment config");

        let paths = deployment_owned_paths(project.path());
        assert!(paths.contains(&".cnb/tag_deploy.yml".to_string()));
    }

    #[test]
    fn initializes_a_new_project_and_keeps_local_secrets_out_of_git() {
        let project = tempdir().expect("temp project");
        fs::write(project.path().join("app.ts"), "console.log('ready')\n").expect("source file");
        fs::write(project.path().join(".env"), "TOKEN=real-secret\n").expect("local env");
        fs::write(project.path().join(".env.example"), "TOKEN=\n").expect("env example");

        assert!(
            ensure_git_repository_for_sync(project.path(), "main").expect("initialize project")
        );
        assert!(!ensure_git_repository_for_sync(project.path(), "main").expect("reuse project"));

        let tracked = Command::new("git")
            .current_dir(project.path())
            .args(["ls-files"])
            .output()
            .expect("list tracked files");
        let tracked = String::from_utf8(tracked.stdout).expect("utf8 files");
        assert!(tracked.lines().any(|line| line == "app.ts"));
        assert!(tracked.lines().any(|line| line == ".env.example"));
        assert!(!tracked.lines().any(|line| line == ".env"));

        let branch = Command::new("git")
            .current_dir(project.path())
            .args(["branch", "--show-current"])
            .output()
            .expect("read branch");
        assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "main");
    }

    #[test]
    fn does_not_create_a_nested_repository_inside_an_existing_project() {
        let project = tempdir().expect("temp project");
        let nested = project.path().join("apps/web");
        fs::create_dir_all(&nested).expect("nested directory");
        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args(["init", "--quiet"])
                .status()
                .expect("initialize parent")
                .success()
        );

        let error = ensure_git_repository_for_sync(&nested, "main")
            .expect_err("nested project should require the repository root");
        assert!(error.starts_with("AD-GIT-103"));
        assert!(!nested.join(".git").exists());
    }

    #[test]
    fn stages_generated_build_files_even_when_project_ignores_build_directories() {
        let project = tempdir().expect("temp project");
        fs::create_dir_all(project.path().join(".deploydesk/generated/build"))
            .expect("create generated build directory");
        fs::write(project.path().join(".gitignore"), "build/\n").expect("write gitignore");
        fs::write(
            project
                .path()
                .join(".deploydesk/generated/build/Dockerfile.api"),
            "FROM scratch\n",
        )
        .expect("write generated Dockerfile");
        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args(["init", "-q"])
                .status()
                .expect("initialize git")
                .success()
        );

        let paths = deployment_owned_paths(project.path());
        stage_deployment_owned_files(project.path(), &paths).expect("stage deployment files");

        let tracked = Command::new("git")
            .current_dir(project.path())
            .args(["ls-files", "--stage"])
            .output()
            .expect("list staged files");
        let tracked = String::from_utf8(tracked.stdout).expect("utf8 git output");
        assert!(
            tracked.contains(".deploydesk/generated/build/Dockerfile.api"),
            "{tracked}"
        );
    }

    #[test]
    fn classifies_main_pushes_as_independent_deployment_path_builds() {
        for event in ["push", "git_push", "api_trigger_deployment_path_build"] {
            assert_eq!(build_environment_for_event(event), Some("deployment"));
        }
        for event in ["api_trigger_staging", "tag_deploy.staging"] {
            assert_eq!(build_environment_for_event(event), Some("staging"));
        }
        for event in ["api_trigger_production", "tag_deploy.production"] {
            assert_eq!(build_environment_for_event(event), Some("production"));
        }
        assert_eq!(build_environment_for_event("pull_request"), None);
        assert!(is_production_approval_build(&CnbBuildRecord {
            serial: "approval-1".to_string(),
            event: "push".to_string(),
            status: "success".to_string(),
            revision: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            source_ref: Some("deploydesk-production".to_string()),
            title: "production approval".to_string(),
            created_at: None,
        }));
        assert!(!is_production_approval_build(&CnbBuildRecord {
            serial: "staging-1".to_string(),
            event: "push".to_string(),
            status: "success".to_string(),
            revision: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            source_ref: Some("main".to_string()),
            title: "staging".to_string(),
            created_at: None,
        }));
    }

    #[test]
    fn legacy_history_sync_never_overwrites_a_bound_deployment_path_run() {
        assert!(deployment_path_owns_history_reconciliation(
            "deployment",
            true
        ));
        assert!(!deployment_path_owns_history_reconciliation(
            "deployment",
            false
        ));
        assert!(!deployment_path_owns_history_reconciliation(
            "staging", true
        ));
        assert!(!deployment_path_owns_history_reconciliation(
            "production",
            true
        ));
    }

    #[test]
    fn imports_cnb_history_oldest_first_and_keeps_latest_result_per_line_kind() {
        let payload = json!({
            "data": [
                {
                    "sn": "approval",
                    "event": "push",
                    "status": "success",
                    "sourceRef": "deploydesk-production",
                    "createTime": "2026-07-04T00:00:00Z"
                },
                {
                    "sn": "production-new",
                    "event": "api_trigger_production",
                    "status": "success",
                    "createTime": "2026-07-03T00:00:00Z"
                },
                {
                    "sn": "staging-new",
                    "event": "push",
                    "status": "success",
                    "sourceRef": "main",
                    "createTime": "2026-07-02T00:00:00Z"
                },
                {
                    "sn": "production-old",
                    "event": "api_trigger_production",
                    "status": "success",
                    "createTime": "2026-07-01T00:00:00Z"
                },
                {
                    "sn": "staging-old",
                    "event": "push",
                    "status": "success",
                    "sourceRef": "main",
                    "createTime": "2026-07-01T00:00:00Z"
                }
            ]
        });
        let records = ordered_build_records(&payload);
        assert_eq!(
            records
                .iter()
                .map(|record| record.serial.as_str())
                .collect::<Vec<_>>(),
            vec![
                "staging-old",
                "production-old",
                "staging-new",
                "production-new",
                "approval"
            ]
        );
        assert_eq!(
            latest_success_serials_by_environment(&records),
            BTreeMap::from([
                ("deployment", "staging-new".to_string()),
                ("production", "production-new".to_string()),
            ])
        );
    }

    #[test]
    fn recovers_only_staging_builds_for_the_pushed_revision() {
        let revision = "0123456789abcdef0123456789abcdef01234567";
        let payload = serde_json::json!({
            "data": [
                {
                    "sn": "production-1",
                    "event": "api_trigger_production",
                    "status": "running",
                    "sha": revision
                },
                {
                    "sn": "push-2",
                    "event": "push",
                    "status": "running",
                    "sha": revision
                }
            ]
        });

        assert_eq!(
            build_serial_for_revision(&payload, revision, "staging").as_deref(),
            Some("push-2")
        );
        assert_eq!(
            build_serial_for_revision(&payload, revision, "production").as_deref(),
            Some("production-1")
        );
        assert!(
            build_serial_for_revision(
                &payload,
                "fedcba9876543210fedcba9876543210fedcba98",
                "staging"
            )
            .is_none()
        );
    }

    #[test]
    fn cloud_setup_is_required_until_both_secret_imports_are_real() {
        let raw = r#"
version: 1
project:
  name: sample
source:
  provider: local
  repository: ""
  release_branch: main
services: []
environments:
  development:
    target: { kind: local, namespace: sample-development }
  staging:
    target: { kind: server, server: default, namespace: sample-staging }
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.staging.yml
  production:
    target: { kind: server, server: default, namespace: sample-production }
    approval_required: true
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.production.yml
providers:
  build: { kind: cnb, repository: team/sample }
  registry: { kind: cnb, repository: team/sample }
"#;
        let mut manifest = deploy_core::parse_manifest(raw, Path::new("deploy.yaml"))
            .expect("valid manifest fixture");
        assert!(!cloud_setup_required(&manifest));

        manifest.environments.production.secrets_ref = None;
        assert!(cloud_setup_required(&manifest));
        manifest.environments.production.secrets_ref =
            Some("https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml".to_string());
        assert!(cloud_setup_required(&manifest));
    }

    #[test]
    fn rollback_changes_only_release_images_and_restores_on_failure() {
        let script = rollback_script("sample", "production");
        assert!(script.contains("$HOME/.deploydesk/apps/sample/production"));
        assert!(script.contains("cp \"$previous_file\" .release.env"));
        assert!(script.contains("cp .release.env.before-rollback .release.env"));
        assert!(script.contains("docker compose --env-file .release.env"));
        assert!(!script.contains("cp \"$previous_file\" .runtime.env"));
        assert!(!script.contains("Caddyfile"));
    }

    #[test]
    fn public_route_failures_pause_without_rebuilding() {
        let mut deployment = run();
        deployment.status = "success".to_string();
        deployment.completed_steps.push("healthcheck".to_string());
        apply_public_route_checks(
            &mut deployment,
            &[PublicRouteStatus {
                host: "app.example.com".to_string(),
                url: "https://app.example.com/".to_string(),
                reachable: false,
                phase: "dns".to_string(),
                http_status: None,
                message: "app.example.com 尚未解析".to_string(),
            }],
        );

        assert_eq!(deployment.status, "needs_action");
        assert_eq!(deployment.action_kind.as_deref(), Some("route-check"));
        assert_eq!(deployment.current_stage, "healthcheck");
        assert!(
            !deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
        assert!(deployment.message.contains("尚未解析"));
        assert!(deployment.message.contains("应用已经部署成功"));
    }

    #[tokio::test]
    async fn route_inspection_failures_preserve_the_last_per_address_results() {
        let directory = tempdir().expect("temporary workspace");
        let state = WorkspaceState::open(&directory.path().join("workspace.sqlite3"))
            .expect("open workspace");
        let mut deployment = run();
        deployment.project_path = directory
            .path()
            .join("missing-project")
            .to_string_lossy()
            .into_owned();
        deployment.route_checks = vec![PublicRouteStatus {
            host: "app.example.com".to_string(),
            url: "https://app.example.com/".to_string(),
            phase: "ready".to_string(),
            reachable: true,
            http_status: Some(200),
            message: "上次检查可访问".to_string(),
        }];
        let previous = deployment.route_checks.clone();

        verify_public_routes(&mut deployment, &state)
            .await
            .expect("invalid snapshot becomes a durable task");

        assert_eq!(deployment.route_checks, previous);
        assert_eq!(deployment.status, "needs_action");
    }

    #[test]
    fn repaired_deployment_path_drops_the_previous_issue_code() {
        let directory = tempdir().expect("temporary workspace");
        let state = WorkspaceState::open(&directory.path().join("workspace.sqlite3"))
            .expect("open workspace");
        let mut deployment = run();
        deployment.project_path = directory
            .path()
            .canonicalize()
            .expect("canonical project path")
            .to_string_lossy()
            .into_owned();
        deployment.environment = "deployment".to_string();
        deployment.status = "needs_action".to_string();
        deployment.current_stage = "local".to_string();
        deployment.issue_code = Some("AD-GIT-102".to_string());
        deployment.action_kind = Some("deployment-path-source-retry".to_string());
        state
            .remember_project(directory.path(), "sample", true, 1)
            .expect("remember project");
        state
            .save_deployment_run(&deployment)
            .expect("save interrupted run");

        let repaired =
            prepare_deployment_path_retry_inner(deployment.id, "server".to_string(), &state)
                .expect("prepare retry");

        assert_eq!(repaired.current_stage, "server");
        assert_eq!(repaired.issue_code, None);
        assert_eq!(
            repaired.action_kind.as_deref(),
            Some("deployment-path-retry")
        );
    }

    #[test]
    fn repaired_deployment_path_routes_keep_existing_artifacts_on_the_server() {
        let directory = tempdir().expect("temporary workspace");
        let state = WorkspaceState::open(&directory.path().join("workspace.sqlite3"))
            .expect("open workspace");
        let mut deployment = run();
        deployment.project_path = directory
            .path()
            .canonicalize()
            .expect("canonical project path")
            .to_string_lossy()
            .into_owned();
        deployment.environment = "deployment".to_string();
        deployment.status = "needs_action".to_string();
        deployment.current_stage = "server".to_string();
        deployment.issue_code = Some("AD-NET-201".to_string());
        deployment.action_kind = Some("deployment-path-route-check".to_string());
        deployment.artifacts.push(DeploymentArtifact {
            service: "web".to_string(),
            image: "registry.example.com/sample/web".to_string(),
            digest: format!("sha256:{}", "a".repeat(64)),
        });
        state
            .remember_project(directory.path(), "sample", true, 1)
            .expect("remember project");
        state
            .save_deployment_run(&deployment)
            .expect("save interrupted run");

        let repaired =
            prepare_deployment_path_retry_inner(deployment.id, "routes".to_string(), &state)
                .expect("prepare route retry");

        assert_eq!(repaired.current_stage, "server");
        assert_eq!(repaired.artifacts.len(), 1);
        assert_eq!(repaired.issue_code, None);
        assert_eq!(
            repaired.action_kind.as_deref(),
            Some("deployment-path-retry")
        );
        assert!(repaired.message.contains("访问地址"));
    }

    #[test]
    fn interrupted_first_route_check_preserves_the_deployed_version() {
        let mut deployment = run();
        deployment.environment = "production".to_string();
        deployment.status = "success".to_string();
        deployment.current_stage = "complete".to_string();
        deployment.artifacts.push(DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:abc".to_string(),
        });

        pause_public_route_inspection(&mut deployment, "本机网络暂时不可用");

        assert_eq!(deployment.status, "needs_action");
        assert_eq!(deployment.action_kind.as_deref(), Some("route-check"));
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-NET-202"));
        assert_eq!(deployment.artifacts.len(), 1);
        assert!(deployment.message.contains("服务已经部署"));
        assert!(deployment.message.contains("网络恢复后会自动继续"));
    }

    #[test]
    fn certificate_retry_requires_dns_ready_https_only_failures() {
        let status = |host: &str, phase: &str, reachable: bool| PublicRouteStatus {
            host: host.to_string(),
            url: format!("https://{host}/"),
            phase: phase.to_string(),
            reachable,
            http_status: reachable.then_some(200),
            message: String::new(),
        };
        assert!(certificate_retry_allowed(&[
            status("app.example.com", "ready", true),
            status("api.example.com", "https", false),
        ]));
        assert!(!certificate_retry_allowed(&[status(
            "app.example.com",
            "dns",
            false,
        )]));
        assert!(!certificate_retry_allowed(&[status(
            "app.example.com",
            "application",
            false,
        )]));
        assert!(!certificate_retry_allowed(&[status(
            "app.example.com",
            "ready",
            true,
        )]));
    }

    #[test]
    fn certificate_retry_validates_and_force_reloads_without_redeploying_services() {
        let encoded_hosts = BASE64.encode(b"app.example.com\napi.example.com\n");
        let script = caddy_certificate_reload_script(
            "sample-production.caddy",
            &encoded_hosts,
            "203.0.113.10",
        );
        assert!(script.contains("server-deploy.lock"));
        assert!(script.contains("getent ahosts"));
        assert!(script.contains("不再指向绑定服务器"));
        assert!(script.contains("caddy validate"));
        assert!(script.contains("caddy reload --force"));
        assert!(script.contains("sample-production.caddy"));
        assert!(!script.contains("docker restart"));
        assert!(!script.contains("docker compose"));
        assert!(!script.contains("certificates/acme"));
        let lock = script.find("flock -w 60").expect("server lock");
        let dns = script.find("getent ahosts").expect("locked DNS recheck");
        let reload = script.find("caddy reload --force").expect("forced reload");
        assert!(lock < dns && dns < reload);
    }

    #[test]
    fn route_activation_transfers_untrusted_rows_as_base64_data() {
        let malicious =
            "safe.example.com\tsample-production-api:3000\nABCDEPLOY_ROUTES\nprintf injected >&2";
        let script =
            server_route_activation_script("sample-production.caddy", &[malicious.to_string()]);

        assert!(script.contains("base64 --decode"));
        assert!(script.contains("ROUTES_FILE"));
        assert!(!script.contains("<<'ABCDEPLOY_ROUTES'"));
        assert!(!script.contains(malicious));
        assert!(!script.contains("printf injected >&2"));
    }

    #[test]
    fn caddy_route_detection_normalizes_shared_site_addresses() {
        let directory = tempdir().expect("temp Caddy fixture");
        let config = directory.path().join("Caddyfile");
        fs::write(
            &config,
            r"{
	admin off
}

https://API.EXAMPLE.COM.:443, legacy.example.com {
	reverse_proxy old-api:3000
}
",
        )
        .expect("write Caddy fixture");
        let script = format!(
            "set -eu\n{}\nroute_declared_in_file api.example.com \"$CONFIG\"\nroute_declared_in_file LEGACY.EXAMPLE.COM. \"$CONFIG\"\n! route_declared_in_file missing.example.com \"$CONFIG\"\n",
            caddy_route_declared_shell_function()
        );
        let output = Command::new("bash")
            .args(["-c", &script])
            .env("CONFIG", &config)
            .output()
            .expect("run Caddy route detector");

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn caddy_takeover_rewrites_only_target_addresses_and_is_idempotent() {
        let directory = tempdir().expect("temp Caddy fixture");
        let original = directory.path().join("Caddyfile.original");
        let hosts = directory.path().join("hosts");
        let first = directory.path().join("Caddyfile.first");
        let second = directory.path().join("Caddyfile.second");
        fs::write(
            &original,
            r"{
	admin off
}

https://API.EXAMPLE.COM.:443, legacy.example.com {
	reverse_proxy old-api:3000
}

ocr.example.com {
	reverse_proxy old-ocr:8000
}

untouched.example.com {
	respond 200
}
",
        )
        .expect("write Caddy fixture");
        fs::write(&hosts, "api.example.com\nOCR.EXAMPLE.COM.\n").expect("write takeover hosts");
        let script = format!(
            "set -eu\n{}\nrewrite_caddy_main_routes \"$HOSTS\" \"$INPUT\" \"$FIRST\"\nrewrite_caddy_main_routes \"$HOSTS\" \"$FIRST\" \"$SECOND\"\n",
            caddy_main_route_rewrite_shell_function()
        );
        let output = Command::new("bash")
            .args(["-c", &script])
            .env("HOSTS", &hosts)
            .env("INPUT", &original)
            .env("FIRST", &first)
            .env("SECOND", &second)
            .output()
            .expect("run Caddy route takeover rewrite");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let first_content = fs::read_to_string(&first).expect("read rewritten Caddyfile");
        let second_content = fs::read_to_string(&second).expect("read idempotent Caddyfile");
        assert!(
            !first_content
                .to_ascii_lowercase()
                .contains("api.example.com")
        );
        assert!(!first_content.contains("ocr.example.com"));
        assert!(first_content.contains("legacy.example.com {"));
        assert!(first_content.contains("reverse_proxy old-api:3000"));
        assert!(first_content.contains("untouched.example.com"));
        assert!(first_content.contains("respond 200"));
        assert_eq!(first_content, second_content);
    }

    #[test]
    fn routing_manifest_validation_rejects_a_host_with_embedded_commands() {
        let raw = r#"version: 1
project: { name: sample }
source: { provider: local, repository: "", release_branch: main }
services:
  - id: api
    kind: api
    image: sample-api
    context: .
    dockerfile: Dockerfile
    container_port: 3000
    healthcheck: { path: /health }
environments:
  development: { target: { kind: local, namespace: sample-development } }
  staging:
    target: { kind: server, server: default, namespace: sample-staging }
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.staging.yml
    domains: []
  production:
    target: { kind: server, server: default, namespace: sample-production }
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.production.yml
    domains: [{ service: api, host: app.example.com, path: / }]
providers:
  build: { kind: cnb, repository: team/sample }
  registry: { kind: cnb, repository: team/sample }
"#;
        let mut manifest = deploy_core::parse_manifest(raw, Path::new("deploy.yaml"))
            .expect("parse routing manifest");
        let mut unsafe_project = manifest.clone();
        unsafe_project.project.name = "sample\nABCDEPLOY_HOSTS\nprintf injected >&2".to_string();
        let project_error = validate_deployment_routing_manifest(&unsafe_project, "当前项目")
            .expect_err("unsafe project name must be rejected before SSH");
        assert!(project_error.contains("当前项目"));
        assert!(!project_error.contains("printf injected"));

        manifest.environments.production.domains[0].host =
            "app.example.com\nprintf injected >&2".to_string();

        let error = validate_deployment_routing_manifest(&manifest, "当前项目")
            .expect_err("unsafe host must be rejected before SSH");

        assert!(error.contains("当前项目"));
        assert!(error.contains("域名只填写主机名"));
        assert!(!error.contains("printf injected"));
    }

    #[test]
    fn interrupted_route_checks_use_the_check_phase_contract() {
        let production = interrupted_public_route_status("app.example.com", "/health");
        assert_eq!(production.phase, "check");
        assert_eq!(production.url, "https://app.example.com/health");
        assert_eq!(
            interrupted_route_check_message(std::slice::from_ref(&production)).as_deref(),
            Some("app.example.com 的地址检查被中断，请重新检查")
        );

        let staging = interrupted_public_route_status("app.203-0-113-10.sslip.io", "/");
        assert_eq!(staging.phase, "check");
        assert_eq!(staging.url, "http://app.203-0-113-10.sslip.io/");
    }

    #[test]
    fn multiple_public_route_failures_are_reported_together() {
        let mut deployment = run();
        deployment.status = "success".to_string();
        deployment.completed_steps.push("healthcheck".to_string());
        apply_public_route_checks(
            &mut deployment,
            &[
                PublicRouteStatus {
                    host: "app.example.com".to_string(),
                    url: "https://app.example.com/".to_string(),
                    reachable: false,
                    phase: "dns".to_string(),
                    http_status: None,
                    message: "app.example.com 尚未解析，请添加 A 记录".to_string(),
                },
                PublicRouteStatus {
                    host: "api.example.com".to_string(),
                    url: "https://api.example.com/".to_string(),
                    reachable: false,
                    phase: "dns".to_string(),
                    http_status: None,
                    message: "api.example.com 尚未解析，请添加 A 记录".to_string(),
                },
            ],
        );

        assert_eq!(deployment.status, "needs_action");
        assert!(deployment.message.contains("2 个访问地址暂未就绪"));
        assert!(deployment.message.contains("app.example.com 尚未解析"));
        assert!(deployment.message.contains("api.example.com 尚未解析"));
        assert!(deployment.message.contains("应用已经部署成功"));
    }

    #[test]
    fn every_route_attention_state_rechecks_public_addresses() {
        for action in ["route-check", "route-repair", "route-takeover"] {
            assert!(deployment_needs_public_route_recheck(Some(action)));
        }
        assert!(!deployment_needs_public_route_recheck(Some("cnb-auth")));
        assert!(!deployment_needs_public_route_recheck(None));
    }

    #[test]
    fn route_problems_are_kept_per_address_and_takeover_wins_over_repair() {
        let ready = |host: &str| PublicRouteStatus {
            host: host.to_string(),
            url: format!("https://{host}/"),
            reachable: true,
            phase: "ready".to_string(),
            http_status: Some(200),
            message: format!("{host} 可以访问"),
        };
        let mut checks = vec![
            ready("api.example.com"),
            ready("h5.example.com"),
            ready("ocr.example.com"),
        ];
        let problems = vec![
            ServerRouteProblem {
                kind: ServerRouteProblemKind::Takeover,
                host: "api.example.com".to_string(),
                message: "api.example.com 仍由旧服务提供".to_string(),
            },
            ServerRouteProblem {
                kind: ServerRouteProblemKind::Repair,
                host: "h5.example.com".to_string(),
                message: "h5.example.com 尚未启用".to_string(),
            },
        ];

        overlay_server_route_problems(&mut checks, &problems);

        assert_eq!(checks[0].phase, "route-conflict");
        assert!(!checks[0].reachable);
        assert_eq!(checks[1].phase, "route-missing");
        assert!(!checks[1].reachable);
        assert_eq!(checks[2].phase, "ready");
        assert!(checks[2].reachable);

        let mut deployment = run();
        deployment.status = "success".to_string();
        assert!(apply_server_route_problems(&mut deployment, &problems));
        assert_eq!(deployment.action_kind.as_deref(), Some("route-takeover"));
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-SRV-206"));
        assert!(deployment.message.contains("api.example.com"));
        assert!(
            deployment
                .message
                .contains("另外 1 个未冲突地址尚未启用，可以先单独恢复")
        );
    }

    #[test]
    fn missing_caddy_route_requires_a_route_only_repair() {
        let mut deployment = run();
        deployment.status = "success".to_string();
        deployment.completed_steps.push("healthcheck".to_string());

        apply_server_route_problem(&mut deployment, "app.example.com 还没有加载到统一 Caddy");

        assert_eq!(deployment.status, "needs_action");
        assert_eq!(deployment.action_kind.as_deref(), Some("route-repair"));
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-SRV-209"));
        assert_eq!(deployment.current_stage, "prepare-server");
        assert!(deployment.message.contains("正式地址没有生效"));
        assert!(deployment.message.contains("app.example.com"));
        assert!(
            !deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
    }

    #[test]
    fn an_old_main_caddy_route_requires_explicit_takeover() {
        let mut deployment = run();
        deployment.status = "success".to_string();
        deployment.completed_steps.push("healthcheck".to_string());

        apply_server_route_takeover_problem(
            &mut deployment,
            "app.example.com 仍转发到 sample-api，应切换到 sample-production-api",
        );

        assert_eq!(deployment.status, "needs_action");
        assert_eq!(deployment.action_kind.as_deref(), Some("route-takeover"));
        assert_eq!(deployment.issue_code.as_deref(), Some("AD-SRV-206"));
        assert!(deployment.message.contains("仍指向旧服务"));
        assert!(
            !deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
    }

    #[test]
    fn successful_route_recheck_restores_the_completed_state() {
        let mut deployment = run();
        deployment.status = "needs_action".to_string();
        deployment.current_stage = "healthcheck".to_string();
        deployment.action_kind = Some("route-check".to_string());
        deployment.issue_code = Some("AD-NET-201".to_string());

        apply_public_route_checks(
            &mut deployment,
            &[PublicRouteStatus {
                host: "app.example.com".to_string(),
                url: "https://app.example.com/".to_string(),
                reachable: true,
                phase: "ready".to_string(),
                http_status: Some(200),
                message: "app.example.com 可以访问".to_string(),
            }],
        );

        assert_eq!(deployment.status, "success");
        assert_eq!(deployment.current_stage, "complete");
        assert_eq!(deployment.action_kind, None);
        assert_eq!(deployment.issue_code, None);
        assert!(
            deployment
                .completed_steps
                .contains(&"healthcheck".to_string())
        );
    }

    #[test]
    fn deployment_path_uses_the_selected_registry_connection_over_stale_manifest_defaults() {
        let project = tempdir().expect("temp project");
        fs::write(
            project.path().join("deploy.yaml"),
            r#"version: 1
project: { name: sample }
source: { provider: local, repository: "", release_branch: main }
services:
  - id: api
    kind: api
    image: sample-api
    context: .
    dockerfile: Dockerfile
    container_port: 3000
    healthcheck: { path: /health }
environments:
  development: { target: { kind: local, namespace: sample-development } }
  staging:
    target: { kind: server, server: default, namespace: sample-staging }
    domains: []
  production:
    target: { kind: server, server: default, namespace: sample-production }
    domains: []
providers:
  build: { kind: cnb, repository: team/sample }
  registry: { kind: tcr, registry: ccr.ccs.tencentyun.com, namespace: replace-me }
"#,
        )
        .expect("write manifest");
        for arguments in [
            vec!["init", "-q"],
            vec!["add", "deploy.yaml"],
            vec![
                "-c",
                "user.name=ABCDeploy Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "snapshot",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(project.path())
                    .args(arguments)
                    .status()
                    .expect("run git")
                    .success()
            );
        }
        let revision = git_stdout(project.path(), &["rev-parse", "HEAD"])
            .expect("read revision")
            .trim()
            .to_string();
        let state = WorkspaceState::open(&project.path().join("workspace.sqlite3"))
            .expect("open workspace");
        state
            .upsert_compat_connection(
                "registry-finagent",
                "registry",
                "tcr",
                "腾讯云 TCR",
                Some("registry.tcr.v2.password"),
                &BTreeMap::from([
                    ("endpoint".to_string(), "ccr.ccs.tencentyun.com".to_string()),
                    ("namespace".to_string(), "finagent".to_string()),
                ]),
                &["push".to_string(), "pull".to_string()],
                "ready",
                None,
            )
            .expect("save registry connection");
        let mut deployment = run();
        deployment.project_path = project.path().to_string_lossy().into_owned();
        deployment.commit_sha = Some(revision);
        deployment.environment = "deployment".to_string();
        let path = DeploymentPath {
            id: "path-sample".to_string(),
            project_path: deployment.project_path.clone(),
            name: "上线".to_string(),
            source_connection_id: None,
            registry_connection_id: Some("registry-finagent".to_string()),
            server_id: None,
            config_profile_ids: Vec::new(),
            address: String::new(),
            routes: Vec::new(),
            state: "ready".to_string(),
            last_run_id: None,
            last_successful_revision: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let resolved =
            deployment_path_manifest(&deployment, &path, &state).expect("resolve path manifest");

        assert!(matches!(
            resolved.providers.registry,
            RegistryConfig::Tcr { ref registry, ref namespace }
                if registry == "ccr.ccs.tencentyun.com" && namespace == "finagent"
        ));
    }

    #[test]
    fn deployment_checks_use_the_committed_manifest_snapshot() {
        let project = tempdir().expect("temp project");
        let manifest = |host: &str| {
            format!(
                r#"version: 1
project: {{ name: sample }}
source: {{ provider: local, repository: "", release_branch: main }}
services:
  - id: api
    kind: api
    image: sample-api
    context: .
    dockerfile: Dockerfile
    container_port: 3000
    healthcheck: {{ path: /health }}
environments:
  development: {{ target: {{ kind: local, namespace: sample-development }} }}
  staging:
    target: {{ kind: server, server: default, namespace: sample-staging }}
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.staging.yml
    domains: []
  production:
    target: {{ kind: server, server: default, namespace: sample-production }}
    approval_required: true
    secrets_ref: https://cnb.cool/team/sample-secrets/-/blob/main/env.production.yml
    domains: [{{ service: api, host: {host}, path: / }}]
providers:
  build: {{ kind: cnb, repository: team/sample }}
  registry: {{ kind: cnb, repository: team/sample }}
"#
            )
        };
        fs::write(
            project.path().join("deploy.yaml"),
            manifest("old.example.com"),
        )
        .expect("write committed manifest");
        for arguments in [
            vec!["init", "-q"],
            vec!["add", "deploy.yaml"],
            vec![
                "-c",
                "user.name=ABCDeploy Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "snapshot",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(project.path())
                    .args(arguments)
                    .status()
                    .expect("run git")
                    .success()
            );
        }
        let revision = String::from_utf8(
            Command::new("git")
                .current_dir(project.path())
                .args(["rev-parse", "HEAD"])
                .output()
                .expect("read revision")
                .stdout,
        )
        .expect("utf8 revision");
        fs::write(
            project.path().join("deploy.yaml"),
            manifest("ocr.example.com"),
        )
        .expect("write newer working tree manifest");
        let mut deployment = run();
        deployment.project_path = project.path().to_string_lossy().into_owned();
        deployment.commit_sha = Some(revision.trim().to_string());
        deployment.environment = "production".to_string();

        let snapshot = deployment_manifest(&deployment).expect("load committed snapshot");
        assert_eq!(
            snapshot.environments.production.domains[0].host,
            "old.example.com"
        );
        let routing = deployment_routing_manifest(&deployment).expect("load current routes");
        assert_eq!(
            routing.environments.production.domains[0].host,
            "ocr.example.com"
        );

        let mut newer_manifest =
            deploy_core::parse_manifest(&manifest("ocr.example.com"), Path::new("deploy.yaml"))
                .expect("parse newer manifest");
        let mut ocr = newer_manifest.services[0].clone();
        ocr.id = "ocr".to_string();
        ocr.image = "sample-ocr".to_string();
        newer_manifest.services.push(ocr);
        newer_manifest.environments.production.domains[0].service = "ocr".to_string();
        fs::write(
            project.path().join("deploy.yaml"),
            serialize_manifest(&newer_manifest).expect("serialize newer manifest"),
        )
        .expect("write route for a service absent from the candidate");
        let mismatch = deployment_routing_manifest(&deployment)
            .expect_err("new services require a new test candidate");
        assert!(mismatch.starts_with("AD-REL-204：ocr"));

        let mut unsafe_manifest = newer_manifest;
        unsafe_manifest.environments.production.domains[0].host =
            "ocr.example.com\nABCDEPLOY_ROUTES".to_string();
        fs::write(
            project.path().join("deploy.yaml"),
            serialize_manifest(&unsafe_manifest).expect("serialize unsafe manifest"),
        )
        .expect("write unsafe current manifest");
        let unsafe_current = deployment_routing_manifest(&deployment)
            .expect_err("current manifest must be validated before route inspection");
        assert!(unsafe_current.starts_with("当前项目的 deploy.yaml 未通过安全校验"));
        assert!(!unsafe_current.contains("ABCDEPLOY_ROUTES"));

        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args(["add", "deploy.yaml"])
                .status()
                .expect("stage unsafe manifest")
                .success()
        );
        assert!(
            Command::new("git")
                .current_dir(project.path())
                .args([
                    "-c",
                    "user.name=ABCDeploy Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-qm",
                    "unsafe snapshot",
                ])
                .status()
                .expect("commit unsafe manifest")
                .success()
        );
        deployment.commit_sha = Some(
            String::from_utf8(
                Command::new("git")
                    .current_dir(project.path())
                    .args(["rev-parse", "HEAD"])
                    .output()
                    .expect("read unsafe revision")
                    .stdout,
            )
            .expect("utf8 unsafe revision")
            .trim()
            .to_string(),
        );
        let unsafe_deployed = deployment_routing_manifest(&deployment)
            .expect_err("deployed manifest must also be validated");
        assert!(unsafe_deployed.starts_with("已部署版本的 deploy.yaml 未通过安全校验"));
        assert!(!unsafe_deployed.contains("ABCDEPLOY_ROUTES"));
    }

    #[test]
    fn reusable_connections_only_fill_empty_runtime_values() {
        let template = concat!(
            "# 项目原始注释\n",
            "MINIMAX_API_KEY=\n",
            "MINIMAX_BASE_URL=https://custom.example/v1\n",
            "UNKNOWN_VALUE=''\n",
        );
        let suggestions = BTreeMap::from([
            (
                "MINIMAX_API_KEY".to_string(),
                "secret-with-$-value".to_string(),
            ),
            (
                "MINIMAX_BASE_URL".to_string(),
                "https://api.minimax.chat/v1".to_string(),
            ),
            ("UNKNOWN_VALUE".to_string(), "preserved".to_string()),
            ("NOT_IN_TEMPLATE".to_string(), "ignored".to_string()),
        ]);

        let (content, filled) = fill_empty_runtime_values(template, &suggestions);
        assert!(content.starts_with("# 项目原始注释\n"));
        assert!(content.contains("MINIMAX_API_KEY=\"secret-with-$-value\""));
        assert!(content.contains("MINIMAX_BASE_URL=https://custom.example/v1"));
        assert!(content.contains("UNKNOWN_VALUE=\"preserved\""));
        assert!(!content.contains("NOT_IN_TEMPLATE"));
        assert_eq!(filled, vec!["MINIMAX_API_KEY", "UNKNOWN_VALUE"]);
    }

    #[test]
    fn local_env_generation_requires_confirmation_and_keeps_a_backup() {
        let project = tempdir().expect("project");
        fs::write(project.path().join(".env"), "OLD=value\n").expect("existing env");

        let preview = write_project_local_env(project.path(), "NEW=value\n", false)
            .expect("preview overwrite");
        assert!(preview.requires_confirmation);
        assert!(!preview.written);
        assert_eq!(
            fs::read_to_string(project.path().join(".env")).expect("unchanged"),
            "OLD=value\n"
        );

        let result =
            write_project_local_env(project.path(), "NEW=value\n", true).expect("confirmed write");
        assert!(result.written);
        assert!(result.backup_path.is_some());
        assert_eq!(
            fs::read_to_string(project.path().join(".env")).expect("new env"),
            "NEW=value\n"
        );
        assert!(
            fs::read_to_string(project.path().join(".gitignore"))
                .expect("gitignore")
                .lines()
                .any(|line| line == ".env")
        );
    }

    #[test]
    fn recognizes_a_broken_docker_proxy_for_automatic_retry() {
        assert_eq!(local_build_proxy_attempts(false), [false, true]);
        assert_eq!(local_build_proxy_attempts(true), [true, false]);
        assert!(looks_like_dependency_network_text(
            "npm error connect ECONNREFUSED 192.168.65.254:7890"
        ));
        assert!(looks_like_dependency_network_text(
            "Corepack error when performing the request to registry.npmjs.org"
        ));
        assert!(!looks_like_dependency_network_text(
            "TypeScript error: Property name does not exist"
        ));
        assert!(!looks_like_dependency_network_text(
            "ENV npm_config_registry=https://registry.npmmirror.com\nsrc/main.ts: error TS2307"
        ));

        let mut direct_attempts = Vec::new();
        let direct_result = run_local_build_with_recovery(false, |clear_proxy| {
            direct_attempts.push(clear_proxy);
            Command::new("sh")
                .args(if clear_proxy {
                    ["-c", "exit 0"]
                } else {
                    ["-c", "echo ECONNREFUSED >&2; exit 1"]
                })
                .output()
        })
        .expect("fallback to direct build");
        assert_eq!(direct_attempts, [false, true]);
        assert!(direct_result.output.status.success());
        assert!(direct_result.clear_proxy);
        assert!(direct_result.switched_mode);

        let mut proxy_attempts = Vec::new();
        let proxy_result = run_local_build_with_recovery(true, |clear_proxy| {
            proxy_attempts.push(clear_proxy);
            Command::new("sh")
                .args(if clear_proxy {
                    ["-c", "echo network timeout >&2; exit 1"]
                } else {
                    ["-c", "exit 0"]
                })
                .output()
        })
        .expect("fallback to configured proxy");
        assert_eq!(proxy_attempts, [true, false]);
        assert!(proxy_result.output.status.success());
        assert!(!proxy_result.clear_proxy);
        assert!(proxy_result.switched_mode);

        let port_conflict = Command::new("sh")
            .args([
                "-c",
                "echo 'Bind for 127.0.0.1:3000 failed: port is already allocated' >&2; exit 1",
            ])
            .output()
            .expect("port conflict output");
        assert!(local_start_failure(&port_conflict).starts_with("AD-LOC-116"));
    }

    #[test]
    fn summarizes_the_failed_local_service_without_exposing_build_output() {
        let summary = local_build_failure_summary(
            r"
#15 5.652 src/live-tool-executor.ts(5,8): error TS2307: Cannot find module '@wx-toolbox/ai-router' or its corresponding type declarations.
#15 5.652 src/tools/tools.service.ts(53,17): error TS18046: 'error' is of type 'unknown'.
5.652 src/live-tool-executor.ts(5,8): error TS2307: Cannot find module '@wx-toolbox/ai-router' or its corresponding type declarations.
DATABASE_URL=postgresql://user:must-not-appear@example/app
target api: failed to solve: process exited with code 2
",
        );

        assert!(summary.contains("后端服务（api）"));
        assert!(summary.contains("2 个 TypeScript 编译问题"));
        assert!(summary.contains("@wx-toolbox/ai-router"));
        assert!(!summary.contains("must-not-appear"));
    }

    #[test]
    fn recognizes_only_abcdeploy_managed_development_port_owners() {
        let owner = parse_managed_local_port_owner("a1b2c3d4e5f6\tfinagent\tdevelopment\n")
            .expect("managed development container");
        assert_eq!(owner.container_id, "a1b2c3d4e5f6");
        assert_eq!(owner.project, "finagent");

        assert!(parse_managed_local_port_owner("a1b2c3d4e5f6\tfinagent\tproduction\n").is_none());
        assert!(
            parse_managed_local_port_owner("not-a-container\tfinagent\tdevelopment\n").is_none()
        );
    }

    #[test]
    fn bypasses_private_credentials_only_for_abcdeploy_generated_builds() {
        let manifest = deploy_core::parse_manifest(
            r"
version: 1
project: { name: sample }
source: { provider: cnb, repository: team/sample, release_branch: main }
services:
  - id: generated
    kind: api
    image: sample-generated
    context: .
    dockerfile: .deploydesk/generated/build/Dockerfile.generated
    container_port: 3000
    healthcheck: { path: /health }
  - id: private
    kind: api
    image: sample-private
    context: .
    dockerfile: Dockerfile.private
    container_port: 3001
    healthcheck: { path: /health }
environments:
  development:
    target: { kind: local, namespace: sample-development }
  staging:
    target: { kind: server, server: default, namespace: sample-staging }
  production:
    target: { kind: server, server: default, namespace: sample-production }
providers:
  build: { kind: cnb, repository: team/sample }
  registry: { kind: tcr, registry: registry.example.com, namespace: team }
",
            Path::new("deploy.yaml"),
        )
        .expect("manifest fixture");

        assert!(services_use_public_generated_dockerfiles(
            &manifest,
            &["generated".to_string()]
        ));
        assert!(!services_use_public_generated_dockerfiles(
            &manifest,
            &["private".to_string()]
        ));
        assert!(!services_use_public_generated_dockerfiles(
            &manifest,
            &["generated".to_string(), "private".to_string()]
        ));
    }

    #[test]
    fn stops_a_silent_local_command_instead_of_waiting_forever() {
        let project = tempdir().expect("project");
        let task = super::LocalStartTask::begin(project.path()).expect("start task");
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        let started = std::time::Instant::now();
        let error = super::run_tracked_local_command(
            &task.key,
            &mut command,
            super::LocalCommandLimits {
                idle: std::time::Duration::from_millis(100),
                total: std::time::Duration::from_secs(2),
            },
        )
        .expect_err("silent command should time out");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn lets_the_user_cancel_a_running_local_command() {
        let project = tempdir().expect("project");
        let task = super::LocalStartTask::begin(project.path()).expect("start task");
        let task_key = task.key.clone();
        let process = std::thread::spawn(move || {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            super::run_tracked_local_command(
                &task_key,
                &mut command,
                super::LocalCommandLimits {
                    idle: std::time::Duration::from_secs(3),
                    total: std::time::Duration::from_secs(4),
                },
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            super::cancel_local_preview_start(project.path().to_string_lossy().into_owned())
                .expect("cancel task")
        );
        let error = process
            .join()
            .expect("command thread")
            .expect_err("cancelled command should stop");
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    }

    #[test]
    fn managed_remote_dependencies_replace_missing_local_or_wrong_protocol_values() {
        let suggestions = BTreeMap::from([
            (
                "DATABASE_URL".to_string(),
                "postgresql://user:secret@infra-postgres:5432/app".to_string(),
            ),
            (
                "REDIS_URL".to_string(),
                "redis://infra-redis:6379/3".to_string(),
            ),
        ]);
        let (content, filled) = fill_managed_runtime_dependencies(
            "DATABASE_URL=mysql://old-db/app\nREDIS_URL=redis://custom-redis:6379/0\n",
            &suggestions,
        );
        assert!(
            content.contains("DATABASE_URL=\"postgresql://user:secret@infra-postgres:5432/app\"")
        );
        assert!(content.contains("REDIS_URL=redis://custom-redis:6379/0"));
        assert_eq!(filled, vec!["DATABASE_URL"]);
    }

    #[test]
    fn deployment_lines_replace_managed_values_when_the_server_changes() {
        let suggestions = BTreeMap::from([
            (
                "DATABASE_URL".to_string(),
                "postgresql://user:new@abcdeploy-postgres:5432/app".to_string(),
            ),
            (
                "REDIS_URL".to_string(),
                "redis://:new@abcdeploy-redis:6379/3".to_string(),
            ),
        ]);
        let managed_keys = suggestions.keys().cloned().collect();

        let (content, replaced) = replace_managed_runtime_dependencies(
            concat!(
                "DATABASE_URL=postgresql://user:old@abcdeploy-postgres:5432/app\n",
                "REDIS_URL=redis://:old@abcdeploy-redis:6379/3\n",
                "API_KEY=keep-me\n",
            ),
            &suggestions,
            &managed_keys,
        );

        assert!(
            content.contains("DATABASE_URL=\"postgresql://user:new@abcdeploy-postgres:5432/app\"")
        );
        assert!(content.contains("REDIS_URL=\"redis://:new@abcdeploy-redis:6379/3\""));
        assert!(content.contains("API_KEY=keep-me"));
        assert_eq!(replaced, vec!["DATABASE_URL", "REDIS_URL"]);
    }

    #[test]
    fn stored_runtime_absorbs_only_safe_non_secret_defaults_and_new_managed_fields() {
        let defaults = runtime_defaults(
            concat!(
                "BAILIAN_TTS_MODEL=cosyvoice-v1\n",
                "BAILIAN_API_KEY=example-secret\n",
                "DATABASE_URL=postgresql://user:pass@localhost/app\n",
            ),
            &BTreeSet::from(["BAILIAN_API_KEY".to_string()]),
        );
        assert_eq!(
            defaults,
            BTreeMap::from([("BAILIAN_TTS_MODEL".to_string(), "cosyvoice-v1".to_string(),)])
        );

        let suggestions = BTreeMap::from([
            ("POSTGRES_DB".to_string(), "swifteng_path".to_string()),
            ("POSTGRES_USER".to_string(), "swifteng_user".to_string()),
        ]);
        let (content, filled) =
            fill_managed_runtime_dependencies("NODE_ENV=production\n", &suggestions);
        assert!(content.contains("POSTGRES_DB=\"swifteng_path\""));
        assert!(content.contains("POSTGRES_USER=\"swifteng_user\""));
        assert_eq!(filled, vec!["POSTGRES_DB", "POSTGRES_USER"]);
    }

    #[test]
    fn existing_project_config_prefers_environment_specific_values() {
        let project = tempdir().expect("project");
        fs::write(project.path().join(".env"), "API_KEY=shared\n").expect("base env");
        fs::write(
            project.path().join(".env.production"),
            "API_KEY=production\n",
        )
        .expect("production env");
        let config = load_existing_project_config(
            project.path().to_string_lossy().into_owned(),
            "production".to_string(),
        )
        .expect("existing config");
        assert_eq!(config.source_files, [".env", ".env.production"]);
        assert!(
            config.content.find("API_KEY=shared").unwrap()
                < config.content.find("API_KEY=production").unwrap()
        );
    }

    #[test]
    fn validates_remote_dependency_identifiers_and_encodes_credentials() {
        assert!(safe_postgres_identifier("sample_staging_user"));
        assert!(!safe_postgres_identifier("Sample-User"));
        assert!(!safe_postgres_identifier("1sample"));
        assert_eq!(url_encode_userinfo("a:b@c"), "a%3Ab%40c");
    }

    #[test]
    fn generates_reliable_local_development_commands_without_changing_release_files() {
        let project = tempdir().expect("project");
        let root = project.path();
        fs::create_dir_all(root.join("apps/api/src")).expect("api source");
        fs::create_dir_all(root.join("apps/h5/src")).expect("h5 source");
        fs::create_dir_all(root.join("apps/ocr/src/finagent_ocr")).expect("ocr source");
        fs::create_dir_all(root.join("infra")).expect("infra");
        fs::write(
            root.join("package.json"),
            r#"{"name":"sample","workspaces":["apps/*"]}"#,
        )
        .expect("root package");
        fs::write(root.join("pnpm-workspace.yaml"), "packages:\n  - apps/*\n").expect("workspace");
        fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").expect("lockfile");
        fs::write(
            root.join("apps/api/package.json"),
            r#"{"name":"@sample/api","scripts":{"dev":"nest start --watch","build":"nest build"},"dependencies":{"@nestjs/core":"1"}}"#,
        )
        .expect("api package");
        fs::write(root.join("apps/api/src/main.ts"), "export {};\n").expect("api main");
        fs::write(
            root.join("apps/h5/package.json"),
            r#"{"name":"@sample/h5","scripts":{"dev":"vite --host 0.0.0.0 --port 10087","build":"vite build"},"dependencies":{"vite":"1"}}"#,
        )
        .expect("h5 package");
        fs::write(root.join("apps/h5/src/main.ts"), "export {};\n").expect("h5 main");
        fs::write(root.join("apps/ocr/requirements.txt"), "fastapi\nuvicorn\n")
            .expect("requirements");
        fs::write(
            root.join("apps/ocr/src/finagent_ocr/main.py"),
            "from fastapi import FastAPI\napp = FastAPI()\n",
        )
        .expect("ocr main");
        for name in ["api", "h5"] {
            fs::write(
                root.join(format!("infra/Dockerfile.{name}")),
                "FROM node:22-slim AS build\nWORKDIR /app\nCOPY . .\n",
            )
            .expect("node dockerfile");
        }
        fs::write(
            root.join("apps/ocr/Dockerfile"),
            "FROM python:3.12-slim\nWORKDIR /app\nCOPY apps/ocr/src ./src\n",
        )
        .expect("ocr dockerfile");

        let inspection = deploy_core::inspect_project(root).expect("inspection");
        let manifest = deploy_core::create_default_manifest(&inspection);
        let generated = deploy_core::render::render_project_files(&manifest)
            .expect("generated deployment files");
        let compose = generated
            .iter()
            .find(|file| file.path == ".deploydesk/generated/development/docker-compose.yml")
            .expect("development compose");
        let compose_path = root.join(&compose.path);
        fs::create_dir_all(compose_path.parent().expect("compose parent"))
            .expect("compose directory");
        fs::write(&compose_path, &compose.content).expect("base compose");

        let hot_path = super::write_local_development_compose(root, &inspection, &manifest)
            .expect("development compose");
        let hot = fs::read_to_string(hot_path).expect("hot compose");
        assert!(hot.contains(
            "corepack pnpm --config.verify-deps-before-run=warn --dir '/app/apps/api' run dev"
        ));
        assert!(hot.contains("10087"));
        assert!(hot.contains("--reload"));
        assert!(hot.contains("apps/api/src"));
        assert!(hot.contains("仅用于本机开发调试"));
        assert!(!compose.content.contains("--reload"));
        assert_eq!(
            super::development_package_command(PackageManager::Pnpm, "apps/customer's api", "dev"),
            "corepack pnpm --config.verify-deps-before-run=warn --dir '/app/apps/customer'\"'\"'s api' run dev"
        );
    }
}
