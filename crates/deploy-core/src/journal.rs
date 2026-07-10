use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{DeployError, Result};
use crate::model::{EnvironmentName, RecoveryPlan, ReleaseRecord, ReleaseStatus};

pub struct DeploymentJournal {
    path: PathBuf,
}

impl DeploymentJournal {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn for_project(project: &str) -> Result<Self> {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("deploydesk/history");
        fs::create_dir_all(&base).map_err(|source| DeployError::WriteFile {
            path: base.clone(),
            source,
        })?;
        Ok(Self::new(base.join(format!("{project}.jsonl"))))
    }

    pub fn append(&self, record: &ReleaseRecord) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|source| DeployError::WriteFile {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let serialized = serde_json::to_string(record).map_err(|source| DeployError::Json {
            path: self.path.clone(),
            source,
        })?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|source| DeployError::WriteFile {
                path: self.path.clone(),
                source,
            })?;
        writeln!(file, "{serialized}").map_err(|source| DeployError::WriteFile {
            path: self.path.clone(),
            source,
        })?;
        Ok(())
    }

    pub fn records(&self) -> Result<Vec<ReleaseRecord>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path).map_err(|source| DeployError::ReadFile {
            path: self.path.clone(),
            source,
        })?;
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line).map_err(|source| DeployError::Json {
                    path: self.path.clone(),
                    source,
                })
            })
            .collect()
    }

    pub fn recovery_plan(&self, failed_release: &str) -> Result<RecoveryPlan> {
        let records = self.records()?;
        let failed = records
            .iter()
            .rev()
            .find(|record| record.id == failed_release)
            .ok_or_else(|| DeployError::MissingRelease(failed_release.to_string()))?;
        let resume_from = next_step(&failed.completed_steps).map(ToString::to_string);
        let rollback_release = records
            .iter()
            .rev()
            .find(|record| {
                record.project == failed.project
                    && record.environment == failed.environment
                    && record.status == ReleaseStatus::Healthy
                    && record.id != failed.id
            })
            .cloned();
        Ok(RecoveryPlan {
            failed_release: failed.id.clone(),
            resume_from,
            completed_steps: failed.completed_steps.clone(),
            rollback_release,
        })
    }

    pub fn latest_healthy(&self, environment: EnvironmentName) -> Result<Option<ReleaseRecord>> {
        Ok(self.records()?.into_iter().rev().find(|record| {
            record.environment == environment && record.status == ReleaseStatus::Healthy
        }))
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn next_step(completed: &[String]) -> Option<&'static str> {
    [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
        "promote-release",
        "healthcheck",
    ]
    .into_iter()
    .find(|step| !completed.iter().any(|completed| completed == step))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tempfile::tempdir;

    use super::*;

    fn record(id: &str, status: ReleaseStatus, completed_steps: &[&str]) -> ReleaseRecord {
        ReleaseRecord {
            id: id.to_string(),
            project: "sample".to_string(),
            environment: EnvironmentName::Production,
            image_digest: format!("sha256:{id}"),
            status,
            created_at: Utc::now(),
            previous_release: None,
            completed_steps: completed_steps.iter().map(ToString::to_string).collect(),
            failure: None,
        }
    }

    #[test]
    fn proposes_resume_step_and_last_healthy_rollback() {
        let directory = tempdir().expect("tempdir");
        let journal = DeploymentJournal::new(directory.path().join("history.jsonl"));
        journal
            .append(&record("healthy", ReleaseStatus::Healthy, &["healthcheck"]))
            .expect("append healthy");
        journal
            .append(&record(
                "failed",
                ReleaseStatus::Failed,
                &["write-config", "verify-build"],
            ))
            .expect("append failed");
        let recovery = journal.recovery_plan("failed").expect("recovery");
        assert_eq!(recovery.resume_from.as_deref(), Some("publish-images"));
        assert_eq!(
            recovery
                .rollback_release
                .as_ref()
                .map(|item| item.id.as_str()),
            Some("healthy")
        );
    }
}
