import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ApplyResult,
  CnbRepositoryInput,
  CnbRepositoryResult,
  CnbProjectSetup,
  CnbAccount,
  CnbSecretBundle,
  DeploymentRun,
  OnboardingStep,
  ProviderCheck,
  PipelineIdentityResult,
  RecentProject,
  ServerForm,
  ServerResource,
  SecretStatus,
  RuntimeConfigFile,
  RuntimeConfigStatus,
  RuntimeSecretStatus,
  SourceSyncResult,
  GeneratedSshIdentity,
  SshIdentity,
  SystemPreflight,
  WorkspacePreview,
} from "./types";

export async function selectProjectDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择项目目录",
  });
  return typeof selected === "string" ? selected : null;
}

export async function selectPrivateKey(
  defaultPath?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    defaultPath,
    directory: false,
    multiple: false,
    title: "选择 SSH 私钥",
  });
  return typeof selected === "string" ? selected : null;
}

export async function discoverSshIdentities(): Promise<SshIdentity[]> {
  if (!isTauri()) {
    return [
      {
        name: "abcdeploy_ed25519",
        path: "/Users/demo/.ssh/abcdeploy_ed25519",
        source: "ABCDeploy 专用身份",
        fingerprint: "SHA256:ABCDeployDemoIdentity",
        managed: true,
      },
    ];
  }
  return invoke<SshIdentity[]>("discover_ssh_identities");
}

export async function generateSshIdentity(): Promise<GeneratedSshIdentity> {
  if (!isTauri()) {
    return {
      identity: (await discoverSshIdentities())[0],
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemo abcdeploy",
      created: true,
    };
  }
  return invoke<GeneratedSshIdentity>("generate_ssh_identity");
}

export async function getPreflight(): Promise<SystemPreflight> {
  if (!isTauri()) return demoPreflight;
  return invoke<SystemPreflight>("get_preflight");
}

export async function openProject(path: string): Promise<WorkspacePreview> {
  if (!isTauri()) {
    const workspace = demoWorkspace(path);
    rememberDemoProject(path, workspace);
    return workspace;
  }
  return invoke<WorkspacePreview>("open_project", { path });
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  if (!isTauri()) return readDemoProjects();
  return invoke<RecentProject[]>("list_recent_projects");
}

export async function getAppSetting(key: string): Promise<string | null> {
  if (!isTauri()) {
    return (
      localStorage.getItem(`abcdeploy.setting.${key}`) ??
      (key === "registry.tcr.namespace" ? "demo" : null)
    );
  }
  return invoke<string | null>("get_app_setting", { key });
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(`abcdeploy.setting.${key}`, value);
    return;
  }
  return invoke("set_app_setting", { key, value });
}

export async function saveProjectStep(
  path: string,
  step: OnboardingStep,
): Promise<void> {
  if (!isTauri()) {
    const projects = readDemoProjects().map((project) =>
      project.path === path ? { ...project, currentStep: step } : project,
    );
    localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(projects));
    return;
  }
  return invoke("save_project_step", { path, step });
}

export async function forgetProject(path: string): Promise<boolean> {
  if (!isTauri()) {
    const projects = readDemoProjects();
    const remaining = projects.filter((project) => project.path !== path);
    localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(remaining));
    return remaining.length !== projects.length;
  }
  return invoke<boolean>("forget_project", { path });
}

export async function previewManifest(
  path: string,
  manifestYaml: string,
): Promise<WorkspacePreview> {
  if (!isTauri()) return { ...demoWorkspace(path), manifestYaml };
  return invoke<WorkspacePreview>("preview_manifest", { path, manifestYaml });
}

export async function applyManifest(
  path: string,
  manifestYaml: string,
): Promise<ApplyResult> {
  if (!isTauri()) {
    return {
      planId: "demo-plan",
      writtenFiles: ["deploy.yaml"],
      backupDirectory: `${path}/.deploydesk/backups/demo-plan`,
    };
  }
  return invoke<ApplyResult>("apply_manifest", {
    path,
    manifestYaml,
    confirmed: true,
  });
}

export async function checkDocker(): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "docker",
      ok: true,
      summary: "Docker Engine 29.4.3 可用",
      details: [],
    };
  }
  return invoke<ProviderCheck>("check_docker");
}

