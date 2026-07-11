use std::fmt;
use std::time::Duration;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{DeployError, Result};
use crate::redact::redact_text;

const DEFAULT_API_BASE: &str = "https://api.cnb.cool";
const MAX_RUNNER_LOG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct CnbBuildStatus {
    pub status: String,
    pub active_stages: Vec<String>,
    pub error_stages: Vec<String>,
    pub pipeline_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CnbBuildRecord {
    pub serial: String,
    pub event: String,
    pub status: String,
    pub revision: Option<String>,
    pub source_ref: Option<String>,
    pub title: String,
    pub created_at: Option<String>,
}

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
                .user_agent("ABCDeploy/0.1")
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

    pub async fn user_groups(&self) -> Result<Value> {
        self.request(Method::GET, "/user/groups?page=1&page_size=100", None)
            .await
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
        self.trigger_build_at_revision(repository, branch, event, title, None)
            .await
    }

    pub async fn trigger_build_at_revision(
        &self,
        repository: &str,
        branch: &str,
        event: &str,
        title: &str,
        revision: Option<&str>,
    ) -> Result<Value> {
        if !event.starts_with("api_trigger") {
            return Err(DeployError::InvalidManifest(
                "CNB API 事件必须以 api_trigger 开头".to_string(),
            ));
        }
        if revision.is_some_and(|value| !valid_revision(value)) {
            return Err(DeployError::InvalidManifest(
                "CNB 构建提交标识格式不正确".to_string(),
            ));
        }
        let repository = encode_segment(repository);
        let mut body = json!({
            "branch": branch,
            "event": event,
            "title": title,
            "sync": "false"
        });
        if let Some(revision) = revision {
            body["sha"] = Value::String(revision.to_string());
        }
        self.request(
            Method::POST,
            &format!("/{repository}/-/build/start"),
            Some(body),
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

    pub async fn build_status(&self, repository: &str, serial: &str) -> Result<Value> {
        let repository = encode_segment(repository);
        let serial = encode_segment(serial);
        self.request(
            Method::GET,
            &format!("/{repository}/-/build/status/{serial}"),
            None,
        )
        .await
    }

    pub async fn runner_log(&self, repository: &str, pipeline_id: &str) -> Result<String> {
        let repository = encode_segment(repository);
        let pipeline_id = encode_segment(pipeline_id);
        let response = self
            .client
            .get(format!(
                "{}/{repository}/-/build/runner/download/log/{pipeline_id}",
                self.api_base
            ))
            .bearer_auth(&self.token)
            .header("Accept", "text/plain")
            .send()
            .await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            return Err(DeployError::CnbApi {
                status: status.as_u16(),
                message: permission_hint(
                    status.as_u16(),
                    &redact_text(&String::from_utf8_lossy(&bytes)),
                ),
            });
        }
        let start = bytes.len().saturating_sub(MAX_RUNNER_LOG_BYTES);
        Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
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

#[must_use]
pub fn build_serial(value: &Value) -> Option<String> {
    [
        value.get("sn"),
        value.get("buildSn"),
        value.pointer("/data/sn"),
        value.pointer("/data/buildSn"),
    ]
    .into_iter()
    .flatten()
    .find_map(value_as_string)
}

#[must_use]
pub fn build_revision(value: &Value) -> Option<String> {
    [
        "/sha",
        "/commit",
        "/commitSha",
        "/data/sha",
        "/data/commit",
        "/build/sha",
        "/git/sha",
    ]
    .into_iter()
    .filter_map(|path| value.pointer(path).and_then(Value::as_str))
    .map(str::trim)
    .find(|value| valid_revision(value))
    .map(ToString::to_string)
}

#[must_use]
pub fn summarize_build_status(value: &Value) -> CnbBuildStatus {
    let mut active_stages = Vec::new();
    let mut error_stages = Vec::new();
    let mut pipeline_ids = Vec::new();
    if let Some(pipelines) = value.get("pipelinesStatus").and_then(Value::as_object) {
        for (pipeline_id, pipeline) in pipelines {
            pipeline_ids.push(pipeline_id.clone());
            if let Some(stages) = pipeline.get("stages").and_then(Value::as_array) {
                for stage in stages {
                    let status = stage.get("status").and_then(Value::as_str).unwrap_or("");
                    let name = stage
                        .get("name")
                        .or_else(|| stage.get("id"))
                        .and_then(value_as_string)
                        .unwrap_or_else(|| "未知阶段".to_string());
                    if matches!(status, "start" | "running") {
                        active_stages.push(name);
                    } else if matches!(status, "error" | "failed") {
                        error_stages.push(name);
                    }
                }
            }
        }
    }
    pipeline_ids.sort();
    pipeline_ids.dedup();
    CnbBuildStatus {
        status: value
            .get("status")
            .and_then(value_as_string)
            .unwrap_or_else(|| "unknown".to_string()),
        active_stages,
        error_stages,
        pipeline_ids,
    }
}

#[must_use]
pub fn build_records(value: &Value) -> Vec<CnbBuildRecord> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|record| {
            let serial = record.get("sn").and_then(value_as_string)?;
            let event = record
                .get("event")
                .and_then(value_as_string)
                .unwrap_or_default();
            let status = record
                .get("status")
                .and_then(value_as_string)
                .unwrap_or_else(|| "unknown".to_string());
            let revision = record
                .get("sha")
                .and_then(Value::as_str)
                .filter(|value| valid_revision(value))
                .map(ToString::to_string);
            Some(CnbBuildRecord {
                serial,
                event,
                status,
                revision,
                source_ref: record
                    .get("sourceRef")
                    .and_then(value_as_string)
                    .filter(|value| !value.trim().is_empty()),
                title: record
                    .get("title")
                    .and_then(value_as_string)
                    .unwrap_or_default(),
                created_at: record
                    .get("createTime")
                    .and_then(value_as_string)
                    .filter(|value| !value.trim().is_empty()),
            })
        })
        .collect()
}

fn value_as_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| value.as_u64().map(|number| number.to_string()))
}

