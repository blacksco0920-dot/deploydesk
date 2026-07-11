use std::path::Path;
use std::process::Command;

use crate::error::{DeployError, Result};
use crate::model::ProviderCheck;
use crate::redact::redact_text;

pub fn check_engine() -> Result<ProviderCheck> {
    let output = Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DeployError::MissingCommand("docker".to_string())
            } else {
                DeployError::Command {
                    command: "docker info".to_string(),
                    message: error.to_string(),
                }
            }
        })?;
    Ok(ProviderCheck {
        provider: "docker".to_string(),
        ok: output.status.success(),
        summary: if output.status.success() {
            format!(
                "Docker Engine {} 可用",
                String::from_utf8_lossy(&output.stdout).trim()
            )
        } else {
            "Docker Engine 未启动".to_string()
        },
        details: if output.status.success() {
            Vec::new()
        } else {
            vec![redact_text(&String::from_utf8_lossy(&output.stderr))]
        },
        code: (!output.status.success()).then(|| "AD-LOC-101".to_string()),
        next_steps: if output.status.success() {
            Vec::new()
        } else {
            vec!["启动 Docker Desktop 或 Docker Engine 后重新检查".to_string()]
        },
        retryable: !output.status.success(),
    })
}

pub fn validate_compose(compose_file: &Path, env_file: Option<&Path>) -> Result<ProviderCheck> {
    let mut command = Command::new("docker");
    command.arg("compose");
    if let Some(env_file) = env_file {
        command.arg("--env-file").arg(env_file);
    }
    let output = command
        .arg("-f")
        .arg(compose_file)
        .arg("config")
        .arg("--quiet")
        .output()
        .map_err(|error| DeployError::Command {
            command: "docker compose config".to_string(),
            message: error.to_string(),
        })?;
    Ok(ProviderCheck {
        provider: "docker-compose".to_string(),
        ok: output.status.success(),
        summary: if output.status.success() {
            "Docker Compose 配置有效".to_string()
        } else {
            "Docker Compose 配置无效".to_string()
        },
        details: if output.status.success() {
            Vec::new()
        } else {
            vec![redact_text(&String::from_utf8_lossy(&output.stderr))]
        },
        code: (!output.status.success()).then(|| "AD-LOC-102".to_string()),
        next_steps: if output.status.success() {
            Vec::new()
        } else {
            vec!["检查 Compose 文件和环境配置后重新验证".to_string()]
        },
        retryable: !output.status.success(),
    })
}