export async function checkServer(form: ServerForm): Promise<ProviderCheck> {
  if (!isTauri()) {
    if (form.host && form.user && form.keyPath && !form.hostFingerprint) {
      return {
        provider: "ssh-host-key",
        ok: false,
        summary: "请确认这台服务器的身份指纹",
        details: ["SHA256:ABCDeployDemoServerFingerprint"],
      };
    }
    return {
      provider: "ssh",
      ok: Boolean(form.host && form.user && form.keyPath),
      summary: form.host ? "服务器连接正常" : "请填写服务器信息",
      details: ["未执行远程写操作"],
    };
  }
  return invoke<ProviderCheck>("check_server", {
    name: form.name,
    host: form.host,
    user: form.user,
    keyPath: form.keyPath,
    port: form.port,
    hostFingerprint: form.hostFingerprint,
  });
}

export async function listServers(): Promise<ServerResource[]> {
  if (!isTauri()) return [];
  return invoke<ServerResource[]>("list_servers");
}

export async function bindProjectServer(
  path: string,
  environment: "staging" | "production",
  server: ServerForm,
): Promise<ServerResource> {
  if (!isTauri()) {
    return {
      ...server,
      id: `demo-${server.user}@${server.host}:${server.port}`,
      keyPathExists: true,
      lastCheckedAt: new Date().toISOString(),
    };
  }
  return invoke<ServerResource>("bind_project_server", {
    path,
    environment,
    server,
  });
}

export async function startStagingDeployment(
  path: string,
  expectedRevision?: string,
  preferPushBuild = false,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run = demoRun(path, "staging");
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("start_staging_deployment", {
    path,
    expectedRevision: expectedRevision ?? null,
    preferPushBuild,
  });
}

export async function resumeStagingDeployment(
  runId: string,
  expectedRevision?: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run = readDemoRuns().find((item) => item.id === runId);
    if (!run) throw new Error("找不到这次部署记录");
    const resumed = {
      ...run,
      status: "running" as const,
      currentStage: "build",
      actionKind: null,
      actionUrl: null,
      message: "CNB 已开始构建，关闭应用后也可以继续查看",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(resumed);
    return resumed;
  }
  return invoke<DeploymentRun>("resume_staging_deployment", {
    runId,
    expectedRevision: expectedRevision ?? null,
  });
}

export async function promoteProductionDeployment(
  sourceRunId: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const source = readDemoRuns().find((run) => run.id === sourceRunId);
    if (!source || source.status !== "success") {
      throw new Error("只有健康检查通过的测试版本才能发布生产");
    }
    const run = {
      ...demoRun(source.projectPath, "production"),
      commitSha: source.commitSha,
      sourceRunId,
      candidateTag: source.candidateTag,
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("promote_production_deployment", {
    sourceRunId,
  });
}

export async function refreshDeployment(runId: string): Promise<DeploymentRun> {
  if (!isTauri()) {
    const runs = readDemoRuns();
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error("找不到这次部署记录");
    if (run.status === "running" || run.status === "queued") {
      const updated: DeploymentRun = {
        ...run,
        status: "success",
        currentStage: "complete",
        message:
          run.environment === "production"
            ? "生产环境已按测试通过的同一镜像摘要发布"
            : "测试环境部署完成并通过健康检查",
        completedSteps: [
          "write-config",
          "verify-build",
          "publish-images",
          "prepare-server",
          "deploy",
          "healthcheck",
        ],
        updatedAt: new Date().toISOString(),
      };
      writeDemoRun(updated);
      return updated;
    }
    return run;
  }
  return invoke<DeploymentRun>("refresh_deployment", { runId });
}

export async function listDeploymentRuns(
  path: string,
): Promise<DeploymentRun[]> {
  if (!isTauri())
    return readDemoRuns().filter((run) => run.projectPath === path);
  return invoke<DeploymentRun[]>("list_deployment_runs", { path });
}

export async function listActiveDeploymentRuns(): Promise<DeploymentRun[]> {
  if (!isTauri()) {
    return readDemoRuns().filter((run) =>
      ["queued", "running"].includes(run.status),
    );
  }
  return invoke<DeploymentRun[]>("list_active_deployment_runs");
}

export async function syncExternalDeployments(
  path: string,
): Promise<DeploymentRun[]> {
  if (!isTauri()) return [];
  return invoke<DeploymentRun[]>("sync_external_deployments", { path });
}

export async function bootstrapServerCaddy(
  form: ServerForm,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "caddy",
      ok: true,
      summary: `服务器 ${form.name} 的 ABCDeploy Caddy 已就绪`,
      details: ["已准备统一运行目录，未修改其他反向代理配置"],
    };
  }
  return invoke<ProviderCheck>("bootstrap_server_caddy", {
    name: form.name,
    host: form.host,
    user: form.user,
    keyPath: form.keyPath,
    port: form.port,
    hostFingerprint: form.hostFingerprint,
    confirmed: true,
  });
}

