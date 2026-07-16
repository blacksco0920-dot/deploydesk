use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use walkdir::{DirEntry, WalkDir};

use crate::error::{DeployError, Result};
use crate::model::{
    DetectedEnvironmentVariable, DetectedService, Diagnostic, DiagnosticLevel, Framework,
    FrameworkDetection, InspectionReport, PackageManager, ServiceKind,
};

#[derive(Debug, Default, Deserialize)]
struct PackageJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    scripts: BTreeMap<String, String>,
    #[serde(default)]
    dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(rename = "devDependencies", default)]
    dev_dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    workspaces: Option<serde_json::Value>,
    #[serde(rename = "packageManager", default)]
    package_manager: String,
}

impl PackageJson {
    fn has_dependency(&self, name: &str) -> bool {
        self.dependencies.contains_key(name) || self.dev_dependencies.contains_key(name)
    }

    fn dependency_names(&self) -> impl Iterator<Item = &str> {
        self.dependencies
            .keys()
            .chain(self.dev_dependencies.keys())
            .map(String::as_str)
    }
}

pub fn inspect_project(root: &Path) -> Result<InspectionReport> {
    if !root.is_dir() {
        return Err(DeployError::MissingProject(root.to_path_buf()));
    }

    let root = root
        .canonicalize()
        .map_err(|source| DeployError::ReadFile {
            path: root.to_path_buf(),
            source,
        })?;
    let package_manager = detect_package_manager(&root);
    let mut diagnostics = Vec::new();
    let mut package_files = Vec::new();
    let mut dockerfiles = Vec::new();
    let mut prisma_schemas = Vec::new();
    let mut env_files = Vec::new();
    let mut python_manifests = Vec::new();

    for entry in WalkDir::new(&root)
        .max_depth(6)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
    {
        let Ok(entry) = entry else {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Warning,
                code: "unreadable_path".to_string(),
                message: "部分目录无法读取，已跳过".to_string(),
                path: None,
            });
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy();
        let relative = relative_string(&root, entry.path());
        match file_name.as_ref() {
            "package.json" => package_files.push(entry.path().to_path_buf()),
            "Dockerfile" => dockerfiles.push(relative),
            "schema.prisma" => prisma_schemas.push(relative),
            ".env.example" => env_files.push(entry.path().to_path_buf()),
            "requirements.txt" | "pyproject.toml" => {
                python_manifests.push(entry.path().to_path_buf());
            }
            _ if file_name.starts_with("Dockerfile.") => dockerfiles.push(relative),
            _ => {}
        }
    }

    package_files.sort();
    dockerfiles.sort();
    prisma_schemas.sort();
    env_files.sort();

    let root_package_path = root.join("package.json");
    let root_package = read_package(&root_package_path).ok();
    // The selected directory is the product boundary. Root package names are often
    // copied from templates (for example, two unrelated projects both named
    // `finagent`) and using them here can make server directories, Docker networks,
    // and the sidebar collide. Package names remain available on detected services;
    // the project itself uses the stable folder name users chose.
    let project_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .map_or_else(|| "new-project".to_string(), sanitize_id);
    let monorepo = root.join("pnpm-workspace.yaml").exists()
        || root_package
            .as_ref()
            .is_some_and(|package| package.workspaces.is_some());

    let mut frameworks = Vec::new();
    let mut services = Vec::new();
    for package_path in package_files {
        let package = match read_package(&package_path) {
            Ok(package) => package,
            Err(error) => {
                diagnostics.push(Diagnostic {
                    level: DiagnosticLevel::Warning,
                    code: "invalid_package_json".to_string(),
                    message: error.to_string(),
                    path: Some(relative_string(&root, &package_path)),
                });
                continue;
            }
        };
        let package_dir = package_path.parent().unwrap_or(&root);
        let relative_dir = relative_string(&root, package_dir);
        let mut detected = detect_frameworks(&package, &relative_dir);
        if (package_dir != root || !monorepo)
            && primary_framework(&detected).is_none()
            && let Some(script) = generic_node_start_script(&package)
        {
            detected.push(FrameworkDetection {
                framework: Framework::NodeJs,
                path: ".".to_string(),
                confidence: 96,
                evidence: vec![format!("包含 {script} 启动脚本")],
            });
        }
        frameworks.extend(detected.iter().cloned());

        if let Some(primary) = primary_framework(&detected) {
            let kind = service_kind(primary.framework);
            let id_source = if package.name.trim().is_empty() {
                package_dir
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("service")
            } else {
                package.name.rsplit('/').next().unwrap_or(&package.name)
            };
            let service_id = sanitize_id(id_source);
            let dockerfile = find_service_dockerfile(&root, package_dir, &service_id, &dockerfiles);
            let detected_port = dockerfile
                .as_deref()
                .and_then(|path| dockerfile_exposed_port(&root.join(path)))
                .or_else(|| {
                    (primary.framework == Framework::NodeJs)
                        .then(|| declared_node_port(package_dir))
                        .flatten()
                })
                .unwrap_or_else(|| suggested_port(primary.framework));
            let is_mobile_client = matches!(primary.framework, Framework::Taro | Framework::UniApp);
            let has_h5_build = package.scripts.contains_key("build:h5");
            if is_mobile_client && !has_h5_build && dockerfile.is_none() {
                diagnostics.push(Diagnostic {
                    level: DiagnosticLevel::Info,
                    code: "client_only_package_detected".to_string(),
                    message: format!(
                        "已识别 {service_id} 为原生移动端产物，不需要部署为服务器服务"
                    ),
                    path: Some(relative_string(&root, &package_path)),
                });
                continue;
            }
            let build_command = if primary.framework == Framework::NodeJs {
                package
                    .scripts
                    .get("build")
                    .map(|_| package_script_command_at(package_manager, "build", &relative_dir))
            } else if is_mobile_client && has_h5_build {
                Some(package_script_command(package_manager, "build:h5"))
            } else {
                package
                    .scripts
                    .get("build")
                    .map(|_| package_script_command(package_manager, "build"))
            };
            let start_command = if primary.framework == Framework::NodeJs {
                generic_node_start_script(&package)
                    .and_then(|script| package.scripts.get(script).cloned())
            } else {
                package
                    .scripts
                    .contains_key("start:prod")
                    .then(|| package_script_command(package_manager, "start:prod"))
            };
            services.push(DetectedService {
                id: service_id,
                package_name: package.name,
                path: if relative_dir.is_empty() {
                    ".".to_string()
                } else {
                    relative_dir
                },
                kind,
                framework: primary.framework,
                dockerfile,
                suggested_port: detected_port,
                build_command,
                start_command,
                dependency_file: Some(relative_string(&root, &package_path)),
                confidence: primary.confidence,
            });
        }
    }

    let mut python_directories = BTreeMap::<PathBuf, Vec<PathBuf>>::new();
    for manifest in python_manifests {
        if let Some(directory) = manifest.parent() {
            python_directories
                .entry(directory.to_path_buf())
                .or_default()
                .push(manifest);
        }
    }
    for (directory, manifests) in python_directories {
        let manifest_mentions_fastapi = manifests.iter().any(|path| {
            fs::read_to_string(path)
                .is_ok_and(|content| content.to_ascii_lowercase().contains("fastapi"))
        });
        let Some((module, variable, source_path)) = fastapi_entrypoint(&directory) else {
            if manifest_mentions_fastapi {
                diagnostics.push(Diagnostic {
                    level: DiagnosticLevel::Warning,
                    code: "python_entrypoint_uncertain".to_string(),
                    message: "检测到 FastAPI 依赖，但尚未确定启动入口".to_string(),
                    path: Some(relative_string(&root, &directory)),
                });
            }
            continue;
        };
        let relative_dir = relative_string(&root, &directory);
        let id_source = directory
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("python-api");
        let service_id = sanitize_id(id_source);
        let dockerfile = find_service_dockerfile(&root, &directory, &service_id, &dockerfiles);
        let dependency_file = manifests
            .iter()
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name == "requirements.txt")
            })
            .or_else(|| manifests.first())
            .map(|path| relative_string(&root, path));
        let path = if relative_dir.is_empty() {
            ".".to_string()
        } else {
            relative_dir
        };
        frameworks.push(FrameworkDetection {
            framework: Framework::FastApi,
            path: path.clone(),
            confidence: if manifest_mentions_fastapi { 99 } else { 96 },
            evidence: vec![
                "检测到 FastAPI 应用实例".to_string(),
                format!("启动入口 {module}:{variable}"),
            ],
        });
        services.push(DetectedService {
            id: service_id.clone(),
            package_name: service_id,
            path,
            kind: ServiceKind::Api,
            framework: Framework::FastApi,
            dockerfile,
            suggested_port: 8000,
            build_command: None,
            start_command: Some(format!(
                "uvicorn {module}:{variable} --host 0.0.0.0 --port 8000"
            )),
            dependency_file,
            confidence: if manifest_mentions_fastapi { 99 } else { 96 },
        });
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Info,
            code: "python_service_detected".to_string(),
            message: format!("已识别 Python API：{source_path}"),
            path: Some(relative_string(&root, &directory)),
        });
    }

    if monorepo {
        frameworks.push(FrameworkDetection {
            framework: Framework::PnpmWorkspace,
            path: ".".to_string(),
            confidence: 100,
            evidence: vec!["检测到 workspace 配置".to_string()],
        });
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Info,
            code: "monorepo_detected".to_string(),
            message: "已按 monorepo 扫描应用和共享包".to_string(),
            path: Some(".".to_string()),
        });
    }
    for schema in &prisma_schemas {
        frameworks.push(FrameworkDetection {
            framework: Framework::Prisma,
            path: schema.clone(),
            confidence: 100,
            evidence: vec!["检测到 schema.prisma".to_string()],
        });
    }

    deduplicate_frameworks(&mut frameworks);
    deduplicate_services(&mut services);
    if services.is_empty() {
        diagnostics.push(Diagnostic {
            level: DiagnosticLevel::Error,
            code: "no_deployable_service".to_string(),
            message: "未识别到可部署的前端或后端服务".to_string(),
            path: None,
        });
    }
    for service in &services {
        if service.dockerfile.is_none() {
            diagnostics.push(Diagnostic {
                level: DiagnosticLevel::Info,
                code: "missing_dockerfile".to_string(),
                message: format!("服务 {} 将由部署规划选择容器构建方式", service.id),
                path: Some(service.path.clone()),
            });
        }
    }

    let environment_files = env_files
        .iter()
        .map(|path| relative_string(&root, path))
        .collect();
    let environment_variables = inspect_environment_files(&root, &env_files);
    Ok(InspectionReport {
        project_root: root.to_string_lossy().into_owned(),
        project_name,
        package_manager,
        monorepo,
        frameworks,
        services,
        prisma_schemas,
        dockerfiles,
        environment_files,
        environment_variables,
        diagnostics,
    })
}

