use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use deploy_core::error::DeployError;
use deploy_core::manifest::{ManifestValidation, validate_manifest};
use deploy_core::model::{
    DeploymentPlan, EnvironmentName, InspectionReport, ProviderCheck, PublicRouteCheck,
    RegistryConfig, SystemPreflight,
};
use deploy_core::plan::serialize_manifest;
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{
    caddy,
    cnb::{CnbClient, build_records, build_revision, build_serial, summarize_build_status},
    docker,
    registry::RegistryProvider,
    ssh,
};
use deploy_core::redact::redact_text;
use deploy_core::render::render_project_files;
use deploy_core::{
    MANIFEST_FILE, apply_plan, build_plan, create_default_manifest, inspect_project, load_manifest,
    parse_manifest,
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

use workspace::{DeploymentArtifact, DeploymentRun, RecentProject, ServerResource, WorkspaceState};

const KEYRING_SERVICE: &str = "cloud.finagent.abcdeploy";
const LEGACY_KEYRING_SERVICE: &str = "com.deploydesk.desktop";
static SECRET_CACHE: OnceLock<Mutex<BTreeMap<String, Zeroizing<String>>>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePreview {
    inspection: InspectionReport,
    manifest_yaml: String,
    validation: ManifestValidation,
    plan: DeploymentPlan,
    manifest_exists: bool,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CnbAccount {
    connected: bool,
    display_name: String,
    username: String,
    default_namespace: String,
    namespaces: Vec<CnbNamespace>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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
    stored: bool,
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
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_exists = manifest_path.is_file();
    let manifest = if manifest_exists {
        load_manifest(&manifest_path).map_err(public_error)?
    } else {
        create_default_manifest(&inspection)
    };
    let validation = validate_manifest(&manifest);
    let manifest_yaml = serialize_manifest(&manifest).map_err(public_error)?;
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    state.remember_project(
        &root,
        &inspection.project_name,
        manifest_exists,
        inspection.services.len(),
    )?;
    Ok(WorkspacePreview {
        inspection,
        manifest_yaml,
        validation,
        plan,
        manifest_exists,
    })
}

#[tauri::command]
fn preview_manifest(path: String, manifest_yaml: String) -> Result<WorkspacePreview, String> {
    let root = PathBuf::from(path);
    let inspection = inspect_project(&root).map_err(public_error)?;
    let manifest =
        parse_manifest(&manifest_yaml, Path::new(MANIFEST_FILE)).map_err(public_error)?;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("部署配置仍有必填项或隔离问题，请先处理校验结果".to_string());
    }
    let plan = build_plan(&root, &inspection, &manifest).map_err(public_error)?;
    Ok(WorkspacePreview {
        inspection,
        manifest_yaml,
        validation,
        plan,
        manifest_exists: root.join(MANIFEST_FILE).is_file(),
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
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn set_app_setting(
    key: String,
    value: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    state.set_setting(&key, &value)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn start_staging_deployment(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("部署配置仍有必填项或隔离问题，请先处理校验结果".to_string());
    }
    let mut run = state.create_deployment_run(
        &root,
        &manifest.project.name,
        "staging",
        &manifest.providers.build.repository,
        &manifest.source.release_branch,
    )?;
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
    Ok(trigger_cnb_run(run, "api_trigger_staging", None, &state).await)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn resume_staging_deployment(
    run_id: String,
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
    run.status = "queued".to_string();
    run.current_stage = "prepare".to_string();
    run.action_kind = None;
    run.action_url = None;
    run.message = "持续部署连接已完成，正在请求 CNB 构建".to_string();
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    Ok(trigger_cnb_run(run, "api_trigger_staging", None, &state).await)
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
        return Err(
            "AD-REL-201: 尚未读取到测试环境的镜像摘要，请刷新部署状态或重新验证服务器".to_string(),
        );
    }
    let mut run = state.create_deployment_run(
        Path::new(&source.project_path),
        &source.project_name,
        "production",
        &source.repository,
        &source.branch,
    )?;
    run.commit_sha = Some(revision.clone());
    run.source_run_id = Some(source.id);
    run.candidate_tag = source.candidate_tag;
    state.save_deployment_run(&run)?;
    Ok(trigger_cnb_run(run, "api_trigger_production", Some(&revision), &state).await)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn refresh_deployment(
    run_id: String,
    state: State<'_, WorkspaceState>,
) -> Result<DeploymentRun, String> {
    let mut run = state.deployment_run(&run_id)?;
    if matches!(run.status.as_str(), "success" | "failed" | "cancelled") {
        if run.status == "success" && run.artifacts.is_empty() {
            finalize_successful_deployment(&mut run, &state).await;
            run.updated_at = Utc::now().to_rfc3339();
            state.save_deployment_run(&run)?;
        }
        return Ok(run);
    }
    let Some(serial) = run.build_serial.clone() else {
        run.status = "needs_action".to_string();
        run.issue_code = Some("AD-CNB-202".to_string());
        run.message = "CNB 已接受请求，但没有返回构建编号；请检查最近构建记录".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    };
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            run.status = "needs_action".to_string();
            run.issue_code = Some("AD-CNB-101".to_string());
            run.message = if error == "missing" {
                "CNB 登录已失效，请重新连接后继续".to_string()
            } else {
                public_error(error)
            };
            run.updated_at = Utc::now().to_rfc3339();
            state.save_deployment_run(&run)?;
            return Ok(run);
        }
    };
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    match client.build_status(&run.repository, &serial).await {
        Ok(payload) => {
            if let Some(revision) = build_revision(&payload) {
                run.commit_sha = Some(revision);
            }
            update_run_from_cnb(&mut run, &payload);
            if run.status == "success" {
                verify_public_routes(&mut run).await;
            }
        }
        Err(error) => {
            let message = public_error(error);
            run.status = if message.contains("权限不足") {
                "needs_action".to_string()
            } else {
                "failed".to_string()
            };
            run.issue_code = Some(if message.contains("权限不足") {
                "AD-CNB-103".to_string()
            } else {
                "AD-CNB-204".to_string()
            });
            run.message = message;
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

async fn finalize_successful_deployment(run: &mut DeploymentRun, state: &WorkspaceState) {
    let manifest_path = Path::new(&run.project_path).join(MANIFEST_FILE);
    let manifest = match load_manifest(&manifest_path) {
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
            run.action_kind = Some("verify-release".to_string());
            run.issue_code = Some("AD-REL-201".to_string());
            run.message = message;
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
    verify_public_routes(run).await;
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
        "set -eu; cd \"$HOME\"/{}; test -f .release.env; cat .release.env",
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

async fn verify_public_routes(run: &mut DeploymentRun) {
    let manifest = match load_manifest(Path::new(&run.project_path).join(MANIFEST_FILE).as_path()) {
        Ok(manifest) => manifest,
        Err(error) => {
            run.status = "needs_action".to_string();
            run.current_stage = "healthcheck".to_string();
            run.action_kind = Some("route-check".to_string());
            run.issue_code = Some("AD-NET-201".to_string());
            run.message = format!(
                "应用已部署，但无法读取公网路由配置：{}",
                public_error(error)
            );
            return;
        }
    };
    let Ok(environment) = parse_deploy_environment(&run.environment) else {
        return;
    };
    let routes = &manifest.environments.get(environment).domains;
    if routes.is_empty() {
        return;
    }
    let mut checks = Vec::with_capacity(routes.len());
    for route in routes {
        checks.push(deploy_core::health::check_public_route(&route.host, &route.path).await);
    }
    apply_public_route_checks(run, &checks);
}

fn apply_public_route_checks(run: &mut DeploymentRun, checks: &[PublicRouteCheck]) {
    if let Some(failure) = checks.iter().find(|check| !check.reachable) {
        run.status = "needs_action".to_string();
        run.current_stage = "healthcheck".to_string();
        run.action_kind = Some("route-check".to_string());
        run.action_url = None;
        run.issue_code = Some("AD-NET-201".to_string());
        run.completed_steps.retain(|step| step != "healthcheck");
        run.message.clone_from(&failure.message);
        return;
    }
    if !checks.is_empty() {
        run.message = if run.environment == "production" {
            "生产环境已按测试通过的同一镜像摘要发布，域名和 HTTPS 可访问".to_string()
        } else {
            "测试环境部署完成，域名和 HTTPS 可访问".to_string()
        };
    }
    run.action_kind = None;
    run.issue_code = None;
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
#[allow(clippy::needless_pass_by_value)] // Tauri injects managed state by value.
fn list_active_deployment_runs(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_active_deployment_runs()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
async fn sync_external_deployments(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    let root = PathBuf::from(&path);
    let manifest = load_manifest(&root.join(MANIFEST_FILE)).map_err(public_error)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let payload = client
        .recent_builds(&manifest.providers.build.repository, 30)
        .await
        .map_err(public_error)?;
    let mut imported = Vec::new();
    for record in build_records(&payload) {
        let environment = match record.event.as_str() {
            "tag_deploy.staging" => "staging",
            "tag_deploy.production" => "production",
            _ => continue,
        };
        if state
            .deployment_run_by_serial(&manifest.providers.build.repository, &record.serial)?
            .is_some()
        {
            continue;
        }
        let mut run = state.create_deployment_run(
            &root,
            &manifest.project.name,
            environment,
            &manifest.providers.build.repository,
            &manifest.source.release_branch,
        )?;
        run.build_serial = Some(record.serial);
        run.commit_sha = record.revision.clone();
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
        run.started_at = record
            .created_at
            .filter(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        run.updated_at.clone_from(&run.started_at);
        apply_history_status(&mut run, &record.status);
        run.message = if run.status == "success" {
            if environment == "production" {
                "已同步手机端完成的正式发布".to_string()
            } else {
                "已同步 CNB 完成的测试部署".to_string()
            }
        } else if run.status == "running" || run.status == "queued" {
            format!(
                "已同步 CNB 页面触发的{}任务",
                if environment == "production" {
                    "正式发布"
                } else {
                    "测试部署"
                }
            )
        } else {
            format!(
                "CNB 页面触发的{}任务未完成",
                if environment == "production" {
                    "正式发布"
                } else {
                    "测试部署"
                }
            )
        };
        if run.status == "success" {
            finalize_successful_deployment(&mut run, &state).await;
            if run.status == "success" && environment == "production" {
                run.message = "已同步手机端完成的正式发布，并核对同一镜像摘要".to_string();
            }
        }
        state.save_deployment_run(&run)?;
        imported.push(run);
    }
    imported.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(imported)
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
            run.current_stage = "deploy".to_string();
            run.issue_code = Some("AD-DEP-201".to_string());
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
    state: &WorkspaceState,
) -> DeploymentRun {
    let result = async {
        let token = Zeroizing::new(resolve_cnb_token(String::new())?);
        let client = CnbClient::new(token.as_str()).map_err(public_error)?;
        let response = client
            .trigger_build_at_revision(
                &run.repository,
                &run.branch,
                event,
                &format!("ABCDeploy · {} · {}", run.project_name, run.environment),
                revision,
            )
            .await
            .map_err(public_error)?;
        if let Some(revision) = build_revision(&response) {
            run.commit_sha = Some(revision);
        }
        let serial = if let Some(serial) = build_serial(&response) {
            Some(serial)
        } else {
            let recent = client
                .recent_builds(&run.repository, 1)
                .await
                .map_err(public_error)?;
            recent.pointer("/data/0/sn").and_then(|value| {
                value
                    .as_str()
                    .map(ToString::to_string)
                    .or_else(|| value.as_u64().map(|number| number.to_string()))
            })
        };
        Ok::<Option<String>, String>(serial)
    }
    .await;

    match result {
        Ok(serial) => {
            run.build_serial = serial;
            run.status = "running".to_string();
            run.current_stage = "build".to_string();
            run.action_kind = None;
            run.action_url = None;
            run.issue_code = None;
            run.message = "CNB 已开始构建，关闭应用后也可以继续查看".to_string();
        }
        Err(message) => {
            run.status = if message.contains("权限不足") || message.contains("重新连接") {
                "needs_action".to_string()
            } else {
                "failed".to_string()
            };
            run.issue_code = Some(if message.contains("权限不足") {
                "AD-CNB-103".to_string()
            } else if message.contains("重新连接") {
                "AD-CNB-101".to_string()
            } else {
                "AD-CNB-203".to_string()
            });
            run.message = message;
        }
    }
    run.updated_at = Utc::now().to_rfc3339();
    let _ = state.save_deployment_run(&run);
    run
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
            run.status = "queued".to_string();
            run.issue_code = None;
            run.message = "CNB 正在分配构建资源".to_string();
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

fn stage_key(stage: Option<&str>) -> String {
    let stage = stage.unwrap_or("");
    if stage.contains("安装") || stage.contains("验证") || stage.contains("构建") {
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
        state.remember_server(&profile)?;
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
        state.remember_server(&profile)?;
    }
    Ok(result)
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
fn load_runtime_config(path: String, environment: String) -> Result<RuntimeConfigFile, String> {
    let environment_name = parse_deploy_environment(&environment)?;
    let root = PathBuf::from(path);
    let (template_content, source_files) = runtime_config_template(&root, environment_name)?;
    let key = runtime_config_key(&root, &environment)?;
    let (content, stored) = match read_keyring_secret(&key) {
        Ok(value) if !value.is_empty() => (value, true),
        Ok(mut value) => {
            value.zeroize();
            (template_content.clone(), false)
        }
        Err(error) if error == "missing" => (template_content.clone(), false),
        Err(error) => return Err(error),
    };
    Ok(RuntimeConfigFile {
        filename: runtime_config_filename(&environment),
        environment,
        source_files,
        content,
        template_content,
        stored,
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
    let runtime_file_key = runtime_config_key(&root, &environment)?;
    let has_runtime_file = match read_keyring_secret(&runtime_file_key) {
        Ok(value) if !value.is_empty() => {
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
        let environment_config = manifest.environments.get(environment_name);
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
            "registry.tcr"
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
    let mut content = serde_yaml_ng::to_string(&values).map_err(public_error)?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 在本机生成，仅粘贴到 CNB 密钥仓库 Web 编辑器。\n",
    );
    let filename = format!("env.{environment}.yml");
    Ok(CnbSecretBundle {
        environment,
        file_url: format!("https://cnb.cool/{secret_repository}/-/blob/main/{filename}"),
        filename,
        content,
        missing_variables,
        deploy_key_fingerprint: material.fingerprint,
    })
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
    let mut run = state.create_deployment_run(
        &root,
        &manifest.project.name,
        &environment,
        &manifest.providers.build.repository,
        &manifest.source.release_branch,
    )?;
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
fn secret_status(key: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
    let stored = match read_keyring_secret(&key) {
        Ok(mut value) => {
            let stored = !value.is_empty();
            value.zeroize();
            stored
        }
        Err(error) if error == "missing" => false,
        Err(error) => return Err(public_error(error)),
    };
    Ok(SecretStatus { key, stored })
}

#[tauri::command]
fn store_secret(key: String, mut value: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
    if value.is_empty() {
        return Err("密钥不能为空".to_string());
    }
    let result = write_keyring_secret(&key, &value);
    value.zeroize();
    result?;
    Ok(SecretStatus { key, stored: true })
}

#[tauri::command]
fn delete_secret(key: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
    evict_cached_secret(&key);
    for service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
        let entry = Entry::new(service, &key).map_err(public_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(public_error(error)),
        }
    }
    Ok(SecretStatus { key, stored: false })
}

#[tauri::command]
async fn connect_cnb(token: String, persist: bool) -> Result<CnbAccount, String> {
    let token = Zeroizing::new(token);
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let user = client.current_user().await.map_err(cnb_public_error)?;
    let groups = client.user_groups().await.map_err(cnb_public_error)?;
    if persist {
        write_keyring_secret("cnb-token", token.as_str())?;
    }
    Ok(cnb_account_from_responses(&user, &groups))
}

#[tauri::command]
async fn get_cnb_account() -> Result<CnbAccount, String> {
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) if error == "missing" => {
            return Ok(CnbAccount {
                connected: false,
                display_name: "尚未连接".to_string(),
                username: String::new(),
                default_namespace: String::new(),
                namespaces: Vec::new(),
            });
        }
        Err(error) => return Err(public_error(error)),
    };
    let client = CnbClient::new(token.as_str()).map_err(cnb_public_error)?;
    let user = client.current_user().await.map_err(cnb_public_error)?;
    let groups = client.user_groups().await.map_err(cnb_public_error)?;
    Ok(cnb_account_from_responses(&user, &groups))
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
fn sync_project_to_cnb(
    path: String,
    repository: String,
    branch: String,
    allow_uncommitted: bool,
) -> Result<SourceSyncResult, String> {
    validate_repository_slug(&repository)?;
    validate_git_branch(&branch)?;
    let root = PathBuf::from(path);
    let root = root
        .canonicalize()
        .map_err(|error| format!("项目目录无法读取：{error}"))?;
    let git_root = git_stdout(&root, &["rev-parse", "--show-toplevel"])?;
    let canonical_git_root = PathBuf::from(git_root.trim())
        .canonicalize()
        .map_err(public_error)?;
    if canonical_git_root != root {
        return Err("请选择 Git 仓库根目录后再部署".to_string());
    }
    let allowed = deployment_owned_paths(&root);
    let status = git_stdout(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    let unrelated = status
        .lines()
        .filter_map(status_path)
        .filter(|path| !is_deployment_owned_path(path) && !is_deployment_internal_path(path))
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

    let mut committed = false;
    if !allowed.is_empty() {
        let mut add = Command::new("git");
        add.current_dir(&root).arg("add").arg("--");
        add.args(&allowed);
        run_git_command(add, "暂存部署配置")?;

        let staged = Command::new("git")
            .current_dir(&root)
            .args(["diff", "--cached", "--quiet"])
            .status()
            .map_err(|error| git_launch_error("检查部署配置", &error))?;
        if !staged.success() {
            let mut commit = Command::new("git");
            commit
                .current_dir(&root)
                .args([
                    "-c",
                    "user.name=ABCDeploy",
                    "-c",
                    "user.email=abcdeploy@localhost",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--only",
                    "-m",
                    "chore: configure ABCDeploy deployment",
                    "--",
                ])
                .args(&allowed);
            run_git_command(commit, "提交部署配置")?;
            committed = true;
        }
    }

    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let credentials = Zeroizing::new(format!("cnb:{}", token.as_str()));
    let authorization = Zeroizing::new(format!(
        "Authorization: Basic {}",
        BASE64.encode(credentials.as_bytes())
    ));
    let remote = format!("https://cnb.cool/{repository}.git");
    let refspec = format!("HEAD:refs/heads/{branch}");
    let mut push = Command::new("git");
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
    let commit_sha = git_stdout(&root, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    Ok(SourceSyncResult {
        repository,
        branch,
        commit_sha,
        committed,
    })
}

fn resolve_cnb_token(mut provided: String) -> Result<String, String> {
    if !provided.trim().is_empty() {
        let token = provided.trim().to_string();
        provided.zeroize();
        return Ok(token);
    }
    provided.zeroize();
    read_keyring_secret("cnb-token").map_err(|error| {
        if error == "missing" {
            "AD-CNB-101：CNB 登录状态已失效，请返回连接步骤重新授权".to_string()
        } else {
            public_error(error)
        }
    })
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
    parse_deploy_environment(environment)?;
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
    parse_deploy_environment(environment)?;
    Ok(format!(
        "runtime-file.{}.{}",
        &project_storage_id(root)[..24],
        environment
    ))
}

fn runtime_config_filename(environment: &str) -> String {
    format!(".env.{environment}")
}

fn runtime_config_template(
    root: &Path,
    environment: EnvironmentName,
) -> Result<(String, Vec<String>), String> {
    let inspection = inspect_project(root).map_err(public_error)?;
    let canonical_root = PathBuf::from(&inspection.project_root);
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
        let manifest_path = canonical_root.join(MANIFEST_FILE);
        let manifest = if manifest_path.exists() {
            load_manifest(&manifest_path).map_err(public_error)?
        } else {
            create_default_manifest(&inspection)
        };
        let generated_path = format!(
            ".deploydesk/generated/{}/.env.example",
            environment.as_str()
        );
        let generated = render_project_files(&manifest)
            .map_err(public_error)?
            .into_iter()
            .find(|file| file.path == generated_path)
            .ok_or_else(|| "无法生成运行配置模板".to_string())?;
        return Ok((generated.content, Vec::new()));
    }

    let source_files = sections
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    if sections.len() == 1 {
        return Ok((sections.remove(0).1, source_files));
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
    Ok((content, source_files))
}

fn project_storage_id(root: &Path) -> String {
    let normalized = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut digest = Sha256::new();
    digest.update(normalized.to_string_lossy().as_bytes());
    format!("{:x}", digest.finalize())
}

fn parse_deploy_environment(value: &str) -> Result<EnvironmentName, String> {
    match value {
        "staging" => Ok(EnvironmentName::Staging),
        "production" => Ok(EnvironmentName::Production),
        _ => Err("持续部署密钥只能用于测试或生产环境".to_string()),
    }
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
        ".github/workflows/sync-cnb.yml",
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
    let output = Command::new("git")
        .current_dir(root)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| git_launch_error("读取 Git 项目", &error))?;
    if !output.status.success() {
        return Err(git_failure("读取 Git 项目", &output.stderr));
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
    Err(git_failure(action, &output.stderr))
}

fn git_launch_error(action: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "当前电脑未安装 Git，请先通过编程工具安装 Git 后重试".to_string()
    } else {
        format!("{action}无法启动：{error}")
    }
}

fn git_failure(action: &str, stderr: &[u8]) -> String {
    let message = redact_text(&String::from_utf8_lossy(stderr));
    format!(
        "{action}未完成：{}",
        message
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Git 返回未知错误")
    )
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
    let (code, message) = match error {
        DeployError::MissingCredential(_) | DeployError::CnbApi { status: 401, .. } => {
            ("AD-CNB-101", "CNB 登录状态已失效，请返回连接步骤重新授权")
        }
        DeployError::Http(error) if error.status().is_some_and(|status| status.as_u16() == 429) => {
            ("AD-CNB-107", "CNB 请求过于频繁，请稍后重新尝试")
        }
        DeployError::Http(_) => ("AD-CNB-102", "暂时无法连接 CNB，请检查网络后重试"),
        DeployError::CnbApi { status: 403, .. } => {
            ("AD-CNB-103", "当前 CNB 令牌或组织角色缺少所需权限")
        }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            list_recent_projects,
            save_project_step,
            forget_project,
            list_servers,
            bind_project_server,
            get_app_setting,
            set_app_setting,
            start_staging_deployment,
            resume_staging_deployment,
            promote_production_deployment,
            refresh_deployment,
            list_deployment_runs,
            list_active_deployment_runs,
            sync_external_deployments,
            preview_manifest,
            apply_manifest,
            check_docker,
            discover_ssh_identities,
            generate_ssh_identity,
            check_server,
            bootstrap_server_caddy,
            prepare_pipeline_identity,
            runtime_secret_status,
            store_runtime_secret,
            generate_runtime_secret,
            load_runtime_config,
            store_runtime_config,
            prepare_cnb_secret_bundle,
            rollback_environment,
            secret_status,
            store_secret,
            delete_secret,
            connect_cnb,
            get_cnb_account,
            create_cnb_repository,
            ensure_cnb_repository,
            enable_cnb_auto_trigger,
            sync_project_to_cnb,
        ])
        .run(tauri::generate_context!())
        .expect("ABCDeploy failed to start");
}

#[cfg(test)]
mod tests {
    use std::{fmt::Write as _, fs, path::Path};

    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        DeploymentRun, apply_public_route_checks, cache_secret, cached_secret,
        cloud_setup_required, cnb_account_from_responses, cnb_public_error, evict_cached_secret,
        existing_cnb_repository, is_deployment_internal_path, is_deployment_owned_path,
        parse_deployment_artifacts, rollback_script, runtime_config_key, runtime_config_template,
        runtime_secret_key, same_artifact_digests, stage_key, update_run_from_cnb,
        validate_git_branch, validate_repository_slug,
    };
    use deploy_core::error::DeployError;
    use deploy_core::model::PublicRouteCheck;

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
            source_run_id: None,
            candidate_tag: None,
            artifacts: Vec::new(),
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
        let other_project =
            runtime_secret_key(second.path(), "staging", "JWT_SECRET").expect("valid runtime key");

        assert_ne!(staging, production);
        assert_ne!(staging, other_project);
        assert!(!staging.contains("JWT_SECRET"));
        assert!(!staging.contains(&first.path().to_string_lossy().to_string()));
        assert!(runtime_secret_key(first.path(), "development", "JWT_SECRET").is_err());
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

        let (content, sources) =
            runtime_config_template(project.path(), deploy_core::model::EnvironmentName::Staging)
                .expect("load runtime template");

        assert_eq!(content, template);
        assert_eq!(sources, [".env.example"]);
        let staging = runtime_config_key(project.path(), "staging").expect("staging key");
        let production = runtime_config_key(project.path(), "production").expect("production key");
        assert_ne!(staging, production);
        assert!(!staging.contains(&project.path().to_string_lossy().to_string()));
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
    }

    #[test]
    fn only_generated_deployment_files_are_owned() {
        for path in [
            "deploy.yaml",
            ".cnb.yml",
            ".cnb/tag_deploy.yml",
            ".github/workflows/sync-cnb.yml",
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
            &[PublicRouteCheck {
                url: "https://app.example.com/".to_string(),
                reachable: false,
                phase: "dns".to_string(),
                status: None,
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
    }
}
