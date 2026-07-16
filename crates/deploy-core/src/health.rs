use std::collections::HashSet;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use reqwest::header::{ACCEPT, LOCATION};
use serde::Deserialize;

use crate::error::Result;
use crate::model::{DnsProviderHint, HealthcheckResult, PublicRouteCheck};

#[derive(Debug, Deserialize)]
struct DnsJsonResponse {
    #[serde(rename = "Answer", default)]
    answers: Vec<DnsJsonAnswer>,
}

#[derive(Debug, Deserialize)]
struct DnsJsonAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
}

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
    let scheme = public_route_scheme(host);
    let uses_temporary_http = scheme == "http";
    let url = format!("{scheme}://{host}{route_path}");
    let Some(route_addresses) = resolve_addresses(host).await else {
        let record_type = dns_record_type(expected_target);
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "dns".to_string(),
            status: None,
            message: format!("{host} 尚未解析，请添加指向目标服务器的 {record_type} 记录"),
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

    if let Some(message) = detect_cloud_domain_interception(host, route_path).await {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "domain-policy".to_string(),
            status: None,
            message,
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
            phase: scheme.to_string(),
            status: None,
            message: format!("无法创建 {} 检查，请稍后重试", scheme.to_ascii_uppercase()),
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
                    message: format!(
                        "{host} 的 DNS、{} 和 Caddy 路由均可访问",
                        scheme.to_ascii_uppercase()
                    ),
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
            phase: scheme.to_string(),
            status: None,
            message: if error.is_timeout() {
                let port = if uses_temporary_http { 80 } else { 443 };
                format!(
                    "{host} 已解析，但 {} 连接超时；请确认服务器开放 {port} 端口",
                    scheme.to_ascii_uppercase()
                )
            } else if uses_temporary_http {
                format!("{host} 已解析，但 HTTP 测试地址尚未就绪；请检查 Caddy 路由")
            } else {
                format!(
                    "{host} 已解析，但 HTTPS 尚未就绪；请稍候让 Caddy 申请证书并确认 443 端口开放"
                )
            },
        },
    }
}

pub async fn detect_dns_provider(host: &str) -> Option<DnsProviderHint> {
    let normalized = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels = normalized.split('.').collect::<Vec<_>>();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    for index in 0..labels.len() - 1 {
        let zone = labels[index..].join(".");
        let response = client
            .get(format!("https://doh.pub/dns-query?name={zone}&type=NS"))
            .header(ACCEPT, "application/dns-json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let payload = response.json::<DnsJsonResponse>().await.ok()?;
        let mut name_servers = payload
            .answers
            .into_iter()
            .filter(|answer| answer.record_type == 2)
            .map(|answer| answer.data.trim_end_matches('.').to_ascii_lowercase())
            .filter(|answer| !answer.is_empty())
            .collect::<Vec<_>>();
        name_servers.sort();
        name_servers.dedup();
        if name_servers.is_empty() {
            continue;
        }
        let (provider, management_url) = dns_provider_for_nameservers(&name_servers);
        return Some(DnsProviderHint {
            zone,
            provider: provider.to_string(),
            management_url: management_url.map(str::to_string),
            name_servers,
        });
    }
    None
}

fn dns_provider_for_nameservers(name_servers: &[String]) -> (&'static str, Option<&'static str>) {
    let matches = |suffix: &str| {
        name_servers
            .iter()
            .any(|server| server == suffix || server.ends_with(&format!(".{suffix}")))
    };
    if matches("dnspod.net") || matches("dnspod.com") {
        return (
            "腾讯云 DNSPod",
            Some("https://console.cloud.tencent.com/cns"),
        );
    }
    if matches("alidns.com") {
        return ("阿里云云解析 DNS", Some("https://dns.console.aliyun.com/"));
    }
    if matches("cloudflare.com") {
        return ("Cloudflare", Some("https://dash.cloudflare.com/"));
    }
    if matches("huaweicloud-dns.com") {
        return (
            "华为云云解析服务",
            Some("https://console.huaweicloud.com/dns/"),
        );
    }
    ("当前域名服务商", None)
}

fn public_route_scheme(host: &str) -> &'static str {
    if host.to_ascii_lowercase().ends_with(".sslip.io") {
        "http"
    } else {
        "https"
    }
}

fn dns_record_type(expected_target: Option<&str>) -> &'static str {
    match expected_target.and_then(|target| target.parse::<IpAddr>().ok()) {
        Some(IpAddr::V4(_)) => "A",
        Some(IpAddr::V6(_)) => "AAAA",
        None => "A 或 AAAA",
    }
}

async fn detect_cloud_domain_interception(host: &str, path: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(format!("http://{host}{path}"))
        .send()
        .await
        .ok()?;
    let location = response.headers().get(LOCATION)?.to_str().ok()?;
    cloud_domain_policy_message(host, location)
}

fn cloud_domain_policy_message(host: &str, location: &str) -> Option<String> {
    let normalized = location.to_ascii_lowercase();
    (normalized.contains("dnspod.qcloud.com/static/webblock")
        || normalized.contains("qcloud.com/static/webblock"))
    .then(|| {
        format!("{host} 被云厂商的未备案域名策略拦截；应用已在服务器运行，请改用已备案的测试域名")
    })
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
    use super::{
        cloud_domain_policy_message, dns_provider_for_nameservers, dns_record_type,
        public_route_scheme, resolve_addresses,
    };

    #[test]
    fn maps_public_name_servers_to_their_management_console() {
        assert_eq!(
            dns_provider_for_nameservers(&["cricket.dnspod.net".to_string()]),
            (
                "腾讯云 DNSPod",
                Some("https://console.cloud.tencent.com/cns")
            )
        );
        assert_eq!(
            dns_provider_for_nameservers(&["ada.ns.cloudflare.com".to_string()]),
            ("Cloudflare", Some("https://dash.cloudflare.com/"))
        );
        assert_eq!(
            dns_provider_for_nameservers(&["ns.example.net".to_string()]),
            ("当前域名服务商", None)
        );
    }

    #[test]
    fn names_the_exact_dns_record_type_for_literal_server_addresses() {
        assert_eq!(dns_record_type(Some("203.0.113.10")), "A");
        assert_eq!(dns_record_type(Some("2001:db8::1")), "AAAA");
        assert_eq!(dns_record_type(Some("server.example.com")), "A 或 AAAA");
        assert_eq!(dns_record_type(None), "A 或 AAAA");
    }

    #[tokio::test]
    async fn parses_literal_target_addresses_without_dns() {
        let addresses = resolve_addresses("203.0.113.10")
            .await
            .expect("literal address");
        assert!(
            addresses
                .iter()
                .any(|address| address.to_string() == "203.0.113.10")
        );
    }

    #[test]
    fn recognizes_tencent_cloud_unfiled_domain_interception() {
        let message = cloud_domain_policy_message(
            "demo.42-193-229-35.sslip.io",
            "https://dnspod.qcloud.com/static/webblock.html?d=demo",
        )
        .expect("interception message");
        assert!(message.contains("未备案域名"));
        assert!(message.contains("已在服务器运行"));
        assert!(cloud_domain_policy_message("demo.example.com", "/login").is_none());
    }

    #[test]
    fn uses_http_only_for_generated_sslip_test_hosts() {
        assert_eq!(public_route_scheme("demo.42-193-229-35.sslip.io"), "http");
        assert_eq!(public_route_scheme("demo.example.com"), "https");
    }
}
