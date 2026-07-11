use std::collections::HashSet;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use crate::error::Result;
use crate::model::{HealthcheckResult, PublicRouteCheck};

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

pub async fn check_public_route(host: &str, path: &str) -> PublicRouteCheck {
    check_public_route_for_target(host, path, None).await
}

pub async fn check_public_route_for_target(
    host: &str,
    path: &str,
    expected_target: Option<&str>,
) -> PublicRouteCheck {
    let route_path = if path.starts_with('/') { path } else { "/" };
    let url = format!("https://{host}{route_path}");
    let Some(route_addresses) = resolve_addresses(host).await else {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "dns".to_string(),
            status: None,
            message: format!("{host} 尚未解析，请添加指向目标服务器的 A 或 AAAA 记录"),
        };
    };
    if let Some(expected_target) = expected_target
        && let Some(target_addresses) = resolve_addresses(expected_target).await
        && route_addresses.is_disjoint(&target_addresses)
    {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "dns".to_string(),
            status: None,
            message: format!("{host} 已解析，但没有指向刚刚验证的目标服务器"),
        };
    }

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
    else {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "https".to_string(),
            status: None,
            message: "无法创建 HTTPS 检查，请稍后重试".to_string(),
        };
    };
    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            if status < 500 {
                PublicRouteCheck {
                    url,
                    reachable: true,
                    phase: "ready".to_string(),
                    status: Some(status),
                    message: format!("{host} 的 DNS、HTTPS 和 Caddy 路由均可访问"),
                }
            } else {
                PublicRouteCheck {
                    url,
                    reachable: false,
                    phase: "application".to_string(),
                    status: Some(status),
                    message: format!(
                        "{host} 已连通，但返回 HTTP {status}；请检查 Caddy 路由和应用日志"
                    ),
                }
            }
        }
        Err(error) => PublicRouteCheck {
            url,
            reachable: false,
            phase: "https".to_string(),
            status: None,
            message: if error.is_timeout() {
                format!("{host} 已解析，但 HTTPS 连接超时；请确认服务器开放 443 端口")
            } else {
                format!(
                    "{host} 已解析，但 HTTPS 尚未就绪；请稍候让 Caddy 申请证书并确认 443 端口开放"
                )
            },
        },
    }
}

async fn resolve_addresses(host: &str) -> Option<HashSet<IpAddr>> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Some(HashSet::from([address]));
    }
    let lookup_host = host.to_string();
    match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            (lookup_host.as_str(), 443)
                .to_socket_addrs()
                .map(|addresses| {
                    addresses
                        .map(|address| address.ip())
                        .collect::<HashSet<_>>()
                })
        }),
    )
    .await
    {
        Ok(Ok(Ok(addresses))) if !addresses.is_empty() => Some(addresses),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_addresses;

    #[tokio::test]
    async fn parses_literal_target_addresses_without_dns() {
        let addresses = resolve_addresses("42.193.229.35")
            .await
            .expect("literal address");
        assert!(
            addresses
                .iter()
                .any(|address| address.to_string() == "42.193.229.35")
        );
    }
}