export async function preparePipelineIdentity(
  path: string,
  server: ServerForm,
): Promise<PipelineIdentityResult> {
  if (!isTauri()) {
    return { created: true, fingerprint: "SHA256:DemoDeployIdentity" };
  }
  return invoke<PipelineIdentityResult>("prepare_pipeline_identity", {
    path,
    server,
  });
}

export async function getRuntimeSecretStatus(
  path: string,
  environment: RuntimeSecretStatus["environment"],
  variable: string,
): Promise<RuntimeSecretStatus> {
  if (!isTauri()) {
    return {
      environment,
      variable,
      stored: readDemoSecret(path, environment, variable),
    };
  }
  return invoke<RuntimeSecretStatus>("runtime_secret_status", {
    path,
    environment,
    variable,
  });
}

export async function storeRuntimeSecret(
  path: string,
  environment: RuntimeSecretStatus["environment"],
  variable: string,
  value: string,
): Promise<RuntimeSecretStatus> {
  if (!isTauri()) {
    writeDemoSecret(path, environment, variable);
    return { environment, variable, stored: Boolean(value) };
  }
  return invoke<RuntimeSecretStatus>("store_runtime_secret", {
    path,
    environment,
    variable,
    value,
  });
}

export async function generateRuntimeSecret(
  path: string,
  environment: RuntimeSecretStatus["environment"],
  variable: string,
): Promise<RuntimeSecretStatus> {
  if (!isTauri()) {
    writeDemoSecret(path, environment, variable);
    return { environment, variable, stored: true };
  }
  return invoke<RuntimeSecretStatus>("generate_runtime_secret", {
    path,
    environment,
    variable,
  });
}

export async function loadRuntimeConfig(
  path: string,
  environment: RuntimeConfigFile["environment"],
): Promise<RuntimeConfigFile> {
  if (!isTauri()) {
    const templateContent = demoRuntimeTemplate(environment);
    const content = readDemoRuntimeConfig(path, environment);
    return {
      environment,
      filename: `.env.${environment}`,
      sourceFiles: [".env.example"],
      content: content ?? templateContent,
      templateContent,
      stored: content !== null,
    };
  }
  return invoke<RuntimeConfigFile>("load_runtime_config", {
    path,
    environment,
  });
}

export async function storeRuntimeConfig(
  path: string,
  environment: RuntimeConfigFile["environment"],
  content: string,
): Promise<RuntimeConfigStatus> {
  if (!isTauri()) {
    writeDemoRuntimeConfig(path, environment, content);
    return { environment, filename: `.env.${environment}`, stored: true };
  }
  return invoke<RuntimeConfigStatus>("store_runtime_config", {
    path,
    environment,
    content,
  });
}

export async function prepareCnbSecretBundle(
  path: string,
  environment: RuntimeSecretStatus["environment"],
  secretRepository: string,
  server: ServerForm,
): Promise<CnbSecretBundle> {
  if (!isTauri()) {
    const runtimeConfig = readDemoRuntimeConfig(path, environment);
    const prefix = environment.toUpperCase();
    const runtimeLines = (runtimeConfig ?? "")
      .split("\n")
      .map((line) => `  ${line}`);
    return {
      environment,
      filename: `env.${environment}.yml`,
      fileUrl: `https://cnb.cool/${secretRepository}/-/blob/main/env.${environment}.yml`,
      content: [
        "# ABCDeploy demo",
        `${prefix}_SERVER_HOST: ${server.host}`,
        `${prefix}_RUNTIME_ENV_FILE: |-`,
        ...runtimeLines,
        "",
      ].join("\n"),
      missingVariables: runtimeConfig ? [] : ["RUNTIME_ENV_FILE"],
      deployKeyFingerprint: "SHA256:DemoDeployIdentity",
    };
  }
  return invoke<CnbSecretBundle>("prepare_cnb_secret_bundle", {
    path,
    environment,
    secretRepository,
    server,
  });
}