fn read_package(path: &Path) -> Result<PackageJson> {
    let raw = fs::read_to_string(path).map_err(|source| DeployError::ReadFile {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&raw).map_err(|source| DeployError::Json {
        path: path.to_path_buf(),
        source,
    })
}

fn detect_frameworks(package: &PackageJson, path: &str) -> Vec<FrameworkDetection> {
    let mut detections = Vec::new();
    let candidates = [
        (Framework::NestJs, "@nestjs/core", "NestJS"),
        (Framework::NextJs, "next", "Next.js"),
        (Framework::UniApp, "@dcloudio/uni-app", "UniApp"),
        (Framework::Taro, "@tarojs/taro", "Taro"),
        (Framework::Vite, "vite", "Vite"),
    ];
    for (framework, dependency, _label) in candidates {
        if package.has_dependency(dependency) {
            let mut evidence = vec![format!("依赖 {dependency}")];
            if package.scripts.contains_key("build") || package.scripts.contains_key("build:h5") {
                evidence.push("包含构建脚本".to_string());
            }
            detections.push(FrameworkDetection {
                framework,
                path: if path.is_empty() {
                    ".".to_string()
                } else {
                    path.to_string()
                },
                confidence: if evidence.len() > 1 { 98 } else { 92 },
                evidence,
            });
        }
    }
    if package.has_dependency("prisma") || package.has_dependency("@prisma/client") {
        detections.push(FrameworkDetection {
            framework: Framework::Prisma,
            path: if path.is_empty() {
                ".".to_string()
            } else {
                path.to_string()
            },
            confidence: 95,
            evidence: package
                .dependency_names()
                .filter(|name| *name == "prisma" || *name == "@prisma/client")
                .map(|name| format!("依赖 {name}"))
                .collect(),
        });
    }
    detections
}

fn primary_framework(detections: &[FrameworkDetection]) -> Option<&FrameworkDetection> {
    [
        Framework::NodeJs,
        Framework::NestJs,
        Framework::NextJs,
        Framework::FastApi,
        Framework::UniApp,
        Framework::Taro,
        Framework::Vite,
    ]
    .into_iter()
    .find_map(|framework| {
        detections
            .iter()
            .find(|detection| detection.framework == framework)
    })
}

const fn service_kind(framework: Framework) -> ServiceKind {
    match framework {
        Framework::NestJs | Framework::FastApi => ServiceKind::Api,
        Framework::NodeJs | Framework::NextJs => ServiceKind::Web,
        Framework::Vite | Framework::UniApp | Framework::Taro => ServiceKind::Static,
        Framework::Prisma | Framework::PnpmWorkspace => ServiceKind::Worker,
    }
}

const fn suggested_port(framework: Framework) -> u16 {
    match framework {
        Framework::NodeJs
        | Framework::NestJs
        | Framework::NextJs
        | Framework::Prisma
        | Framework::PnpmWorkspace => 3000,
        Framework::FastApi => 8000,
        Framework::Vite | Framework::UniApp | Framework::Taro => 80,
    }
}

fn generic_node_start_script(package: &PackageJson) -> Option<&'static str> {
    ["start:prod", "start"]
        .into_iter()
        .find(|script| package.scripts.contains_key(*script))
}

