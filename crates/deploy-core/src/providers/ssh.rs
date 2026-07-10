use std::path::PathBuf;
use std::process::Command;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{DeployError, Result};
use crate::model::ProviderCheck;
use crate::redact::redact_text;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct SshProfile {
    pub name: String,
    pub host: String,
    pub user: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub key_path: PathBuf,
}

const fn default_port() -> u16 {
    22
}

pub fn check_connection(profile: &SshProfile) -> Result<ProviderCheck> {
    if !profile.key_path.is_file() {
        return Ok(ProviderCheck {
            provider: "ssh".to_string(),
            ok: false,
            summary: "SSH 私钥文件不存在".to_string(),
            details: vec!["重新选择本机私钥文件".to_string()],
        });
    }
    let destination = format!("{}@{}", profile.user, profile.host);
    let output = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-p",
            &profile.port.to_string(),
            "-i",
        ])
        .arg(&profile.key_path)
        .arg(destination)
        .arg("true")
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DeployError::MissingCommand("ssh".to_string())
            } else {
                DeployError::Command {
                    command: "ssh".to_string(),
                    message: error.to_string(),
                }
            }
        })?;
    if output.status.success() {
        return Ok(ProviderCheck {
            provider: "ssh".to_string(),
            ok: true,
            summary: format!("服务器 {} 连接正常", profile.name),
            details: vec!["未执行远程写操作".to_string()],
        });
    }
    let message = redact_text(&String::from_utf8_lossy(&output.stderr));
    Ok(ProviderCheck {
        provider: "ssh".to_string(),
        ok: false,
        summary: format!("服务器 {} 无法连接", profile.name),
        details: vec![message.lines().next().unwrap_or("SSH 验证失败").to_string()],
    })
}