export async function rollbackEnvironment(
  path: string,
  environment: DeploymentRun["environment"],
  server: ServerForm,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run = {
      ...demoRun(path, environment),
      status: "success" as const,
      currentStage: "complete",
      message: "已安全回滚到上一健康版本",
      completedSteps: ["rollback", "healthcheck"],
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("rollback_environment", {
    path,
    environment,
    server,
    confirmed: true,
  });
}

export async function connectCnb(
  token: string,
  persist: boolean,
): Promise<CnbAccount> {
  if (!isTauri()) {
    return {
      connected: true,
      displayName: "示例用户",
      username: "cnb.demo-user",
      defaultNamespace: "demo",
      namespaces: [
        {
          path: "demo",
          displayName: "示例组织",
          accessRole: "Owner",
          canCreateRepository: true,
        },
      ],
    };
  }
  return invoke("connect_cnb", { token, persist });
}

export async function getCnbAccount(): Promise<CnbAccount> {
  if (!isTauri()) {
    return {
      connected: false,
      displayName: "尚未连接",
      username: "",
      defaultNamespace: "",
      namespaces: [],
    };
  }
  return invoke<CnbAccount>("get_cnb_account");
}

export async function createCnbRepository(
  input: CnbRepositoryInput,
): Promise<CnbRepositoryResult> {
  if (!isTauri()) {
    return {
      repository: `${input.slug.trim()}/${input.name.trim()}`,
      visibility: input.privateRepo ? "private" : "public",
    };
  }
  return invoke("create_cnb_repository", { ...input });
}

export async function ensureCnbRepository(
  slug: string,
  name: string,
): Promise<CnbProjectSetup> {
  if (!isTauri()) {
    return { repository: `${slug}/${name}`, created: true };
  }
  return invoke<CnbProjectSetup>("ensure_cnb_repository", { slug, name });
}

export async function enableCnbAutoTrigger(
  repository: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "cnb-auto-trigger",
      ok: true,
      summary: "CNB 自动构建已开启",
      details: [],
    };
  }
  return invoke<ProviderCheck>("enable_cnb_auto_trigger", { repository });
}

export async function syncProjectToCnb(
  path: string,
  repository: string,
  branch: string,
  allowUncommitted = false,
): Promise<SourceSyncResult> {
  if (!isTauri()) {
    return {
      repository,
      branch,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      committed: true,
    };
  }
  return invoke<SourceSyncResult>("sync_project_to_cnb", {
    path,
    repository,
    branch,
    allowUncommitted,
  });
}

export async function getSecretStatus(key: string): Promise<SecretStatus> {
  if (!isTauri()) {
    return { key, stored: key.startsWith("registry.tcr.") };
  }
  return invoke<SecretStatus>("secret_status", { key });
}

export async function storeSecret(
  key: string,
  value: string,
): Promise<SecretStatus> {
  if (!isTauri()) return { key, stored: Boolean(value) };
  return invoke<SecretStatus>("store_secret", { key, value });
}

export async function deleteSecret(key: string): Promise<SecretStatus> {
  if (!isTauri()) return { key, stored: false };
  return invoke<SecretStatus>("delete_secret", { key });
}

const demoPreflight: SystemPreflight = {
  operating_system: "macos",
  architecture: "aarch64",
  ready_for_cloud_deploy: true,
  ready_for_local_preview: true,
  tools: [
    {
      name: "Git",
      available: true,
      version: "git version 2.50.1",
      required_for: "读取和同步项目代码",
      resolution: null,
    },
    {
      name: "内置安全连接",
      available: true,
      version: "ABCDeploy SSH",
      required_for: "安全连接目标服务器",
      resolution: null,
    },
    {
      name: "Docker",
      available: true,
      version: "29.4.3",
      required_for: "本地完整预览",
      resolution: null,
    },
    {
      name: "Node.js",
      available: true,
      version: "v22.22.3",
      required_for: "本地开发预览",
      resolution: null,
    },
  ],
};

