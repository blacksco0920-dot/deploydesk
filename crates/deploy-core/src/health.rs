use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use reqwest::header::{ACCEPT, LOCATION};
use serde::Deserialize;

use crate::error::Result;
use crate::model::{DnsProviderHint, HealthcheckResult, PublicRouteCheck, PublicRouteStatus};

#[derive(Debug, Deserialize)]
struct DnsJsonResponse {
    #[serde(rename = "Status", default)]
    status: u16,
    #[serde(rename = "Answer", default)]
    answers: Vec<DnsJsonAnswer>,
}

#[derive(Debug, Deserialize)]
struct DnsJsonAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
}

#[derive(Debug, PartialEq, Eq)]
enum AddressResolution {
    Resolved(HashSet<IpAddr>),
    NotFound,
    Unavailable,
}

#[derive(Debug, PartialEq, Eq)]
enum DnsQueryOutcome {
    Resolved(HashSet<IpAddr>),
    NoRecords,
    Unavailable,
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
    let mut route_addresses = match resolve_addresses(host).await {
        AddressResolution::Resolved(addresses) => addresses,
        AddressResolution::NotFound => {
            let record_type = dns_record_type(expected_target);
            return PublicRouteCheck {
                url,
                reachable: false,
                phase: "dns".to_string(),
                status: None,
                message: format!("{host} 尚未解析，请添加指向目标服务器的 {record_type} 记录"),
            };
        }
        AddressResolution::Unavailable => {
            return PublicRouteCheck {
                url,
                reachable: false,
                phase: "check".to_string(),
                status: None,
                message: format!(
                    "{host} 的 DNS 检查没有完成；请确认本机网络，恢复后系统会自动继续"
                ),
            };
        }
    };
    if let Some(expected_target) = expected_target
        && let AddressResolution::Resolved(target_addresses) =
            resolve_addresses(expected_target).await
    {
        if route_addresses.is_disjoint(&target_addresses) {
            return PublicRouteCheck {
                url,
                reachable: false,
                phase: "dns".to_string(),
                status: None,
                message: format!("{host} 已解析，但没有指向刚刚验证的目标服务器"),
            };
        }
        // When recursive resolvers briefly disagree after a DNS change, only
        // probe the address that belongs to the verified server. Otherwise a
        // stale resolver could make the HTTPS check hit the previous server.
        route_addresses.retain(|address| target_addresses.contains(address));
    }

    if let Some(message) =
        detect_cloud_domain_interception(host, route_path, &route_addresses).await
    {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "domain-policy".to_string(),
            status: None,
            message,
        };
    }

    // A failed HTTPS request cannot tell the user whether the server port is
    // unreachable or whether TLS/certificate setup failed after connecting.
    // Probe TCP 443 first so certificate retry is offered only when the
    // network path is actually open.
    if !uses_temporary_http && !tcp_port_open(&route_addresses, 443).await {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "tcp".to_string(),
            status: None,
            message: format!(
                "{host} 已解析，但无法连接服务器 443 端口；请确认安全组和防火墙已开放 443"
            ),
        };
    }

    let route_port = if uses_temporary_http { 80 } else { 443 };
    let route_socket_addresses = route_addresses
        .iter()
        .copied()
        .map(|address| SocketAddr::new(address, route_port))
        .collect::<Vec<_>>();
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .no_proxy()
        // Public DNS can already contain a newly-added record while the macOS
        // resolver still keeps a negative cache entry. Reuse the addresses we
        // just verified so HTTPS/SNI validation does not consult stale cache.
        .resolve_to_addrs(host, &route_socket_addresses)
        .build()
    else {
        return PublicRouteCheck {
            url,
            reachable: false,
            phase: "check".to_string(),
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
        Err(error) => {
            let phase = request_failure_phase(scheme, error.is_timeout(), error.is_connect());
            PublicRouteCheck {
                url,
                reachable: false,
                phase: phase.to_string(),
                status: None,
                message: if uses_temporary_http {
                    if error.is_timeout() {
                        format!("{host} 已解析，但 HTTP 检查超时；请稍后重新检查")
                    } else {
                        format!("{host} 已解析，但 HTTP 测试地址尚未就绪；请检查 Caddy 路由")
                    }
                } else if phase == "https" {
                    format!(
                        "{host} 的 443 端口已连通，但 TLS/HTTPS 尚未就绪；请稍候让 Caddy 申请证书"
                    )
                } else if error.is_timeout() {
                    format!("{host} 的 443 端口已连通，但 HTTPS 检查超时；请稍后重新检查")
                } else {
                    format!("{host} 的 HTTPS 检查被中断，请稍后重新检查")
                },
            }
        }
    }
}

