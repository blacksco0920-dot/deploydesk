use std::path::{Path, PathBuf};

use deploy_core::manifest::{ManifestValidation, validate_manifest};
use deploy_core::model::{DeploymentPlan, InspectionReport, ProviderCheck, SystemPreflight};
use deploy_core::plan::serialize_manifest;
use deploy_core::preflight::system_preflight;
use deploy_core::providers::{caddy, cnb::CnbClient, docker, ssh};
use deploy_core::redact::redact_text;
use deploy_core::{
    MANIFEST_FILE, apply_plan, build_plan, create_default_manifest, inspect_project, load_manifest,
    parse_manifest,
};
use keyring::Entry;
use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

const KEYRING_SERVICE: &str = "com.deploydesk.desktop";

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
fn open_project(path: String) -> Result<WorkspacePreview, String> {
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
fn check_docker() -> Result<ProviderCheck, String> {
    docker::check_engine().map_err(public_error)
}

#[tauri::command]
fn check_server(
    name: String,
    host: String,
    user: String,
    key_path: String,
    port: u16,
) -> Result<ProviderCheck, String> {
    ssh::check_connection(&ssh::SshProfile {
        name,
        host,
        user,
        port,
        key_path: PathBuf::from(key_path),
    })
    .map_err(public_error)
}

#[tauri::command]
fn bootstrap_server_caddy(
    name: String,
    host: String,
    user: String,
    key_path: String,
    port: u16,
    confirmed: bool,
) -> Result<ProviderCheck, String> {
    caddy::bootstrap_server(
        &ssh::SshProfile {
            name,
            host,
            user,
            port,
            key_path: PathBuf::from(key_path),
        },
        confirmed,
    )
    .map_err(public_error)
}

#[tauri::command]
fn secret_status(key: String) -> Result<SecretStatus, String> {
    validate_secret_key(&key)?;
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(public_error)?;
    let stored = match entry.get_password() {
        Ok(mut value) => {
            let stored = !value.is_empty();
            value.zeroize();
            stored
        }
        Err(keyring::Error::NoEntry) => false,
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
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(public_error)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(SecretStatus { key, stored: false }),
        Err(error) => Err(public_error(error)),
    }
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
    let entry = Entry::new(KEYRING_SERVICE, "cnb-token").map_err(public_error)?;
    entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => "请重新连接 CNB，并保存令牌后再创建仓库".to_string(),
        other => public_error(other),
    })
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_preflight,
            open_project,
            preview_manifest,
            apply_manifest,
            check_docker,
            check_server,
            bootstrap_server_caddy,
            secret_status,
            store_secret,
            delete_secret,
            connect_cnb,
            create_cnb_repository,
        ])
        .run(tauri::generate_context!())
        .expect("DeployDesk failed to start");
}