const DEMO_PROJECTS_KEY = "abcdeploy.demo.projects";
const DEMO_RUNS_KEY = "abcdeploy.demo.runs";
const DEMO_SECRETS_KEY = "abcdeploy.demo.secrets";
const DEMO_RUNTIME_CONFIGS_KEY = "abcdeploy.demo.runtime-configs";

function demoSecretId(path: string, environment: string, variable: string) {
  return `${path}:${environment}:${variable}`;
}

function readDemoSecret(path: string, environment: string, variable: string) {
  const values = JSON.parse(
    localStorage.getItem(DEMO_SECRETS_KEY) ?? "[]",
  ) as string[];
  return values.includes(demoSecretId(path, environment, variable));
}

function writeDemoSecret(path: string, environment: string, variable: string) {
  const values = JSON.parse(
    localStorage.getItem(DEMO_SECRETS_KEY) ?? "[]",
  ) as string[];
  const id = demoSecretId(path, environment, variable);
  localStorage.setItem(
    DEMO_SECRETS_KEY,
    JSON.stringify([...new Set([...values, id])]),
  );
}

function demoRuntimeTemplate(environment: string) {
  return [
    "# 项目运行配置",
    `DEPLOYDESK_ENV=${environment}`,
    "DATABASE_URL=",
    "JWT_SECRET=",
    "MINIMAX_API_KEY=",
    "MINIMAX_BASE_URL=https://api.minimax.chat/v1",
    "VITE_API_BASE_URL=",
    "",
  ].join("\n");
}

function readDemoRuntimeConfig(path: string, environment: string) {
  try {
    const values = JSON.parse(
      localStorage.getItem(DEMO_RUNTIME_CONFIGS_KEY) ?? "{}",
    ) as Record<string, string>;
    return values[demoSecretId(path, environment, "runtime-file")] ?? null;
  } catch {
    return null;
  }
}

function writeDemoRuntimeConfig(
  path: string,
  environment: string,
  content: string,
) {
  const values = JSON.parse(
    localStorage.getItem(DEMO_RUNTIME_CONFIGS_KEY) ?? "{}",
  ) as Record<string, string>;
  values[demoSecretId(path, environment, "runtime-file")] = content;
  localStorage.setItem(DEMO_RUNTIME_CONFIGS_KEY, JSON.stringify(values));
}

function readDemoProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(DEMO_PROJECTS_KEY);
    if (!raw) return [];
    const runs = readDemoRuns();
    return (JSON.parse(raw) as RecentProject[]).map((project) => {
      const projectRuns = runs
        .filter((run) => run.projectPath === project.path)
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime(),
        );
      const latest = projectRuns[0];
      return {
        ...project,
        latestStatus: latest?.status ?? project.latestStatus ?? null,
        latestEnvironment:
          latest?.environment ?? project.latestEnvironment ?? null,
        latestMessage: latest?.message ?? project.latestMessage ?? null,
        activeRunCount: projectRuns.filter((run) =>
          ["queued", "running"].includes(run.status),
        ).length,
      };
    });
  } catch {
    return [];
  }
}

function rememberDemoProject(path: string, workspace: WorkspacePreview) {
  const projects = readDemoProjects();
  const previous = projects.find((project) => project.path === path);
  const recent: RecentProject = {
    id: previous?.id ?? `demo-${workspace.inspection.project_name}`,
    path,
    name: workspace.inspection.project_name,
    currentStep: previous?.currentStep ?? "inspection",
    manifestExists: workspace.manifestExists,
    serviceCount: workspace.inspection.services.length,
    lastOpenedAt: new Date().toISOString(),
    pathExists: true,
    latestStatus: previous?.latestStatus ?? null,
    latestEnvironment: previous?.latestEnvironment ?? null,
    latestMessage: previous?.latestMessage ?? null,
    activeRunCount: previous?.activeRunCount ?? 0,
  };
  localStorage.setItem(
    DEMO_PROJECTS_KEY,
    JSON.stringify([
      recent,
      ...projects.filter((project) => project.path !== path),
    ]),
  );
}