fn dockerfile_exposed_port(path: &Path) -> Option<u16> {
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let instruction = fields.next()?;
        if !instruction.eq_ignore_ascii_case("EXPOSE") {
            return None;
        }
        fields.find_map(|field| {
            field
                .split_once('/')
                .map_or(field, |(port, _)| port)
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
        })
    })
}

fn declared_node_port(package_dir: &Path) -> Option<u16> {
    let content = fs::read_to_string(package_dir.join(".env.example")).ok()?;
    ["PORT", "APP_PORT", "SERVER_PORT"]
        .into_iter()
        .find_map(|expected| {
            content.lines().find_map(|line| {
                let trimmed = line.trim().strip_prefix("export ").unwrap_or(line.trim());
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return None;
                }
                let (key, value) = trimmed.split_once('=')?;
                if key.trim() != expected {
                    return None;
                }
                value
                    .split('#')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .trim_matches(['\'', '"'])
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
            })
        })
}

fn fastapi_entrypoint(directory: &Path) -> Option<(String, String, String)> {
    for entry in WalkDir::new(directory)
        .max_depth(5)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
        .filter_map(std::result::Result::ok)
    {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("py")
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(variable) = content.lines().find_map(|line| {
            let compact = line.trim();
            let (left, _) = compact
                .split_once("= FastAPI(")
                .or_else(|| compact.split_once("=FastAPI("))?;
            let variable = left.trim();
            (!variable.is_empty()
                && variable
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
            .then(|| variable.to_string())
        }) else {
            continue;
        };
        let Ok(relative) = entry.path().strip_prefix(directory) else {
            continue;
        };
        let module_path = relative
            .strip_prefix("src")
            .unwrap_or(relative)
            .with_extension("");
        let module = module_path
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join(".");
        if module.is_empty() {
            continue;
        }
        return Some((
            module,
            variable,
            relative.to_string_lossy().replace('\\', "/"),
        ));
    }
    None
}

fn find_service_dockerfile(
    root: &Path,
    package_dir: &Path,
    service_id: &str,
    dockerfiles: &[String],
) -> Option<String> {
    let direct = package_dir.join("Dockerfile");
    if direct.is_file() {
        return Some(relative_string(root, &direct));
    }
    let package_relative = relative_string(root, package_dir);
    dockerfiles
        .iter()
        .find(|path| path.starts_with(&package_relative))
        .or_else(|| {
            let expected_name = format!("Dockerfile.{service_id}");
            dockerfiles.iter().find(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(&expected_name))
            })
        })
        .cloned()
}

