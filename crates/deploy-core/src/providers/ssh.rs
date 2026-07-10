use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use russh::{ChannelMsg, Disconnect};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_fingerprint: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshHostIdentity {
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCommandOutput {
    pub exit_status: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone)]
struct HostKeyVerifier {
    expected: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
    observed_public_key: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }
        if let Ok(public_key) = key.to_openssh()
            && let Ok(mut observed) = self.observed_public_key.lock()
        {
            *observed = Some(public_key);
        }
        Ok(self
            .expected
            .as_deref()
            .is_none_or(|expected| expected == fingerprint))
    }
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

pub async fn check_connection(profile: &SshProfile) -> Result<ProviderCheck> {
    if !profile.key_path.is_file() {
        return Ok(ProviderCheck {
            provider: "ssh".to_string(),
            ok: false,
            summary: "SSH 私钥文件不存在".to_string(),
            details: vec!["重新选择本机私钥文件".to_string()],
        });
    }
    let identity = match probe_host_identity(profile).await {
        Ok(identity) => identity,
        Err(error) => {
            return Ok(failed_check(
                "ssh",
                format!("服务器 {} 无法连接", profile.name),
                &error.to_string(),
            ));
        }
    };
    if let Some(check) = host_key_gate(profile, &identity.fingerprint) {
        return Ok(check);
    }

    let output = match execute(profile, "true", None, Duration::from_secs(20)).await {
        Ok(output) => output,
        Err(error) => {
            return Ok(failed_check(
                "ssh",
                format!("服务器 {} 无法连接", profile.name),
                &error.to_string(),
            ));
        }
    };
    if output.exit_status == Some(0) {
        return Ok(ProviderCheck {
            provider: "ssh".to_string(),
            ok: true,
            summary: format!("服务器 {} 连接正常", profile.name),
            details: vec![format!(
                "已验证服务器身份 {}，未执行远程写操作",
                identity.fingerprint
            )],
        });
    }
    Ok(failed_check(
        "ssh",
        format!("服务器 {} 无法连接", profile.name),
        &output.stderr,
    ))
}

pub async fn execute(
    profile: &SshProfile,
    command: &str,
    input: Option<&[u8]>,
    command_timeout: Duration,
) -> Result<RemoteCommandOutput> {
    let expected = profile.host_fingerprint.as_deref().ok_or_else(|| {
        DeployError::MissingCredential("请先确认目标服务器的 SSH 身份指纹".to_string())
    })?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let verifier = HostKeyVerifier {
        expected: Some(expected.to_string()),
        observed_fingerprint: Arc::clone(&observed_fingerprint),
        observed_public_key: Arc::new(Mutex::new(None)),
    };
    let config = Arc::new(client_config());
    let connect = client::connect(config, (profile.host.as_str(), profile.port), verifier);
    let mut session = match tokio::time::timeout(Duration::from_secs(12), connect).await {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            let actual = observed_fingerprint
                .lock()
                .ok()
                .and_then(|value| value.clone());
            if actual.as_deref().is_some_and(|actual| actual != expected) {
                return Err(DeployError::MissingCredential(
                    "服务器身份指纹已变化，已阻止连接".to_string(),
                ));
            }
            return Err(ssh_error("connect", &error));
        }
        Err(_) => {
            return Err(DeployError::Command {
                command: "ssh connect".to_string(),
                message: "连接超时，请检查服务器地址、安全组和 SSH 端口".to_string(),
            });
        }
    };

    let key_pair = load_secret_key(&profile.key_path, None).map_err(|error| {
        DeployError::MissingCredential(format!(
            "无法读取 SSH 私钥，请确认格式且未设置口令：{}",
            redact_text(&error.to_string())
        ))
    })?;
    let rsa_hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|error| ssh_error("negotiate key", &error))?
        .flatten();
    let authentication = session
        .authenticate_publickey(
            profile.user.clone(),
            PrivateKeyWithHashAlg::new(Arc::new(key_pair), rsa_hash),
        )
        .await
        .map_err(|error| ssh_error("authenticate", &error))?;
    if !authentication.success() {
        return Err(DeployError::MissingCredential(
            "服务器未接受这把 SSH 公钥，请先将公钥添加到服务器".to_string(),
        ));
    }

    let run = run_remote_command(&session, command, input);
    let output = tokio::time::timeout(command_timeout, run)
        .await
        .map_err(|_| DeployError::Command {
            command: "ssh command".to_string(),
            message: "远程操作超时，执行结果未知，请先检查服务器状态".to_string(),
        })??;
    session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await
        .map_err(|error| ssh_error("disconnect", &error))?;
    Ok(output)
}

