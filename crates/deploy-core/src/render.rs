use std::collections::BTreeMap;
use std::fmt::Write as _;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{DeployError, Result};
use crate::model::{
    EnvironmentConfig, EnvironmentName, ProductionMode, ProjectManifest, RegistryConfig,
    ServiceConfig, ServiceKind, SourceProvider,
};
use crate::providers::registry::RegistryProvider;
use crate::providers::{PipelineProviderAdapter, pipeline::CnbPipelineProvider};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedFile {
    pub path: String,
    pub content: String,
}

/// Files and server-side transaction used by one user-visible deployment
/// path. The path key is independent from legacy staging/production slots so
/// several targets for the same project can coexist on one or more servers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentPathBundle {
    pub compose: String,
    pub caddy: String,
    pub remote_directory: String,
    pub network: String,
    pub site_name: String,
    pub runtime_config_path: String,
    pub deploy_script: String,
    /// A separate, idempotent Caddy reconciliation for all public routes.
    /// Keeping this out of the application Compose transaction lets callers
    /// repair a half-finished deployment without pulling images, rerunning
    /// migrations, or recreating already healthy containers.
    pub route_activation_script: String,
}

#[derive(Debug, Serialize)]
struct ComposeFile {
    name: String,
    services: BTreeMap<String, ComposeService>,
    networks: BTreeMap<String, ComposeNetwork>,
}

#[derive(Debug, Serialize)]
struct ComposeService {
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    build: Option<ComposeBuild>,
    restart: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    env_file: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    extra_hosts: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ports: Vec<String>,
    environment: BTreeMap<String, String>,
    networks: BTreeMap<String, ComposeServiceNetwork>,
    labels: BTreeMap<String, String>,
    healthcheck: ComposeHealthcheck,
}

#[derive(Debug, Serialize)]
struct ComposeBuild {
    context: String,
    dockerfile: String,
}

