use std::collections::HashSet;
use std::path::PathBuf;

use deploy_core::{
    EnvironmentName, Framework, build_plan, create_default_manifest, inspect_project,
    validate_manifest,
};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ecat-energy")
}

#[test]
fn recognizes_ecat_structure_without_exposing_values() {
    let report = inspect_project(&fixture_root()).expect("inspect Ecat fixture");
    let frameworks = report
        .frameworks
        .iter()
        .map(|item| item.framework)
        .collect::<HashSet<_>>();
    let service_ids = report
        .services
        .iter()
        .map(|service| service.id.as_str())
        .collect::<HashSet<_>>();

    assert_eq!(report.project_name, "ecat-energy");
    assert!(report.monorepo);
    assert_eq!(service_ids, HashSet::from(["api", "admin", "miniapp"]));
    assert!(frameworks.contains(&Framework::NestJs));
    assert!(frameworks.contains(&Framework::Vite));
    assert!(frameworks.contains(&Framework::Taro));
    assert!(frameworks.contains(&Framework::Prisma));
    assert!(frameworks.contains(&Framework::PnpmWorkspace));

    let serialized = serde_json::to_string(&report).expect("serialize report");
    assert!(!serialized.contains("DO_NOT_LEAK_SENTINEL"));
    assert!(serialized.contains("DATABASE_URL"));
    assert!(serialized.contains("JWT_SECRET"));
}

#[test]
fn creates_three_isolated_environments_for_ecat() {
    let root = fixture_root();
    let report = inspect_project(&root).expect("inspect Ecat fixture");
    let manifest = create_default_manifest(&report);
    let validation = validate_manifest(&manifest);
    let api = manifest
        .services
        .iter()
        .find(|service| service.id == "api")
        .expect("api service");
    let admin = manifest
        .services
        .iter()
        .find(|service| service.id == "admin")
        .expect("admin service");
    let miniapp = manifest
        .services
        .iter()
        .find(|service| service.id == "miniapp")
        .expect("miniapp service");

    assert!(
        validation.valid,
        "validation issues: {:?}",
        validation.issues
    );
    assert!(
        api.runtime_env
            .iter()
            .any(|variable| variable.name == "JWT_SECRET")
    );
    assert!(!admin.runtime_env.iter().any(|variable| variable.secret));
    assert!(!miniapp.runtime_env.iter().any(|variable| variable.secret));
    assert_eq!(manifest.source.integration_branch, "test");
    assert_eq!(manifest.source.stable_branch, "main");
    assert_eq!(
        manifest
            .environments
            .get(EnvironmentName::Staging)
            .branch
            .as_deref(),
        Some("test")
    );
    assert_eq!(
        manifest
            .environments
            .get(EnvironmentName::Production)
            .branch
            .as_deref(),
        Some("main")
    );
    assert_ne!(
        manifest.environments.staging.target.namespace,
        manifest.environments.production.target.namespace
    );

    let plan = build_plan(&root, &report, &manifest).expect("build deployment plan");
    for environment in ["development", "staging", "production"] {
        for file in ["docker-compose.yml", "Caddyfile"] {
            let expected = format!(".deploydesk/generated/{environment}/{file}");
            assert!(plan.changes.iter().any(|change| change.path == expected));
        }
    }
    assert!(plan.changes.iter().any(|change| change.path == ".cnb.yml"));
}