fn request_failure_phase(scheme: &str, is_timeout: bool, is_connect: bool) -> &'static str {
    if scheme == "http" {
        "http"
    } else if !is_timeout && is_connect {
        // reqwest reports TLS negotiation and certificate failures as connect
        // errors. Timeouts are intentionally excluded because the TCP probe
        // already succeeded and a slow HTTP response is not evidence that a
        // certificate reload can help.
        "https"
    } else {
        "check"
    }
}

pub async fn check_public_route_status_for_target(
    host: &str,
    path: &str,
    expected_target: Option<&str>,
) -> PublicRouteStatus {
    let check = check_public_route_for_target(host, path, expected_target).await;
    PublicRouteStatus {
        host: host.to_string(),
        url: check.url,
        phase: check.phase,
        reachable: check.reachable,
        http_status: check.status,
        message: check.message,
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

async fn detect_cloud_domain_interception(
    host: &str,
    path: &str,
    addresses: &HashSet<IpAddr>,
) -> Option<String> {
    let socket_addresses = addresses
        .iter()
        .copied()
        .map(|address| SocketAddr::new(address, 80))
        .collect::<Vec<_>>();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &socket_addresses)
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

async fn resolve_addresses(host: &str) -> AddressResolution {
    if let Ok(address) = host.parse::<IpAddr>() {
        return AddressResolution::Resolved(HashSet::from([address]));
    }
    let (public, system) = tokio::join!(
        resolve_public_addresses(host),
        resolve_system_addresses(host)
    );
    select_address_resolution(public, system)
}

fn select_address_resolution(
    public: AddressResolution,
    system: Option<HashSet<IpAddr>>,
) -> AddressResolution {
    match (public, system) {
        (AddressResolution::Resolved(mut public), Some(system)) => {
            public.extend(system);
            AddressResolution::Resolved(public)
        }
        (AddressResolution::Resolved(public), None) => AddressResolution::Resolved(public),
        (_, Some(system)) => AddressResolution::Resolved(system),
        (AddressResolution::NotFound, None) => AddressResolution::NotFound,
        (AddressResolution::Unavailable, None) => AddressResolution::Unavailable,
    }
}

async fn resolve_public_addresses(host: &str) -> AddressResolution {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .no_proxy()
        .build()
    else {
        return AddressResolution::Unavailable;
    };
    let (doh_pub_a, doh_pub_aaaa, alidns_a, alidns_aaaa) = tokio::join!(
        query_public_dns(&client, "https://doh.pub/dns-query", host, "A"),
        query_public_dns(&client, "https://doh.pub/dns-query", host, "AAAA"),
        query_public_dns(&client, "https://dns.alidns.com/resolve", host, "A"),
        query_public_dns(&client, "https://dns.alidns.com/resolve", host, "AAAA"),
    );
    combine_dns_query_outcomes([doh_pub_a, doh_pub_aaaa, alidns_a, alidns_aaaa])
}

async fn query_public_dns(
    client: &reqwest::Client,
    endpoint: &str,
    host: &str,
    record_type: &str,
) -> DnsQueryOutcome {
    let Ok(mut endpoint) = url::Url::parse(endpoint) else {
        return DnsQueryOutcome::Unavailable;
    };
    endpoint
        .query_pairs_mut()
        .append_pair("name", host)
        .append_pair("type", record_type);
    let Ok(response) = client
        .get(endpoint)
        .header(ACCEPT, "application/dns-json")
        .send()
        .await
    else {
        return DnsQueryOutcome::Unavailable;
    };
    if !response.status().is_success() {
        return DnsQueryOutcome::Unavailable;
    }
    let Ok(payload) = response.json::<DnsJsonResponse>().await else {
        return DnsQueryOutcome::Unavailable;
    };
    dns_query_outcome(payload)
}

fn dns_query_outcome(payload: DnsJsonResponse) -> DnsQueryOutcome {
    if !matches!(payload.status, 0 | 3) {
        return DnsQueryOutcome::Unavailable;
    }
    let addresses = payload
        .answers
        .into_iter()
        .filter(|answer| matches!(answer.record_type, 1 | 28))
        .filter_map(|answer| answer.data.trim().parse::<IpAddr>().ok())
        .collect::<HashSet<_>>();
    if addresses.is_empty() {
        DnsQueryOutcome::NoRecords
    } else {
        DnsQueryOutcome::Resolved(addresses)
    }
}

fn combine_dns_query_outcomes(
    outcomes: impl IntoIterator<Item = DnsQueryOutcome>,
) -> AddressResolution {
    let mut addresses = HashSet::new();
    let mut received_dns_response = false;
    for outcome in outcomes {
        match outcome {
            DnsQueryOutcome::Resolved(resolved) => {
                received_dns_response = true;
                addresses.extend(resolved);
            }
            DnsQueryOutcome::NoRecords => received_dns_response = true,
            DnsQueryOutcome::Unavailable => {}
        }
    }
    if !addresses.is_empty() {
        AddressResolution::Resolved(addresses)
    } else if received_dns_response {
        AddressResolution::NotFound
    } else {
        AddressResolution::Unavailable
    }
}

async fn resolve_system_addresses(host: &str) -> Option<HashSet<IpAddr>> {
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

async fn tcp_port_open(addresses: &HashSet<IpAddr>, port: u16) -> bool {
    let socket_addresses = addresses
        .iter()
        .copied()
        .map(|address| SocketAddr::new(address, port))
        .collect::<Vec<_>>();
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || {
                socket_addresses.into_iter().any(|address| {
                    TcpStream::connect_timeout(&address, Duration::from_secs(3)).is_ok()
                })
            }),
        )
        .await,
        Ok(Ok(true))
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::net::{IpAddr, Ipv4Addr, TcpListener};

    use super::{
        AddressResolution, DnsJsonAnswer, DnsJsonResponse, DnsQueryOutcome,
        cloud_domain_policy_message, combine_dns_query_outcomes, dns_provider_for_nameservers,
        dns_query_outcome, dns_record_type, public_route_scheme, request_failure_phase,
        resolve_addresses, select_address_resolution, tcp_port_open,
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
        let AddressResolution::Resolved(addresses) = resolve_addresses("203.0.113.10").await else {
            panic!("literal target must resolve without DNS");
        };
        assert!(
            addresses
                .iter()
                .any(|address| address.to_string() == "203.0.113.10")
        );
    }

    #[test]
    fn accepts_public_dns_before_a_stale_system_cache_catches_up() {
        let public_address = "203.0.113.10".parse().expect("public address");
        assert_eq!(
            select_address_resolution(
                AddressResolution::Resolved(HashSet::from([public_address])),
                None,
            ),
            AddressResolution::Resolved(HashSet::from([public_address]))
        );
    }

    #[test]
    fn distinguishes_no_records_from_an_interrupted_dns_check() {
        assert_eq!(
            combine_dns_query_outcomes([DnsQueryOutcome::NoRecords, DnsQueryOutcome::Unavailable,]),
            AddressResolution::NotFound
        );
        assert_eq!(
            combine_dns_query_outcomes([
                DnsQueryOutcome::Unavailable,
                DnsQueryOutcome::Unavailable,
            ]),
            AddressResolution::Unavailable
        );
    }

    #[test]
    fn parses_ipv4_and_ipv6_answers_from_dns_json() {
        let outcome = dns_query_outcome(DnsJsonResponse {
            status: 0,
            answers: vec![
                DnsJsonAnswer {
                    record_type: 1,
                    data: "203.0.113.10".to_string(),
                },
                DnsJsonAnswer {
                    record_type: 28,
                    data: "2001:db8::10".to_string(),
                },
                DnsJsonAnswer {
                    record_type: 5,
                    data: "alias.example.com.".to_string(),
                },
            ],
        });
        let DnsQueryOutcome::Resolved(addresses) = outcome else {
            panic!("DNS response should contain addresses");
        };
        assert!(addresses.contains(&"203.0.113.10".parse().expect("IPv4 address")));
        assert!(addresses.contains(&"2001:db8::10".parse().expect("IPv6 address")));
    }

    #[tokio::test]
    async fn distinguishes_an_open_tcp_port_before_https() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test port");
        let port = listener.local_addr().expect("listener address").port();
        let addresses = HashSet::from([IpAddr::V4(Ipv4Addr::LOCALHOST)]);

        assert!(tcp_port_open(&addresses, port).await);
        drop(listener);
        assert!(!tcp_port_open(&addresses, port).await);
    }

    #[test]
    fn only_non_timeout_connect_errors_are_certificate_candidates() {
        assert_eq!(request_failure_phase("https", false, true), "https");
        assert_eq!(request_failure_phase("https", true, true), "check");
        assert_eq!(request_failure_phase("https", true, false), "check");
        assert_eq!(request_failure_phase("https", false, false), "check");
        assert_eq!(request_failure_phase("http", false, true), "http");
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
