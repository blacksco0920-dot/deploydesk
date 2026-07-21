import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ApplyResult,
  CnbRepositoryInput,
  CnbRepositoryResult,
  CnbProjectSetup,
  CnbAccount,
  CnbSecretBundle,
  ConfigProfile,
  ConfigProfileInput,
  ConnectionKind,
  ConnectionResource,
  DeploymentAttempt,
  DeploymentPath,
  DeploymentPathInput,
  DeploymentRun,
  DnsProviderHint,
  ExistingProjectConfig,
  EnvironmentConfigBindings,
  LocalEnvWriteResult,
  LocalDevelopmentSupport,
  LocalPreviewStatus,
  LocalInfrastructureStatus,
  OnboardingStep,
  ProjectEnvironment,
  ProjectConnectionBindings,
  ProjectVersion,
  ProjectProfileBinding,
  ProviderCheck,
  PublicRouteStatus,
  PipelineIdentityResult,
  RecentProject,
  RelinkProjectResult,
  RouteConflictCheck,
  ServerForm,
  ServerResource,
  SecretStatus,
  RuntimeConfigFile,
  RuntimeConfigRecommendation,
  RuntimeConfigStatus,
  RuntimeConfigSyncStatus,
  RuntimeEnvironment,
  RuntimeSecretStatus,
  SourceSyncResult,
  GeneratedSshIdentity,
  SshIdentity,
  SystemPreflight,
  WorkspacePreview,
  VersionValidation,
  VersionValidationState,
} from "./types";
import { deploymentVersionKey } from "./lib/projects";

export async function selectProjectDirectory(
  title = "选择 AI 生成的整个项目文件夹（不要只选前端或后端）",
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title,
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
    const adoption = readDemoWorkspaceAdoption(path);
    if (adoption) workspace.adoption = adoption;
    const manifestYaml = localStorage.getItem(demoManifestKey(path));
    if (manifestYaml) {
      workspace.manifestExists = true;
      workspace.manifestYaml = manifestYaml;
    }
    rememberDemoProject(path, workspace);
    return workspace;
  }
  return invoke<WorkspacePreview>("open_project", { path });
}

export async function continueExistingDeployment(
  path: string,
): Promise<WorkspacePreview> {
  if (!isTauri()) {
    const current = await openProject(path);
    const adoption: WorkspacePreview["adoption"] = {
      ...current.adoption,
      mode: "managed",
      detected: true,
      freshDraft: false,
    };
    writeDemoWorkspaceAdoption(path, adoption);
    return { ...current, adoption };
  }
  return invoke<WorkspacePreview>("continue_existing_deployment", { path });
}

export async function resetProjectDeployment(
  path: string,
): Promise<WorkspacePreview> {
  if (!isTauri()) {
    const current = await openProject(path);
    const adoption: WorkspacePreview["adoption"] = {
      ...current.adoption,
      mode: "fresh",
      detected: current.adoption.detected,
      historyImportAfter: new Date().toISOString(),
      freshDraft: true,
    };
    writeDemoWorkspaceAdoption(path, adoption);
    localStorage.setItem(
      DEMO_RUNS_KEY,
      JSON.stringify(readDemoRuns().filter((run) => run.projectPath !== path)),
    );
    const bindings = readDemoServerBindings();
    delete bindings[demoServerBindingKey(path, "staging")];
    delete bindings[demoServerBindingKey(path, "production")];
    localStorage.setItem(DEMO_SERVER_BINDINGS_KEY, JSON.stringify(bindings));
    return { ...current, adoption };
  }
  return invoke<WorkspacePreview>("reset_project_deployment", { path });
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  if (!isTauri()) return readDemoProjects();
  return invoke<RecentProject[]>("list_recent_projects");
}

export async function relinkProject(
  oldPath: string,
  newPath: string,
): Promise<RelinkProjectResult> {
  if (!isTauri()) {
    const projects = readDemoProjects();
    const project = projects.find((item) => item.path === oldPath);
    if (!project) throw new Error("原项目记录不存在，请重新添加");
    const now = new Date().toISOString();
    localStorage.setItem(
      DEMO_PROJECTS_KEY,
      JSON.stringify(
        projects.map((item) =>
          item.path === oldPath
            ? { ...item, path: newPath, pathExists: true, lastOpenedAt: now }
            : item,
        ),
      ),
    );
    const runs = readDemoRuns().map((run) =>
      run.projectPath === oldPath ? { ...run, projectPath: newPath } : run,
    );
    localStorage.setItem(DEMO_RUNS_KEY, JSON.stringify(runs));
    const validations = readDemoVersionValidations(oldPath);
    if (validations.length) {
      writeDemoVersionValidations(newPath, validations);
      localStorage.removeItem(demoVersionValidationsKey(oldPath));
    }
    const oldPrefix = `abcdeploy.setting.project.${encodeURIComponent(oldPath)}.`;
    const newPrefix = `abcdeploy.setting.project.${encodeURIComponent(newPath)}.`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(oldPrefix)) continue;
      const value = localStorage.getItem(key);
      localStorage.removeItem(key);
      index -= 1;
      if (value !== null) {
        localStorage.setItem(
          `${newPrefix}${key.slice(oldPrefix.length)}`,
          value,
        );
      }
    }
    if (localStorage.getItem("abcdeploy.setting.active-project") === oldPath) {
      localStorage.setItem("abcdeploy.setting.active-project", newPath);
    }
    return { path: newPath, name: project.name };
  }
  return invoke<RelinkProjectResult>("relink_project", { oldPath, newPath });
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

export async function getAppSettings(
  keys: string[],
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(keys));
  if (!isTauri()) {
    const entries = await Promise.all(
      unique.map(async (key) => [key, await getAppSetting(key)] as const),
    );
    return Object.fromEntries(
      entries.filter(
        (entry): entry is readonly [string, string] => entry[1] !== null,
      ),
    );
  }
  return invoke<Record<string, string>>("get_app_settings", { keys: unique });
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(`abcdeploy.setting.${key}`, value);
    return;
  }
  return invoke("set_app_setting", { key, value });
}

export async function listConnections(
  kind?: ConnectionKind,
): Promise<ConnectionResource[]> {
  if (!isTauri()) {
    const cnb = readDemoCnbAccount();
    const cnbCheckedAt = localStorage.getItem(
      "abcdeploy.demo.connection.checked.cnb",
    );
    const tcrCheckedAt = localStorage.getItem(
      "abcdeploy.demo.connection.checked.tcr",
    );
    const namespace = await getAppSetting("registry.tcr.namespace");
    const verifiedEndpoint = await getAppSetting(
      "registry.tcr.v2.verified-endpoint",
    );
    const connections: ConnectionResource[] = [
      {
        id: "connection-cnb-default",
        kind: "source",
        provider: "cnb",
        name: cnb?.connected ? `CNB · ${cnb.displayName}` : "CNB",
        status: cnbCheckedAt
          ? "ready"
          : cnb?.connected
            ? "configured"
            : "needs_authorization",
        lastCheckedAt: cnbCheckedAt,
        capabilities: ["repositories", "builds", "automation"],
        metadata: {
          endpoint: "https://cnb.cool",
          ...(cnb?.username ? { username: cnb.username } : {}),
          ...(cnb?.defaultNamespace ? { namespace: cnb.defaultNamespace } : {}),
        },
      },
      {
        id: "connection-tcr-default",
        kind: "registry",
        provider: "tcr",
        name: "腾讯云 TCR",
        status: tcrCheckedAt
          ? "ready"
          : verifiedEndpoint
            ? "configured"
            : "unknown",
        lastCheckedAt: tcrCheckedAt,
        capabilities: ["push", "pull"],
        metadata: {
          endpoint: verifiedEndpoint || "ccr.ccs.tencentyun.com",
          ...(namespace ? { namespace } : {}),
        },
      },
      ...Array.from(
        new Map(
          Object.values(readDemoServerBindings()).map((server) => [
            server.id,
            server,
          ]),
        ).values(),
      ).map((server): ConnectionResource => ({
        id: `legacy-server:${server.id}`,
        kind: "server",
        provider: "ssh",
        name: server.name,
        status: "configured",
        lastCheckedAt: server.lastCheckedAt,
        capabilities: ["deploy", "healthcheck", "reverse-proxy"],
        metadata: {
          host: server.host,
          user: server.user,
          port: String(server.port),
          ...(server.hostFingerprint
            ? { hostFingerprint: server.hostFingerprint }
            : {}),
        },
      })),
    ];
    return kind
      ? connections.filter((connection) => connection.kind === kind)
      : connections;
  }
  return invoke<ConnectionResource[]>("list_connections", {
    kind: kind ?? null,
  });
}