#[derive(Debug, Serialize)]
struct ComposeServiceNetwork {
    aliases: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ComposeHealthcheck {
    test: Vec<String>,
    interval: String,
    timeout: String,
    retries: u16,
    start_period: String,
}

#[derive(Debug, Serialize)]
struct ComposeNetwork {
    external: bool,
    name: String,
}

#[derive(Debug, Serialize)]
struct RuntimeVariableSpec {
    name: String,
    source: String,
    required: bool,
    default: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum ReleaseChannel {
    Candidate,
    Verified,
}

pub fn render_project_files(manifest: &ProjectManifest) -> Result<Vec<GeneratedFile>> {
    let mut files = Vec::new();
    files.push(GeneratedFile {
        path: ".deploydesk/.gitignore".to_string(),
        content: "# ABCDeploy 本机状态，不上传到代码仓库。\nbackups/\nruntime/\nstate/\n"
            .to_string(),
    });
    for (name, environment) in manifest.environments.entries() {
        files.push(GeneratedFile {
            path: format!(".deploydesk/generated/{}/docker-compose.yml", name.as_str()),
            content: render_compose(manifest, name, environment)?,
        });
        files.push(GeneratedFile {
            path: format!(".deploydesk/generated/{}/.env.example", name.as_str()),
            content: render_env_example(manifest, name, environment),
        });
        files.push(GeneratedFile {
            path: format!(".deploydesk/generated/{}/Caddyfile", name.as_str()),
            content: render_caddy(manifest, name, environment),
        });
        if name != EnvironmentName::Development {
            files.push(GeneratedFile {
                path: format!(".deploydesk/generated/{}/secret.example.yml", name.as_str()),
                content: render_secret_example(manifest, name, environment)?,
            });
        }
    }
    files.push(GeneratedFile {
        path: ".cnb.yml".to_string(),
        content: render_cnb_pipeline(manifest)?,
    });
    let pipeline = CnbPipelineProvider;
    files.push(GeneratedFile {
        path: pipeline.deployment_config_path().to_string(),
        content: render_cnb_deployments()?,
    });
    if manifest.source.provider == SourceProvider::Github {
        files.push(GeneratedFile {
            path: ".github/workflows/sync-cnb.yml".to_string(),
            content: render_github_sync(manifest)?,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn render_deployment_path_bundle(
    manifest: &ProjectManifest,
    path_key: &str,
    routes: &[crate::model::DomainRoute],
) -> Result<DeploymentPathBundle> {
    if path_key.is_empty()
        || path_key.len() > 64
        || !path_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(DeployError::InvalidManifest(
            "部署线路标识格式不正确".to_string(),
        ));
    }
    for route in routes {
        if !manifest
            .services
            .iter()
            .any(|service| service.id == route.service)
        {
            return Err(DeployError::InvalidManifest(format!(
                "访问地址引用了不存在的服务 {}",
                route.service
            )));
        }
    }
    let target_key = format!("{}-{path_key}", manifest.project.name);
    let remote_directory = format!(
        ".deploydesk/apps/{}/paths/{path_key}",
        manifest.project.name
    );
    let network = format!("deploydesk-{target_key}");
    let site_name = format!("{target_key}.caddy");
    let runtime_config_path = format!(
        ".deploydesk/runtime-config/{}/paths/{path_key}.env",
        manifest.project.name
    );
    let compose = render_deployment_path_compose(
        manifest,
        path_key,
        &target_key,
        &network,
        &manifest.environments.production,
    )?;
    let caddy = render_deployment_path_caddy(manifest, path_key, routes);
    let root_routes = routes
        .iter()
        .filter(|route| route.path == "/")
        .cloned()
        .collect::<Vec<_>>();
    let deploy_script = remote_deploy_script_for_target(
        manifest,
        EnvironmentName::Production,
        &remote_directory,
        &network,
        &site_name,
        &runtime_config_path,
        // A deployment path reconciles every route in its own idempotent
        // transaction after the services are healthy. The Compose transaction
        // deliberately does not touch Caddy, so a transient route failure can
        // be retried without recreating the application.
        &[],
    );
    let root_caddy = render_deployment_path_caddy(manifest, path_key, &root_routes);
    let root_route_targets = root_routes
        .iter()
        .map(|route| {
            let service = manifest
                .services
                .iter()
                .find(|service| service.id == route.service)
                .ok_or_else(|| {
                    DeployError::InvalidManifest(format!(
                        "访问地址引用了不存在的服务 {}",
                        route.service
                    ))
                })?;
            Ok((
                route.host.clone(),
                format!(
                    "{}-{path_key}-{}:{}",
                    manifest.project.name, service.id, service.container_port
                ),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let root_activation =
        root_path_route_activation_script(&site_name, &network, &root_caddy, &root_route_targets);
    let shared_activation =
        shared_path_route_activation_script(manifest, path_key, &site_name, &network, routes)?;
    let route_activation_script = [root_activation, shared_activation]
        .into_iter()
        .filter(|script| !script.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(DeploymentPathBundle {
        compose,
        caddy,
        remote_directory,
        network,
        site_name,
        runtime_config_path,
        deploy_script,
        route_activation_script,
    })
}

fn render_deployment_path_compose(
    manifest: &ProjectManifest,
    path_key: &str,
    namespace: &str,
    network_name: &str,
    environment: &EnvironmentConfig,
) -> Result<String> {
    let uses_shared_infrastructure =
        environment.database.is_some() || environment.redis_namespace.is_some();
    let mut services = BTreeMap::new();
    for service in &manifest.services {
        let image_variable = image_variable(service);
        let mut labels = BTreeMap::new();
        labels.insert(
            "deploydesk.project".to_string(),
            manifest.project.name.clone(),
        );
        labels.insert("deploydesk.path".to_string(), path_key.to_string());
        labels.insert("deploydesk.service".to_string(), service.id.clone());
        let mut runtime = BTreeMap::from([
            ("DEPLOYDESK_ENV".to_string(), "deployment".to_string()),
            ("DEPLOYDESK_PATH".to_string(), path_key.to_string()),
        ]);
        for listen_variable in ["APP_PORT", "PORT"] {
            if service
                .runtime_env
                .iter()
                .any(|variable| variable.name == listen_variable)
            {
                runtime.insert(
                    listen_variable.to_string(),
                    service.container_port.to_string(),
                );
            }
        }
        if service
            .dockerfile
            .starts_with(".deploydesk/generated/build/Dockerfile.")
            && matches!(service.kind, ServiceKind::Static | ServiceKind::Web)
            && let Some(api) = manifest
                .services
                .iter()
                .find(|candidate| candidate.kind == ServiceKind::Api)
        {
            runtime.insert("API_HOST".to_string(), api.id.clone());
            runtime.insert("API_PORT".to_string(), api.container_port.to_string());
        }
        let health_command = service.healthcheck.command.clone().unwrap_or_else(|| {
            match service.kind {
                ServiceKind::Static => format!(
                    "wget -Y off -q --spider http://127.0.0.1:{}{}",
                    service.container_port, service.healthcheck.path
                ),
                ServiceKind::Api | ServiceKind::Web | ServiceKind::Worker => format!(
                    "node -e \"fetch('http://127.0.0.1:{}{}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"",
                    service.container_port, service.healthcheck.path
                ),
            }
        });
        let generated_caddy_runtime = service
            .dockerfile
            .starts_with(".deploydesk/generated/build/Dockerfile.")
            && health_command.starts_with("wget -Y off -q --spider ");
        let mut aliases = vec![
            format!("{}-{path_key}-{}", manifest.project.name, service.id),
            service.image.clone(),
        ];
        aliases.sort();
        aliases.dedup();
        let mut service_networks =
            BTreeMap::from([("apps".to_string(), ComposeServiceNetwork { aliases })]);
        if uses_shared_infrastructure {
            service_networks.insert(
                "infrastructure".to_string(),
                ComposeServiceNetwork {
                    aliases: Vec::new(),
                },
            );
        }
        services.insert(
            service.id.clone(),
            ComposeService {
                image: Some(format!("${{{image_variable}:?请填写不可变镜像地址}}")),
                build: None,
                restart: "unless-stopped".to_string(),
                env_file: if service.runtime_env.is_empty() {
                    Vec::new()
                } else {
                    vec![".runtime.env".to_string()]
                },
                extra_hosts: Vec::new(),
                ports: Vec::new(),
                environment: runtime,
                networks: service_networks,
                labels,
                healthcheck: ComposeHealthcheck {
                    test: vec!["CMD-SHELL".to_string(), health_command],
                    interval: if generated_caddy_runtime {
                        "2s".to_string()
                    } else {
                        format!("{}s", service.healthcheck.interval_seconds)
                    },
                    timeout: if generated_caddy_runtime {
                        "2s".to_string()
                    } else {
                        "5s".to_string()
                    },
                    retries: if generated_caddy_runtime {
                        15
                    } else {
                        service.healthcheck.retries
                    },
                    start_period: if generated_caddy_runtime {
                        "1s".to_string()
                    } else {
                        "20s".to_string()
                    },
                },
            },
        );
    }
    let mut networks = BTreeMap::from([(
        "apps".to_string(),
        ComposeNetwork {
            external: true,
            name: network_name.to_string(),
        },
    )]);
    if uses_shared_infrastructure {
        networks.insert(
            "infrastructure".to_string(),
            ComposeNetwork {
                external: true,
                name: "abcdeploy-infra".to_string(),
            },
        );
    }
    let compose = ComposeFile {
        name: namespace.to_string(),
        services,
        networks,
    };
    let mut content = serde_yaml_ng::to_string(&compose).map_err(|source| DeployError::Yaml {
        path: format!("generated/paths/{path_key}/docker-compose.yml").into(),
        source,
    })?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 生成。运行配置只保存在客户端密钥库和目标服务器。\n",
    );
    Ok(content)
}

fn render_deployment_path_caddy(
    manifest: &ProjectManifest,
    path_key: &str,
    routes: &[crate::model::DomainRoute],
) -> String {
    let mut lines = vec![format!(
        "# {} / {}，由 ABCDeploy 生成",
        manifest.project.name, path_key
    )];
    for route in routes.iter().filter(|route| route.path == "/") {
        let Some(service) = manifest
            .services
            .iter()
            .find(|service| service.id == route.service)
        else {
            continue;
        };
        let site_address = if is_temporary_test_host(&route.host) {
            format!("http://{}", route.host)
        } else {
            route.host.clone()
        };
        let alias = format!("{}-{path_key}-{}", manifest.project.name, service.id);
        lines.push(String::new());
        lines.push(format!("{site_address} {{"));
        lines.push(format!(
            "\treverse_proxy {alias}:{}",
            service.container_port
        ));
        lines.push("}".to_string());
    }
    lines.push(String::new());
    lines.join("\n")
}

fn shared_caddy_host_key(host: &str) -> String {
    let normalized = host
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())[..20].to_string()
}

fn root_path_route_activation_script(
    site_name: &str,
    network: &str,
    caddy: &str,
    route_targets: &[(String, String)],
) -> String {
    if route_targets.is_empty() {
        return String::new();
    }
    let hosts = route_targets
        .iter()
        .map(|(host, _)| host.clone())
        .collect::<Vec<_>>();
    let targets = route_targets
        .iter()
        .map(|(host, target)| format!("{host}\t{target}"))
        .collect::<Vec<_>>()
        .join("\n");
    let encoded_targets = BASE64.encode(format!("{targets}\n").as_bytes());
    let encoded_caddy = BASE64.encode(caddy.as_bytes());
    let partial_route_script = caddy_partial_route_activation_script(&hosts);
    format!(
        r#"# Reconcile root routes independently from the application deployment.
set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 900 9 || {{ echo '同一服务器已有部署任务，等待超时' >&2; exit 75; }}
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || printf 'deploydesk-caddy')"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || printf '%s' "$HOME/.deploydesk/caddy/sites")"
DEPLOYMENT_NETWORK={network}
SITE_FILE="$CADDY_SITE_DIRECTORY"/{site_name}
case "$CADDY_CONTAINER" in ''|*[!A-Za-z0-9_.-]*) echo 'AD-SRV-205：统一 Caddy 记录无效' >&2; exit 1 ;; esac
case "$CADDY_SITE_DIRECTORY" in /*) ;; *) echo 'AD-SRV-205：统一 Caddy 路由目录无效' >&2; exit 1 ;; esac
case "$DEPLOYMENT_NETWORK" in ''|*[!A-Za-z0-9_.-]*) echo 'AD-SRV-211：项目网络记录无效' >&2; exit 1 ;; esac
test -d "$CADDY_SITE_DIRECTORY" && test -w "$CADDY_SITE_DIRECTORY" || {{ echo 'AD-SRV-205：统一 Caddy 路由目录不可写' >&2; exit 1; }}
docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 || {{ echo 'AD-SRV-205：统一 Caddy 尚未启动' >&2; exit 1; }}
docker network inspect "$DEPLOYMENT_NETWORK" >/dev/null 2>&1 || {{ echo 'AD-SRV-204：项目运行网络不存在，请重新上线' >&2; exit 1; }}
if ! docker network inspect "$DEPLOYMENT_NETWORK" --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
  docker network connect "$DEPLOYMENT_NETWORK" "$CADDY_CONTAINER" || {{ echo 'AD-SRV-211：统一 Caddy 无法连接项目服务' >&2; exit 1; }}
fi
if ! docker network inspect "$DEPLOYMENT_NETWORK" --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
  echo 'AD-SRV-211：统一 Caddy 尚未连接项目服务' >&2
  exit 1
fi
ROUTE_WORK_DIR="$(mktemp -d "$HOME/.deploydesk/caddy/reconcile.XXXXXX")"
trap 'rm -rf "$ROUTE_WORK_DIR"' EXIT
printf '%s' {encoded_caddy} | base64 --decode >"$ROUTE_WORK_DIR/Caddyfile.next"
printf '%s' {encoded_targets} | base64 --decode >"$ROUTE_WORK_DIR/targets"
CANDIDATE_FILE="$ROUTE_WORK_DIR/Caddyfile.next"
FILTERED_SITE_FILE="$ROUTE_WORK_DIR/Caddyfile.filtered"
MAIN_CONFIG_FILE="$ROUTE_WORK_DIR/Caddyfile.main"
ROUTE_CONFLICTS_FILE="$ROUTE_WORK_DIR/conflicts"
FILTER_HOSTS_FILE="$ROUTE_WORK_DIR/filter-hosts"
{partial_route_script}
if [ -f "$SITE_FILE" ]; then cp "$SITE_FILE" "$ROUTE_WORK_DIR/site.original"; fi
restore_site() {{
  if [ -f "$ROUTE_WORK_DIR/site.original" ]; then cp "$ROUTE_WORK_DIR/site.original" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
}}
cp "$FILTERED_SITE_FILE" "$SITE_FILE"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$ROUTE_WORK_DIR/validate.log" 2>&1; then
  restore_site
  echo 'AD-SRV-209：访问地址配置校验失败，已恢复原路由' >&2
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >"$ROUTE_WORK_DIR/reload.log" 2>&1; then
  restore_site
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo 'AD-SRV-207：访问地址加载失败，已恢复原路由' >&2
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >"$ROUTE_WORK_DIR/active.json" 2>/dev/null; then
  restore_site
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo 'AD-SRV-209：无法确认访问地址是否生效，已恢复原路由' >&2
  exit 1
fi
while IFS="$(printf '\t')" read -r host expected; do
  [ -n "$host" ] || continue
  if awk -F '\t' -v host="$host" '$1 == host && $2 == "main" {{ found=1 }} END {{ exit found ? 0 : 1 }}' "$ROUTE_CONFLICTS_FILE"; then
    printf 'ROUTE_TAKEOVER_REQUIRED\t%s\n' "$host"
    continue
  fi
  if ! grep -Fq -- "$host" "$ROUTE_WORK_DIR/active.json" || ! grep -Fq -- "$expected" "$ROUTE_WORK_DIR/active.json"; then
    restore_site
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    echo "AD-SRV-209：统一 Caddy 尚未加载 $host 的项目路由，已恢复原配置" >&2
    exit 1
  fi
done <"$ROUTE_WORK_DIR/targets"
"#,
        network = shell_quote(network),
        site_name = shell_quote(site_name),
        encoded_caddy = shell_quote(&encoded_caddy),
        encoded_targets = shell_quote(&encoded_targets),
        partial_route_script = partial_route_script,
    )
}

fn shared_path_route_activation_script(
    manifest: &ProjectManifest,
    path_key: &str,
    site_name: &str,
    network: &str,
    routes: &[crate::model::DomainRoute],
) -> Result<String> {
    let mut grouped = BTreeMap::<String, Vec<&crate::model::DomainRoute>>::new();
    for route in routes.iter().filter(|route| route.path != "/") {
        grouped.entry(route.host.clone()).or_default().push(route);
    }
    if grouped.is_empty() {
        return Ok(String::new());
    }

    let mut records = String::new();
    for (host, host_routes) in grouped {
        let key = shared_caddy_host_key(&host);
        let mut fragment = vec![format!(
            "# {} / {}，由 ABCDeploy 生成",
            manifest.project.name, path_key
        )];
        let mut paths = Vec::new();
        for route in host_routes {
            let service = manifest
                .services
                .iter()
                .find(|service| service.id == route.service)
                .ok_or_else(|| {
                    DeployError::InvalidManifest(format!(
                        "访问地址引用了不存在的服务 {}",
                        route.service
                    ))
                })?;
            let alias = format!("{}-{path_key}-{}", manifest.project.name, service.id);
            fragment.push(format!("# ABCDEPLOY_ROUTE {}", route.path));
            fragment.push(format!("handle_path {}* {{", route.path));
            fragment.push(format!(
                "\treverse_proxy {alias}:{}",
                service.container_port
            ));
            fragment.push("}".to_string());
            fragment.push(String::new());
            paths.push(route.path.clone());
        }
        let fragment = fragment.join("\n");
        let aggregator = format!(
            "# {host} 的共享路径入口，由 ABCDeploy 管理\n{host} {{\n\timport /etc/caddy/sites/.abcdeploy-paths/{key}/*.caddy\n}}\n"
        );
        let paths = format!("{}\n", paths.join("\n"));
        writeln!(
            records,
            "{host}\t{key}\t{}\t{}\t{}",
            BASE64.encode(fragment.as_bytes()),
            BASE64.encode(aggregator.as_bytes()),
            BASE64.encode(paths.as_bytes()),
        )
        .expect("writing to a String is infallible");
    }

    let encoded_records = BASE64.encode(records.as_bytes());
    let route_declared = r#"route_declared_in_file() {
  awk -v host="$1" '
    BEGIN {
      target=tolower(host);
      sub(/^https?:\/\//, "", target);
      sub(/:(80|443)$/, "", target);
      sub(/\.$/, "", target);
      depth=0;
    }
    {
      open_line=$0; close_line=$0;
      opens=gsub(/\{/, "{", open_line); closes=gsub(/\}/, "}", close_line);
      if (depth == 0 && index($0, "{") > 0) {
        header=$0;
        sub(/\{.*/, "", header);
        gsub(/[[:space:]]/, "", header);
        count=split(header, labels, ",");
        for (i=1; i<=count; i++) {
          candidate=tolower(labels[i]);
          sub(/^https?:\/\//, "", candidate);
          sub(/:(80|443)$/, "", candidate);
          sub(/\.$/, "", candidate);
          if (candidate == target) found=1;
        }
      }
      depth += opens - closes;
    }
    END { exit found ? 0 : 1 }
  ' "$2"
}"#;

    Ok(format!(
        r##"# Activate non-root routes through one shared Caddy site per host.
# Each deployment path owns only its fragment, so other projects remain intact.
set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 900 9 || {{ echo '同一服务器已有部署任务，等待超时' >&2; exit 75; }}
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || printf 'deploydesk-caddy')"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || printf '%s' "$HOME/.deploydesk/caddy/sites")"
DEPLOYMENT_NETWORK={network}
SITE_NAME={site_name}
SHARED_WORK_DIR="$(mktemp -d "$HOME/.deploydesk/caddy/shared.XXXXXX")"
SHARED_PATH_ROOT="$CADDY_SITE_DIRECTORY/.abcdeploy-paths"
SHARED_RECORDS_FILE="$SHARED_WORK_DIR/records"
SHARED_MAIN_FILE="$SHARED_WORK_DIR/main"
mkdir -p "$SHARED_WORK_DIR/aggregators.original" "$SHARED_WORK_DIR/owners.original"
printf '%s' {encoded_records} | base64 --decode >"$SHARED_RECORDS_FILE"
case "$CADDY_CONTAINER" in ''|*[!A-Za-z0-9_.-]*) echo 'AD-SRV-205：Caddy 容器记录无效' >&2; exit 1 ;; esac
case "$DEPLOYMENT_NETWORK" in ''|*[!A-Za-z0-9_.-]*) echo 'AD-SRV-211：项目网络记录无效，未加载访问地址' >&2; exit 1 ;; esac
if ! docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1; then
  echo 'AD-SRV-205：统一 Caddy 尚未启动，未加载访问地址' >&2
  exit 1
fi
# The path route and network attachment are one transaction. A successful
# Caddy reload is not enough when its upstream network remains unreachable.
if ! docker network inspect "$DEPLOYMENT_NETWORK" --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
  if ! docker network connect "$DEPLOYMENT_NETWORK" "$CADDY_CONTAINER"; then
    echo 'AD-SRV-211：统一 Caddy 无法加入当前项目网络，未加载访问地址' >&2
    exit 1
  fi
fi
if ! docker network inspect "$DEPLOYMENT_NETWORK" --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
  echo 'AD-SRV-211：统一 Caddy 尚未连接当前项目网络，未加载访问地址' >&2
  exit 1
fi
docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile >"$SHARED_MAIN_FILE"
{route_declared}
insert_shared_import() {{
  awk -v target_host="$1" -v import_path="$2" '
    function normalize(value, normalized) {{
      normalized=tolower(value);
      sub(/^https?:\/\//, "", normalized);
      sub(/:(80|443)$/, "", normalized);
      sub(/\.$/, "", normalized);
      return normalized;
    }}
    function trim(value) {{
      sub(/^[[:space:]]+/, "", value);
      sub(/[[:space:]]+$/, "", value);
      return value;
    }}
    BEGIN {{ target=normalize(target_host); depth=0; inserted=0; }}
    {{
      original=$0;
      open_line=$0; close_line=$0;
      opens=gsub(/\{{/, "{{", open_line); closes=gsub(/\}}/, "}}", close_line);
      matches=0;
      if (depth == 0 && index($0, "{{") > 0) {{
        header=$0;
        sub(/\{{.*/, "", header);
        count=split(header, labels, ",");
        for (i=1; i<=count; i++) if (normalize(trim(labels[i])) == target) matches=1;
      }}
      print original;
      if (matches) {{ print "\timport " import_path; inserted=1; }}
      depth += opens - closes;
    }}
    END {{ if (!inserted) exit 1; }}
  ' "$3" >"$4"
}}
if [ -d "$SHARED_PATH_ROOT" ]; then cp -a "$SHARED_PATH_ROOT" "$SHARED_WORK_DIR/paths.original"; fi
for file in "$CADDY_SITE_DIRECTORY"/abcdeploy-shared-*.caddy; do
  [ -f "$file" ] || continue
  cp "$file" "$SHARED_WORK_DIR/aggregators.original/"
done
restore_shared_routes() {{
  rm -rf "$SHARED_PATH_ROOT"
  if [ -d "$SHARED_WORK_DIR/paths.original" ]; then cp -a "$SHARED_WORK_DIR/paths.original" "$SHARED_PATH_ROOT"; fi
  rm -f "$CADDY_SITE_DIRECTORY"/abcdeploy-shared-*.caddy
  for file in "$SHARED_WORK_DIR/aggregators.original"/*.caddy; do
    [ -f "$file" ] || continue
    cp "$file" "$CADDY_SITE_DIRECTORY/"
  done
  if [ -f "$SHARED_WORK_DIR/owners.map" ]; then
    while IFS="$(printf '\t')" read -r key owner_file; do
      [ -n "$key" ] && [ -n "$owner_file" ] || continue
      cp "$SHARED_WORK_DIR/owners.original/$key.caddy" "$owner_file"
    done <"$SHARED_WORK_DIR/owners.map"
  fi
}}
mkdir -p "$SHARED_PATH_ROOT"
# Updating a line replaces only fragments previously owned by that line.
find "$SHARED_PATH_ROOT" -type f -name "$SITE_NAME" -delete 2>/dev/null || true
for directory in "$SHARED_PATH_ROOT"/*; do
  [ -d "$directory" ] || continue
  if ! find "$directory" -maxdepth 1 -type f -name '*.caddy' | grep -q .; then
    key="$(basename "$directory")"
    rm -rf "$directory"
    rm -f "$CADDY_SITE_DIRECTORY/abcdeploy-shared-$key.caddy"
  fi
done
while IFS="$(printf '\t')" read -r host key fragment_b64 aggregator_b64 paths_b64; do
  [ -n "$host" ] || continue
  case "$key" in ''|*[!a-f0-9]*) restore_shared_routes; echo '共享访问地址标识无效' >&2; exit 1 ;; esac
  HOST_DIRECTORY="$SHARED_PATH_ROOT/$key"
  AGGREGATOR_FILE="$CADDY_SITE_DIRECTORY/abcdeploy-shared-$key.caddy"
  if route_declared_in_file "$host" "$SHARED_MAIN_FILE"; then
    restore_shared_routes
    echo "AD-SRV-210：$host 已由服务器主路由管理，不能直接追加项目路径" >&2
    exit 1
  fi
  OWNER_FILE=''
  for file in "$CADDY_SITE_DIRECTORY"/*.caddy; do
    [ -f "$file" ] || continue
    [ "$file" = "$AGGREGATOR_FILE" ] && continue
    [ "$file" = "$CADDY_SITE_DIRECTORY/$SITE_NAME" ] && continue
    if route_declared_in_file "$host" "$file"; then
      if [ -n "$OWNER_FILE" ] && [ "$OWNER_FILE" != "$file" ]; then
        restore_shared_routes
        echo "AD-SRV-210：$host 同时存在多份整站路由，未追加访问路径" >&2
        exit 1
      fi
      OWNER_FILE="$file"
    fi
  done
  mkdir -p "$HOST_DIRECTORY"
  printf '%s' "$paths_b64" | base64 --decode >"$SHARED_WORK_DIR/paths"
  while IFS= read -r route_path; do
    [ -n "$route_path" ] || continue
    for file in "$HOST_DIRECTORY"/*.caddy; do
      [ -f "$file" ] || continue
      [ "$file" = "$HOST_DIRECTORY/$SITE_NAME" ] && continue
      if grep -Fqx -- "# ABCDEPLOY_ROUTE $route_path" "$file"; then
        restore_shared_routes
        echo "AD-SRV-210：$host$route_path 已由另一条上线线路使用，请更换访问路径" >&2
        exit 1
      fi
    done
  done <"$SHARED_WORK_DIR/paths"
  printf '%s' "$fragment_b64" | base64 --decode >"$HOST_DIRECTORY/$SITE_NAME.next"
  mv -f "$HOST_DIRECTORY/$SITE_NAME.next" "$HOST_DIRECTORY/$SITE_NAME"
  if [ -n "$OWNER_FILE" ]; then
    if ! grep -Fqx -- "$OWNER_FILE" "$SHARED_WORK_DIR/owners.saved" 2>/dev/null; then
      cp "$OWNER_FILE" "$SHARED_WORK_DIR/owners.original/$key.caddy"
      printf '%s\t%s\n' "$key" "$OWNER_FILE" >>"$SHARED_WORK_DIR/owners.map"
      printf '%s\n' "$OWNER_FILE" >>"$SHARED_WORK_DIR/owners.saved"
    fi
    IMPORT_PATH="/etc/caddy/sites/.abcdeploy-paths/$key/*.caddy"
    if ! grep -Fq -- "import $IMPORT_PATH" "$OWNER_FILE"; then
      if ! insert_shared_import "$host" "$IMPORT_PATH" "$OWNER_FILE" "$OWNER_FILE.next"; then
        restore_shared_routes
        rm -f "$OWNER_FILE.next"
        echo "AD-SRV-210：$host 的现有路由无法安全追加项目路径" >&2
        exit 1
      fi
      mv -f "$OWNER_FILE.next" "$OWNER_FILE"
    fi
    rm -f "$AGGREGATOR_FILE"
  else
    printf '%s' "$aggregator_b64" | base64 --decode >"$AGGREGATOR_FILE.next"
    mv -f "$AGGREGATOR_FILE.next" "$AGGREGATOR_FILE"
  fi
done <"$SHARED_RECORDS_FILE"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$SHARED_WORK_DIR/validate.log" 2>&1; then
  diagnostic="$(tail -n 1 "$SHARED_WORK_DIR/validate.log" | tr '\n' ' ')"
  restore_shared_routes
  echo "AD-SRV-210：共享访问路径校验失败，已恢复原路由：$diagnostic" >&2
  rm -rf "$SHARED_WORK_DIR"
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  restore_shared_routes
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo 'AD-SRV-210：共享访问路径加载失败，已恢复原路由' >&2
  rm -rf "$SHARED_WORK_DIR"
  exit 1
fi
rm -rf "$SHARED_WORK_DIR"
"##,
        site_name = shell_quote(site_name),
        network = shell_quote(network),
        encoded_records = shell_quote(&encoded_records),
        route_declared = route_declared,
    ))
}

fn render_compose(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    environment: &EnvironmentConfig,
) -> Result<String> {
    let network_name = format!("deploydesk-{}-{}", manifest.project.name, name.as_str());
    let uses_shared_infrastructure = name != EnvironmentName::Development
        && (environment.database.is_some() || environment.redis_namespace.is_some());
    let mut services = BTreeMap::new();
    for (index, service) in manifest.services.iter().enumerate() {
        let image_variable = image_variable(service);
        let mut labels = BTreeMap::new();
        labels.insert(
            "deploydesk.project".to_string(),
            manifest.project.name.clone(),
        );
        labels.insert(
            "deploydesk.environment".to_string(),
            name.as_str().to_string(),
        );
        labels.insert("deploydesk.service".to_string(), service.id.clone());
        let mut runtime = BTreeMap::new();
        runtime.insert("DEPLOYDESK_ENV".to_string(), name.as_str().to_string());
        // The manifest's container port is the deployment contract used by the
        // healthcheck and Caddy route. A copied local runtime file may still
        // contain APP_PORT/PORT values that only make sense on the developer's
        // machine, so make the deployment contract authoritative when the
        // service explicitly declares either conventional listen variable.
        for listen_variable in ["APP_PORT", "PORT"] {
            if service
                .runtime_env
                .iter()
                .any(|variable| variable.name == listen_variable)
            {
                runtime.insert(
                    listen_variable.to_string(),
                    service.container_port.to_string(),
                );
            }
        }
        if service
            .dockerfile
            .starts_with(".deploydesk/generated/build/Dockerfile.")
            && matches!(service.kind, ServiceKind::Static | ServiceKind::Web)
            && let Some(api) = manifest
                .services
                .iter()
                .find(|candidate| candidate.kind == ServiceKind::Api)
        {
            runtime.insert("API_HOST".to_string(), api.id.clone());
            runtime.insert("API_PORT".to_string(), api.container_port.to_string());
        }
        let health_command = service.healthcheck.command.clone().unwrap_or_else(|| match service.kind {
            ServiceKind::Static => format!(
                "wget -Y off -q --spider http://127.0.0.1:{}{}",
                service.container_port, service.healthcheck.path
            ),
            ServiceKind::Api | ServiceKind::Web | ServiceKind::Worker => format!(
                "node -e \"fetch('http://127.0.0.1:{}{}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"",
                service.container_port, service.healthcheck.path
            ),
        });
        let generated_caddy_runtime = service
            .dockerfile
            .starts_with(".deploydesk/generated/build/Dockerfile.")
            && health_command.starts_with("wget -Y off -q --spider ");
        let mut aliases = vec![
            service_alias(manifest, name, service),
            service.image.clone(),
        ];
        aliases.sort();
        aliases.dedup();
        let mut service_networks =
            BTreeMap::from([("apps".to_string(), ComposeServiceNetwork { aliases })]);
        if uses_shared_infrastructure {
            service_networks.insert(
                "infrastructure".to_string(),
                ComposeServiceNetwork {
                    aliases: Vec::new(),
                },
            );
        }
        services.insert(
            service.id.clone(),
            ComposeService {
                image: (name != EnvironmentName::Development)
                    .then(|| format!("${{{image_variable}:?请填写不可变镜像地址}}")),
                build: (name == EnvironmentName::Development).then(|| ComposeBuild {
                    context: local_build_context(&service.context),
                    dockerfile: local_dockerfile(&service.context, &service.dockerfile),
                }),
                restart: if name == EnvironmentName::Development {
                    "no".to_string()
                } else {
                    "unless-stopped".to_string()
                },
                // A shared runtime file must only be injected into services that actually
                // declare runtime variables. Otherwise an API-only value such as API_PORT can
                // unexpectedly override an identically named Dockerfile default in a web
                // container. Static services generally need their configuration at build time.
                env_file: if service.runtime_env.is_empty() {
                    Vec::new()
                } else {
                    vec![if name == EnvironmentName::Development {
                        "../../runtime/development.env".to_string()
                    } else {
                        ".runtime.env".to_string()
                    }]
                },
                extra_hosts: if name == EnvironmentName::Development {
                    vec!["host.docker.internal:host-gateway".to_string()]
                } else {
                    Vec::new()
                },
                ports: if name == EnvironmentName::Development
                    && service.kind != ServiceKind::Worker
                {
                    vec![format!(
                        "127.0.0.1:{}:{}",
                        local_service_host_port(service, index),
                        service.container_port
                    )]
                } else {
                    Vec::new()
                },
                environment: runtime,
                networks: service_networks,
                labels,
                healthcheck: ComposeHealthcheck {
                    test: vec!["CMD-SHELL".to_string(), health_command],
                    interval: if generated_caddy_runtime {
                        "2s".to_string()
                    } else {
                        format!("{}s", service.healthcheck.interval_seconds)
                    },
                    timeout: if generated_caddy_runtime {
                        "2s".to_string()
                    } else {
                        "5s".to_string()
                    },
                    retries: if generated_caddy_runtime {
                        15
                    } else {
                        service.healthcheck.retries
                    },
                    start_period: if generated_caddy_runtime {
                        "1s".to_string()
                    } else {
                        "20s".to_string()
                    },
                },
            },
        );
    }
    let mut networks = BTreeMap::from([(
        "apps".to_string(),
        ComposeNetwork {
            external: name != EnvironmentName::Development,
            name: network_name,
        },
    )]);
    if uses_shared_infrastructure {
        networks.insert(
            "infrastructure".to_string(),
            ComposeNetwork {
                external: true,
                name: "abcdeploy-infra".to_string(),
            },
        );
    }
    let compose = ComposeFile {
        name: environment.target.namespace.clone(),
        services,
        networks,
    };
    let mut content = serde_yaml_ng::to_string(&compose).map_err(|source| DeployError::Yaml {
        path: format!("generated/{}/docker-compose.yml", name.as_str()).into(),
        source,
    })?;
    content.insert_str(0, "# 由 ABCDeploy 生成。真实 .env 只保存在目标环境。\n");
    Ok(content)
}

fn local_build_context(context: &str) -> String {
    if context == "." {
        "../../..".to_string()
    } else {
        format!("../../../{context}")
    }
}

fn local_dockerfile(context: &str, dockerfile: &str) -> String {
    if context == "." {
        dockerfile.to_string()
    } else {
        dockerfile
            .strip_prefix(&format!("{context}/"))
            .unwrap_or(dockerfile)
            .to_string()
    }
}

#[must_use]
pub fn local_service_host_port(service: &ServiceConfig, index: usize) -> usize {
    let base = match service.kind {
        ServiceKind::Api => 3000,
        ServiceKind::Web => 3100,
        ServiceKind::Static => 4173,
        ServiceKind::Worker => 3200,
    };
    base + index
}

fn render_env_example(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    environment: &EnvironmentConfig,
) -> String {
    let mut lines = vec![
        "# 由 ABCDeploy 生成，仅包含变量名和非敏感默认值。".to_string(),
        format!("DEPLOYDESK_ENV={}", name.as_str()),
    ];
    if let Some(database) = &environment.database {
        lines.push(format!("DATABASE_NAME={}", database.name));
        lines.push(format!("DATABASE_USER={}", database.user));
        lines.push("DATABASE_URL=".to_string());
    }
    if let Some(namespace) = &environment.redis_namespace {
        lines.push(format!("REDIS_KEY_PREFIX={namespace}"));
        lines.push("REDIS_URL=".to_string());
    }
    let mut variables = BTreeMap::new();
    for service in &manifest.services {
        for variable in &service.runtime_env {
            variables
                .entry(variable.name.clone())
                .or_insert_with(|| variable.default.clone().unwrap_or_default());
        }
    }
    for (key, value) in variables {
        if !lines
            .iter()
            .any(|line| line.starts_with(&format!("{key}=")))
        {
            lines.push(format!("{key}={value}"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn render_secret_example(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    _environment: &EnvironmentConfig,
) -> Result<String> {
    let prefix = name.as_str().to_ascii_uppercase();
    let mut values = BTreeMap::<String, String>::from([
        (format!("{prefix}_SERVER_HOST"), String::new()),
        (format!("{prefix}_SERVER_PORT"), "22".to_string()),
        (format!("{prefix}_SERVER_USER"), String::new()),
        (format!("{prefix}_SERVER_SSH_KEY"), String::new()),
        (format!("{prefix}_SERVER_KNOWN_HOSTS"), String::new()),
        (format!("{prefix}_RUNTIME_ENV_FILE"), String::new()),
    ]);
    if !matches!(manifest.providers.registry, RegistryConfig::Cnb { .. }) {
        let provider = RegistryProvider::new(&manifest.providers.registry);
        let (username, password) = provider.credential_names();
        values.insert(username.to_string(), String::new());
        values.insert(password.to_string(), String::new());
    }
    let mut content = serde_yaml_ng::to_string(&values).map_err(|source| DeployError::Yaml {
        path: format!("generated/{}/secret.example.yml", name.as_str()).into(),
        source,
    })?;
    content.insert_str(
        0,
        concat!(
            "# 仅包含字段名和空占位符。请在 CNB 密钥仓库 Web 页面填写，勿提交真实值。\n",
            "# SSH 私钥和 RUNTIME_ENV_FILE 请在 Web 编辑器中使用 YAML 的 | 多行格式。\n",
            "# SERVER_KNOWN_HOSTS 应填写已人工核对指纹后的 known_hosts 完整行。\n",
        ),
    );
    Ok(content)
}

fn render_caddy(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    environment: &EnvironmentConfig,
) -> String {
    let mut lines = vec![format!(
        "# {} / {}，由 ABCDeploy 生成",
        manifest.project.name,
        name.display_name()
    )];
    if environment.domains.is_empty() {
        lines.push("# 域名待配置，当前不创建公网路由。".to_string());
    }
    for route in &environment.domains {
        let Some(service) = manifest
            .services
            .iter()
            .find(|service| service.id == route.service)
        else {
            continue;
        };
        lines.push(String::new());
        let site_address = if is_temporary_test_host(&route.host) {
            // Public ACME validation for sslip.io is commonly intercepted by
            // domestic cloud domain policies. Temporary test addresses are
            // intentionally HTTP-only; production domains still use Caddy's
            // automatic HTTPS.
            format!("http://{}", route.host)
        } else {
            route.host.clone()
        };
        lines.push(format!("{site_address} {{"));
        if route.path == "/" {
            lines.push(format!(
                "\treverse_proxy {}:{}",
                service_alias(manifest, name, service),
                service.container_port
            ));
        } else {
            lines.push(format!("\thandle_path {}* {{", route.path));
            lines.push(format!(
                "\t\treverse_proxy {}:{}",
                service_alias(manifest, name, service),
                service.container_port
            ));
            lines.push("\t}".to_string());
        }
        lines.push("}".to_string());
    }
    lines.push(String::new());
    lines.join("\n")
}

fn is_temporary_test_host(host: &str) -> bool {
    host.to_ascii_lowercase().ends_with(".sslip.io")
}

fn render_cnb_pipeline(manifest: &ProjectManifest) -> Result<String> {
    let provider = CnbPipelineProvider;
    let build = deployment_path_build_pipeline(manifest);

    let mut root = Map::new();
    root.insert(
        manifest.source.release_branch.clone(),
        // A source update creates an immutable build candidate only. Runtime
        // targets are first-class desktop deployment paths and must never be
        // selected implicitly by a branch name.
        json!({ "push": [build.clone()] }),
    );
    if manifest.release.production_mode == ProductionMode::Approval {
        root.insert(
            "deploydesk-production".to_string(),
            json!({
                "push": [{
                    "name": "deploydesk-production-approval",
                    "stages": [{
                        "name": "发布已验证版本",
                        "type": "cnb:apply",
                        "options": {
                            "event": provider.production_event(),
                            "sync": true,
                            "title": "ABCDeploy production promotion"
                        }
                    }]
                }]
            }),
        );
    }
    let mut api_triggers = Map::new();
    api_triggers.insert(
        "api_trigger_deployment_path_build".to_string(),
        json!([build]),
    );
    // Keep the legacy events readable for previously persisted tasks. New
    // deployment paths never call these provider-specific environment slots.
    api_triggers.insert(
        provider.staging_event().to_string(),
        json!([release_pipeline(manifest)?]),
    );
    api_triggers.insert(
        provider.native_staging_event().to_string(),
        json!([native_staging_pipeline(manifest)?]),
    );
    if manifest.release.production_mode == ProductionMode::Approval {
        api_triggers.insert(
            provider.production_event().to_string(),
            json!([production_pipeline(manifest)?]),
        );
        api_triggers.insert(
            provider.native_production_event().to_string(),
            json!([production_pipeline(manifest)?]),
        );
    }
    root.insert("$".to_string(), Value::Object(api_triggers));
    let mut content =
        serde_yaml_ng::to_string(&Value::Object(root)).map_err(|source| DeployError::Yaml {
            path: ".cnb.yml".into(),
            source,
        })?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 生成。流水线只引用密钥，不在仓库保存密钥值。\n",
    );
    Ok(content)
}

fn deployment_path_build_pipeline(manifest: &ProjectManifest) -> Value {
    let mut stages = vec![
        system_tools_stage(),
        json!({
            "name": "安装依赖",
            "script": [
                "command -v corepack >/dev/null 2>&1 && corepack enable || true",
                manifest.project.commands.install
            ]
        }),
    ];
    for (index, command) in manifest.project.commands.verify.iter().enumerate() {
        stages.push(json!({
            "name": format!("验证 {}", index + 1),
            "script": [command]
        }));
    }
    stages.push(json!({
        "name": "登录临时构建仓库",
        "script": [concat!(
            "test -n \"${CNB_TOKEN:-}\"\n",
            "printf '%s' \"$CNB_TOKEN\" | docker login docker.cnb.cool --username \"${CNB_USERNAME:-cnb}\" --password-stdin"
        )]
    }));
    for service in &manifest.services {
        stages.push(json!({
            "name": format!("构建 {}", service.id),
            "script": [deployment_path_build_script(manifest, service)]
        }));
    }
    json!({
        "name": "abcdeploy-build-candidate",
        "runner": { "tags": "cnb:arch:amd64", "cpus": 4 },
        "docker": { "image": "node:22-slim" },
        "services": ["docker"],
        "env": {
            "COREPACK_NPM_REGISTRY": "https://registry.npmmirror.com",
            "NO_PROXY": "registry.npmmirror.com",
            "no_proxy": "registry.npmmirror.com",
            "npm_config_registry": "https://registry.npmmirror.com"
        },
        "stages": stages
    })
}

fn deployment_path_build_script(manifest: &ProjectManifest, service: &ServiceConfig) -> String {
    let repository = format!(
        "docker.cnb.cool/{}/{}",
        manifest.providers.build.repository.to_ascii_lowercase(),
        service.image.to_ascii_lowercase(),
    );
    let mut build_arguments = String::new();
    for (key, value) in &service.build_args {
        write!(
            build_arguments,
            " --build-arg {}",
            shell_quote(&format!("{key}={value}"))
        )
        .expect("writing to a String is infallible");
    }
    format!(
        "IMAGE_TAG=\"{}\"\nIMAGE_REFERENCE={}:$IMAGE_TAG\ndocker build --file {} --tag \"$IMAGE_REFERENCE\"{} {}\ndocker push \"$IMAGE_REFERENCE\"",
        image_tag_expression(manifest),
        shell_quote(&repository),
        shell_quote(&service.dockerfile),
        build_arguments,
        shell_quote(&service.context),
    )
}

fn render_cnb_deployments() -> Result<String> {
    let document = json!({
        "environments": [
            {
                "name": "staging",
                "description": "重新部署这次已经验证的测试版本",
                "title": "重新部署测试环境",
                "env": { "DEPLOYDESK_ENV": "staging" },
                "permissions": { "roles": ["owner", "master", "developer"] }
            },
            {
                "name": "production",
                "description": "把测试通过的同一镜像摘要发布到正式环境",
                "title": "发布正式环境",
                "env": { "DEPLOYDESK_ENV": "production" },
                "permissions": { "roles": ["owner", "master"] },
                "require": [
                    {
                        "approver": { "roles": ["owner", "master"] },
                        "title": "确认本次正式发布"
                    }
                ]
            }
        ]
    });
    let mut content = serde_yaml_ng::to_string(&document).map_err(|source| DeployError::Yaml {
        path: ".cnb/tag_deploy.yml".into(),
        source,
    })?;
    content.insert_str(
        0,
        "# 由 ABCDeploy 生成。候选 Tag 只会在测试环境健康后创建。\n",
    );
    Ok(content)
}

fn release_pipeline(manifest: &ProjectManifest) -> Result<Value> {
    let mut stages = build_stages(manifest);
    stages.push(json!({
        "name": "在测试环境验证生产候选",
        "script": [deploy_script(
            manifest,
            EnvironmentName::Staging,
            ReleaseChannel::Candidate,
        )?]
    }));
    stages.push(json!({
        "name": "标记已验证镜像摘要",
        "script": [promote_script(manifest)]
    }));
    stages.push(json!({
        "name": "创建可在手机发布的候选版本",
        "script": [candidate_tag_script(manifest)]
    }));

    let mut imports = vec![secret_import(manifest, EnvironmentName::Staging)];
    if manifest.release.production_mode == ProductionMode::Automatic {
        imports.push(secret_import(manifest, EnvironmentName::Production));
        stages.push(json!({
            "name": "自动晋级生产环境",
            "script": [deploy_script(
                manifest,
                EnvironmentName::Production,
                ReleaseChannel::Verified,
            )?]
        }));
    }

    Ok(pipeline_definition(
        "deploydesk-release-candidate",
        &imports,
        EnvironmentName::Staging,
        &stages,
    ))
}

fn native_staging_pipeline(manifest: &ProjectManifest) -> Result<Value> {
    let stages = vec![
        system_tools_stage(),
        registry_login_stage(manifest),
        json!({
            "name": "重新部署已验证的测试版本",
            "script": [deploy_script(
                manifest,
                EnvironmentName::Staging,
                ReleaseChannel::Verified,
            )?]
        }),
    ];
    let imports = [secret_import(manifest, EnvironmentName::Staging)];
    Ok(pipeline_definition(
        "deploydesk-staging-redeploy",
        &imports,
        EnvironmentName::Staging,
        &stages,
    ))
}

fn production_pipeline(manifest: &ProjectManifest) -> Result<Value> {
    let stages = vec![
        system_tools_stage(),
        registry_login_stage(manifest),
        json!({
            "name": "按已验证摘要部署生产环境",
            "script": [deploy_script(
                manifest,
                EnvironmentName::Production,
                ReleaseChannel::Verified,
            )?]
        }),
    ];
    let imports = [secret_import(manifest, EnvironmentName::Production)];
    Ok(pipeline_definition(
        "deploydesk-production-approved",
        &imports,
        EnvironmentName::Production,
        &stages,
    ))
}

fn pipeline_definition(
    name: &str,
    imports: &[String],
    environment: EnvironmentName,
    stages: &[Value],
) -> Value {
    json!({
        "name": name,
        "runner": { "tags": "cnb:arch:amd64", "cpus": 4 },
        "docker": { "image": "node:22-slim" },
        "services": ["docker"],
        "imports": imports,
        "env": {
            "COREPACK_NPM_REGISTRY": "https://registry.npmmirror.com",
            "DEPLOYDESK_ENV": environment.as_str(),
            "NO_PROXY": "registry.npmmirror.com",
            "no_proxy": "registry.npmmirror.com",
            "npm_config_registry": "https://registry.npmmirror.com"
        },
        "stages": stages
    })
}

fn build_stages(manifest: &ProjectManifest) -> Vec<Value> {
    let mut stages = vec![
        system_tools_stage(),
        json!({
            "name": "安装依赖",
            "script": ["corepack enable", manifest.project.commands.install]
        }),
    ];
    for (index, command) in manifest.project.commands.verify.iter().enumerate() {
        stages.push(json!({
            "name": format!("验证 {}", index + 1),
            "script": [command]
        }));
    }
    stages.push(registry_login_stage(manifest));
    for service in &manifest.services {
        stages.push(json!({
            "name": format!("构建并上传 {}", service.id),
            "script": [build_script(manifest, service)]
        }));
    }
    stages
}

fn system_tools_stage() -> Value {
    json!({
        "name": "准备安全部署工具",
        "script": ["apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client && rm -rf /var/lib/apt/lists/*"]
    })
}

fn registry_login_stage(manifest: &ProjectManifest) -> Value {
    json!({
        "name": "登录镜像仓库",
        "script": [registry_login_script(manifest)]
    })
}

fn registry_login_script(manifest: &ProjectManifest) -> String {
    match &manifest.providers.registry {
        RegistryConfig::Cnb { .. } => concat!(
            "test -n \"$CNB_TOKEN\"\n",
            "printf '%s' \"$CNB_TOKEN\" | docker login docker.cnb.cool --username \"${CNB_USERNAME:-cnb}\" --password-stdin"
        )
        .to_string(),
        RegistryConfig::Tcr { .. } | RegistryConfig::Oci { .. } => {
            let provider = RegistryProvider::new(&manifest.providers.registry);
            let (username, password) = provider.credential_names();
            format!(
                "test -n \"${{{username}:-}}\"\ntest -n \"${{{password}:-}}\"\nprintf '%s' \"${{{password}}}\" | docker login {} --username \"${{{username}}}\" --password-stdin",
                shell_quote(provider.push_registry())
            )
        }
    }
}

fn build_script(manifest: &ProjectManifest, service: &ServiceConfig) -> String {
    let repository = image_push_repository(manifest, &service.image);
    let mut build_arguments = String::new();
    for (key, value) in &service.build_args {
        write!(
            build_arguments,
            " --build-arg {}",
            shell_quote(&format!("{key}={value}"))
        )
        .expect("writing to a String is infallible");
    }
    format!(
        "IMAGE_TAG=\"{}\"\nIMAGE_REPOSITORY={}\nIMAGE_REFERENCE=\"${{IMAGE_REPOSITORY}}:${{IMAGE_TAG}}\"\ndocker build --file {} --tag \"$IMAGE_REFERENCE\"{} {}\ndocker push \"$IMAGE_REFERENCE\"",
        image_tag_expression(manifest),
        shell_quote(&repository),
        shell_quote(&service.dockerfile),
        build_arguments,
        shell_quote(&service.context),
    )
}

fn image_digest_expression(reference: &str) -> String {
    format!(
        "$(docker buildx imagetools inspect {reference} | awk '$1 == \"Digest:\" && $2 ~ /^sha256:/ {{ print $2; exit }}')"
    )
}

fn promote_script(manifest: &ProjectManifest) -> String {
    let mut lines = vec![
        "set -eu".to_string(),
        format!("IMAGE_TAG=\"{}\"", image_tag_expression(manifest)),
        "VERIFIED_TAG=\"verified-${IMAGE_TAG}\"".to_string(),
    ];
    for service in &manifest.services {
        let repository = image_push_repository(manifest, &service.image);
        lines.push(format!("IMAGE_REPOSITORY={}", shell_quote(&repository)));
        lines.push(format!(
            "IMAGE_DIGEST=\"{}\"",
            image_digest_expression("\"${IMAGE_REPOSITORY}:${IMAGE_TAG}\"")
        ));
        lines.push(
            "case \"$IMAGE_DIGEST\" in sha256:*) ;; *) echo '镜像摘要解析失败' >&2; exit 1 ;; esac"
                .to_string(),
        );
        lines.push(
            "docker buildx imagetools create --prefer-index=false --tag \"${IMAGE_REPOSITORY}:${VERIFIED_TAG}\" \"${IMAGE_REPOSITORY}@${IMAGE_DIGEST}\""
                .to_string(),
        );
        lines.push(format!(
            "VERIFIED_DIGEST=\"{}\"",
            image_digest_expression("\"${IMAGE_REPOSITORY}:${VERIFIED_TAG}\"")
        ));
        lines.push("test \"$VERIFIED_DIGEST\" = \"$IMAGE_DIGEST\"".to_string());
    }
    lines.join("\n")
}

fn candidate_tag_script(manifest: &ProjectManifest) -> String {
    let tag = manifest
        .release
        .candidate_tag_template
        .replace("{commit}", "${CNB_COMMIT}");
    [
        "set -eu".to_string(),
        format!("CANDIDATE_TAG=\"{tag}\""),
        "case \"$CANDIDATE_TAG\" in ''|*[!A-Za-z0-9._-]*) echo '候选版本标签无效' >&2; exit 1 ;; esac".to_string(),
        "test -n \"${CNB_TOKEN:-}\"".to_string(),
        "AUTH_HEADER=\"Authorization: Basic $(printf 'cnb:%s' \"$CNB_TOKEN\" | base64 | tr -d '\\n')\"".to_string(),
        "REMOTE_SHA=\"$(git -c http.extraHeader=\"$AUTH_HEADER\" ls-remote \"$CNB_REPO_URL_HTTPS\" \"refs/tags/$CANDIDATE_TAG\" | awk 'NR == 1 { print $1 }')\"".to_string(),
        "if [ -n \"$REMOTE_SHA\" ]; then test \"$REMOTE_SHA\" = \"$CNB_COMMIT\"; else git tag -f \"$CANDIDATE_TAG\" \"$CNB_COMMIT\"; git -c http.extraHeader=\"$AUTH_HEADER\" push \"$CNB_REPO_URL_HTTPS\" \"refs/tags/$CANDIDATE_TAG\"; fi".to_string(),
        "unset AUTH_HEADER".to_string(),
        "printf '已验证候选版本：%s\\n' \"$CANDIDATE_TAG\"".to_string(),
    ]
    .join("\n")
}

fn deploy_script(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    channel: ReleaseChannel,
) -> Result<String> {
    let prefix = environment.as_str().to_ascii_uppercase();
    let runtime_directory = format!(".deploydesk/runtime/{}", environment.as_str());
    let remote_directory = format!(
        ".deploydesk/apps/{}/{}",
        manifest.project.name,
        environment.as_str()
    );
    let network = format!(
        "deploydesk-{}-{}",
        manifest.project.name,
        environment.as_str()
    );
    let generated_directory = format!(".deploydesk/generated/{}", environment.as_str());
    let mut lines = vec![
        "set -eu".to_string(),
        format!("IMAGE_TAG=\"{}\"", image_tag_expression(manifest)),
        match channel {
            ReleaseChannel::Candidate => "RELEASE_TAG=\"$IMAGE_TAG\"".to_string(),
            ReleaseChannel::Verified => "RELEASE_TAG=\"verified-${IMAGE_TAG}\"".to_string(),
        },
        format!("RUNTIME_DIRECTORY={}", shell_quote(&runtime_directory)),
        "rm -rf \"$RUNTIME_DIRECTORY\"".to_string(),
        "install -d -m 700 \"$RUNTIME_DIRECTORY\"".to_string(),
        runtime_env_script(manifest, environment, &runtime_directory)?,
    ];

    for service in &manifest.services {
        let variable = image_variable(service);
        let repository_variable = format!("{variable}_PUSH_REPOSITORY");
        let pull_repository_variable = format!("{variable}_PULL_REPOSITORY");
        let digest_variable = format!("{variable}_DIGEST");
        lines.push(format!(
            "{repository_variable}={}",
            shell_quote(&image_push_repository(manifest, &service.image))
        ));
        lines.push(format!(
            "{pull_repository_variable}={}",
            shell_quote(&image_pull_repository(manifest, &service.image))
        ));
        let image_reference = format!("\"${{{repository_variable}}}:${{RELEASE_TAG}}\"");
        lines.push(format!(
            "{digest_variable}=\"{}\"",
            image_digest_expression(&image_reference)
        ));
        lines.push(format!(
            "case \"${{{digest_variable}}}\" in sha256:*) ;; *) echo '服务 {} 的镜像摘要无效' >&2; exit 1 ;; esac",
            service.id
        ));
        lines.push(format!(
            "{variable}=\"${{{pull_repository_variable}}}@${{{digest_variable}}}\""
        ));
    }

    lines.push("{".to_string());
    lines.push("  printf 'DEPLOYDESK_RELEASE_ID=%s\\n' \"$RELEASE_TAG\"".to_string());
    for service in &manifest.services {
        let variable = image_variable(service);
        lines.push(format!("  printf '{variable}=%s\\n' \"${{{variable}}}\""));
    }
    lines.push("} > \"$RUNTIME_DIRECTORY/.release.env\"".to_string());
    lines.push("chmod 600 \"$RUNTIME_DIRECTORY/.release.env\"".to_string());

    lines.extend([
        format!("SERVER_HOST=\"${{{prefix}_SERVER_HOST:-}}\""),
        format!("SERVER_PORT=\"${{{prefix}_SERVER_PORT:-22}}\""),
        format!("SERVER_USER=\"${{{prefix}_SERVER_USER:-}}\""),
        format!("SERVER_SSH_KEY=\"${{{prefix}_SERVER_SSH_KEY:-}}\""),
        format!("SERVER_KNOWN_HOSTS=\"${{{prefix}_SERVER_KNOWN_HOSTS:-}}\""),
        "test -n \"$SERVER_HOST\" || { echo '缺少目标环境的 SERVER_HOST' >&2; exit 1; }"
            .to_string(),
        "test -n \"$SERVER_USER\" || { echo '缺少目标环境的 SERVER_USER' >&2; exit 1; }"
            .to_string(),
        "test -n \"$SERVER_SSH_KEY\" || { echo '缺少目标环境的 SERVER_SSH_KEY' >&2; exit 1; }"
            .to_string(),
        "test -n \"$SERVER_KNOWN_HOSTS\" || { echo '缺少已确认的 SERVER_KNOWN_HOSTS' >&2; exit 1; }"
            .to_string(),
        "case \"$SERVER_PORT\" in ''|*[!0-9]*) echo 'SSH 端口格式不正确' >&2; exit 1 ;; esac"
            .to_string(),
        "SSH_KEY_FILE=\"$RUNTIME_DIRECTORY/deploydesk_key\"".to_string(),
        "KNOWN_HOSTS_FILE=\"$RUNTIME_DIRECTORY/known_hosts\"".to_string(),
        "printf '%s\\n' \"$SERVER_SSH_KEY\" > \"$SSH_KEY_FILE\"".to_string(),
        "printf '%s\\n' \"$SERVER_KNOWN_HOSTS\" > \"$KNOWN_HOSTS_FILE\"".to_string(),
        "chmod 600 \"$SSH_KEY_FILE\" \"$KNOWN_HOSTS_FILE\"".to_string(),
        "DESTINATION=\"$SERVER_USER@$SERVER_HOST\"".to_string(),
    ]);

    let remote_prepare = format!(
        "set -eu\nmkdir -p {} \"$HOME/.deploydesk/caddy/sites\"\ndocker network inspect {} >/dev/null 2>&1 || docker network create {} >/dev/null",
        shell_quote(&remote_directory),
        shell_quote(&network),
        shell_quote(&network),
    );
    lines.push(format!(
        "ssh -i \"$SSH_KEY_FILE\" -p \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" \"$DESTINATION\" {}",
        shell_quote(&remote_prepare)
    ));
    lines.push(remote_registry_login(manifest));
    lines.push(format!(
        "scp -i \"$SSH_KEY_FILE\" -P \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" {} \"$DESTINATION:{remote_directory}/docker-compose.yml.next\"",
        shell_quote(&format!("{generated_directory}/docker-compose.yml"))
    ));
    lines.push(format!(
        "scp -i \"$SSH_KEY_FILE\" -P \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" {} \"$DESTINATION:{remote_directory}/Caddyfile.next\"",
        shell_quote(&format!("{generated_directory}/Caddyfile"))
    ));
    lines.push(format!(
        "scp -i \"$SSH_KEY_FILE\" -P \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" \"$RUNTIME_DIRECTORY/.runtime.env\" \"$DESTINATION:{remote_directory}/.runtime.env.next\""
    ));
    lines.push(format!(
        "scp -i \"$SSH_KEY_FILE\" -P \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" \"$RUNTIME_DIRECTORY/.release.env\" \"$DESTINATION:{remote_directory}/.release.env.next\""
    ));

    let remote_deploy = remote_deploy_script(manifest, environment, &remote_directory, &network);
    lines.push(format!(
        "ssh -i \"$SSH_KEY_FILE\" -p \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" \"$DESTINATION\" {}",
        shell_quote(&remote_deploy)
    ));
    Ok(lines.join("\n"))
}

fn runtime_env_script(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    runtime_directory: &str,
) -> Result<String> {
    let prefix = environment.as_str().to_ascii_uppercase();
    let config = manifest.environments.get(environment);
    let mut variables = BTreeMap::<String, RuntimeVariableSpec>::new();
    for variable in manifest
        .services
        .iter()
        .flat_map(|service| &service.runtime_env)
    {
        variables
            .entry(variable.name.clone())
            .and_modify(|current| {
                current.required |= variable.required;
                if current.default.is_none() {
                    current.default.clone_from(&variable.default);
                }
            })
            .or_insert_with(|| RuntimeVariableSpec {
                name: variable.name.clone(),
                source: format!("{prefix}_{}", variable.name),
                required: variable.required,
                default: variable.default.clone(),
            });
    }
    if let Some(database) = &config.database {
        variables
            .entry("DATABASE_URL".to_string())
            .or_insert_with(|| RuntimeVariableSpec {
                name: "DATABASE_URL".to_string(),
                source: format!("{prefix}_DATABASE_URL"),
                required: true,
                default: None,
            });
        for (name, default) in [
            ("DATABASE_NAME", database.name.clone()),
            ("DATABASE_USER", database.user.clone()),
        ] {
            variables
                .entry(name.to_string())
                .or_insert_with(|| RuntimeVariableSpec {
                    name: name.to_string(),
                    source: format!("{prefix}_{name}"),
                    required: false,
                    default: Some(default),
                });
        }
    }
    if let Some(namespace) = &config.redis_namespace {
        variables
            .entry("REDIS_URL".to_string())
            .or_insert_with(|| RuntimeVariableSpec {
                name: "REDIS_URL".to_string(),
                source: format!("{prefix}_REDIS_URL"),
                required: true,
                default: None,
            });
        variables
            .entry("REDIS_KEY_PREFIX".to_string())
            .or_insert_with(|| RuntimeVariableSpec {
                name: "REDIS_KEY_PREFIX".to_string(),
                source: format!("{prefix}_REDIS_KEY_PREFIX"),
                required: false,
                default: Some(namespace.clone()),
            });
    }
    let specs = variables.into_values().collect::<Vec<_>>();
    let specs_json = serde_json::to_string(&specs).map_err(|source| DeployError::Json {
        path: "generated/runtime-env.json".into(),
        source,
    })?;
    let output_path =
        serde_json::to_string(&format!("{runtime_directory}/.runtime.env")).map_err(|source| {
            DeployError::Json {
                path: "generated/runtime-env-path.json".into(),
                source,
            }
        })?;
    let environment_line =
        serde_json::to_string(&format!("DEPLOYDESK_ENV={}", environment.as_str())).map_err(
            |source| DeployError::Json {
                path: "generated/runtime-env-name.json".into(),
                source,
            },
        )?;
    let runtime_file_source = format!("{prefix}_RUNTIME_ENV_FILE");

    Ok([
        "node <<'DEPLOYDESK_NODE'".to_string(),
        "const fs = require(\"node:fs\");".to_string(),
        format!("const variables = {specs_json};"),
        format!("const outputPath = {output_path};"),
        format!("const runtimeFileSource = {runtime_file_source:?};"),
        "const runtimeFile = process.env[runtimeFileSource];".to_string(),
        "if (runtimeFile) {".to_string(),
        "  if (runtimeFile.includes(\"\\0\")) {".to_string(),
        "    console.error(`密钥仓库字段 ${runtimeFileSource} 包含无效字符`);".to_string(),
        "    process.exit(1);".to_string(),
        "  }".to_string(),
        "  const configured = new Map();".to_string(),
        "  for (const line of runtimeFile.split(/\\r?\\n/)) {".to_string(),
        "    const normalized = line.trimStart().replace(/^export\\s+/, \"\");".to_string(),
        "    const equals = normalized.indexOf(\"=\");".to_string(),
        "    if (equals <= 0) continue;".to_string(),
        "    const name = normalized.slice(0, equals).trim();".to_string(),
        "    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;".to_string(),
        "    const value = normalized.slice(equals + 1).trim();".to_string(),
        "    const present = value !== \"\" && value !== \"\\\"\\\"\" && value !== String.fromCharCode(39, 39);"
            .to_string(),
        "    configured.set(name, present);".to_string(),
        "  }".to_string(),
        "  const missing = variables".to_string(),
        "    .filter((variable) => variable.required && !configured.get(variable.name))"
            .to_string(),
        "    .map((variable) => variable.name);".to_string(),
        "  if (missing.length) {".to_string(),
        "    console.error(`缺少密钥仓库字段：${missing.join(\", \")}`);".to_string(),
        "    process.exit(1);".to_string(),
        "  }".to_string(),
        "  const content = runtimeFile.endsWith(\"\\n\") ? runtimeFile : `${runtimeFile}\\n`;"
            .to_string(),
        "  fs.writeFileSync(outputPath, content, { mode: 0o600 });".to_string(),
        "} else {".to_string(),
        format!("  const lines = [{environment_line}];"),
        "  const missing = [];".to_string(),
        "  for (const variable of variables) {".to_string(),
        "    const configured = Object.prototype.hasOwnProperty.call(process.env, variable.source);"
            .to_string(),
        "    const value = configured ? process.env[variable.source] : (variable.default ?? \"\");"
            .to_string(),
        "    if (variable.required && !value) missing.push(variable.source);".to_string(),
        "    if (/\\r|\\n/.test(value)) {".to_string(),
        "      console.error(`密钥仓库字段 ${variable.source} 不支持换行值`);".to_string(),
        "      process.exit(1);".to_string(),
        "    }".to_string(),
        "    lines.push(`${variable.name}=${JSON.stringify(value)}`);".to_string(),
        "  }".to_string(),
        "  if (missing.length) {".to_string(),
        "    console.error(`缺少密钥仓库字段：${missing.join(\", \")}`);".to_string(),
        "    process.exit(1);".to_string(),
        "  }".to_string(),
        "  fs.writeFileSync(outputPath, `${lines.join(\"\\n\")}\\n`, { mode: 0o600 });"
            .to_string(),
        "}".to_string(),
        "DEPLOYDESK_NODE".to_string(),
    ]
    .join("\n"))
}

fn remote_registry_login(manifest: &ProjectManifest) -> String {
    let ssh = "ssh -i \"$SSH_KEY_FILE\" -p \"$SERVER_PORT\" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS_FILE\" \"$DESTINATION\"";
    match &manifest.providers.registry {
        RegistryConfig::Cnb { .. } => format!(
            "printf '%s' \"$CNB_TOKEN\" | {ssh} {}",
            shell_quote("docker login docker.cnb.cool --username cnb --password-stdin")
        ),
        RegistryConfig::Tcr { .. } | RegistryConfig::Oci { .. } => {
            let provider = RegistryProvider::new(&manifest.providers.registry);
            let (username, password) = provider.credential_names();
            let command = format!(
                "IFS= read -r registry_user; test -n \"$registry_user\"; docker login {} --username \"$registry_user\" --password-stdin",
                shell_quote(provider.pull_registry())
            );
            format!(
                "{{ printf '%s\\n' \"${{{username}}}\"; printf '%s' \"${{{password}}}\"; }} | {ssh} {}",
                shell_quote(&command)
            )
        }
    }
}

/// Build the shared shell fragment that keeps non-conflicting Caddy routes
/// active while leaving routes owned by the server's main Caddyfile for an
/// explicit user-approved takeover. Callers provide the file locations via
/// `CANDIDATE_FILE`, `FILTERED_SITE_FILE`, `MAIN_CONFIG_FILE`,
/// `ROUTE_CONFLICTS_FILE`, and `FILTER_HOSTS_FILE`.
#[must_use]
pub fn caddy_partial_route_activation_script(hosts: &[String]) -> String {
    let host_arguments = hosts
        .iter()
        .map(|host| shell_quote(host))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile >"$MAIN_CONFIG_FILE" || {{ echo 'AD-SRV-205：无法读取统一 Caddy 主配置' >&2; exit 1; }}
: >"$ROUTE_CONFLICTS_FILE"
route_declared_in_file() {{
  awk -v host="$1" '
    BEGIN {{
      target=tolower(host);
      sub(/^https?:\/\//, "", target);
      sub(/:(80|443)$/, "", target);
      sub(/\.$/, "", target);
      depth=0;
    }}
    {{
      open_line=$0;
      close_line=$0;
      opens=gsub(/\{{/, "{{", open_line);
      closes=gsub(/\}}/, "}}", close_line);
      if (depth == 0 && index($0, "{{") > 0) {{
        header=$0;
        sub(/\{{.*/, "", header);
        gsub(/[[:space:]]/, "", header);
        count=split(header, labels, ",");
        for (i=1; i<=count; i++) {{
          candidate=tolower(labels[i]);
          sub(/^https?:\/\//, "", candidate);
          sub(/:(80|443)$/, "", candidate);
          sub(/\.$/, "", candidate);
          if (candidate == target) found=1;
        }}
      }}
      depth += opens - closes;
    }}
    END {{ exit found ? 0 : 1 }}
  ' "$2"
}}
for host in {host_arguments}; do
  if route_declared_in_file "$host" "$MAIN_CONFIG_FILE"; then
    printf '%s\tmain\n' "$host" >>"$ROUTE_CONFLICTS_FILE"
    continue
  fi
  for file in "$CADDY_SITE_DIRECTORY"/*.caddy; do
    [ -f "$file" ] || continue
    [ "$file" = "$SITE_FILE" ] && continue
    if route_declared_in_file "$host" "$file"; then
      printf '%s\tmanaged\n' "$host" >>"$ROUTE_CONFLICTS_FILE"
      break
    fi
  done
done
if awk -F '\t' '$2 == "managed" {{ found=1 }} END {{ exit found ? 0 : 1 }}' "$ROUTE_CONFLICTS_FILE"; then
  managed_hosts="$(awk -F '\t' '$2 == "managed" {{ print $1 }}' "$ROUTE_CONFLICTS_FILE" | paste -sd ',' -)"
  echo "AD-SRV-210：$managed_hosts 已由另一个项目管理，请先调整正式地址" >&2
  exit 1
fi
awk -F '\t' '$2 == "main" {{ print $1 }}' "$ROUTE_CONFLICTS_FILE" >"$FILTER_HOSTS_FILE"
awk -v hosts_file="$FILTER_HOSTS_FILE" '
  function normalize(value, normalized) {{
    normalized=tolower(value);
    sub(/^https?:\/\//, "", normalized);
    sub(/:(80|443)$/, "", normalized);
    sub(/\.$/, "", normalized);
    return normalized;
  }}
  BEGIN {{
    while ((getline host < hosts_file) > 0) targets[normalize(host)]=1;
    close(hosts_file);
    depth=0;
    skip=0;
  }}
  {{
    open_line=$0;
    close_line=$0;
    opens=gsub(/\{{/, "{{", open_line);
    closes=gsub(/\}}/, "}}", close_line);
    if (!skip && depth == 0 && index($0, "{{") > 0) {{
      header=$0;
      sub(/\{{.*/, "", header);
      gsub(/[[:space:]]/, "", header);
      count=split(header, labels, ",");
      for (i=1; i<=count; i++) {{
        site_host=tolower(labels[i]);
        sub(/^https?:\/\//, "", site_host);
        sub(/:(80|443)$/, "", site_host);
        sub(/\.$/, "", site_host);
        if (targets[site_host]) skip=1;
      }}
    }}
    if (!skip) print;
    depth += opens - closes;
    if (skip && depth == 0) skip=0;
  }}
