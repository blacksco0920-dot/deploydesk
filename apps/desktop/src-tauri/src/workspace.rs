use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use deploy_core::providers::ssh::SshProfile;

pub struct WorkspaceState {
    connection: Mutex<Connection>,
}

const PROJECT_ID_FILE: &str = ".deploydesk/state/project-id";

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

impl WorkspaceState {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(public_storage_error)?;
        }
        let connection = Connection::open(path).map_err(public_storage_error)?;
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
                   PRIMARY KEY(project_path, environment, profile_kind),
                   FOREIGN KEY(profile_id) REFERENCES config_profiles(id)
                 );",
            )
            .map_err(public_storage_error)?;
        ensure_server_fingerprint_column(&connection)?;
        ensure_deployment_run_columns(&connection)?;
        ensure_config_profile_scope_column(&connection)?;
        ensure_project_storage_id_column(&connection)?;
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
        self.remember_project_with_identity(path, name, manifest_exists, service_count, None, None)
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
                   last_opened_at = excluded.last_opened_at",
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
        Ok(())
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
                     service_count = ?4, last_opened_at = ?5
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
                            AND d.status IN ('queued', 'running'))
                 FROM projects p
                 LEFT JOIN deployment_runs latest ON latest.id = (
                    SELECT d.id FROM deployment_runs d
                    WHERE d.project_path = p.path
                    ORDER BY d.started_at DESC LIMIT 1
                 )
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

    pub fn remove_project(&self, path: &Path) -> Result<bool, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let changed = connection
            .execute("DELETE FROM projects WHERE path = ?1", [normalized])
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
        if !matches!(environment, "development" | "staging" | "production") {
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
                 ON CONFLICT(project_path, environment, profile_kind) DO UPDATE SET
                   profile_id = excluded.profile_id,
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

    pub fn config_profile_bindings(
        &self,
        path: &Path,
        environment: &str,
    ) -> Result<Vec<ProjectProfileBinding>, String> {
        if !matches!(environment, "development" | "staging" | "production") {
            return Err("项目环境名称不正确".to_string());
        }
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT environment, profile_kind, profile_id
                 FROM project_profile_bindings
                 WHERE project_path = ?1 AND environment = ?2
                 ORDER BY profile_kind",
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
        if !matches!(environment, "staging" | "production") {
            return Err("只能创建测试或生产部署".to_string());
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
            action_kind: None,
            action_url: None,
            issue_code: None,
            repository: repository.to_string(),
            branch: branch.to_string(),
            message: "正在请求 CNB 开始构建".to_string(),
            completed_steps: vec!["write-config".to_string()],
            started_at: now.clone(),
            updated_at: now,
        };
        self.save_deployment_run(&run)?;
        Ok(run)
    }

    pub fn save_deployment_run(&self, run: &DeploymentRun) -> Result<(), String> {
        if !valid_run_status(&run.status) {
            return Err("部署运行状态不正确".to_string());
        }
        let completed_steps =
            serde_json::to_string(&run.completed_steps).map_err(public_storage_error)?;
        let artifacts = serde_json::to_string(&run.artifacts).map_err(public_storage_error)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
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
        Ok(())
    }

    pub fn deployment_run(&self, id: &str) -> Result<DeploymentRun, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
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
            .ok_or_else(|| "找不到这次部署记录".to_string())
    }

    pub fn deployment_run_by_serial(
        &self,
        repository: &str,
        serial: &str,
    ) -> Result<Option<DeploymentRun>, String> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .query_row(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_title, source_run_id,
                        candidate_tag, artifacts, action_kind, action_url,
                        issue_code, repository, branch, message, completed_steps,
                        started_at, updated_at
                 FROM deployment_runs
                 WHERE repository = ?1 AND build_serial = ?2
                 LIMIT 1",
                params![repository, serial],
                deployment_run_from_row,
            )
            .optional()
            .map_err(public_storage_error)
    }

    pub fn successful_staging_run_by_revision(
        &self,
        path: &Path,
        revision: &str,
    ) -> Result<Option<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
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
            .map_err(public_storage_error)
    }

    pub fn list_deployment_runs(&self, path: &Path) -> Result<Vec<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
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
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
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
                 ORDER BY updated_at DESC
                 LIMIT 100",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], deployment_run_from_row)
            .map_err(public_storage_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
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
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
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
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(public_storage_error)
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
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection.execute(sql, []).map_err(public_storage_error)?;
        }
    }
    Ok(())
}

fn public_storage_error(error: impl std::fmt::Display) -> String {
    format!("无法更新本机项目记录：{error}")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use deploy_core::providers::ssh::SshProfile;
    use rusqlite::Connection;

    use super::{
        ConfigProfile, DeploymentArtifact, WorkspaceState, encode_uri_component, project_storage_id,
    };

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
}