pub async fn probe_host_identity(profile: &SshProfile) -> Result<SshHostIdentity> {
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let observed_public_key = Arc::new(Mutex::new(None));
    let verifier = HostKeyVerifier {
        expected: None,
        observed_fingerprint: Arc::clone(&observed_fingerprint),
        observed_public_key: Arc::clone(&observed_public_key),
    };
    let connect = client::connect(
        Arc::new(client_config()),
        (profile.host.as_str(), profile.port),
        verifier,
    );
    let session = tokio::time::timeout(Duration::from_secs(12), connect)
        .await
        .map_err(|_| DeployError::Command {
            command: "ssh fingerprint".to_string(),
            message: "连接超时，请检查服务器地址、安全组和 SSH 端口".to_string(),
        })?
        .map_err(|error| ssh_error("fingerprint", &error))?;
    session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await
        .map_err(|error| ssh_error("disconnect", &error))?;
    let fingerprint = observed_fingerprint
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .ok_or_else(|| DeployError::Command {
            command: "ssh fingerprint".to_string(),
            message: "服务器没有返回可验证的身份指纹".to_string(),
        })?;
    let public_key = observed_public_key
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .ok_or_else(|| DeployError::Command {
            command: "ssh fingerprint".to_string(),
            message: "服务器没有返回可保存的主机公钥".to_string(),
        })?;
    Ok(SshHostIdentity {
        fingerprint,
        public_key,
    })
}

fn host_key_gate(profile: &SshProfile, observed: &str) -> Option<ProviderCheck> {
    match profile.host_fingerprint.as_deref() {
        None => Some(ProviderCheck {
            provider: "ssh-host-key".to_string(),
            ok: false,
            summary: "请确认这台服务器的身份指纹".to_string(),
            details: vec![observed.to_string()],
        }),
        Some(expected) if expected != observed => Some(ProviderCheck {
            provider: "ssh-host-key-mismatch".to_string(),
            ok: false,
            summary: "服务器身份发生变化，已阻止连接".to_string(),
            details: vec![
                format!("已保存：{expected}"),
                format!("本次发现：{observed}"),
            ],
        }),
        Some(_) => None,
    }
}

fn client_config() -> client::Config {
    client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    }
}

async fn run_remote_command(
    session: &client::Handle<HostKeyVerifier>,
    command: &str,
    input: Option<&[u8]>,
) -> Result<RemoteCommandOutput> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| ssh_error("open channel", &error))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| ssh_error("execute", &error))?;
    if let Some(input) = input {
        channel
            .data_bytes(input.to_vec())
            .await
            .map_err(|error| ssh_error("send input", &error))?;
    }
    channel
        .eof()
        .await
        .map_err(|error| ssh_error("close input", &error))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => append_limited(&mut stdout, &data),
            ChannelMsg::ExtendedData { data, .. } => append_limited(&mut stderr, &data),
            ChannelMsg::ExitStatus {
                exit_status: status,
            } => exit_status = Some(status),
            _ => {}
        }
    }
    Ok(RemoteCommandOutput {
        exit_status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

fn append_limited(target: &mut Vec<u8>, data: &[u8]) {
    const OUTPUT_LIMIT: usize = 512 * 1024;
    let remaining = OUTPUT_LIMIT.saturating_sub(target.len());
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

fn failed_check(provider: &str, summary: String, message: &str) -> ProviderCheck {
    let message = redact_text(message);
    ProviderCheck {
        provider: provider.to_string(),
        ok: false,
        summary,
        details: vec![
            message
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("SSH 验证失败")
                .to_string(),
        ],
    }
}

fn ssh_error(action: &str, error: &russh::Error) -> DeployError {
    DeployError::Command {
        command: format!("ssh {action}"),
        message: redact_text(&error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{SshProfile, discover_identities_in, generate_managed_identity_in, host_key_gate};
    use std::path::PathBuf;

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

    #[test]
    fn requires_confirmation_and_rejects_changed_host_keys() {
        let mut profile = SshProfile {
            name: "server".to_string(),
            host: "example.com".to_string(),
            user: "ubuntu".to_string(),
            port: 22,
            key_path: PathBuf::from("key"),
            host_fingerprint: None,
        };
        let first = host_key_gate(&profile, "SHA256:first").expect("confirmation required");
        assert_eq!(first.provider, "ssh-host-key");

        profile.host_fingerprint = Some("SHA256:first".to_string());
        assert!(host_key_gate(&profile, "SHA256:first").is_none());
        let changed = host_key_gate(&profile, "SHA256:changed").expect("mismatch");
        assert_eq!(changed.provider, "ssh-host-key-mismatch");
    }
}