' "$CANDIDATE_FILE" >"$FILTERED_SITE_FILE"
"#
    )
}

fn remote_deploy_script(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    remote_directory: &str,
    network: &str,
) -> String {
    let site_name = format!("{}-{}.caddy", manifest.project.name, environment.as_str());
    let persisted_runtime_file = format!(
        ".deploydesk/runtime-config/{}/{}.env",
        manifest.project.name,
        environment.as_str()
    );
    let route_hosts = manifest
        .environments
        .get(environment)
        .domains
        .iter()
        .map(|route| route.host.clone())
        .collect::<Vec<_>>();
    remote_deploy_script_for_target(
        manifest,
        environment,
        remote_directory,
        network,
        &site_name,
        &persisted_runtime_file,
        &route_hosts,
    )
}

fn remote_deploy_script_for_target(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    remote_directory: &str,
    network: &str,
    site_name: &str,
    persisted_runtime_file: &str,
    route_hosts: &[String],
) -> String {
    let compose = "docker compose --env-file .release.env -f docker-compose.yml";
    let migration_steps = remote_migration_steps(manifest, environment, compose);
    let partial_route_script = caddy_partial_route_activation_script(route_hosts);
    let prune_from = manifest.release.keep_releases.saturating_add(1);
    format!(
        r#"set -eu
mkdir -p "$HOME/.deploydesk/locks"
exec 9>"$HOME/.deploydesk/locks/server-deploy.lock"
flock -w 900 9 || {{ echo '同一服务器已有部署任务，等待超时' >&2; exit 75; }}
cd {remote_directory}
minimum_free_kb=5242880
available_kb="$(df -Pk . | awk 'NR == 2 {{ print $4 }}')"
case "$available_kb" in ''|*[!0-9]*) echo 'AD-SRV-208：无法读取服务器剩余磁盘空间' >&2; exit 1 ;; esac
if [ "$available_kb" -lt "$minimum_free_kb" ]; then
  docker image prune -a -f >/dev/null 2>&1 || true
  available_kb="$(df -Pk . | awk 'NR == 2 {{ print $4 }}')"
fi
if [ "$available_kb" -lt "$minimum_free_kb" ]; then
  echo 'AD-SRV-208：服务器可用磁盘空间不足 5GB，已安全清理未使用镜像但仍不足' >&2
  exit 1
fi
PERSISTED_RUNTIME_FILE="$HOME/{persisted_runtime_file}"
if [ -s "$PERSISTED_RUNTIME_FILE" ]; then
  cp "$PERSISTED_RUNTIME_FILE" .runtime.env.next
fi
backup_file() {{
  if [ -f "$1" ]; then
    cp "$1" "$1.previous.next"
    mv -f "$1.previous.next" "$1.previous"
  else
    rm -f "$1.previous" "$1.previous.next"
  fi
}}
restore_previous() {{
  for file in docker-compose.yml .runtime.env .release.env Caddyfile; do
    if [ -f "$file.previous" ]; then mv -f "$file.previous" "$file"; fi
  done
}}
for file in docker-compose.yml .runtime.env .release.env Caddyfile; do
  test -f "$file.next"
  backup_file "$file"
  mv "$file.next" "$file"
done
chmod 600 .runtime.env .release.env
release_id="$(sed -n 's/^DEPLOYDESK_RELEASE_ID=//p' .release.env | head -n 1)"
case "$release_id" in ''|*[!A-Za-z0-9._-]*) echo '发布记录标识无效' >&2; exit 1 ;; esac
if {compose} config --quiet && \
   {compose} pull && \
   {migration_steps}{compose} up -d --remove-orphans --force-recreate --wait --wait-timeout 180; then
  :