fn inspect_environment_files(root: &Path, files: &[PathBuf]) -> Vec<DetectedEnvironmentVariable> {
    let mut seen = HashSet::new();
    let mut variables = Vec::new();
    for file in files {
        let Ok(raw) = fs::read_to_string(file) else {
            continue;
        };
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, _)) = trimmed.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if key.is_empty() || !seen.insert(key.to_string()) {
                continue;
            }
            variables.push(DetectedEnvironmentVariable {
                name: key.to_string(),
                secret: looks_secret(key),
                source: relative_string(root, file),
            });
        }
    }
    variables.sort_by(|left, right| left.name.cmp(&right.name));
    variables
}

fn looks_secret(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "PASSWORD",
        "TOKEN",
        "SECRET",
        "PRIVATE_KEY",
        "API_KEY",
        "ACCESS_KEY",
        "DATABASE_URL",
        "REDIS_URL",
        "CONNECTION_STRING",
        "DSN",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn detect_package_manager(root: &Path) -> PackageManager {
    if root.join("pnpm-lock.yaml").exists() || root.join("pnpm-workspace.yaml").exists() {
        PackageManager::Pnpm
    } else if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
        PackageManager::Bun
    } else if root.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else if root.join("package-lock.json").exists() {
        PackageManager::Npm
    } else {
        read_package(&root.join("package.json"))
            .ok()
            .map(|package| package.package_manager.to_ascii_lowercase())
            .map_or(PackageManager::Unknown, |declared| {
                if declared.starts_with("pnpm@") {
                    PackageManager::Pnpm
                } else if declared.starts_with("yarn@") {
                    PackageManager::Yarn
                } else if declared.starts_with("bun@") {
                    PackageManager::Bun
                } else if declared.starts_with("npm@") {
                    PackageManager::Npm
                } else {
                    PackageManager::Unknown
                }
            })
    }
}

