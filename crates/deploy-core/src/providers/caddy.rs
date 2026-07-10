use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{DeployError, Result};
use crate::model::ProviderCheck;
use crate::providers::ssh::SshProfile;
use crate::redact::redact_text;

const SERVER_BOOTSTRAP: &str = include_str!("../../../../scripts/server-bootstrap.sh");

pub fn validate_caddyfile(path: &Path) -> Result<ProviderCheck> {
    let output = if command_exists("caddy") {
        Command::new("caddy")
            .arg("validate")
            .arg("--config")
            .arg(path)
            .arg("--adapter")
            .arg("caddyfile")
            .output()
    } else {
        let mount = format!("{}:/etc/caddy/Caddyfile:ro", path.to_string_lossy());
        Command::new("docker")
            .args([
                "run",
                "--rm",
                "-v",
                &mount,
                "caddy:2-alpine",
                "caddy",
                "validate",
                "--config",
                "/etc/caddy/Caddyfile",
                "--adapter",
                "caddyfile",
            ])
            .output()
    }
    .map_err(|error| DeployError::Command {
        command: "caddy validate".to_string(),
        message: error.to_string(),
    })?;
    Ok(ProviderCheck {
        provider: "caddy".to_string(),
        ok: output.status.success(),
        summary: if output.status.success() {
            "Caddy 配置有效".to_string()
        } else {
            "Caddy 配置无效".to_string()
        },
        details: if output.status.success() {
            Vec::new()
        } else {
            vec![redact_text(&String::from_utf8_lossy(&output.stderr))]
        },
    })
}

pub fn bootstrap_server(profile: &SshProfile, confirmed: bool) -> Result<ProviderCheck> {
    if !confirmed {
        return Err(DeployError::Command {
            command: "caddy bootstrap".to_string(),
            message: "初始化服务器 Caddy 前必须明确确认".to_string(),
        });
    }
    if !profile.key_path.is_file() {
        return Ok(ProviderCheck {
            provider: "caddy".to_string(),
            ok: false,
            summary: "SSH 私钥文件不存在".to_string(),
            details: vec!["重新选择本机私钥文件".to_string()],
        });
    }
    let destination = format!("{}@{}", profile.user, profile.host);
    let mut child = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=12",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-p",
            &profile.port.to_string(),
            "-i",
        ])
        .arg(&profile.key_path)
        .arg(destination)
        .args(["bash", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| DeployError::Command {
            command: "ssh caddy bootstrap".to_string(),
            message: error.to_string(),
        })?;
    child
        .stdin
        .take()
        .ok_or_else(|| DeployError::Command {
            command: "ssh caddy bootstrap".to_string(),
            message: "无法写入远程初始化脚本".to_string(),
        })?
        .write_all(SERVER_BOOTSTRAP.as_bytes())
        .map_err(|error| DeployError::Command {
            command: "ssh caddy bootstrap".to_string(),
            message: error.to_string(),
        })?;
    let output = child
        .wait_with_output()
        .map_err(|error| DeployError::Command {
            command: "ssh caddy bootstrap".to_string(),
            message: error.to_string(),
        })?;
    if output.status.success() {
        return Ok(ProviderCheck {
            provider: "caddy".to_string(),
            ok: true,
            summary: format!("服务器 {} 的 DeployDesk Caddy 已就绪", profile.name),
            details: vec!["已创建 ~/.deploydesk，未修改其他反向代理配置".to_string()],
        });
    }
    let message = redact_text(&String::from_utf8_lossy(&output.stderr));
    Ok(ProviderCheck {
        provider: "caddy".to_string(),
        ok: false,
        summary: format!("服务器 {} 初始化未完成", profile.name),
        details: vec![
            message
                .lines()
                .next()
                .unwrap_or("远程初始化失败")
                .to_string(),
        ],
    })
}

fn command_exists(command: &str) -> bool {
    Command::new(command)
        .arg("version")
        .output()
        .is_ok_and(|output| output.status.success())
}