export async function getProjectConnectionBindings(
  path: string,
): Promise<ProjectConnectionBindings> {
  if (!isTauri()) {
    const serverBindings = readDemoServerBindings();
    const manifest =
      localStorage.getItem(demoManifestKey(path)) ??
      demoWorkspace(path).manifestYaml;
    const registryConnectionId = /kind:\s*tcr\b/.test(manifest)
      ? "connection-tcr-default"
      : null;
    return {
      sourceConnectionId: "connection-cnb-default",
      staging: {
        targetConnectionId: serverBindings[
          demoServerBindingKey(path, "staging")
        ]
          ? `legacy-server:${serverBindings[demoServerBindingKey(path, "staging")].id}`
          : null,
        registryConnectionId,
      },
      production: {
        targetConnectionId: serverBindings[
          demoServerBindingKey(path, "production")
        ]
          ? `legacy-server:${serverBindings[demoServerBindingKey(path, "production")].id}`
          : null,
        registryConnectionId,
      },
    };
  }
  return invoke<ProjectConnectionBindings>("get_project_connection_bindings", {
    path,
  });
}

function deploymentPathsSettingKey(path: string) {
  return `project.${encodeURIComponent(path)}.deployment-paths.v1`;
}

export const DEPLOYMENT_PATH_CANVAS_NODE_IDS = [
  "local",
  "build",
  "registry",
  "server",
] as const;

export type DeploymentPathCanvasNodeId =
  (typeof DEPLOYMENT_PATH_CANVAS_NODE_IDS)[number];

export interface DeploymentPathCanvasPosition {
  x: number;
  y: number;
}

export type DeploymentPathCanvasLayout = Record<
  DeploymentPathCanvasNodeId,
  DeploymentPathCanvasPosition
>;

function deploymentPathCanvasLayoutSettingKey(
  projectPath: string,
  pathId: string,
) {
  return `project.${encodeURIComponent(projectPath)}.deployment-path.${encodeURIComponent(pathId)}.canvas-layout.v1`;
}

function normalizeDeploymentPathCanvasLayout(
  candidate: unknown,
): DeploymentPathCanvasLayout | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const layout = candidate as Record<string, unknown>;
  const nodeIds = Object.keys(layout);
  if (
    nodeIds.length !== DEPLOYMENT_PATH_CANVAS_NODE_IDS.length ||
    nodeIds.some(
      (nodeId) =>
        !DEPLOYMENT_PATH_CANVAS_NODE_IDS.includes(
          nodeId as DeploymentPathCanvasNodeId,
        ),
    )
  ) {
    return null;
  }

  const positions = {} as DeploymentPathCanvasLayout;
  for (const nodeId of DEPLOYMENT_PATH_CANVAS_NODE_IDS) {
    const candidatePosition = layout[nodeId];
    if (
      !candidatePosition ||
      typeof candidatePosition !== "object" ||
      Array.isArray(candidatePosition)
    ) {
      return null;
    }
    const position = candidatePosition as Record<string, unknown>;
    const coordinateNames = Object.keys(position);
    if (
      coordinateNames.length !== 2 ||
      !coordinateNames.includes("x") ||
      !coordinateNames.includes("y") ||
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    ) {
      return null;
    }
    positions[nodeId] = { x: position.x, y: position.y };
  }
  return positions;
}

/**
 * Canvas geometry is application state scoped to one project and deployment
 * path. Invalid or outdated values are ignored so they cannot prevent the
 * workflow from opening with its default layout.
 */
