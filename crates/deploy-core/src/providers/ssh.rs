use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey, rand_core::OsRng};

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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct SshIdentity {
    pub name: String,
    pub path: PathBuf,
    pub source: String,
    pub fingerprint: Option<String>,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSshIdentity {
    pub identity: SshIdentity,
    pub public_key: String,
    pub created: bool,
}

const fn default_port() -> u16 {
    22
}

#[must_use]
pub fn discover_identities() -> Vec<SshIdentity> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    discover_identities_in(&home)
}

pub fn generate_managed_identity() -> Result<GeneratedSshIdentity> {
    let home = dirs::home_dir().ok_or_else(|| {
        DeployError::MissingCredential("无法确定当前用户目录，不能创建 SSH 身份".to_string())
    })?;
    generate_managed_identity_in(&home)
}

fn discover_identities_in(home: &Path) -> Vec<SshIdentity> {
    let ssh_directory = home.join(".ssh");
    let mut candidates = BTreeSet::new();
    for name in [
        "abcdeploy_ed25519",
        "id_ed25519",
        "id_ecdsa",
        "id_rsa",
        "id_dsa",
    ] {
        candidates.insert(ssh_directory.join(name));
    }

    let config_path = ssh_directory.join("config");
    if let Ok(config) = fs::read_to_string(config_path) {
        for line in config.lines() {
            let mut parts = line.split_whitespace();
            if parts
                .next()
                .is_some_and(|value| value.eq_ignore_ascii_case("IdentityFile"))
                && let Some(raw) = parts.next()
                && !raw.contains('%')
            {
                candidates.insert(expand_home(raw, home));
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&ssh_directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let extension = path.extension().and_then(|value| value.to_str());
            if path.is_file()
                && !extension.is_some_and(|value| value.eq_ignore_ascii_case("pub"))
                && (name.starts_with("id_")
                    || name.starts_with("abcdeploy_")
                    || extension.is_some_and(|value| value.eq_ignore_ascii_case("pem")))
            {
                candidates.insert(path);
            }
        }
    }

    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| identity_from_path(path, "本机 SSH 目录"))
        .collect()
}

fn generate_managed_identity_in(home: &Path) -> Result<GeneratedSshIdentity> {
    let ssh_directory = home.join(".ssh");
    fs::create_dir_all(&ssh_directory).map_err(|source| DeployError::WriteFile {
        path: ssh_directory.clone(),
        source,
    })?;
    let private_path = ssh_directory.join("abcdeploy_ed25519");
    let public_path = ssh_directory.join("abcdeploy_ed25519.pub");

    if private_path.is_file() && public_path.is_file() {
        let public_key =
            fs::read_to_string(&public_path).map_err(|source| DeployError::ReadFile {
                path: public_path,
                source,
            })?;
        return Ok(GeneratedSshIdentity {
            identity: identity_from_path(private_path, "ABCDeploy 专用身份"),
            public_key: public_key.trim().to_string(),
            created: false,
        });
    }
    if private_path.exists() || public_path.exists() {
        return Err(DeployError::MissingCredential(
            "ABCDeploy SSH 身份文件不完整，请在高级设置中修复或移除后重试".to_string(),
        ));
    }

    let private_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(|error| {
        DeployError::Command {
            command: "generate ssh identity".to_string(),
            message: error.to_string(),
        }
    })?;
    let encoded_private =
        private_key
            .to_openssh(LineEnding::LF)
            .map_err(|error| DeployError::Command {
                command: "encode ssh identity".to_string(),
                message: error.to_string(),
            })?;
    let public_key =
        private_key
            .public_key()
            .to_openssh()
            .map_err(|error| DeployError::Command {
                command: "encode ssh public key".to_string(),
                message: error.to_string(),
            })?;

    let mut private_options = OpenOptions::new();
    private_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        private_options.mode(0o600);
    }
    let mut private_file =
        private_options
            .open(&private_path)
            .map_err(|source| DeployError::WriteFile {
                path: private_path.clone(),
                source,
            })?;
    private_file
        .write_all(encoded_private.as_bytes())
        .map_err(|source| DeployError::WriteFile {
            path: private_path.clone(),
            source,
        })?;
    fs::write(&public_path, format!("{public_key} abcdeploy\n")).map_err(|source| {
        DeployError::WriteFile {
            path: public_path,
            source,
        }
    })?;

    Ok(GeneratedSshIdentity {
        identity: identity_from_path(private_path, "ABCDeploy 专用身份"),
        public_key: format!("{public_key} abcdeploy"),
        created: true,
    })
}

fn identity_from_path(path: PathBuf, source: &str) -> SshIdentity {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("SSH 身份")
        .to_string();
    let managed = name.starts_with("abcdeploy_");
    SshIdentity {
        fingerprint: public_key_fingerprint(&path),
        name,
        path,
        source: source.to_string(),
        managed,
    }
}

fn public_key_fingerprint(private_path: &Path) -> Option<String> {
    let public_path = PathBuf::from(format!("{}.pub", private_path.to_string_lossy()));
    let encoded = fs::read_to_string(public_path).ok()?;
    let public_key = PublicKey::from_openssh(encoded.trim()).ok()?;
    Some(public_key.fingerprint(HashAlg::Sha256).to_string())
}

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(relative);
    }
    PathBuf::from(value)
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

#[cfg(test)]
mod tests {
    use super::{discover_identities_in, generate_managed_identity_in};

    #[test]
    fn creates_and_rediscovers_a_managed_ed25519_identity() {
        let home = tempfile::tempdir().expect("temp home");
        let generated = generate_managed_identity_in(home.path()).expect("generate identity");
        assert!(generated.created);
        assert!(generated.public_key.starts_with("ssh-ed25519 "));
        assert!(generated.identity.path.is_file());
        assert!(generated.identity.managed);
        assert!(generated.identity.fingerprint.is_some());

        let reused = generate_managed_identity_in(home.path()).expect("reuse identity");
        assert!(!reused.created);
        assert_eq!(reused.public_key, generated.public_key);

        let identities = discover_identities_in(home.path());
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].path, generated.identity.path);
    }
}
