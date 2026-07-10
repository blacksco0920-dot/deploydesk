use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum DeployError {
    #[error("无法读取文件 {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("无法写入文件 {path}: {source}")]
    WriteFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("JSON 解析失败 ({path}): {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("YAML 解析失败 ({path}): {source}")]
    Yaml {
        path: PathBuf,
        source: serde_yaml_ng::Error,
    },
    #[error("部署配置校验失败: {0}")]
    InvalidManifest(String),
    #[error("项目目录不存在: {0}")]
    MissingProject(PathBuf),
    #[error("外部命令不可用: {0}")]
    MissingCommand(String),
    #[error("缺少凭据: {0}")]
    MissingCredential(String),
    #[error("外部命令执行失败: {command}: {message}")]
    Command { command: String, message: String },
    #[error("网络请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("CNB API 请求失败 ({status}): {message}")]
    CnbApi { status: u16, message: String },
    #[error("敏感信息不能写入部署配置: {0}")]
    SecretLeak(String),
    #[error("找不到部署记录: {0}")]
    MissingRelease(String),
}

pub type Result<T> = std::result::Result<T, DeployError>;