else
  deploy_status=$?
  if [ "{auto_rollback}" = "true" ] && [ -f .release.env.previous ]; then
    restore_previous
    {compose} pull || true
    {compose} up -d --remove-orphans --force-recreate --wait --wait-timeout 180 || true
  fi
  exit "$deploy_status"
fi
mkdir -p .history "$HOME/.deploydesk/caddy/sites"
cp .release.env ".history/$release_id.env"
old_releases="$(ls -1t .history/*.env 2>/dev/null | tail -n +{prune_from} || true)"
if [ -n "$old_releases" ]; then printf '%s\n' "$old_releases" | xargs rm -f; fi
if [ "{activate_caddy_routes}" = 1 ]; then
CADDY_CONTAINER="$(cat "$HOME/.deploydesk/caddy/container-name" 2>/dev/null || printf 'deploydesk-caddy')"
CADDY_SITE_DIRECTORY="$(cat "$HOME/.deploydesk/caddy/site-directory" 2>/dev/null || printf '%s' "$HOME/.deploydesk/caddy/sites")"
case "$CADDY_CONTAINER" in ''|*[!A-Za-z0-9_.-]*) echo 'AD-SRV-205：Caddy 容器记录无效' >&2; exit 1 ;; esac
case "$CADDY_SITE_DIRECTORY" in /*) ;; *) echo 'AD-SRV-205：Caddy 路由目录记录无效' >&2; exit 1 ;; esac
test -d "$CADDY_SITE_DIRECTORY" && test -w "$CADDY_SITE_DIRECTORY" || {{ echo 'AD-SRV-205：Caddy 路由目录不可写' >&2; exit 1; }}
SITE_FILE="$CADDY_SITE_DIRECTORY/{site_name}"
if docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1; then
  if ! docker network inspect {network} --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
    if ! docker network connect {network} "$CADDY_CONTAINER"; then
      echo 'AD-SRV-211：统一 Caddy 无法加入当前项目网络，未加载访问地址' >&2
      exit 1
    fi
  fi
  if ! docker network inspect {network} --format '{{{{range .Containers}}}}{{{{println .Name}}}}{{{{end}}}}' | grep -Fx -- "$CADDY_CONTAINER" >/dev/null; then
    echo 'AD-SRV-211：统一 Caddy 尚未连接当前项目网络，未加载访问地址' >&2
    exit 1
  fi
  ROUTE_WORK_DIR="$(mktemp -d "$HOME/.deploydesk/caddy/activate.XXXXXX")"
  trap 'rm -rf "$ROUTE_WORK_DIR"' EXIT
  CANDIDATE_FILE="$PWD/Caddyfile"
  FILTERED_SITE_FILE="$ROUTE_WORK_DIR/Caddyfile.filtered"
  MAIN_CONFIG_FILE="$ROUTE_WORK_DIR/Caddyfile.main"
  ROUTE_CONFLICTS_FILE="$ROUTE_WORK_DIR/conflicts"
  FILTER_HOSTS_FILE="$ROUTE_WORK_DIR/filter-hosts"
  {partial_route_script}
  if [ -f "$SITE_FILE" ]; then cp "$SITE_FILE" "$SITE_FILE.previous"; else rm -f "$SITE_FILE.previous"; fi
  cp "$FILTERED_SITE_FILE" "$SITE_FILE"
  if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if [ -f "$SITE_FILE.previous" ]; then cp "$SITE_FILE.previous" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
    echo 'AD-SRV-209：未冲突地址的配置校验失败，已恢复原路由' >&2
    exit 1
  fi
  if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if [ -f "$SITE_FILE.previous" ]; then cp "$SITE_FILE.previous" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    echo 'AD-SRV-207：Caddy 重载失败，已恢复原路由' >&2
    exit 1
  fi
  while IFS="$(printf '\t')" read -r host source; do
    if [ "$source" = "main" ]; then
      printf 'ROUTE_TAKEOVER_REQUIRED\t%s\n' "$host"
    fi
  done <"$ROUTE_CONFLICTS_FILE"
else
  if [ -f "$SITE_FILE" ]; then cp "$SITE_FILE" "$SITE_FILE.previous"; else rm -f "$SITE_FILE.previous"; fi
  cp Caddyfile "$SITE_FILE"
  echo 'ROUTE_PENDING: AD-SRV-203：应用已健康运行，但统一 Caddy 当前未运行。'
fi
fi"#,
        remote_directory = shell_quote(remote_directory),
        persisted_runtime_file = persisted_runtime_file,
        compose = compose,
        migration_steps = migration_steps,
        auto_rollback = manifest.release.auto_rollback,
        prune_from = prune_from,
        activate_caddy_routes = if route_hosts.is_empty() { "0" } else { "1" },
        site_name = site_name,
        network = shell_quote(network),
        partial_route_script = partial_route_script,
    )
}

fn remote_migration_steps(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    compose: &str,
) -> String {
    let config = manifest.environments.get(environment);
    let mut commands = Vec::new();
    for service in &manifest.services {
        let Some(migration) = &service.migration else {
            continue;
        };
        if migration.backup_required {
            if let Some(database) = &config.database {
                commands.extend([
                    "mkdir -p .backups".to_string(),
                    "POSTGRES_CONTAINER=''; for candidate in abcdeploy-postgres infra-postgres; do if docker ps --format '{{.Names}}' | grep -Fx -- \"$candidate\" >/dev/null; then POSTGRES_CONTAINER=\"$candidate\"; break; fi; done; if [ -z \"$POSTGRES_CONTAINER\" ]; then POSTGRES_CONTAINER=\"$(docker ps --filter network=abcdeploy-infra --filter label=com.docker.compose.service=postgres --format '{{.Names}}' | head -n 1)\"; fi".to_string(),
                    "{ test -n \"$POSTGRES_CONTAINER\" || { echo 'AD-DB-201：没有找到 ABCDeploy 管理的 PostgreSQL 服务，已停止数据库迁移' >&2; exit 1; }; }".to_string(),
                    format!(
                        "DATABASE_EXISTS=\"$(docker exec -u postgres \"$POSTGRES_CONTAINER\" sh -lc {} sh {} | tr -d '[:space:]')\"",
                        shell_quote("exec psql -d postgres -Atqc \"SELECT 1 FROM pg_database WHERE datname = '$1'\""),
                        shell_quote(&database.name),
                    ),
                    "{ test \"$DATABASE_EXISTS\" = 1 || { echo 'AD-DB-204：远程数据库尚未准备，请在客户端重新生成当前环境的云端安全配置' >&2; exit 1; }; }".to_string(),
                    format!(
                        "docker exec -u postgres \"$POSTGRES_CONTAINER\" sh -lc {} sh {} > \".backups/${{release_id}}-{}.dump\"",
                        shell_quote("exec pg_dump -Fc -d \"$1\""),
                        shell_quote(&database.name),
                        service.id,
                    ),
                    format!(
                        "{{ test -s \".backups/${{release_id}}-{}.dump\" || {{ echo 'AD-DB-202：数据库备份没有生成，已停止迁移' >&2; exit 1; }}; }}",
                        service.id
                    ),
                ]);
            } else {
                commands.push(
                    "echo 'AD-DB-203：部署协议要求迁移前备份，但当前环境没有数据库记录' >&2; exit 1"
                        .to_string(),
                );
            }
        }
        commands.push(format!(
            "{compose} run -T --rm --no-deps {} sh -lc {}",
            shell_quote(&service.id),
            shell_quote(&migration.command),
        ));
    }
    if commands.is_empty() {
        String::new()
    } else {
        format!("{} && \\\n   ", commands.join(" && \\\n   "))
    }
}

fn secret_import(manifest: &ProjectManifest, environment: EnvironmentName) -> String {
    manifest
        .environments
        .get(environment)
        .secrets_ref
        .clone()
        .unwrap_or_else(|| {
            format!(
                "https://cnb.cool/replace-me/secret/-/blob/main/env.{}.yml",
                environment.as_str()
            )
        })
}

fn image_tag_expression(manifest: &ProjectManifest) -> String {
    manifest
        .release
        .image_tag_template
        .replace("{commit}", "${CNB_COMMIT}")
}

fn image_push_repository(manifest: &ProjectManifest, image: &str) -> String {
    RegistryProvider::new(&manifest.providers.registry).push_repository(image)
}

fn image_pull_repository(manifest: &ProjectManifest, image: &str) -> String {
    RegistryProvider::new(&manifest.providers.registry).pull_repository(image)
}

fn service_alias(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    service: &ServiceConfig,
) -> String {
    format!(
        "{}-{}-{}",
        manifest.project.name,
        environment.as_str(),
        service.id
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn render_github_sync(manifest: &ProjectManifest) -> Result<String> {
    let workflow = json!({
        "name": "Sync CNB",
        "on": {
            "push": {
            "branches": [manifest.source.release_branch]
            },
            "workflow_dispatch": Value::Object(Map::new())
        },
        "permissions": { "contents": "read" },
        "concurrency": {
            "group": "sync-cnb-${{ github.ref_name }}",
            "cancel-in-progress": true
        },
        "jobs": {
            "sync": {
                "runs-on": "ubuntu-latest",
                "timeout-minutes": 5,
                "steps": [
                    {
                        "name": "Checkout",
                        "uses": "actions/checkout@v4",
                        "with": { "fetch-depth": 0 }
                    },
                    {
                        "name": "Sync branch to CNB",
                        "env": {
                            "CNB_PUSH_TOKEN": "${{ secrets.CNB_PUSH_TOKEN }}",
                            "CNB_REPOSITORY": manifest.providers.build.repository
                        },
                        "run": "set -eu\ntest -n \"$CNB_PUSH_TOKEN\"\nCNB_BASIC_AUTH=\"$(printf 'cnb:%s' \"$CNB_PUSH_TOKEN\" | base64 -w0)\"\nexport GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=http.https://cnb.cool/.extraHeader\nexport GIT_CONFIG_VALUE_0=\"Authorization: Basic ${CNB_BASIC_AUTH}\"\ngit push \"https://cnb.cool/${CNB_REPOSITORY}.git\" \"HEAD:${GITHUB_REF_NAME}\""
                    }
                ]
            }
        }
    });
    let mut content = serde_yaml_ng::to_string(&workflow).map_err(|source| DeployError::Yaml {
        path: ".github/workflows/sync-cnb.yml".into(),
        source,
    })?;
    content.insert_str(0, "# 由 ABCDeploy 生成。\n");
    Ok(content)
}

fn image_variable(service: &ServiceConfig) -> String {
    let service_id = service.id.replace('-', "_").to_ascii_uppercase();
    format!("DEPLOYDESK_{service_id}_IMAGE")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::*;
    use crate::model::{DomainRoute, EnvironmentVariable};
    use crate::plan::create_default_manifest;
    use crate::scanner::inspection_fixture;

    #[test]
    fn renders_legacy_environment_files_and_one_build_only_main_branch() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.environments.staging.domains.push(DomainRoute {
            service: "api".to_string(),
            host: "api.staging.example.com".to_string(),
            path: "/".to_string(),
        });
        let files = render_project_files(&manifest).expect("render files");
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/.gitignore"
                && file.content.contains("backups/")
                && file.content.contains("state/")
        }));
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/generated/development/docker-compose.yml"
                && file.content.contains("build:")
                && file.content.contains("../../runtime/development.env")
                && file.content.contains("host.docker.internal:host-gateway")
                && file.content.contains("127.0.0.1:3000:3000")
                && !file.content.contains("请填写不可变镜像地址")
        }));
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/generated/staging/docker-compose.yml"
                && file.content.contains("example-app-staging")
                && file.content.contains("example-app-staging-api")
                && file.content.contains("- example-app-api")
                && file.content.contains(".runtime.env")
                && file.content.contains("r.status<500?0:1")
                && file.content.contains("abcdeploy-infra")
        }));
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/generated/production/docker-compose.yml"
                && file.content.contains("example-app-production")
        }));
        let pipeline = files
            .iter()
            .find(|file| file.path == ".cnb.yml")
            .expect("pipeline");
        assert!(pipeline.content.contains("main:"));
        assert!(!pipeline.content.contains("test:"));
        let pipeline_yaml: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&pipeline.content).expect("parse generated pipeline");
        let main_pipeline =
            serde_yaml_ng::to_string(&pipeline_yaml["main"]).expect("serialize main pipeline");
        assert_eq!(
            main_pipeline.matches("abcdeploy-build-candidate").count(),
            1
        );
        assert!(!main_pipeline.contains("STAGING_SERVER_HOST"));
        assert!(!main_pipeline.contains("PRODUCTION_SERVER_HOST"));
        assert!(pipeline.content.contains("api_trigger_staging"));
        assert!(
            pipeline
                .content
                .contains("api_trigger_deployment_path_build")
        );
        assert!(pipeline.content.contains("abcdeploy-build-candidate"));
        assert!(
            pipeline
                .content
                .contains("docker.cnb.cool/owner/example-app/example-app-api")
        );
        assert!(pipeline.content.contains("corepack enable"));
        assert!(pipeline.content.contains("COREPACK_NPM_REGISTRY"));
        assert!(
            pipeline
                .content
                .contains("NO_PROXY: registry.npmmirror.com")
        );
        assert!(pipeline.content.contains("api_trigger_production"));
        assert!(pipeline.content.contains("deploydesk-production:"));
        assert!(pipeline.content.contains("type: cnb:apply"));
        assert!(pipeline.content.contains("tag_deploy.staging"));
        assert!(pipeline.content.contains("tag_deploy.production"));
        assert!(pipeline.content.contains("在测试环境验证生产候选"));
        assert!(pipeline.content.contains("标记已验证镜像摘要"));
        assert!(pipeline.content.contains("创建可在手机发布的候选版本"));
        assert!(pipeline.content.contains("deploydesk-${CNB_COMMIT}"));
        assert!(pipeline.content.contains("verified-${IMAGE_TAG}"));
        assert!(pipeline.content.contains("awk '$1 == \"Digest:\""));
        assert!(pipeline.content.contains("StrictHostKeyChecking=yes"));
        assert!(pipeline.content.contains(".release.env.previous"));
        assert!(pipeline.content.contains("--wait-timeout 180"));
        assert!(pipeline.content.contains("--force-recreate"));
        assert!(pipeline.content.contains("docker image prune -a -f"));
        assert!(pipeline.content.contains("AD-SRV-208"));
        assert!(pipeline.content.contains("minimum_free_kb=5242880"));
        assert!(pipeline.content.contains("pg_dump -Fc"));
        assert!(
            pipeline
                .content
                .contains("for candidate in abcdeploy-postgres infra-postgres")
        );
        assert!(pipeline.content.contains("docker exec -u postgres"));
        assert!(
            !pipeline
                .content
                .contains("pg_dump -Fc -U \"$POSTGRES_USER\"")
        );
        assert!(pipeline.content.contains("AD-DB-204"));
        assert!(pipeline.content.contains("SELECT 1 FROM pg_database"));
        assert!(
            pipeline
                .content
                .contains(".deploydesk/runtime-config/example-app/staging.env")
        );
        assert!(pipeline.content.contains(".backups/${release_id}-api.dump"));
        assert!(pipeline.content.contains("run -T --rm --no-deps"));
        assert!(!pipeline.content.contains(":latest"));
        assert!(!pipeline.content.contains("ssh-keyscan"));
        assert!(!pipeline.content.contains("TCR_PASSWORD: actual"));

        let caddy = files
            .iter()
            .find(|file| file.path == ".deploydesk/generated/staging/Caddyfile")
            .expect("staging Caddyfile");
        assert!(caddy.content.contains("example-app-staging-api:3000"));
        let secret_example = files
            .iter()
            .find(|file| file.path == ".deploydesk/generated/staging/secret.example.yml")
            .expect("staging secret example");
        assert!(
            secret_example
                .content
                .contains("STAGING_SERVER_KNOWN_HOSTS")
        );
        assert!(secret_example.content.contains("STAGING_RUNTIME_ENV_FILE"));
        assert!(!secret_example.content.contains("STAGING_DATABASE_URL"));
        assert!(pipeline.content.contains("STAGING_RUNTIME_ENV_FILE"));
        assert!(pipeline.content.contains("caddy/container-name"));
        assert!(pipeline.content.contains("caddy/site-directory"));
        assert!(pipeline.content.contains("ROUTE_TAKEOVER_REQUIRED"));

        let deployment = files
            .iter()
            .find(|file| file.path == ".cnb/tag_deploy.yml")
            .expect("CNB native deployment config");
        assert!(deployment.content.contains("name: staging"));
        assert!(deployment.content.contains("name: production"));
        assert!(deployment.content.contains("同一镜像摘要"));
        assert!(deployment.content.contains("approver:"));
    }

    #[test]
    fn renders_an_independent_deployment_path_without_environment_slots() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.environments.production.database = None;
        let routes = vec![DomainRoute {
            service: "api".to_string(),
            host: "sample.example.com".to_string(),
            path: "/".to_string(),
        }];
        let bundle = render_deployment_path_bundle(&manifest, "path-a1b2", &routes)
            .expect("deployment path bundle");
        assert_eq!(
            bundle.remote_directory,
            ".deploydesk/apps/example-app/paths/path-a1b2"
        );
        assert_eq!(bundle.network, "deploydesk-example-app-path-a1b2");
        assert_eq!(bundle.site_name, "example-app-path-a1b2.caddy");
        assert!(bundle.compose.contains("name: example-app-path-a1b2"));
        assert!(bundle.compose.contains("deploydesk.path: path-a1b2"));
        assert!(bundle.compose.contains("example-app-path-a1b2-api"));
        assert!(!bundle.compose.contains("staging"));
        assert!(!bundle.compose.contains("production"));
        assert!(bundle.caddy.contains("sample.example.com"));
        assert!(bundle.caddy.contains("example-app-path-a1b2-api:3000"));
        assert!(bundle.deploy_script.contains("server-deploy.lock"));
        assert!(bundle.deploy_script.contains("AD-SRV-211"));
        assert!(bundle.deploy_script.contains("docker network inspect"));
        assert!(bundle.deploy_script.contains("example-app-path-a1b2.caddy"));
        assert!(bundle.deploy_script.contains("$file.previous"));
        assert!(
            bundle
                .route_activation_script
                .contains("Reconcile root routes independently")
        );
        assert!(
            bundle
                .route_activation_script
                .contains("server-deploy.lock")
        );
        assert!(
            bundle
                .route_activation_script
                .contains("docker network connect")
        );
        assert!(bundle.route_activation_script.contains("caddy validate"));
        assert!(bundle.route_activation_script.contains("caddy reload"));
        assert!(bundle.route_activation_script.contains("active.json"));
        assert!(
            bundle
                .route_activation_script
                .contains("ROUTE_TAKEOVER_REQUIRED")
        );
        assert!(bundle.route_activation_script.contains("targets"));
    }

    #[test]
    fn renders_non_root_routes_as_a_separate_caddy_transaction() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.environments.production.database = None;
        let routes = vec![DomainRoute {
            service: "api".to_string(),
            host: "shared.example.com".to_string(),
            path: "/sample/".to_string(),
        }];
        let bundle = render_deployment_path_bundle(&manifest, "path-sample", &routes)
            .expect("deployment path bundle");

        assert!(!bundle.deploy_script.contains("Activate non-root routes"));
        assert!(
            bundle
                .route_activation_script
                .contains("Activate non-root routes")
        );
        assert!(
            bundle
                .route_activation_script
                .contains("SHARED_RECORDS_FILE")
        );
        assert!(
            bundle
                .route_activation_script
                .contains("server-deploy.lock")
        );
        assert!(bundle.route_activation_script.contains("AD-SRV-211"));
        assert!(
            bundle
                .route_activation_script
                .contains("deploydesk-example-app-path-sample")
        );
        assert!(
            bundle
                .route_activation_script
                .contains("docker network connect")
        );
        assert!(bundle.route_activation_script.contains("caddy validate"));
        assert!(bundle.route_activation_script.contains("caddy reload"));
    }

    #[test]
    fn runtime_file_is_not_injected_into_services_without_runtime_variables() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        let mut static_service = manifest.services[0].clone();
        static_service.id = "web".to_string();
        static_service.kind = ServiceKind::Static;
        static_service.image = "example-app-web".to_string();
        static_service.dockerfile = ".deploydesk/generated/build/Dockerfile.web".to_string();
        static_service.runtime_env.clear();
        manifest.services.push(static_service);

        let compose = render_compose(
            &manifest,
            EnvironmentName::Staging,
            &manifest.environments.staging,
        )
        .expect("render staging compose");
        let compose: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&compose).expect("parse staging compose");

        assert!(compose["services"]["api"]["env_file"].is_sequence());
        assert!(compose["services"]["web"].get("env_file").is_none());
        assert_eq!(compose["services"]["web"]["environment"]["API_HOST"], "api");
        assert_eq!(
            compose["services"]["web"]["environment"]["API_PORT"],
            "3000"
        );
    }

    #[test]
    fn temporary_sslip_routes_do_not_request_public_certificates() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.environments.staging.domains = vec![DomainRoute {
            service: manifest.services[0].id.clone(),
            host: "demo.42-193-229-35.sslip.io".to_string(),
            path: "/".to_string(),
        }];

        let caddy = render_caddy(
            &manifest,
            EnvironmentName::Staging,
            &manifest.environments.staging,
        );

        assert!(caddy.contains("http://demo.42-193-229-35.sslip.io {"));
        assert!(!caddy.contains("\ndemo.42-193-229-35.sslip.io {"));
    }

    #[test]
    fn deployment_port_overrides_local_listen_port_values() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.services[0].container_port = 3202;
        manifest.services[0].runtime_env.push(EnvironmentVariable {
            name: "APP_PORT".to_string(),
            required: true,
            secret: false,
            default: None,
            description: String::new(),
        });
        manifest.services[0].runtime_env.push(EnvironmentVariable {
            name: "PORT".to_string(),
            required: false,
            secret: false,
            default: None,
            description: String::new(),
        });

        let compose = render_compose(
            &manifest,
            EnvironmentName::Staging,
            &manifest.environments.staging,
        )
        .expect("render staging compose");
        let compose: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&compose).expect("parse staging compose");

        assert_eq!(
            compose["services"]["api"]["environment"]["APP_PORT"],
            "3202"
        );
        assert_eq!(compose["services"]["api"]["environment"]["PORT"], "3202");
    }

    #[test]
    fn automatic_production_uses_the_verified_candidate_digest() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.release.production_mode = ProductionMode::Automatic;
        manifest.environments.production.approval_required = false;
        manifest.environments.production.auto_deploy = true;
        let pipeline = render_cnb_pipeline(&manifest).expect("render automatic pipeline");

        assert!(pipeline.contains("自动晋级生产环境"));
        assert!(pipeline.contains("env.staging.yml"));
        assert!(pipeline.contains("env.production.yml"));
        assert!(pipeline.contains("RELEASE_TAG=\"verified-${IMAGE_TAG}\""));
        assert!(!pipeline.contains("api_trigger_production"));
    }

    #[test]
    fn whole_runtime_file_is_preserved_after_required_value_validation() {
        let tools_available = ["bash", "node"].into_iter().all(|tool| {
            Command::new(tool)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        });
        if !tools_available {
            return;
        }

        let directory = tempfile::tempdir().expect("runtime directory");
        fs::create_dir_all(directory.path().join(".deploydesk/runtime/staging"))
            .expect("create runtime path");
        let manifest = create_default_manifest(&inspection_fixture());
        let script = runtime_env_script(
            &manifest,
            EnvironmentName::Staging,
            ".deploydesk/runtime/staging",
        )
        .expect("render runtime script");
        let runtime_file =
            "# 原始注释\nDATABASE_URL=postgresql://example\nUNKNOWN_DETAIL=a=b#c\nEMPTY=\n";
        let status = Command::new("bash")
            .current_dir(directory.path())
            .arg("-c")
            .arg(script)
            .env("STAGING_RUNTIME_ENV_FILE", runtime_file)
            .status()
            .expect("run generated script");

        assert!(status.success());
        let deployed = fs::read_to_string(
            directory
                .path()
                .join(".deploydesk/runtime/staging/.runtime.env"),
        )
        .expect("read deployed runtime file");
        assert_eq!(deployed, runtime_file);
    }

    #[test]
    fn whole_runtime_file_rejects_empty_required_values() {
        let tools_available = ["bash", "node"].into_iter().all(|tool| {
            Command::new(tool)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        });
        if !tools_available {
            return;
        }

        let directory = tempfile::tempdir().expect("runtime directory");
        fs::create_dir_all(directory.path().join(".deploydesk/runtime/staging"))
            .expect("create runtime path");
        let manifest = create_default_manifest(&inspection_fixture());
        let script = runtime_env_script(
            &manifest,
            EnvironmentName::Staging,
            ".deploydesk/runtime/staging",
        )
        .expect("render runtime script");
        let status = Command::new("bash")
            .current_dir(directory.path())
            .arg("-c")
            .arg(script)
            .env("STAGING_RUNTIME_ENV_FILE", "DATABASE_URL=\n")
            .stderr(Stdio::null())
            .status()
            .expect("run generated script");

        assert!(!status.success());
    }

    #[test]
    fn generated_cnb_shell_is_syntax_valid_when_bash_is_available() {
        let bash_probe = Command::new("bash")
            .arg("-n")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !matches!(bash_probe, Ok(status) if status.success()) {
            return;
        }
        let manifest = create_default_manifest(&inspection_fixture());
        let pipeline = render_cnb_pipeline(&manifest).expect("render pipeline");
        let parsed: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&pipeline).expect("parse pipeline");
        let mut scripts = Vec::new();
        collect_scripts(&parsed, &mut scripts);
        assert!(!scripts.is_empty());

        for script in scripts {
            let mut file = tempfile::NamedTempFile::new().expect("temporary script");
            file.write_all(script.as_bytes()).expect("write script");
            let status = Command::new("bash")
                .arg("-n")
                .arg(file.path())
                .status()
                .expect("check shell syntax");
            assert!(status.success(), "invalid generated script: {script}");
        }
    }

    #[test]
    fn generated_remote_deploy_shell_is_syntax_valid_when_bash_is_available() {
        let bash_probe = Command::new("bash")
            .arg("-n")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !matches!(bash_probe, Ok(status) if status.success()) {
            return;
        }
        let manifest = create_default_manifest(&inspection_fixture());
        let script = remote_deploy_script(
            &manifest,
            EnvironmentName::Staging,
            ".deploydesk/apps/example/staging",
            "deploydesk-example-staging",
        );
        let mut file = tempfile::NamedTempFile::new().expect("temporary remote script");
        file.write_all(script.as_bytes())
            .expect("write remote script");
        let status = Command::new("bash")
            .arg("-n")
            .arg(file.path())
            .status()
            .expect("check remote shell syntax");
        assert!(status.success(), "invalid remote deploy script: {script}");
    }

    #[test]
    fn generated_deployment_path_route_reconciliation_is_shell_syntax_valid() {
        let bash_probe = Command::new("bash")
            .arg("-n")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !matches!(bash_probe, Ok(status) if status.success()) {
            return;
        }
        let manifest = create_default_manifest(&inspection_fixture());
        let routes = vec![DomainRoute {
            service: "api".to_string(),
            host: "api.example.com".to_string(),
            path: "/".to_string(),
        }];
        let bundle = render_deployment_path_bundle(&manifest, "path-shell", &routes)
            .expect("deployment path bundle");
        let mut file = tempfile::NamedTempFile::new().expect("temporary route script");
        file.write_all(bundle.route_activation_script.as_bytes())
            .expect("write route script");
        let status = Command::new("bash")
            .arg("-n")
            .arg(file.path())
            .status()
            .expect("check route reconciliation syntax");
        assert!(
            status.success(),
            "invalid route reconciliation script: {}",
            bundle.route_activation_script
        );
    }

    #[test]
    fn remote_deploy_activates_safe_routes_before_requesting_takeover() {
        let manifest = create_default_manifest(&inspection_fixture());
        let script = remote_deploy_script(
            &manifest,
            EnvironmentName::Staging,
            ".deploydesk/apps/example/staging",
            "deploydesk-example-staging",
        );

        assert!(script.contains("FILTERED_SITE_FILE"));
        assert!(script.contains("ROUTE_TAKEOVER_REQUIRED"));
        assert!(script.contains("cp \"$FILTERED_SITE_FILE\" \"$SITE_FILE\""));
        assert!(script.contains("caddy validate"));
        assert!(script.contains("caddy reload"));
        assert!(!script.contains("新路由与现有 Caddy 配置冲突，已恢复原路由"));
    }

    #[cfg(unix)]
    #[test]
    fn caddy_route_filter_keeps_safe_hosts_when_one_main_route_conflicts() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().expect("route filter directory");
        let bin = directory.path().join("bin");
        let sites = directory.path().join("sites");
        fs::create_dir_all(&bin).expect("create fake bin");
        fs::create_dir_all(&sites).expect("create sites");
        let fake_docker = bin.join("docker");
        fs::write(
            &fake_docker,
            "#!/bin/sh\nif [ \"$1\" = exec ] && [ \"$3\" = cat ]; then cat \"$FAKE_MAIN\"; exit 0; fi\nexit 1\n",
        )
        .expect("write fake docker");
        let mut permissions = fs::metadata(&fake_docker)
            .expect("fake docker metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_docker, permissions).expect("make fake docker executable");

        let main = directory.path().join("main.caddy");
        let candidate = directory.path().join("candidate.caddy");
        let filtered = directory.path().join("filtered.caddy");
        let conflicts = directory.path().join("conflicts");
        let filter_hosts = directory.path().join("filter-hosts");
        let main_snapshot = directory.path().join("main-snapshot.caddy");
        let site = sites.join("sample-production.caddy");
        fs::write(
            &main,
            "https://API.EXAMPLE.COM.:443, legacy.example.com {\n  reverse_proxy legacy-api:3000\n}\n",
        )
        .expect("write main Caddyfile");
        fs::write(
            &candidate,
            "# candidate\n\napi.example.com {\n  reverse_proxy sample-api:3000\n}\n\nh5.example.com {\n  reverse_proxy sample-h5:80\n}\n\nocr.example.com {\n  reverse_proxy sample-ocr:8000\n}\n",
        )
        .expect("write candidate Caddyfile");

        let helper = caddy_partial_route_activation_script(&[
            "api.example.com".to_string(),
            "h5.example.com".to_string(),
            "ocr.example.com".to_string(),
        ]);
        let script = format!(
            "set -eu\nCADDY_CONTAINER=fake\nCADDY_SITE_DIRECTORY={}\nSITE_FILE={}\nCANDIDATE_FILE={}\nFILTERED_SITE_FILE={}\nMAIN_CONFIG_FILE={}\nROUTE_CONFLICTS_FILE={}\nFILTER_HOSTS_FILE={}\n{}",
            shell_quote(&sites.to_string_lossy()),
            shell_quote(&site.to_string_lossy()),
            shell_quote(&candidate.to_string_lossy()),
            shell_quote(&filtered.to_string_lossy()),
            shell_quote(&main_snapshot.to_string_lossy()),
            shell_quote(&conflicts.to_string_lossy()),
            shell_quote(&filter_hosts.to_string_lossy()),
            helper,
        );
        let status = Command::new("bash")
            .arg("-c")
            .arg(script)
            .env("FAKE_MAIN", &main)
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    bin.to_string_lossy(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .status()
            .expect("run route filter");
        assert!(status.success());

        let filtered = fs::read_to_string(filtered).expect("read filtered Caddyfile");
        assert!(!filtered.contains("api.example.com"));
        assert!(filtered.contains("h5.example.com"));
        assert!(filtered.contains("ocr.example.com"));
        assert_eq!(
            fs::read_to_string(conflicts).expect("read conflicts"),
            "api.example.com\tmain\n"
        );
    }

    fn collect_scripts(value: &serde_yaml_ng::Value, scripts: &mut Vec<String>) {
        match value {
            serde_yaml_ng::Value::Mapping(mapping) => {
                for (key, child) in mapping {
                    if key.as_str() == Some("script") {
                        if let Some(items) = child.as_sequence() {
                            scripts.extend(
                                items
                                    .iter()
                                    .filter_map(serde_yaml_ng::Value::as_str)
                                    .map(ToString::to_string),
                            );
                        }
                    } else {
                        collect_scripts(child, scripts);
                    }
                }
            }
            serde_yaml_ng::Value::Sequence(items) => {
                for item in items {
                    collect_scripts(item, scripts);
                }
            }
            _ => {}
        }
    }
}
