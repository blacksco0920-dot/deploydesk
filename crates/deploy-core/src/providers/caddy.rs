use std::path::Path;
use std::time::Duration;

use crate::error::{DeployError, Result};
use crate::model::ProviderCheck;
use crate::providers::ssh::SshProfile;
use crate::redact::redact_text;
use crate::system_command;

const SERVER_BOOTSTRAP: &str = include_str!("../../../../scripts/server-bootstrap.sh");

pub fn validate_caddyfile(path: &Path) -> Result<ProviderCheck> {
    let output = if command_exists("caddy") {
        system_command("caddy")
            .arg("validate")
            .arg("--config")
            .arg(path)
            .arg("--adapter")
            .arg("caddyfile")
            .output()
    } else {
        let mount = format!("{}:/etc/caddy/Caddyfile:ro", path.to_string_lossy());
        system_command("docker")
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
        code: (!output.status.success()).then(|| "AD-SRV-204".to_string()),
        next_steps: if output.status.success() {
            Vec::new()
        } else {
            vec!["修复 Caddyfile 后重新验证".to_string()]
        },
        retryable: !output.status.success(),
    })
}

pub async fn bootstrap_server(profile: &SshProfile, confirmed: bool) -> Result<ProviderCheck> {
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
            code: Some("AD-SSH-101".to_string()),
            next_steps: vec!["返回服务器连接步骤，重新选择或生成 SSH 私钥".to_string()],
            retryable: true,
        });
    }
    let output = crate::providers::ssh::execute(
        profile,
        "bash -s",
        Some(SERVER_BOOTSTRAP.as_bytes()),
        Duration::from_mins(10),
    )
    .await?;
    if output.exit_status == Some(0) {
        let docker_installed = output
            .stdout
            .lines()
            .any(|line| line.trim() == "ABCDEPLOY_DOCKER_SETUP=installed");
        let reused = output
            .stdout
            .lines()
            .any(|line| line.trim() == "ABCDEPLOY_CADDY_MODE=reused");
        let container =
            marker_value(&output.stdout, "ABCDEPLOY_CADDY_CONTAINER").unwrap_or("deploydesk-caddy");
        return Ok(ProviderCheck {
            provider: "caddy".to_string(),
            ok: true,
            summary: if reused {
                format!("已复用服务器现有的统一 Caddy：{container}")
            } else if docker_installed {
                format!("已自动初始化服务器 {} 并启动统一 Caddy", profile.name)
            } else {
                format!("服务器 {} 的 ABCDeploy Caddy 已就绪", profile.name)
            },
            details: vec![
                if docker_installed {
                    "已安装并启动 Docker Engine 与 Compose 插件".to_string()
                } else {
                    "已复用服务器现有 Docker 运行环境".to_string()
                },
                if reused {
                    "只使用独立路由目录，不改写现有主 Caddyfile".to_string()
                } else {
                    "已准备统一运行目录，未修改其他反向代理配置".to_string()
                },
            ],
            code: None,
            next_steps: Vec::new(),
            retryable: false,
        });
    }
    let message = redact_text(&output.stderr);
    let code = marker_value(&message, "ABCDEPLOY_ERROR_CODE")
        .unwrap_or("AD-SRV-299")
        .to_string();
    let summary = marker_value(&message, "ABCDEPLOY_ERROR_MESSAGE").map_or_else(
        || format!("服务器 {} 初始化未完成", profile.name),
        ToString::to_string,
    );
    let next_step = marker_value(&message, "ABCDEPLOY_ERROR_NEXT_STEP")
        .unwrap_or("展开技术详情检查服务器日志，然后重新检查")
        .to_string();
    let details = message
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty() && !line.starts_with("ABCDEPLOY_ERROR_")
        })
        .take(3)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    Ok(ProviderCheck {
        provider: "caddy".to_string(),
        ok: false,
        summary,
        details,
        code: Some(code),
        next_steps: vec![next_step],
        retryable: true,
    })
}

fn marker_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    text.lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .filter(|value| !value.is_empty())
}

fn command_exists(command: &str) -> bool {
    system_command(command)
        .arg("version")
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(test)]
mod tests {
    use super::{SERVER_BOOTSTRAP, marker_value};

    #[test]
    fn extracts_stable_bootstrap_error_markers() {
        let output = "docker failed\nABCDEPLOY_ERROR_CODE=AD-SRV-202\nABCDEPLOY_ERROR_MESSAGE=已有 Caddy 不兼容\nABCDEPLOY_ERROR_NEXT_STEP=挂载路由目录\n";
        assert_eq!(
            marker_value(output, "ABCDEPLOY_ERROR_CODE"),
            Some("AD-SRV-202")
        );
        assert_eq!(
            marker_value(output, "ABCDEPLOY_ERROR_NEXT_STEP"),
            Some("挂载路由目录")
        );
    }

    #[test]
    fn empty_ubuntu_servers_are_initialized_without_user_commands() {
        assert!(SERVER_BOOTSTRAP.contains("download.docker.com/linux/$distribution"));
        assert!(SERVER_BOOTSTRAP.contains("docker-compose-plugin"));
        assert!(SERVER_BOOTSTRAP.contains("systemctl enable --now docker"));
        assert!(SERVER_BOOTSTRAP.contains("ABCDEPLOY_DOCKER_SETUP=installed"));
        assert!(SERVER_BOOTSTRAP.contains("AD-SRV-104"));
        assert!(SERVER_BOOTSTRAP.contains("mirror.ccs.tencentyun.com/library/caddy@"));
        assert!(SERVER_BOOTSTRAP.contains("m.daocloud.io/docker.io/library/caddy@"));
        assert!(SERVER_BOOTSTRAP.contains("http://127.0.0.1"));
        assert!(SERVER_BOOTSTRAP.contains("systemctl disable --now caddy"));
        assert!(SERVER_BOOTSTRAP.contains("AD-SRV-212"));
    }
}
