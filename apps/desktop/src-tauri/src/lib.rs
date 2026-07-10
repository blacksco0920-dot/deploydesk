use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use deploy_core::error::DeployError;
use deploy_core::manifest::{ManifestValidation, validate_manifest};
use deploy_core::model::{
    DeploymentPlan, EnvironmentName, InspectionReport, ProviderCheck, RegistryConfig,
    SystemPreflight,
};
use deploy_core::plan::serialize_manifest;
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{
    caddy,
    cnb::{CnbClient, build_revision, build_serial, summarize_build_status},
    docker, ssh,
};
use deploy_core::redact::redact_text;
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

use workspace::{DeploymentRun, RecentProject, ServerResource, WorkspaceState};

const KEYRING_SERVICE: &str = "cloud.finagent.abcdeploy";
const LEGACY_KEYRING_SERVICE: &str = "com.deploydesk.desktop";

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
    let mut run = state.create_deployment_run(
        Path::new(&source.project_path),
        &source.project_name,
        "production",
        &source.repository,
        &source.branch,
    )?;
    run.commit_sha = Some(revision.clone());
    run.source_run_id = Some(source.id);
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
        return Ok(run);
    }
    let Some(serial) = run.build_serial.clone() else {
        run.status = "needs_action".to_string();
        run.message = "CNB 已接受请求，但没有返回构建编号；请检查最近构建记录".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        state.save_deployment_run(&run)?;
        return Ok(run);
    };
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            run.status = "needs_action".to_string();
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
        }
        Err(error) => {
            let message = public_error(error);
            run.status = if message.contains("权限不足") {
                "needs_action".to_string()
            } else {
                "failed".to_string()
            };
            run.message = message;
        }
    }
    run.updated_at = Utc::now().to_rfc3339();
    state.save_deployment_run(&run)?;
    if run.status == "success" && run.environment == "staging" {
        state.set_project_step(Path::new(&run.project_path), "workspace")?;
    }
    Ok(run)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri IPC deserializes owned arguments.
fn list_deployment_runs(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DeploymentRun>, String> {
    state.list_deployment_runs(Path::new(&path))
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
            run.message = "CNB 已开始构建，关闭应用后也可以继续查看".to_string();
        }
        Err(message) => {
            run.status = if message.contains("权限不足") || message.contains("重新连接") {
                "needs_action".to_string()
            } else {
                "failed".to_string()
            };
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
            run.message = current.map_or_else(
                || "CNB 构建失败，请查看经过脱敏的技术日志".to_string(),
                |stage| format!("{stage}未完成，可以从这个阶段重试"),
            );
        }
        "waiting" | "pending" | "queued" => {
            run.status = "queued".to_string();
            run.message = "CNB 正在分配构建资源".to_string();
        }
        _ => {
            run.status = "running".to_string();
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
    if matches!(manifest.providers.registry, RegistryConfig::Tcr { .. }) {
        for (field, key) in [
            ("TCR_USERNAME", "registry.tcr.username"),
            ("TCR_PASSWORD", "registry.tcr.password"),
        ] {
            match read_keyring_secret(key) {
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
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(public_error)?;
    let result = entry.set_password(&value).map_err(public_error);
    value.zeroize();
    result?;
    Ok(SecretStatus { key, stored: true })
}

#[tauri::command]
fn delete_secret(key: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
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
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let user = client.current_user().await.map_err(public_error)?;
    if persist {
        let entry = Entry::new(KEYRING_SERVICE, "cnb-token").map_err(public_error)?;
        entry.set_password(token.as_str()).map_err(public_error)?;
    }
    Ok(cnb_account_from_user(&user))
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
            });
        }
        Err(error) => return Err(public_error(error)),
    };
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let user = client.current_user().await.map_err(public_error)?;
    Ok(cnb_account_from_user(&user))
}

