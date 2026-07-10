use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::{DeployError, Result};
use crate::model::{
    EnvironmentConfig, EnvironmentName, ProductionMode, ProjectManifest, RegistryConfig,
    ServiceConfig, ServiceKind, SourceProvider,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ComposeFile {
    name: String,
    services: BTreeMap<String, ComposeService>,
    networks: BTreeMap<String, ComposeNetwork>,
}

#[derive(Debug, Serialize)]
struct ComposeService {
    image: String,
    restart: String,
    env_file: Vec<String>,
    environment: BTreeMap<String, String>,
    networks: BTreeMap<String, ComposeServiceNetwork>,
    labels: BTreeMap<String, String>,
    healthcheck: ComposeHealthcheck,
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
    if manifest.source.provider == SourceProvider::Github {
        files.push(GeneratedFile {
            path: ".github/workflows/sync-cnb.yml".to_string(),
            content: render_github_sync(manifest)?,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn render_compose(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    environment: &EnvironmentConfig,
) -> Result<String> {
    let network_name = format!("deploydesk-{}-{}", manifest.project.name, name.as_str());
    let mut services = BTreeMap::new();
    for service in &manifest.services {
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
        let health_command = match service.kind {
            ServiceKind::Static => format!(
                "wget -q --spider http://127.0.0.1:{}{}",
                service.container_port, service.healthcheck.path
            ),
            ServiceKind::Api | ServiceKind::Web | ServiceKind::Worker => format!(
                "node -e \"fetch('http://127.0.0.1:{}{}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
                service.container_port, service.healthcheck.path
            ),
        };
        services.insert(
            service.id.clone(),
            ComposeService {
                image: format!("${{{image_variable}:?请填写不可变镜像地址}}"),
                restart: "unless-stopped".to_string(),
                env_file: vec![".runtime.env".to_string()],
                environment: runtime,
                networks: BTreeMap::from([(
                    "apps".to_string(),
                    ComposeServiceNetwork {
                        aliases: vec![service_alias(manifest, name, service)],
                    },
                )]),
                labels,
                healthcheck: ComposeHealthcheck {
                    test: vec!["CMD-SHELL".to_string(), health_command],
                    interval: format!("{}s", service.healthcheck.interval_seconds),
                    timeout: "5s".to_string(),
                    retries: service.healthcheck.retries,
                    start_period: "20s".to_string(),
                },
            },
        );
    }
    let compose = ComposeFile {
        name: environment.target.namespace.clone(),
        services,
        networks: BTreeMap::from([(
            "apps".to_string(),
            ComposeNetwork {
                external: true,
                name: network_name,
            },
        )]),
    };
    let mut content = serde_yaml_ng::to_string(&compose).map_err(|source| DeployError::Yaml {
        path: format!("generated/{}/docker-compose.yml", name.as_str()).into(),
        source,
    })?;
    content.insert_str(0, "# 由 DeployDesk 生成。真实 .env 只保存在目标环境。\n");
    Ok(content)
}

fn render_env_example(
    manifest: &ProjectManifest,
    name: EnvironmentName,
    environment: &EnvironmentConfig,
) -> String {
    let mut lines = vec![
        "# 由 DeployDesk 生成，仅包含变量名和非敏感默认值。".to_string(),
        format!("DEPLOYDESK_ENV={}", name.as_str()),
    ];
    for service in &manifest.services {
        lines.push(format!("{}=", image_variable(service)));
    }
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
    environment: &EnvironmentConfig,
) -> Result<String> {
    let prefix = name.as_str().to_ascii_uppercase();
    let mut values = BTreeMap::<String, String>::from([
        (format!("{prefix}_SERVER_HOST"), String::new()),
        (format!("{prefix}_SERVER_PORT"), "22".to_string()),
        (format!("{prefix}_SERVER_USER"), String::new()),
        (format!("{prefix}_SERVER_SSH_KEY"), String::new()),
        (format!("{prefix}_SERVER_KNOWN_HOSTS"), String::new()),
    ]);
    if environment.database.is_some() {
        values.insert(format!("{prefix}_DATABASE_URL"), String::new());
    }
    if environment.redis_namespace.is_some() {
        values.insert(format!("{prefix}_REDIS_URL"), String::new());
    }
    for variable in manifest
        .services
        .iter()
        .flat_map(|service| &service.runtime_env)
    {
        values
            .entry(format!("{prefix}_{}", variable.name))
            .or_insert_with(|| variable.default.clone().unwrap_or_default());
    }
    if matches!(manifest.providers.registry, RegistryConfig::Tcr { .. }) {
        values.insert("TCR_USERNAME".to_string(), String::new());
        values.insert("TCR_PASSWORD".to_string(), String::new());
    }
    let mut content = serde_yaml_ng::to_string(&values).map_err(|source| DeployError::Yaml {
        path: format!("generated/{}/secret.example.yml", name.as_str()).into(),
        source,
    })?;
    content.insert_str(
        0,
        concat!(
            "# 仅包含字段名和空占位符。请在 CNB 密钥仓库 Web 页面填写，勿提交真实值。\n",
            "# SSH 私钥可在 Web 编辑器中改用 YAML 的 | 多行格式。\n",
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
        "# {} / {}，由 DeployDesk 生成",
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
        lines.push(format!("{} {{", route.host));
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

fn render_cnb_pipeline(manifest: &ProjectManifest) -> Result<String> {
    let staging = integration_pipeline(manifest)?;
    let release = release_pipeline(manifest)?;

    let mut root = Map::new();
    root.insert(
        manifest.source.integration_branch.clone(),
        json!({ "push": [staging] }),
    );
    root.insert(
        manifest.source.stable_branch.clone(),
        json!({ "push": [release] }),
    );
    if manifest.release.production_mode == ProductionMode::Approval {
        root.insert(
            "$".to_string(),
            json!({ "api_trigger_production": [production_pipeline(manifest)?] }),
        );
    }
    let mut content =
        serde_yaml_ng::to_string(&Value::Object(root)).map_err(|source| DeployError::Yaml {
            path: ".cnb.yml".into(),
            source,
        })?;
    content.insert_str(
        0,
        "# 由 DeployDesk 生成。流水线只引用密钥，不在仓库保存密钥值。\n",
    );
    Ok(content)
}

fn integration_pipeline(manifest: &ProjectManifest) -> Result<Value> {
    let mut stages = build_stages(manifest);
    stages.push(json!({
        "name": "部署测试环境",
        "script": [deploy_script(
            manifest,
            EnvironmentName::Staging,
            ReleaseChannel::Candidate,
        )?]
    }));
    let imports = [secret_import(manifest, EnvironmentName::Staging)];
    Ok(pipeline_definition(
        "deploydesk-integration",
        &imports,
        EnvironmentName::Staging,
        &stages,
    ))
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
        "env": { "DEPLOYDESK_ENV": environment.as_str() },
        "stages": stages
    })
}

fn build_stages(manifest: &ProjectManifest) -> Vec<Value> {
    let mut stages = vec![
        system_tools_stage(),
        json!({
            "name": "安装依赖",
            "script": [manifest.project.commands.install]
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
        "script": ["apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*"]
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
        RegistryConfig::Tcr { registry, .. } => format!(
            "test -n \"$TCR_USERNAME\"\ntest -n \"$TCR_PASSWORD\"\nprintf '%s' \"$TCR_PASSWORD\" | docker login {} --username \"$TCR_USERNAME\" --password-stdin",
            shell_quote(registry)
        ),
    }
}

fn build_script(manifest: &ProjectManifest, service: &ServiceConfig) -> String {
    let repository = image_repository(manifest, &service.image);
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

fn promote_script(manifest: &ProjectManifest) -> String {
    let mut lines = vec![
        "set -eu".to_string(),
        format!("IMAGE_TAG=\"{}\"", image_tag_expression(manifest)),
        "VERIFIED_TAG=\"verified-${IMAGE_TAG}\"".to_string(),
    ];
    for service in &manifest.services {
        let repository = image_repository(manifest, &service.image);
        lines.push(format!("IMAGE_REPOSITORY={}", shell_quote(&repository)));
        lines.push(
            "IMAGE_DIGEST=\"$(docker buildx imagetools inspect \"${IMAGE_REPOSITORY}:${IMAGE_TAG}\" --format '{{.Manifest.Digest}}')\""
                .to_string(),
        );
        lines.push(
            "case \"$IMAGE_DIGEST\" in sha256:*) ;; *) echo '镜像摘要解析失败' >&2; exit 1 ;; esac"
                .to_string(),
        );
        lines.push(
            "docker buildx imagetools create --prefer-index=false --tag \"${IMAGE_REPOSITORY}:${VERIFIED_TAG}\" \"${IMAGE_REPOSITORY}@${IMAGE_DIGEST}\""
                .to_string(),
        );
        lines.push(
            "VERIFIED_DIGEST=\"$(docker buildx imagetools inspect \"${IMAGE_REPOSITORY}:${VERIFIED_TAG}\" --format '{{.Manifest.Digest}}')\""
                .to_string(),
        );
        lines.push("test \"$VERIFIED_DIGEST\" = \"$IMAGE_DIGEST\"".to_string());
    }
    lines.join("\n")
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
        let repository_variable = format!("{variable}_REPOSITORY");
        let digest_variable = format!("{variable}_DIGEST");
        lines.push(format!(
            "{repository_variable}={}",
            shell_quote(&image_repository(manifest, &service.image))
        ));
        lines.push(format!(
            "{digest_variable}=\"$(docker buildx imagetools inspect \"${{{repository_variable}}}:${{RELEASE_TAG}}\" --format '{{{{.Manifest.Digest}}}}')\""
        ));
        lines.push(format!(
            "case \"${{{digest_variable}}}\" in sha256:*) ;; *) echo '服务 {} 的镜像摘要无效' >&2; exit 1 ;; esac",
            service.id
        ));
        lines.push(format!(
            "{variable}=\"${{{repository_variable}}}@${{{digest_variable}}}\""
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
        "test -n \"$SERVER_HOST\"".to_string(),
        "test -n \"$SERVER_USER\"".to_string(),
        "test -n \"$SERVER_SSH_KEY\"".to_string(),
        "test -n \"$SERVER_KNOWN_HOSTS\"".to_string(),
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

    Ok([
        "node <<'DEPLOYDESK_NODE'".to_string(),
        "const fs = require(\"node:fs\");".to_string(),
        format!("const variables = {specs_json};"),
        format!("const outputPath = {output_path};"),
        format!("const lines = [{environment_line}];"),
        "const missing = [];".to_string(),
        "for (const variable of variables) {".to_string(),
        "  const configured = Object.prototype.hasOwnProperty.call(process.env, variable.source);"
            .to_string(),
        "  const value = configured ? process.env[variable.source] : (variable.default ?? \"\");"
            .to_string(),
        "  if (variable.required && !value) missing.push(variable.source);".to_string(),
        "  if (/\\r|\\n/.test(value)) {".to_string(),
        "    console.error(`密钥仓库字段 ${variable.source} 不支持换行值`);".to_string(),
        "    process.exit(1);".to_string(),
        "  }".to_string(),
        "  lines.push(`${variable.name}=${JSON.stringify(value)}`);".to_string(),
        "}".to_string(),
        "if (missing.length) {".to_string(),
        "  console.error(`缺少密钥仓库字段：${missing.join(\", \")}`);".to_string(),
        "  process.exit(1);".to_string(),
        "}".to_string(),
        "fs.writeFileSync(outputPath, `${lines.join(\"\\n\")}\\n`, { mode: 0o600 });".to_string(),
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
        RegistryConfig::Tcr { registry, .. } => {
            let command = format!(
                "IFS= read -r registry_user; test -n \"$registry_user\"; docker login {} --username \"$registry_user\" --password-stdin",
                shell_quote(registry)
            );
            format!(
                "{{ printf '%s\\n' \"$TCR_USERNAME\"; printf '%s' \"$TCR_PASSWORD\"; }} | {ssh} {}",
                shell_quote(&command)
            )
        }
    }
}

fn remote_deploy_script(
    manifest: &ProjectManifest,
    environment: EnvironmentName,
    remote_directory: &str,
    network: &str,
) -> String {
    let compose = "docker compose --env-file .release.env -f docker-compose.yml";
    let site_name = format!("{}-{}.caddy", manifest.project.name, environment.as_str());
    let prune_from = manifest.release.keep_releases.saturating_add(1);
    format!(
        r#"set -eu
cd {remote_directory}
backup_file() {{
  if [ -f "$1" ]; then cp "$1" "$1.previous"; else rm -f "$1.previous"; fi
}}
restore_previous() {{
  for file in docker-compose.yml .runtime.env .release.env Caddyfile; do
    if [ -f "$file.previous" ]; then cp "$file.previous" "$file"; fi
  done
}}
for file in docker-compose.yml .runtime.env .release.env Caddyfile; do
  test -f "$file.next"
  backup_file "$file"
  mv "$file.next" "$file"
done
chmod 600 .runtime.env .release.env
if {compose} config --quiet && \
   {compose} pull && \
   {compose} up -d --remove-orphans --wait --wait-timeout 180; then
  release_id="$(sed -n 's/^DEPLOYDESK_RELEASE_ID=//p' .release.env | head -n 1)"
else
  deploy_status=$?
  if [ "{auto_rollback}" = "true" ] && [ -f .release.env.previous ]; then
    restore_previous
    {compose} pull || true
    {compose} up -d --remove-orphans --wait --wait-timeout 180 || true
  fi
  exit "$deploy_status"
fi
case "$release_id" in ''|*[!A-Za-z0-9._-]*) echo '发布记录标识无效' >&2; exit 1 ;; esac
mkdir -p .history "$HOME/.deploydesk/caddy/sites"
cp .release.env ".history/$release_id.env"
old_releases="$(ls -1t .history/*.env 2>/dev/null | tail -n +{prune_from} || true)"
if [ -n "$old_releases" ]; then printf '%s\n' "$old_releases" | xargs rm -f; fi
cp Caddyfile "$HOME/.deploydesk/caddy/sites/{site_name}"
if docker inspect deploydesk-caddy >/dev/null 2>&1; then
  docker network connect {network} deploydesk-caddy 2>/dev/null || true
  docker exec deploydesk-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker exec deploydesk-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  echo 'ROUTE_PENDING: 应用已健康运行，服务器尚未初始化 DeployDesk Caddy。'
fi"#,
        remote_directory = shell_quote(remote_directory),
        compose = compose,
        auto_rollback = manifest.release.auto_rollback,
        prune_from = prune_from,
        site_name = site_name,
        network = shell_quote(network),
    )
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
        .replace("{commit}", "${CNB_COMMIT_SHORT}")
}

fn image_repository(manifest: &ProjectManifest, image: &str) -> String {
    match &manifest.providers.registry {
        RegistryConfig::Cnb { repository } => {
            format!("docker.cnb.cool/{repository}/{image}")
        }
        RegistryConfig::Tcr {
            registry,
            namespace,
        } => format!("{registry}/{namespace}/{image}"),
    }
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
                "branches": [
                    manifest.source.integration_branch,
                    manifest.source.stable_branch
                ]
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
                        "run": "test -n \"$CNB_PUSH_TOKEN\"\ngit remote add cnb \"https://oauth2:${CNB_PUSH_TOKEN}@cnb.cool/${CNB_REPOSITORY}.git\"\ngit push cnb \"HEAD:${GITHUB_REF_NAME}\" --force"
                    }
                ]
            }
        }
    });
    let mut content = serde_yaml_ng::to_string(&workflow).map_err(|source| DeployError::Yaml {
        path: ".github/workflows/sync-cnb.yml".into(),
        source,
    })?;
    content.insert_str(0, "# 由 DeployDesk 生成。\n");
    Ok(content)
}

fn image_variable(service: &ServiceConfig) -> String {
    let service_id = service.id.replace('-', "_").to_ascii_uppercase();
    format!("DEPLOYDESK_{service_id}_IMAGE")
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::Command;

    use super::*;
    use crate::model::DomainRoute;
    use crate::plan::create_default_manifest;
    use crate::scanner::inspection_fixture;

    #[test]
    fn renders_three_isolated_compose_files_and_two_branch_pipeline() {
        let mut manifest = create_default_manifest(&inspection_fixture());
        manifest.environments.staging.domains.push(DomainRoute {
            service: "api".to_string(),
            host: "api.staging.example.com".to_string(),
            path: "/".to_string(),
        });
        let files = render_project_files(&manifest).expect("render files");
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/generated/staging/docker-compose.yml"
                && file.content.contains("example-app-staging")
                && file.content.contains("example-app-staging-api")
                && file.content.contains(".runtime.env")
        }));
        assert!(files.iter().any(|file| {
            file.path == ".deploydesk/generated/production/docker-compose.yml"
                && file.content.contains("example-app-production")
        }));
        let pipeline = files
            .iter()
            .find(|file| file.path == ".cnb.yml")
            .expect("pipeline");
        assert!(pipeline.content.contains("test:"));
        assert!(pipeline.content.contains("main:"));
        assert!(pipeline.content.contains("api_trigger_production"));
        assert!(pipeline.content.contains("在测试环境验证生产候选"));
        assert!(pipeline.content.contains("标记已验证镜像摘要"));
        assert!(pipeline.content.contains("verified-${IMAGE_TAG}"));
        assert!(pipeline.content.contains("{{.Manifest.Digest}}"));
        assert!(pipeline.content.contains("StrictHostKeyChecking=yes"));
        assert!(pipeline.content.contains(".release.env.previous"));
        assert!(pipeline.content.contains("--wait-timeout 180"));
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
        assert!(secret_example.content.contains("STAGING_DATABASE_URL"));
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
    fn generated_cnb_shell_is_syntax_valid_when_bash_is_available() {
        if Command::new("bash").arg("--version").output().is_err() {
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