export async function getDeploymentPathCanvasLayout(
  projectPath: string,
  pathId: string,
): Promise<DeploymentPathCanvasLayout | null> {
  const value = await getAppSetting(
    deploymentPathCanvasLayoutSettingKey(projectPath, pathId),
  );
  if (!value) return null;
  try {
    return normalizeDeploymentPathCanvasLayout(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function saveDeploymentPathCanvasLayout(
  projectPath: string,
  pathId: string,
  layout: DeploymentPathCanvasLayout,
): Promise<void> {
  const normalized = normalizeDeploymentPathCanvasLayout(layout);
  if (!normalized) {
    throw new Error("部署线路画布布局无效");
  }
  await setAppSetting(
    deploymentPathCanvasLayoutSettingKey(projectPath, pathId),
    JSON.stringify(normalized),
  );
}

export async function clearDeploymentPathCanvasLayout(
  projectPath: string,
  pathId: string,
): Promise<void> {
  await setAppSetting(
    deploymentPathCanvasLayoutSettingKey(projectPath, pathId),
    "",
  );
}

function parseDeploymentPaths(
  value: string | null,
  projectPath: string,
): DeploymentPath[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (candidate): candidate is DeploymentPath =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          typeof (candidate as DeploymentPath).id === "string" &&
          typeof (candidate as DeploymentPath).name === "string",
      )
      .map((candidate) => ({
        ...candidate,
        projectPath,
        sourceConnectionId: candidate.sourceConnectionId ?? null,
        registryConnectionId: candidate.registryConnectionId ?? null,
        serverId: candidate.serverId ?? null,
        configProfileIds: Array.isArray(candidate.configProfileIds)
          ? candidate.configProfileIds.filter(
              (profileId): profileId is string => typeof profileId === "string",
            )
          : [],
        address: typeof candidate.address === "string" ? candidate.address : "",
        routes: Array.isArray(candidate.routes)
          ? candidate.routes.filter(
              (route): route is DeploymentPath["routes"][number] =>
                Boolean(route) &&
                typeof route === "object" &&
                typeof route.service === "string" &&
                typeof route.host === "string" &&
                typeof route.path === "string",
            )
          : [],
        state: [
          "draft",
          "ready",
          "deploying",
          "online",
          "needs_action",
        ].includes(candidate.state)
          ? candidate.state
          : "draft",
        lastRunId: candidate.lastRunId ?? null,
        lastSuccessfulRevision: candidate.lastSuccessfulRevision ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * Deployment paths deliberately live in application state rather than the
 * user's source tree. Only reusable connection ids and project-scoped values
 * are persisted; credentials remain in their existing secure stores.
 */
export async function listDeploymentPaths(
  path: string,
): Promise<DeploymentPath[]> {
  if (isTauri()) {
    return invoke<DeploymentPath[]>("list_deployment_paths", { path });
  }
  return parseDeploymentPaths(
    await getAppSetting(deploymentPathsSettingKey(path)),
    path,
  );
}

export async function listDeploymentPathRuns(
  pathId: string,
): Promise<DeploymentRun[]> {
  if (isTauri()) {
    return invoke<DeploymentRun[]>("list_deployment_path_runs", { pathId });
  }
  return readDemoRuns()
    .filter((run) => run.environment === "deployment")
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function redeployDeploymentPathVersion(
  pathId: string,
  sourceRunId: string,
): Promise<DeploymentRun> {
  if (isTauri()) {
    return invoke<DeploymentRun>("redeploy_deployment_path_version", {
      pathId,
      sourceRunId,
    });
  }
  const source = readDemoRuns().find((run) => run.id === sourceRunId);
  if (!source) throw new Error("找不到要重新上线的版本");
  const run: DeploymentRun = {
    ...source,
    id: `run-${pathId}-${Date.now()}`,
    status: "success",
    message: "所选历史版本已经重新上线",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeDemoRun(run);
  return run;
}

export async function saveDeploymentPath(
  input: DeploymentPathInput,
): Promise<DeploymentPath> {
  if (isTauri()) {
    return invoke<DeploymentPath>("save_deployment_path", { input });
  }
  const paths = await listDeploymentPaths(input.projectPath);
  const previous = input.id
    ? paths.find((candidate) => candidate.id === input.id)
    : undefined;
  const now = new Date().toISOString();
  const path: DeploymentPath = {
    id:
      input.id ??
      `path-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectPath: input.projectPath,
    name: input.name.trim() || "上线",
    sourceConnectionId: input.sourceConnectionId,
    registryConnectionId: input.registryConnectionId,
    serverId: input.serverId,
    configProfileIds: Array.from(new Set(input.configProfileIds)),
    address: input.address.trim(),
    routes: input.routes.map((route) => ({
      service: route.service.trim(),
      host: route.host.trim(),
      path: route.path.trim() || "/",
    })),
    state: input.state ?? previous?.state ?? "draft",
    lastRunId: input.lastRunId ?? previous?.lastRunId ?? null,
    lastSuccessfulRevision:
      input.lastSuccessfulRevision ?? previous?.lastSuccessfulRevision ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const next = [...paths.filter((candidate) => candidate.id !== path.id), path];
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  await setAppSetting(
    deploymentPathsSettingKey(input.projectPath),
    JSON.stringify(next),
  );
  return path;
}

export async function deleteDeploymentPath(
  projectPath: string,
  pathId: string,
): Promise<boolean> {
  if (isTauri()) {
    const deleted = await invoke<boolean>("delete_deployment_path", {
      projectPath,
      pathId,
    });
    if (deleted) {
      try {
        await clearDeploymentPathCanvasLayout(projectPath, pathId);
      } catch {
        // The path is already gone. Stale presentation state must not turn a
        // successful destructive operation into a reported failure.
      }
    }
    return deleted;
  }
  const paths = await listDeploymentPaths(projectPath);
  const next = paths.filter((candidate) => candidate.id !== pathId);
  if (next.length === paths.length) return false;
  await setAppSetting(
    deploymentPathsSettingKey(projectPath),
    JSON.stringify(next),
  );
  try {
    await clearDeploymentPathCanvasLayout(projectPath, pathId);
  } catch {
    // Keep the successfully persisted deletion authoritative even if the
    // independent canvas-layout cleanup cannot be written.
  }
  return true;
}

export async function listConfigProfiles(): Promise<ConfigProfile[]> {
  if (!isTauri()) return readDemoConfigProfiles();
  return invoke<ConfigProfile[]>("list_config_profiles");
}

export async function saveConfigProfile(
  input: ConfigProfileInput,
): Promise<ConfigProfile> {
  if (!isTauri()) {
    const profiles = readDemoConfigProfiles();
    const id = input.id ?? `${input.kind}-${Date.now()}`;
    const profile: ConfigProfile = {
      id,
      kind: input.kind,
      provider: input.provider,
      name: input.name,
      scope: input.scope,
      values: input.values,
      secretFields: input.secretFields,
      configuredSecretFields: input.secretFields.filter(
        (field) =>
          Boolean(input.secrets[field]) ||
          profiles
            .find((item) => item.id === id)
            ?.configuredSecretFields.includes(field),
      ),
      isDefault:
        input.isDefault ||
        !profiles.some((profile) => profile.kind === input.kind),
      updatedAt: new Date().toISOString(),
    };
    const previousSecrets = demoConfigProfileSecrets.get(id) ?? {};
    demoConfigProfileSecrets.set(id, {
      ...previousSecrets,
      ...Object.fromEntries(
        Object.entries(input.secrets).filter(([, value]) => Boolean(value)),
      ),
    });
    const next = profiles
      .filter((item) => item.id !== id)
      .map((item) =>
        profile.isDefault && item.kind === profile.kind
          ? { ...item, isDefault: false }
          : item,
      );
    next.push(profile);
    localStorage.setItem(DEMO_CONFIG_PROFILES_KEY, JSON.stringify(next));
    return profile;
  }
  return invoke<ConfigProfile>("save_config_profile", { input });
}

export async function deleteConfigProfile(id: string): Promise<boolean> {
  if (!isTauri()) {
    const profiles = readDemoConfigProfiles();
    const next = profiles.filter((profile) => profile.id !== id);
    localStorage.setItem(DEMO_CONFIG_PROFILES_KEY, JSON.stringify(next));
    demoConfigProfileSecrets.delete(id);
    return next.length !== profiles.length;
  }
  return invoke<boolean>("delete_config_profile", { id });
}

export async function bindConfigProfile(
  path: string,
  environment: RuntimeEnvironment,
  kind: ConfigProfile["kind"],
  profileId: string,
): Promise<ProjectProfileBinding> {
  if (!isTauri()) {
    const binding = { environment, kind, profileId };
    const bindings = readDemoConfigProfileBindings(path, environment).filter(
      (current) => current.profileId !== profileId,
    );
    bindings.push(binding);
    writeDemoConfigProfileBindings(path, environment, bindings);
    return binding;
  }
  return invoke<ProjectProfileBinding>("bind_config_profile", {
    path,
    environment,
    kind,
    profileId,
  });
}

export async function listConfigProfileBindings(
  path: string,
  environment: RuntimeEnvironment,
): Promise<EnvironmentConfigBindings> {
  if (!isTauri()) {
    return readDemoConfigProfileBindings(path, environment);
  }
  return invoke<ProjectProfileBinding[]>("list_config_profile_bindings", {
    path,
    environment,
  });
}

export async function setEnvironmentConfigBindings(
  path: string,
  environment: RuntimeEnvironment,
  profileIds: string[],
): Promise<EnvironmentConfigBindings> {
  if (!isTauri()) {
    const profiles = readDemoConfigProfiles();
    const uniqueIds = Array.from(new Set(profileIds));
    const bindings = uniqueIds.map((profileId) => {
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) throw new Error(`所选配置中心连接已不存在：${profileId}`);
      const supported =
        profile.scope === "any" ||
        (profile.scope === "local" && environment === "development") ||
        (profile.scope === "remote" && environment !== "development");
      if (!supported) {
        throw new Error(`配置“${profileId}”不适用于当前运行环境`);
      }
      return { environment, kind: profile.kind, profileId };
    });
    writeDemoConfigProfileBindings(path, environment, bindings);
    return bindings;
  }
  return invoke<ProjectProfileBinding[]>("set_environment_config_bindings", {
    path,
    environment,
    profileIds,
  });
}

export async function recommendRuntimeConfig(
  path: string,
  environment: RuntimeEnvironment,
  profileIds: string[],
  content?: string,
): Promise<RuntimeConfigRecommendation> {
  if (!isTauri()) {
    const current = await loadRuntimeConfig(path, environment);
    const profiles = readDemoConfigProfiles().filter(
      (profile) =>
        profileIds.includes(profile.id) &&
        (profile.scope === "any" ||
          (profile.scope === "local" && environment === "development") ||
          (profile.scope === "remote" && environment !== "development")),
    );
    const suggestions: Record<string, string> = Object.fromEntries(
      profiles.flatMap((profile) =>
        Object.entries(
          demoRuntimeValuesFromProfile(profile, path, environment),
        ),
      ),
    );
    const source = content ?? current.content;
    for (const variable of demoEmptyRuntimeVariables(source)) {
      if (demoInternalRuntimeSecret(variable) && !suggestions[variable]) {
        suggestions[variable] = demoGeneratedRuntimeSecret(
          path,
          environment,
          variable,
        );
      }
    }
    const recommendation = fillDemoRuntimeValues(source, suggestions);
    return {
      content: recommendation.content,
      appliedProfiles: profiles
        .filter((profile) =>
          Object.keys(
            demoRuntimeValuesFromProfile(profile, path, environment),
          ).some((variable) =>
            recommendation.filledVariables.includes(variable),
          ),
        )
        .map((profile) => profile.name),
      filledVariables: recommendation.filledVariables,
    };
  }
  return invoke<RuntimeConfigRecommendation>("recommend_runtime_config", {
    path,
    environment,
    profileIds,
    content: content ?? null,
  });
}

export async function writeLocalEnv(
  path: string,
  content: string,
  overwrite = false,
): Promise<LocalEnvWriteResult> {
  if (!isTauri()) {
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    return {
      path: `${path}/.env`,
      written: true,
      requiresConfirmation: false,
      backupPath: null,
    };
  }
  return invoke<LocalEnvWriteResult>("write_local_env", {
    path,
    content,
    overwrite,
  });
}

export async function getLocalInfrastructureStatus(): Promise<LocalInfrastructureStatus> {
  if (!isTauri()) return demoLocalInfrastructureStatus();
  return invoke<LocalInfrastructureStatus>("get_local_infrastructure_status");
}

export async function prepareLocalInfrastructure(): Promise<LocalInfrastructureStatus> {
  if (!isTauri()) {
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    await Promise.all([
      saveConfigProfile({
        id: "profile-local-postgres",
        kind: "database",
        provider: "abcdeploy_local_postgres",
        name: "ABCDeploy 本机 PostgreSQL",
        scope: "local",
        values: { host: "127.0.0.1", port: "55432", user: "abcdeploy" },
        secretFields: ["password"],
        secrets: { password: "demo-local-password" },
        isDefault: true,
      }),
      saveConfigProfile({
        id: "profile-local-redis",
        kind: "redis",
        provider: "abcdeploy_local_redis",
        name: "ABCDeploy 本机 Redis",
        scope: "local",
        values: { host: "127.0.0.1", port: "56379" },
        secretFields: ["password"],
        secrets: { password: "demo-local-password" },
        isDefault: true,
      }),
    ]);
    return demoLocalInfrastructureStatus();
  }
  return invoke<LocalInfrastructureStatus>("prepare_local_infrastructure");
}

export async function prepareLocalPreview(
  path: string,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) return demoLocalPreview(path, "stopped");
  return invoke<LocalPreviewStatus>("prepare_local_preview", { path });
}

export async function startLocalPreview(
  path: string,
  developmentMode = false,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) {
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "running");
    localStorage.removeItem(`abcdeploy.demo.local-services.${path}`);
    return demoLocalPreview(path, "running");
  }
  return invoke<LocalPreviewStatus>("start_local_preview", {
    path,
    developmentMode,
  });
}

export async function startLocalPreviewService(
  path: string,
  serviceId: string,
  developmentMode = false,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) {
    const services = readDemoLocalServices(path);
    services[serviceId] = true;
    localStorage.setItem(
      `abcdeploy.demo.local-services.${path}`,
      JSON.stringify(services),
    );
    return demoLocalPreview(path, "partial");
  }
  return invoke<LocalPreviewStatus>("start_local_preview_service", {
    path,
    serviceId,
    developmentMode,
  });
}

export async function cancelLocalPreviewStart(path: string): Promise<boolean> {
  if (!isTauri()) return true;
  return invoke<boolean>("cancel_local_preview_start", { path });
}

export async function stopManagedLocalPortOwner(port: number): Promise<string> {
  if (!isTauri()) return "其他项目";
  return invoke<string>("stop_managed_local_port_owner", { port });
}

export async function getLocalPreviewStatus(
  path: string,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) {
    const state = (localStorage.getItem(`abcdeploy.demo.local.${path}`) ??
      "stopped") as LocalPreviewStatus["state"];
    return demoLocalPreview(path, state);
  }
  return invoke<LocalPreviewStatus>("get_local_preview_status", { path });
}

export async function getLocalDevelopmentSupport(
  path: string,
): Promise<LocalDevelopmentSupport> {
  if (!isTauri()) {
    return {
      available: true,
      serviceCount: 3,
      message: "修改代码后会自动重启后端或刷新网页，仅影响本机运行。",
    };
  }
  return invoke<LocalDevelopmentSupport>("get_local_development_support", {
    path,
  });
}

export async function prepareLocalDevelopment(
  path: string,
): Promise<LocalDevelopmentSupport> {
  if (!isTauri()) return getLocalDevelopmentSupport(path);
  return invoke<LocalDevelopmentSupport>("prepare_local_development", {
    path,
  });
}

export async function stopLocalPreview(
  path: string,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) {
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "stopped");
    localStorage.removeItem(`abcdeploy.demo.local-services.${path}`);
    return demoLocalPreview(path, "stopped");
  }
  return invoke<LocalPreviewStatus>("stop_local_preview", { path });
}

export async function stopLocalPreviewService(
  path: string,
  serviceId: string,
): Promise<LocalPreviewStatus> {
  if (!isTauri()) {
    const services = readDemoLocalServices(path);
    services[serviceId] = false;
    localStorage.setItem(
      `abcdeploy.demo.local-services.${path}`,
      JSON.stringify(services),
    );
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "partial");
    return demoLocalPreview(path, "partial");
  }
  return invoke<LocalPreviewStatus>("stop_local_preview_service", {
    path,
    serviceId,
  });
}

export async function setLocalInfrastructureService(
  service: "postgres" | "redis",
  running: boolean,
): Promise<LocalInfrastructureStatus> {
  if (!isTauri()) {
    const status = demoLocalInfrastructureStatus();
    const next = {
      postgres: service === "postgres" ? running : status.postgresRunning,
      redis: service === "redis" ? running : status.redisRunning,
    };
    localStorage.setItem(
      "abcdeploy.demo.local-infrastructure-services",
      JSON.stringify(next),
    );
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "prepared");
    return demoLocalInfrastructureStatus();
  }
  return invoke<LocalInfrastructureStatus>("set_local_infrastructure_service", {
    service,
    running,
  });
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
    localStorage.setItem(demoManifestKey(path), manifestYaml);
    const adoption = readDemoWorkspaceAdoption(path);
    if (adoption?.mode === "fresh" && adoption.freshDraft) {
      writeDemoWorkspaceAdoption(path, { ...adoption, freshDraft: false });
    }
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

export async function saveManifestDraft(
  path: string,
  manifestYaml: string,
): Promise<ApplyResult> {
  if (!isTauri()) {
    localStorage.setItem(demoManifestKey(path), manifestYaml);
    const adoption = readDemoWorkspaceAdoption(path);
    if (adoption?.mode === "fresh" && adoption.freshDraft) {
      writeDemoWorkspaceAdoption(path, { ...adoption, freshDraft: false });
    }
    return {
      planId: "demo-draft-plan",
      writtenFiles: ["deploy.yaml"],
      backupDirectory: `${path}/.deploydesk/backups/demo-draft-plan`,
    };
  }
  return invoke<ApplyResult>("save_manifest_draft", {
    path,
    manifestYaml,
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

export async function installServerKeyWithPassword(
  form: ServerForm,
  password: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "ssh",
      ok: Boolean(form.host && form.user && form.keyPath && password),
      summary: password ? "服务器已建立安全连接" : "请填写服务器登录密码",
      details: ["公钥已幂等安装；服务器密码未保存"],
      code: password ? null : "AD-SSH-105",
      nextSteps: password ? [] : ["填写服务器登录密码后重试"],
      retryable: !password,
    };
  }
  return invoke<ProviderCheck>("install_server_key_with_password", {
    name: form.name,
    host: form.host,
    user: form.user,
    keyPath: form.keyPath,
    port: form.port,
    hostFingerprint: form.hostFingerprint,
    password,
  });
}

export async function listServers(): Promise<ServerResource[]> {
  if (!isTauri()) return Object.values(readDemoServerBindings());
  return invoke<ServerResource[]>("list_servers");
}

export async function getProjectServer(
  path: string,
  environment: "staging" | "production",
): Promise<ServerResource | null> {
  if (!isTauri()) {
    return (
      readDemoServerBindings()[demoServerBindingKey(path, environment)] ?? null
    );
  }
  return invoke<ServerResource | null>("get_project_server", {
    path,
    environment,
  });
}

export async function bindProjectServer(
  path: string,
  environment: "staging" | "production",
  server: ServerForm,
): Promise<ServerResource> {
  if (!isTauri()) {
    const resource = {
      ...server,
      id: `demo-${server.user}@${server.host}:${server.port}`,
      keyPathExists: true,
      lastCheckedAt: new Date().toISOString(),
    };
    const bindings = readDemoServerBindings();
    bindings[demoServerBindingKey(path, environment)] = resource;
    localStorage.setItem(DEMO_SERVER_BINDINGS_KEY, JSON.stringify(bindings));
    return resource;
  }
  return invoke<ServerResource>("bind_project_server", {
    path,
    environment,
    server,
  });
}

export async function createDeploymentTask(
  path: string,
  environment: DeploymentRun["environment"],
  sourceRunId?: string,
  deploymentPathId?: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run: DeploymentRun = {
      ...demoRun(path, environment),
      status: "queued",
      currentStage: "prepare",
      sourceRunId: sourceRunId ?? null,
      completedSteps: [],
      message:
        environment === "production"
          ? "正式发布任务已保存，正在核对目标环境"
          : environment === "deployment"
            ? "上线任务已保存，正在准备当前本地项目"
            : "测试部署任务已保存，正在准备代码和运行环境",
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("create_deployment_task", {
    path,
    environment,
    sourceRunId: sourceRunId ?? null,
    deploymentPathId: deploymentPathId ?? null,
  });
}

export async function beginDeploymentAttempt(
  taskId: string,
): Promise<DeploymentAttempt> {
  if (!isTauri()) {
    const now = new Date().toISOString();
    return {
      id: `attempt-${taskId}-1`,
      taskId,
      ordinal: 1,
      status: "running",
      currentStage: "prepare",
      inputSnapshot: {},
      output: {},
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    };
  }
  return invoke<DeploymentAttempt>("begin_deployment_attempt", { taskId });
}

export async function listDeploymentAttempts(
  taskId: string,
): Promise<DeploymentAttempt[]> {
  if (!isTauri()) return [];
  return invoke<DeploymentAttempt[]>("list_deployment_attempts", { taskId });
}

export async function pauseDeploymentTask(
  runId: string,
  currentStage:
    | "prepare"
    | "prepare-server"
    | "write-config"
    | "sync-source"
    | "trigger-build",
  issueCode: string,
  message: string,
  actionKind:
    | "retry-staging-preparation"
    | "retry-production-preparation"
    | "deployment-path-preparation-retry",
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run = readDemoRuns().find((item) => item.id === runId);
    if (!run) throw new Error("找不到这次部署任务");
    const paused: DeploymentRun = {
      ...run,
      status: "needs_action",
      currentStage,
      issueCode,
      actionKind,
      message,
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(paused);
    return paused;
  }
  return invoke<DeploymentRun>("pause_deployment_task", {
    runId,
    currentStage,
    issueCode,
    message,
    actionKind,
  });
}

export async function prepareDeploymentPathRetry(
  runId: string,
  repairedNode: "local" | "build" | "registry" | "server" | "routes",
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const run = readDemoRuns().find((item) => item.id === runId);
    if (!run) throw new Error("找不到这次上线任务");
    const next: DeploymentRun = {
      ...run,
      currentStage:
        repairedNode === "routes"
          ? "server"
          : repairedNode === "server" && run.artifacts.length
            ? "deploy"
            : repairedNode,
      issueCode: null,
      actionKind: "deployment-path-retry",
      message: "新配置已经验证，点击“继续上线”后从这里继续",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(next);
    return next;
  }
  return invoke<DeploymentRun>("prepare_deployment_path_retry", {
    runId,
    repairedNode,
  });
}

export async function startStagingDeployment(
  path: string,
  expectedRevision?: string,
  preferPushBuild = false,
  taskId?: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const savedTask = taskId
      ? readDemoRuns().find((item) => item.id === taskId)
      : undefined;
    const run = {
      ...(savedTask ?? demoRun(path, "staging")),
      status: "running" as const,
      currentStage: "build",
      commitSha:
        expectedRevision ??
        savedTask?.commitSha ??
        "0123456789abcdef0123456789abcdef01234567",
      actionKind: null,
      issueCode: null,
      message: "CNB 已开始构建，关闭应用后也可以继续查看",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("start_staging_deployment", {
    path,
    expectedRevision: expectedRevision ?? null,
    preferPushBuild,
    taskId: taskId ?? null,
  });
}

export async function startDeploymentPath(
  path: string,
  expectedRevision: string,
  taskId: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const savedTask = readDemoRuns().find((item) => item.id === taskId);
    if (!savedTask) throw new Error("找不到这次上线任务");
    const run: DeploymentRun = {
      ...savedTask,
      environment: "deployment",
      status: "running",
      currentStage: "build",
      commitSha: expectedRevision,
      actionKind: null,
      issueCode: null,
      message: "构建服务正在生成可运行版本",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("start_deployment_path", {
    path,
    expectedRevision,
    taskId,
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
  taskId?: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const source = readDemoRuns().find((run) => run.id === sourceRunId);
    if (!source || source.status !== "success") {
      throw new Error("只有健康检查通过的测试版本才能发布生产");
    }
    const savedTask = taskId
      ? readDemoRuns().find((item) => item.id === taskId)
      : undefined;
    const run = {
      ...(savedTask ?? demoRun(source.projectPath, "production")),
      status: "running" as const,
      currentStage: "build",
      commitSha: source.commitSha,
      sourceRunId,
      candidateTag: source.candidateTag,
      actionKind: null,
      issueCode: null,
      message: "CNB 已开始构建，关闭应用后也可以继续查看",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("promote_production_deployment", {
    sourceRunId,
    taskId: taskId ?? null,
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
            : run.environment === "deployment"
              ? "项目已经上线并通过公网检查"
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

export interface StagingPreviewTunnel {
  url: string;
  service: string;
}

export async function openStagingPreviewTunnel(
  runId: string,
): Promise<StagingPreviewTunnel> {
  if (!isTauri()) {
    return { url: "http://127.0.0.1:4173", service: "web" };
  }
  return invoke<StagingPreviewTunnel>("open_staging_preview_tunnel", {
    runId,
  });
}

export async function listDeploymentRuns(
  path: string,
): Promise<DeploymentRun[]> {
  if (!isTauri())
    return readDemoRuns().filter((run) => run.projectPath === path);
  return invoke<DeploymentRun[]>("list_deployment_runs", { path });
}

export async function listProjectEnvironments(
  path: string,
): Promise<ProjectEnvironment[]> {
  if (!isTauri()) return demoProjectEnvironments(path);
  return invoke<ProjectEnvironment[]>("list_project_environments", { path });
}

export async function listProjectVersions(
  path: string,
): Promise<ProjectVersion[]> {
  if (!isTauri()) return demoProjectVersions(path);
  return invoke<ProjectVersion[]>("list_project_versions", { path });
}

export async function listVersionValidations(
  path: string,
): Promise<VersionValidation[]> {
  if (!isTauri()) return readDemoVersionValidations(path);
  return invoke<VersionValidation[]>("list_version_validations", { path });
}

export async function setVersionValidation(
  path: string,
  runId: string,
  validationState: VersionValidationState,
): Promise<VersionValidation> {
  if (!isTauri()) {
    const run = readDemoRuns().find((candidate) => candidate.id === runId);
    if (!run || run.projectPath !== path) {
      throw new Error("这条版本记录不属于当前项目");
    }
    if (run.environment !== "staging" || run.status !== "success") {
      throw new Error("只有已经成功部署到测试环境的版本才能确认测试结果");
    }
    const validation: VersionValidation = {
      versionKey: deploymentVersionKey(run),
      state: validationState,
      runId,
      verifiedAt: new Date().toISOString(),
    };
    const current = readDemoVersionValidations(path);
    writeDemoVersionValidations(path, [
      validation,
      ...current.filter(
        (candidate) => candidate.versionKey !== validation.versionKey,
      ),
    ]);
    return validation;
  }
  return invoke<VersionValidation>("set_version_validation", {
    path,
    runId,
    validationState,
  });
}

export async function listActiveDeploymentRuns(): Promise<DeploymentRun[]> {
  if (!isTauri()) {
    return readDemoRuns().filter((run) =>
      ["queued", "running"].includes(run.status),
    );
  }
  return invoke<DeploymentRun[]>("list_active_deployment_runs");
}

export async function listAttentionDeploymentRuns(): Promise<DeploymentRun[]> {
  if (!isTauri()) {
    const latestByEnvironment = new Map<string, DeploymentRun>();
    for (const run of readDemoRuns()) {
      const key = `${run.projectPath}:${run.environment}`;
      const current = latestByEnvironment.get(key);
      if (!current || run.startedAt > current.startedAt) {
        latestByEnvironment.set(key, run);
      }
    }
    return Array.from(latestByEnvironment.values())
      .filter((run) =>
        ["queued", "running", "needs_action", "failed"].includes(run.status),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return invoke<DeploymentRun[]>("list_attention_deployment_runs");
}

export async function listRecentSuccessfulDeploymentRuns(): Promise<
  DeploymentRun[]
> {
  if (!isTauri()) {
    const latestByEnvironment = new Map<string, DeploymentRun>();
    for (const run of readDemoRuns()) {
      if (run.status !== "success") continue;
      const key = `${run.projectPath}:${run.environment}`;
      const current = latestByEnvironment.get(key);
      if (!current || run.startedAt > current.startedAt) {
        latestByEnvironment.set(key, run);
      }
    }
    return Array.from(latestByEnvironment.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
  }
  return invoke<DeploymentRun[]>("list_recent_successful_deployment_runs");
}

export async function detectDnsProvider(
  host: string,
): Promise<DnsProviderHint | null> {
  if (!isTauri()) return null;
  return invoke<DnsProviderHint | null>("detect_dns_provider", { host });
}

export async function checkDeploymentRoutes(
  runId: string,
): Promise<PublicRouteStatus[]> {
  if (!isTauri()) {
    return (
      readDemoRuns()
        .find((run) => run.id === runId)
        ?.routeChecks?.slice() ?? []
    );
  }
  return invoke<PublicRouteStatus[]>("check_deployment_routes", { runId });
}

export async function retryDeploymentCertificates(
  runId: string,
): Promise<PublicRouteStatus[]> {
  if (!isTauri()) return checkDeploymentRoutes(runId);
  return invoke<PublicRouteStatus[]>("retry_deployment_certificates", {
    runId,
  });
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

export async function inspectServerRouteConflicts(
  path: string,
  environment: "staging" | "production",
  server: ServerForm,
): Promise<RouteConflictCheck> {
  if (!isTauri()) return { conflicts: [], takeoverAvailable: false };
  return invoke<RouteConflictCheck>("inspect_server_route_conflicts", {
    path,
    environment,
    server,
  });
}

export async function takeOverServerRoutes(
  path: string,
  environment: "staging" | "production",
  server: ServerForm,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "caddy",
      ok: true,
      summary: "现有地址已安全切换到 ABCDeploy 管理",
      details: [],
    };
  }
  return invoke<ProviderCheck>("take_over_server_routes", {
    path,
    environment,
    server,
    confirmed: true,
  });
}

export async function takeOverDeploymentPathRoutes(
  runId: string,
): Promise<DeploymentRun> {
  if (!isTauri()) {
    const source = readDemoRuns().find((run) => run.id === runId);
    if (!source) throw new Error("找不到需要继续的上线任务");
    const run: DeploymentRun = {
      ...source,
      status: "success",
      currentStage: "complete",
      issueCode: null,
      actionKind: null,
      message: "现有访问地址已安全接管，上线完成",
      updatedAt: new Date().toISOString(),
    };
    writeDemoRun(run);
    return run;
  }
  return invoke<DeploymentRun>("take_over_deployment_path_routes", {
    runId,
    confirmed: true,
  });
}

export async function reapplyDeploymentRoutes(
  runId: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "caddy",
      ok: true,
      summary: "正式地址已重新应用",
      details: [],
    };
  }
  return invoke<ProviderCheck>("reapply_deployment_routes", { runId });
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
  authorize = false,
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
      requiredVariables: ["DATABASE_URL", "APP_SECRET"],
      stored: content !== null,
      authorizationRequired: false,
    };
  }
  return invoke<RuntimeConfigFile>("load_runtime_config", {
    path,
    environment,
    authorize,
  });
}

export async function loadExistingProjectConfig(
  path: string,
  environment: Exclude<RuntimeEnvironment, "development">,
): Promise<ExistingProjectConfig> {
  if (!isTauri()) {
    return {
      sourceFiles: [".env"],
      content: readDemoRuntimeConfig(path, "development") ?? "",
    };
  }
  return invoke<ExistingProjectConfig>("load_existing_project_config", {
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

export async function getRuntimeConfigSyncStatus(
  path: string,
  environment: Exclude<RuntimeEnvironment, "development">,
  server: ServerForm,
): Promise<RuntimeConfigSyncStatus> {
  if (!isTauri()) {
    const stored = Boolean(readDemoRuntimeConfig(path, environment));
    return { stored, synchronized: stored };
  }
  return invoke<RuntimeConfigSyncStatus>("runtime_config_sync_status", {
    path,
    environment,
    server,
  });
}

export async function syncRuntimeConfigToServer(
  path: string,
  environment: Exclude<RuntimeEnvironment, "development">,
  server: ServerForm,
): Promise<RuntimeConfigSyncStatus> {
  if (!isTauri()) return { stored: true, synchronized: true };
  return invoke<RuntimeConfigSyncStatus>("sync_runtime_config_to_server", {
    path,
    environment,
    server,
  });
}

export async function prepareCnbSecretBundle(
  path: string,
  environment: CnbSecretBundle["environment"],
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

function safeDemoConnectionText(value: unknown, fallback = ""): string {
  return typeof value === "string" &&
    value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fallback;
}

function readDemoCnbAccount(): CnbAccount | null {
  const stored = localStorage.getItem("abcdeploy.demo.cnb-account");
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    const namespaces = Array.isArray(value.namespaces)
      ? value.namespaces.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const namespace = item as Record<string, unknown>;
          const path = safeDemoConnectionText(namespace.path);
          if (!path) return [];
          return [
            {
              path,
              displayName: safeDemoConnectionText(namespace.displayName, path),
              accessRole: safeDemoConnectionText(namespace.accessRole),
              canCreateRepository: namespace.canCreateRepository === true,
            },
          ];
        })
      : [];
    return {
      connected: value.connected === true,
      displayName: safeDemoConnectionText(value.displayName, "CNB"),
      username: safeDemoConnectionText(value.username),
      defaultNamespace: safeDemoConnectionText(value.defaultNamespace),
      namespaces,
    };
  } catch {
    return null;
  }
}

export async function connectCnb(
  token: string,
  persist: boolean,
  repository?: string,
): Promise<CnbAccount> {
  if (!isTauri()) {
    const account: CnbAccount = {
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
    if (persist) {
      localStorage.setItem(
        "abcdeploy.demo.cnb-account",
        JSON.stringify(account),
      );
    }
    localStorage.setItem(
      "abcdeploy.demo.connection.checked.cnb",
      new Date().toISOString(),
    );
    return account;
  }
  return invoke("connect_cnb", {
    token,
    persist,
    repository: repository?.trim() || null,
  });
}

export async function getCnbAccount(): Promise<CnbAccount> {
  if (!isTauri()) {
    const stored = readDemoCnbAccount();
    if (stored) return stored;
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

export async function checkCnbRepositoryAccess(
  repository: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "cnb-repository",
      ok: true,
      summary: "CNB 仓库可用",
      details: [],
    };
  }
  return invoke<ProviderCheck>("check_cnb_repository_access", { repository });
}

export async function checkCnbSecretRepositoryAccess(
  repository: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "cnb-secret-repository",
      ok: true,
      summary: "CNB 安全位置可用",
      details: [],
    };
  }
  return invoke<ProviderCheck>("check_cnb_secret_repository_access", {
    repository,
  });
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
  taskId?: string,
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
    taskId: taskId ?? null,
  });
}

export async function getSecretStatus(
  key: string,
  authorize = false,
): Promise<SecretStatus> {
  if (!isTauri()) {
    return { key, stored: key.startsWith("registry.tcr.") };
  }
  return invoke<SecretStatus>("secret_status", { authorize, key });
}

export async function storeSecret(
  key: string,
  value: string,
): Promise<SecretStatus> {
  if (!isTauri()) return { key, stored: Boolean(value) };
  return invoke<SecretStatus>("store_secret", { key, value });
}

export async function checkRegistryCredentials(
  registry: string,
  username: string,
  password: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    const ok = Boolean(registry.trim() && username.trim() && password);
    return {
      provider: "registry",
      ok,
      summary: ok ? "镜像仓库登录信息可用" : "登录信息还没有填写完整",
      details: [],
      code: ok ? undefined : "AD-IMG-201",
      nextSteps: ok ? [] : ["填写登录用户名和访问密码后重新验证"],
      retryable: false,
    };
  }
  return invoke<ProviderCheck>("check_registry_credentials", {
    registry,
    username,
    password,
  });
}

export async function replaceRegistryCredentials(
  registry: string,
  secretPrefix: string,
  username: string,
  password: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    const result = await checkRegistryCredentials(registry, username, password);
    if (result.ok && secretPrefix === "registry.tcr.v2") {
      localStorage.setItem(
        "abcdeploy.demo.connection.checked.tcr",
        new Date().toISOString(),
      );
    }
    return result;
  }
  return invoke<ProviderCheck>("replace_registry_credentials", {
    registry,
    secretPrefix,
    username,
    password,
  });
}

export async function checkSavedRegistryCredentials(
  registry: string,
  secretPrefix: string,
): Promise<ProviderCheck> {
  if (!isTauri()) {
    return {
      provider: "registry",
      ok: true,
      summary: "镜像仓库登录信息可用",
      details: [],
      nextSteps: [],
      retryable: false,
    };
  }
  return invoke<ProviderCheck>("check_saved_registry_credentials", {
    registry,
    secretPrefix,
  });
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
const DEMO_VERSION_VALIDATIONS_PREFIX = "abcdeploy.demo.version-validations.";
const DEMO_SECRETS_KEY = "abcdeploy.demo.secrets";
const DEMO_RUNTIME_CONFIGS_KEY = "abcdeploy.demo.runtime-configs";
const DEMO_CONFIG_PROFILES_KEY = "abcdeploy.demo.config-profiles";
const DEMO_SERVER_BINDINGS_KEY = "abcdeploy.demo.server-bindings";
const DEMO_WORKSPACE_ADOPTION_PREFIX = "abcdeploy.demo.workspace-adoption.";

function demoManifestKey(path: string) {
  return `abcdeploy.demo.manifest.${encodeURIComponent(path)}`;
}

function demoWorkspaceAdoptionKey(path: string) {
  return `${DEMO_WORKSPACE_ADOPTION_PREFIX}${encodeURIComponent(path)}`;
}

function readDemoWorkspaceAdoption(
  path: string,
): WorkspacePreview["adoption"] | null {
  try {
    const value = localStorage.getItem(demoWorkspaceAdoptionKey(path));
    return value ? (JSON.parse(value) as WorkspacePreview["adoption"]) : null;
  } catch {
    return null;
  }
}

function writeDemoWorkspaceAdoption(
  path: string,
  adoption: WorkspacePreview["adoption"],
) {
  localStorage.setItem(
    demoWorkspaceAdoptionKey(path),
    JSON.stringify(adoption),
  );
}

function demoVersionValidationsKey(path: string) {
  return `${DEMO_VERSION_VALIDATIONS_PREFIX}${encodeURIComponent(path)}`;
}

function readDemoVersionValidations(path: string): VersionValidation[] {
  try {
    const raw = localStorage.getItem(demoVersionValidationsKey(path));
    if (!raw) return [];
    return (JSON.parse(raw) as VersionValidation[]).filter(
      (validation) =>
        typeof validation.versionKey === "string" &&
        (validation.state === "passed" || validation.state === "rejected") &&
        typeof validation.runId === "string" &&
        typeof validation.verifiedAt === "string",
    );
  } catch {
    return [];
  }
}

function writeDemoVersionValidations(
  path: string,
  validations: VersionValidation[],
) {
  localStorage.setItem(
    demoVersionValidationsKey(path),
    JSON.stringify(validations),
  );
}

function demoServerBindingKey(
  path: string,
  environment: "staging" | "production",
) {
  return `${encodeURIComponent(path)}:${environment}`;
}

function readDemoServerBindings(): Record<string, ServerResource> {
  try {
    const value = JSON.parse(
      localStorage.getItem(DEMO_SERVER_BINDINGS_KEY) ?? "{}",
    ) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, ServerResource>)
      : {};
  } catch {
    return {};
  }
}
const demoConfigProfileSecrets = new Map<string, Record<string, string>>();
const demoGeneratedRuntimeSecrets = new Map<string, string>();

function demoEmptyRuntimeVariables(content: string): string[] {
  return content.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/,
    );
    return match && ["", '\"\"', "''"].includes(match[2].trim())
      ? [match[1]]
      : [];
  });
}

function demoInternalRuntimeSecret(variable: string): boolean {
  return [
    "JWT_SECRET",
    "AUTH_TOKEN_SECRET",
    "SESSION_SECRET",
    "COOKIE_SECRET",
    "ENCRYPTION_KEY",
    "SECRET_KEY",
  ].some((suffix) => variable === suffix || variable.endsWith(`_${suffix}`));
}

function demoGeneratedRuntimeSecret(
  path: string,
  environment: RuntimeEnvironment,
  variable: string,
): string {
  const key = `${path}:${environment}:${variable}`;
  const existing = demoGeneratedRuntimeSecrets.get(key);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  demoGeneratedRuntimeSecrets.set(key, value);
  return value;
}

function demoRuntimeValuesFromProfile(
  profile: ConfigProfile,
  path: string,
  environment: RuntimeEnvironment,
): Record<string, string> {
  const secrets = demoConfigProfileSecrets.get(profile.id) ?? {};
  if (profile.kind === "ai" && profile.provider === "minimax") {
    return {
      AI_PROVIDER: "minimax",
      ...(profile.values.base_url
        ? { MINIMAX_BASE_URL: profile.values.base_url }
        : {}),
      ...(profile.values.model ? { MINIMAX_MODEL: profile.values.model } : {}),
      ...(secrets.api_key ? { MINIMAX_API_KEY: secrets.api_key } : {}),
    };
  }
  if (
    profile.kind === "database" &&
    profile.provider === "abcdeploy_local_postgres" &&
    secrets.password
  ) {
    const project = path
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const database = `abc_demo_${project || "project"}_${environment}`;
    const host = profile.values.host || "127.0.0.1";
    const port = profile.values.port || "55432";
    const user = profile.values.user || "abcdeploy";
    return {
      DATABASE_URL: `postgresql://${user}:${secrets.password}@${host}:${port}/${database}`,
    };
  }
  if (
    profile.kind === "redis" &&
    profile.provider === "abcdeploy_local_redis" &&
    secrets.password
  ) {
    const host = profile.values.host || "127.0.0.1";
    const port = profile.values.port || "56379";
    return { REDIS_URL: `redis://:${secrets.password}@${host}:${port}/0` };
  }
  if (profile.kind === "database" && secrets.url) {
    return { DATABASE_URL: secrets.url };
  }
  if (profile.kind === "redis" && secrets.url) {
    return { REDIS_URL: secrets.url };
  }
  if (profile.kind === "custom") {
    const values: Record<string, string> = {};
    const variable = profile.values.env_name;
    if (variable && /^[A-Z_][A-Z0-9_]*$/.test(variable)) {
      const value = profile.values.env_value || secrets[variable];
      if (value) values[variable] = value;
    }
    return values;
  }
  return {};
}

function fillDemoRuntimeValues(
  content: string,
  suggestions: Record<string, string>,
): { content: string; filledVariables: string[] } {
  const filledVariables: string[] = [];
  const lines = content.split("\n").map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=)(.*)$/);
    if (!match) return line;
    const [, assignment, variable, rawValue] = match;
    const suggestion = suggestions[variable];
    if (!suggestion || !["", '""', "''"].includes(rawValue.trim())) {
      return line;
    }
    filledVariables.push(variable);
    return `${assignment}${demoDotenvValue(suggestion)}`;
  });
  return { content: lines.join("\n"), filledVariables };
}

function demoDotenvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function readDemoConfigProfiles(): ConfigProfile[] {
  try {
    const profiles = (
      JSON.parse(
        localStorage.getItem(DEMO_CONFIG_PROFILES_KEY) ?? "[]",
      ) as ConfigProfile[]
    ).map((profile) => ({
      ...profile,
      scope: profile.scope ?? "any",
    }));
    restoreDemoManagedProfileSecrets(profiles);
    return profiles;
  } catch {
    return [];
  }
}

function restoreDemoManagedProfileSecrets(profiles: ConfigProfile[]) {
  if (
    localStorage.getItem("abcdeploy.demo.local-infrastructure") !== "running"
  ) {
    return;
  }
  for (const profile of profiles) {
    if (
      (profile.provider === "abcdeploy_local_postgres" ||
        profile.provider === "abcdeploy_local_redis") &&
      !demoConfigProfileSecrets.has(profile.id)
    ) {
      demoConfigProfileSecrets.set(profile.id, {
        password: "demo-local-password",
      });
    }
  }
}

function demoBindingKey(
  path: string,
  environment: RuntimeEnvironment,
  kind: ConfigProfile["kind"],
) {
  return `abcdeploy.demo.binding.${path}.${environment}.${kind}`;
}

function demoBindingsKey(path: string, environment: RuntimeEnvironment) {
  return `abcdeploy.demo.bindings.${encodeURIComponent(path)}.${environment}`;
}

function readDemoConfigProfileBindings(
  path: string,
  environment: RuntimeEnvironment,
): ProjectProfileBinding[] {
  const grouped = localStorage.getItem(demoBindingsKey(path, environment));
  if (grouped !== null) {
    try {
      return JSON.parse(grouped) as ProjectProfileBinding[];
    } catch {
      return [];
    }
  }
  return (["ai", "database", "redis", "dns", "registry", "custom"] as const)
    .map((kind) =>
      localStorage.getItem(demoBindingKey(path, environment, kind)),
    )
    .flatMap((value) =>
      value ? [JSON.parse(value) as ProjectProfileBinding] : [],
    );
}

function writeDemoConfigProfileBindings(
  path: string,
  environment: RuntimeEnvironment,
  bindings: ProjectProfileBinding[],
) {
  localStorage.setItem(
    demoBindingsKey(path, environment),
    JSON.stringify(bindings),
  );
  for (const kind of [
    "ai",
    "database",
    "redis",
    "dns",
    "registry",
    "custom",
  ] as const) {
    localStorage.removeItem(demoBindingKey(path, environment, kind));
  }
  for (const binding of bindings) {
    localStorage.setItem(
      demoBindingKey(path, environment, binding.kind),
      JSON.stringify(binding),
    );
  }
}

function demoLocalInfrastructureStatus(): LocalInfrastructureStatus {
  const prepared = localStorage.getItem("abcdeploy.demo.local-infrastructure");
  const saved = localStorage.getItem(
    "abcdeploy.demo.local-infrastructure-services",
  );
  const services = saved
    ? (JSON.parse(saved) as { postgres: boolean; redis: boolean })
    : { postgres: prepared === "running", redis: prepared === "running" };
  const running = services.postgres && services.redis;
  const partial = services.postgres || services.redis;
  return {
    state: running
      ? "running"
      : partial
        ? "partial"
        : prepared
          ? "stopped"
          : "not_prepared",
    message: running
      ? "本机数据库和 Redis 运行正常"
      : partial
        ? "部分本机基础服务正在运行"
        : prepared
          ? "本机基础服务已停止"
          : "本机数据库和 Redis 尚未准备",
    postgresRunning: services.postgres,
    redisRunning: services.redis,
    postgresPort: 55432,
    redisPort: 56379,
    profilesReady: running,
  };
}

function readDemoLocalServices(path: string) {
  try {
    return JSON.parse(
      localStorage.getItem(`abcdeploy.demo.local-services.${path}`) ?? "{}",
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

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
    "# 当前运行环境",
    `DEPLOYDESK_ENV=${environment}`,
    "# 数据库连接地址",
    "DATABASE_URL=",
    "# 应用内部安全密钥",
    "APP_SECRET=",
    "# 项目公开访问地址",
    "PUBLIC_SITE_URL=",
    "# 可选功能开关",
    "OPTIONAL_FEATURE_ENABLED=",
    "",
  ].join("\n");
}

function demoLocalPreview(
  path: string,
  state: LocalPreviewStatus["state"],
): LocalPreviewStatus {
  const running = state === "running";
  const individual = readDemoLocalServices(path);
  return {
    state,
    message: running ? "本地容器均已通过运行检查" : "本地容器预览尚未启动",
    composePath: `${path}/.deploydesk/generated/development/docker-compose.yml`,
    envReady: localStorage.getItem(`abcdeploy.demo.local-env.${path}`) !== null,
    writtenFiles: [],
    services: [
      {
        id: "api",
        kind: "api",
        buildStrategy: "existing",
        dockerfile: "apps/api/Dockerfile",
        hostPort: 3000,
        url: "http://127.0.0.1:3000",
        running: running || Boolean(individual.api),
      },
      {
        id: "admin",
        kind: "static",
        buildStrategy: "existing",
        dockerfile: "apps/admin/Dockerfile",
        hostPort: 4174,
        url: "http://127.0.0.1:4174",
        running: running || Boolean(individual.admin),
      },
    ],
  };
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
        latestRunId: latest?.id ?? project.latestRunId ?? null,
        latestSourceRunId:
          latest?.sourceRunId ?? project.latestSourceRunId ?? null,
        latestCurrentStage:
          latest?.currentStage ?? project.latestCurrentStage ?? null,
        latestActionKind:
          latest?.actionKind ?? project.latestActionKind ?? null,
        latestIssueCode: latest?.issueCode ?? project.latestIssueCode ?? null,
        latestCompletedSteps:
          latest?.completedSteps ?? project.latestCompletedSteps ?? [],
        latestUpdatedAt: latest?.updatedAt ?? project.latestUpdatedAt ?? null,
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
    latestRunId: previous?.latestRunId ?? null,
    latestSourceRunId: previous?.latestSourceRunId ?? null,
    latestCurrentStage: previous?.latestCurrentStage ?? null,
    latestActionKind: previous?.latestActionKind ?? null,
    latestIssueCode: previous?.latestIssueCode ?? null,
    latestCompletedSteps: previous?.latestCompletedSteps ?? [],
    latestUpdatedAt: previous?.latestUpdatedAt ?? null,
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
      latestRunId: run.id,
      latestSourceRunId: run.sourceRunId,
      latestCurrentStage: run.currentStage,
      latestActionKind: run.actionKind,
      latestIssueCode: run.issueCode,
      latestCompletedSteps: run.completedSteps,
      latestUpdatedAt: run.updatedAt,
      activeRunCount: nextRuns.filter(
        (item) =>
          item.projectPath === project.path &&
          ["queued", "running"].includes(item.status),
      ).length,
    };
  });
  localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(projects));
}

