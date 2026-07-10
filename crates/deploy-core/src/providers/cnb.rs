use std::fmt;
use std::time::Duration;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

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

impl Drop for CnbClient {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

impl CnbClient {
    pub fn new(token: impl Into<String>) -> Result<Self> {
        Self::with_api_base(token, DEFAULT_API_BASE)
    }

    pub fn with_api_base(token: impl Into<String>, api_base: impl Into<String>) -> Result<Self> {
        let mut provided = token.into();
        let token = Zeroizing::new(provided.trim().to_string());
        provided.zeroize();
        if token.is_empty() {
            return Err(DeployError::MissingCredential("CNB_TOKEN".to_string()));
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent("DeployDesk/0.1")
                .timeout(Duration::from_secs(30))
                .build()?,
            api_base: api_base.into().trim_end_matches('/').to_string(),
            token: token.to_string(),
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

    pub async fn create_repository(
        &self,
        slug: &str,
        name: &str,
        description: &str,
        private: bool,
    ) -> Result<Value> {
        let slug = slug.trim();
        let name = name.trim();
        if slug.is_empty() || slug.chars().any(char::is_control) {
            return Err(DeployError::InvalidManifest(
                "CNB 组织或用户名不能为空".to_string(),
            ));
        }
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name.chars().any(char::is_control)
        {
            return Err(DeployError::InvalidManifest(
                "CNB 仓库名格式不正确".to_string(),
            ));
        }
        let slug = encode_segment(slug);
        self.request(
            Method::POST,
            &format!("/{slug}/-/repos"),
            Some(json!({
                "name": name,
                "description": description.trim(),
                "visibility": if private { "private" } else { "public" }
            })),
        )
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
    use std::io::{Read, Write};
    use std::net::TcpListener;

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

    #[tokio::test]
    async fn rejects_unsafe_repository_names_before_network_access() {
        let client = CnbClient::with_api_base("test-token", "http://127.0.0.1:1").expect("client");
        let error = client
            .create_repository("owner", "nested/repo", "", true)
            .await
            .expect_err("unsafe name must fail");
        assert!(error.to_string().contains("仓库名格式不正确"));
    }

    #[tokio::test]
    async fn creates_a_private_repository_with_the_documented_api_shape() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set timeout");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = stream.read(&mut chunk).expect("read request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request_is_complete(&request) {
                    break;
                }
            }

            let response_body = r#"{"id":"repository-id"}"#;
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            String::from_utf8(request).expect("request is UTF-8")
        });

        let client =
            CnbClient::with_api_base("test-token", format!("http://{address}")).expect("client");
        let result = client
            .create_repository("owner", "project", "部署项目", true)
            .await
            .expect("create repository");
        assert_eq!(result["id"], "repository-id");

        let request = server.join().expect("test server thread");
        let (headers, body) = request.split_once("\r\n\r\n").expect("HTTP request");
        assert!(headers.starts_with("POST /owner/-/repos HTTP/1.1"));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer test-token")
        );
        assert_eq!(
            serde_json::from_str::<Value>(body).expect("JSON body"),
            json!({
                "name": "project",
                "description": "部署项目",
                "visibility": "private"
            })
        );
    }

    fn request_is_complete(request: &[u8]) -> bool {
        let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let body_start = header_end + 4;
        let headers = String::from_utf8_lossy(&request[..body_start]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        request.len() >= body_start + content_length
    }
}