function demoRun(
  path: string,
  environment: DeploymentRun["environment"],
): DeploymentRun {
  const now = new Date().toISOString();
  return {
    id: `demo-${environment}-${Date.now()}`,
    projectPath: path,
    projectName: "ecat-energy",
    environment,
    status: "running",
    currentStage: environment === "production" ? "deploy" : "build",
    buildSerial: `demo-${Date.now()}`,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    sourceRunId: null,
    candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    artifacts: [
      {
        service: "api",
        image: "ccr.example.com/demo/ecat-api",
        digest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ],
    actionKind: null,
    actionUrl: "https://cnb.cool/owner/ecat-energy/-/tags",
    issueCode: null,
    repository: "owner/ecat-energy",
    branch: "main",
    message:
      environment === "production"
        ? "正在按已验证镜像摘要发布生产环境"
        : "CNB 已开始构建，关闭应用后也可以继续查看",
    completedSteps: ["write-config"],
    startedAt: now,
    updatedAt: now,
  };
}

function readDemoRuns(): DeploymentRun[] {
  try {
    const raw = localStorage.getItem(DEMO_RUNS_KEY);
    return raw
      ? (JSON.parse(raw) as DeploymentRun[]).map((run) => ({
          ...run,
          candidateTag: run.candidateTag ?? null,
          artifacts: run.artifacts ?? [],
          issueCode: run.issueCode ?? null,
        }))
      : [];
  } catch {
    return [];
  }
}

function writeDemoRun(run: DeploymentRun) {
  const runs = readDemoRuns();
  const nextRuns = [run, ...runs.filter((item) => item.id !== run.id)];
  localStorage.setItem(DEMO_RUNS_KEY, JSON.stringify(nextRuns));
  const projects = readDemoProjects().map((project) => {
    if (project.path !== run.projectPath) return project;
    return {
      ...project,
      latestStatus: run.status,
      latestEnvironment: run.environment,
      latestMessage: run.message,
      activeRunCount: nextRuns.filter(
        (item) =>
          item.projectPath === project.path &&
          ["queued", "running"].includes(item.status),
      ).length,
    };
  });
  localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(projects));
}

