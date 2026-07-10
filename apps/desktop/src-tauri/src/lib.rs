use std::path::{Path, PathBuf};

use chrono::Utc;
use deploy_core::manifest::{ManifestValidation, validate_manifest};
use deploy_core::model::{DeploymentPlan, InspectionReport, ProviderCheck, SystemPreflight};
use deploy_core::plan::serialize_manifest;
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{
    caddy,
    cnb::{CnbClient, build_serial, summarize_build_status},
    docker, ssh,
};
use deploy_core::redact::redact_text;
use deploy_core::{
    MANIFEST_FILE, apply_plan, build_plan, create_default_manifest, inspect_project, load_manifest,
    parse_manifest,
};
use keyring::Entry;
use serde::Serialize;
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CnbRepositoryResult {
    repository: String,
    visibility: String,
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
    let run = state.create_deployment_run(
        &root,
        &manifest.project.name,
        "staging",
        &manifest.providers.build.repository,
        &manifest.source.release_branch,
    )?;
    state.set_project_step(&root, "deploying")?;
    Ok(trigger_cnb_run(run, "api_trigger_staging", &state).await)
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
    let run = state.create_deployment_run(
        Path::new(&source.project_path),
        &source.project_name,
        "production",
        &source.repository,
        &source.branch,
    )?;
    Ok(trigger_cnb_run(run, "api_trigger_production", &state).await)
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
        Ok(payload) => update_run_from_cnb(&mut run, &payload),
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
    state: &WorkspaceState,
) -> DeploymentRun {
    let result = async {
        let token = Zeroizing::new(resolve_cnb_token(String::new())?);
        let client = CnbClient::new(token.as_str()).map_err(public_error)?;
        let response = client
            .trigger_build(
                &run.repository,
                &run.branch,
                event,
                &format!("ABCDeploy · {} · {}", run.project_name, run.environment),
            )
            .await
            .map_err(public_error)?;
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
    let display_name = ["username", "name", "slug", "nickname"]
        .into_iter()
        .find_map(|key| user.get(key).and_then(serde_json::Value::as_str))
        .unwrap_or("CNB 用户")
        .to_string();
    if persist {
        let entry = Entry::new(KEYRING_SERVICE, "cnb-token").map_err(public_error)?;
        entry.set_password(token.as_str()).map_err(public_error)?;
    }
    Ok(CnbAccount {
        connected: true,
        display_name,
    })
}

#[tauri::command]
async fn get_cnb_account() -> Result<CnbAccount, String> {
    let token = match read_keyring_secret("cnb-token") {
        Ok(value) => Zeroizing::new(value),
        Err(error) if error == "missing" => {
            return Ok(CnbAccount {
                connected: false,
                display_name: "尚未连接".to_string(),
            });
        }
        Err(error) => return Err(public_error(error)),
    };
    let client = CnbClient::new(token.as_str()).map_err(public_error)?;
    let user = client.current_user().await.map_err(public_error)?;
    let display_name = ["username", "name", "slug", "nickname"]
        .into_iter()
        .find_map(|key| user.get(key).and_then(serde_json::Value::as_str))
        .unwrap_or("CNB 用户")
        .to_string();
    Ok(CnbAccount {
        connected: true,
        display_name,
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
            secret_status,
            store_secret,
            delete_secret,
            connect_cnb,
            get_cnb_account,
            create_cnb_repository,
        ])
        .run(tauri::generate_context!())
        .expect("DeployDesk failed to start");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DeploymentRun, stage_key, update_run_from_cnb};

    fn run() -> DeploymentRun {
        DeploymentRun {
            id: "run-1".to_string(),
            project_path: "/tmp/sample".to_string(),
            project_name: "sample".to_string(),
            environment: "staging".to_string(),
            status: "running".to_string(),
            current_stage: "build".to_string(),
            build_serial: Some("42".to_string()),
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
}
