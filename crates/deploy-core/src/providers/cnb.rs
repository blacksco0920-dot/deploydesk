use std::fmt;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use serde_json::{Value, json};

use crate::error::{DeployError, Result};
use crate::redact::redact_text;

const DEFAULT_API_BASE: &str = "https://api.cnb.cool";

pub struct CnbClient {
    client: reqwest::Client,
    api_base: String,
    token: String,
}

impl fmt::Debug for CnbClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CnbClient")
            .field("api_base", &self.api_base)
            .field("token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl CnbClient {
    pub fn new(token: impl Into<String>) -> Result<Self> {
        Self::with_api_base(token, DEFAULT_API_BASE)
    }

    pub fn with_api_base(token: impl Into<String>, api_base: impl Into<String>) -> Result<Self> {
        let token = token.into();
        if token.trim().is_empty() {
            return Err(DeployError::MissingCredential("CNB_TOKEN".to_string()));
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent("DeployDesk/0.1")
                .build()?,
            api_base: api_base.into().trim_end_matches('/').to_string(),
            token,
        })
    }

    pub fn from_env() -> Result<Self> {
        let token = std::env::var("CNB_TOKEN")
            .map_err(|_| DeployError::MissingCredential("CNB_TOKEN".to_string()))?;
        let api_base =
            std::env::var("CNB_API_BASE").unwrap_or_else(|_| DEFAULT_API_BASE.to_string());
        Self::with_api_base(token, api_base)
    }

    pub async fn current_user(&self) -> Result<Value> {
        self.request(Method::GET, "/user", None).await
    }

    pub async fn repositories(&self, slug: &str) -> Result<Value> {
        let slug = encode_segment(slug);
        self.request(Method::GET, &format!("/{slug}/-/repos"), None)
            .await
    }

    pub async fn build_settings(&self, repository: &str) -> Result<Value> {
        let repository = encode_segment(repository);
        self.request(
            Method::GET,
            &format!("/{repository}/-/settings/cloud-native-build"),
            None,
        )
        .await
    }

    pub async fn enable_auto_trigger(&self, repository: &str) -> Result<Value> {
        let repository = encode_segment(repository);
        self.request(
            Method::PUT,
            &format!("/{repository}/-/settings/cloud-native-build"),
            Some(json!({
                "auto_trigger": true,
                "cron_auto_trigger": false,
                "forked_repo_auto_trigger": false
            })),
        )
        .await
    }

    pub async fn trigger_build(
        &self,
        repository: &str,
        branch: &str,
        event: &str,
        title: &str,
    ) -> Result<Value> {
        if !event.starts_with("api_trigger") {
            return Err(DeployError::InvalidManifest(
                "CNB API 事件必须以 api_trigger 开头".to_string(),
            ));
        }
        let repository = encode_segment(repository);
        self.request(
            Method::POST,
            &format!("/{repository}/-/build/start"),
            Some(json!({
                "branch": branch,
                "event": event,
                "title": title,
                "sync": "false"
            })),
        )
        .await
    }

    pub async fn recent_builds(&self, repository: &str, size: u16) -> Result<Value> {
        let repository = encode_segment(repository);
        self.request(
            Method::GET,
            &format!("/{repository}/-/build/logs?size={}", size.clamp(1, 50)),
            None,
        )
        .await
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.api_base, path))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.cnb.api+json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        let status = response.status();
        let raw = response.text().await?;
        if !status.is_success() {
            return Err(DeployError::CnbApi {
                status: status.as_u16(),
                message: permission_hint(status.as_u16(), &redact_text(&raw)),
            });
        }
        if raw.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&raw).map_err(|source| DeployError::Json {
            path: "CNB API response".into(),
            source,
        })
    }
}

fn encode_segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn permission_hint(status: u16, message: &str) -> String {
    if status != 403 {
        return message.to_string();
    }
    format!(
        "权限不足。读取设置需要 repo-manage:r，修改设置需要 repo-manage:rw，触发构建需要 repo-cnb-trigger:rw，创建仓库需要 group-resource:rw。原始信息: {message}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_token() {
        let client =
            CnbClient::with_api_base("very-secret-token", "http://localhost").expect("client");
        let debug = format!("{client:?}");
        assert!(!debug.contains("very-secret-token"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn repository_slug_is_fully_encoded() {
        assert_eq!(encode_segment("owner/repo"), "owner%2Frepo");
    }
}
