use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
#[cfg(test)]
use rusqlite::OptionalExtension;
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

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
                   ON projects(last_opened_at DESC);",
            )
            .map_err(public_storage_error)?;
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

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "本机项目记录暂时不可用，请重新启动应用".to_string()
}

fn public_storage_error(error: impl std::fmt::Display) -> String {
    format!("无法更新本机项目记录：{error}")
}

#[cfg(test)]
mod tests {
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
    }
}