function demoWorkspace(path: string): WorkspacePreview {
  return {
    manifestExists: false,
    manifestYaml: `version: 1
project:
  name: ecat-energy
source:
  release_branch: main
environments:
  staging:
    target:
      server: staging-server
    branch: null
    domains: []
    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.staging.yml
  production:
    target:
      server: production-server
    branch: null
    domains: []
    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml
providers:
  build:
    kind: cnb
    repository: owner/ecat-energy
  registry:
    kind: cnb
    repository: owner/ecat-energy
  reverse_proxy: caddy
release:
  production_mode: approval
`,
    validation: { valid: true, issues: [] },
    inspection: {
      project_root: path,
      project_name: "ecat-energy",
      package_manager: "pnpm",
      monorepo: true,
      frameworks: [
        {
          framework: "nest_js",
          path: "apps/api",
          confidence: 98,
          evidence: ["依赖 @nestjs/core", "包含构建脚本"],
        },
        {
          framework: "vite",
          path: "apps/admin",
          confidence: 98,
          evidence: ["依赖 vite", "包含构建脚本"],
        },
        {
          framework: "taro",
          path: "apps/miniapp",
          confidence: 98,
          evidence: ["依赖 @tarojs/taro", "包含构建脚本"],
        },
        {
          framework: "prisma",
          path: "prisma/schema.prisma",
          confidence: 100,
          evidence: ["检测到 schema.prisma"],
        },
      ],
      services: [
        {
          id: "api",
          package_name: "@ecat-energy/api",
          path: "apps/api",
          kind: "api",
          framework: "nest_js",
          dockerfile: "apps/api/Dockerfile",
          suggested_port: 3000,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
        {
          id: "admin",
          package_name: "@ecat-energy/admin",
          path: "apps/admin",
          kind: "static",
          framework: "vite",
          dockerfile: "apps/admin/Dockerfile",
          suggested_port: 80,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
        {
          id: "miniapp",
          package_name: "@ecat-energy/miniapp",
          path: "apps/miniapp",
          kind: "static",
          framework: "taro",
          dockerfile: "apps/miniapp/Dockerfile",
          suggested_port: 80,
          build_command: "corepack pnpm run build",
          confidence: 98,
        },
      ],
      prisma_schemas: ["prisma/schema.prisma"],
      dockerfiles: [
        "apps/api/Dockerfile",
        "apps/admin/Dockerfile",
        "apps/miniapp/Dockerfile",
      ],
      environment_files: [".env.example"],
      environment_variables: [
        { name: "DATABASE_URL", secret: true, source: ".env.example" },
        { name: "JWT_SECRET", secret: true, source: ".env.example" },
        { name: "VITE_API_BASE_URL", secret: false, source: ".env.example" },
      ],
      diagnostics: [],
    },
    plan: {
      id: "fb6cbe0ce86dc7ed",
      project: "ecat-energy",
      generated_at: new Date().toISOString(),
      environments: [
        {
          name: "development",
          branch: null,
          target: "本机",
          automatic: false,
          approval_required: false,
        },
        {
          name: "staging",
          branch: "test",
          target: "staging-server",
          automatic: true,
          approval_required: false,
        },
        {
          name: "production",
          branch: "main",
          target: "production-server",
          automatic: false,
          approval_required: true,
        },
      ],
      changes: [
        {
          path: "deploy.yaml",
          kind: "create",
          after: "version: 1\nproject:\n  name: ecat-energy\n",
          sensitive: false,
        },
        {
          path: ".cnb.yml",
          kind: "update",
          before: "main:\n  push: []\n",
          after: "test:\n  push: []\nmain:\n  push: []\n",
          sensitive: false,
        },
        {
          path: ".deploydesk/generated/production/docker-compose.yml",
          kind: "create",
          after:
            "name: ecat-energy-production\nservices:\n  api:\n    image: ${DEPLOYDESK_API_IMAGE}\n",
          sensitive: false,
        },
      ],
      steps: [
        {
          id: "write-config",
          title: "生成部署配置",
          detail: "写入 deploy.yaml、Compose、Caddy 和流水线配置",
          executor: "local",
          destructive: false,
        },
        {
          id: "verify-build",
          title: "验证并构建程序",
          detail: "在 CNB 标准 Linux 环境执行项目验证命令",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "publish-images",
          title: "制作不可变镜像",
          detail: "镜像以提交版本标识",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "deploy",
          title: "部署并验证测试候选",
          detail: "同步配置，按摘要启动容器并等待健康检查",
          executor: "server",
          destructive: false,
        },
        {
          id: "promote-release",
          title: "晋级已验证镜像",
          detail: "为通过测试的摘要创建提交唯一的验证标记",
          executor: "cnb",
          destructive: false,
        },
        {
          id: "healthcheck",
          title: "部署生产并验证访问",
          detail: "生产复用同一摘要；失败时恢复上一个健康版本",
          executor: "server",
          destructive: false,
        },
      ],
      user_actions: [
        {
          id: "connect-cnb",
          title: "连接 CNB",
          detail: "授权后创建或选择云原生构建仓库",
          category: "authorization",
          required: true,
        },
        {
          id: "server-staging",
          title: "连接测试服务器",
          detail: "验证 SSH 登录",
          category: "server",
          required: true,
        },
        {
          id: "domain-staging",
          title: "填写测试域名",
          detail: "生成 DNS 记录并检查解析",
          category: "dns",
          required: false,
        },
        {
          id: "secrets-staging",
          title: "配置测试环境密钥文件",
          detail: "按生成模板在 CNB Web 端填写",
          category: "secret",
          required: true,
        },
        {
          id: "server-production",
          title: "连接生产服务器",
          detail: "验证 SSH 登录",
          category: "server",
          required: true,
        },
        {
          id: "domain-production",
          title: "填写生产域名",
          detail: "生成 DNS 记录并检查解析",
          category: "dns",
          required: true,
        },
        {
          id: "secrets-production",
          title: "配置生产环境密钥文件",
          detail: "按生成模板在 CNB Web 端填写",
          category: "secret",
          required: true,
        },
        {
          id: "approve-production",
          title: "确认发布生产",
          detail: "生产只拉取测试通过的同一镜像摘要",
          category: "approval",
          required: true,
        },
      ],
      warnings: [],
    },
  };
}
