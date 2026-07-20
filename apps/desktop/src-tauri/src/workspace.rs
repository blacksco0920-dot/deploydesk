use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use deploy_core::model::PublicRouteStatus;
use deploy_core::providers::ssh::SshProfile;

pub struct WorkspaceState {
    connection: Mutex<Connection>,
}

const PROJECT_ID_FILE: &str = ".deploydesk/state/project-id";
pub const CNB_SOURCE_CONNECTION_ID: &str = "connection-cnb-default";
pub const TCR_REGISTRY_CONNECTION_ID: &str = "connection-tcr-default";

const ADOPTION_PENDING: &str = "pending";
const ADOPTION_FRESH: &str = "fresh";

type ExistingConnectionState = (String, Option<String>, BTreeMap<String, String>);

#[cfg(test)]
type DeploymentRunLinks = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAdoptionRecord {
    pub mode: String,
    pub history_import_after: Option<String>,
    pub fresh_draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionResource {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub name: String,
    pub status: String,
    pub last_checked_at: Option<String>,
    pub capabilities: Vec<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentConnectionBindings {
    pub target_connection_id: Option<String>,
    pub registry_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConnectionBindings {
    pub source_connection_id: Option<String>,
    pub staging: EnvironmentConnectionBindings,
    pub production: EnvironmentConnectionBindings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPath {
    pub id: String,
    pub project_path: String,
    pub name: String,
    pub source_connection_id: Option<String>,
    pub registry_connection_id: Option<String>,
    pub server_id: Option<String>,
    pub config_profile_ids: Vec<String>,
    pub address: String,
    pub routes: Vec<DeploymentPathRoute>,
    pub state: String,
    pub last_run_id: Option<String>,
    pub last_successful_revision: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPathInput {
    pub id: Option<String>,
    pub project_path: String,
    pub name: String,
    pub source_connection_id: Option<String>,
    pub registry_connection_id: Option<String>,
    pub server_id: Option<String>,
    #[serde(default)]
    pub config_profile_ids: Vec<String>,
    pub address: String,
    #[serde(default)]
    pub routes: Vec<DeploymentPathRoute>,
    pub state: Option<String>,
    pub last_run_id: Option<String>,
    pub last_successful_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPathRoute {
    pub service: String,
    pub host: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentAttempt {
    pub id: String,
    pub task_id: String,
    pub ordinal: u32,
    pub status: String,
    pub current_stage: String,
    pub input_snapshot: serde_json::Value,
    pub output: serde_json::Value,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ProjectRelinkIdentity {
    pub name: String,
    pub service_count: u32,
    pub storage_id: String,
    pub repository: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub path: String,
    pub name: String,
    pub current_step: String,
    pub manifest_exists: bool,
    pub service_count: u32,
    pub last_opened_at: String,
    pub path_exists: bool,
    pub latest_status: Option<String>,
    pub latest_environment: Option<String>,
    pub latest_message: Option<String>,
    pub latest_run_id: Option<String>,
    pub latest_source_run_id: Option<String>,
    pub latest_current_stage: Option<String>,
    pub latest_action_kind: Option<String>,
    pub latest_issue_code: Option<String>,
    pub latest_completed_steps: Vec<String>,
    pub latest_updated_at: Option<String>,
    pub active_run_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResource {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub key_path: String,
    pub host_fingerprint: Option<String>,
    pub key_path_exists: bool,
    pub last_checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProfile {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub name: String,
    pub scope: String,
    pub values: BTreeMap<String, String>,
    pub secret_fields: Vec<String>,
    #[serde(default)]
    pub configured_secret_fields: Vec<String>,
    pub is_default: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProfileBinding {
    pub environment: String,
    pub kind: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnvironment {
    pub environment: String,
    pub display_name: String,
    pub status: String,
    pub current_version_key: Option<String>,
    pub current_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRun {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub environment: String,
    pub status: String,
    pub current_stage: String,
    pub build_serial: Option<String>,
    pub commit_sha: Option<String>,
    pub source_title: Option<String>,
    pub source_run_id: Option<String>,
    pub candidate_tag: Option<String>,
    pub artifacts: Vec<DeploymentArtifact>,
    #[serde(default)]
    pub route_checks: Vec<PublicRouteStatus>,
    pub action_kind: Option<String>,
    pub action_url: Option<String>,
    pub issue_code: Option<String>,
    pub repository: String,
    pub branch: String,
    pub message: String,
    pub completed_steps: Vec<String>,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentArtifact {
    pub service: String,
    pub image: String,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionValidation {
    pub version_key: String,
    pub state: String,
    pub run_id: String,
    pub verified_at: String,
}

/// One immutable project version assembled from the first-class version
/// tables. Deployment failures deliberately do not appear here: a version is
/// created only after a successful staging deployment has produced a stable
/// commit or OCI digest identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVersion {
    pub id: String,
    pub version_key: String,
    pub status: String,
    pub commit_sha: Option<String>,
    pub source_title: Option<String>,
    pub source_connection_id: Option<String>,
    pub source_build_id: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub candidate_tag: Option<String>,
    pub staging_run_id: Option<String>,
    pub artifacts: Vec<DeploymentArtifact>,
    pub validation: Option<VersionValidation>,
    pub current_environments: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkspaceState {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(public_storage_error)?;
        }
        let mut connection = Connection::open(path).map_err(public_storage_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS projects (
                   id TEXT PRIMARY KEY,
                   path TEXT NOT NULL UNIQUE,
                   storage_id TEXT NOT NULL,
                   repository_hint TEXT,
                   identity_fingerprint TEXT,
                   name TEXT NOT NULL,
                   current_step TEXT NOT NULL DEFAULT 'inspection',
                   manifest_exists INTEGER NOT NULL DEFAULT 0,
                   service_count INTEGER NOT NULL DEFAULT 0,
                   last_opened_at TEXT NOT NULL,
                   hidden_at TEXT,
                   deployment_adoption_mode TEXT NOT NULL DEFAULT 'pending',
                   external_import_after TEXT,
                   adoption_decided_at TEXT,
                   deployment_fresh_draft INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS projects_recent
                   ON projects(last_opened_at DESC);
                 CREATE TABLE IF NOT EXISTS servers (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   host TEXT NOT NULL,
                   user TEXT NOT NULL,
                   port INTEGER NOT NULL,
                   key_path TEXT NOT NULL,
                   host_fingerprint TEXT,
                   last_checked_at TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   UNIQUE(host, user, port)
                 );
                 CREATE INDEX IF NOT EXISTS servers_recent
                   ON servers(last_checked_at DESC);
                 CREATE TABLE IF NOT EXISTS deployment_runs (
                   id TEXT PRIMARY KEY,
                   project_path TEXT NOT NULL,
                   project_name TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   status TEXT NOT NULL,
                   current_stage TEXT NOT NULL,
                   build_serial TEXT,
                   commit_sha TEXT,
                   source_title TEXT,
                   source_run_id TEXT,
                   candidate_tag TEXT,
                   artifacts TEXT NOT NULL DEFAULT '[]',
                   action_kind TEXT,
                   action_url TEXT,
                   issue_code TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS deployment_runs_project
                   ON deployment_runs(project_path, started_at DESC);
                 CREATE INDEX IF NOT EXISTS deployment_runs_active
                   ON deployment_runs(status, updated_at DESC);
                 CREATE TABLE IF NOT EXISTS deployment_route_checks (
                   run_id TEXT NOT NULL,
                   position INTEGER NOT NULL,
                   host TEXT NOT NULL,
                   url TEXT NOT NULL,
                   phase TEXT NOT NULL,
                   reachable INTEGER NOT NULL,
                   http_status INTEGER,
                   message TEXT NOT NULL,
                   PRIMARY KEY(run_id, position),
                   FOREIGN KEY(run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS project_server_bindings (
                   project_path TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   server_id TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   PRIMARY KEY(project_path, environment),
                   FOREIGN KEY(server_id) REFERENCES servers(id)
                 );
                 CREATE TABLE IF NOT EXISTS app_settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS config_profiles (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   name TEXT NOT NULL,
                   scope TEXT NOT NULL DEFAULT 'any',
                   values_json TEXT NOT NULL,
                   secret_fields_json TEXT NOT NULL DEFAULT '[]',
                   is_default INTEGER NOT NULL DEFAULT 0,
                   updated_at TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS config_profiles_kind
                   ON config_profiles(kind, is_default DESC, updated_at DESC);
                 CREATE TABLE IF NOT EXISTS project_profile_bindings (
                   project_path TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   profile_kind TEXT NOT NULL,
                   profile_id TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   PRIMARY KEY(project_path, environment, profile_id),
                   FOREIGN KEY(profile_id) REFERENCES config_profiles(id)
                 );
                 CREATE INDEX IF NOT EXISTS project_profile_bindings_environment
                   ON project_profile_bindings(project_path, environment, profile_kind);",
            )
            .map_err(public_storage_error)?;
        ensure_server_fingerprint_column(&connection)?;
        ensure_config_profile_scope_column(&connection)?;
        ensure_project_storage_id_column(&connection)?;
        ensure_project_visibility_column(&connection)?;
        ensure_project_adoption_columns(&connection)?;
        ensure_project_profile_binding_schema(&mut connection)?;
        ensure_workspace_model_tables(&connection)?;
        ensure_deployment_path_columns(&connection)?;
        ensure_deployment_run_columns(&connection)?;
        backfill_workspace_model(&mut connection)?;
        sync_compat_provider_connections_from_settings(&connection)?;
        backfill_successful_staging_versions(&connection)?;
        backfill_successful_production_versions(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    pub fn remember_project(
        &self,
        path: &Path,
        name: &str,
        manifest_exists: bool,
        service_count: usize,
    ) -> Result<(), String> {
        self.remember_project_with_identity(
            path,
            name,
            manifest_exists,
            service_count,
            None,
            None,
        )?;
        // Most storage tests predate the user-facing adoption gate and are
        // exercising deployment persistence directly. Keep those fixtures in
        // the managed state; dedicated adoption tests use the production
        // `remember_project_with_identity` path.
        self.continue_existing_deployment(path)?;
        Ok(())
    }

    pub fn remember_project_with_identity(
        &self,
        path: &Path,
        name: &str,
        manifest_exists: bool,
        service_count: usize,
        repository_hint: Option<&str>,
        identity_fingerprint: Option<&str>,
    ) -> Result<(), String> {
        let normalized = normalize_path(path);
        let id = project_id(&normalized);
        let storage_id = project_storage_id(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO projects (
                   id, path, storage_id, repository_hint, identity_fingerprint,
                   name, current_step, manifest_exists, service_count,
                   last_opened_at, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'inspection', ?7, ?8, ?9, ?9)
                 ON CONFLICT(path) DO UPDATE SET
                   repository_hint = COALESCE(excluded.repository_hint, projects.repository_hint),
                   identity_fingerprint = COALESCE(excluded.identity_fingerprint, projects.identity_fingerprint),
                   name = excluded.name,
                   manifest_exists = excluded.manifest_exists,
                   service_count = excluded.service_count,
                   last_opened_at = excluded.last_opened_at,
                   hidden_at = NULL",
                params![
                    id,
                    normalized,
                    storage_id,
                    repository_hint,
                    identity_fingerprint,
                    name,
                    manifest_exists,
                    u32::try_from(service_count).unwrap_or(u32::MAX),
                    now
                ],
            )
            .map_err(public_storage_error)?;
        sync_project_identity_and_environments(&connection, &normalized)?;
        Ok(())
    }

    pub fn list_deployment_paths(&self, path: &Path) -> Result<Vec<DeploymentPath>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, project_path, name, source_connection_id,
                        registry_connection_id, server_id,
                        config_profile_ids_json, address, routes_json, state, last_run_id,
                        last_successful_revision, created_at, updated_at
                 FROM deployment_paths
                 WHERE project_path = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized], deployment_path_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn deployment_path_for_run(&self, run_id: &str) -> Result<DeploymentPath, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT id, project_path, name, source_connection_id,
                        registry_connection_id, server_id,
                        config_profile_ids_json, address, routes_json, state, last_run_id,
                        last_successful_revision, created_at, updated_at
                 FROM deployment_paths
                 WHERE id = (
                   SELECT path_id FROM deployment_path_runs WHERE run_id = ?1
                 )",
                [run_id],
                deployment_path_from_row,
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "找不到这次任务对应的部署线路".to_string())
    }

    pub fn deployment_path_by_id(&self, path_id: &str) -> Result<DeploymentPath, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT id, project_path, name, source_connection_id,
                        registry_connection_id, server_id,
                        config_profile_ids_json, address, routes_json, state, last_run_id,
                        last_successful_revision, created_at, updated_at
                 FROM deployment_paths WHERE id = ?1",
                [path_id],
                deployment_path_from_row,
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "找不到这条部署线路".to_string())
    }

    pub fn list_deployment_path_runs(&self, path_id: &str) -> Result<Vec<DeploymentRun>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT run.id, run.project_path, run.project_name, run.environment, run.status,
                        run.current_stage, run.build_serial, run.commit_sha, run.source_title,
                        run.source_run_id, run.candidate_tag, run.artifacts, run.action_kind,
                        run.action_url, run.issue_code, run.repository, run.branch, run.message,
                        run.completed_steps, run.started_at, run.updated_at
                 FROM deployment_path_runs link
                 JOIN deployment_runs run ON run.id = link.run_id
                 WHERE link.path_id = ?1
                 ORDER BY run.started_at DESC, run.id DESC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([path_id], deployment_run_from_row)
            .map_err(public_storage_error)?;
        let mut runs = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?;
        for run in &mut runs {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(runs)
    }

    pub fn save_deployment_path(
        &self,
        input: DeploymentPathInput,
    ) -> Result<DeploymentPath, String> {
        let normalized = normalize_path(Path::new(&input.project_path));
        let name = input.name.trim();
        if name.is_empty() {
            return Err("请填写线路名称".to_string());
        }
        if name.chars().count() > 40 {
            return Err("线路名称不能超过 40 个字符".to_string());
        }
        let state = input.state.as_deref().unwrap_or("draft");
        if !matches!(
            state,
            "draft" | "ready" | "deploying" | "online" | "needs_action"
        ) {
            return Err("线路状态不正确".to_string());
        }
        let mut profile_ids = input
            .config_profile_ids
            .into_iter()
            .filter(|profile_id| !profile_id.trim().is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        profile_ids.sort();
        let profile_ids_json = serde_json::to_string(&profile_ids).map_err(public_storage_error)?;
        let mut routes = input.routes;
        for route in &mut routes {
            route.service = route.service.trim().to_string();
            route.host = route
                .host
                .trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_ascii_lowercase();
            route.path = route.path.trim().to_string();
            if route.path.is_empty() {
                route.path = "/".to_string();
            }
            validate_deployment_path_route(route)?;
        }
        routes.sort_by(|left, right| {
            (&left.service, &left.host, &left.path).cmp(&(&right.service, &right.host, &right.path))
        });
        routes.dedup();
        let routes_json = serde_json::to_string(&routes).map_err(public_storage_error)?;
        let mut address = input.address.trim().to_string();
        if address.is_empty() {
            address = routes
                .first()
                .map(|route| route.host.clone())
                .unwrap_or_default();
        }
        let now = Utc::now().to_rfc3339();
        let id = input.id.unwrap_or_else(|| {
            let mut hasher = Sha256::new();
            hasher.update(normalized.as_bytes());
            hasher.update(name.as_bytes());
            hasher.update(now.as_bytes());
            format!("path-{}", &format!("{:x}", hasher.finalize())[..16])
        });
        let connection = self.connection.lock().map_err(lock_error)?;
        let project_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE path = ?1)",
                [&normalized],
                |row| row.get::<_, bool>(0),
            )
            .map_err(public_storage_error)?;
        if !project_exists {
            return Err("项目记录不存在，请重新打开项目".to_string());
        }
        if let Some(connection_id) = input.source_connection_id.as_deref() {
            ensure_connection_kind(&connection, connection_id, "source")?;
        }
        if let Some(connection_id) = input.registry_connection_id.as_deref() {
            ensure_connection_kind(&connection, connection_id, "registry")?;
        }
        if let Some(server_id) = input.server_id.as_deref() {
            let exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM servers WHERE id = ?1)",
                    [server_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(public_storage_error)?;
            if !exists {
                return Err("所选运行服务器已经不存在，请重新选择".to_string());
            }
        }
        for profile_id in &profile_ids {
            let exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM config_profiles WHERE id = ?1)",
                    [profile_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(public_storage_error)?;
            if !exists {
                return Err(format!("所选项目配置已经不存在：{profile_id}"));
            }
        }
        connection
            .execute(
                "INSERT INTO deployment_paths (
                   id, project_path, name, source_connection_id,
                   registry_connection_id, server_id,
                   config_profile_ids_json, address, routes_json, state, last_run_id,
                   last_successful_revision, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   source_connection_id = excluded.source_connection_id,
                   registry_connection_id = excluded.registry_connection_id,
                   server_id = excluded.server_id,
                   config_profile_ids_json = excluded.config_profile_ids_json,
                   address = excluded.address,
                   routes_json = excluded.routes_json,
                   state = excluded.state,
                   last_run_id = COALESCE(excluded.last_run_id, deployment_paths.last_run_id),
                   last_successful_revision = COALESCE(
                     excluded.last_successful_revision,
                     deployment_paths.last_successful_revision
                   ),
                   updated_at = excluded.updated_at
                 WHERE deployment_paths.project_path = excluded.project_path",
                params![
                    id,
                    normalized,
                    name,
                    input.source_connection_id,
                    input.registry_connection_id,
                    input.server_id,
                    profile_ids_json,
                    address,
                    routes_json,
                    state,
                    input.last_run_id,
                    input.last_successful_revision,
                    now,
                ],
            )
            .map_err(public_storage_error)?;
        connection
            .query_row(
                "SELECT id, project_path, name, source_connection_id,
                        registry_connection_id, server_id,
                        config_profile_ids_json, address, routes_json, state, last_run_id,
                        last_successful_revision, created_at, updated_at
                 FROM deployment_paths WHERE id = ?1 AND project_path = ?2",
                params![id, normalized],
                deployment_path_from_row,
            )
            .map_err(public_storage_error)
    }

    pub fn delete_deployment_path(&self, path: &Path, path_id: &str) -> Result<bool, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let active = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM deployment_paths
                   WHERE id = ?1 AND project_path = ?2 AND state = 'deploying'
                 )",
                params![path_id, normalized],
                |row| row.get::<_, bool>(0),
            )
            .map_err(public_storage_error)?;
        if active {
            return Err("线路正在上线，完成或停止后才能删除".to_string());
        }
        connection
            .execute(
                "DELETE FROM deployment_paths WHERE id = ?1 AND project_path = ?2",
                params![path_id, normalized],
            )
            .map(|changed| changed > 0)
            .map_err(public_storage_error)
    }

    pub fn bind_deployment_path_run(&self, path_id: &str, run_id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let same_project = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1
                   FROM deployment_paths path
                   JOIN deployment_runs run ON run.id = ?2
                   WHERE path.id = ?1 AND path.project_path = run.project_path
                 )",
                params![path_id, run_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(public_storage_error)?;
        if !same_project {
            return Err("部署线路与当前项目任务不一致".to_string());
        }
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "UPDATE deployment_paths
                 SET last_run_id = ?2, state = 'deploying', updated_at = ?3
                 WHERE id = ?1",
                params![path_id, run_id, now],
            )
            .map_err(public_storage_error)?;
        connection
            .execute(
                "INSERT INTO deployment_path_runs (path_id, run_id, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(run_id) DO UPDATE SET path_id = excluded.path_id",
                params![path_id, run_id, now],
            )
            .map_err(public_storage_error)?;
        Ok(())
    }

    pub fn begin_deployment_attempt(&self, task_id: &str) -> Result<DeploymentAttempt, String> {
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        if let Some(current) = deployment_attempt_optional(&transaction, task_id, true)? {
            transaction.commit().map_err(public_storage_error)?;
            return Ok(current);
        }
        let snapshot_row = transaction
            .query_row(
                "SELECT run.project_path, run.environment, run.repository, run.branch,
                        run.commit_sha, run.source_run_id,
                        path.id, path.name, path.source_connection_id,
                        path.registry_connection_id, path.server_id,
                        path.config_profile_ids_json, path.address, path.routes_json
                 FROM deployment_runs run
                 LEFT JOIN deployment_paths path ON path.last_run_id = run.id
                 WHERE run.id = ?1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                },
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "找不到要执行的部署任务".to_string())?;
        let ordinal = transaction
            .query_row(
                "SELECT COALESCE(MAX(ordinal), 0) + 1
                 FROM deployment_attempts WHERE task_id = ?1",
                [task_id],
                |row| row.get::<_, u32>(0),
            )
            .map_err(public_storage_error)?;
        let mut hasher = Sha256::new();
        hasher.update(task_id.as_bytes());
        hasher.update(ordinal.to_string().as_bytes());
        hasher.update(now.as_bytes());
        let id = format!("attempt-{}", &format!("{:x}", hasher.finalize())[..16]);
        let config_profile_ids = snapshot_row
            .11
            .as_deref()
            .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            .unwrap_or_default();
        let input_snapshot = serde_json::json!({
            "projectPath": snapshot_row.0,
            "adapterChannel": snapshot_row.1,
            "repository": snapshot_row.2,
            "branch": snapshot_row.3,
            "commitSha": snapshot_row.4,
            "sourceTaskId": snapshot_row.5,
            "deploymentPathId": snapshot_row.6,
            "deploymentPathName": snapshot_row.7,
            "sourceConnectionId": snapshot_row.8,
            "registryConnectionId": snapshot_row.9,
            "serverId": snapshot_row.10,
            "configProfileIds": config_profile_ids,
            "address": snapshot_row.12,
            "routes": snapshot_row.13.as_deref()
                .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                .unwrap_or_else(|| serde_json::json!([])),
        });
        let input_snapshot_json =
            serde_json::to_string(&input_snapshot).map_err(public_storage_error)?;
        transaction
            .execute(
                "INSERT INTO deployment_attempts (
                   id, task_id, ordinal, status, current_stage,
                   input_snapshot_json, output_json, started_at,
                   finished_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'running', 'prepare', ?4, '{}', ?5, NULL, ?5, ?5)",
                params![id, task_id, ordinal, input_snapshot_json, now],
            )
            .map_err(public_storage_error)?;
        transaction.commit().map_err(public_storage_error)?;
        Ok(DeploymentAttempt {
            id,
            task_id: task_id.to_string(),
            ordinal,
            status: "running".to_string(),
            current_stage: "prepare".to_string(),
            input_snapshot,
            output: serde_json::json!({}),
            started_at: now.clone(),
            finished_at: None,
            updated_at: now,
        })
    }

    pub fn list_deployment_attempts(
        &self,
        task_id: &str,
    ) -> Result<Vec<DeploymentAttempt>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let task_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deployment_runs WHERE id = ?1)",
                [task_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(public_storage_error)?;
        if !task_exists {
            return Err("找不到这次部署任务".to_string());
        }
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, ordinal, status, current_stage,
                        input_snapshot_json, output_json, started_at,
                        finished_at, updated_at
                 FROM deployment_attempts
                 WHERE task_id = ?1 ORDER BY ordinal ASC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([task_id], deployment_attempt_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    /// Resolve the one-time adoption state for a project without contacting a
    /// provider. A project with no previous `ABCDeploy` files is immediately a
    /// fresh setup; detected deployment files stay pending until the user
    /// explicitly chooses whether to manage or reset them.
    pub fn initialize_project_adoption(
        &self,
        path: &Path,
        detected_existing_deployment: bool,
    ) -> Result<ProjectAdoptionRecord, String> {
        let normalized = normalize_path(path);
        if !detected_existing_deployment {
            let should_start_fresh = {
                let connection = self.connection.lock().map_err(lock_error)?;
                project_adoption_record(&connection, &normalized)?
                    .mode
                    .eq(ADOPTION_PENDING)
            };
            if should_start_fresh {
                // A legacy database can still contain deployment rows even if
                // deploy.yaml/.cnb.yml has since been removed. Starting fresh
                // must clear that local state now; merely hiding it until the
                // draft is saved would let stale history reappear later.
                return self.reset_project_deployment(path);
            }
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        project_adoption_record(&connection, &normalized)
    }

    pub fn project_adoption(&self, path: &Path) -> Result<ProjectAdoptionRecord, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        project_adoption_record(&connection, &normalized)
    }

    /// Continue managing an existing deployment. This changes only the local
    /// adoption gate; the caller may subsequently perform a read-only provider
    /// history sync as a separate, explicit action.
    pub fn continue_existing_deployment(
        &self,
        path: &Path,
    ) -> Result<ProjectAdoptionRecord, String> {
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        let changed = transaction
            .execute(
                "UPDATE projects
                 SET deployment_adoption_mode = 'managed',
                     external_import_after = NULL,
                     adoption_decided_at = ?1,
                     deployment_fresh_draft = 0
                 WHERE path = ?2",
                params![now, normalized],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("项目记录不存在，请重新打开项目".to_string());
        }
        // Opening an upgraded database deliberately leaves legacy release rows
        // unlinked while adoption is pending. Once the user chooses to keep
        // managing that deployment, rebuild only this project's local release
        // model. No provider, server, or project file is touched here.
        backfill_project_release_model(&transaction, &normalized)?;
        let adoption = project_adoption_record(&transaction, &normalized)?;
        transaction.commit().map_err(public_storage_error)?;
        Ok(adoption)
    }

    pub fn mark_project_fresh_draft_saved(&self, path: &Path) -> Result<(), String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let changed = connection
            .execute(
                "UPDATE projects SET deployment_fresh_draft = 0 WHERE path = ?1",
                [&normalized],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("项目记录不存在，请重新打开项目".to_string());
        }
        Ok(())
    }

    /// Forget locally imported deployment state and begin a new local setup.
    /// The transaction deliberately preserves project files, provider
    /// credentials, reusable servers/connections/profiles, and every remote
    /// resource. `external_import_after` is also the tombstone that prevents a
    /// background request started before this reset from resurrecting history.
    pub fn reset_project_deployment(&self, path: &Path) -> Result<ProjectAdoptionRecord, String> {
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        let project_id: String = transaction
            .query_row(
                "SELECT id FROM projects WHERE path = ?1",
                [&normalized],
                |row| row.get(0),
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "项目记录不存在，请重新打开项目".to_string())?;

        transaction
            .execute(
                "UPDATE projects
                 SET deployment_adoption_mode = 'fresh',
                     external_import_after = ?1,
                     adoption_decided_at = ?1,
                     deployment_fresh_draft = 1,
                     current_step = 'inspection'
                 WHERE id = ?2",
                params![now, project_id],
            )
            .map_err(public_storage_error)?;

        // current_version_id/current_deployment_run_id are intentionally not
        // foreign keys in the compatibility schema, so they must be cleared
        // before removing the underlying run and version records.
        transaction
            .execute(
                "UPDATE environments
                 SET status = 'unknown',
                     target_connection_id = NULL,
                     registry_connection_id = NULL,
                     current_version_id = NULL,
                     current_deployment_run_id = NULL,
                     updated_at = ?1
                 WHERE project_id = ?2
                   AND name IN ('staging', 'production')",
                params![now, project_id],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_connection_bindings WHERE project_id = ?1",
                [&project_id],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_server_bindings
                 WHERE project_path = ?1
                   AND environment IN ('staging', 'production')",
                [&normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_profile_bindings
                 WHERE project_path = ?1
                   AND environment IN ('staging', 'production')",
                [&normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM automation_rules WHERE project_id = ?1",
                [&project_id],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM deployment_runs
                 WHERE project_id = ?1 OR project_path = ?2",
                params![project_id, normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute("DELETE FROM versions WHERE project_id = ?1", [&project_id])
            .map_err(public_storage_error)?;

        let setting_prefix = format!("project.{}.", encode_uri_component(&normalized));
        let project_setting_keys = {
            // Do not use LIKE here. Encoded paths contain `%2F`, and `%` is a
            // SQL wildcard that could delete another project's settings.
            let mut statement = transaction
                .prepare(
                    "SELECT key FROM app_settings
                     WHERE substr(key, 1, length(?1)) = ?1",
                )
                .map_err(public_storage_error)?;
            let rows = statement
                .query_map([&setting_prefix], |row| row.get::<_, String>(0))
                .map_err(public_storage_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(public_storage_error)?
        };
        for key in project_setting_keys {
            let Some(suffix) = key.strip_prefix(&setting_prefix) else {
                continue;
            };
            if deployment_setup_setting_suffix(suffix) {
                transaction
                    .execute("DELETE FROM app_settings WHERE key = ?1", [&key])
                    .map_err(public_storage_error)?;
            }
        }

        transaction.commit().map_err(public_storage_error)?;
        Ok(ProjectAdoptionRecord {
            mode: ADOPTION_FRESH.to_string(),
            history_import_after: Some(now),
            fresh_draft: true,
        })
    }

    pub fn project_relink_identity(&self, path: &Path) -> Result<ProjectRelinkIdentity, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT p.name, p.service_count, p.storage_id,
                        COALESCE((SELECT d.repository FROM deployment_runs d
                         WHERE d.project_path = p.path AND d.repository <> ''
                         ORDER BY d.started_at DESC LIMIT 1), p.repository_hint),
                        p.identity_fingerprint
                 FROM projects p WHERE p.path = ?1",
                [normalized],
                |row| {
                    Ok(ProjectRelinkIdentity {
                        name: row.get(0)?,
                        service_count: row.get(1)?,
                        storage_id: row.get(2)?,
                        repository: row.get(3)?,
                        fingerprint: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "原项目记录不存在，请从“所有项目”重新添加".to_string())
    }

    pub fn relink_project(
        &self,
        old_path: &Path,
        new_path: &Path,
        name: &str,
        manifest_exists: bool,
        service_count: usize,
    ) -> Result<String, String> {
        let old_normalized = normalize_path(old_path);
        let new_normalized = normalize_path(new_path);
        if old_normalized == new_normalized {
            return Err("所选位置仍是原来的项目目录".to_string());
        }

        let identity = self.project_relink_identity(old_path)?;
        {
            let connection = self.connection.lock().map_err(lock_error)?;
            let target_project: Option<String> = connection
                .query_row(
                    "SELECT name FROM projects WHERE path = ?1",
                    [&new_normalized],
                    |row| row.get(0),
                )
                .optional()
                .map_err(public_storage_error)?;
            if let Some(target_name) = target_project {
                return Err(format!(
                    "这个文件夹已经作为“{target_name}”添加过，请直接打开它"
                ));
            }
            let conflicting_history: bool = connection
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM deployment_runs WHERE project_path = ?1
                       UNION ALL
                       SELECT 1 FROM project_server_bindings WHERE project_path = ?1
                       UNION ALL
                       SELECT 1 FROM project_profile_bindings WHERE project_path = ?1
                     )",
                    [&new_normalized],
                    |row| row.get(0),
                )
                .map_err(public_storage_error)?;
            if conflicting_history {
                return Err(
                    "这个文件夹已有另一份 ABCDeploy 历史记录，为避免混合配置，暂未重新关联"
                        .to_string(),
                );
            }
        }
        write_project_storage_id(new_path, &identity.storage_id)?;

        let now = Utc::now().to_rfc3339();
        let old_prefix = format!("project.{}.", encode_uri_component(&old_normalized));
        let new_prefix = format!("project.{}.", encode_uri_component(&new_normalized));
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;

        let target_project: Option<String> = transaction
            .query_row(
                "SELECT name FROM projects WHERE path = ?1",
                [&new_normalized],
                |row| row.get(0),
            )
            .optional()
            .map_err(public_storage_error)?;
        if let Some(target_name) = target_project {
            return Err(format!(
                "这个文件夹已经作为“{target_name}”添加过，请直接打开它"
            ));
        }

        let conflicting_history: bool = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM deployment_runs WHERE project_path = ?1
                   UNION ALL
                   SELECT 1 FROM project_server_bindings WHERE project_path = ?1
                   UNION ALL
                   SELECT 1 FROM project_profile_bindings WHERE project_path = ?1
                 )",
                [&new_normalized],
                |row| row.get(0),
            )
            .map_err(public_storage_error)?;
        if conflicting_history {
            return Err(
                "这个文件夹已有另一份 ABCDeploy 历史记录，为避免混合配置，暂未重新关联".to_string(),
            );
        }

        let scoped_settings = {
            let mut statement = transaction
                .prepare("SELECT key, value, updated_at FROM app_settings")
                .map_err(public_storage_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(public_storage_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(public_storage_error)?
                .into_iter()
                .filter(|(key, _, _)| key.starts_with(&old_prefix))
                .collect::<Vec<_>>()
        };

        let changed = transaction
            .execute(
                "UPDATE projects
                 SET path = ?1, name = ?2, manifest_exists = ?3,
                     service_count = ?4, last_opened_at = ?5, hidden_at = NULL
                 WHERE path = ?6",
                params![
                    new_normalized,
                    name,
                    manifest_exists,
                    u32::try_from(service_count).unwrap_or(u32::MAX),
                    now,
                    old_normalized
                ],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("原项目记录不存在，请从“所有项目”重新添加".to_string());
        }
        transaction
            .execute(
                "UPDATE deployment_runs SET project_path = ?1, project_name = ?2
                 WHERE project_path = ?3",
                params![new_normalized, name, old_normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "UPDATE project_server_bindings SET project_path = ?1 WHERE project_path = ?2",
                params![new_normalized, old_normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "UPDATE project_profile_bindings SET project_path = ?1 WHERE project_path = ?2",
                params![new_normalized, old_normalized],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "UPDATE app_settings SET value = ?1, updated_at = ?2
                 WHERE key = 'active-project' AND value = ?3",
                params![new_normalized, now, old_normalized],
            )
            .map_err(public_storage_error)?;

        for (old_key, value, updated_at) in scoped_settings {
            let suffix = old_key
                .strip_prefix(&old_prefix)
                .expect("settings were filtered by the same prefix");
            let new_key = format!("{new_prefix}{suffix}");
            transaction
                .execute("DELETE FROM app_settings WHERE key = ?1", [&old_key])
                .map_err(public_storage_error)?;
            transaction
                .execute(
                    "INSERT INTO app_settings (key, value, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = excluded.updated_at",
                    params![new_key, value, updated_at],
                )
                .map_err(public_storage_error)?;
        }

        transaction.commit().map_err(public_storage_error)?;
        Ok(new_normalized)
    }

    pub fn set_project_step(&self, path: &Path, step: &str) -> Result<(), String> {
        if !valid_step(step) {
            return Err("项目进度状态不正确".to_string());
        }
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let changed = connection
            .execute(
                "UPDATE projects SET current_step = ?1 WHERE path = ?2",
                params![step, normalized],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("项目记录不存在，请重新打开项目".to_string());
        }
        Ok(())
    }

    pub fn list_projects(&self) -> Result<Vec<RecentProject>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.path, p.name, p.current_step, p.manifest_exists,
                        p.service_count, p.last_opened_at,
                        latest.status, latest.environment, latest.message,
                        latest.id, latest.source_run_id, latest.current_stage,
                        latest.action_kind, latest.issue_code,
                        latest.completed_steps, latest.updated_at,
                        (SELECT COUNT(*) FROM deployment_runs d
                          WHERE d.project_path = p.path
                            AND d.status IN ('queued', 'running')
                            AND p.deployment_adoption_mode <> 'pending'
                            AND p.deployment_fresh_draft = 0)
                 FROM projects p
                 LEFT JOIN deployment_runs latest ON latest.id = (
                    SELECT d.id FROM deployment_runs d
                    WHERE d.project_path = p.path
                      AND p.deployment_adoption_mode <> 'pending'
                      AND p.deployment_fresh_draft = 0
                    ORDER BY d.started_at DESC LIMIT 1
                 )
                 WHERE p.hidden_at IS NULL
                 ORDER BY last_opened_at DESC
                 LIMIT 50",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let path: String = row.get(1)?;
                let latest_completed_steps = row
                    .get::<_, Option<String>>(15)?
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default();
                Ok(RecentProject {
                    id: row.get(0)?,
                    path_exists: Path::new(&path).is_dir(),
                    path,
                    name: row.get(2)?,
                    current_step: row.get(3)?,
                    manifest_exists: row.get(4)?,
                    service_count: row.get(5)?,
                    last_opened_at: row.get(6)?,
                    latest_status: row.get(7)?,
                    latest_environment: row.get(8)?,
                    latest_message: row.get(9)?,
                    latest_run_id: row.get(10)?,
                    latest_source_run_id: row.get(11)?,
                    latest_current_stage: row.get(12)?,
                    latest_action_kind: row.get(13)?,
                    latest_issue_code: row.get(14)?,
                    latest_completed_steps,
                    latest_updated_at: row.get(16)?,
                    active_run_count: row.get(17)?,
                })
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn list_connections(&self, kind: Option<&str>) -> Result<Vec<ConnectionResource>, String> {
        if kind.is_some_and(|value| !matches!(value, "source" | "registry" | "server")) {
            return Err("连接类型不正确".to_string());
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, kind, provider, name, status, last_checked_at,
                        capabilities_json, metadata_json
                 FROM connections
                 WHERE ?1 IS NULL OR kind = ?1
                 ORDER BY kind, name, id",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([kind], connection_resource_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn connection_by_id(&self, id: &str) -> Result<ConnectionResource, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT id, kind, provider, name, status, last_checked_at,
                        capabilities_json, metadata_json
                 FROM connections WHERE id = ?1",
                [id],
                connection_resource_from_row,
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "所选连接已经不存在，请重新选择".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_compat_connection(
        &self,
        id: &str,
        kind: &str,
        provider: &str,
        name: &str,
        secret_ref: Option<&str>,
        metadata: &BTreeMap<String, String>,
        capabilities: &[String],
        status: &str,
        last_checked_at: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        upsert_connection_record(
            &connection,
            id,
            kind,
            provider,
            name,
            secret_ref,
            metadata,
            capabilities,
            status,
            last_checked_at,
        )
    }

    pub fn connection_exists(&self, id: &str) -> Result<bool, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(public_storage_error)
    }

    pub fn bind_project_source_connection(
        &self,
        path: &Path,
        connection_id: Option<&str>,
    ) -> Result<(), String> {
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        if let Some(connection_id) = connection_id {
            ensure_connection_kind(&connection, connection_id, "source")?;
        }
        let changed = connection
            .execute(
                "INSERT INTO project_connection_bindings (
                   project_id, source_connection_id, updated_at
                 )
                 SELECT id, ?1, ?2 FROM projects WHERE path = ?3
                 ON CONFLICT(project_id) DO UPDATE SET
                   source_connection_id = excluded.source_connection_id,
                   updated_at = excluded.updated_at",
                params![connection_id, now, normalized],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("项目记录不存在，请重新打开项目".to_string());
        }
        Ok(())
    }

    pub fn bind_project_registry_connection(
        &self,
        path: &Path,
        environment: &str,
        connection_id: Option<&str>,
    ) -> Result<(), String> {
        if !matches!(environment, "staging" | "production") {
            return Err("镜像仓库只能绑定测试环境或生产环境".to_string());
        }
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        if let Some(connection_id) = connection_id {
            ensure_connection_kind(&connection, connection_id, "registry")?;
        }
        let changed = connection
            .execute(
                "UPDATE environments
                 SET registry_connection_id = ?1, updated_at = ?2
                 WHERE project_id = (SELECT id FROM projects WHERE path = ?3)
                   AND name = ?4",
                params![connection_id, now, normalized, environment],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("项目环境记录不存在，请重新打开项目".to_string());
        }
        Ok(())
    }

    pub fn project_connection_bindings(
        &self,
        path: &Path,
    ) -> Result<ProjectConnectionBindings, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(ProjectConnectionBindings::default());
        }
        let source_connection_id = connection
            .query_row(
                "SELECT binding.source_connection_id
                 FROM projects project
                 LEFT JOIN project_connection_bindings binding
                   ON binding.project_id = project.id
                 WHERE project.path = ?1",
                [&normalized],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "项目记录不存在，请重新打开项目".to_string())?;
        let mut result = ProjectConnectionBindings {
            source_connection_id,
            ..ProjectConnectionBindings::default()
        };
        let mut statement = connection
            .prepare(
                "SELECT environment.name, environment.target_connection_id,
                        environment.registry_connection_id
                 FROM environments environment
                 JOIN projects project ON project.id = environment.project_id
                 WHERE project.path = ?1
                   AND environment.name IN ('staging', 'production')",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    EnvironmentConnectionBindings {
                        target_connection_id: row.get(1)?,
                        registry_connection_id: row.get(2)?,
                    },
                ))
            })
            .map_err(public_storage_error)?;
        for row in rows {
            let (environment, bindings) = row.map_err(public_storage_error)?;
            match environment.as_str() {
                "staging" => result.staging = bindings,
                "production" => result.production = bindings,
                _ => {}
            }
        }
        Ok(result)
    }

    pub fn remove_project(&self, path: &Path) -> Result<bool, String> {
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        let changed = connection
            .execute(
                "UPDATE projects SET hidden_at = ?1
                 WHERE path = ?2 AND hidden_at IS NULL",
                params![now, normalized],
            )
            .map_err(public_storage_error)?;
        Ok(changed > 0)
    }

    pub fn remember_server(&self, profile: &SshProfile) -> Result<(), String> {
        let identity = format!("{}@{}:{}", profile.user, profile.host, profile.port);
        let id = project_id(&identity);
        let now = Utc::now().to_rfc3339();
        let key_path = normalize_path(&profile.key_path);
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO servers (
                   id, name, host, user, port, key_path, host_fingerprint,
                   last_checked_at, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(host, user, port) DO UPDATE SET
                   name = excluded.name,
                   key_path = excluded.key_path,
                   host_fingerprint = excluded.host_fingerprint,
                   last_checked_at = excluded.last_checked_at",
                params![
                    id,
                    profile.name,
                    profile.host,
                    profile.user,
                    profile.port,
                    key_path,
                    profile.host_fingerprint,
                    now
                ],
            )
            .map_err(public_storage_error)?;
        sync_legacy_server_connection(&connection, &id)?;
        Ok(())
    }

    pub fn remember_checked_server(&self, profile: &SshProfile) -> Result<(), String> {
        self.remember_server(profile)?;
        let identity = format!("{}@{}:{}", profile.user, profile.host, profile.port);
        let connection_id = format!("legacy-server:{}", project_id(&identity));
        let checked_at = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        let changed = connection
            .execute(
                "UPDATE connections
                 SET status = 'ready', last_checked_at = ?1, updated_at = ?1
                 WHERE id = ?2 AND kind = 'server' AND provider = 'ssh'",
                params![checked_at, connection_id],
            )
            .map_err(public_storage_error)?;
        if changed == 0 {
            return Err("服务器连接验证成功，但状态没有保存".to_string());
        }
        Ok(())
    }

    pub fn list_servers(&self) -> Result<Vec<ServerResource>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, host, user, port, key_path, host_fingerprint,
                        last_checked_at
                 FROM servers
                 ORDER BY last_checked_at DESC
                 LIMIT 50",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let key_path: String = row.get(5)?;
                Ok(ServerResource {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    user: row.get(3)?,
                    port: row.get(4)?,
                    key_path_exists: Path::new(&key_path).is_file(),
                    key_path,
                    host_fingerprint: row.get(6)?,
                    last_checked_at: row.get(7)?,
                })
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn server_by_id(&self, id: &str) -> Result<ServerResource, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        server_resource_by_id(&connection, id)?
            .ok_or_else(|| "所选运行服务器已经不存在，请重新选择".to_string())
    }

    pub fn bind_project_server(
        &self,
        path: &Path,
        environment: &str,
        profile: &SshProfile,
    ) -> Result<ServerResource, String> {
        if !matches!(environment, "staging" | "production") {
            return Err("只能绑定测试或生产服务器".to_string());
        }
        self.remember_server(profile)?;
        let identity = format!("{}@{}:{}", profile.user, profile.host, profile.port);
        let server_id = project_id(&identity);
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO project_server_bindings (
                   project_path, environment, server_id, updated_at
                 ) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_path, environment) DO UPDATE SET
                   server_id = excluded.server_id,
                   updated_at = excluded.updated_at",
                params![normalized, environment, server_id, now],
            )
            .map_err(public_storage_error)?;
        sync_environment_server_connection(
            &connection,
            &normalized,
            environment,
            &server_id,
            &now,
        )?;
        server_resource_by_id(&connection, &server_id)?
            .ok_or_else(|| "服务器记录保存后无法读取，请重新连接".to_string())
    }

    pub fn server_for_project(
        &self,
        path: &Path,
        environment: &str,
    ) -> Result<Option<ServerResource>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if matches!(environment, "staging" | "production")
            && project_deployment_state_hidden(&connection, &normalized)?
        {
            return Ok(None);
        }
        connection
            .query_row(
                "SELECT s.id, s.name, s.host, s.user, s.port, s.key_path,
                        s.host_fingerprint, s.last_checked_at
                 FROM project_server_bindings b
                 JOIN servers s ON s.id = b.server_id
                 WHERE b.project_path = ?1 AND b.environment = ?2",
                params![normalized, environment],
                server_resource_from_row,
            )
            .optional()
            .map_err(public_storage_error)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        // Project-scoped settings include an encoded absolute path plus an
        // environment suffix. Real macOS project paths commonly exceed the old
        // 80-byte limit even though the key is otherwise safe.
        if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
            return Err("应用设置名称不正确".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO app_settings (key, value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                   value = excluded.value,
                   updated_at = excluded.updated_at",
                params![key, value, now],
            )
            .map_err(public_storage_error)?;
        if matches!(
            key,
            "cnb.account.summary"
                | "registry.mode"
                | "registry.tcr.namespace"
                | "registry.tcr.v2.verified-endpoint"
        ) {
            sync_compat_provider_connections_from_settings(&connection)?;
        }
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(public_storage_error)
    }

    pub fn settings(&self, keys: &[String]) -> Result<BTreeMap<String, String>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare("SELECT value FROM app_settings WHERE key = ?1")
            .map_err(public_storage_error)?;
        let mut values = BTreeMap::new();
        for key in keys {
            if let Some(value) = statement
                .query_row([key], |row| row.get(0))
                .optional()
                .map_err(public_storage_error)?
            {
                values.insert(key.clone(), value);
            }
        }
        Ok(values)
    }

    pub fn save_config_profile(&self, profile: &ConfigProfile) -> Result<(), String> {
        validate_profile(profile)?;
        let values_json = serde_json::to_string(&profile.values).map_err(public_storage_error)?;
        let secret_fields_json =
            serde_json::to_string(&profile.secret_fields).map_err(public_storage_error)?;
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        if profile.is_default {
            transaction
                .execute(
                    "UPDATE config_profiles SET is_default = 0 WHERE kind = ?1 AND scope = ?2",
                    params![profile.kind, profile.scope],
                )
                .map_err(public_storage_error)?;
        }
        transaction
            .execute(
                "INSERT INTO config_profiles (
                   id, kind, provider, name, scope, values_json, secret_fields_json,
                   is_default, updated_at, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   provider = excluded.provider,
                   name = excluded.name,
                   scope = excluded.scope,
                   values_json = excluded.values_json,
                   secret_fields_json = excluded.secret_fields_json,
                   is_default = excluded.is_default,
                   updated_at = excluded.updated_at",
                params![
                    profile.id,
                    profile.kind,
                    profile.provider,
                    profile.name,
                    profile.scope,
                    values_json,
                    secret_fields_json,
                    profile.is_default,
                    now
                ],
            )
            .map_err(public_storage_error)?;
        transaction.commit().map_err(public_storage_error)
    }

    pub fn list_config_profiles(&self) -> Result<Vec<ConfigProfile>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, kind, provider, name, scope, values_json,
                        secret_fields_json, is_default, updated_at
                 FROM config_profiles
                 ORDER BY kind, scope, is_default DESC, updated_at DESC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], config_profile_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn config_profile(&self, id: &str) -> Result<Option<ConfigProfile>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT id, kind, provider, name, scope, values_json,
                        secret_fields_json, is_default, updated_at
                 FROM config_profiles WHERE id = ?1",
                [id],
                config_profile_from_row,
            )
            .optional()
            .map_err(public_storage_error)
    }

    pub fn remove_config_profile(&self, id: &str) -> Result<bool, String> {
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        let removed: Option<(String, String, bool)> = transaction
            .query_row(
                "SELECT kind, scope, is_default FROM config_profiles WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_profile_bindings WHERE profile_id = ?1",
                [id],
            )
            .map_err(public_storage_error)?;
        let changed = transaction
            .execute("DELETE FROM config_profiles WHERE id = ?1", [id])
            .map_err(public_storage_error)?;
        if let Some((kind, scope, true)) = removed {
            transaction
                .execute(
                    "UPDATE config_profiles SET is_default = 1
                     WHERE id = (
                       SELECT id FROM config_profiles
                       WHERE kind = ?1 AND scope = ?2
                       ORDER BY updated_at DESC LIMIT 1
                     )",
                    params![kind, scope],
                )
                .map_err(public_storage_error)?;
        }
        transaction.commit().map_err(public_storage_error)?;
        Ok(changed > 0)
    }

    pub fn bind_config_profile(
        &self,
        path: &Path,
        environment: &str,
        kind: &str,
        profile_id: &str,
    ) -> Result<ProjectProfileBinding, String> {
        if !valid_project_config_scope(environment) {
            return Err("项目环境名称不正确".to_string());
        }
        validate_profile_segment(kind, "连接类型")?;
        let profile = self
            .config_profile(profile_id)?
            .ok_or_else(|| "所选配置中心连接不存在".to_string())?;
        if profile.kind != kind {
            return Err("所选连接类型与项目需要的类型不一致".to_string());
        }
        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO project_profile_bindings (
                   project_path, environment, profile_kind, profile_id, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_path, environment, profile_id) DO UPDATE SET
                   profile_kind = excluded.profile_kind,
                   updated_at = excluded.updated_at",
                params![normalized, environment, kind, profile_id, now],
            )
            .map_err(public_storage_error)?;
        Ok(ProjectProfileBinding {
            environment: environment.to_string(),
            kind: kind.to_string(),
            profile_id: profile_id.to_string(),
        })
    }

    pub fn set_environment_config_bindings(
        &self,
        path: &Path,
        environment: &str,
        profile_ids: &[String],
    ) -> Result<Vec<ProjectProfileBinding>, String> {
        if !valid_project_config_scope(environment) {
            return Err("项目环境名称不正确".to_string());
        }
        if profile_ids.len() > 256 {
            return Err("单个环境选择的配置项过多".to_string());
        }
        let mut seen = BTreeSet::new();
        let unique_ids = profile_ids
            .iter()
            .filter(|id| seen.insert((*id).clone()))
            .cloned()
            .collect::<Vec<_>>();
        for id in &unique_ids {
            validate_profile_segment(id, "连接编号")?;
        }

        let normalized = normalize_path(path);
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        let mut bindings = Vec::with_capacity(unique_ids.len());
        for profile_id in unique_ids {
            let profile: Option<(String, String)> = transaction
                .query_row(
                    "SELECT kind, scope FROM config_profiles WHERE id = ?1",
                    [&profile_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(public_storage_error)?;
            let (kind, scope) =
                profile.ok_or_else(|| format!("所选配置中心连接已不存在：{profile_id}"))?;
            if !profile_scope_supports_environment(&scope, environment) {
                return Err(format!("配置“{profile_id}”不适用于当前运行环境"));
            }
            bindings.push(ProjectProfileBinding {
                environment: environment.to_string(),
                kind,
                profile_id,
            });
        }

        transaction
            .execute(
                "DELETE FROM project_profile_bindings
                 WHERE project_path = ?1 AND environment = ?2",
                params![normalized, environment],
            )
            .map_err(public_storage_error)?;
        for binding in &bindings {
            transaction
                .execute(
                    "INSERT INTO project_profile_bindings (
                       project_path, environment, profile_kind, profile_id, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        normalized,
                        environment,
                        binding.kind,
                        binding.profile_id,
                        now
                    ],
                )
                .map_err(public_storage_error)?;
        }
        transaction.commit().map_err(public_storage_error)?;
        Ok(bindings)
    }

    pub fn config_profile_bindings(
        &self,
        path: &Path,
        environment: &str,
    ) -> Result<Vec<ProjectProfileBinding>, String> {
        if !valid_project_config_scope(environment) {
            return Err("项目环境名称不正确".to_string());
        }
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if matches!(environment, "staging" | "production")
            && project_deployment_state_hidden(&connection, &normalized)?
        {
            return Ok(Vec::new());
        }
        let mut statement = connection
            .prepare(
                "SELECT environment, profile_kind, profile_id
                 FROM project_profile_bindings
                 WHERE project_path = ?1 AND environment = ?2
                 ORDER BY profile_kind, profile_id",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map(params![normalized, environment], |row| {
                Ok(ProjectProfileBinding {
                    environment: row.get(0)?,
                    kind: row.get(1)?,
                    profile_id: row.get(2)?,
                })
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn create_deployment_run(
        &self,
        project_path: &Path,
        project_name: &str,
        environment: &str,
        repository: &str,
        branch: &str,
    ) -> Result<DeploymentRun, String> {
        let run =
            self.deployment_run_draft(project_path, project_name, environment, repository, branch)?;
        self.save_deployment_run(&run)?;
        Ok(run)
    }

    /// Build an unsaved deployment record. External history import uses this
    /// to apply the provider timestamp and the fresh-history cutoff before the
    /// first database write.
    #[allow(clippy::unused_self)] // Kept as a state method because it is the unsaved counterpart of create_deployment_run.
    pub fn deployment_run_draft(
        &self,
        project_path: &Path,
        project_name: &str,
        environment: &str,
        repository: &str,
        branch: &str,
    ) -> Result<DeploymentRun, String> {
        if !matches!(environment, "staging" | "production" | "deployment") {
            return Err("部署任务类型不正确".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let normalized = normalize_path(project_path);
        let id = project_id(&format!("{normalized}:{now}"));
        let run = DeploymentRun {
            id,
            project_path: normalized,
            project_name: project_name.to_string(),
            environment: environment.to_string(),
            status: "queued".to_string(),
            current_stage: "prepare".to_string(),
            build_serial: None,
            commit_sha: None,
            source_title: None,
            source_run_id: None,
            candidate_tag: None,
            artifacts: Vec::new(),
            route_checks: Vec::new(),
            action_kind: None,
            action_url: None,
            issue_code: None,
            repository: repository.to_string(),
            branch: branch.to_string(),
            message: if environment == "deployment" {
                "正在准备当前本地项目".to_string()
            } else {
                "正在请求 CNB 开始构建".to_string()
            },
            completed_steps: vec!["write-config".to_string()],
            started_at: now.clone(),
            updated_at: now,
        };
        Ok(run)
    }

    pub fn save_deployment_run(&self, run: &DeploymentRun) -> Result<(), String> {
        if !valid_run_status(&run.status) {
            return Err("部署运行状态不正确".to_string());
        }
        let completed_steps =
            serde_json::to_string(&run.completed_steps).map_err(public_storage_error)?;
        let artifacts = serde_json::to_string(&run.artifacts).map_err(public_storage_error)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(public_storage_error)?;
        let existing_run: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deployment_runs WHERE id = ?1)",
                [&run.id],
                |row| row.get(0),
            )
            .map_err(public_storage_error)?;
        let adoption = project_adoption_record(&transaction, &run.project_path)?;
        if adoption.mode == ADOPTION_PENDING {
            return Err("AD-ADOPT-101：请先选择继续管理已有部署或重新设置部署".to_string());
        }
        if !existing_run
            && adoption.mode == ADOPTION_FRESH
            && adoption
                .history_import_after
                .as_deref()
                .is_some_and(|cutoff| !run_started_after_cutoff(&run.started_at, cutoff))
        {
            return Err("AD-STATE-STALE：项目已重新设置，已忽略之前的后台结果".to_string());
        }
        transaction
            .execute(
                "INSERT INTO deployment_runs (
                   id, project_path, project_name, environment, status,
                   current_stage, build_serial, commit_sha, source_title, source_run_id,
                   candidate_tag, artifacts, action_kind, action_url, issue_code,
                   repository, branch, message, completed_steps, started_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
                 ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status,
                   current_stage = excluded.current_stage,
                   build_serial = excluded.build_serial,
                   commit_sha = excluded.commit_sha,
                   source_title = excluded.source_title,
                   source_run_id = excluded.source_run_id,
                   candidate_tag = excluded.candidate_tag,
                   artifacts = excluded.artifacts,
                   action_kind = excluded.action_kind,
                   action_url = excluded.action_url,
                   issue_code = excluded.issue_code,
                   repository = excluded.repository,
                   branch = excluded.branch,
                   message = excluded.message,
                   completed_steps = excluded.completed_steps,
                   started_at = excluded.started_at,
                   updated_at = excluded.updated_at",
                params![
                    run.id,
                    run.project_path,
                    run.project_name,
                    run.environment,
                    run.status,
                    run.current_stage,
                    run.build_serial,
                    run.commit_sha,
                    run.source_title,
                    run.source_run_id,
                    run.candidate_tag,
                    artifacts,
                    run.action_kind,
                    run.action_url,
                    run.issue_code,
                    run.repository,
                    run.branch,
                    run.message,
                    completed_steps,
                    run.started_at,
                    run.updated_at
                ],
            )
            .map_err(public_storage_error)?;
        transaction
            .execute(
                "DELETE FROM deployment_route_checks WHERE run_id = ?1",
                [&run.id],
            )
            .map_err(public_storage_error)?;
        for (position, check) in run.route_checks.iter().enumerate() {
            let position = i64::try_from(position)
                .map_err(|_| "无法保存过多的正式地址检查结果".to_string())?;
            transaction
                .execute(
                    "INSERT INTO deployment_route_checks (
                       run_id, position, host, url, phase, reachable, http_status, message
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        run.id,
                        position,
                        check.host,
                        check.url,
                        check.phase,
                        check.reachable,
                        check.http_status,
                        check.message,
                    ],
                )
                .map_err(public_storage_error)?;
        }
        let attempt_finished = matches!(
            run.status.as_str(),
            "needs_action" | "success" | "failed" | "cancelled"
        );
        let attempt_status = if attempt_finished {
            run.status.as_str()
        } else {
            "running"
        };
        let attempt_output = serde_json::to_string(&serde_json::json!({
            "buildSerial": run.build_serial,
            "commitSha": run.commit_sha,
            "candidateTag": run.candidate_tag,
            "artifacts": run.artifacts,
            "issueCode": run.issue_code,
            "message": run.message,
            "completedSteps": run.completed_steps,
            "routeChecks": run.route_checks,
        }))
        .map_err(public_storage_error)?;
        transaction
            .execute(
                "UPDATE deployment_attempts
                 SET status = ?2,
                     current_stage = ?3,
                     output_json = ?4,
                     finished_at = CASE WHEN ?5 THEN ?6 ELSE finished_at END,
                     updated_at = ?6
                 WHERE id = (
                   SELECT id FROM deployment_attempts
                   WHERE task_id = ?1 AND status IN ('queued', 'running')
                   ORDER BY ordinal DESC LIMIT 1
                 )",
                params![
                    run.id,
                    attempt_status,
                    run.current_stage,
                    attempt_output,
                    attempt_finished,
                    run.updated_at,
                ],
            )
            .map_err(public_storage_error)?;
        let path_state = match run.status.as_str() {
            "success" => "online",
            "needs_action" | "failed" | "cancelled" => "needs_action",
            _ => "deploying",
        };
        transaction
            .execute(
                "UPDATE deployment_paths
                 SET state = ?2,
                     last_successful_revision = CASE
                       WHEN ?2 = 'online' THEN COALESCE(?3, last_successful_revision)
                       ELSE last_successful_revision
                     END,
                     updated_at = ?4
                 WHERE last_run_id = ?1",
                params![run.id, path_state, run.commit_sha, run.updated_at],
            )
            .map_err(public_storage_error)?;
        sync_deployment_run_links(&transaction, &run.id)?;
        sync_successful_staging_version(&transaction, run)?;
        sync_successful_production_version(&transaction, run, true)?;
        transaction.commit().map_err(public_storage_error)
    }

    pub fn deployment_run(&self, id: &str) -> Result<DeploymentRun, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut run = connection
            .query_row(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs WHERE id = ?1",
                [id],
                deployment_run_from_row,
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "找不到这次部署记录".to_string())?;
        hydrate_deployment_route_checks(&connection, &mut run)?;
        if project_deployment_state_hidden(&connection, &run.project_path)? {
            return Err("AD-ADOPT-101：请先选择继续管理已有部署或重新设置部署".to_string());
        }
        Ok(run)
    }

    pub fn deployment_run_by_serial_for_project(
        &self,
        path: &Path,
        repository: &str,
        serial: &str,
    ) -> Result<Option<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(None);
        }
        let mut run = connection
            .query_row(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE project_path = ?1 AND repository = ?2 AND build_serial = ?3
                 LIMIT 1",
                params![normalized, repository, serial],
                deployment_run_from_row,
            )
            .optional()
            .map_err(public_storage_error)?;
        if let Some(run) = run.as_mut() {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(run)
    }

    pub fn successful_staging_run_by_revision(
        &self,
        path: &Path,
        revision: &str,
    ) -> Result<Option<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(None);
        }
        let mut run = connection
            .query_row(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE project_path = ?1 AND environment = 'staging'
                   AND status = 'success' AND commit_sha = ?2
                 ORDER BY started_at DESC
                 LIMIT 1",
                params![normalized, revision],
                deployment_run_from_row,
            )
            .optional()
            .map_err(public_storage_error)?;
        if let Some(run) = run.as_mut() {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(run)
    }

    pub fn production_rollback_source_run(
        &self,
        path: &Path,
    ) -> Result<Option<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let source_run_id = {
            let connection = self.connection.lock().map_err(lock_error)?;
            connection
                .query_row(
                    "SELECT previous.source_run_id
                     FROM environments environment
                     JOIN projects project ON project.id = environment.project_id
                     JOIN deployment_runs previous
                       ON previous.environment_id = environment.id
                     WHERE project.path = ?1
                       AND environment.name = 'production'
                       AND environment.current_deployment_run_id IS NOT NULL
                       AND previous.id <> environment.current_deployment_run_id
                       AND previous.status = 'success'
                       AND previous.version_id IS NOT NULL
                       AND previous.source_run_id IS NOT NULL
                     ORDER BY previous.started_at DESC, previous.id DESC
                     LIMIT 1",
                    [normalized],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(public_storage_error)?
        };
        source_run_id
            .map(|run_id| self.deployment_run(&run_id))
            .transpose()
    }

    pub fn list_deployment_runs(&self, path: &Path) -> Result<Vec<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(Vec::new());
        }
        let mut statement = connection
            .prepare(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE project_path = ?1
                 ORDER BY started_at DESC
                 LIMIT 50",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized], deployment_run_from_row)
            .map_err(public_storage_error)?;
        let mut runs = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?;
        for run in &mut runs {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(runs)
    }

    pub fn list_project_environments(
        &self,
        path: &Path,
    ) -> Result<Vec<ProjectEnvironment>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT e.name, e.display_name,
                        CASE WHEN p.deployment_adoption_mode = 'pending'
                                   OR p.deployment_fresh_draft = 1
                                  THEN 'unknown' ELSE e.status END,
                        CASE WHEN p.deployment_adoption_mode = 'pending'
                                   OR p.deployment_fresh_draft = 1
                                  THEN NULL ELSE v.identity_key END,
                        CASE WHEN p.deployment_adoption_mode = 'pending'
                                   OR p.deployment_fresh_draft = 1
                                  THEN NULL ELSE e.current_deployment_run_id END
                 FROM environments e
                 JOIN projects p ON p.id = e.project_id
                 LEFT JOIN versions v ON v.id = e.current_version_id
                 WHERE p.path = ?1
                 ORDER BY CASE e.name
                   WHEN 'development' THEN 0
                   WHEN 'staging' THEN 1
                   WHEN 'production' THEN 2
                   ELSE 3
                 END, e.name",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized], |row| {
                Ok(ProjectEnvironment {
                    environment: row.get(0)?,
                    display_name: row.get(1)?,
                    status: row.get(2)?,
                    current_version_key: row.get(3)?,
                    current_run_id: row.get(4)?,
                })
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn list_project_versions(&self, path: &Path) -> Result<Vec<ProjectVersion>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(Vec::new());
        }
        let mut versions = {
            let mut statement = connection
                .prepare(
                    "SELECT v.id, v.identity_key, v.status, v.commit_sha,
                            v.source_title, v.source_connection_id,
                            v.source_build_id, v.repository, v.branch,
                            v.candidate_tag, v.created_at, v.updated_at
                     FROM versions v
                     JOIN projects p ON p.id = v.project_id
                     WHERE p.path = ?1
                     ORDER BY v.created_at DESC, v.id DESC",
                )
                .map_err(public_storage_error)?;
            let rows = statement
                .query_map([normalized], |row| {
                    Ok(ProjectVersion {
                        id: row.get(0)?,
                        version_key: row.get(1)?,
                        status: row.get(2)?,
                        commit_sha: row.get(3)?,
                        source_title: row.get(4)?,
                        source_connection_id: row.get(5)?,
                        source_build_id: row.get(6)?,
                        repository: row.get(7)?,
                        branch: row.get(8)?,
                        candidate_tag: row.get(9)?,
                        staging_run_id: None,
                        artifacts: Vec::new(),
                        validation: None,
                        current_environments: Vec::new(),
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                    })
                })
                .map_err(public_storage_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(public_storage_error)?
        };

        for version in &mut versions {
            version.staging_run_id = connection
                .query_row(
                    "SELECT d.id
                     FROM deployment_runs d
                     WHERE d.version_id = ?1
                       AND d.environment = 'staging'
                       AND d.status = 'success'
                       AND COALESCE(d.action_kind, '') <> 'production-approval'
                     ORDER BY CASE WHEN EXISTS (
                       SELECT 1 FROM environments e
                       WHERE e.name = 'staging'
                         AND e.current_version_id = d.version_id
                         AND e.current_deployment_run_id = d.id
                     ) THEN 0 ELSE 1 END,
                     d.updated_at DESC, d.started_at DESC, d.id DESC
                     LIMIT 1",
                    [&version.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(public_storage_error)?;

            version.artifacts = {
                let mut statement = connection
                    .prepare(
                        "SELECT DISTINCT service, image, digest
                         FROM version_artifacts
                         WHERE version_id = ?1
                         ORDER BY service, image, digest",
                    )
                    .map_err(public_storage_error)?;
                let rows = statement
                    .query_map([&version.id], |row| {
                        Ok(DeploymentArtifact {
                            service: row.get(0)?,
                            image: row.get(1)?,
                            digest: row.get(2)?,
                        })
                    })
                    .map_err(public_storage_error)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(public_storage_error)?
            };

            let version_key = version.version_key.clone();
            version.validation = connection
                .query_row(
                    "SELECT vv.status, COALESCE(vv.deployment_run_id, ''),
                            COALESCE(vv.verified_at, vv.updated_at)
                     FROM version_validations vv
                     JOIN environments e ON e.id = vv.environment_id
                     WHERE vv.version_id = ?1
                       AND e.name = 'staging'
                       AND vv.status IN ('passed', 'rejected')
                     ORDER BY COALESCE(vv.verified_at, vv.updated_at) DESC,
                              vv.updated_at DESC, vv.id DESC
                     LIMIT 1",
                    [&version.id],
                    |row| {
                        Ok(VersionValidation {
                            version_key: version_key.clone(),
                            state: row.get(0)?,
                            run_id: row.get(1)?,
                            verified_at: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(public_storage_error)?;

            version.current_environments = {
                let mut statement = connection
                    .prepare(
                        "SELECT name FROM environments
                         WHERE current_version_id = ?1
                           AND name IN ('staging', 'production')
                         ORDER BY CASE name
                           WHEN 'staging' THEN 0
                           WHEN 'production' THEN 1
                           ELSE 2
                         END",
                    )
                    .map_err(public_storage_error)?;
                let rows = statement
                    .query_map([&version.id], |row| row.get::<_, String>(0))
                    .map_err(public_storage_error)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(public_storage_error)?
            };
        }

        Ok(versions)
    }

    pub fn list_version_validations(&self, path: &Path) -> Result<Vec<VersionValidation>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        if project_deployment_state_hidden(&connection, &normalized)? {
            return Ok(Vec::new());
        }
        let mut statement = connection
            .prepare(
                "SELECT v.identity_key, vv.status,
                        COALESCE(vv.deployment_run_id, ''),
                        COALESCE(vv.verified_at, vv.updated_at)
                 FROM version_validations vv
                 JOIN versions v ON v.id = vv.version_id
                 JOIN environments e ON e.id = vv.environment_id
                 JOIN projects p ON p.id = v.project_id
                 WHERE p.path = ?1
                   AND e.name = 'staging'
                   AND vv.status IN ('passed', 'rejected')
                   AND NOT EXISTS (
                     SELECT 1 FROM version_validations newer
                     WHERE newer.version_id = vv.version_id
                       AND newer.environment_id = vv.environment_id
                       AND (
                         newer.updated_at > vv.updated_at OR
                         (newer.updated_at = vv.updated_at AND newer.id > vv.id)
                       )
                   )
                 ORDER BY COALESCE(vv.verified_at, vv.updated_at) DESC, vv.id DESC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized], |row| {
                Ok(VersionValidation {
                    version_key: row.get(0)?,
                    state: row.get(1)?,
                    run_id: row.get(2)?,
                    verified_at: row.get(3)?,
                })
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
    }

    pub fn set_version_validation(
        &self,
        path: &Path,
        run_id: &str,
        validation_state: &str,
    ) -> Result<VersionValidation, String> {
        if !matches!(validation_state, "passed" | "rejected") {
            return Err("测试结论只能是通过或不通过".to_string());
        }
        let run = self.deployment_run(run_id)?;
        if run.project_path != normalize_path(path) {
            return Err("这条版本记录不属于当前项目".to_string());
        }
        if run.environment != "staging" || run.status != "success" {
            return Err("只有已经成功部署到测试环境的版本才能确认测试结果".to_string());
        }

        // Legacy successful runs may predate the versions table. Saving the
        // unchanged run is idempotent and creates its immutable version link.
        self.save_deployment_run(&run)?;

        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        let (version_id, environment_id, version_key): (String, String, String) = connection
            .query_row(
                "SELECT d.version_id, d.environment_id, v.identity_key
                 FROM deployment_runs d
                 JOIN versions v ON v.id = d.version_id
                 WHERE d.id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(public_storage_error)?;
        let validation_id =
            project_id(&format!("version-validation:{version_id}:{environment_id}"));
        connection
            .execute(
                "INSERT INTO version_validations (
                   id, version_id, environment_id, deployment_run_id, status,
                   verified_by, evidence_json, verified_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'local-user', '{}', ?6, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   deployment_run_id = excluded.deployment_run_id,
                   status = excluded.status,
                   verified_by = excluded.verified_by,
                   evidence_json = excluded.evidence_json,
                   verified_at = excluded.verified_at,
                   updated_at = excluded.updated_at",
                params![
                    validation_id,
                    version_id,
                    environment_id,
                    run_id,
                    validation_state,
                    now
                ],
            )
            .map_err(public_storage_error)?;
        Ok(VersionValidation {
            version_key,
            state: validation_state.to_string(),
            run_id: run_id.to_string(),
            verified_at: now,
        })
    }

    pub fn list_active_deployment_runs(&self) -> Result<Vec<DeploymentRun>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE status IN ('queued', 'running')
                   AND EXISTS (
                     SELECT 1 FROM projects visible
                     WHERE visible.path = deployment_runs.project_path
                       AND visible.hidden_at IS NULL
                       AND visible.deployment_adoption_mode <> 'pending'
                       AND visible.deployment_fresh_draft = 0
                   )
                 ORDER BY updated_at DESC
                 LIMIT 100",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        let mut runs = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?;
        for run in &mut runs {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(runs)
    }

    pub fn list_attention_deployment_runs(&self) -> Result<Vec<DeploymentRun>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT current.id, current.project_path, current.project_name,
                        current.environment, current.status, current.current_stage,
                        current.build_serial, current.commit_sha, current.source_title,
                        current.source_run_id, current.candidate_tag, current.artifacts,
                        current.action_kind, current.action_url, current.issue_code,
                        current.repository, current.branch, current.message,
                        current.completed_steps, current.started_at, current.updated_at
                 FROM deployment_runs current
                 WHERE current.status IN ('queued', 'running', 'needs_action', 'failed')
                   AND EXISTS (
                     SELECT 1 FROM projects visible
                     WHERE visible.path = current.project_path
                       AND visible.hidden_at IS NULL
                       AND visible.deployment_adoption_mode <> 'pending'
                       AND visible.deployment_fresh_draft = 0
                   )
                   AND current.id = (
                     SELECT latest.id FROM deployment_runs latest
                     WHERE latest.project_path = current.project_path
                       AND latest.environment = current.environment
                     ORDER BY latest.started_at DESC, latest.updated_at DESC, latest.id DESC
                     LIMIT 1
                   )
                 ORDER BY current.updated_at DESC
                 LIMIT 100",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        let mut runs = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?;
        for run in &mut runs {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(runs)
    }

    pub fn list_recent_successful_deployment_runs(&self) -> Result<Vec<DeploymentRun>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT current.id, current.project_path, current.project_name,
                        current.environment, current.status, current.current_stage,
                        current.build_serial, current.commit_sha, current.source_title,
                        current.source_run_id, current.candidate_tag, current.artifacts,
                        current.action_kind, current.action_url, current.issue_code,
                        current.repository, current.branch, current.message,
                        current.completed_steps, current.started_at, current.updated_at
                 FROM deployment_runs current
                 WHERE current.status = 'success'
                   AND EXISTS (
                     SELECT 1 FROM projects visible
                     WHERE visible.path = current.project_path
                       AND visible.hidden_at IS NULL
                       AND visible.deployment_adoption_mode <> 'pending'
                       AND visible.deployment_fresh_draft = 0
                   )
                   AND current.id = (
                     SELECT latest.id FROM deployment_runs latest
                     WHERE latest.project_path = current.project_path
                       AND latest.environment = current.environment
                       AND latest.status = 'success'
                     ORDER BY latest.started_at DESC, latest.updated_at DESC, latest.id DESC
                     LIMIT 1
                   )
                 ORDER BY current.started_at DESC, current.updated_at DESC, current.id DESC
                 LIMIT 20",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        let mut runs = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?;
        for run in &mut runs {
            hydrate_deployment_route_checks(&connection, run)?;
        }
        Ok(runs)
    }

    #[cfg(test)]
    fn project_step(&self, path: &Path) -> Result<Option<String>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT current_step FROM projects WHERE path = ?1",
                [normalized],
                |row| row.get(0),
            )
            .optional()
            .map_err(public_storage_error)
    }
}

fn normalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned()
}

fn deployment_path_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentPath> {
    let profile_ids_json: String = row.get(6)?;
    let routes_json: String = row.get(8)?;
    Ok(DeploymentPath {
        id: row.get(0)?,
        project_path: row.get(1)?,
        name: row.get(2)?,
        source_connection_id: row.get(3)?,
        registry_connection_id: row.get(4)?,
        server_id: row.get(5)?,
        config_profile_ids: serde_json::from_str(&profile_ids_json).unwrap_or_default(),
        address: row.get(7)?,
        routes: serde_json::from_str(&routes_json).unwrap_or_default(),
        state: row.get(9)?,
        last_run_id: row.get(10)?,
        last_successful_revision: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn validate_deployment_path_route(route: &DeploymentPathRoute) -> Result<(), String> {
    if route.service.is_empty()
        || route.service.len() > 80
        || !route
            .service
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("访问地址引用的项目服务格式不正确".to_string());
    }
    if route.host.is_empty()
        || route.host.len() > 253
        || route.host.contains(['/', '\\', ' ', '\t', '\r', '\n'])
        || !route.host.contains('.')
    {
        return Err("项目访问地址格式不正确".to_string());
    }
    if !route.path.starts_with('/')
        || route.path.len() > 512
        || route
            .path
            .contains(['\\', ' ', '\t', '\r', '\n', '\0', '{', '}', '#'])
    {
        return Err("访问路径格式不正确".to_string());
    }
    Ok(())
}

fn deployment_attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentAttempt> {
    let input_snapshot_json: String = row.get(5)?;
    let output_json: String = row.get(6)?;
    Ok(DeploymentAttempt {
        id: row.get(0)?,
        task_id: row.get(1)?,
        ordinal: row.get(2)?,
        status: row.get(3)?,
        current_stage: row.get(4)?,
        input_snapshot: serde_json::from_str(&input_snapshot_json)
            .unwrap_or_else(|_| serde_json::json!({})),
        output: serde_json::from_str(&output_json).unwrap_or_else(|_| serde_json::json!({})),
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn deployment_attempt_optional(
    connection: &Connection,
    task_id: &str,
    only_open: bool,
) -> Result<Option<DeploymentAttempt>, String> {
    let query = if only_open {
        "SELECT id, task_id, ordinal, status, current_stage,
                input_snapshot_json, output_json, started_at,
                finished_at, updated_at
         FROM deployment_attempts
         WHERE task_id = ?1 AND status IN ('queued', 'running')
         ORDER BY ordinal DESC LIMIT 1"
    } else {
        "SELECT id, task_id, ordinal, status, current_stage,
                input_snapshot_json, output_json, started_at,
                finished_at, updated_at
         FROM deployment_attempts
         WHERE task_id = ?1 ORDER BY ordinal DESC LIMIT 1"
    };
    connection
        .query_row(query, [task_id], deployment_attempt_from_row)
        .optional()
        .map_err(public_storage_error)
}

fn project_adoption_record(
    connection: &Connection,
    normalized_path: &str,
) -> Result<ProjectAdoptionRecord, String> {
    project_adoption_record_optional(connection, normalized_path)?
        .ok_or_else(|| "项目记录不存在，请重新打开项目".to_string())
}

fn project_adoption_record_optional(
    connection: &Connection,
    normalized_path: &str,
) -> Result<Option<ProjectAdoptionRecord>, String> {
    connection
        .query_row(
            "SELECT deployment_adoption_mode, external_import_after,
                    deployment_fresh_draft
             FROM projects WHERE path = ?1",
            [normalized_path],
            |row| {
                Ok(ProjectAdoptionRecord {
                    mode: row.get(0)?,
                    history_import_after: row.get(1)?,
                    fresh_draft: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(public_storage_error)
}

/// Deployment state is intentionally invisible until the adoption decision is
/// complete and, for a reset project, until the replacement draft has been
/// saved. Treat a missing project row as hidden as well: project loading reads
/// several resources in parallel, and those reads must not expose orphaned
/// legacy rows before `remember_project_with_identity` completes.
fn project_deployment_state_hidden(
    connection: &Connection,
    normalized_path: &str,
) -> Result<bool, String> {
    Ok(
        project_adoption_record_optional(connection, normalized_path)?
            .is_none_or(|adoption| adoption.mode == ADOPTION_PENDING || adoption.fresh_draft),
    )
}

fn deployment_setup_setting_suffix(suffix: &str) -> bool {
    matches!(
        suffix,
        "scene"
            | "version-setup-active"
            | "version-setup-step"
            | "version-setup-complete"
            | "verified-run"
            | "verified-version"
            | "rejected-version"
            | "production-pending-version"
            | "cnb-secret-repository"
            | "cnb-secret-progress.staging"
            | "cnb-secret-progress.production"
            | "cnb-secret-pending.staging"
            | "cnb-secret-pending.production"
    ) || suffix.starts_with("production-health-check.")
        || suffix.starts_with("staging-runtime-ready.")
        || suffix.starts_with("production-runtime-ready.")
}

fn run_started_after_cutoff(started_at: &str, cutoff: &str) -> bool {
    let Ok(started_at) = chrono::DateTime::parse_from_rfc3339(started_at) else {
        return false;
    };
    let Ok(cutoff) = chrono::DateTime::parse_from_rfc3339(cutoff) else {
        return false;
    };
    started_at > cutoff
}

pub fn project_storage_id(root: &Path) -> String {
    if let Ok(stored) = fs::read_to_string(root.join(PROJECT_ID_FILE)) {
        let stored = stored.trim();
        if stored.len() == 64 && stored.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return stored.to_ascii_lowercase();
        }
    }
    project_id(&normalize_path(root))
}

fn write_project_storage_id(root: &Path, storage_id: &str) -> Result<(), String> {
    if storage_id.len() != 64 || !storage_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("原项目身份记录无效，暂时不能安全恢复".to_string());
    }
    let destination = root.join(PROJECT_ID_FILE);
    if let Ok(existing) = fs::read_to_string(&destination) {
        let existing = existing.trim();
        if existing.len() == 64
            && existing.bytes().all(|byte| byte.is_ascii_hexdigit())
            && !existing.eq_ignore_ascii_case(storage_id)
        {
            return Err("这个文件夹已有另一份 ABCDeploy 本机身份，请选择原项目文件夹".to_string());
        }
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "无法准备项目恢复目录".to_string())?;
    fs::create_dir_all(parent).map_err(public_storage_error)?;
    ensure_local_state_ignored(root)?;
    let temporary = parent.join("project-id.tmp");
    fs::write(&temporary, format!("{}\n", storage_id.to_ascii_lowercase()))
        .map_err(public_storage_error)?;
    fs::rename(&temporary, &destination).map_err(public_storage_error)
}

fn ensure_local_state_ignored(root: &Path) -> Result<(), String> {
    let path = root.join(".deploydesk/.gitignore");
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    if content.lines().any(|line| line.trim() == "state/") {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if content.is_empty() {
        content.push_str("# ABCDeploy 本机状态，不上传到代码仓库。\n");
    }
    content.push_str("state/\n");
    fs::write(path, content).map_err(public_storage_error)
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String is infallible");
        }
    }
    encoded
}

fn project_id(path: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(path.as_bytes());
    format!("{:x}", digest.finalize())
}

fn valid_step(step: &str) -> bool {
    matches!(
        step,
        "inspection"
            | "connections"
            | "recommendation"
            | "requirements"
            | "review"
            | "deploying"
            | "workspace"
    )
}

fn valid_run_status(status: &str) -> bool {
    matches!(
        status,
        "queued" | "running" | "needs_action" | "success" | "failed" | "cancelled"
    )
}

fn deployment_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentRun> {
    let artifacts: String = row.get(11)?;
    let completed_steps: String = row.get(18)?;
    Ok(DeploymentRun {
        id: row.get(0)?,
        project_path: row.get(1)?,
        project_name: row.get(2)?,
        environment: row.get(3)?,
        status: row.get(4)?,
        current_stage: row.get(5)?,
        build_serial: row.get(6)?,
        commit_sha: row.get(7)?,
        source_title: row.get(8)?,
        source_run_id: row.get(9)?,
        candidate_tag: row.get(10)?,
        artifacts: serde_json::from_str(&artifacts).unwrap_or_default(),
        route_checks: Vec::new(),
        action_kind: row.get(12)?,
        action_url: row.get(13)?,
        issue_code: row.get(14)?,
        repository: row.get(15)?,
        branch: row.get(16)?,
        message: row.get(17)?,
        completed_steps: serde_json::from_str(&completed_steps).unwrap_or_default(),
        started_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn hydrate_deployment_route_checks(
    connection: &Connection,
    run: &mut DeploymentRun,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT host, url, phase, reachable, http_status, message
             FROM deployment_route_checks
             WHERE run_id = ?1
             ORDER BY position",
        )
        .map_err(public_storage_error)?;
    let rows = statement
        .query_map([&run.id], |row| {
            Ok(PublicRouteStatus {
                host: row.get(0)?,
                url: row.get(1)?,
                phase: row.get(2)?,
                reachable: row.get(3)?,
                http_status: row.get(4)?,
                message: row.get(5)?,
            })
        })
        .map_err(public_storage_error)?;
    run.route_checks = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(public_storage_error)?;
    Ok(())
}

fn connection_resource_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionResource> {
    let capabilities_json: String = row.get(6)?;
    let metadata_json: String = row.get(7)?;
    let capabilities = serde_json::from_str::<Vec<String>>(&capabilities_json)
        .unwrap_or_default()
        .into_iter()
        .filter(|capability| valid_connection_segment(capability))
        .take(32)
        .collect();
    let metadata = serde_json::from_str::<BTreeMap<String, String>>(&metadata_json)
        .map(|metadata| safe_connection_metadata(&metadata))
        .unwrap_or_default();
    let status: String = row.get(4)?;
    Ok(ConnectionResource {
        id: row.get(0)?,
        kind: row.get(1)?,
        provider: row.get(2)?,
        name: row.get(3)?,
        status: if valid_connection_status(&status) {
            status
        } else {
            "unknown".to_string()
        },
        last_checked_at: row.get(5)?,
        capabilities,
        metadata,
    })
}

fn safe_connection_metadata(metadata: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    const ALLOWED_KEYS: [&str; 10] = [
        "endpoint",
        "namespace",
        "username",
        "account",
        "host",
        "user",
        "port",
        "hostFingerprint",
        "repository",
        "region",
    ];
    metadata
        .iter()
        .filter(|(key, value)| {
            ALLOWED_KEYS.contains(&key.as_str())
                && value.len() <= 512
                && !value.chars().any(char::is_control)
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn valid_connection_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_connection_status(value: &str) -> bool {
    matches!(
        value,
        "unknown" | "configured" | "ready" | "needs_authorization" | "error"
    )
}

fn valid_connection_secret_ref(value: &str) -> bool {
    matches!(
        value,
        "cnb-token" | "registry.tcr.v2.password" | "registry.oci.password"
    )
}

#[allow(clippy::too_many_arguments)]
fn upsert_connection_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    provider: &str,
    name: &str,
    secret_ref: Option<&str>,
    metadata: &BTreeMap<String, String>,
    capabilities: &[String],
    status: &str,
    last_checked_at: Option<&str>,
) -> Result<(), String> {
    if !valid_connection_segment(id)
        || !matches!(kind, "source" | "registry" | "server")
        || !valid_connection_segment(provider)
        || name.trim().is_empty()
        || name.len() > 80
        || name.chars().any(char::is_control)
        || secret_ref.is_some_and(|value| !valid_connection_secret_ref(value))
        || !valid_connection_status(status)
        || capabilities.len() > 32
        || capabilities
            .iter()
            .any(|capability| !valid_connection_segment(capability))
    {
        return Err("连接记录格式不正确".to_string());
    }
    let metadata_json =
        serde_json::to_string(&safe_connection_metadata(metadata)).map_err(public_storage_error)?;
    let capabilities_json = serde_json::to_string(capabilities).map_err(public_storage_error)?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO connections (
               id, kind, provider, name, secret_ref, metadata_json,
               capabilities_json, status, last_checked_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               provider = excluded.provider,
               name = excluded.name,
               secret_ref = excluded.secret_ref,
               metadata_json = excluded.metadata_json,
               capabilities_json = excluded.capabilities_json,
               status = excluded.status,
               last_checked_at = COALESCE(excluded.last_checked_at, connections.last_checked_at),
               updated_at = excluded.updated_at",
            params![
                id,
                kind,
                provider,
                name.trim(),
                secret_ref,
                metadata_json,
                capabilities_json,
                status,
                last_checked_at,
                now
            ],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn existing_connection_state(
    connection: &Connection,
    id: &str,
) -> Result<Option<ExistingConnectionState>, String> {
    connection
        .query_row(
            "SELECT status, last_checked_at, metadata_json
             FROM connections WHERE id = ?1",
            [id],
            |row| {
                let metadata_json: String = row.get(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    serde_json::from_str::<BTreeMap<String, String>>(&metadata_json)
                        .map(|metadata| safe_connection_metadata(&metadata))
                        .unwrap_or_default(),
                ))
            },
        )
        .optional()
        .map_err(public_storage_error)
}

fn ensure_connection_kind(
    connection: &Connection,
    connection_id: &str,
    expected_kind: &str,
) -> Result<(), String> {
    let kind = connection
        .query_row(
            "SELECT kind FROM connections WHERE id = ?1",
            [connection_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(public_storage_error)?;
    match kind.as_deref() {
        Some(kind) if kind == expected_kind => Ok(()),
        Some(_) => Err("所选连接不适用于这个位置".to_string()),
        None => Err("所选连接已不存在，请重新选择".to_string()),
    }
}

fn server_resource_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<ServerResource>, String> {
    connection
        .query_row(
            "SELECT id, name, host, user, port, key_path, host_fingerprint,
                    last_checked_at
             FROM servers WHERE id = ?1",
            [id],
            server_resource_from_row,
        )
        .optional()
        .map_err(public_storage_error)
}

fn server_resource_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerResource> {
    let key_path: String = row.get(5)?;
    Ok(ServerResource {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        user: row.get(3)?,
        port: row.get(4)?,
        key_path_exists: Path::new(&key_path).is_file(),
        key_path,
        host_fingerprint: row.get(6)?,
        last_checked_at: row.get(7)?,
    })
}

fn config_profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConfigProfile> {
    let values_json: String = row.get(5)?;
    let secret_fields_json: String = row.get(6)?;
    let values = serde_json::from_str(&values_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let secret_fields = serde_json::from_str(&secret_fields_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(ConfigProfile {
        id: row.get(0)?,
        kind: row.get(1)?,
        provider: row.get(2)?,
        name: row.get(3)?,
        scope: row.get(4)?,
        values,
        secret_fields,
        configured_secret_fields: Vec::new(),
        is_default: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn validate_profile(profile: &ConfigProfile) -> Result<(), String> {
    validate_profile_segment(&profile.id, "连接编号")?;
    validate_profile_segment(&profile.kind, "连接类型")?;
    validate_profile_segment(&profile.provider, "服务提供方")?;
    if !matches!(profile.scope.as_str(), "any" | "local" | "remote") {
        return Err("连接适用环境格式不正确".to_string());
    }
    let name = profile.name.trim();
    if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        return Err("连接名称不能为空且不能超过 80 个字符".to_string());
    }
    if profile.values.len() > 40 || profile.secret_fields.len() > 40 {
        return Err("单个连接包含的配置项过多".to_string());
    }
    for key in profile.values.keys().chain(profile.secret_fields.iter()) {
        validate_profile_segment(key, "配置字段")?;
    }
    if profile.values.values().any(|value| value.contains('\0')) {
        return Err("连接配置包含无效字符".to_string());
    }
    Ok(())
}

fn validate_profile_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("{label}格式不正确"));
    }
    Ok(())
}

fn profile_scope_supports_environment(scope: &str, environment: &str) -> bool {
    scope == "any"
        || (scope == "local" && environment == "development")
        || (scope == "remote" && environment != "development")
}

fn valid_project_config_scope(value: &str) -> bool {
    matches!(value, "development" | "staging" | "production")
        || (value.starts_with("path-")
            && value.len() <= 80
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "本机项目记录暂时不可用，请重新启动应用".to_string()
}

fn ensure_server_fingerprint_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(servers)")
        .map_err(public_storage_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(public_storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(public_storage_error)?;
    if !columns.iter().any(|column| column == "host_fingerprint") {
        connection
            .execute("ALTER TABLE servers ADD COLUMN host_fingerprint TEXT", [])
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn ensure_config_profile_scope_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(config_profiles)")
        .map_err(public_storage_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(public_storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(public_storage_error)?;
    if !columns.iter().any(|column| column == "scope") {
        connection
            .execute(
                "ALTER TABLE config_profiles ADD COLUMN scope TEXT NOT NULL DEFAULT 'any'",
                [],
            )
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn ensure_project_storage_id_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(projects)")
        .map_err(public_storage_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(public_storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(public_storage_error)?;
    drop(statement);
    if !columns.iter().any(|column| column == "storage_id") {
        connection
            .execute("ALTER TABLE projects ADD COLUMN storage_id TEXT", [])
            .map_err(public_storage_error)?;
    }
    if !columns.iter().any(|column| column == "repository_hint") {
        connection
            .execute("ALTER TABLE projects ADD COLUMN repository_hint TEXT", [])
            .map_err(public_storage_error)?;
    }
    if !columns
        .iter()
        .any(|column| column == "identity_fingerprint")
    {
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN identity_fingerprint TEXT",
                [],
            )
            .map_err(public_storage_error)?;
    }

    let missing = {
        let mut statement = connection
            .prepare(
                "SELECT id, path FROM projects
                 WHERE storage_id IS NULL OR length(storage_id) <> 64",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    for (id, path) in missing {
        connection
            .execute(
                "UPDATE projects SET storage_id = ?1 WHERE id = ?2",
                params![project_id(&path), id],
            )
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn ensure_project_visibility_column(connection: &Connection) -> Result<(), String> {
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(projects)")
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    if !columns.iter().any(|column| column == "hidden_at") {
        connection
            .execute("ALTER TABLE projects ADD COLUMN hidden_at TEXT", [])
            .map_err(public_storage_error)?;
    }
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS projects_visible_recent
             ON projects(hidden_at, last_opened_at DESC)",
            [],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn ensure_project_adoption_columns(connection: &Connection) -> Result<(), String> {
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(projects)")
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    if !columns
        .iter()
        .any(|column| column == "deployment_adoption_mode")
    {
        // Existing projects intentionally enter `pending` once after this
        // upgrade. Silently classifying their old local rows as authoritative
        // recreates the confusing behaviour this gate is meant to remove.
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN deployment_adoption_mode TEXT NOT NULL DEFAULT 'pending'",
                [],
            )
            .map_err(public_storage_error)?;
    }
    if !columns
        .iter()
        .any(|column| column == "external_import_after")
    {
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN external_import_after TEXT",
                [],
            )
            .map_err(public_storage_error)?;
    }
    if !columns.iter().any(|column| column == "adoption_decided_at") {
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN adoption_decided_at TEXT",
                [],
            )
            .map_err(public_storage_error)?;
    }
    if !columns
        .iter()
        .any(|column| column == "deployment_fresh_draft")
    {
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN deployment_fresh_draft INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn ensure_project_profile_binding_schema(connection: &mut Connection) -> Result<(), String> {
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(project_profile_bindings)")
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, u32>(5)?))
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    let primary_key = columns
        .iter()
        .filter(|(_, position)| *position > 0)
        .map(|(name, position)| (*position, name.as_str()))
        .collect::<BTreeMap<_, _>>();
    let current = primary_key.get(&1) == Some(&"project_path")
        && primary_key.get(&2) == Some(&"environment")
        && primary_key.get(&3) == Some(&"profile_id")
        && primary_key.len() == 3;
    if current {
        connection
            .execute(
                "CREATE INDEX IF NOT EXISTS project_profile_bindings_environment
                 ON project_profile_bindings(project_path, environment, profile_kind)",
                [],
            )
            .map_err(public_storage_error)?;
        return Ok(());
    }

    let transaction = connection.transaction().map_err(public_storage_error)?;
    transaction
        .execute_batch(
            "DROP TABLE IF EXISTS project_profile_bindings_v2;
             CREATE TABLE project_profile_bindings_v2 (
               project_path TEXT NOT NULL,
               environment TEXT NOT NULL,
               profile_kind TEXT NOT NULL,
               profile_id TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(project_path, environment, profile_id),
               FOREIGN KEY(profile_id) REFERENCES config_profiles(id)
             );
             INSERT INTO project_profile_bindings_v2 (
               project_path, environment, profile_kind, profile_id, updated_at
             )
             SELECT project_path, environment, profile_kind, profile_id, updated_at
             FROM project_profile_bindings;
             DROP TABLE project_profile_bindings;
             ALTER TABLE project_profile_bindings_v2 RENAME TO project_profile_bindings;
             CREATE INDEX project_profile_bindings_environment
               ON project_profile_bindings(project_path, environment, profile_kind);",
        )
        .map_err(public_storage_error)?;
    transaction.commit().map_err(public_storage_error)
}

fn ensure_workspace_model_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS project_identities (
               project_id TEXT PRIMARY KEY,
               storage_id TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS project_identities_storage
               ON project_identities(storage_id);

             CREATE TABLE IF NOT EXISTS connections (
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               provider TEXT NOT NULL,
               name TEXT NOT NULL,
               secret_ref TEXT,
               metadata_json TEXT NOT NULL DEFAULT '{}',
               capabilities_json TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'unknown',
               last_checked_at TEXT,
               legacy_resource_kind TEXT,
               legacy_resource_id TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(legacy_resource_kind, legacy_resource_id)
             );
             CREATE INDEX IF NOT EXISTS connections_kind_provider
               ON connections(kind, provider, updated_at DESC);

             CREATE TABLE IF NOT EXISTS project_connection_bindings (
               project_id TEXT PRIMARY KEY,
               source_connection_id TEXT,
               updated_at TEXT NOT NULL,
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
               FOREIGN KEY(source_connection_id) REFERENCES connections(id) ON DELETE SET NULL
             );

             CREATE TABLE IF NOT EXISTS deployment_paths (
               id TEXT PRIMARY KEY,
               project_path TEXT NOT NULL,
               name TEXT NOT NULL,
               source_connection_id TEXT,
               registry_connection_id TEXT,
               server_id TEXT,
               config_profile_ids_json TEXT NOT NULL DEFAULT '[]',
               address TEXT NOT NULL DEFAULT '',
               routes_json TEXT NOT NULL DEFAULT '[]',
               state TEXT NOT NULL DEFAULT 'draft',
               last_run_id TEXT,
               last_successful_revision TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               FOREIGN KEY(source_connection_id) REFERENCES connections(id) ON DELETE SET NULL,
               FOREIGN KEY(registry_connection_id) REFERENCES connections(id) ON DELETE SET NULL,
               FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL,
               FOREIGN KEY(last_run_id) REFERENCES deployment_runs(id) ON DELETE SET NULL,
               FOREIGN KEY(project_path) REFERENCES projects(path) ON UPDATE CASCADE ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS deployment_paths_project
               ON deployment_paths(project_path, created_at ASC);
             CREATE INDEX IF NOT EXISTS deployment_paths_state
               ON deployment_paths(state, updated_at DESC);

             CREATE TABLE IF NOT EXISTS deployment_path_runs (
               path_id TEXT NOT NULL,
               run_id TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL,
               PRIMARY KEY(path_id, run_id),
               FOREIGN KEY(path_id) REFERENCES deployment_paths(id) ON DELETE CASCADE,
               FOREIGN KEY(run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS deployment_path_runs_path
               ON deployment_path_runs(path_id, created_at DESC);
             INSERT OR IGNORE INTO deployment_path_runs (path_id, run_id, created_at)
               SELECT id, last_run_id, updated_at
               FROM deployment_paths
               WHERE last_run_id IS NOT NULL;

             CREATE TABLE IF NOT EXISTS deployment_attempts (
               id TEXT PRIMARY KEY,
               task_id TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               status TEXT NOT NULL,
               current_stage TEXT NOT NULL,
               input_snapshot_json TEXT NOT NULL,
               output_json TEXT NOT NULL DEFAULT '{}',
               started_at TEXT NOT NULL,
               finished_at TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(task_id, ordinal),
               FOREIGN KEY(task_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS deployment_attempts_task
               ON deployment_attempts(task_id, ordinal DESC);

             CREATE TABLE IF NOT EXISTS versions (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               identity_key TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'available',
               commit_sha TEXT,
               source_title TEXT,
               source_connection_id TEXT,
               source_build_id TEXT,
               repository TEXT,
               branch TEXT,
               candidate_tag TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(project_id, identity_key),
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
               FOREIGN KEY(source_connection_id) REFERENCES connections(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS versions_project_created
               ON versions(project_id, created_at DESC);
             CREATE INDEX IF NOT EXISTS versions_commit
               ON versions(project_id, commit_sha);

             CREATE TABLE IF NOT EXISTS environments (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               name TEXT NOT NULL,
               display_name TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'unknown',
               target_connection_id TEXT,
               registry_connection_id TEXT,
               current_version_id TEXT,
               current_deployment_run_id TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(project_id, name),
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
               FOREIGN KEY(target_connection_id) REFERENCES connections(id) ON DELETE SET NULL,
               FOREIGN KEY(registry_connection_id) REFERENCES connections(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS environments_project
               ON environments(project_id, name);

             CREATE TABLE IF NOT EXISTS version_artifacts (
               id TEXT PRIMARY KEY,
               version_id TEXT NOT NULL,
               service TEXT NOT NULL,
               image TEXT NOT NULL,
               digest TEXT NOT NULL,
               platform TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               UNIQUE(version_id, service, image, digest, platform),
               FOREIGN KEY(version_id) REFERENCES versions(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS version_artifacts_version
               ON version_artifacts(version_id, service);
             CREATE INDEX IF NOT EXISTS version_artifacts_digest
               ON version_artifacts(digest);

             CREATE TABLE IF NOT EXISTS version_validations (
               id TEXT PRIMARY KEY,
               version_id TEXT NOT NULL,
               environment_id TEXT NOT NULL,
               deployment_run_id TEXT,
               status TEXT NOT NULL,
               verified_by TEXT,
               evidence_json TEXT NOT NULL DEFAULT '{}',
               verified_at TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               FOREIGN KEY(version_id) REFERENCES versions(id) ON DELETE CASCADE,
               FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE,
               FOREIGN KEY(deployment_run_id) REFERENCES deployment_runs(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS version_validations_version
               ON version_validations(version_id, status, verified_at DESC);
             CREATE INDEX IF NOT EXISTS version_validations_environment
               ON version_validations(environment_id, verified_at DESC);

             CREATE TABLE IF NOT EXISTS automation_rules (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               name TEXT NOT NULL,
               trigger_kind TEXT NOT NULL,
               action_kind TEXT NOT NULL,
               target_environment_id TEXT,
               source_connection_id TEXT,
               desired_state TEXT NOT NULL DEFAULT 'disabled',
               observed_state TEXT NOT NULL DEFAULT 'unknown',
               provider_rule_ref TEXT,
               configuration_json TEXT NOT NULL DEFAULT '{}',
               last_synced_at TEXT,
               last_error_code TEXT,
               last_error_message TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(project_id, name),
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
               FOREIGN KEY(target_environment_id) REFERENCES environments(id) ON DELETE SET NULL,
               FOREIGN KEY(source_connection_id) REFERENCES connections(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS automation_rules_project
               ON automation_rules(project_id, desired_state, updated_at DESC);",
        )
        .map_err(public_storage_error)
}

fn ensure_deployment_path_columns(connection: &Connection) -> Result<(), String> {
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(deployment_paths)")
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    if !columns.iter().any(|column| column == "routes_json") {
        connection
            .execute(
                "ALTER TABLE deployment_paths ADD COLUMN routes_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn setting_record(connection: &Connection, key: &str) -> Result<Option<(String, String)>, String> {
    connection
        .query_row(
            "SELECT value, updated_at FROM app_settings WHERE key = ?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(public_storage_error)
}

fn safe_setting_text(value: Option<&serde_json::Value>, fallback: &str) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= 120 && !value.chars().any(char::is_control)
        })
        .unwrap_or(fallback)
        .to_string()
}

fn valid_compat_namespace(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 100
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
}

fn valid_compat_registry_endpoint(value: &str) -> bool {
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

fn sync_compat_provider_connections_from_settings(connection: &Connection) -> Result<(), String> {
    if let Some((summary, _updated_at)) = setting_record(connection, "cnb.account.summary")?
        && let Ok(account) = serde_json::from_str::<serde_json::Value>(&summary)
        && account
            .get("connected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        let display_name = safe_setting_text(account.get("displayName"), "CNB")
            .chars()
            .take(60)
            .collect::<String>();
        let username = safe_setting_text(account.get("username"), "");
        let namespace = safe_setting_text(account.get("defaultNamespace"), "");
        let mut metadata =
            BTreeMap::from([("endpoint".to_string(), "https://cnb.cool".to_string())]);
        if !username.is_empty() {
            metadata.insert("username".to_string(), username);
        }
        if valid_compat_namespace(&namespace) {
            metadata.insert("namespace".to_string(), namespace);
        }
        let existing = existing_connection_state(connection, CNB_SOURCE_CONNECTION_ID)?;
        let status = existing
            .as_ref()
            .map(|(status, _, _)| status.as_str())
            .filter(|status| *status == "ready")
            .unwrap_or("unknown");
        let last_checked_at = existing
            .as_ref()
            .and_then(|(_, last_checked_at, _)| last_checked_at.as_deref());
        upsert_connection_record(
            connection,
            CNB_SOURCE_CONNECTION_ID,
            "source",
            "cnb",
            &format!("CNB · {display_name}"),
            Some("cnb-token"),
            &metadata,
            &[
                "repositories".to_string(),
                "builds".to_string(),
                "automation".to_string(),
            ],
            status,
            last_checked_at,
        )?;
    }

    let mode = setting_record(connection, "registry.mode")?;
    let namespace = setting_record(connection, "registry.tcr.namespace")?;
    let verified_endpoint = setting_record(connection, "registry.tcr.v2.verified-endpoint")?;
    let namespace_value = namespace
        .as_ref()
        .map(|(value, _)| value.trim())
        .filter(|value| valid_compat_namespace(value));
    let verified_value = verified_endpoint
        .as_ref()
        .map(|(value, _)| value.trim())
        .filter(|value| valid_compat_registry_endpoint(value));
    let has_tcr_fact = mode.as_ref().is_some_and(|(value, _)| value == "tcr")
        || namespace_value.is_some()
        || verified_value.is_some();
    if has_tcr_fact {
        let endpoint = verified_value.unwrap_or("ccr.ccs.tencentyun.com");
        let mut metadata = BTreeMap::from([("endpoint".to_string(), endpoint.to_string())]);
        if let Some(namespace) = namespace_value {
            metadata.insert("namespace".to_string(), namespace.to_string());
        }
        let existing = existing_connection_state(connection, TCR_REGISTRY_CONNECTION_ID)?;
        let same_validated_endpoint = existing.as_ref().is_some_and(|(_, _, metadata)| {
            metadata
                .get("endpoint")
                .is_some_and(|existing_endpoint| existing_endpoint == endpoint)
        });
        let status = existing
            .as_ref()
            .map(|(status, _, _)| status.as_str())
            .filter(|status| *status == "ready" && same_validated_endpoint)
            .unwrap_or("unknown");
        let last_checked_at = existing
            .as_ref()
            .filter(|_| same_validated_endpoint)
            .and_then(|(_, last_checked_at, _)| last_checked_at.as_deref());
        upsert_connection_record(
            connection,
            TCR_REGISTRY_CONNECTION_ID,
            "registry",
            "tcr",
            "腾讯云 TCR",
            Some("registry.tcr.v2.password"),
            &metadata,
            &["push".to_string(), "pull".to_string()],
            status,
            last_checked_at,
        )?;
    }
    Ok(())
}

fn sync_project_identity_and_environments(
    connection: &Connection,
    normalized_path: &str,
) -> Result<(), String> {
    let project = connection
        .query_row(
            "SELECT id, storage_id, created_at, last_opened_at
             FROM projects WHERE path = ?1",
            [normalized_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(public_storage_error)?;
    let Some((project_id, storage_id, created_at, updated_at)) = project else {
        return Ok(());
    };

    connection
        .execute(
            "INSERT INTO project_identities (project_id, storage_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               storage_id = excluded.storage_id,
               updated_at = excluded.updated_at",
            params![project_id, storage_id, created_at, updated_at],
        )
        .map_err(public_storage_error)?;
    for (name, display_name) in [
        ("development", "本机环境"),
        ("staging", "测试环境"),
        ("production", "生产环境"),
    ] {
        connection
            .execute(
                "INSERT INTO environments (
                   id, project_id, name, display_name, status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'unknown', ?5, ?6)
                 ON CONFLICT(project_id, name) DO NOTHING",
                params![
                    format!("{project_id}:{name}"),
                    project_id,
                    name,
                    display_name,
                    created_at,
                    updated_at
                ],
            )
            .map_err(public_storage_error)?;
    }
    Ok(())
}

fn sync_legacy_server_connection(connection: &Connection, server_id: &str) -> Result<(), String> {
    let server = connection
        .query_row(
            "SELECT name, host, user, port, host_fingerprint, last_checked_at
             FROM servers WHERE id = ?1",
            [server_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u16>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(public_storage_error)?;
    let Some((name, host, user, port, host_fingerprint, last_checked_at)) = server else {
        return Ok(());
    };
    let connection_id = format!("legacy-server:{server_id}");
    let mut metadata = BTreeMap::from([
        ("host".to_string(), host),
        ("user".to_string(), user),
        ("port".to_string(), port.to_string()),
    ]);
    if let Some(host_fingerprint) = host_fingerprint
        && !host_fingerprint.is_empty()
    {
        metadata.insert("hostFingerprint".to_string(), host_fingerprint);
    }
    let safe_name = name.chars().take(80).collect::<String>();
    upsert_connection_record(
        connection,
        &connection_id,
        "server",
        "ssh",
        if safe_name.is_empty() {
            "Linux 服务器"
        } else {
            &safe_name
        },
        None,
        &metadata,
        &[
            "deploy".to_string(),
            "healthcheck".to_string(),
            "reverse-proxy".to_string(),
        ],
        "configured",
        Some(&last_checked_at),
    )?;
    connection
        .execute(
            "UPDATE connections
             SET legacy_resource_kind = 'server', legacy_resource_id = ?1
             WHERE id = ?2",
            params![server_id, connection_id],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn sync_environment_server_connection(
    connection: &Connection,
    normalized_path: &str,
    environment: &str,
    server_id: &str,
    updated_at: &str,
) -> Result<(), String> {
    let display_name = match environment {
        "development" => "本机环境",
        "staging" => "测试环境",
        "production" => "生产环境",
        _ => environment,
    };
    connection
        .execute(
            "INSERT INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || ?2, p.id, ?2, ?3, 'unknown', p.created_at, ?4
             FROM projects p WHERE p.path = ?1
             ON CONFLICT(project_id, name) DO NOTHING",
            params![normalized_path, environment, display_name, updated_at],
        )
        .map_err(public_storage_error)?;
    connection
        .execute(
            "UPDATE environments
             SET target_connection_id = (
                   SELECT id FROM connections
                   WHERE legacy_resource_kind = 'server' AND legacy_resource_id = ?1
                   LIMIT 1
                 ),
                 updated_at = ?2
             WHERE project_id = (SELECT id FROM projects WHERE path = ?3)
               AND name = ?4",
            params![server_id, updated_at, normalized_path, environment],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn sync_deployment_run_links(connection: &Connection, run_id: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || d.environment, p.id, d.environment,
                    CASE d.environment
                      WHEN 'development' THEN '本机环境'
                      WHEN 'staging' THEN '测试环境'
                      WHEN 'production' THEN '生产环境'
                      ELSE d.environment
                    END,
                    'unknown', p.created_at, d.updated_at
             FROM deployment_runs d
             JOIN projects p ON p.path = d.project_path
             WHERE d.id = ?1
             ON CONFLICT(project_id, name) DO NOTHING",
            [run_id],
        )
        .map_err(public_storage_error)?;
    connection
        .execute(
            "UPDATE deployment_runs
             SET project_id = COALESCE(
                   project_id,
                   (SELECT p.id FROM projects p WHERE p.path = deployment_runs.project_path)
                 ),
                 environment_id = COALESCE(
                   environment_id,
                   (SELECT e.id
                    FROM projects p
                    JOIN environments e ON e.project_id = p.id
                    WHERE p.path = deployment_runs.project_path
                      AND e.name = deployment_runs.environment)
                 )
             WHERE id = ?1",
            [run_id],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn deployment_version_identity(run: &DeploymentRun) -> String {
    let mut artifacts = run
        .artifacts
        .iter()
        .filter_map(|artifact| {
            let digest = artifact.digest.trim();
            if digest.is_empty() {
                return None;
            }
            Some(format!(
                "{}\0{}\0{}",
                artifact.service.trim(),
                artifact.image.trim(),
                digest.to_ascii_lowercase()
            ))
        })
        .collect::<Vec<_>>();
    artifacts.sort();
    if !artifacts.is_empty() {
        return format!("images:{}", artifacts.join("\u{1}"));
    }
    if let Some(revision) = run.commit_sha.as_deref().filter(|value| !value.is_empty()) {
        return format!("commit:{revision}");
    }
    if let Some(candidate) = run
        .candidate_tag
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return format!("candidate:{candidate}");
    }
    format!("run:{}", run.id)
}

fn sync_successful_staging_version(
    connection: &Connection,
    run: &DeploymentRun,
) -> Result<(), String> {
    if run.environment != "staging" || run.status != "success" {
        return Ok(());
    }
    let links: Option<(String, String)> = connection
        .query_row(
            "SELECT project_id, environment_id FROM deployment_runs
             WHERE id = ?1 AND project_id IS NOT NULL AND environment_id IS NOT NULL",
            [&run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(public_storage_error)?;
    let Some((project_id_value, environment_id)) = links else {
        return Ok(());
    };

    let identity_key = deployment_version_identity(run);
    let proposed_version_id = project_id(&format!("version:{project_id_value}:{identity_key}"));
    connection
        .execute(
            "INSERT INTO versions (
               id, project_id, identity_key, status, commit_sha, source_title,
               source_build_id, repository, branch, candidate_tag, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'available', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(project_id, identity_key) DO UPDATE SET
               status = 'available',
               commit_sha = COALESCE(excluded.commit_sha, versions.commit_sha),
               source_title = COALESCE(excluded.source_title, versions.source_title),
               source_build_id = COALESCE(excluded.source_build_id, versions.source_build_id),
               repository = COALESCE(NULLIF(excluded.repository, ''), versions.repository),
               branch = COALESCE(NULLIF(excluded.branch, ''), versions.branch),
               candidate_tag = COALESCE(excluded.candidate_tag, versions.candidate_tag),
               updated_at = excluded.updated_at",
            params![
                proposed_version_id,
                project_id_value,
                identity_key,
                run.commit_sha,
                run.source_title,
                run.build_serial,
                run.repository,
                run.branch,
                run.candidate_tag,
                run.started_at,
                run.updated_at
            ],
        )
        .map_err(public_storage_error)?;
    let version_id: String = connection
        .query_row(
            "SELECT id FROM versions WHERE project_id = ?1 AND identity_key = ?2",
            params![project_id_value, identity_key],
            |row| row.get(0),
        )
        .map_err(public_storage_error)?;

    for artifact in run
        .artifacts
        .iter()
        .filter(|artifact| !artifact.digest.trim().is_empty())
    {
        let service = artifact.service.trim();
        let image = artifact.image.trim();
        let digest = artifact.digest.trim().to_ascii_lowercase();
        let artifact_id = project_id(&format!(
            "version-artifact:{version_id}:{service}:{image}:{digest}"
        ));
        connection
            .execute(
                "INSERT OR IGNORE INTO version_artifacts (
                   id, version_id, service, image, digest, platform, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6)",
                params![
                    artifact_id,
                    version_id,
                    service,
                    image,
                    digest,
                    run.updated_at
                ],
            )
            .map_err(public_storage_error)?;
    }
    connection
        .execute(
            "UPDATE deployment_runs SET version_id = ?1 WHERE id = ?2",
            params![version_id, run.id],
        )
        .map_err(public_storage_error)?;
    connection
        .execute(
            "UPDATE environments
             SET current_version_id = ?1,
                 current_deployment_run_id = ?2,
                 status = 'healthy',
                 updated_at = ?3
             WHERE id = ?4
               AND NOT EXISTS (
                 SELECT 1 FROM deployment_runs newer
                 WHERE newer.environment_id = ?4
                   AND newer.status = 'success'
                   AND newer.version_id IS NOT NULL
                   AND (
                     newer.started_at > ?5 OR
                     (newer.started_at = ?5 AND newer.id > ?2)
                   )
               )",
            params![
                version_id,
                run.id,
                run.updated_at,
                environment_id,
                run.started_at
            ],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn deployment_artifact_digests(
    artifacts: &[DeploymentArtifact],
) -> Result<BTreeSet<String>, String> {
    artifacts
        .iter()
        .map(|artifact| {
            let digest = artifact.digest.trim();
            if digest.is_empty() {
                return Err(format!(
                    "生产发布记录中的服务“{}”缺少不可变镜像摘要",
                    artifact.service.trim()
                ));
            }
            Ok(digest.to_ascii_lowercase())
        })
        .collect()
}

fn invalid_production_version_link(strict: bool, message: &str) -> Result<(), String> {
    if strict {
        Err(format!("无法确认生产环境当前版本：{message}"))
    } else {
        Ok(())
    }
}

fn sync_successful_production_version(
    connection: &Connection,
    run: &DeploymentRun,
    strict: bool,
) -> Result<(), String> {
    if run.environment != "production" || run.status != "success" {
        return Ok(());
    }
    let Some(source_run_id) = run.source_run_id.as_deref() else {
        return invalid_production_version_link(strict, "正式发布缺少测试版本来源");
    };
    let source: Option<(String, String, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT environment, status, project_id, version_id
             FROM deployment_runs WHERE id = ?1",
            [source_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(public_storage_error)?;
    let Some((source_environment, source_status, source_project_id, source_version_id)) = source
    else {
        return invalid_production_version_link(strict, "找不到关联的测试版本记录");
    };
    if source_environment != "staging" || source_status != "success" {
        return invalid_production_version_link(strict, "来源不是已成功部署的测试版本");
    }
    let Some(source_project_id) = source_project_id else {
        return invalid_production_version_link(strict, "测试版本尚未关联当前项目");
    };
    let Some(version_id) = source_version_id else {
        return invalid_production_version_link(strict, "测试版本尚未生成不可变版本记录");
    };
    let production_links: Option<(String, String)> = connection
        .query_row(
            "SELECT project_id, environment_id FROM deployment_runs
             WHERE id = ?1 AND project_id IS NOT NULL AND environment_id IS NOT NULL",
            [&run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(public_storage_error)?;
    let Some((production_project_id, environment_id)) = production_links else {
        return invalid_production_version_link(strict, "正式发布尚未关联当前项目");
    };
    if production_project_id != source_project_id {
        return invalid_production_version_link(strict, "测试版本不属于当前项目");
    }

    if !run.artifacts.is_empty() {
        let production_digests = match deployment_artifact_digests(&run.artifacts) {
            Ok(digests) => digests,
            Err(message) => {
                return invalid_production_version_link(strict, &message);
            }
        };
        let source_digests = {
            let mut statement = connection
                .prepare("SELECT digest FROM version_artifacts WHERE version_id = ?1")
                .map_err(public_storage_error)?;
            let rows = statement
                .query_map([&version_id], |row| row.get::<_, String>(0))
                .map_err(public_storage_error)?;
            rows.collect::<Result<BTreeSet<_>, _>>()
                .map_err(public_storage_error)?
                .into_iter()
                .map(|digest| digest.trim().to_ascii_lowercase())
                .collect::<BTreeSet<_>>()
        };
        if production_digests != source_digests {
            return invalid_production_version_link(strict, "生产镜像摘要与测试通过版本不一致");
        }
    }

    // Production deliberately reuses the staging version id. A production
    // success must never create or reconstruct a second version identity.
    connection
        .execute(
            "UPDATE deployment_runs SET version_id = ?1 WHERE id = ?2",
            params![version_id, run.id],
        )
        .map_err(public_storage_error)?;
    connection
        .execute(
            "UPDATE environments
             SET current_version_id = ?1,
                 current_deployment_run_id = ?2,
                 status = 'healthy',
                 updated_at = ?3
             WHERE id = ?4
               AND NOT EXISTS (
                 SELECT 1 FROM deployment_runs newer
                 WHERE newer.environment_id = ?4
                   AND newer.status = 'success'
                   AND newer.version_id IS NOT NULL
                   AND (
                     newer.started_at > ?5 OR
                     (newer.started_at = ?5 AND newer.id > ?2)
                   )
               )",
            params![
                version_id,
                run.id,
                run.updated_at,
                environment_id,
                run.started_at
            ],
        )
        .map_err(public_storage_error)?;
    Ok(())
}

/// Rebuild the compatibility release model for one adopted project. This is
/// intentionally local-only and runs inside the same transaction that records
/// the user's "continue managing" choice.
fn backfill_project_release_model(
    connection: &Connection,
    normalized_path: &str,
) -> Result<(), String> {
    sync_project_identity_and_environments(connection, normalized_path)?;

    let server_bindings = {
        let mut statement = connection
            .prepare(
                "SELECT environment, server_id, updated_at
                 FROM project_server_bindings
                 WHERE project_path = ?1
                   AND environment IN ('staging', 'production')
                 ORDER BY environment",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized_path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    for (environment, server_id, updated_at) in server_bindings {
        sync_legacy_server_connection(connection, &server_id)?;
        sync_environment_server_connection(
            connection,
            normalized_path,
            &environment,
            &server_id,
            &updated_at,
        )?;
    }

    let runs = {
        let mut statement = connection
            .prepare(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE project_path = ?1
                 ORDER BY started_at ASC, id ASC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([normalized_path], deployment_run_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };

    // Link every historic task first, then build all staging versions before
    // production pointers. This removes any dependence on provider/run order.
    for run in &runs {
        sync_deployment_run_links(connection, &run.id)?;
    }
    for run in &runs {
        sync_successful_staging_version(connection, run)?;
    }
    for run in &runs {
        sync_successful_production_version(connection, run, false)?;
    }
    Ok(())
}

fn backfill_successful_staging_versions(connection: &Connection) -> Result<(), String> {
    let runs = {
        let mut statement = connection
            .prepare(
                "SELECT d.id, d.project_path, d.project_name, d.environment, d.status,
                        d.current_stage, d.build_serial, d.commit_sha, d.source_title,
                        d.source_run_id, d.candidate_tag, d.artifacts, d.action_kind,
                        d.action_url, d.issue_code, d.repository, d.branch, d.message,
                        d.completed_steps, d.started_at, d.updated_at
                 FROM deployment_runs d
                 JOIN projects p ON p.path = d.project_path
                 WHERE d.environment = 'staging' AND d.status = 'success'
                   AND p.deployment_adoption_mode <> 'pending'
                   AND p.deployment_fresh_draft = 0
                 ORDER BY d.started_at ASC, d.id ASC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    for run in runs {
        sync_deployment_run_links(connection, &run.id)?;
        sync_successful_staging_version(connection, &run)?;
    }
    Ok(())
}

fn backfill_successful_production_versions(connection: &Connection) -> Result<(), String> {
    let runs = {
        let mut statement = connection
            .prepare(
                "SELECT d.id, d.project_path, d.project_name, d.environment, d.status,
                        d.current_stage, d.build_serial, d.commit_sha, d.source_title,
                        d.source_run_id, d.candidate_tag, d.artifacts, d.action_kind,
                        d.action_url, d.issue_code, d.repository, d.branch, d.message,
                        d.completed_steps, d.started_at, d.updated_at
                 FROM deployment_runs d
                 JOIN projects p ON p.path = d.project_path
                 WHERE d.environment = 'production' AND d.status = 'success'
                   AND p.deployment_adoption_mode <> 'pending'
                   AND p.deployment_fresh_draft = 0
                 ORDER BY d.started_at ASC, d.id ASC",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    for run in runs {
        sync_deployment_run_links(connection, &run.id)?;
        // Historic records may be incomplete or may predate immutable digest
        // capture. They remain visible in deployment history, but only a
        // verifiable success is allowed to become the online version pointer.
        sync_successful_production_version(connection, &run, false)?;
    }
    Ok(())
}

fn backfill_workspace_model(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(public_storage_error)?;
    transaction
        .execute_batch(
            "INSERT INTO project_identities (project_id, storage_id, created_at, updated_at)
             SELECT id, storage_id, created_at, last_opened_at FROM projects
             WHERE storage_id IS NOT NULL AND storage_id <> ''
             ON CONFLICT(project_id) DO UPDATE SET
               storage_id = excluded.storage_id,
               updated_at = excluded.updated_at;

             INSERT OR IGNORE INTO connections (
               id, kind, provider, name, secret_ref, metadata_json,
               capabilities_json, status, last_checked_at,
               legacy_resource_kind, legacy_resource_id, created_at, updated_at
             )
             SELECT 'legacy-server:' || id, 'server', 'ssh', name, NULL, '{}', '[]',
                    'unknown', last_checked_at, 'server', id, created_at, last_checked_at
             FROM servers;

             UPDATE connections
             SET name = (
                   SELECT s.name FROM servers s
                   WHERE s.id = connections.legacy_resource_id
                 ),
                 last_checked_at = (
                   SELECT s.last_checked_at FROM servers s
                   WHERE s.id = connections.legacy_resource_id
                 ),
                 updated_at = (
                   SELECT s.last_checked_at FROM servers s
                   WHERE s.id = connections.legacy_resource_id
                 )
             WHERE legacy_resource_kind = 'server'
               AND EXISTS (
                 SELECT 1 FROM servers s WHERE s.id = connections.legacy_resource_id
               );

             INSERT OR IGNORE INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || names.name, p.id, names.name,
                    CASE names.name
                      WHEN 'development' THEN '本机环境'
                      WHEN 'staging' THEN '测试环境'
                      WHEN 'production' THEN '生产环境'
                      ELSE names.name
                    END,
                    'unknown', p.created_at, p.last_opened_at
             FROM projects p
             CROSS JOIN (
               SELECT 'development' AS name
               UNION ALL SELECT 'staging'
               UNION ALL SELECT 'production'
             ) names;

             INSERT OR IGNORE INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || d.environment, p.id, d.environment, d.environment,
                    'unknown', p.created_at, d.updated_at
             FROM deployment_runs d
             JOIN projects p ON p.path = d.project_path
             WHERE d.environment <> ''
               AND p.deployment_adoption_mode <> 'pending'
               AND p.deployment_fresh_draft = 0;

             INSERT OR IGNORE INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || b.environment, p.id, b.environment, b.environment,
                    'unknown', p.created_at, b.updated_at
             FROM project_server_bindings b
             JOIN projects p ON p.path = b.project_path
             WHERE b.environment <> ''
               AND p.deployment_adoption_mode <> 'pending'
               AND p.deployment_fresh_draft = 0;

             INSERT OR IGNORE INTO environments (
               id, project_id, name, display_name, status, created_at, updated_at
             )
             SELECT p.id || ':' || b.environment, p.id, b.environment, b.environment,
                    'unknown', p.created_at, b.updated_at
             FROM project_profile_bindings b
             JOIN projects p ON p.path = b.project_path
             WHERE b.environment <> ''
               AND p.deployment_adoption_mode <> 'pending'
               AND p.deployment_fresh_draft = 0;

             UPDATE environments
             SET target_connection_id = (
               SELECT c.id
               FROM projects p
               JOIN project_server_bindings b ON b.project_path = p.path
               JOIN connections c
                 ON c.legacy_resource_kind = 'server'
                AND c.legacy_resource_id = b.server_id
               WHERE p.id = environments.project_id
                 AND b.environment = environments.name
                 AND p.deployment_adoption_mode <> 'pending'
                 AND p.deployment_fresh_draft = 0
               LIMIT 1
             )
             WHERE target_connection_id IS NULL
               AND EXISTS (
                 SELECT 1
                 FROM projects p
                 JOIN project_server_bindings b ON b.project_path = p.path
                 JOIN connections c
                   ON c.legacy_resource_kind = 'server'
                  AND c.legacy_resource_id = b.server_id
                 WHERE p.id = environments.project_id
                   AND b.environment = environments.name
                   AND p.deployment_adoption_mode <> 'pending'
                   AND p.deployment_fresh_draft = 0
               );

             UPDATE deployment_runs
             SET project_id = (
               SELECT p.id FROM projects p
               WHERE p.path = deployment_runs.project_path
                 AND p.deployment_adoption_mode <> 'pending'
                 AND p.deployment_fresh_draft = 0
             )
             WHERE project_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM projects p
                 WHERE p.path = deployment_runs.project_path
                   AND p.deployment_adoption_mode <> 'pending'
                   AND p.deployment_fresh_draft = 0
               );

             UPDATE deployment_runs
             SET environment_id = (
               SELECT e.id FROM environments e
               WHERE e.project_id = deployment_runs.project_id
                 AND e.name = deployment_runs.environment
             )
             WHERE environment_id IS NULL
               AND project_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM projects p
                 WHERE p.id = deployment_runs.project_id
                   AND p.deployment_adoption_mode <> 'pending'
                   AND p.deployment_fresh_draft = 0
               );",
        )
        .map_err(public_storage_error)?;
    transaction.commit().map_err(public_storage_error)?;
    let server_ids = {
        let mut statement = connection
            .prepare("SELECT id FROM servers ORDER BY id")
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)?
    };
    for server_id in server_ids {
        sync_legacy_server_connection(connection, &server_id)?;
    }
    Ok(())
}

fn ensure_deployment_run_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(deployment_runs)")
        .map_err(public_storage_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(public_storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(public_storage_error)?;
    for (column, sql) in [
        (
            "commit_sha",
            "ALTER TABLE deployment_runs ADD COLUMN commit_sha TEXT",
        ),
        (
            "source_run_id",
            "ALTER TABLE deployment_runs ADD COLUMN source_run_id TEXT",
        ),
        (
            "source_title",
            "ALTER TABLE deployment_runs ADD COLUMN source_title TEXT",
        ),
        (
            "candidate_tag",
            "ALTER TABLE deployment_runs ADD COLUMN candidate_tag TEXT",
        ),
        (
            "artifacts",
            "ALTER TABLE deployment_runs ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "action_kind",
            "ALTER TABLE deployment_runs ADD COLUMN action_kind TEXT",
        ),
        (
            "action_url",
            "ALTER TABLE deployment_runs ADD COLUMN action_url TEXT",
        ),
        (
            "issue_code",
            "ALTER TABLE deployment_runs ADD COLUMN issue_code TEXT",
        ),
        (
            "project_id",
            "ALTER TABLE deployment_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
        ),
        (
            "environment_id",
            "ALTER TABLE deployment_runs ADD COLUMN environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL",
        ),
        (
            "version_id",
            "ALTER TABLE deployment_runs ADD COLUMN version_id TEXT REFERENCES versions(id) ON DELETE SET NULL",
        ),
        (
            "task_kind",
            "ALTER TABLE deployment_runs ADD COLUMN task_kind TEXT",
        ),
        (
            "target_snapshot_json",
            "ALTER TABLE deployment_runs ADD COLUMN target_snapshot_json TEXT",
        ),
        (
            "config_snapshot_json",
            "ALTER TABLE deployment_runs ADD COLUMN config_snapshot_json TEXT",
        ),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection.execute(sql, []).map_err(public_storage_error)?;
        }
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS deployment_runs_project_identity
               ON deployment_runs(project_id, started_at DESC);
             CREATE INDEX IF NOT EXISTS deployment_runs_environment_identity
               ON deployment_runs(environment_id, started_at DESC);
             CREATE INDEX IF NOT EXISTS deployment_runs_version_identity
               ON deployment_runs(version_id, started_at DESC);",
        )
        .map_err(public_storage_error)?;
    Ok(())
}

fn public_storage_error(error: impl std::fmt::Display) -> String {
    format!("无法更新本机项目记录：{error}")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use deploy_core::model::PublicRouteStatus;
    use deploy_core::providers::ssh::SshProfile;
    use rusqlite::Connection;

    use super::{
        CNB_SOURCE_CONNECTION_ID, ConfigProfile, DeploymentArtifact, DeploymentPathInput,
        DeploymentPathRoute, DeploymentRun, DeploymentRunLinks, TCR_REGISTRY_CONNECTION_ID,
        WorkspaceState, encode_uri_component, project_storage_id,
    };

    fn save_successful_staging_run(
        database: &WorkspaceState,
        project_path: &std::path::Path,
        commit_sha: &str,
        artifacts: Vec<DeploymentArtifact>,
    ) -> DeploymentRun {
        let mut run = database
            .create_deployment_run(project_path, "sample", "staging", "owner/sample", "main")
            .expect("create staging run");
        run.status = "success".to_string();
        run.current_stage = "complete".to_string();
        run.commit_sha = Some(commit_sha.to_string());
        run.candidate_tag = Some(format!("candidate-{commit_sha}"));
        run.artifacts = artifacts;
        run.message = "测试环境部署成功".to_string();
        database
            .save_deployment_run(&run)
            .expect("save successful staging run");
        run
    }

    fn save_successful_production_run(
        database: &WorkspaceState,
        source: &DeploymentRun,
        artifacts: Vec<DeploymentArtifact>,
        started_at: &str,
    ) -> DeploymentRun {
        let mut run = database
            .create_deployment_run(
                std::path::Path::new(&source.project_path),
                &source.project_name,
                "production",
                &source.repository,
                &source.branch,
            )
            .expect("create production run");
        run.status = "success".to_string();
        run.current_stage = "complete".to_string();
        run.commit_sha.clone_from(&source.commit_sha);
        run.source_title.clone_from(&source.source_title);
        run.source_run_id = Some(source.id.clone());
        run.candidate_tag.clone_from(&source.candidate_tag);
        run.artifacts = artifacts;
        run.started_at = started_at.to_string();
        run.updated_at = started_at.to_string();
        run.message = "生产环境部署成功".to_string();
        database
            .save_deployment_run(&run)
            .expect("save successful production run");
        run
    }

    fn release_model_ids(database: &WorkspaceState) -> BTreeMap<String, Vec<String>> {
        let connection = database.connection.lock().expect("database lock");
        let queries = [
            ("projects", "SELECT id FROM projects ORDER BY id"),
            (
                "project-identities",
                "SELECT project_id || ':' || storage_id FROM project_identities ORDER BY project_id",
            ),
            ("environments", "SELECT id FROM environments ORDER BY id"),
            ("versions", "SELECT id FROM versions ORDER BY id"),
            (
                "version-artifacts",
                "SELECT id FROM version_artifacts ORDER BY id",
            ),
            (
                "version-validations",
                "SELECT id FROM version_validations ORDER BY id",
            ),
            (
                "automation-rules",
                "SELECT id FROM automation_rules ORDER BY id",
            ),
            ("deployment-tasks", "SELECT id FROM deployment_runs ORDER BY id"),
            (
                "server-bindings",
                "SELECT project_path || ':' || environment || ':' || server_id
                 FROM project_server_bindings ORDER BY project_path, environment, server_id",
            ),
            (
                "config-bindings",
                "SELECT project_path || ':' || environment || ':' || profile_kind || ':' || profile_id
                 FROM project_profile_bindings
                 ORDER BY project_path, environment, profile_kind, profile_id",
            ),
            (
                "source-bindings",
                "SELECT project_id || ':' || COALESCE(source_connection_id, '')
                 FROM project_connection_bindings ORDER BY project_id",
            ),
            (
                "environment-connections",
                "SELECT id || ':' || COALESCE(target_connection_id, '') || ':' ||
                        COALESCE(registry_connection_id, '')
                 FROM environments ORDER BY id",
            ),
        ];
        queries
            .into_iter()
            .map(|(name, query)| {
                let mut statement = connection.prepare(query).expect("snapshot query");
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .expect("query release model ids")
                    .collect::<Result<Vec<_>, _>>()
                    .expect("collect release model ids");
                (name.to_string(), ids)
            })
            .collect()
    }

    #[test]
    fn deployment_paths_are_project_scoped_reusable_connection_bindings() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        database
            .upsert_compat_connection(
                CNB_SOURCE_CONNECTION_ID,
                "source",
                "cnb",
                "CNB",
                Some("cnb-token"),
                &BTreeMap::new(),
                &["builds".to_string()],
                "ready",
                Some("2026-07-18T00:00:00Z"),
            )
            .expect("source connection");
        database
            .upsert_compat_connection(
                TCR_REGISTRY_CONNECTION_ID,
                "registry",
                "tcr",
                "腾讯云 TCR",
                Some("registry.tcr.v2.password"),
                &BTreeMap::new(),
                &["push".to_string(), "pull".to_string()],
                "ready",
                Some("2026-07-18T00:00:00Z"),
            )
            .expect("registry connection");
        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "private-key-placeholder").expect("write key");
        let server = database
            .bind_project_server(
                &project_path,
                "staging",
                &SshProfile {
                    name: "运行服务器".to_string(),
                    host: "203.0.113.80".to_string(),
                    user: "ubuntu".to_string(),
                    port: 22,
                    key_path,
                    host_fingerprint: Some("SHA256:confirmed".to_string()),
                },
            )
            .expect("save server");

        let saved = database
            .save_deployment_path(DeploymentPathInput {
                id: None,
                project_path: project_path.to_string_lossy().into_owned(),
                name: "上线".to_string(),
                source_connection_id: Some(CNB_SOURCE_CONNECTION_ID.to_string()),
                registry_connection_id: Some(TCR_REGISTRY_CONNECTION_ID.to_string()),
                server_id: Some(server.id.clone()),
                config_profile_ids: Vec::new(),
                address: "app.example.com".to_string(),
                routes: vec![DeploymentPathRoute {
                    service: "web".to_string(),
                    host: "app.example.com".to_string(),
                    path: "/".to_string(),
                }],
                state: Some("ready".to_string()),
                last_run_id: None,
                last_successful_revision: None,
            })
            .expect("save deployment path");
        assert_eq!(saved.name, "上线");
        assert_eq!(saved.server_id.as_deref(), Some(server.id.as_str()));

        let restored = database
            .list_deployment_paths(&project_path)
            .expect("restore deployment paths");
        assert_eq!(restored, vec![saved.clone()]);

        let deploying = database
            .save_deployment_path(DeploymentPathInput {
                id: Some(saved.id.clone()),
                project_path: project_path.to_string_lossy().into_owned(),
                name: "线上服务器".to_string(),
                source_connection_id: saved.source_connection_id.clone(),
                registry_connection_id: saved.registry_connection_id.clone(),
                server_id: saved.server_id.clone(),
                config_profile_ids: Vec::new(),
                address: saved.address.clone(),
                routes: saved.routes.clone(),
                state: Some("deploying".to_string()),
                last_run_id: None,
                last_successful_revision: None,
            })
            .expect("update deployment path");
        assert_eq!(deploying.name, "线上服务器");
        assert!(
            database
                .delete_deployment_path(&project_path, &deploying.id)
                .is_err(),
            "an in-flight path must not disappear"
        );
    }

    #[test]
    fn deployment_retries_append_attempts_and_freeze_the_path_snapshot() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let deployment_path = database
            .save_deployment_path(DeploymentPathInput {
                id: None,
                project_path: project_path.to_string_lossy().into_owned(),
                name: "上线".to_string(),
                source_connection_id: None,
                registry_connection_id: None,
                server_id: None,
                config_profile_ids: Vec::new(),
                address: "app.example.com".to_string(),
                routes: vec![DeploymentPathRoute {
                    service: "web".to_string(),
                    host: "app.example.com".to_string(),
                    path: "/".to_string(),
                }],
                state: Some("ready".to_string()),
                last_run_id: None,
                last_successful_revision: None,
            })
            .expect("save path");
        let mut task = database
            .create_deployment_run(&project_path, "sample", "staging", "team/sample", "main")
            .expect("create task");
        database
            .bind_deployment_path_run(&deployment_path.id, &task.id)
            .expect("bind task to path");

        let first = database
            .begin_deployment_attempt(&task.id)
            .expect("begin first attempt");
        let duplicate = database
            .begin_deployment_attempt(&task.id)
            .expect("reuse open attempt");
        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.input_snapshot["deploymentPathId"], deployment_path.id);
        assert_eq!(first.input_snapshot["address"], "app.example.com");

        task.status = "needs_action".to_string();
        task.current_stage = "prepare-server".to_string();
        task.issue_code = Some("AD-SSH-102".to_string());
        task.message = "服务器暂时无法连接".to_string();
        database
            .save_deployment_run(&task)
            .expect("finish first attempt");

        let second = database
            .begin_deployment_attempt(&task.id)
            .expect("begin retry attempt");
        assert_ne!(first.id, second.id);
        assert_eq!(second.ordinal, 2);
        let attempts = database
            .list_deployment_attempts(&task.id)
            .expect("list attempts");
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].status, "needs_action");
        assert!(attempts[0].finished_at.is_some());
        assert_eq!(attempts[1].status, "running");

        task.status = "success".to_string();
        task.current_stage = "complete".to_string();
        task.commit_sha = Some("0123456789abcdef0123456789abcdef01234567".to_string());
        database.save_deployment_run(&task).expect("finish retry");
        let next_task = database
            .create_deployment_run(&project_path, "sample", "deployment", "team/sample", "main")
            .expect("create next task");
        database
            .bind_deployment_path_run(&deployment_path.id, &next_task.id)
            .expect("bind next task");
        let history = database
            .list_deployment_path_runs(&deployment_path.id)
            .expect("list path history");
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|run| run.id == task.id));
        assert_eq!(
            database
                .deployment_path_for_run(&task.id)
                .expect("find old task path")
                .id,
            deployment_path.id
        );
    }

    #[test]
    fn creates_first_class_model_foundation_without_copying_secrets() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 2)
            .expect("remember project");
        database
            .set_setting("legacy-cnb-token", "must-not-be-copied")
            .expect("store legacy secret setting");

        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "private-key-placeholder").expect("write key placeholder");
        let server = SshProfile {
            name: "测试服务器".to_string(),
            host: "203.0.113.31".to_string(),
            user: "ubuntu".to_string(),
            port: 22,
            key_path,
            host_fingerprint: Some("SHA256:model-foundation".to_string()),
        };
        database
            .bind_project_server(&project_path, "staging", &server)
            .expect("bind server");
        let run = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create deployment");

        let project = database.list_projects().expect("list projects")[0].clone();
        {
            let connection = database.connection.lock().expect("database lock");
            let model_table_count: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table' AND name IN (
                       'project_identities', 'connections', 'environments', 'versions',
                       'version_artifacts', 'version_validations', 'automation_rules',
                       'project_connection_bindings'
                     )",
                    [],
                    |row| row.get(0),
                )
                .expect("model tables");
            assert_eq!(model_table_count, 8);

            let stored_identity: String = connection
                .query_row(
                    "SELECT storage_id FROM project_identities WHERE project_id = ?1",
                    [&project.id],
                    |row| row.get(0),
                )
                .expect("project identity");
            assert_eq!(stored_identity, project_storage_id(&project_path));
            let environment_count: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM environments WHERE project_id = ?1",
                    [&project.id],
                    |row| row.get(0),
                )
                .expect("environments");
            assert_eq!(environment_count, 3);

            let (secret_ref, metadata, capabilities, status, legacy_server_id): (
                Option<String>,
                String,
                String,
                String,
                String,
            ) = connection
                .query_row(
                    "SELECT secret_ref, metadata_json, capabilities_json, status,
                            legacy_resource_id
                     FROM connections WHERE kind = 'server'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .expect("server connection");
            assert!(secret_ref.is_none());
            assert_eq!(
                serde_json::from_str::<BTreeMap<String, String>>(&metadata)
                    .expect("safe server metadata"),
                BTreeMap::from([
                    ("host".to_string(), "203.0.113.31".to_string()),
                    (
                        "hostFingerprint".to_string(),
                        "SHA256:model-foundation".to_string()
                    ),
                    ("port".to_string(), "22".to_string()),
                    ("user".to_string(), "ubuntu".to_string()),
                ])
            );
            assert_eq!(
                serde_json::from_str::<Vec<String>>(&capabilities).expect("server capabilities"),
                vec!["deploy", "healthcheck", "reverse-proxy"]
            );
            assert_eq!(status, "configured");
            assert!(!metadata.contains("must-not-be-copied"));
            assert!(!metadata.contains("private-key-placeholder"));

            let target_connection: String = connection
                .query_row(
                    "SELECT target_connection_id FROM environments
                     WHERE project_id = ?1 AND name = 'staging'",
                    [&project.id],
                    |row| row.get(0),
                )
                .expect("staging target connection");
            assert_eq!(
                target_connection,
                format!("legacy-server:{legacy_server_id}")
            );

            let links: DeploymentRunLinks = connection
                .query_row(
                    "SELECT project_id, environment_id, version_id, task_kind,
                            target_snapshot_json, config_snapshot_json
                     FROM deployment_runs WHERE id = ?1",
                    [&run.id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .expect("deployment links");
            assert_eq!(links.0.as_deref(), Some(project.id.as_str()));
            assert_eq!(
                links.1.as_deref(),
                Some(format!("{}:staging", project.id).as_str())
            );
            assert!(links.2.is_none());
            assert!(links.3.is_none());
            assert!(links.4.is_none());
            assert!(links.5.is_none());

            let foreign_key_violations: u32 = connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .expect("foreign key check");
            assert_eq!(foreign_key_violations, 0);
        }

        assert!(
            database
                .remove_project(&project_path)
                .expect("remove project")
        );
        assert!(
            database
                .list_projects()
                .expect("hidden projects")
                .is_empty()
        );
        assert_eq!(
            database
                .deployment_run(&run.id)
                .expect("deployment remains")
                .id,
            run.id
        );
        let connection = database.connection.lock().expect("database lock");
        let preserved_links: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT project_id, environment_id FROM deployment_runs WHERE id = ?1",
                [&run.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("preserved deployment links");
        assert_eq!(preserved_links.0.as_deref(), Some(project.id.as_str()));
        assert_eq!(
            preserved_links.1.as_deref(),
            Some(format!("{}:staging", project.id).as_str())
        );
        let hidden_at: Option<String> = connection
            .query_row(
                "SELECT hidden_at FROM projects WHERE id = ?1",
                [&project.id],
                |row| row.get(0),
            )
            .expect("soft-hidden project");
        assert!(hidden_at.is_some());
    }

    #[test]
    fn connection_resources_backfill_legacy_providers_without_exposing_secrets() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        database
            .set_setting(
                "cnb.account.summary",
                r#"{
                  "connected": true,
                  "displayName": "示例账号",
                  "username": "safe-user",
                  "defaultNamespace": "safe-team",
                  "token": "cnb-secret-sentinel",
                  "password": "password-sentinel",
                  "privateKey": "private-key-sentinel"
                }"#,
            )
            .expect("save safe account summary");
        database
            .set_setting("registry.mode", "tcr")
            .expect("save registry mode");
        database
            .set_setting("registry.tcr.namespace", "safe-team")
            .expect("save registry namespace");
        database
            .set_setting(
                "registry.tcr.v2.verified-endpoint",
                "ccr.ccs.tencentyun.com",
            )
            .expect("save historical registry endpoint");

        let key_path = directory.path().join("private-key-sentinel");
        fs::write(&key_path, "private-key-sentinel").expect("write test key");
        database
            .bind_project_server(
                &project_path,
                "staging",
                &SshProfile {
                    name: "测试服务器".to_string(),
                    host: "203.0.113.41".to_string(),
                    user: "ubuntu".to_string(),
                    port: 22,
                    key_path,
                    host_fingerprint: Some("SHA256:no-secret".to_string()),
                },
            )
            .expect("bind server");

        assert!(
            database
                .upsert_compat_connection(
                    "unsafe-connection",
                    "source",
                    "cnb",
                    "Unsafe",
                    Some("cnb-secret-sentinel"),
                    &BTreeMap::new(),
                    &[],
                    "unknown",
                    None,
                )
                .is_err()
        );

        let connections = database.list_connections(None).expect("list connections");
        assert_eq!(connections.len(), 3);
        let source = connections
            .iter()
            .find(|connection| connection.id == CNB_SOURCE_CONNECTION_ID)
            .expect("CNB connection");
        assert_eq!(source.status, "unknown");
        assert!(source.last_checked_at.is_none());
        assert_eq!(
            source.metadata.get("username").map(String::as_str),
            Some("safe-user")
        );
        let registry = connections
            .iter()
            .find(|connection| connection.id == TCR_REGISTRY_CONNECTION_ID)
            .expect("TCR connection");
        assert_eq!(registry.status, "unknown");
        assert!(registry.last_checked_at.is_none());
        assert_eq!(
            database
                .list_connections(Some("server"))
                .expect("list server connections")
                .len(),
            1
        );
        let serialized = serde_json::to_string(&connections).expect("serialize connections");
        for forbidden in [
            "cnb-secret-sentinel",
            "password-sentinel",
            "private-key-sentinel",
            "secret_ref",
            "secretRef",
            "key_path",
            "keyPath",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "connection API leaked {forbidden}"
            );
        }

        let connection = database.connection.lock().expect("database lock");
        let secret_refs = connection
            .prepare(
                "SELECT secret_ref FROM connections
                 WHERE secret_ref IS NOT NULL ORDER BY secret_ref",
            )
            .expect("prepare secret refs")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query secret refs")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect secret refs");
        assert_eq!(secret_refs, vec!["cnb-token", "registry.tcr.v2.password"]);
    }

    #[test]
    fn hiding_and_readding_a_project_preserves_its_release_model() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        database
            .set_project_step(&project_path, "workspace")
            .expect("save project step");
        let original = database.list_projects().expect("project")[0].clone();

        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "test-only-placeholder").expect("write key placeholder");
        database
            .bind_project_server(
                &project_path,
                "staging",
                &SshProfile {
                    name: "测试服务器".to_string(),
                    host: "203.0.113.88".to_string(),
                    user: "ubuntu".to_string(),
                    port: 22,
                    key_path,
                    host_fingerprint: Some("SHA256:soft-hide".to_string()),
                },
            )
            .expect("bind server");
        let profile = ConfigProfile {
            id: "soft-hide-database".to_string(),
            kind: "database".to_string(),
            provider: "postgresql".to_string(),
            name: "测试数据库".to_string(),
            scope: "remote".to_string(),
            values: BTreeMap::new(),
            secret_fields: vec!["url".to_string()],
            configured_secret_fields: Vec::new(),
            is_default: false,
            updated_at: String::new(),
        };
        database
            .save_config_profile(&profile)
            .expect("save config profile");
        database
            .bind_config_profile(&project_path, "staging", "database", &profile.id)
            .expect("bind config profile");
        database
            .upsert_compat_connection(
                CNB_SOURCE_CONNECTION_ID,
                "source",
                "cnb",
                "CNB",
                Some("cnb-token"),
                &BTreeMap::from([("endpoint".to_string(), "https://cnb.cool".to_string())]),
                &["repositories".to_string()],
                "configured",
                None,
            )
            .expect("save source connection");
        database
            .upsert_compat_connection(
                TCR_REGISTRY_CONNECTION_ID,
                "registry",
                "tcr",
                "腾讯云 TCR",
                Some("registry.tcr.v2.password"),
                &BTreeMap::from([("endpoint".to_string(), "ccr.ccs.tencentyun.com".to_string())]),
                &["push".to_string(), "pull".to_string()],
                "configured",
                None,
            )
            .expect("save registry connection");
        database
            .bind_project_source_connection(&project_path, Some(CNB_SOURCE_CONNECTION_ID))
            .expect("bind source connection");
        for environment in ["staging", "production"] {
            database
                .bind_project_registry_connection(
                    &project_path,
                    environment,
                    Some(TCR_REGISTRY_CONNECTION_ID),
                )
                .expect("bind registry connection");
        }
        let original_connection_bindings = database
            .project_connection_bindings(&project_path)
            .expect("read original connection bindings");

        let run = save_successful_staging_run(
            &database,
            &project_path,
            "0123456789abcdef0123456789abcdef01234567",
            vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_string(),
            }],
        );
        let validation = database
            .set_version_validation(&project_path, &run.id, "passed")
            .expect("validate version");
        let mut active_task = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create active task");
        active_task.status = "running".to_string();
        active_task.current_stage = "build".to_string();
        active_task.started_at = "2099-01-02T00:00:00Z".to_string();
        active_task.updated_at = active_task.started_at.clone();
        database
            .save_deployment_run(&active_task)
            .expect("save active task");
        let mut attention_task = database
            .create_deployment_run(
                &project_path,
                "sample",
                "production",
                "owner/sample",
                "main",
            )
            .expect("create attention task");
        attention_task.status = "needs_action".to_string();
        attention_task.current_stage = "prepare-server".to_string();
        attention_task.started_at = "2099-01-03T00:00:00Z".to_string();
        attention_task.updated_at = attention_task.started_at.clone();
        database
            .save_deployment_run(&attention_task)
            .expect("save attention task");
        {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO automation_rules (
                       id, project_id, name, trigger_kind, action_kind,
                       target_environment_id, desired_state, observed_state,
                       created_at, updated_at
                     ) VALUES (
                       'rule-main-staging', ?1, 'main 自动部署测试环境',
                       'branch-update', 'deploy-version', ?2, 'enabled', 'ready', ?3, ?3
                     )",
                    rusqlite::params![
                        original.id,
                        format!("{}:staging", original.id),
                        "2026-01-01T00:00:00Z"
                    ],
                )
                .expect("save automation rule");
        }
        let original_model_ids = release_model_ids(&database);
        for (kind, expected_count) in [
            ("projects", 1_usize),
            ("project-identities", 1),
            ("environments", 3),
            ("versions", 1),
            ("version-artifacts", 1),
            ("version-validations", 1),
            ("automation-rules", 1),
            ("deployment-tasks", 3),
            ("server-bindings", 1),
            ("config-bindings", 1),
            ("source-bindings", 1),
            ("environment-connections", 3),
        ] {
            assert_eq!(
                original_model_ids
                    .get(kind)
                    .expect("release model snapshot kind")
                    .len(),
                expected_count,
                "unexpected original row count for {kind}"
            );
        }

        assert_eq!(
            database
                .list_recent_successful_deployment_runs()
                .expect("visible recent deployment")
                .len(),
            1
        );
        assert_eq!(
            database
                .list_active_deployment_runs()
                .expect("visible active deployment")
                .len(),
            1
        );
        assert_eq!(
            database
                .list_attention_deployment_runs()
                .expect("visible attention deployments")
                .len(),
            2
        );
        assert!(
            database
                .remove_project(&project_path)
                .expect("hide project")
        );
        assert!(
            database
                .list_projects()
                .expect("visible projects")
                .is_empty()
        );
        assert!(
            database
                .list_recent_successful_deployment_runs()
                .expect("hidden recent deployments")
                .is_empty()
        );
        assert!(
            database
                .list_active_deployment_runs()
                .expect("hidden active deployments")
                .is_empty()
        );
        assert!(
            database
                .list_attention_deployment_runs()
                .expect("hidden attention deployments")
                .is_empty()
        );
        assert_eq!(
            database.deployment_run(&run.id).expect("preserved run").id,
            run.id
        );
        assert_eq!(
            database
                .list_project_environments(&project_path)
                .expect("preserved environments")
                .iter()
                .find(|environment| environment.environment == "staging")
                .and_then(|environment| environment.current_version_key.as_deref()),
            Some(validation.version_key.as_str())
        );
        assert_eq!(
            database
                .list_version_validations(&project_path)
                .expect("preserved validation")[0]
                .state,
            "passed"
        );
        assert_eq!(release_model_ids(&database), original_model_ids);
        assert_eq!(
            database
                .project_connection_bindings(&project_path)
                .expect("hidden project connection bindings"),
            original_connection_bindings
        );
        {
            let connection = database.connection.lock().expect("database lock");
            let foreign_key_violations: u32 = connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .expect("foreign key check");
            assert_eq!(foreign_key_violations, 0);
        }

        database
            .remember_project(&project_path, "sample renamed", true, 1)
            .expect("restore project");
        let restored = database.list_projects().expect("restored projects");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, original.id);
        assert_eq!(restored[0].name, "sample renamed");
        assert_eq!(restored[0].current_step, "workspace");
        assert_eq!(release_model_ids(&database), original_model_ids);
        assert_eq!(
            database
                .project_connection_bindings(&project_path)
                .expect("restored project connection bindings"),
            original_connection_bindings
        );
        assert_eq!(
            database
                .list_recent_successful_deployment_runs()
                .expect("restored recent deployment")[0]
                .id,
            run.id
        );
        assert_eq!(
            database
                .list_active_deployment_runs()
                .expect("restored active deployment")[0]
                .id,
            active_task.id
        );
        assert_eq!(
            database
                .list_attention_deployment_runs()
                .expect("restored attention deployments")
                .len(),
            2
        );
        assert_eq!(
            database
                .list_version_validations(&project_path)
                .expect("restored validation")[0]
                .state,
            "passed"
        );
        let connection = database.connection.lock().expect("database lock");
        let automation_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM automation_rules WHERE project_id = ?1",
                [&original.id],
                |row| row.get(0),
            )
            .expect("restored automation rule");
        assert_eq!(automation_count, 1);
    }

    #[test]
    fn migrates_legacy_workspace_model_idempotently() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("legacy-model.db");
        let project_path = directory.path().join("legacy-project");
        let project_path = project_path.to_string_lossy().into_owned();
        let connection = Connection::open(&path).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE projects (
                   id TEXT PRIMARY KEY,
                   path TEXT NOT NULL UNIQUE,
                   name TEXT NOT NULL,
                   current_step TEXT NOT NULL DEFAULT 'inspection',
                   manifest_exists INTEGER NOT NULL DEFAULT 0,
                   service_count INTEGER NOT NULL DEFAULT 0,
                   last_opened_at TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE servers (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   host TEXT NOT NULL,
                   user TEXT NOT NULL,
                   port INTEGER NOT NULL,
                   key_path TEXT NOT NULL,
                   last_checked_at TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   UNIQUE(host, user, port)
                 );
                 CREATE TABLE project_server_bindings (
                   project_path TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   server_id TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   PRIMARY KEY(project_path, environment),
                   FOREIGN KEY(server_id) REFERENCES servers(id)
                 );
                 CREATE TABLE deployment_runs (
                   id TEXT PRIMARY KEY,
                   project_path TEXT NOT NULL,
                   project_name TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   status TEXT NOT NULL,
                   current_stage TEXT NOT NULL,
                   build_serial TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE app_settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .expect("create legacy schema");
        connection
            .execute(
                "INSERT INTO projects (
                   id, path, name, manifest_exists, service_count, last_opened_at, created_at
                 ) VALUES ('legacy-project-id', ?1, '旧项目', 1, 2, ?2, ?2)",
                rusqlite::params![project_path, "2026-01-01T00:00:00Z"],
            )
            .expect("insert legacy project");
        connection
            .execute(
                "INSERT INTO servers VALUES (
                   'legacy-server-id', '旧服务器', '203.0.113.40', 'ubuntu', 22,
                   '/private/must-not-be-copied', ?1, ?1
                 )",
                ["2026-01-01T00:00:00Z"],
            )
            .expect("insert legacy server");
        connection
            .execute(
                "INSERT INTO project_server_bindings VALUES (?1, 'staging',
                   'legacy-server-id', ?2)",
                rusqlite::params![project_path, "2026-01-01T00:00:00Z"],
            )
            .expect("insert legacy binding");
        connection
            .execute(
                "INSERT INTO deployment_runs VALUES (
                   'legacy-run-id', ?1, '旧项目', 'staging', 'success', 'complete',
                   '42', 'owner/legacy', 'main', '部署成功', '[]', ?2, ?2
                 )",
                rusqlite::params![project_path, "2026-01-02T00:00:00Z"],
            )
            .expect("insert legacy deployment");
        connection
            .execute(
                "INSERT INTO app_settings VALUES ('cnb-token', 'must-not-be-copied', ?1)",
                ["2026-01-01T00:00:00Z"],
            )
            .expect("insert legacy setting");
        drop(connection);

        let database = WorkspaceState::open(&path).expect("migrate legacy model");
        assert_eq!(
            database
                .project_adoption(std::path::Path::new(&project_path))
                .expect("legacy adoption")
                .mode,
            "pending"
        );
        assert!(
            database
                .list_deployment_runs(std::path::Path::new(&project_path))
                .expect("legacy history is gated")
                .is_empty()
        );
        database
            .continue_existing_deployment(std::path::Path::new(&project_path))
            .expect("adopt legacy deployment");
        {
            let connection = database.connection.lock().expect("database lock");
            let project_columns = {
                let mut statement = connection
                    .prepare("PRAGMA table_info(projects)")
                    .expect("project columns");
                statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .expect("query project columns")
                    .collect::<Result<Vec<_>, _>>()
                    .expect("collect project columns")
            };
            assert!(project_columns.iter().any(|column| column == "hidden_at"));
            let hidden_at: Option<String> = connection
                .query_row(
                    "SELECT hidden_at FROM projects WHERE id = 'legacy-project-id'",
                    [],
                    |row| row.get(0),
                )
                .expect("legacy project remains visible");
            assert!(hidden_at.is_none());
            let columns = {
                let mut statement = connection
                    .prepare("PRAGMA table_info(deployment_runs)")
                    .expect("deployment columns");
                statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .expect("query columns")
                    .collect::<Result<Vec<_>, _>>()
                    .expect("collect columns")
            };
            for expected in [
                "project_id",
                "environment_id",
                "version_id",
                "task_kind",
                "target_snapshot_json",
                "config_snapshot_json",
            ] {
                assert!(columns.iter().any(|column| column == expected));
            }

            let storage_id: String = connection
                .query_row(
                    "SELECT storage_id FROM project_identities
                     WHERE project_id = 'legacy-project-id'",
                    [],
                    |row| row.get(0),
                )
                .expect("migrated identity");
            assert_eq!(storage_id.len(), 64);
            let environments: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM environments
                     WHERE project_id = 'legacy-project-id'",
                    [],
                    |row| row.get(0),
                )
                .expect("migrated environments");
            assert_eq!(environments, 3);
            let target_connection: String = connection
                .query_row(
                    "SELECT target_connection_id FROM environments
                     WHERE project_id = 'legacy-project-id' AND name = 'staging'",
                    [],
                    |row| row.get(0),
                )
                .expect("migrated target connection");
            assert_eq!(target_connection, "legacy-server:legacy-server-id");

            let connection_data: (Option<String>, String, String, String) = connection
                .query_row(
                    "SELECT secret_ref, metadata_json, capabilities_json, status
                     FROM connections WHERE id = 'legacy-server:legacy-server-id'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("migrated connection");
            assert_eq!(connection_data.0, None);
            assert_eq!(
                serde_json::from_str::<BTreeMap<String, String>>(&connection_data.1)
                    .expect("migrated safe metadata"),
                BTreeMap::from([
                    ("host".to_string(), "203.0.113.40".to_string()),
                    ("port".to_string(), "22".to_string()),
                    ("user".to_string(), "ubuntu".to_string()),
                ])
            );
            assert_eq!(
                serde_json::from_str::<Vec<String>>(&connection_data.2)
                    .expect("migrated capabilities"),
                vec!["deploy", "healthcheck", "reverse-proxy"]
            );
            assert_eq!(connection_data.3, "configured");

            let run_links: (Option<String>, Option<String>, Option<String>) = connection
                .query_row(
                    "SELECT project_id, environment_id, version_id FROM deployment_runs
                     WHERE id = 'legacy-run-id'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("migrated run links");
            assert_eq!(run_links.0.as_deref(), Some("legacy-project-id"));
            assert_eq!(run_links.1.as_deref(), Some("legacy-project-id:staging"));
            assert!(run_links.2.is_some());
            let secret_occurrences: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM connections
                     WHERE COALESCE(secret_ref, '') LIKE '%must-not-be-copied%'
                        OR metadata_json LIKE '%must-not-be-copied%'
                        OR metadata_json LIKE '%/private/%'",
                    [],
                    |row| row.get(0),
                )
                .expect("no copied secrets");
            assert_eq!(secret_occurrences, 0);
        }
        assert_eq!(
            database
                .deployment_run("legacy-run-id")
                .expect("legacy deployment readable")
                .status,
            "success"
        );
        assert_eq!(
            database
                .list_projects()
                .expect("legacy project visible")
                .len(),
            1
        );
        drop(database);

        let reopened = WorkspaceState::open(&path).expect("reopen migrated model");
        let connection = reopened.connection.lock().expect("database lock");
        let hidden_column_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'hidden_at'",
                [],
                |row| row.get(0),
            )
            .expect("idempotent hidden column");
        assert_eq!(hidden_column_count, 1);
        let visibility_index_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'projects_visible_recent'",
                [],
                |row| row.get(0),
            )
            .expect("idempotent visibility index");
        assert_eq!(visibility_index_count, 1);
        for (table, expected_count) in [
            ("project_identities", 1_u32),
            ("connections", 1),
            ("project_connection_bindings", 0),
            ("environments", 3),
            ("versions", 1),
            ("version_artifacts", 0),
            ("version_validations", 0),
            ("automation_rules", 0),
        ] {
            let count: u32 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("idempotent count");
            assert_eq!(count, expected_count, "unexpected count in {table}");
        }
        let foreign_key_violations: u32 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[test]
    fn migrates_legacy_failed_only_project_without_inventing_a_version() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("legacy-failed-only.db");
        let project_path = directory.path().join("legacy-failed-project");
        fs::create_dir_all(&project_path).expect("create legacy project");
        let project_path_value = project_path
            .canonicalize()
            .expect("canonical legacy project")
            .to_string_lossy()
            .into_owned();
        let connection = Connection::open(&path).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE projects (
                   id TEXT PRIMARY KEY,
                   path TEXT NOT NULL UNIQUE,
                   name TEXT NOT NULL,
                   current_step TEXT NOT NULL DEFAULT 'inspection',
                   manifest_exists INTEGER NOT NULL DEFAULT 0,
                   service_count INTEGER NOT NULL DEFAULT 0,
                   last_opened_at TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE deployment_runs (
                   id TEXT PRIMARY KEY,
                   project_path TEXT NOT NULL,
                   project_name TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   status TEXT NOT NULL,
                   current_stage TEXT NOT NULL,
                   build_serial TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .expect("create legacy schema");
        connection
            .execute(
                "INSERT INTO projects (
                   id, path, name, manifest_exists, service_count, last_opened_at, created_at
                 ) VALUES ('legacy-failed-project-id', ?1, '失败项目', 1, 1, ?2, ?2)",
                rusqlite::params![project_path_value, "2026-01-01T00:00:00Z"],
            )
            .expect("insert legacy project");
        connection
            .execute(
                "INSERT INTO deployment_runs VALUES (
                   'legacy-failed-run', ?1, '失败项目', 'staging', 'failed', 'deploy',
                   '43', 'owner/failed', 'main', '部署失败', '[]', ?2, ?2
                 )",
                rusqlite::params![project_path_value, "2026-01-02T00:00:00Z"],
            )
            .expect("insert failed deployment");
        drop(connection);

        let database = WorkspaceState::open(&path).expect("migrate failed-only workspace");
        assert!(
            database
                .deployment_run("legacy-failed-run")
                .expect_err("pending deployment must not refresh")
                .contains("AD-ADOPT-101")
        );
        database
            .continue_existing_deployment(&project_path)
            .expect("adopt failed-only deployment");
        assert!(
            database
                .list_project_versions(&project_path)
                .expect("list migrated versions")
                .is_empty()
        );
        assert_eq!(
            database
                .deployment_run("legacy-failed-run")
                .expect("failed deployment remains readable")
                .status,
            "failed"
        );
        let staging = database
            .list_project_environments(&project_path)
            .expect("list environments")
            .into_iter()
            .find(|environment| environment.environment == "staging")
            .expect("staging environment");
        assert!(staging.current_version_key.is_none());
        assert!(staging.current_run_id.is_none());
    }

    #[test]
    fn leaves_orphaned_legacy_deployments_unlinked() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("orphaned-run.db");
        let connection = Connection::open(&path).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE deployment_runs (
                   id TEXT PRIMARY KEY,
                   project_path TEXT NOT NULL,
                   project_name TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   status TEXT NOT NULL,
                   current_stage TEXT NOT NULL,
                   build_serial TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO deployment_runs VALUES (
                   'orphaned-run', '/missing/project', '已移除项目', 'production',
                   'failed', 'deploy', NULL, 'owner/missing', 'main', '失败', '[]',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                 );",
            )
            .expect("create orphaned deployment");
        drop(connection);

        let database = WorkspaceState::open(&path).expect("migrate orphaned deployment");
        assert!(
            database
                .deployment_run("orphaned-run")
                .expect_err("orphaned run must not be refreshable")
                .contains("AD-ADOPT-101")
        );
        let connection = database.connection.lock().expect("database lock");
        let links: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT project_id, environment_id, version_id
                 FROM deployment_runs WHERE id = 'orphaned-run'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("orphaned links");
        assert_eq!(links, (None, None, None));
    }

    #[test]
    fn stores_reusable_profiles_and_project_bindings_without_secret_values() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        let profile = ConfigProfile {
            id: "minimax-primary".to_string(),
            kind: "ai".to_string(),
            provider: "minimax".to_string(),
            name: "常用 MiniMax".to_string(),
            scope: "any".to_string(),
            values: BTreeMap::from([
                (
                    "base_url".to_string(),
                    "https://api.minimax.chat/v1".to_string(),
                ),
                ("model".to_string(), "MiniMax-M2.5".to_string()),
            ]),
            secret_fields: vec!["api_key".to_string()],
            configured_secret_fields: vec!["api_key".to_string()],
            is_default: true,
            updated_at: String::new(),
        };

        database
            .save_config_profile(&profile)
            .expect("save profile metadata");
        let profiles = database.list_config_profiles().expect("list profiles");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].values["model"], "MiniMax-M2.5");
        assert!(profiles[0].configured_secret_fields.is_empty());

        let fallback = ConfigProfile {
            id: "minimax-backup".to_string(),
            name: "备用 MiniMax".to_string(),
            is_default: false,
            ..profile.clone()
        };
        database
            .save_config_profile(&fallback)
            .expect("save fallback profile");

        database
            .bind_config_profile(directory.path(), "development", "ai", &profile.id)
            .expect("bind profile");
        let bindings = database
            .config_profile_bindings(directory.path(), "development")
            .expect("list bindings");
        assert_eq!(bindings[0].profile_id, profile.id);

        assert!(
            database
                .remove_config_profile(&profile.id)
                .expect("remove profile")
        );
        assert!(
            database
                .config_profile(&fallback.id)
                .expect("fallback profile")
                .expect("fallback exists")
                .is_default
        );
        assert!(
            database
                .config_profile_bindings(directory.path(), "development")
                .expect("bindings removed")
                .is_empty()
        );
    }

    #[test]
    fn keeps_independent_defaults_for_local_and_remote_connections() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        let local = ConfigProfile {
            id: "local-postgres".to_string(),
            kind: "database".to_string(),
            provider: "postgresql".to_string(),
            name: "本地 PostgreSQL".to_string(),
            scope: "local".to_string(),
            values: BTreeMap::new(),
            secret_fields: vec!["url".to_string()],
            configured_secret_fields: Vec::new(),
            is_default: true,
            updated_at: String::new(),
        };
        let remote = ConfigProfile {
            id: "remote-postgres".to_string(),
            name: "线上 PostgreSQL".to_string(),
            scope: "remote".to_string(),
            ..local.clone()
        };

        database
            .save_config_profile(&local)
            .expect("save local default");
        database
            .save_config_profile(&remote)
            .expect("save remote default");
        let profiles = database.list_config_profiles().expect("profiles");
        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().all(|profile| profile.is_default));
    }

    #[test]
    fn upgrades_profile_bindings_and_supports_multiple_profiles_per_environment() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("legacy-bindings.db");
        let connection = Connection::open(&path).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE config_profiles (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   name TEXT NOT NULL,
                   scope TEXT NOT NULL DEFAULT 'any',
                   values_json TEXT NOT NULL,
                   secret_fields_json TEXT NOT NULL DEFAULT '[]',
                   is_default INTEGER NOT NULL DEFAULT 0,
                   updated_at TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE project_profile_bindings (
                   project_path TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   profile_kind TEXT NOT NULL,
                   profile_id TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   PRIMARY KEY(project_path, environment, profile_kind),
                   FOREIGN KEY(profile_id) REFERENCES config_profiles(id)
                 );
                 INSERT INTO config_profiles VALUES
                   ('legacy-custom', 'custom', 'environment', '旧接口密钥', 'remote',
                    '{\"env_name\":\"API_KEY\"}', '[\"API_KEY\"]', 1,
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                   ('legacy-database', 'database', 'postgresql', '旧数据库', 'remote',
                    '{}', '[\"url\"]', 1,
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO project_profile_bindings VALUES
                   ('/legacy/project', 'staging', 'custom', 'legacy-custom',
                    '2026-01-01T00:00:00Z'),
                   ('/legacy/project', 'staging', 'database', 'legacy-database',
                    '2026-01-01T00:00:00Z');",
            )
            .expect("create legacy binding schema");
        drop(connection);

        let database = WorkspaceState::open(&path).expect("upgrade bindings");
        database
            .remember_project(std::path::Path::new("/legacy/project"), "legacy", true, 1)
            .expect("adopt legacy binding project");
        let preserved = database
            .config_profile_bindings(std::path::Path::new("/legacy/project"), "staging")
            .expect("preserve old bindings");
        assert_eq!(preserved.len(), 2);
        assert!(
            preserved
                .iter()
                .any(|binding| binding.profile_id == "legacy-custom")
        );
        assert!(
            preserved
                .iter()
                .any(|binding| binding.profile_id == "legacy-database")
        );

        let second_custom = ConfigProfile {
            id: "second-custom".to_string(),
            kind: "custom".to_string(),
            provider: "environment".to_string(),
            name: "第二个环境变量".to_string(),
            scope: "remote".to_string(),
            values: BTreeMap::from([
                ("env_name".to_string(), "SECOND_KEY".to_string()),
                ("env_value".to_string(), "public-value".to_string()),
            ]),
            secret_fields: Vec::new(),
            configured_secret_fields: Vec::new(),
            is_default: false,
            updated_at: String::new(),
        };
        database
            .save_config_profile(&second_custom)
            .expect("save second custom profile");
        database
            .bind_config_profile(
                std::path::Path::new("/legacy/project"),
                "staging",
                "custom",
                &second_custom.id,
            )
            .expect("add another profile of the same kind");
        let additive = database
            .config_profile_bindings(std::path::Path::new("/legacy/project"), "staging")
            .expect("list additive bindings");
        assert_eq!(
            additive
                .iter()
                .filter(|binding| binding.kind == "custom")
                .count(),
            2
        );

        let replaced = database
            .set_environment_config_bindings(
                std::path::Path::new("/legacy/project"),
                "staging",
                &[
                    "second-custom".to_string(),
                    "legacy-custom".to_string(),
                    "second-custom".to_string(),
                ],
            )
            .expect("replace environment bindings");
        assert_eq!(replaced.len(), 2);
        drop(database);

        let reopened = WorkspaceState::open(&path).expect("idempotent reopen");
        let bindings = reopened
            .config_profile_bindings(std::path::Path::new("/legacy/project"), "staging")
            .expect("read migrated bindings");
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().all(|binding| binding.kind == "custom"));
        reopened
            .set_environment_config_bindings(
                std::path::Path::new("/legacy/project"),
                "staging",
                &[],
            )
            .expect("clear bindings explicitly");
        assert!(
            reopened
                .config_profile_bindings(std::path::Path::new("/legacy/project"), "staging")
                .expect("bindings cleared")
                .is_empty()
        );
    }

    #[test]
    fn preserves_the_same_deployment_task_when_preparation_is_paused_and_resumed() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("workspace.db");
        let task_id;
        {
            let database = WorkspaceState::open(&path).expect("open workspace");
            database
                .remember_project(directory.path(), "sample", true, 2)
                .expect("remember project");
            let mut task = database
                .create_deployment_run(
                    directory.path(),
                    "sample",
                    "staging",
                    "owner/sample",
                    "main",
                )
                .expect("create deployment task");
            task_id = task.id.clone();
            task.commit_sha = Some("0123456789abcdef0123456789abcdef01234567".to_string());
            task.completed_steps.clear();
            task.status = "needs_action".to_string();
            task.current_stage = "sync-source".to_string();
            task.issue_code = Some("AD-GIT-102".to_string());
            task.action_kind = Some("retry-staging-preparation".to_string());
            task.message = "代码版本已保存，修复同步问题后继续当前任务".to_string();
            database
                .save_deployment_run(&task)
                .expect("pause deployment task");
        }

        let reopened = WorkspaceState::open(&path).expect("reopen workspace");
        let mut resumed = reopened
            .deployment_run(&task_id)
            .expect("load paused deployment task");
        assert_eq!(resumed.id, task_id);
        assert_eq!(resumed.status, "needs_action");
        assert_eq!(resumed.current_stage, "sync-source");
        assert_eq!(
            resumed.commit_sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(
            resumed.action_kind.as_deref(),
            Some("retry-staging-preparation")
        );

        resumed.status = "queued".to_string();
        resumed.current_stage = "trigger-build".to_string();
        resumed.issue_code = None;
        resumed.action_kind = None;
        reopened
            .save_deployment_run(&resumed)
            .expect("resume the same deployment task");
        let after_resume = reopened
            .deployment_run(&task_id)
            .expect("reload resumed deployment task");
        assert_eq!(after_resume.id, task_id);
        assert_eq!(after_resume.status, "queued");
        assert_eq!(after_resume.current_stage, "trigger-build");
        assert_eq!(
            after_resume.commit_sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
    }

    #[test]
    fn keeps_the_latest_attention_task_for_each_environment() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("open workspace");
        database
            .remember_project(directory.path(), "sample", true, 2)
            .expect("remember project");

        let mut production = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "production",
                "owner/sample",
                "main",
            )
            .expect("create production run");
        production.status = "needs_action".to_string();
        production.current_stage = "healthcheck".to_string();
        production.action_kind = Some("route-check".to_string());
        production.started_at = "2026-01-01T00:00:00Z".to_string();
        production.updated_at = production.started_at.clone();
        database
            .save_deployment_run(&production)
            .expect("save pending production");

        let mut staging = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "staging",
                "owner/sample",
                "main",
            )
            .expect("create staging run");
        staging.status = "success".to_string();
        staging.current_stage = "complete".to_string();
        staging.started_at = "2026-01-02T00:00:00Z".to_string();
        staging.updated_at = staging.started_at.clone();
        database
            .save_deployment_run(&staging)
            .expect("save newer staging success");

        let projects = database.list_projects().expect("list projects");
        assert_eq!(projects[0].latest_status.as_deref(), Some("success"));
        assert_eq!(projects[0].latest_environment.as_deref(), Some("staging"));
        let attention = database
            .list_attention_deployment_runs()
            .expect("attention runs");
        assert_eq!(attention.len(), 1);
        assert_eq!(attention[0].id, production.id);
        assert_eq!(attention[0].environment, "production");

        let mut completed_production = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "production",
                "owner/sample",
                "main",
            )
            .expect("create completed production run");
        completed_production.status = "success".to_string();
        completed_production.current_stage = "complete".to_string();
        completed_production.source_run_id = Some(staging.id.clone());
        completed_production.started_at = "2026-01-03T00:00:00Z".to_string();
        completed_production.updated_at = completed_production.started_at.clone();
        database
            .save_deployment_run(&completed_production)
            .expect("save completed production");
        assert!(
            database
                .list_attention_deployment_runs()
                .expect("resolved attention runs")
                .is_empty()
        );

        let completed = database
            .list_recent_successful_deployment_runs()
            .expect("recent successful runs");
        assert_eq!(completed.len(), 2);
        assert_eq!(completed[0].id, completed_production.id);
        assert_eq!(completed[1].id, staging.id);

        let mut newer_staging = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "staging",
                "owner/sample",
                "main",
            )
            .expect("create newer staging run");
        newer_staging.status = "success".to_string();
        newer_staging.current_stage = "complete".to_string();
        newer_staging.started_at = "2026-01-04T00:00:00Z".to_string();
        newer_staging.updated_at = newer_staging.started_at.clone();
        database
            .save_deployment_run(&newer_staging)
            .expect("save newer staging success");

        let completed = database
            .list_recent_successful_deployment_runs()
            .expect("deduplicated successful runs");
        assert_eq!(completed.len(), 2);
        assert_eq!(completed[0].id, newer_staging.id);
        assert_eq!(completed[1].id, completed_production.id);

        completed_production.updated_at = "2026-01-05T00:00:00Z".to_string();
        database
            .save_deployment_run(&completed_production)
            .expect("refresh older production result");
        let completed = database
            .list_recent_successful_deployment_runs()
            .expect("refresh must not reorder history");
        assert_eq!(completed[0].id, newer_staging.id);
        assert_eq!(completed[1].id, completed_production.id);
    }

    #[test]
    fn remembers_and_resumes_projects_without_storing_secrets() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("open workspace");
        database
            .remember_project(directory.path(), "sample", false, 3)
            .expect("remember project");
        database
            .set_project_step(directory.path(), "connections")
            .expect("save step");

        let projects = database.list_projects().expect("list projects");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "sample");
        assert_eq!(projects[0].service_count, 3);
        assert!(projects[0].path_exists);
        assert_eq!(
            database.project_step(directory.path()).expect("step"),
            Some("connections".to_string())
        );

        assert!(
            database
                .remove_project(directory.path())
                .expect("remove project")
        );
        assert!(database.list_projects().expect("empty").is_empty());
        assert!(
            !database
                .remove_project(directory.path())
                .expect("already-hidden project")
        );

        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "test-only-placeholder").expect("write key placeholder");
        database
            .remember_server(&SshProfile {
                name: "test-server".to_string(),
                host: "203.0.113.10".to_string(),
                user: "ubuntu".to_string(),
                port: 22,
                key_path: key_path.clone(),
                host_fingerprint: Some("SHA256:test".to_string()),
            })
            .expect("remember server");
        let servers = database.list_servers().expect("list servers");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].host, "203.0.113.10");
        assert_eq!(servers[0].host_fingerprint.as_deref(), Some("SHA256:test"));
        assert_eq!(
            servers[0].key_path,
            key_path
                .canonicalize()
                .expect("canonical key")
                .to_string_lossy()
        );
        assert!(servers[0].key_path_exists);

        database
            .remember_project(directory.path(), "sample", true, 3)
            .expect("remember project again");
        assert_eq!(
            database
                .project_step(directory.path())
                .expect("restored step"),
            Some("connections".to_string())
        );
        assert_eq!(database.list_projects().expect("restored project").len(), 1);
        let mut run = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "staging",
                "owner/sample",
                "main",
            )
            .expect("create run");
        run.status = "running".to_string();
        run.current_stage = "build".to_string();
        run.build_serial = Some("42".to_string());
        run.source_run_id = Some("tested-version".to_string());
        run.source_title = Some("修复登录并优化首页速度".to_string());
        run.candidate_tag = Some("deploydesk-0123456789abcdef".to_string());
        run.completed_steps = vec!["write-config".to_string(), "verify-build".to_string()];
        run.artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(),
        }];
        run.started_at = "2025-01-02T03:04:05Z".to_string();
        run.updated_at = chrono::Utc::now().to_rfc3339();
        database.save_deployment_run(&run).expect("save run");
        let resumed = database.deployment_run(&run.id).expect("resume run");
        assert_eq!(resumed.build_serial.as_deref(), Some("42"));
        assert_eq!(resumed.current_stage, "build");
        assert_eq!(
            resumed.source_title.as_deref(),
            Some("修复登录并优化首页速度")
        );
        assert_eq!(resumed.started_at, "2025-01-02T03:04:05Z");
        assert_eq!(resumed.artifacts, run.artifacts);
        assert_eq!(
            database
                .list_active_deployment_runs()
                .expect("active runs")
                .len(),
            1
        );
        let projects = database.list_projects().expect("projects with status");
        assert_eq!(projects[0].latest_status.as_deref(), Some("running"));
        assert_eq!(projects[0].latest_run_id.as_deref(), Some(run.id.as_str()));
        assert_eq!(
            projects[0].latest_source_run_id.as_deref(),
            Some("tested-version")
        );
        assert_eq!(projects[0].latest_current_stage.as_deref(), Some("build"));
        assert_eq!(projects[0].latest_completed_steps, run.completed_steps);
        assert_eq!(
            projects[0].latest_updated_at.as_deref(),
            Some(run.updated_at.as_str())
        );
        assert_eq!(projects[0].active_run_count, 1);
        assert_eq!(
            database
                .list_deployment_runs(directory.path())
                .expect("list runs")
                .len(),
            1
        );

        let profile = SshProfile {
            name: "test-server".to_string(),
            host: "203.0.113.10".to_string(),
            user: "ubuntu".to_string(),
            port: 22,
            key_path,
            host_fingerprint: Some("SHA256:test".to_string()),
        };
        database
            .bind_project_server(directory.path(), "staging", &profile)
            .expect("bind server");
        assert_eq!(
            database
                .server_for_project(directory.path(), "staging")
                .expect("bound server")
                .expect("server")
                .host,
            "203.0.113.10"
        );
        database
            .set_setting("active-project", &directory.path().to_string_lossy())
            .expect("save setting");
        assert!(
            database
                .setting("active-project")
                .expect("read setting")
                .is_some()
        );
        let long_project_setting = format!(
            "project.{}.cnb-secret-pending.production",
            "Users%2Fdeveloper%2FDocuments%2FDeployWorkspace%2Fprojects%2F".repeat(3)
        );
        assert!(long_project_setting.len() > 80);
        database
            .set_setting(&long_project_setting, "true")
            .expect("save long project-scoped setting");
        assert_eq!(
            database
                .setting(&long_project_setting)
                .expect("read long project-scoped setting")
                .as_deref(),
            Some("true")
        );
        let settings = database
            .settings(&[
                "active-project".to_string(),
                long_project_setting.clone(),
                "missing".to_string(),
            ])
            .expect("read settings in one batch");
        let expected_active_project = directory.path().to_string_lossy().into_owned();
        assert_eq!(
            settings.get(&long_project_setting).map(String::as_str),
            Some("true")
        );
        assert_eq!(
            settings.get("active-project").map(String::as_str),
            Some(expected_active_project.as_str())
        );
        assert!(!settings.contains_key("missing"));
    }

    #[test]
    fn persists_per_address_route_checks_across_workspace_restart() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database_path = directory.path().join("workspace.db");
        let database = WorkspaceState::open(&database_path).expect("open workspace");
        database
            .remember_project(directory.path(), "sample", true, 1)
            .expect("remember project");
        let mut run = database
            .create_deployment_run(
                directory.path(),
                "sample",
                "production",
                "owner/sample",
                "main",
            )
            .expect("create deployment");
        run.route_checks = vec![
            PublicRouteStatus {
                host: "app.example.com".to_string(),
                url: "https://app.example.com/".to_string(),
                phase: "ready".to_string(),
                reachable: true,
                http_status: Some(200),
                message: "app.example.com 可以访问".to_string(),
            },
            PublicRouteStatus {
                host: "api.example.com".to_string(),
                url: "https://api.example.com/".to_string(),
                phase: "https".to_string(),
                reachable: false,
                http_status: None,
                message: "api.example.com 的 HTTPS 尚未就绪".to_string(),
            },
        ];
        let run_id = run.id.clone();
        database
            .save_deployment_run(&run)
            .expect("save route checks");
        drop(database);

        let reopened = WorkspaceState::open(&database_path).expect("reopen workspace");
        let restored = reopened
            .deployment_run(&run_id)
            .expect("restore deployment");
        assert_eq!(restored.route_checks, run.route_checks);
        assert_eq!(
            reopened
                .list_deployment_runs(directory.path())
                .expect("list deployments")[0]
                .route_checks,
            run.route_checks
        );
    }

    #[test]
    fn relinks_a_moved_project_without_losing_history_bindings_or_settings() {
        let directory = tempfile::tempdir().expect("temp dir");
        let old_path = directory.path().join("original project");
        let new_path = directory.path().join("moved project");
        fs::create_dir_all(&old_path).expect("create original project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&old_path, "sample", true, 2)
            .expect("remember project");
        database
            .set_project_step(&old_path, "connections")
            .expect("save project step");
        let original = database.list_projects().expect("original project")[0].clone();
        let recorded_old_path = std::path::PathBuf::from(&original.path);
        let original_storage_id = project_storage_id(&old_path);

        let mut run = database
            .create_deployment_run(&old_path, "sample", "staging", "team/sample", "main")
            .expect("create deployment history");
        run.status = "success".to_string();
        run.current_stage = "complete".to_string();
        database.save_deployment_run(&run).expect("save deployment");

        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "test-only-placeholder").expect("write key placeholder");
        database
            .bind_project_server(
                &old_path,
                "staging",
                &SshProfile {
                    name: "test-server".to_string(),
                    host: "203.0.113.20".to_string(),
                    user: "ubuntu".to_string(),
                    port: 22,
                    key_path,
                    host_fingerprint: Some("SHA256:moved".to_string()),
                },
            )
            .expect("bind server");
        let profile = ConfigProfile {
            id: "moved-database".to_string(),
            kind: "database".to_string(),
            provider: "postgresql".to_string(),
            name: "线上数据库".to_string(),
            scope: "remote".to_string(),
            values: BTreeMap::new(),
            secret_fields: vec!["url".to_string()],
            configured_secret_fields: Vec::new(),
            is_default: true,
            updated_at: String::new(),
        };
        database
            .save_config_profile(&profile)
            .expect("save profile");
        database
            .bind_config_profile(&old_path, "staging", "database", &profile.id)
            .expect("bind profile");

        let old_normalized = old_path
            .canonicalize()
            .expect("canonical original")
            .to_string_lossy()
            .into_owned();
        let old_setting = format!(
            "project.{}.verified-version",
            encode_uri_component(&old_normalized)
        );
        database
            .set_setting(&old_setting, "verified-image")
            .expect("save project setting");
        database
            .set_setting("active-project", &old_normalized)
            .expect("save active project");

        fs::rename(&old_path, &new_path).expect("move project folder");
        let recovered_path = database
            .relink_project(&recorded_old_path, &new_path, "sample", true, 2)
            .expect("relink moved project");
        let new_normalized = new_path
            .canonicalize()
            .expect("canonical moved path")
            .to_string_lossy()
            .into_owned();
        assert_eq!(recovered_path, new_normalized);
        assert_eq!(project_storage_id(&new_path), original_storage_id);
        assert!(
            fs::read_to_string(new_path.join(".deploydesk/.gitignore"))
                .expect("local state ignore")
                .lines()
                .any(|line| line == "state/")
        );

        let recovered = database.list_projects().expect("recovered project");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, original.id);
        assert_eq!(recovered[0].path, new_normalized);
        assert!(recovered[0].path_exists);
        assert_eq!(recovered[0].latest_run_id.as_deref(), Some(run.id.as_str()));
        assert_eq!(
            database.project_step(&new_path).expect("preserved step"),
            Some("connections".to_string())
        );
        assert!(
            database
                .list_deployment_runs(&recorded_old_path)
                .expect("old history")
                .is_empty()
        );
        assert_eq!(
            database
                .list_deployment_runs(&new_path)
                .expect("moved history")[0]
                .id,
            run.id
        );
        assert_eq!(
            database
                .server_for_project(&new_path, "staging")
                .expect("moved server binding")
                .expect("bound server")
                .host,
            "203.0.113.20"
        );
        assert_eq!(
            database
                .config_profile_bindings(&new_path, "staging")
                .expect("moved profile binding")[0]
                .profile_id,
            profile.id
        );
        let new_setting = format!(
            "project.{}.verified-version",
            encode_uri_component(&new_normalized)
        );
        assert!(
            database
                .setting(&old_setting)
                .expect("old setting")
                .is_none()
        );
        assert_eq!(
            database
                .setting(&new_setting)
                .expect("moved setting")
                .as_deref(),
            Some("verified-image")
        );
        assert_eq!(
            database
                .setting("active-project")
                .expect("active project")
                .as_deref(),
            Some(new_normalized.as_str())
        );
    }

    #[test]
    fn upgrades_existing_server_records_with_host_fingerprints() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("legacy-workspace.db");
        let connection = Connection::open(&path).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE servers (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   host TEXT NOT NULL,
                   user TEXT NOT NULL,
                   port INTEGER NOT NULL,
                   key_path TEXT NOT NULL,
                   last_checked_at TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   UNIQUE(host, user, port)
                 );
                 CREATE TABLE deployment_runs (
                   id TEXT PRIMARY KEY,
                   project_path TEXT NOT NULL,
                   project_name TEXT NOT NULL,
                   environment TEXT NOT NULL,
                   status TEXT NOT NULL,
                   current_stage TEXT NOT NULL,
                   build_serial TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .expect("create legacy server table");
        drop(connection);

        let database = WorkspaceState::open(&path).expect("upgrade workspace");
        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "test-only-placeholder").expect("write key placeholder");
        database
            .remember_server(&SshProfile {
                name: "upgraded-server".to_string(),
                host: "203.0.113.11".to_string(),
                user: "ubuntu".to_string(),
                port: 22,
                key_path,
                host_fingerprint: Some("SHA256:upgraded".to_string()),
            })
            .expect("remember upgraded server");
        let servers = database.list_servers().expect("list upgraded servers");
        assert_eq!(
            servers[0].host_fingerprint.as_deref(),
            Some("SHA256:upgraded")
        );

        database
            .remember_project(directory.path(), "upgraded-project", true, 1)
            .expect("remember upgraded project");
        let mut run = database
            .create_deployment_run(
                directory.path(),
                "upgraded-project",
                "staging",
                "owner/project",
                "main",
            )
            .expect("create upgraded run");
        run.commit_sha = Some("0123456789abcdef0123456789abcdef01234567".to_string());
        run.source_title = Some("旧数据库升级后也能保存版本说明".to_string());
        database
            .save_deployment_run(&run)
            .expect("save upgraded run");
        assert_eq!(
            database
                .deployment_run(&run.id)
                .expect("load upgraded run")
                .commit_sha
                .as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(
            database
                .deployment_run(&run.id)
                .expect("load upgraded run")
                .source_title
                .as_deref(),
            Some("旧数据库升级后也能保存版本说明")
        );
    }

    #[test]
    fn persists_version_validation_across_workspace_restart() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database_path = directory.path().join("workspace.db");
        let expected_version_key;
        let run_id;
        {
            let database = WorkspaceState::open(&database_path).expect("open workspace");
            database
                .remember_project(&project_path, "sample", true, 1)
                .expect("remember project");
            let run = save_successful_staging_run(
                &database,
                &project_path,
                "1111111111111111111111111111111111111111",
                vec![DeploymentArtifact {
                    service: " api ".to_string(),
                    image: " registry.example.com/sample/api ".to_string(),
                    digest: " SHA256:ABCDEF ".to_string(),
                }],
            );
            run_id = run.id.clone();
            expected_version_key =
                "images:api\0registry.example.com/sample/api\0sha256:abcdef".to_string();
            let validation = database
                .set_version_validation(&project_path, &run.id, "passed")
                .expect("confirm validation");
            assert_eq!(validation.version_key, expected_version_key);
            assert_eq!(validation.state, "passed");
        }

        let reopened = WorkspaceState::open(&database_path).expect("reopen workspace");
        let validations = reopened
            .list_version_validations(&project_path)
            .expect("list persisted validations");
        assert_eq!(validations.len(), 1);
        assert_eq!(validations[0].version_key, expected_version_key);
        assert_eq!(validations[0].state, "passed");
        assert_eq!(validations[0].run_id, run_id);
    }

    #[test]
    fn lists_immutable_project_versions_with_artifacts_validation_and_environment_ownership() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 2)
            .expect("remember project");
        let artifacts = vec![
            DeploymentArtifact {
                service: " web ".to_string(),
                image: " registry.example.com/sample/web ".to_string(),
                digest: " SHA256:BBBB ".to_string(),
            },
            DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:aaaa".to_string(),
            },
        ];
        let mut staging = save_successful_staging_run(
            &database,
            &project_path,
            "5555555555555555555555555555555555555555",
            artifacts,
        );
        staging.build_serial = Some("501".to_string());
        staging.source_title = Some("加入批量导入".to_string());
        database
            .save_deployment_run(&staging)
            .expect("save staging source metadata");
        let validation = database
            .set_version_validation(&project_path, &staging.id, "passed")
            .expect("pass staging version");
        let production_artifacts = vec![
            DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "SHA256:AAAA".to_string(),
            },
            DeploymentArtifact {
                service: "web".to_string(),
                image: "registry.example.com/sample/web".to_string(),
                digest: "sha256:bbbb".to_string(),
            },
        ];
        let production = save_successful_production_run(
            &database,
            &staging,
            production_artifacts,
            "2030-01-01T00:00:00Z",
        );
        let mut approval = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create production approval record");
        approval.status = "success".to_string();
        approval.current_stage = "complete".to_string();
        approval.commit_sha.clone_from(&staging.commit_sha);
        approval.artifacts.clone_from(&staging.artifacts);
        approval.action_kind = Some("production-approval".to_string());
        approval.started_at = "2035-01-01T00:00:00Z".to_string();
        approval.updated_at = approval.started_at.clone();
        database
            .save_deployment_run(&approval)
            .expect("save production approval record");
        let mut failed = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create failed staging record");
        failed.status = "failed".to_string();
        failed.current_stage = "deploy".to_string();
        failed.commit_sha.clone_from(&staging.commit_sha);
        failed.artifacts.clone_from(&staging.artifacts);
        failed.started_at = "2040-01-01T00:00:00Z".to_string();
        failed.updated_at = failed.started_at.clone();
        database
            .save_deployment_run(&failed)
            .expect("save failed staging record");
        {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "UPDATE deployment_runs
                     SET version_id = (
                       SELECT version_id FROM deployment_runs WHERE id = ?2
                     )
                     WHERE id = ?1",
                    rusqlite::params![failed.id, staging.id],
                )
                .expect("link legacy failed record to immutable version");
        }

        let versions = database
            .list_project_versions(&project_path)
            .expect("list versions");
        assert_eq!(versions.len(), 1);
        let version = &versions[0];
        assert_eq!(version.version_key, validation.version_key);
        assert_eq!(version.status, "available");
        assert_eq!(version.commit_sha, staging.commit_sha);
        assert_eq!(version.source_title, staging.source_title);
        assert_eq!(version.source_build_id.as_deref(), Some("501"));
        assert!(version.source_connection_id.is_none());
        assert_eq!(version.repository.as_deref(), Some("owner/sample"));
        assert_eq!(version.branch.as_deref(), Some("main"));
        assert_eq!(version.staging_run_id.as_deref(), Some(staging.id.as_str()));
        assert_ne!(
            version.staging_run_id.as_deref(),
            Some(production.id.as_str())
        );
        assert_ne!(
            version.staging_run_id.as_deref(),
            Some(approval.id.as_str())
        );
        assert_ne!(version.staging_run_id.as_deref(), Some(failed.id.as_str()));
        assert_eq!(version.validation.as_ref(), Some(&validation));
        assert_eq!(
            version.current_environments,
            vec!["staging".to_string(), "production".to_string()]
        );
        assert_eq!(
            version.artifacts,
            vec![
                DeploymentArtifact {
                    service: "api".to_string(),
                    image: "registry.example.com/sample/api".to_string(),
                    digest: "sha256:aaaa".to_string(),
                },
                DeploymentArtifact {
                    service: "web".to_string(),
                    image: "registry.example.com/sample/web".to_string(),
                    digest: "sha256:bbbb".to_string(),
                },
            ]
        );
        assert_eq!(
            database
                .deployment_run(&production.id)
                .expect("production remains linked")
                .source_run_id,
            Some(staging.id)
        );
    }

    #[test]
    fn failed_deployment_does_not_create_a_project_version() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let mut run = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create failed run");
        run.status = "failed".to_string();
        run.current_stage = "deploy".to_string();
        run.commit_sha = Some("6666666666666666666666666666666666666666".to_string());
        run.artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:cccc".to_string(),
        }];
        database.save_deployment_run(&run).expect("save failed run");

        assert!(
            database
                .list_project_versions(&project_path)
                .expect("list versions")
                .is_empty()
        );
    }

    #[test]
    fn shares_validation_between_runs_with_the_same_immutable_artifacts() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 2)
            .expect("remember project");
        let first = save_successful_staging_run(
            &database,
            &project_path,
            "2222222222222222222222222222222222222222",
            vec![
                DeploymentArtifact {
                    service: "web".to_string(),
                    image: "registry.example.com/sample/web".to_string(),
                    digest: "sha256:bbbb".to_string(),
                },
                DeploymentArtifact {
                    service: "api".to_string(),
                    image: "registry.example.com/sample/api".to_string(),
                    digest: "sha256:aaaa".to_string(),
                },
            ],
        );
        database
            .set_version_validation(&project_path, &first.id, "passed")
            .expect("pass first run");
        let second = save_successful_staging_run(
            &database,
            &project_path,
            "3333333333333333333333333333333333333333",
            vec![
                DeploymentArtifact {
                    service: "api".to_string(),
                    image: "registry.example.com/sample/api".to_string(),
                    digest: "SHA256:AAAA".to_string(),
                },
                DeploymentArtifact {
                    service: "web".to_string(),
                    image: "registry.example.com/sample/web".to_string(),
                    digest: "SHA256:BBBB".to_string(),
                },
            ],
        );

        let connection = database.connection.lock().expect("database lock");
        let version_count: u32 = connection
            .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0))
            .expect("version count");
        let linked_versions: (String, String) = connection
            .query_row(
                "SELECT first.version_id, second.version_id
                 FROM deployment_runs first, deployment_runs second
                 WHERE first.id = ?1 AND second.id = ?2",
                rusqlite::params![first.id, second.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("linked versions");
        drop(connection);
        assert_eq!(version_count, 1);
        assert_eq!(linked_versions.0, linked_versions.1);
        let validations = database
            .list_version_validations(&project_path)
            .expect("shared validation");
        assert_eq!(validations.len(), 1);
        assert_eq!(validations[0].state, "passed");
    }

    #[test]
    fn latest_rejected_result_replaces_the_previous_passed_result() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let run = save_successful_staging_run(
            &database,
            &project_path,
            "4444444444444444444444444444444444444444",
            Vec::new(),
        );
        database
            .set_version_validation(&project_path, &run.id, "passed")
            .expect("pass version");
        let rejected = database
            .set_version_validation(&project_path, &run.id, "rejected")
            .expect("reject version");
        assert_eq!(rejected.state, "rejected");
        assert_eq!(
            rejected.version_key,
            format!("commit:{}", run.commit_sha.unwrap())
        );

        let validations = database
            .list_version_validations(&project_path)
            .expect("latest validation");
        assert_eq!(validations.len(), 1);
        assert_eq!(validations[0].state, "rejected");
        let connection = database.connection.lock().expect("database lock");
        let validation_count: u32 = connection
            .query_row("SELECT COUNT(*) FROM version_validations", [], |row| {
                row.get(0)
            })
            .expect("validation count");
        assert_eq!(validation_count, 1);
    }

    #[test]
    fn production_success_reuses_the_staging_version_and_updates_environment_pointer() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:1111".to_string(),
        }];
        let staging = save_successful_staging_run(
            &database,
            &project_path,
            "1111111111111111111111111111111111111111",
            artifacts.clone(),
        );
        let production =
            save_successful_production_run(&database, &staging, artifacts, "2026-07-01T00:00:00Z");

        let environments = database
            .list_project_environments(&project_path)
            .expect("list environments");
        assert_eq!(
            environments
                .iter()
                .map(|environment| environment.environment.as_str())
                .collect::<Vec<_>>(),
            vec!["development", "staging", "production"]
        );
        let staging_environment = environments
            .iter()
            .find(|environment| environment.environment == "staging")
            .expect("staging environment");
        let production_environment = environments
            .iter()
            .find(|environment| environment.environment == "production")
            .expect("production environment");
        assert_eq!(staging_environment.status, "healthy");
        assert_eq!(production_environment.status, "healthy");
        assert_eq!(
            production_environment.current_version_key,
            staging_environment.current_version_key
        );
        assert_eq!(
            production_environment.current_run_id.as_deref(),
            Some(production.id.as_str())
        );

        let connection = database.connection.lock().expect("database lock");
        let (staging_version_id, production_version_id): (String, String) = connection
            .query_row(
                "SELECT staging.version_id, production.version_id
                 FROM deployment_runs staging, deployment_runs production
                 WHERE staging.id = ?1 AND production.id = ?2",
                rusqlite::params![staging.id, production.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("linked versions");
        assert_eq!(production_version_id, staging_version_id);
        let version_count: u32 = connection
            .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0))
            .expect("version count");
        assert_eq!(version_count, 1);
    }

    #[test]
    fn newer_failed_or_needs_action_production_does_not_replace_online_version() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let first_artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:1111".to_string(),
        }];
        let first_source = save_successful_staging_run(
            &database,
            &project_path,
            "1111111111111111111111111111111111111111",
            first_artifacts.clone(),
        );
        let first_production = save_successful_production_run(
            &database,
            &first_source,
            first_artifacts,
            "2026-07-01T00:00:00Z",
        );
        let second_source = save_successful_staging_run(
            &database,
            &project_path,
            "2222222222222222222222222222222222222222",
            vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:2222".to_string(),
            }],
        );
        for status in ["failed", "needs_action"] {
            let mut attempt = database
                .create_deployment_run(
                    &project_path,
                    "sample",
                    "production",
                    "owner/sample",
                    "main",
                )
                .expect("create unsuccessful production run");
            attempt.status = status.to_string();
            attempt.source_run_id = Some(second_source.id.clone());
            attempt.started_at = format!(
                "2026-07-0{}T00:00:00Z",
                if status == "failed" { 2 } else { 3 }
            );
            attempt.updated_at.clone_from(&attempt.started_at);
            database
                .save_deployment_run(&attempt)
                .expect("save unsuccessful production run");
        }

        let production = database
            .list_project_environments(&project_path)
            .expect("list environments")
            .into_iter()
            .find(|environment| environment.environment == "production")
            .expect("production environment");
        assert_eq!(production.status, "healthy");
        assert_eq!(
            production.current_run_id.as_deref(),
            Some(first_production.id.as_str())
        );
    }

    #[test]
    fn restart_backfills_production_history_and_preserves_a_newer_rollback() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database_path = directory.path().join("workspace.db");
        let first_source_id;
        let second_source_id;
        let first_production_id;
        let second_production_id;
        let rollback_id;
        {
            let database = WorkspaceState::open(&database_path).expect("workspace");
            database
                .remember_project(&project_path, "sample", true, 1)
                .expect("remember project");
            let first_artifacts = vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:1111".to_string(),
            }];
            let second_artifacts = vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:2222".to_string(),
            }];
            let first_source = save_successful_staging_run(
                &database,
                &project_path,
                "1111111111111111111111111111111111111111",
                first_artifacts.clone(),
            );
            let second_source = save_successful_staging_run(
                &database,
                &project_path,
                "2222222222222222222222222222222222222222",
                second_artifacts.clone(),
            );
            let first_production = save_successful_production_run(
                &database,
                &first_source,
                first_artifacts.clone(),
                "2026-07-01T00:00:00Z",
            );
            let second_production = save_successful_production_run(
                &database,
                &second_source,
                second_artifacts,
                "2026-07-02T00:00:00Z",
            );
            let rollback = save_successful_production_run(
                &database,
                &first_source,
                first_artifacts,
                "2026-07-03T00:00:00Z",
            );
            first_source_id = first_source.id;
            second_source_id = second_source.id;
            first_production_id = first_production.id;
            second_production_id = second_production.id;
            rollback_id = rollback.id;

            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "UPDATE deployment_runs SET version_id = NULL
                     WHERE environment = 'production'",
                    [],
                )
                .expect("clear legacy production version links");
            connection
                .execute(
                    "UPDATE environments
                     SET current_version_id = NULL,
                         current_deployment_run_id = NULL,
                         status = 'unknown'
                     WHERE name = 'production'",
                    [],
                )
                .expect("clear legacy production pointer");
        }

        let reopened = WorkspaceState::open(&database_path).expect("reopen workspace");
        let production = reopened
            .list_project_environments(&project_path)
            .expect("list restored environments")
            .into_iter()
            .find(|environment| environment.environment == "production")
            .expect("production environment");
        assert_eq!(production.status, "healthy");
        assert_eq!(
            production.current_run_id.as_deref(),
            Some(rollback_id.as_str())
        );
        assert_eq!(
            reopened
                .production_rollback_source_run(&project_path)
                .expect("find next rollback source")
                .expect("previous healthy production version")
                .id,
            second_source_id
        );

        let connection = reopened.connection.lock().expect("database lock");
        let (first_source_version, second_source_version): (String, String) = connection
            .query_row(
                "SELECT first.version_id, second.version_id
                 FROM deployment_runs first, deployment_runs second
                 WHERE first.id = ?1 AND second.id = ?2",
                rusqlite::params![first_source_id, second_source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("source versions");
        let (first_production_version, second_production_version, rollback_version): (
            String,
            String,
            String,
        ) = connection
            .query_row(
                "SELECT first.version_id, second.version_id, rollback.version_id
                 FROM deployment_runs first, deployment_runs second, deployment_runs rollback
                 WHERE first.id = ?1 AND second.id = ?2 AND rollback.id = ?3",
                rusqlite::params![first_production_id, second_production_id, rollback_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("restored production versions");
        assert_eq!(first_production_version, first_source_version);
        assert_eq!(second_production_version, second_source_version);
        assert_eq!(rollback_version, first_source_version);
        let current_version: String = connection
            .query_row(
                "SELECT current_version_id FROM environments
                 WHERE name = 'production'",
                [],
                |row| row.get(0),
            )
            .expect("current production version");
        assert_eq!(current_version, first_source_version);
    }

    #[test]
    fn production_digest_mismatch_is_atomic_and_does_not_switch_pointer() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");
        let first_artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:1111".to_string(),
        }];
        let first_source = save_successful_staging_run(
            &database,
            &project_path,
            "1111111111111111111111111111111111111111",
            first_artifacts.clone(),
        );
        let current = save_successful_production_run(
            &database,
            &first_source,
            first_artifacts,
            "2026-07-01T00:00:00Z",
        );
        let second_source = save_successful_staging_run(
            &database,
            &project_path,
            "2222222222222222222222222222222222222222",
            vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: "sha256:2222".to_string(),
            }],
        );
        let mut mismatch = database
            .create_deployment_run(
                &project_path,
                "sample",
                "production",
                "owner/sample",
                "main",
            )
            .expect("create mismatched production run");
        mismatch.status = "success".to_string();
        mismatch.current_stage = "complete".to_string();
        mismatch.source_run_id = Some(second_source.id);
        mismatch.artifacts = vec![DeploymentArtifact {
            service: "api".to_string(),
            image: "registry.example.com/sample/api".to_string(),
            digest: "sha256:deadbeef".to_string(),
        }];
        mismatch.started_at = "2026-07-02T00:00:00Z".to_string();
        mismatch.updated_at.clone_from(&mismatch.started_at);
        let error = database
            .save_deployment_run(&mismatch)
            .expect_err("reject mismatched digest");
        assert!(error.contains("镜像摘要与测试通过版本不一致"));

        let production = database
            .list_project_environments(&project_path)
            .expect("list environments")
            .into_iter()
            .find(|environment| environment.environment == "production")
            .expect("production environment");
        assert_eq!(
            production.current_run_id.as_deref(),
            Some(current.id.as_str())
        );
        let stored_attempt = database
            .deployment_run(&mismatch.id)
            .expect("load original queued attempt");
        assert_eq!(stored_attempt.status, "queued");
        let connection = database.connection.lock().expect("database lock");
        let version_id: Option<String> = connection
            .query_row(
                "SELECT version_id FROM deployment_runs WHERE id = ?1",
                [mismatch.id],
                |row| row.get(0),
            )
            .expect("mismatch version link");
        assert!(version_id.is_none());
    }

    #[test]
    fn persists_pending_managed_and_fresh_draft_adoption_states_across_restarts() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database_path = directory.path().join("workspace.db");
        let existing_project = directory.path().join("existing");
        let new_project = directory.path().join("new");
        fs::create_dir_all(&existing_project).expect("create existing project");
        fs::create_dir_all(&new_project).expect("create new project");

        {
            let database = WorkspaceState::open(&database_path).expect("workspace");
            database
                .remember_project_with_identity(
                    &existing_project,
                    "existing",
                    true,
                    1,
                    Some("owner/existing"),
                    None,
                )
                .expect("remember existing project");
            let pending = database
                .initialize_project_adoption(&existing_project, true)
                .expect("pending adoption");
            assert_eq!(pending.mode, "pending");
            assert!(!pending.fresh_draft);
            assert!(pending.history_import_after.is_none());

            let managed = database
                .continue_existing_deployment(&existing_project)
                .expect("continue existing deployment");
            assert_eq!(managed.mode, "managed");
            assert!(!managed.fresh_draft);

            database
                .remember_project_with_identity(
                    &new_project,
                    "new",
                    false,
                    1,
                    Some("owner/new"),
                    None,
                )
                .expect("remember new project");
            let fresh = database
                .initialize_project_adoption(&new_project, false)
                .expect("fresh adoption");
            assert_eq!(fresh.mode, "fresh");
            assert!(fresh.fresh_draft);
            assert!(fresh.history_import_after.is_some());
            database
                .mark_project_fresh_draft_saved(&new_project)
                .expect("save fresh draft");
        }

        let reopened = WorkspaceState::open(&database_path).expect("reopen workspace");
        assert_eq!(
            reopened
                .project_adoption(&existing_project)
                .expect("managed adoption")
                .mode,
            "managed"
        );
        let fresh = reopened
            .project_adoption(&new_project)
            .expect("fresh adoption");
        assert_eq!(fresh.mode, "fresh");
        assert!(!fresh.fresh_draft);
        assert!(fresh.history_import_after.is_some());
    }

    #[test]
    fn fresh_initialization_removes_legacy_rows_before_the_new_draft_is_saved() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project-with-removed-files");
        fs::create_dir_all(&project_path).expect("create project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember managed project");
        let old_run = database
            .create_deployment_run(&project_path, "sample", "staging", "owner/sample", "main")
            .expect("create old run");
        {
            let normalized_path = super::normalize_path(&project_path);
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "UPDATE projects
                     SET deployment_adoption_mode = 'pending',
                         external_import_after = NULL,
                         adoption_decided_at = NULL,
                         deployment_fresh_draft = 0
                     WHERE path = ?1",
                    [&normalized_path],
                )
                .expect("simulate migrated pending project");
        }

        let fresh = database
            .initialize_project_adoption(&project_path, false)
            .expect("start fresh without deployment files");
        assert_eq!(fresh.mode, "fresh");
        assert!(fresh.fresh_draft);
        database
            .mark_project_fresh_draft_saved(&project_path)
            .expect("save replacement draft");
        assert!(
            database
                .list_deployment_runs(&project_path)
                .expect("old history stays removed")
                .is_empty()
        );
        assert!(
            database
                .deployment_run(&old_run.id)
                .expect_err("old run was deleted")
                .contains("找不到这次部署记录")
        );
    }

    #[test]
    fn reset_clears_only_project_deployment_state_and_blocks_stale_resurrection() {
        let directory = tempfile::tempdir().expect("temp dir");
        let project_path = directory.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let manifest_path = project_path.join("deploy.yaml");
        fs::write(&manifest_path, "project: unchanged\n").expect("write project manifest");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&project_path, "sample", true, 1)
            .expect("remember project");

        let metadata = BTreeMap::new();
        database
            .upsert_compat_connection(
                CNB_SOURCE_CONNECTION_ID,
                "source",
                "cnb",
                "CNB",
                Some("cnb-token"),
                &metadata,
                &["builds".to_string()],
                "ready",
                None,
            )
            .expect("save source connection");
        database
            .upsert_compat_connection(
                TCR_REGISTRY_CONNECTION_ID,
                "registry",
                "tcr",
                "TCR",
                Some("registry.tcr.v2.password"),
                &metadata,
                &["pull".to_string()],
                "ready",
                None,
            )
            .expect("save registry connection");
        database
            .bind_project_source_connection(&project_path, Some(CNB_SOURCE_CONNECTION_ID))
            .expect("bind source");
        database
            .bind_project_registry_connection(
                &project_path,
                "staging",
                Some(TCR_REGISTRY_CONNECTION_ID),
            )
            .expect("bind registry");

        let key_path = directory.path().join("id_ed25519");
        fs::write(&key_path, "private-key-placeholder").expect("write key placeholder");
        let server = SshProfile {
            name: "test server".to_string(),
            host: "192.0.2.10".to_string(),
            user: "ubuntu".to_string(),
            port: 22,
            key_path,
            host_fingerprint: Some("SHA256:test".to_string()),
        };
        database
            .bind_project_server(&project_path, "staging", &server)
            .expect("bind server");

        let profile = ConfigProfile {
            id: "profile-shared".to_string(),
            kind: "custom".to_string(),
            provider: "environment".to_string(),
            name: "shared config".to_string(),
            scope: "any".to_string(),
            values: BTreeMap::from([("FEATURE".to_string(), "on".to_string())]),
            secret_fields: Vec::new(),
            configured_secret_fields: Vec::new(),
            is_default: false,
            updated_at: String::new(),
        };
        database
            .save_config_profile(&profile)
            .expect("save config profile");
        database
            .bind_config_profile(&project_path, "staging", "custom", &profile.id)
            .expect("bind staging config");
        database
            .bind_config_profile(&project_path, "development", "custom", &profile.id)
            .expect("bind development config");

        let run = save_successful_staging_run(
            &database,
            &project_path,
            "1111111111111111111111111111111111111111",
            vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/sample/api".to_string(),
                digest: format!("sha256:{}", "1".repeat(64)),
            }],
        );
        database
            .set_version_validation(&project_path, &run.id, "passed")
            .expect("validate version");

        let normalized_path = super::normalize_path(&project_path);
        let prefix = format!("project.{}.", encode_uri_component(&normalized_path));
        for suffix in [
            "version-setup-complete",
            "verified-run",
            "cnb-secret-progress.staging",
            "production-health-check.old-run",
            "staging-runtime-ready.ubuntu%40host%3A22",
        ] {
            database
                .set_setting(&format!("{prefix}{suffix}"), "saved")
                .expect("save deployment setting");
        }
        database
            .set_setting(&format!("{prefix}local-milestone"), "opened")
            .expect("save local setting");
        database
            .set_setting("registry.mode", "tcr")
            .expect("save global setting");

        {
            let connection = database.connection.lock().expect("database lock");
            let project_id: String = connection
                .query_row(
                    "SELECT id FROM projects WHERE path = ?1",
                    [&normalized_path],
                    |row| row.get(0),
                )
                .expect("project id");
            connection
                .execute(
                    "INSERT INTO automation_rules (
                       id, project_id, name, trigger_kind, action_kind,
                       desired_state, observed_state, created_at, updated_at
                     ) VALUES ('rule', ?1, 'main', 'push', 'deploy',
                               'enabled', 'ready', 'now', 'now')",
                    [&project_id],
                )
                .expect("save automation rule");
        }

        let reset = database
            .reset_project_deployment(&project_path)
            .expect("reset deployment");
        assert_eq!(reset.mode, "fresh");
        assert!(reset.fresh_draft);
        assert!(reset.history_import_after.is_some());
        assert_eq!(
            fs::read_to_string(&manifest_path).expect("read manifest"),
            "project: unchanged\n"
        );
        assert!(
            database
                .list_deployment_runs(&project_path)
                .expect("list runs")
                .is_empty()
        );
        assert!(
            database
                .list_project_versions(&project_path)
                .expect("list versions")
                .is_empty()
        );
        for environment in database
            .list_project_environments(&project_path)
            .expect("list environments")
            .into_iter()
            .filter(|environment| {
                matches!(environment.environment.as_str(), "staging" | "production")
            })
        {
            assert_eq!(environment.status, "unknown");
            assert!(environment.current_run_id.is_none());
            assert!(environment.current_version_key.is_none());
        }
        assert_eq!(
            database
                .project_connection_bindings(&project_path)
                .expect("connection bindings"),
            super::ProjectConnectionBindings::default()
        );
        assert!(
            database
                .server_for_project(&project_path, "staging")
                .expect("server binding")
                .is_none()
        );
        assert!(
            database
                .config_profile_bindings(&project_path, "staging")
                .expect("staging config bindings")
                .is_empty()
        );
        assert_eq!(
            database
                .config_profile_bindings(&project_path, "development")
                .expect("development config bindings")
                .len(),
            1
        );
        assert_eq!(
            database.list_connections(None).expect("connections").len(),
            3
        );
        assert_eq!(database.list_servers().expect("servers").len(), 1);
        assert!(
            database
                .config_profile(&profile.id)
                .expect("profile")
                .is_some()
        );
        assert_eq!(
            database
                .setting("registry.mode")
                .expect("global setting")
                .as_deref(),
            Some("tcr")
        );
        assert_eq!(
            database
                .setting(&format!("{prefix}local-milestone"))
                .expect("local setting")
                .as_deref(),
            Some("opened")
        );
        assert!(
            database
                .setting(&format!("{prefix}version-setup-complete"))
                .expect("setup setting")
                .is_none()
        );

        let stale_error = database
            .save_deployment_run(&run)
            .expect_err("stale run must not be resurrected");
        assert!(stale_error.contains("AD-STATE-STALE"));
        assert!(
            database
                .list_deployment_runs(&project_path)
                .expect("runs after stale save")
                .is_empty()
        );
    }

    #[test]
    fn pending_and_fresh_draft_hide_legacy_state_until_continue_backfills_it() {
        let directory = tempfile::tempdir().expect("temp dir");
        let database_path = directory.path().join("workspace.db");
        let project_path = directory.path().join("legacy-project");
        fs::create_dir_all(&project_path).expect("create project");
        let normalized_path = super::normalize_path(&project_path);
        let success_id = "legacy-staging-success".to_string();
        let active_id = "legacy-production-active".to_string();

        {
            let database = WorkspaceState::open(&database_path).expect("workspace");
            database
                .remember_project_with_identity(
                    &project_path,
                    "legacy",
                    true,
                    1,
                    Some("owner/legacy"),
                    None,
                )
                .expect("remember pending project");

            let key_path = directory.path().join("legacy_id_ed25519");
            fs::write(&key_path, "private-key-placeholder").expect("write key placeholder");
            let server = SshProfile {
                name: "legacy server".to_string(),
                host: "192.0.2.44".to_string(),
                user: "ubuntu".to_string(),
                port: 22,
                key_path,
                host_fingerprint: Some("SHA256:legacy".to_string()),
            };
            database.remember_server(&server).expect("remember server");
            let server_id =
                super::project_id(&format!("{}@{}:{}", server.user, server.host, server.port));

            let mut success = database
                .deployment_run_draft(&project_path, "legacy", "staging", "owner/legacy", "main")
                .expect("staging draft");
            success.id.clone_from(&success_id);
            success.status = "success".to_string();
            success.current_stage = "complete".to_string();
            success.commit_sha = Some("1111111111111111111111111111111111111111".to_string());
            success.artifacts = vec![DeploymentArtifact {
                service: "api".to_string(),
                image: "registry.example.com/legacy/api".to_string(),
                digest: format!("sha256:{}", "1".repeat(64)),
            }];
            success.started_at = "2026-07-01T00:00:00Z".to_string();
            success.updated_at.clone_from(&success.started_at);

            let mut active = database
                .deployment_run_draft(
                    &project_path,
                    "legacy",
                    "production",
                    "owner/legacy",
                    "main",
                )
                .expect("production draft");
            active.id.clone_from(&active_id);
            active.status = "running".to_string();
            active.current_stage = "deploy".to_string();
            active.started_at = "2026-07-02T00:00:00Z".to_string();
            active.updated_at.clone_from(&active.started_at);

            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO project_server_bindings (
                       project_path, environment, server_id, updated_at
                     ) VALUES (?1, 'staging', ?2, '2026-07-01T00:00:00Z')",
                    rusqlite::params![normalized_path, server_id],
                )
                .expect("insert legacy server binding");
            for run in [&success, &active] {
                let artifacts = serde_json::to_string(&run.artifacts).expect("artifacts");
                let completed_steps =
                    serde_json::to_string(&run.completed_steps).expect("completed steps");
                connection
                    .execute(
                        "INSERT INTO deployment_runs (
                           id, project_path, project_name, environment, status,
                           current_stage, build_serial, commit_sha, source_title,
                           source_run_id, candidate_tag, artifacts, action_kind,
                           action_url, issue_code, repository, branch, message,
                           completed_steps, started_at, updated_at
                         ) VALUES (
                           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
                         )",
                        rusqlite::params![
                            run.id,
                            run.project_path,
                            run.project_name,
                            run.environment,
                            run.status,
                            run.current_stage,
                            run.build_serial,
                            run.commit_sha,
                            run.source_title,
                            run.source_run_id,
                            run.candidate_tag,
                            artifacts,
                            run.action_kind,
                            run.action_url,
                            run.issue_code,
                            run.repository,
                            run.branch,
                            run.message,
                            completed_steps,
                            run.started_at,
                            run.updated_at,
                        ],
                    )
                    .expect("insert legacy run");
            }
        }

        let database = WorkspaceState::open(&database_path).expect("reopen workspace");
        assert_eq!(
            database
                .project_adoption(&project_path)
                .expect("pending adoption")
                .mode,
            "pending"
        );
        assert!(
            database
                .list_deployment_runs(&project_path)
                .expect("hidden runs")
                .is_empty()
        );
        assert!(
            database
                .list_project_versions(&project_path)
                .expect("hidden versions")
                .is_empty()
        );
        assert!(
            database
                .server_for_project(&project_path, "staging")
                .expect("hidden server")
                .is_none()
        );
        assert!(
            database
                .list_active_deployment_runs()
                .expect("hidden active runs")
                .is_empty()
        );
        assert!(
            database
                .list_attention_deployment_runs()
                .expect("hidden attention runs")
                .is_empty()
        );
        assert!(
            database
                .list_recent_successful_deployment_runs()
                .expect("hidden successful runs")
                .is_empty()
        );
        assert!(
            database
                .deployment_run(&active_id)
                .expect_err("refresh must be blocked")
                .contains("AD-ADOPT-101")
        );
        let pending_project = database.list_projects().expect("pending project").remove(0);
        assert!(pending_project.latest_run_id.is_none());
        assert_eq!(pending_project.active_run_count, 0);

        database
            .continue_existing_deployment(&project_path)
            .expect("continue managing");
        assert_eq!(
            database
                .list_deployment_runs(&project_path)
                .expect("visible runs")
                .len(),
            2
        );
        assert_eq!(
            database
                .list_project_versions(&project_path)
                .expect("backfilled versions")
                .len(),
            1
        );
        assert!(
            database
                .server_for_project(&project_path, "staging")
                .expect("visible server")
                .is_some()
        );
        assert_eq!(
            database
                .list_active_deployment_runs()
                .expect("visible active runs")
                .len(),
            1
        );
        assert_eq!(
            database
                .list_recent_successful_deployment_runs()
                .expect("visible successful runs")
                .len(),
            1
        );
        assert_eq!(
            database
                .list_projects()
                .expect("managed project")
                .remove(0)
                .latest_run_id
                .as_deref(),
            Some(active_id.as_str())
        );

        // The same storage gates also cover the short fresh-draft window,
        // even if a stale row somehow exists outside the public save API.
        {
            let connection = database.connection.lock().expect("database lock");
            connection
                .execute(
                    "UPDATE projects
                     SET deployment_adoption_mode = 'fresh', deployment_fresh_draft = 1
                     WHERE path = ?1",
                    [&normalized_path],
                )
                .expect("mark fresh draft");
        }
        assert!(
            database
                .list_deployment_runs(&project_path)
                .expect("fresh draft runs")
                .is_empty()
        );
        assert!(
            database
                .list_active_deployment_runs()
                .expect("fresh draft active runs")
                .is_empty()
        );
        assert!(
            database
                .server_for_project(&project_path, "staging")
                .expect("fresh draft server")
                .is_none()
        );
    }

    #[test]
    fn deployment_serial_lookup_is_scoped_to_project_path() {
        let directory = tempfile::tempdir().expect("temp dir");
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        fs::create_dir_all(&first).expect("create first project");
        fs::create_dir_all(&second).expect("create second project");
        let database =
            WorkspaceState::open(&directory.path().join("workspace.db")).expect("workspace");
        database
            .remember_project(&first, "first", true, 1)
            .expect("remember first");
        database
            .remember_project(&second, "second", true, 1)
            .expect("remember second");
        let mut run = database
            .create_deployment_run(&first, "first", "staging", "owner/shared", "main")
            .expect("create run");
        run.build_serial = Some("42".to_string());
        database.save_deployment_run(&run).expect("save serial");

        assert!(
            database
                .deployment_run_by_serial_for_project(&first, "owner/shared", "42")
                .expect("first lookup")
                .is_some()
        );
        assert!(
            database
                .deployment_run_by_serial_for_project(&second, "owner/shared", "42")
                .expect("second lookup")
                .is_none()
        );
    }
}
