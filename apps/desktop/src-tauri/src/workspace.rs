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
    pub source_run_id: Option<String>,
    pub action_kind: Option<String>,
    pub action_url: Option<String>,
    pub repository: String,
    pub branch: String,
    pub message: String,
    pub completed_steps: Vec<String>,
    pub started_at: String,
    pub updated_at: String,
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
                   source_run_id TEXT,
                   action_kind TEXT,
                   action_url TEXT,
                   repository TEXT NOT NULL,
                   branch TEXT NOT NULL,
                   message TEXT NOT NULL,
                   completed_steps TEXT NOT NULL,
                   started_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS deployment_runs_project
                   ON deployment_runs(project_path, started_at DESC);",
            )
            .map_err(public_storage_error)?;
        ensure_server_fingerprint_column(&connection)?;
        ensure_deployment_run_columns(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn remember_project(
        &self,
        path: &Path,
        name: &str,
        manifest_exists: bool,
        service_count: usize,
    ) -> Result<(), String> {
        let normalized = normalize_path(path);
        let id = project_id(&normalized);
        let now = Utc::now().to_rfc3339();
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO projects (
                   id, path, name, current_step, manifest_exists,
                   service_count, last_opened_at, created_at
                 ) VALUES (?1, ?2, ?3, 'inspection', ?4, ?5, ?6, ?6)
                 ON CONFLICT(path) DO UPDATE SET
                   name = excluded.name,
                   manifest_exists = excluded.manifest_exists,
                   service_count = excluded.service_count,
                   last_opened_at = excluded.last_opened_at",
                params![
                    id,
                    normalized,
                    name,
                    manifest_exists,
                    u32::try_from(service_count).unwrap_or(u32::MAX),
                    now
                ],
            )
            .map_err(public_storage_error)?;
        Ok(())
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
                "SELECT id, path, name, current_step, manifest_exists,
                        service_count, last_opened_at
                 FROM projects
                 ORDER BY last_opened_at DESC
                 LIMIT 50",
            )
            .map_err(public_storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let path: String = row.get(1)?;
                Ok(RecentProject {
                    id: row.get(0)?,
                    path_exists: Path::new(&path).is_dir(),
                    path,
                    name: row.get(2)?,
                    current_step: row.get(3)?,
                    manifest_exists: row.get(4)?,
                    service_count: row.get(5)?,
                    last_opened_at: row.get(6)?,
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
            source_run_id: None,
            action_kind: None,
            action_url: None,
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
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO deployment_runs (
                   id, project_path, project_name, environment, status,
                   current_stage, build_serial, commit_sha, source_run_id,
                   action_kind, action_url, repository, branch, message,
                   completed_steps, started_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status,
                   current_stage = excluded.current_stage,
                   build_serial = excluded.build_serial,
                   commit_sha = excluded.commit_sha,
                   source_run_id = excluded.source_run_id,
                   action_kind = excluded.action_kind,
                   action_url = excluded.action_url,
                   message = excluded.message,
                   completed_steps = excluded.completed_steps,
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
                    run.source_run_id,
                    run.action_kind,
                    run.action_url,
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
                        current_stage, build_serial, commit_sha, source_run_id,
                        action_kind, action_url, repository, branch, message,
                        completed_steps, started_at, updated_at
                 FROM deployment_runs WHERE id = ?1",
                [id],
                deployment_run_from_row,
            )
            .optional()
            .map_err(public_storage_error)?
            .ok_or_else(|| "找不到这次部署记录".to_string())
    }

    pub fn list_deployment_runs(&self, path: &Path) -> Result<Vec<DeploymentRun>, String> {
        let normalized = normalize_path(path);
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, project_path, project_name, environment, status,
                        current_stage, build_serial, commit_sha, source_run_id,
                        action_kind, action_url, repository, branch, message,
                        completed_steps, started_at, updated_at
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
    let completed_steps: String = row.get(14)?;
    Ok(DeploymentRun {
        id: row.get(0)?,
        project_path: row.get(1)?,
        project_name: row.get(2)?,
        environment: row.get(3)?,
        status: row.get(4)?,
        current_stage: row.get(5)?,
        build_serial: row.get(6)?,
        commit_sha: row.get(7)?,
        source_run_id: row.get(8)?,
        action_kind: row.get(9)?,
        action_url: row.get(10)?,
        repository: row.get(11)?,
        branch: row.get(12)?,
        message: row.get(13)?,
        completed_steps: serde_json::from_str(&completed_steps).unwrap_or_default(),
        started_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
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
            "action_kind",
            "ALTER TABLE deployment_runs ADD COLUMN action_kind TEXT",
        ),
        (
            "action_url",
            "ALTER TABLE deployment_runs ADD COLUMN action_url TEXT",
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
    use std::fs;

    use deploy_core::providers::ssh::SshProfile;
    use rusqlite::Connection;

    use super::WorkspaceState;

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
        run.updated_at = chrono::Utc::now().to_rfc3339();
        database.save_deployment_run(&run).expect("save run");
        let resumed = database.deployment_run(&run.id).expect("resume run");
        assert_eq!(resumed.build_serial.as_deref(), Some("42"));
        assert_eq!(resumed.current_stage, "build");
        assert_eq!(
            database
                .list_deployment_runs(directory.path())
                .expect("list runs")
                .len(),
            1
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
    }
}
