use std::process::Command;

use crate::model::{SystemPreflight, ToolStatus};

#[must_use]
pub fn system_preflight() -> SystemPreflight {
    let git = tool_status(
        "Git",
        "git",
        &["--version"],
        "读取和同步项目代码",
        "安装 Git 后重新检查",
    );
    let ssh = ToolStatus {
        name: "内置安全连接".to_string(),
        available: true,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        required_for: "安全连接目标服务器".to_string(),
        resolution: None,
    };
    let docker = docker_status();
    let node = tool_status(
        "Node.js",
        "node",
        &["--version"],
        "本地开发预览",
        "仅云端部署时可以暂不安装",
    );
    let ready_for_cloud_deploy = git.available;
    let ready_for_local_preview = ready_for_cloud_deploy && docker.available && node.available;
    SystemPreflight {
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        tools: vec![git, ssh, docker, node],
        ready_for_cloud_deploy,
        ready_for_local_preview,
    }
}

fn docker_status() -> ToolStatus {
    let version = Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output();
    match version {
        Ok(output) if output.status.success() => ToolStatus {
            name: "Docker".to_string(),
            available: true,
            version: nonempty_output(&output),
            required_for: "本地完整预览".to_string(),
            resolution: None,
        },
        Ok(_) => ToolStatus {
            name: "Docker".to_string(),
            available: false,
            version: None,
            required_for: "本地完整预览".to_string(),
            resolution: Some("启动 Docker Desktop，云端部署不受影响".to_string()),
        },
        Err(_) => ToolStatus {
            name: "Docker".to_string(),
            available: false,
            version: None,
            required_for: "本地完整预览".to_string(),
            resolution: Some("安装 Docker Desktop 或 Docker Engine".to_string()),
        },
    }
}

fn tool_status(
    name: &str,
    command: &str,
    arguments: &[&str],
    required_for: &str,
    resolution: &str,
) -> ToolStatus {
    match Command::new(command).args(arguments).output() {
        Ok(output) if output.status.success() => ToolStatus {
            name: name.to_string(),
            available: true,
            version: nonempty_output(&output),
            required_for: required_for.to_string(),
            resolution: None,
        },
        _ => ToolStatus {
            name: name.to_string(),
            available: false,
            version: None,
            required_for: required_for.to_string(),
            resolution: Some(resolution.to_string()),
        },
    }
}

fn nonempty_output(output: &std::process::Output) -> Option<String> {
    let value = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    value
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_never_exposes_environment_values() {
        let result = system_preflight();
        let json = serde_json::to_string(&result).expect("serialize");
        assert!(!json.contains("CNB_TOKEN"));
        assert!(!json.contains("TCR_PASSWORD"));
    }
}