fn package_script_command(manager: PackageManager, script: &str) -> String {
    match manager {
        PackageManager::Pnpm => format!("corepack pnpm run {script}"),
        PackageManager::Yarn => format!("corepack yarn {script}"),
        PackageManager::Bun => format!("bun run {script}"),
        PackageManager::Npm | PackageManager::Unknown => format!("npm run {script}"),
    }
}

fn package_script_command_at(manager: PackageManager, script: &str, path: &str) -> String {
    if path.is_empty() || path == "." {
        return package_script_command(manager, script);
    }
    let directory = shell_quote(path);
    match manager {
        PackageManager::Pnpm => format!("corepack pnpm --dir {directory} run {script}"),
        PackageManager::Yarn => format!("corepack yarn --cwd {directory} {script}"),
        PackageManager::Bun => format!("bun --cwd {directory} run {script}"),
        PackageManager::Npm | PackageManager::Unknown => {
            format!("npm --prefix {directory} run {script}")
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn relative_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !matches!(
        name.as_ref(),
        ".git"
            | ".deploydesk"
            | "node_modules"
            | "target"
            | "dist"
            | ".next"
            | ".turbo"
            | "coverage"
    )
}

fn deduplicate_frameworks(frameworks: &mut Vec<FrameworkDetection>) {
    let mut seen = HashSet::new();
    frameworks.retain(|item| seen.insert((item.framework, item.path.clone())));
    frameworks.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| format!("{:?}", left.framework).cmp(&format!("{:?}", right.framework)))
    });
}

fn deduplicate_services(services: &mut [DetectedService]) {
    let mut counts = BTreeMap::<String, usize>::new();
    for service in services.iter_mut() {
        let count = counts.entry(service.id.clone()).or_default();
        if *count > 0 {
            service.id = format!("{}-{}", service.id, *count + 1);
        }
        *count += 1;
    }
    services.sort_by(|left, right| left.path.cmp(&right.path));
}

