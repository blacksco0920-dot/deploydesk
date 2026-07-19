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
use zeroize::Zeroizing;

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

const AUTHORIZED_KEYS_INSTALL_COMMAND: &str = r#"set -eu
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
IFS= read -r key
case "$key" in ssh-*) ;; *) exit 64 ;; esac
grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '%s\n' "$key" >> "$HOME/.ssh/authorized_keys"
"#;

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

fn identity_public_key(private_path: &Path) -> Result<String> {
    let public_path = PathBuf::from(format!("{}.pub", private_path.to_string_lossy()));
    let encoded = if public_path.is_file() {
        fs::read_to_string(&public_path).map_err(|source| DeployError::ReadFile {
            path: public_path,
            source,
        })?
    } else {
        load_secret_key(private_path, None)
            .map_err(|error| {
                DeployError::MissingCredential(format!(
                    "无法读取 SSH 私钥以生成公钥：{}",
                    redact_text(&error.to_string())
                ))
            })?
            .public_key()
            .to_openssh()
            .map_err(|error| DeployError::Command {
                command: "encode ssh public key".to_string(),
                message: redact_text(&error.to_string()),
            })?
    };
    PublicKey::from_openssh(encoded.trim())
        .and_then(|key| key.to_openssh())
        .map_err(|error| {
            DeployError::MissingCredential(format!(
                "SSH 公钥格式不正确：{}",
                redact_text(&error.to_string())
            ))
        })
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
            code: Some("AD-SSH-101".to_string()),
            next_steps: vec!["返回服务器连接步骤，重新选择或生成 SSH 私钥".to_string()],
            retryable: true,
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
        Err(DeployError::MissingCredential(message))
            if message.contains("服务器未接受这把 SSH 公钥") =>
        {
            return Ok(ProviderCheck {
                provider: "ssh-key-install".to_string(),
                ok: false,
                summary: "服务器还不认识这台电脑".to_string(),
                details: vec!["SSH 公钥尚未安装到目标登录用户".to_string()],
                code: Some("AD-SSH-105".to_string()),
                next_steps: vec!["输入一次服务器登录密码，由 ABCDeploy 自动安装公钥".to_string()],
                retryable: true,
            });
        }
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
            code: None,
            next_steps: Vec::new(),
            retryable: false,
        });
    }
    Ok(failed_check(
        "ssh",
        format!("服务器 {} 无法连接", profile.name),
        &output.stderr,
    ))
}

pub async fn install_public_key_with_password(
    profile: &SshProfile,
    password: Zeroizing<String>,
) -> Result<ProviderCheck> {
    if password.is_empty() {
        return Ok(ProviderCheck {
            provider: "ssh-key-install".to_string(),
            ok: false,
            summary: "请填写服务器登录密码".to_string(),
            details: Vec::new(),
            code: Some("AD-SSH-105".to_string()),
            next_steps: vec!["填写云服务器当前登录用户的密码后重试".to_string()],
            retryable: true,
        });
    }
    let public_key = identity_public_key(&profile.key_path)?;
    let mut session = connect_verified(profile).await?;
    let authentication = session
        .authenticate_password(profile.user.clone(), password.as_str())
        .await
        .map_err(|error| ssh_error("authenticate password", &error))?;
    if !authentication.success() {
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
        return Ok(ProviderCheck {
            provider: "ssh-key-install".to_string(),
            ok: false,
            summary: "服务器没有接受这个登录密码".to_string(),
            details: vec!["未修改服务器，密码也没有保存".to_string()],
            code: Some("AD-SSH-105".to_string()),
            next_steps: vec!["确认登录用户和服务器密码是否正确，然后重试".to_string()],
            retryable: true,
        });
    }

    let input = format!("{public_key}\n");
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        run_remote_command(
            &session,
            AUTHORIZED_KEYS_INSTALL_COMMAND,
            Some(input.as_bytes()),
        ),
    )
    .await
    .map_err(|_| DeployError::Command {
        command: "ssh install public key".to_string(),
        message: "安装公钥超时，执行结果未知，请重新验证服务器连接".to_string(),
    })??;
    session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await
        .map_err(|error| ssh_error("disconnect", &error))?;
    if output.exit_status != Some(0) {
        return Ok(ProviderCheck {
            provider: "ssh-key-install".to_string(),
            ok: false,
            summary: "服务器没有完成安全身份安装".to_string(),
            details: vec![redact_text(&output.stderr)],
            code: Some("AD-SSH-106".to_string()),
            next_steps: vec!["确认登录用户有权写入自己的 .ssh 目录，然后重试".to_string()],
            retryable: true,
        });
    }

    let verification = check_connection(profile).await?;
    if verification.ok {
        return Ok(ProviderCheck {
            provider: "ssh".to_string(),
            ok: true,
            summary: format!("服务器 {} 已建立安全连接", profile.name),
            details: vec!["公钥已幂等安装；服务器密码未保存".to_string()],
            code: None,
            next_steps: Vec::new(),
            retryable: false,
        });
    }
    Ok(verification)
}

pub async fn execute(
    profile: &SshProfile,
    command: &str,
    input: Option<&[u8]>,
    command_timeout: Duration,
) -> Result<RemoteCommandOutput> {
    let mut session = connect_verified(profile).await?;

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

async fn connect_verified(profile: &SshProfile) -> Result<client::Handle<HostKeyVerifier>> {
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
    let session = match tokio::time::timeout(Duration::from_secs(12), connect).await {
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

    Ok(session)
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
            code: None,
            next_steps: Vec::new(),
            retryable: true,
        }),
        Some(expected) if expected != observed => Some(ProviderCheck {
            provider: "ssh-host-key-mismatch".to_string(),
            ok: false,
            summary: "服务器身份发生变化，已阻止连接".to_string(),
            details: vec![
                format!("已保存：{expected}"),
                format!("本次发现：{observed}"),
            ],
            code: Some("AD-SSH-103".to_string()),
            next_steps: vec!["确认服务器是否重装或更换；核实无误后重新建立信任".to_string()],
            retryable: false,
        }),
        Some(_) => None,
    }
}

fn client_config() -> client::Config {
    client::Config {
        // A valid remote command can be deliberately quiet for minutes while
        // Docker pulls or pushes a large image.  Treating that silence as an
        // inactive SSH session aborted healthy deployments after 15 seconds.
        // Every caller already owns a bounded command timeout, so keep the
        // transport alive and let that operation-specific timeout decide when
        // work is genuinely stuck.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 6,
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
        code: Some("AD-SSH-102".to_string()),
        next_steps: vec!["检查服务器地址、安全组、登录用户和 SSH 私钥后重试".to_string()],
        retryable: true,
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
    use super::{
        AUTHORIZED_KEYS_INSTALL_COMMAND, SshProfile, client_config, discover_identities_in,
        generate_managed_identity_in, host_key_gate, identity_public_key,
    };
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
        let public_key = identity_public_key(&generated.identity.path).expect("public key");
        assert!(public_key.starts_with("ssh-ed25519 "));
        assert!(!AUTHORIZED_KEYS_INSTALL_COMMAND.contains(&public_key));
    }

    #[test]
    fn keeps_long_silent_remote_commands_alive() {
        let config = client_config();
        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(
            config.keepalive_interval,
            Some(std::time::Duration::from_secs(10))
        );
        assert_eq!(config.keepalive_max, 6);
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