fn cnb_account_from_user(user: &serde_json::Value) -> CnbAccount {
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
    CnbAccount {
        connected: true,
        display_name,
        username,
    }
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
    let client = CnbClient::new(token).map_err(public_error)?;
    client
        .create_repository(&slug, &name, &description, private_repo)
        .await
        .map_err(public_error)?;
    Ok(CnbRepositoryResult {
        repository: format!("{}/{}", slug.trim(), name.trim()),
        visibility: if private_repo { "private" } else { "public" }.to_string(),
    })
}

#[tauri::command]
async fn ensure_cnb_repository(slug: String, name: String) -> Result<CnbProjectSetup, String> {
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let created = match client
        .create_repository(&slug, &name, "由 ABCDeploy 管理的私有构建仓库", true)
        .await
    {
        Ok(_) => true,
        Err(DeployError::CnbApi { status: 409, .. }) => false,
        Err(error) => return Err(public_error(error)),
    };
    Ok(CnbProjectSetup {
        repository: format!("{}/{}", slug.trim(), name.trim()),
        created,
    })
}

#[tauri::command]
async fn enable_cnb_auto_trigger(repository: String) -> Result<ProviderCheck, String> {
    validate_repository_slug(&repository)?;
    let token = Zeroizing::new(resolve_cnb_token(String::new())?);
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    client
        .enable_auto_trigger(&repository)
        .await
        .map_err(public_error)?;
    Ok(ProviderCheck {
        provider: "cnb-auto-trigger".to_string(),
        ok: true,
        summary: "CNB 自动构建已开启".to_string(),
        details: vec!["发布分支的新提交会自动进入测试环境".to_string()],
    })
}

#[tauri::command]
fn sync_project_to_cnb(
    path: String,
    repository: String,
    branch: String,
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
        .filter(|path| !is_deployment_owned_path(path))
        .take(4)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !unrelated.is_empty() {
        return Err(format!(
            "还有未提交的业务代码：{}。请先在编程工具中保存版本，再继续部署",
            unrelated.join("、")
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
            "请重新连接 CNB，并保存令牌后再创建仓库".to_string()
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
    let mut segments = value.split('/');
    let owner = segments.next().unwrap_or_default();
    let repository = segments.next().unwrap_or_default();
    if segments.next().is_some()
        || !valid_repository_segment(owner)
        || !valid_repository_segment(repository)
    {
        return Err("CNB 密钥仓库应填写为 所属组织/仓库名".to_string());
    }
    Ok(())
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
        .map_err(public_error)
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
        "deploy.yaml" | ".cnb.yml" | ".github/workflows/sync-cnb.yml"
    ) || path.starts_with(".deploydesk/generated/")
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
    let current = Entry::new(KEYRING_SERVICE, key).map_err(public_error)?;
    match current.get_password() {
        Ok(value) => return Ok(value),
        Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(public_error(error)),
    }

    let legacy = Entry::new(LEGACY_KEYRING_SERVICE, key).map_err(public_error)?;
    match legacy.get_password() {
        Ok(mut value) => {
            current.set_password(&value).map_err(public_error)?;
            let migrated = value.clone();
            value.zeroize();
            Ok(migrated)
        }
        Err(keyring::Error::NoEntry) => Err("missing".to_string()),
        Err(error) => Err(public_error(error)),
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
            start_staging_deployment,
            resume_staging_deployment,
            promote_production_deployment,
            refresh_deployment,
            list_deployment_runs,
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
    use std::path::Path;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        DeploymentRun, cloud_setup_required, is_deployment_owned_path, rollback_script,
        runtime_secret_key, stage_key, update_run_from_cnb, validate_git_branch,
        validate_repository_slug,
    };

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
            action_kind: None,
            action_url: None,
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
    fn validates_cnb_repositories_and_release_branches() {
        for repository in ["team/project", "abc_1/project.name"] {
            assert!(validate_repository_slug(repository).is_ok());
        }
        for repository in [
            "project",
            "team/project/extra",
            "team/project name",
            "../project",
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
    fn only_generated_deployment_files_are_owned() {
        for path in [
            "deploy.yaml",
            ".cnb.yml",
            ".github/workflows/sync-cnb.yml",
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
}