function demoProjectEnvironments(path: string): ProjectEnvironment[] {
  const projectRuns = readDemoRuns().filter(
    (run) => run.projectPath === path && run.status === "success",
  );
  const latestSuccessful = (environment: DeploymentRun["environment"]) =>
    projectRuns
      .filter(
        (run) =>
          run.environment === environment &&
          !(
            run.environment === "staging" &&
            run.actionKind === "production-approval"
          ),
      )
      .sort(compareDemoRuns)[0];
  const staging = latestSuccessful("staging");
  const production = latestSuccessful("production");
  const productionSource = production?.sourceRunId
    ? projectRuns.find(
        (run) =>
          run.environment === "staging" && run.id === production.sourceRunId,
      )
    : undefined;
  const environment = (
    name: ProjectEnvironment["environment"],
    displayName: string,
    currentRun: DeploymentRun | undefined,
    currentVersionKey: string | null,
  ): ProjectEnvironment => ({
    environment: name,
    displayName,
    status: currentVersionKey ? "healthy" : "unknown",
    currentVersionKey,
    currentRunId: currentRun?.id ?? null,
  });

  return [
    environment("development", "本机环境", undefined, null),
    environment(
      "staging",
      "测试环境",
      staging,
      staging ? deploymentVersionKey(staging) : null,
    ),
    environment(
      "production",
      "生产环境",
      production,
      productionSource
        ? deploymentVersionKey(productionSource)
        : production
          ? deploymentVersionKey(production)
          : null,
    ),
  ];
}

