use std::time::Duration;

use crate::error::Result;
use crate::model::HealthcheckResult;

pub async fn check_http_health(
    url: &str,
    retries: u16,
    interval: Duration,
) -> Result<HealthcheckResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let attempts = retries.max(1);
    let mut last_status = None;
    let mut last_message = String::new();
    for attempt in 1..=attempts {
        match client.get(url).send().await {
            Ok(response) => {
                let status = response.status();
                last_status = Some(status.as_u16());
                if status.is_success() {
                    return Ok(HealthcheckResult {
                        url: url.to_string(),
                        healthy: true,
                        attempts: attempt,
                        status: last_status,
                        message: "服务健康".to_string(),
                    });
                }
                last_message = format!("HTTP 状态码 {}", status.as_u16());
            }
            Err(error) => {
                last_message = if error.is_timeout() {
                    "请求超时".to_string()
                } else if error.is_connect() {
                    "无法连接服务".to_string()
                } else {
                    "健康检查请求失败".to_string()
                };
            }
        }
        if attempt < attempts {
            tokio::time::sleep(interval).await;
        }
    }
    Ok(HealthcheckResult {
        url: url.to_string(),
        healthy: false,
        attempts,
        status: last_status,
        message: last_message,
    })
}
