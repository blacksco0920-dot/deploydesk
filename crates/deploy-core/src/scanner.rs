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
    let project_name = root_package
        .as_ref()
        .map(|package| package.name.trim())
        .filter(|name| !name.is_empty())
        .map_or_else(
            || {
                root.file_name()
                    .and_then(|name| name.to_str())
                    .map_or_else(|| "new-project".to_string(), sanitize_id)
            },
            sanitize_id,
        );
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
        let detected = detect_frameworks(&package, &relative_dir);
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
            let dockerfile = find_service_dockerfile(&root, package_dir, &dockerfiles);
            let build_command = package
                .scripts
                .get("build")
                .map(|_| package_script_command(package_manager, "build"))
                .or_else(|| {
                    package
                        .scripts
                        .get("build:h5")
                        .map(|_| package_script_command(package_manager, "build:h5"))
                });
            services.push(DetectedService {
                id: sanitize_id(id_source),
                package_name: package.name,
                path: if relative_dir.is_empty() {
                    ".".to_string()
                } else {
                    relative_dir
                },
                kind,
                framework: primary.framework,
                dockerfile,
                suggested_port: suggested_port(primary.framework),
                build_command,
                confidence: primary.confidence,
            });
        }
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
                level: DiagnosticLevel::Warning,
                code: "missing_dockerfile".to_string(),
                message: format!("服务 {} 需要生成 Dockerfile", service.id),
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
        Framework::NestJs,
        Framework::NextJs,
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
        Framework::NestJs => ServiceKind::Api,
        Framework::NextJs => ServiceKind::Web,
        Framework::Vite | Framework::UniApp | Framework::Taro => ServiceKind::Static,
        Framework::Prisma | Framework::PnpmWorkspace => ServiceKind::Worker,
    }
}

const fn suggested_port(framework: Framework) -> u16 {
    match framework {
        Framework::NestJs | Framework::NextJs | Framework::Prisma | Framework::PnpmWorkspace => {
            3000
        }
        Framework::Vite | Framework::UniApp | Framework::Taro => 80,
    }
}

fn find_service_dockerfile(
    root: &Path,
    package_dir: &Path,
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
        PackageManager::Unknown
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
            "FROM node:22\n",
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
}