fn encode_segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn valid_revision(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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

    #[test]
    fn summarizes_build_responses_without_exposing_unrelated_fields() {
        let payload = json!({
            "sn": 42,
            "status": "running",
            "pipelinesStatus": {
                "pipeline-1": {
                    "stages": [
                        {"name": "构建镜像", "status": "running"},
                        {"name": "健康检查", "status": "waiting"}
                    ]
                }
            },
            "token": "must-not-be-copied"
        });
        assert_eq!(build_serial(&payload).as_deref(), Some("42"));
        assert!(build_revision(&payload).is_none());
        let summary = summarize_build_status(&payload);
        assert_eq!(summary.status, "running");
        assert_eq!(summary.active_stages, ["构建镜像"]);
        assert_eq!(summary.pipeline_ids, ["pipeline-1"]);
    }

    #[test]
    fn extracts_only_valid_git_revisions() {
        let revision = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            build_revision(&json!({"data": {"sha": revision}})).as_deref(),
            Some(revision)
        );
        assert!(build_revision(&json!({"sha": "../../main"})).is_none());
    }

    #[test]
    fn extracts_only_safe_build_history_fields() {
        let records = build_records(&json!({
            "data": [{
                "sn": "cnb-123",
                "event": "tag_deploy.production",
                "status": "success",
                "sha": "0123456789abcdef0123456789abcdef01234567",
                "sourceRef": "deploydesk-0123456789abcdef",
                "title": "发布正式环境",
                "createTime": "2026-07-11T00:00:00Z",
                "token": "must-not-be-copied"
            }]
        }));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].event, "tag_deploy.production");
        assert_eq!(records[0].serial, "cnb-123");
        let serialized = serde_json::to_string(&records).expect("serialize records");
        assert!(!serialized.contains("must-not-be-copied"));
    }

    #[tokio::test]
    async fn rejects_unsafe_build_revisions_before_network_access() {
        let client = CnbClient::with_api_base("test-token", "http://127.0.0.1:1").expect("client");
        let error = client
            .trigger_build_at_revision(
                "owner/repo",
                "main",
                "api_trigger_production",
                "production",
                Some("main; echo unsafe"),
            )
            .await
            .expect_err("unsafe revision must fail");
        assert!(error.to_string().contains("提交标识格式不正确"));
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
    async fn lists_current_users_organizations_with_the_documented_endpoint() {
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

            let response_body = r#"[{"path":"team","access_role":"Owner"}]"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            String::from_utf8(request).expect("request is UTF-8")
        });

        let client =
            CnbClient::with_api_base("test-token", format!("http://{address}")).expect("client");
        let groups = client.user_groups().await.expect("list organizations");
        assert_eq!(groups[0]["path"], "team");

        let request = server.join().expect("test server thread");
        assert!(request.starts_with("GET /user/groups?page=1&page_size=100 HTTP/1.1"));
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