function demoProjectVersions(path: string): ProjectVersion[] {
  const successfulStagingRuns = readDemoRuns()
    .filter(
      (run) =>
        run.projectPath === path &&
        run.environment === "staging" &&
        run.status === "success" &&
        run.actionKind !== "production-approval",
    )
    .sort(compareDemoRuns);
  const validations = new Map(
    readDemoVersionValidations(path).map((validation) => [
      validation.versionKey,
      validation,
    ]),
  );
  const environments = demoProjectEnvironments(path);
  const environmentKeys = new Map(
    environments.map((environment) => [
      environment.environment,
      environment.currentVersionKey,
    ]),
  );
  const currentStagingRunId = environments.find(
    (environment) => environment.environment === "staging",
  )?.currentRunId;
  const seen = new Set<string>();

  return successfulStagingRuns.flatMap((run) => {
    const versionKey = deploymentVersionKey(run);
    if (seen.has(versionKey)) return [];
    seen.add(versionKey);
    const matchingRuns = successfulStagingRuns.filter(
      (candidate) => deploymentVersionKey(candidate) === versionKey,
    );
    const stagingRun =
      matchingRuns.find((candidate) => candidate.id === currentStagingRunId) ??
      [...matchingRuns].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.startedAt.localeCompare(left.startedAt) ||
          right.id.localeCompare(left.id),
      )[0];
    const currentEnvironments = (["staging", "production"] as const).filter(
      (environment) => environmentKeys.get(environment) === versionKey,
    );
    const artifacts = Array.from(
      new Map(
        run.artifacts
          .filter((artifact) => artifact.digest.trim())
          .map((artifact) => {
            const normalized = {
              service: artifact.service.trim(),
              image: artifact.image.trim(),
              digest: artifact.digest.trim().toLowerCase(),
            };
            return [
              `${normalized.service}\u0000${normalized.image}\u0000${normalized.digest}`,
              normalized,
            ] as const;
          }),
      ).values(),
    ).sort(
      (left, right) =>
        left.service.localeCompare(right.service) ||
        left.image.localeCompare(right.image) ||
        left.digest.localeCompare(right.digest),
    );

    return [
      {
        id: `demo-version:${encodeURIComponent(versionKey)}`,
        versionKey,
        status: "available",
        commitSha: run.commitSha ?? null,
        sourceTitle: run.sourceTitle ?? null,
        sourceConnectionId: null,
        sourceBuildId: run.buildSerial ?? null,
        repository: run.repository || null,
        branch: run.branch || null,
        candidateTag: run.candidateTag ?? null,
        stagingRunId: stagingRun?.id ?? null,
        artifacts,
        validation: validations.get(versionKey) ?? null,
        currentEnvironments,
        createdAt: matchingRuns.reduce(
          (earliest, candidate) =>
            candidate.startedAt < earliest ? candidate.startedAt : earliest,
          run.startedAt,
        ),
        updatedAt: run.updatedAt,
      },
    ];
  });
}

function compareDemoRuns(left: DeploymentRun, right: DeploymentRun) {
  return (
    right.startedAt.localeCompare(left.startedAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id)
  );
}

function demoWorkspace(path: string): WorkspacePreview {
  return {
    adoption: {
      mode: "fresh",
      detected: false,
      repository: null,
      pipelineExists: false,
      historyImportAfter: null,
      freshDraft: false,
    },
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
          start_command: "corepack pnpm run start:prod",
          dependency_file: "apps/api/package.json",
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
          start_command: null,
          dependency_file: "apps/admin/package.json",
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
          start_command: null,
          dependency_file: "apps/miniapp/package.json",
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
        { name: "APP_SECRET", secret: true, source: ".env.example" },
        { name: "PUBLIC_SITE_URL", secret: false, source: ".env.example" },
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
