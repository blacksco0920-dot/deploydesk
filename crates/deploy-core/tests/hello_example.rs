use std::collections::HashSet;
use std::path::PathBuf;

use deploy_core::{
    FileChangeKind, Framework, build_plan, inspect_project, load_manifest, validate_manifest,
};

fn example_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/hello-fullstack")
}

#[test]
fn runnable_example_stays_in_sync_with_the_generator() {
    let root = example_root();
    let report = inspect_project(&root).expect("inspect hello example");
    let frameworks = report
        .frameworks
        .iter()
        .map(|item| item.framework)
        .collect::<HashSet<_>>();
    assert_eq!(report.services.len(), 2);
    assert!(frameworks.contains(&Framework::NestJs));
    assert!(frameworks.contains(&Framework::Vite));
    assert!(frameworks.contains(&Framework::PnpmWorkspace));

    let manifest = load_manifest(&root.join("deploy.yaml")).expect("load example manifest");
    let validation = validate_manifest(&manifest);
    assert!(
        validation.valid,
        "validation issues: {:?}",
        validation.issues
    );
    let api = manifest
        .services
        .iter()
        .find(|service| service.id == "api")
        .expect("api service");
    let web = manifest
        .services
        .iter()
        .find(|service| service.id == "web")
        .expect("web service");
    assert!(
        api.runtime_env
            .iter()
            .any(|variable| variable.name == "API_GREETING")
    );
    assert!(
        web.runtime_env
            .iter()
            .any(|variable| variable.name == "VITE_API_BASE_URL")
    );
    assert!(!web.runtime_env.iter().any(|variable| variable.secret));

    let plan = build_plan(&root, &report, &manifest).expect("build example plan");
    assert!(
        plan.changes
            .iter()
            .all(|change| change.kind == FileChangeKind::Unchanged),
        "example generated files need refreshing"
    );
}