fn sanitize_id(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut last_dash = false;
    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            result.push(character);
            last_dash = false;
        } else if !last_dash && !result.is_empty() {
            result.push('-');
            last_dash = true;
        }
    }
    let result = result.trim_matches('-');
    if result.len() < 2 {
        "app-service".to_string()
    } else {
        result.chars().take(63).collect()
    }
}

#[cfg(test)]
#[must_use]
pub fn inspection_fixture() -> InspectionReport {
    InspectionReport {
        project_root: "/tmp/example".to_string(),
        project_name: "example-app".to_string(),
        package_manager: PackageManager::Pnpm,
        monorepo: true,
        frameworks: vec![FrameworkDetection {
            framework: Framework::NestJs,
            path: "apps/api".to_string(),
            confidence: 98,
            evidence: vec!["依赖 @nestjs/core".to_string()],
        }],
        services: vec![DetectedService {
            id: "api".to_string(),
            package_name: "@example/api".to_string(),
            path: "apps/api".to_string(),
            kind: ServiceKind::Api,
            framework: Framework::NestJs,
            dockerfile: Some("apps/api/Dockerfile".to_string()),
            suggested_port: 3000,
            build_command: Some("corepack pnpm run build".to_string()),
            start_command: Some("corepack pnpm run start:prod".to_string()),
            dependency_file: Some("apps/api/package.json".to_string()),
            confidence: 98,
        }],
        prisma_schemas: vec!["apps/api/prisma/schema.prisma".to_string()],
        dockerfiles: vec!["apps/api/Dockerfile".to_string()],
        environment_files: vec![".env.example".to_string()],
        environment_variables: vec![DetectedEnvironmentVariable {
            name: "DATABASE_URL".to_string(),
            secret: true,
            source: ".env.example".to_string(),
        }],
        diagnostics: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn detects_supported_frameworks_without_reading_secret_values() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/api/prisma")).expect("create app");
        fs::write(
            directory.path().join("pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
        )
        .expect("workspace");
        fs::write(
            directory.path().join("pnpm-lock.yaml"),
            "lockfileVersion: '9.0'\n",
        )
        .expect("lock");
        fs::write(
            directory.path().join("package.json"),
            r#"{"name":"sample-app","private":true,"workspaces":["apps/*"]}"#,
        )
        .expect("root package");
        fs::write(
            directory.path().join("apps/api/package.json"),
            r#"{"name":"@sample/api","scripts":{"build":"nest build"},"dependencies":{"@nestjs/core":"1","@prisma/client":"1"}}"#,
        )
        .expect("api package");
        fs::write(
            directory.path().join("apps/api/Dockerfile"),
            "FROM node:22\nEXPOSE 3300/tcp\n",
        )
        .expect("dockerfile");
        fs::write(
            directory.path().join("apps/api/prisma/schema.prisma"),
            "datasource db { provider = \"postgresql\" }\n",
        )
        .expect("schema");
        fs::write(
            directory.path().join(".env.example"),
            "DATABASE_URL=postgresql://example\nAPI_KEY=must-not-appear\n",
        )
        .expect("env");
        fs::create_dir_all(directory.path().join(".deploydesk/generated/staging"))
            .expect("generated directory");
        fs::write(
            directory
                .path()
                .join(".deploydesk/generated/staging/.env.example"),
            "INTERNAL_GENERATED_VALUE=ignore-me\n",
        )
        .expect("generated env");

        let report = inspect_project(directory.path()).expect("inspection");
        assert!(report.monorepo);
        assert_eq!(report.services.len(), 1);
        assert_eq!(report.services[0].framework, Framework::NestJs);
        assert_eq!(report.services[0].suggested_port, 3300);
        assert_eq!(report.prisma_schemas.len(), 1);
        assert_eq!(report.environment_files, [".env.example"]);
        assert!(
            report
                .environment_variables
                .iter()
                .all(|variable| variable.name != "INTERNAL_GENERATED_VALUE")
        );
        assert!(
            report
                .environment_variables
                .iter()
                .all(|variable| variable.secret)
        );
        let json = serde_json::to_string(&report).expect("serialize");
        assert!(!json.contains("must-not-appear"));
        assert!(!json.contains("postgresql://example"));
    }

    #[test]
    fn uses_the_selected_folder_as_project_identity_instead_of_a_copied_package_name() {
        let directory = tempdir().expect("tempdir");
        let project = directory.path().join("FinAgentCrm");
        fs::create_dir_all(&project).expect("project directory");
        fs::write(
            project.join("package.json"),
            r#"{"name":"finagent","private":true}"#,
        )
        .expect("package");

        let report = inspect_project(&project).expect("inspection");

        assert_eq!(report.project_name, "finagentcrm");
    }

    #[test]
    fn recognizes_the_declared_package_manager_before_a_lockfile_exists() {
        let directory = tempdir().expect("tempdir");
        fs::write(
            directory.path().join("package.json"),
            r#"{"name":"new-app","private":true,"packageManager":"pnpm@10.28.1"}"#,
        )
        .expect("package");

        let report = inspect_project(directory.path()).expect("inspection");

        assert_eq!(report.package_manager, PackageManager::Pnpm);
    }

    #[test]
    fn recognizes_a_root_node_service_from_its_standard_start_script() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("src")).expect("source directory");
        fs::write(
            directory.path().join("package.json"),
            r#"{
              "name":"plain-node-service",
              "private":true,
              "scripts":{
                "dev":"node src/server.js",
                "start":"node src/server.js"
              }
            }"#,
        )
        .expect("package");
        fs::write(
            directory.path().join("src/server.js"),
            "require('node:http').createServer((_req, res) => res.end('ok')).listen(process.env.PORT || 4310);\n",
        )
        .expect("server");
        fs::write(
            directory.path().join(".env.example"),
            "PORT='4310' # 本机和服务器共用\nADMIN_PASSWORD=\n",
        )
        .expect("environment example");

        let report = inspect_project(directory.path()).expect("inspection");

        assert_eq!(report.services.len(), 1);
        let service = &report.services[0];
        assert_eq!(service.id, "plain-node-service");
        assert_eq!(service.framework, Framework::NodeJs);
        assert_eq!(service.kind, ServiceKind::Web);
        assert_eq!(service.suggested_port, 4310);
        assert_eq!(service.start_command.as_deref(), Some("node src/server.js"));
        assert_eq!(service.dependency_file.as_deref(), Some("package.json"));
        assert!(report.frameworks.iter().any(|framework| {
            framework.framework == Framework::NodeJs
                && framework.evidence == ["包含 start 启动脚本"]
        }));
        assert!(
            report
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "no_deployable_service")
        );
    }

    #[test]
    fn recognizes_plain_node_services_inside_a_workspace_without_duplicating_the_root() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/api")).expect("service directory");
        fs::write(
            directory.path().join("package.json"),
            r#"{
              "name":"workspace-root",
              "private":true,
              "scripts":{"start":"pnpm --recursive start"}
            }"#,
        )
        .expect("root package");
        fs::write(
            directory.path().join("pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
        )
        .expect("workspace");
        fs::write(
            directory.path().join("apps/api/package.json"),
            r#"{
              "name":"@audit/api",
              "private":true,
              "scripts":{
                "build":"node build.js",
                "start":"node dist/server.js"
              }
            }"#,
        )
        .expect("service package");
        fs::write(
            directory.path().join("apps/api/.env.example"),
            "APP_PORT=4600\n",
        )
        .expect("service environment");

        let report = inspect_project(directory.path()).expect("inspection");

        assert!(report.monorepo);
        assert_eq!(report.services.len(), 1);
        let service = &report.services[0];
        assert_eq!(service.id, "api");
        assert_eq!(service.path, "apps/api");
        assert_eq!(service.framework, Framework::NodeJs);
        assert_eq!(service.suggested_port, 4600);
        assert_eq!(
            service.build_command.as_deref(),
            Some("corepack pnpm --dir 'apps/api' run build")
        );
        assert_eq!(
            service.start_command.as_deref(),
            Some("node dist/server.js")
        );
    }

    #[test]
    fn shell_quotes_workspace_directories_in_generated_commands() {
        assert_eq!(
            package_script_command_at(PackageManager::Pnpm, "start", "apps/customer's-api"),
            "corepack pnpm --dir 'apps/customer'\"'\"'s-api' run start"
        );
    }

    #[test]
    fn reuses_service_named_dockerfiles_from_an_infra_directory() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/api")).expect("create app");
        fs::create_dir_all(directory.path().join("infra")).expect("create infra");
        fs::write(
            directory.path().join("pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
        )
        .expect("workspace");
        fs::write(
            directory.path().join("package.json"),
            r#"{"name":"sample-app","private":true}"#,
        )
        .expect("root package");
        fs::write(
            directory.path().join("apps/api/package.json"),
            r#"{"name":"@sample/api","scripts":{"build":"nest build"},"dependencies":{"@nestjs/core":"1"}}"#,
        )
        .expect("api package");
        fs::write(
            directory.path().join("infra/Dockerfile.api"),
            "FROM node:22-slim\n",
        )
        .expect("dockerfile");

        let report = inspect_project(directory.path()).expect("inspection");
        assert_eq!(
            report.services[0].dockerfile.as_deref(),
            Some("infra/Dockerfile.api")
        );
    }

    #[test]
    fn detects_fastapi_service_entrypoint_and_dependency_file() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/ocr/src/finagent_ocr"))
            .expect("create Python app");
        fs::write(
            directory.path().join("apps/ocr/requirements.txt"),
            "fastapi==0.115.0\nuvicorn==0.32.0\n",
        )
        .expect("requirements");
        fs::write(
            directory.path().join("apps/ocr/src/finagent_ocr/main.py"),
            "from fastapi import FastAPI\n\napp = FastAPI(title='OCR')\n",
        )
        .expect("FastAPI entrypoint");
        fs::write(
            directory.path().join("apps/ocr/Dockerfile"),
            "FROM python:3.12-slim\n",
        )
        .expect("Dockerfile");

        let report = inspect_project(directory.path()).expect("inspection");
        assert_eq!(report.services.len(), 1);
        let service = &report.services[0];
        assert_eq!(service.id, "ocr");
        assert_eq!(service.framework, Framework::FastApi);
        assert_eq!(service.kind, ServiceKind::Api);
        assert_eq!(service.suggested_port, 8000);
        assert_eq!(service.dockerfile.as_deref(), Some("apps/ocr/Dockerfile"));
        assert_eq!(
            service.dependency_file.as_deref(),
            Some("apps/ocr/requirements.txt")
        );
        assert_eq!(
            service.start_command.as_deref(),
            Some("uvicorn finagent_ocr.main:app --host 0.0.0.0 --port 8000")
        );
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "python_service_detected"
                && diagnostic.message.contains("src/finagent_ocr/main.py")
        }));
    }

    #[test]
    fn excludes_native_mini_apps_but_keeps_explicit_h5_builds() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("apps/miniapp")).expect("create miniapp");
        fs::create_dir_all(directory.path().join("apps/h5")).expect("create h5");
        fs::write(
            directory.path().join("pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
        )
        .expect("workspace");
        fs::write(
            directory.path().join("package.json"),
            r#"{"name":"sample-mobile","private":true}"#,
        )
        .expect("root package");
        fs::write(
            directory.path().join("apps/miniapp/package.json"),
            r#"{"name":"@sample/miniapp","scripts":{"build":"taro build --type weapp"},"dependencies":{"@tarojs/taro":"4"}}"#,
        )
        .expect("miniapp package");
        fs::write(
            directory.path().join("apps/h5/package.json"),
            r#"{"name":"@sample/h5","scripts":{"build:h5":"taro build --type h5"},"dependencies":{"@tarojs/taro":"4"}}"#,
        )
        .expect("h5 package");

        let report = inspect_project(directory.path()).expect("inspection");

        assert_eq!(report.services.len(), 1);
        assert_eq!(report.services[0].id, "h5");
        assert_eq!(
            report.services[0].build_command.as_deref(),
            Some("corepack pnpm run build:h5")
        );
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "client_only_package_detected"
                && diagnostic.message.contains("miniapp")
        }));
    }
}
