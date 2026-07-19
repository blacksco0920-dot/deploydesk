import {
  Check,
  ChevronRight,
  CircleAlert,
  CloudCog,
  ExternalLink,
  FolderCode,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseDocument } from "yaml";
import {
  bindProjectServer,
  checkCnbRepositoryAccess,
  checkSavedRegistryCredentials,
  checkServer,
  connectCnb,
  deleteDeploymentPath,
  generateSshIdentity,
  installServerKeyWithPassword,
  listConnections,
  listDeploymentPathRuns,
  listDeploymentPaths,
  listServers,
  loadRuntimeConfig,
  prepareDeploymentPathRetry,
  replaceRegistryCredentials,
  redeployDeploymentPathVersion,
  saveDeploymentPath,
  setAppSetting,
  takeOverDeploymentPathRoutes,
} from "../api";
import type {
  ConnectionResource,
  DeploymentPath,
  DeploymentPathRoute,
  DeploymentRun,
  ServerForm,
  ServerResource,
  WorkspacePreview,
} from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import { RuntimeConfigFields } from "./RuntimeConfigFields";

type PathNode = "local" | "build" | "registry" | "server";
type NodeTone = "ready" | "waiting" | "working" | "error";

interface DeploymentPathWorkspaceProps {
  autoCreateDefault?: boolean;
  path: string;
  workspace: WorkspacePreview;
  runs: DeploymentRun[];
  onDeploy: (
    deploymentPathId: string,
    previousTaskId: string | null,
    server: ServerForm,
    repository: string,
    useCurrentLocalState?: boolean,
  ) => Promise<DeploymentRun | void>;
  onError: (message: string) => void;
  onRefresh: (run: DeploymentRun) => Promise<DeploymentRun>;
  onRunUpdated: (run: DeploymentRun) => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
}

interface NodeStatus {
  tone: NodeTone;
  summary: string;
  provider?: string;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function manifestValue(yaml: string, path: Array<string | number>): string {
  try {
    const value = parseDocument(yaml).getIn(path);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function firstManifestDomain(yaml: string) {
  try {
    const document = parseDocument(yaml);
    for (const environment of ["production", "staging"]) {
      const domains = document.getIn(["environments", environment, "domains"]);
      if (Array.isArray(domains)) {
        const first = domains.find((domain) => typeof domain === "string");
        if (typeof first === "string") return first;
      }
    }
  } catch {
    // A malformed manifest is reported by the local-project node.
  }
  return "";
}

function manifestRoutes(yaml: string): DeploymentPathRoute[] {
  try {
    const value = parseDocument(yaml).toJS() as {
      environments?: Record<string, { domains?: unknown }>;
    };
    for (const environment of ["production", "staging"]) {
      const domains = value.environments?.[environment]?.domains;
      if (!Array.isArray(domains) || domains.length === 0) continue;
      return domains.flatMap((route) => {
        if (!route || typeof route !== "object") return [];
        const record = route as Record<string, unknown>;
        if (
          typeof record.service !== "string" ||
          typeof record.host !== "string"
        ) {
          return [];
        }
        return [
          {
            service: record.service,
            host: record.host,
            path: typeof record.path === "string" ? record.path : "/",
          },
        ];
      });
    }
  } catch {
    // Manifest validation owns malformed YAML reporting.
  }
  return [];
}

function normalizedAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function deploymentSlug(value: string, fallback: string, maxLength: number) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength) || fallback
  );
}

function automaticRouteDrafts(
  routes: DeploymentPathRoute[],
  workspace: WorkspacePreview,
  server: Pick<ServerResource, "host"> | undefined,
) {
  const octets = server?.host.trim().split(".").map(Number);
  if (
    !octets ||
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return routes;
  }
  const project = deploymentSlug(
    workspace.inspection.project_name,
    "project",
    30,
  );
  const address = octets.join("-");
  return routes.map((route) => ({
    ...route,
    host:
      route.host.trim() ||
      `${project}-${deploymentSlug(route.service, "app", 20)}.${address}.sslip.io`,
  }));
}

function connectionReady(connection: ConnectionResource | undefined) {
  return Boolean(
    connection && ["ready", "configured"].includes(connection.status),
  );
}

function statusCopy(tone: NodeTone) {
  if (tone === "ready") return "已就绪";
  if (tone === "working") return "处理中";
  if (tone === "error") return "需要修复";
  return "待配置";
}

function runProblemNode(run: DeploymentRun | undefined): PathNode | null {
  if (!run || !["failed", "needs_action"].includes(run.status)) return null;
  if (["local", "prepare", "sync-source"].includes(run.currentStage))
    return "local";
  if (["build", "trigger-build"].includes(run.currentStage)) return "build";
  if (run.currentStage === "registry") return "registry";
  return "server";
}

function needsFreshLocalSnapshot(run: DeploymentRun | undefined) {
  if (!run || run.status !== "needs_action") return false;
  if (
    !["local", "prepare", "sync-source", "build", "trigger-build"].includes(
      run.currentStage,
    )
  )
    return false;
  return (
    run.issueCode === "AD-GIT-102" ||
    run.actionKind === "deployment-path-source-retry" ||
    run.message.includes("本地项目快照") ||
    run.message.includes("重新开始上线")
  );
}

const nodeMeta: Array<{
  id: PathNode;
  title: string;
  description: string;
  icon: typeof FolderCode;
}> = [
  {
    id: "local",
    title: "本地项目",
    description: "你电脑里的当前项目",
    icon: FolderCode,
  },
  {
    id: "build",
    title: "构建服务",
    description: "把代码生成可运行版本",
    icon: CloudCog,
  },
  {
    id: "registry",
    title: "版本仓库",
    description: "安全保存每次上线版本",
    icon: PackageOpen,
  },
  {
    id: "server",
    title: "运行服务器",
    description: "运行项目并提供访问地址",
    icon: Server,
  },
];

export function DeploymentPathWorkspace({
  autoCreateDefault = false,
  path,
  workspace,
  runs,
  onDeploy,
  onError,
  onRefresh,
  onRunUpdated,
  onSaveManifest,
}: DeploymentPathWorkspaceProps) {
  const [paths, setPaths] = useState<DeploymentPath[]>([]);
  const [connections, setConnections] = useState<ConnectionResource[]>([]);
  const [servers, setServers] = useState<ServerResource[]>([]);
  const [pathRuns, setPathRuns] = useState<DeploymentRun[]>([]);
  const [runtimeConfigReady, setRuntimeConfigReady] = useState(false);
  const [runtimeConfigRequired, setRuntimeConfigRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [activePathId, setActivePathId] = useState("");
  const [activeNode, setActiveNode] = useState<PathNode | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [confirmingDeploy, setConfirmingDeploy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [cnbToken, setCnbToken] = useState("");
  const [registryEndpoint, setRegistryEndpoint] = useState("");
  const [registryNamespace, setRegistryNamespace] = useState("");
  const [registryUsername, setRegistryUsername] = useState("");
  const [registryPassword, setRegistryPassword] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [routeDrafts, setRouteDrafts] = useState<DeploymentPathRoute[]>([]);
  const [serverDraft, setServerDraft] = useState<ServerForm>({
    name: "运行服务器",
    host: "",
    user: "ubuntu",
    port: 22,
    keyPath: "",
  });
  const [serverPassword, setServerPassword] = useState("");
  const [serverPasswordError, setServerPasswordError] = useState("");
  const [changingServer, setChangingServer] = useState(false);
  const serverPasswordInputRef = useRef<HTMLInputElement>(null);
  const autoCreateAttempted = useRef(false);

  const repository = manifestValue(workspace.manifestYaml, [
    "providers",
    "build",
    "repository",
  ]);
  const manifestRegistry = manifestValue(workspace.manifestYaml, [
    "providers",
    "registry",
    "registry",
  ]);
  const manifestNamespace = manifestValue(workspace.manifestYaml, [
    "providers",
    "registry",
    "namespace",
  ]);

  const refreshResources = useCallback(async () => {
    const [nextPaths, nextConnections, nextServers] = await Promise.all([
      listDeploymentPaths(path),
      listConnections(),
      listServers(),
    ]);
    setPaths(nextPaths);
    setConnections(nextConnections);
    setServers(nextServers);
    setActivePathId((current) =>
      nextPaths.some((candidate) => candidate.id === current)
        ? current
        : (nextPaths[0]?.id ?? ""),
    );
  }, [path]);

  useEffect(() => {
    if (!activePathId) {
      setRuntimeConfigRequired(false);
      setRuntimeConfigReady(false);
      return;
    }
    let active = true;
    loadRuntimeConfig(path, activePathId as `path-${string}`)
      .then((config) => {
        if (!active) return;
        setRuntimeConfigRequired(Boolean(config.requiredVariables.length));
        setRuntimeConfigReady(
          config.stored || config.requiredVariables.length === 0,
        );
      })
      .catch(() => {
        if (!active) return;
        setRuntimeConfigRequired(false);
        setRuntimeConfigReady(false);
      });
    return () => {
      active = false;
    };
  }, [activePathId, path]);

  useEffect(() => {
    if (!activePathId) {
      setPathRuns([]);
      return;
    }
    let active = true;
    listDeploymentPathRuns(activePathId)
      .then((records) => active && setPathRuns(records))
      .catch(() => active && setPathRuns([]));
    return () => {
      active = false;
    };
  }, [activePathId, runs]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refreshResources()
      .catch((error) => active && onError(messageOf(error)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [onError, refreshResources]);

  const activePath = paths.find((candidate) => candidate.id === activePathId);
  const selectedSource = connections.find(
    (connection) => connection.id === activePath?.sourceConnectionId,
  );
  const selectedRegistry = connections.find(
    (connection) => connection.id === activePath?.registryConnectionId,
  );
  const selectedServer = servers.find(
    (server) => server.id === activePath?.serverId,
  );
  const pointedRun = activePath?.lastRunId
    ? runs.find((run) => run.id === activePath.lastRunId)
    : undefined;
  // The path pointer can lag behind when the app is closed during a failed
  // preparation. The append-only path history is authoritative: always show
  // and continue its newest attempt instead of reviving an older error.
  const activeRun = pathRuns[0] ?? pointedRun;
  const problemNode = runProblemNode(activeRun);
  const freshLocalSnapshotRequired = needsFreshLocalSnapshot(activeRun);

  const nodeStatuses = useMemo<Record<PathNode, NodeStatus>>(() => {
    const localReady =
      workspace.inspection.services.length > 0 && workspace.validation.valid;
    const repositoryReady =
      repository.includes("/") &&
      !repository.includes("replace-me") &&
      !repository.startsWith("owner/");
    const buildReady = repositoryReady && connectionReady(selectedSource);
    const registryReady =
      Boolean(manifestRegistry && manifestNamespace) &&
      connectionReady(selectedRegistry);
    const serverReady = Boolean(
      selectedServer &&
      activePath?.routes.length &&
      activePath.routes.every((route) => route.host.trim()) &&
      (runtimeConfigReady || !runtimeConfigRequired),
    );
    return {
      local: {
        tone: problemNode === "local" || !localReady ? "error" : "ready",
        summary:
          problemNode === "local"
            ? freshLocalSnapshotRequired
              ? "需要重新读取当前项目"
              : (activeRun?.message ?? "本地项目需要处理")
            : localReady
              ? `已识别 ${workspace.inspection.services.length} 个项目服务`
              : "项目结构还需要处理",
      },
      build: {
        tone:
          problemNode === "build" ? "error" : buildReady ? "ready" : "waiting",
        summary:
          problemNode === "build"
            ? freshLocalSnapshotRequired
              ? "需要重新读取当前项目"
              : (activeRun?.message ?? "构建服务需要处理")
            : buildReady
              ? "连接可用"
              : "还没有完成连接",
        provider: selectedSource?.provider.toUpperCase() || "CNB",
      },
      registry: {
        tone:
          problemNode === "registry"
            ? "error"
            : registryReady
              ? "ready"
              : "waiting",
        summary:
          problemNode === "registry"
            ? (activeRun?.message ?? "版本仓库需要处理")
            : registryReady
              ? "登录信息可用"
              : "还没有完成连接",
        provider: selectedRegistry?.provider.toUpperCase() || "TCR",
      },
      server: {
        tone:
          problemNode === "server"
            ? "error"
            : serverReady
              ? "ready"
              : "waiting",
        summary:
          problemNode === "server"
            ? (activeRun?.message ?? "运行服务器需要处理")
            : selectedServer
              ? activePath?.routes.length
                ? `${activePath.routes.length} 个访问地址`
                : "还差访问地址"
              : "还没有选择服务器",
        provider: selectedServer?.host,
      },
    };
  }, [
    activePath?.address,
    activeRun?.status,
    activeRun?.currentStage,
    activeRun?.message,
    freshLocalSnapshotRequired,
    manifestNamespace,
    manifestRegistry,
    repository,
    runtimeConfigReady,
    runtimeConfigRequired,
    selectedRegistry,
    selectedServer,
    selectedSource,
    workspace.inspection.services.length,
    workspace.validation.valid,
  ]);

  const allReady = nodeMeta.every(
    (node) => nodeStatuses[node.id].tone === "ready",
  );
  const firstBlockedNode = nodeMeta.find(
    (node) => nodeStatuses[node.id].tone !== "ready",
  )?.id;
  const nextActionLabel =
    firstBlockedNode === "local"
      ? "检查本地项目"
      : firstBlockedNode === "build"
        ? "连接构建服务"
        : firstBlockedNode === "registry"
          ? "连接版本仓库"
          : firstBlockedNode === "server"
            ? selectedServer
              ? "设置访问地址"
              : "连接运行服务器"
            : "开始上线";

  async function createPath() {
    setBusy("create");
    try {
      const sourceCandidates = connections.filter(
        (connection) =>
          connection.kind === "source" && connectionReady(connection),
      );
      const registryCandidates = connections.filter(
        (connection) =>
          connection.kind === "registry" && connectionReady(connection),
      );
      const created = await saveDeploymentPath({
        projectPath: path,
        name: paths.length ? `上线 ${paths.length + 1}` : "上线",
        sourceConnectionId:
          sourceCandidates.length === 1 ? sourceCandidates[0].id : null,
        registryConnectionId:
          registryCandidates.length === 1 ? registryCandidates[0].id : null,
        serverId: null,
        configProfileIds: [],
        address:
          paths.length === 0 ? firstManifestDomain(workspace.manifestYaml) : "",
        routes:
          paths.length === 0 ? manifestRoutes(workspace.manifestYaml) : [],
      });
      await refreshResources();
      setActivePathId(created.id);
      setActiveNode("local");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (
      loading ||
      !autoCreateDefault ||
      autoCreateAttempted.current ||
      paths.length > 0
    ) {
      return;
    }
    autoCreateAttempted.current = true;
    void createPath();
  }, [autoCreateDefault, loading, paths.length]);

  function openNode(node: PathNode, selectedPath = activePath) {
    if (!selectedPath) return;
    setActivePathId(selectedPath.id);
    setActiveNode(node);
    setNameDraft(selectedPath.name);
    setRepositoryDraft(repository);
    setRegistryEndpoint(
      selectedRegistry?.metadata.endpoint ||
        manifestRegistry ||
        "ccr.ccs.tencentyun.com",
    );
    setRegistryNamespace(
      selectedRegistry?.metadata.namespace || manifestNamespace,
    );
    setAddressDraft(selectedPath.address);
    const savedRoutes = selectedPath.routes.length
      ? selectedPath.routes
      : manifestRoutes(workspace.manifestYaml);
    const publicService =
      workspace.inspection.services.find((service) =>
        ["web", "static"].includes(service.kind),
      ) ??
      workspace.inspection.services.find(
        (service) => service.kind !== "worker",
      );
    const pathServer = servers.find(
      (server) => server.id === selectedPath.serverId,
    );
    setRouteDrafts(
      automaticRouteDrafts(
        savedRoutes.length
          ? savedRoutes
          : publicService
            ? [{ service: publicService.id, host: "", path: "/" }]
            : [],
        workspace,
        pathServer,
      ),
    );
    if (pathServer) {
      setServerDraft({
        name: pathServer.name,
        host: pathServer.host,
        user: pathServer.user,
        port: pathServer.port,
        keyPath: pathServer.keyPath,
        hostFingerprint: pathServer.hostFingerprint,
      });
    }
  }

  async function updateActivePath(
    changes: Partial<
      Omit<DeploymentPath, "id" | "projectPath" | "createdAt" | "updatedAt">
    >,
  ) {
    if (!activePath) return null;
    const saved = await saveDeploymentPath({
      ...activePath,
      ...changes,
      projectPath: path,
    });
    await refreshResources();
    setActivePathId(saved.id);
    return saved;
  }

  async function markNodeRepaired(node: PathNode) {
    if (!activeRun || activeRun.status !== "needs_action") return;
    const updated = await prepareDeploymentPathRetry(activeRun.id, node);
    onRunUpdated(updated);
    await updateActivePath({ lastRunId: updated.id });
  }

  async function savePathName() {
    setBusy("name");
    try {
      await updateActivePath({ name: nameDraft });
      setEditingName(false);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  function checkedRepositoryDraft() {
    const nextRepository = repositoryDraft.trim();
    if (!nextRepository) throw new Error("请填写项目代码仓库");
    if (
      !nextRepository.includes("/") ||
      nextRepository.includes("replace-me")
    ) {
      throw new Error("项目代码仓库应填写为“组织/仓库”");
    }
    return nextRepository;
  }

  async function persistRepositoryDraft(nextRepository: string) {
    if (nextRepository === repository) return;
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(["source", "repository"], nextRepository);
    document.setIn(["providers", "build", "repository"], nextRepository);
    if (!(await onSaveManifest(document.toString()))) {
      throw new Error("项目代码仓库没有保存，请重试");
    }
  }

  async function selectSource(connectionId: string) {
    setBusy("source");
    try {
      const nextRepository = checkedRepositoryDraft();
      const check = await checkCnbRepositoryAccess(nextRepository);
      if (!check.ok) throw new Error(check.summary);
      await persistRepositoryDraft(nextRepository);
      await updateActivePath({ sourceConnectionId: connectionId });
      await markNodeRepaired("build");
      setActiveNode(firstBlockedNode === "build" ? "registry" : null);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function connectBuildService() {
    if (!cnbToken.trim()) return;
    setBusy("source");
    try {
      const nextRepository = checkedRepositoryDraft();
      await connectCnb(cnbToken.trim(), true, nextRepository);
      await persistRepositoryDraft(nextRepository);
      const nextConnections = await listConnections();
      setConnections(nextConnections);
      const connection = nextConnections.find(
        (candidate) =>
          candidate.kind === "source" && candidate.provider === "cnb",
      );
      if (!connection)
        throw new Error("构建服务已经授权，但连接记录没有刷新成功");
      await updateActivePath({ sourceConnectionId: connection.id });
      await markNodeRepaired("build");
      setCnbToken("");
      setActiveNode("registry");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function saveRegistryConnection() {
    setBusy("registry");
    try {
      const endpoint = registryEndpoint.trim();
      const namespace = registryNamespace.trim();
      if (!endpoint || !namespace)
        throw new Error("请填写版本仓库地址和命名空间");
      let check;
      if (registryUsername || registryPassword) {
        check = await replaceRegistryCredentials(
          endpoint,
          "registry.tcr.v2",
          registryUsername,
          registryPassword,
        );
      } else {
        check = await checkSavedRegistryCredentials(
          endpoint,
          "registry.tcr.v2",
        );
      }
      if (!check.ok) throw new Error(check.summary);
      await Promise.all([
        setAppSetting("registry.tcr.v2.verified-endpoint", endpoint),
        setAppSetting("registry.tcr.namespace", namespace),
      ]);
      const document = parseDocument(workspace.manifestYaml);
      document.setIn(["providers", "registry", "registry"], endpoint);
      document.setIn(["providers", "registry", "namespace"], namespace);
      if (!(await onSaveManifest(document.toString()))) return;
      const nextConnections = await listConnections();
      setConnections(nextConnections);
      const connection = nextConnections.find(
        (candidate) =>
          candidate.kind === "registry" && candidate.provider === "tcr",
      );
      if (!connection)
        throw new Error("版本仓库已验证，但连接记录没有刷新成功");
      await updateActivePath({ registryConnectionId: connection.id });
      await markNodeRepaired("registry");
      setRegistryPassword("");
      setActiveNode("server");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function selectRegistryConnection(connection: ConnectionResource) {
    setBusy("registry");
    try {
      const endpoint = connection.metadata.endpoint?.trim();
      const namespace = connection.metadata.namespace?.trim();
      if (!endpoint || !namespace)
        throw new Error("这个版本仓库连接缺少地址或命名空间");
      const check = await checkSavedRegistryCredentials(
        endpoint,
        "registry.tcr.v2",
      );
      if (!check.ok) throw new Error(check.summary);
      const document = parseDocument(workspace.manifestYaml);
      document.setIn(["providers", "registry", "registry"], endpoint);
      document.setIn(["providers", "registry", "namespace"], namespace);
      if (!(await onSaveManifest(document.toString()))) return;
      setRegistryEndpoint(endpoint);
      setRegistryNamespace(namespace);
      await updateActivePath({ registryConnectionId: connection.id });
      await markNodeRepaired("registry");
      setActiveNode("server");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function redeployVersion(run: DeploymentRun) {
    if (!activePath) return;
    setBusy(`version:${run.id}`);
    try {
      const deployed = await redeployDeploymentPathVersion(
        activePath.id,
        run.id,
      );
      const refreshed = await onRefresh(deployed);
      await refreshResources();
      setPathRuns(await listDeploymentPathRuns(activePath.id));
      if (refreshed.status === "success") setActiveNode(null);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function selectServer(server: ServerResource) {
    if (!activePath) return;
    setBusy("server");
    try {
      const form: ServerForm = {
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        keyPath: server.keyPath,
        hostFingerprint: server.hostFingerprint,
      };
      const check = await checkServer(form);
      if (!check.ok) throw new Error(check.summary);
      await updateActivePath({ serverId: server.id, address: addressDraft });
      await markNodeRepaired("server");
      setServerDraft(form);
      setRouteDrafts((current) =>
        automaticRouteDrafts(current, workspace, server),
      );
      setChangingServer(false);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function saveNewServer() {
    if (serverDraft.hostFingerprint && !serverPassword) {
      setServerPasswordError("请先输入这台服务器的登录密码");
      serverPasswordInputRef.current?.focus();
      return;
    }
    setServerPasswordError("");
    setBusy("server");
    try {
      let nextServer = serverDraft;
      if (!nextServer.keyPath) {
        const generated = await generateSshIdentity();
        nextServer = {
          ...nextServer,
          keyPath: generated.identity.path,
        };
        setServerDraft(nextServer);
      }

      const check = await checkServer(nextServer);
      if (!check.ok) {
        const fingerprint = check.details.find((detail) =>
          detail.startsWith("SHA256:"),
        );
        if (fingerprint && !nextServer.hostFingerprint) {
          setServerDraft({
            ...nextServer,
            hostFingerprint: fingerprint,
          });
          return;
        }
        if (
          check.code === "AD-SSH-105" ||
          check.provider === "ssh-key-install"
        ) {
          const installed = await installServerKeyWithPassword(
            nextServer,
            serverPassword,
          );
          if (!installed.ok) throw new Error(installed.summary);
        } else {
          throw new Error(check.summary);
        }
      }
      // The current runtime creates an application-level Server resource
      // through this command. The environment argument is an adapter detail;
      // the new product state only stores the returned reusable Server id.
      const resource = await bindProjectServer(path, "staging", nextServer);
      await updateActivePath({
        serverId: resource.id,
        address: addressDraft,
      });
      await markNodeRepaired("server");
      await refreshResources();
      setServerPassword("");
      setRouteDrafts((current) =>
        automaticRouteDrafts(current, workspace, resource),
      );
      setChangingServer(false);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function saveAddress() {
    setBusy("address");
    try {
      const routes = routeDrafts.map((route) => ({
        ...route,
        host: route.host.trim(),
        path: route.path.trim() || "/",
      }));
      if (!routes.length || routes.some((route) => !route.host)) {
        throw new Error("请填写项目访问地址");
      }
      const address = routes[0]?.host ?? addressDraft;
      await updateActivePath({ address, routes });
      await markNodeRepaired("server");
      setAddressDraft(address);
      setActiveNode(null);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function deployActivePath(restartFromCurrentProject = false) {
    if (!activePath) return;
    if (!selectedServer) {
      onError("请先连接运行服务器");
      openNode("server");
      return;
    }
    const preparationRetry =
      activeRun?.status === "needs_action" &&
      activeRun.actionKind === "deployment-path-preparation-retry";
    if (!allReady && !restartFromCurrentProject && !preparationRetry) return;
    setBusy("deploy");
    try {
      await updateActivePath({ state: "deploying" });
      const run = await onDeploy(
        activePath.id,
        restartFromCurrentProject
          ? null
          : (activeRun?.id ?? activePath.lastRunId),
        {
          name: selectedServer.name,
          host: selectedServer.host,
          user: selectedServer.user,
          port: selectedServer.port,
          keyPath: selectedServer.keyPath,
          hostFingerprint: selectedServer.hostFingerprint,
        },
        repository,
        true,
      );
      await updateActivePath({
        state:
          run?.status === "success"
            ? "online"
            : run?.status === "needs_action" || run?.status === "failed"
              ? "needs_action"
              : "deploying",
        lastRunId: run?.id ?? activePath.lastRunId,
        lastSuccessfulRevision:
          run?.status === "success"
            ? (run.commitSha ?? activePath.lastSuccessfulRevision)
            : activePath.lastSuccessfulRevision,
      });
    } catch (error) {
      await updateActivePath({ state: "needs_action" }).catch(() => undefined);
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  function requestDeploy() {
    if (!activePath) return;
    if (!activePath.lastRunId) {
      setConfirmingDeploy(true);
      return;
    }
    void deployActivePath();
  }

  async function refreshActiveRun() {
    if (!activePath || !activeRun) return;
    setBusy("refresh");
    try {
      const refreshed = await onRefresh(activeRun);
      await updateActivePath({
        state:
          refreshed.status === "success"
            ? "online"
            : refreshed.status === "failed" ||
                refreshed.status === "needs_action"
              ? "needs_action"
              : "deploying",
        lastRunId: refreshed.id,
        lastSuccessfulRevision:
          refreshed.status === "success"
            ? (refreshed.commitSha ?? activePath.lastSuccessfulRevision)
            : activePath.lastSuccessfulRevision,
      });
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function takeOverActiveRoutes() {
    if (!activePath || !activeRun) return;
    setBusy("takeover");
    try {
      const takenOver = await takeOverDeploymentPathRoutes(activeRun.id);
      const refreshed = await onRefresh(takenOver);
      await updateActivePath({
        state: refreshed.status === "success" ? "online" : "needs_action",
        lastSuccessfulRevision:
          refreshed.status === "success"
            ? (refreshed.commitSha ?? activePath.lastSuccessfulRevision)
            : activePath.lastSuccessfulRevision,
      });
      if (refreshed.status === "success") setActiveNode(null);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function removeActivePath() {
    if (!activePath || activePath.state === "deploying") return;
    setBusy("delete");
    try {
      await deleteDeploymentPath(path, activePath.id);
      setActiveNode(null);
      await refreshResources();
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <main className="grid min-h-[420px] place-items-center p-8">
        <div className="flex items-center gap-3 text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取部署线路
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] px-6 py-8 lg:px-10">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">部署线路</h1>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">
            从本地项目出发，经过两个自动服务，最后到达运行服务器。
          </p>
        </div>
        {paths.length > 0 ? (
          <Button onClick={() => void createPath()} variant="secondary">
            <Plus />
            新增线路
          </Button>
        ) : null}
      </div>

      {paths.length === 0 ? (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
          <div className="mx-auto max-w-5xl py-8 text-center">
            <div
              className="mb-8 grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-3"
              aria-hidden="true"
            >
              {nodeMeta.map((node, index) => {
                const Icon = node.icon;
                return [
                  <div
                    className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--muted)]/35 px-3 py-6"
                    key={node.id}
                  >
                    <Icon className="mx-auto mb-3 size-6 text-[var(--subtle-foreground)]" />
                    <div className="text-sm font-medium text-[var(--muted-foreground)]">
                      {node.title}
                    </div>
                  </div>,
                  index < nodeMeta.length - 1 ? (
                    <ChevronRight
                      className="size-5 text-[var(--subtle-foreground)]"
                      key={`${node.id}-arrow`}
                    />
                  ) : null,
                ];
              })}
            </div>
            <h2 className="text-xl font-semibold">还没有部署线路</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--muted-foreground)]">
              创建后，系统会自动识别已经准备好的内容，只让你补充确实缺少的信息。
            </p>
            <Button
              className="mt-6"
              disabled={busy === "create"}
              onClick={() => void createPath()}
              size="lg"
            >
              {busy === "create" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Rocket />
              )}
              创建上线线路
            </Button>
          </div>
        </section>
      ) : (
        <div className="space-y-6">
          <div
            className="flex gap-2 overflow-x-auto pb-1"
            aria-label="部署线路列表"
          >
            {paths.map((candidate) => (
              <button
                className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${candidate.id === activePathId ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--muted)]"}`}
                key={candidate.id}
                onClick={() => setActivePathId(candidate.id)}
                type="button"
              >
                {candidate.name}
              </button>
            ))}
          </div>

          {activePath ? (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm lg:p-8">
              <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold">{activePath.name}</h2>
                    <button
                      className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                      onClick={() => {
                        setNameDraft(activePath.name);
                        setEditingName(true);
                      }}
                      type="button"
                    >
                      <Pencil className="size-4" />
                      <span className="sr-only">修改线路名称</span>
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                    {activePath.state === "online"
                      ? "项目已经在线；本地有新修改时可以再次更新。"
                      : activePath.state === "deploying"
                        ? "正在上线，可以关闭客户端，稍后回来继续查看。"
                        : activePath.state === "needs_action"
                          ? freshLocalSnapshotRequired
                            ? "上次上线任务已经中断，所有配置都已保留。"
                            : "上线停在一个问题上，已完成的配置不会丢失。"
                          : allReady
                            ? "全部准备完成，可以开始上线。"
                            : `还差 ${nodeMeta.filter((node) => nodeStatuses[node.id].tone !== "ready").length} 项准备。`}
                  </p>
                </div>
                {activePath.state === "online" && activePath.address ? (
                  <Button asChild variant="secondary">
                    <a
                      href={normalizedAddress(activePath.address)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink />
                      打开项目
                    </a>
                  </Button>
                ) : null}
              </header>

              <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
                {nodeMeta.map((node, index) => {
                  const status = nodeStatuses[node.id];
                  const Icon = node.icon;
                  return [
                    <button
                      aria-label={`${node.title}：${statusCopy(status.tone)}，${status.summary}`}
                      className={`group relative min-h-40 rounded-xl border p-5 text-left outline-none transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${status.tone === "ready" ? "border-emerald-200 bg-emerald-50/55 dark:border-emerald-900 dark:bg-emerald-950/15" : status.tone === "error" ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20" : "border-[var(--border)] bg-[var(--background)]"}`}
                      key={node.id}
                      onClick={() => openNode(node.id)}
                      type="button"
                    >
                      <div className="mb-6 flex items-start justify-between gap-3">
                        <span className="grid size-10 place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                          <Icon className="size-5" />
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${status.tone === "ready" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : status.tone === "error" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}
                        >
                          {status.tone === "ready" ? (
                            <Check className="size-3" />
                          ) : status.tone === "error" ? (
                            <CircleAlert className="size-3" />
                          ) : null}
                          {statusCopy(status.tone)}
                        </span>
                      </div>
                      <div className="font-semibold">{node.title}</div>
                      <div className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                        {node.description}
                      </div>
                      <div className="mt-4 truncate text-xs font-medium text-[var(--foreground)]">
                        {status.summary}
                      </div>
                      {status.provider ? (
                        <div className="mt-1 truncate text-[11px] text-[var(--subtle-foreground)]">
                          {status.provider}
                        </div>
                      ) : null}
                    </button>,
                    index < nodeMeta.length - 1 ? (
                      <div
                        className="hidden items-center lg:flex"
                        key={`${node.id}-arrow`}
                      >
                        <ChevronRight className="size-5 text-[var(--subtle-foreground)]" />
                      </div>
                    ) : null,
                  ];
                })}
              </div>

              <footer
                className={`mt-7 flex flex-wrap items-center justify-between gap-4 border-t pt-6 ${freshLocalSnapshotRequired ? "border-amber-300" : "border-[var(--border)]"}`}
              >
                <div className="max-w-2xl text-sm">
                  {freshLocalSnapshotRequired ? (
                    <>
                      <div className="font-semibold text-[var(--foreground)]">
                        只需重新读取你电脑里的当前项目
                      </div>
                      <p className="mt-1 leading-6 text-[var(--muted-foreground)]">
                        构建服务、版本仓库、服务器和访问地址都不需要重新设置。系统会放弃上次中断的临时任务，使用当前代码重新上线。
                      </p>
                    </>
                  ) : (
                    <span className="text-[var(--muted-foreground)]">
                      {activeRun
                        ? `${activeRun.message}${activeRun.commitSha ? ` · ${activeRun.commitSha.slice(0, 8)}` : ""}`
                        : firstBlockedNode
                          ? `下一步：${nextActionLabel}`
                          : "系统会在上线后核对构建、服务器和访问地址。"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeRun &&
                  ["queued", "running"].includes(activeRun.status) ? (
                    <Button
                      disabled={busy === "refresh"}
                      onClick={() => void refreshActiveRun()}
                      variant="secondary"
                    >
                      <RefreshCw
                        className={busy === "refresh" ? "animate-spin" : ""}
                      />
                      刷新状态
                    </Button>
                  ) : null}
                  {activeRun?.status === "needs_action" ? (
                    freshLocalSnapshotRequired ? (
                      <Button
                        disabled={busy === "deploy"}
                        onClick={() => void deployActivePath(true)}
                        size="lg"
                      >
                        {busy === "deploy" ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        重新读取项目并上线
                      </Button>
                    ) : activeRun.actionKind ===
                      "deployment-path-preparation-retry" ? (
                      <Button
                        disabled={busy === "deploy"}
                        onClick={() => void deployActivePath()}
                        size="lg"
                      >
                        {busy === "deploy" ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Rocket />
                        )}
                        {activeRun.currentStage === "prepare-server"
                          ? "初始化服务器并继续"
                          : "重试并继续上线"}
                      </Button>
                    ) : activeRun.actionKind ===
                      "deployment-path-route-takeover" ? (
                      <Button onClick={() => openNode("server")} size="lg">
                        <Server />
                        处理访问地址
                      </Button>
                    ) : (
                      <Button
                        disabled={busy === "refresh"}
                        onClick={() => void refreshActiveRun()}
                        size="lg"
                      >
                        {busy === "refresh" ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Rocket />
                        )}
                        继续上线
                      </Button>
                    )
                  ) : !allReady && firstBlockedNode ? (
                    <Button onClick={() => openNode(firstBlockedNode)}>
                      {nextActionLabel}
                      <ChevronRight />
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        busy === "deploy" || activePath.state === "deploying"
                      }
                      onClick={requestDeploy}
                      size="lg"
                    >
                      {busy === "deploy" || activePath.state === "deploying" ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Rocket />
                      )}
                      {activePath.state === "online" ? "更新上线" : "开始上线"}
                    </Button>
                  )}
                </div>
              </footer>
            </section>
          ) : null}
        </div>
      )}

      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            setActiveNode(null);
            setServerPassword("");
            setServerPasswordError("");
            setChangingServer(false);
          }
        }}
        open={Boolean(activeNode)}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {nodeMeta.find((node) => node.id === activeNode)?.title}
            </SheetTitle>
            <SheetDescription>
              {nodeMeta.find((node) => node.id === activeNode)?.description}
            </SheetDescription>
          </SheetHeader>

          {activeNode === "local" ? (
            <div className="mt-8 space-y-5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/20">
                <div className="font-semibold">项目已经识别</div>
                <div className="mt-1 text-[var(--muted-foreground)]">
                  {workspace.inspection.project_name} ·{" "}
                  {workspace.inspection.services.length} 个项目服务
                </div>
              </div>
              <div className="space-y-2">
                {workspace.inspection.services.map((service) => (
                  <div
                    className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3 text-sm"
                    key={service.id}
                  >
                    <span>{service.package_name || service.id}</span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {service.kind}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                上线时会使用你点击按钮那一刻的本地项目内容。
              </p>
              <Button
                className="w-full"
                onClick={() =>
                  setActiveNode(
                    firstBlockedNode === "local"
                      ? null
                      : (firstBlockedNode ?? null),
                  )
                }
              >
                完成
              </Button>
            </div>
          ) : null}

          {activeNode === "build" ? (
            <div className="mt-8 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="repository">项目代码仓库</Label>
                <Input
                  id="repository"
                  onChange={(event) => setRepositoryDraft(event.target.value)}
                  value={repositoryDraft}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  用于保存项目代码并触发构建。
                </p>
              </div>
              {connections
                .filter((connection) => connection.kind === "source")
                .map((connection) => (
                  <button
                    className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.sourceConnectionId === connection.id ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20" : "border-[var(--border)]"}`}
                    key={connection.id}
                    onClick={() => void selectSource(connection.id)}
                    type="button"
                  >
                    <span>
                      <span className="block text-sm font-semibold">
                        {connection.name}
                      </span>
                      <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                        配置中心已有连接 · 后续项目可复用
                      </span>
                    </span>
                    {activePath?.sourceConnectionId === connection.id ? (
                      <Check className="size-4 text-emerald-600" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                ))}
              <div className="rounded-xl border border-[var(--border)] p-4">
                <div className="flex items-center gap-2 font-semibold">
                  <KeyRound className="size-4" />
                  连接新的构建服务
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                  验证成功后保存到配置中心，其他项目可以直接复用。
                </p>
                <div className="mt-4 space-y-2">
                  <Label htmlFor="cnb-token">访问令牌</Label>
                  <Input
                    autoComplete="off"
                    id="cnb-token"
                    onChange={(event) => setCnbToken(event.target.value)}
                    type="password"
                    value={cnbToken}
                  />
                </div>
                <Button
                  className="mt-4 w-full"
                  disabled={!cnbToken.trim() || busy === "source"}
                  onClick={() => void connectBuildService()}
                >
                  {busy === "source" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  验证并保存
                </Button>
              </div>
            </div>
          ) : null}

          {activeNode === "registry" ? (
            <div className="mt-8 space-y-5">
              {connections
                .filter((connection) => connection.kind === "registry")
                .map((connection) => (
                  <button
                    className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.registryConnectionId === connection.id ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20" : "border-[var(--border)]"}`}
                    key={connection.id}
                    onClick={() => void selectRegistryConnection(connection)}
                    type="button"
                  >
                    <span>
                      <span className="block text-sm font-semibold">
                        {connection.name}
                      </span>
                      <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                        配置中心已有连接 · {connection.metadata.endpoint}
                      </span>
                    </span>
                    {activePath?.registryConnectionId === connection.id ? (
                      <Check className="size-4 text-emerald-600" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                ))}
              <div className="space-y-2">
                <Label htmlFor="registry-endpoint">版本仓库地址</Label>
                <Input
                  id="registry-endpoint"
                  onChange={(event) => setRegistryEndpoint(event.target.value)}
                  value={registryEndpoint}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="registry-namespace">命名空间</Label>
                <Input
                  id="registry-namespace"
                  onChange={(event) => setRegistryNamespace(event.target.value)}
                  value={registryNamespace}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="registry-user">登录用户名</Label>
                  <Input
                    autoComplete="off"
                    id="registry-user"
                    onChange={(event) =>
                      setRegistryUsername(event.target.value)
                    }
                    value={registryUsername}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="registry-password">访问密码</Label>
                  <Input
                    autoComplete="off"
                    id="registry-password"
                    onChange={(event) =>
                      setRegistryPassword(event.target.value)
                    }
                    type="password"
                    value={registryPassword}
                  />
                </div>
              </div>
              <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                已有登录信息时可以留空用户名和密码，系统只重新验证。新连接会保存到配置中心。
              </p>
              <Button
                className="w-full"
                disabled={busy === "registry"}
                onClick={() => void saveRegistryConnection()}
              >
                {busy === "registry" ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                验证并保存
              </Button>
              {pathRuns.some(
                (run) => run.status === "success" && run.artifacts.length,
              ) ? (
                <div className="border-t border-[var(--border)] pt-5">
                  <div className="text-sm font-semibold">版本记录</div>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    每次上线都会保留不可变版本，需要时可以把旧版本重新上线。
                  </p>
                  <div className="mt-3 space-y-2">
                    {pathRuns
                      .filter(
                        (run) =>
                          run.status === "success" && run.artifacts.length,
                      )
                      .slice(0, 8)
                      .map((run) => (
                        <div
                          className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3"
                          key={run.id}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {run.sourceTitle ||
                                `${new Date(run.startedAt).toLocaleString("zh-CN")} 的版本`}
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              {run.commitSha?.slice(0, 8)} ·{" "}
                              {run.artifacts.length} 个镜像
                            </div>
                          </div>
                          <Button
                            disabled={
                              busy === `version:${run.id}` ||
                              run.id === activePath?.lastRunId
                            }
                            onClick={() => void redeployVersion(run)}
                            size="sm"
                            variant="secondary"
                          >
                            {busy === `version:${run.id}` ? (
                              <LoaderCircle className="animate-spin" />
                            ) : null}
                            {run.id === activePath?.lastRunId
                              ? "当前版本"
                              : "重新上线"}
                          </Button>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeNode === "server" ? (
            <div className="mt-8 space-y-6">
              {activeRun?.actionKind === "deployment-path-route-takeover" ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/20">
                  <div className="font-semibold">
                    访问地址正在由服务器原配置使用
                  </div>
                  <p className="mt-2 leading-6 text-[var(--muted-foreground)]">
                    应用服务已经更新。确认后只会把当前线路填写的地址切换给这个项目；其他项目和未知地址保持不变，校验失败会自动恢复原配置。
                  </p>
                  <Button
                    className="mt-4 w-full"
                    disabled={busy === "takeover"}
                    onClick={() => void takeOverActiveRoutes()}
                  >
                    {busy === "takeover" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : null}
                    确认接管并继续上线
                  </Button>
                </div>
              ) : null}
              {selectedServer && !changingServer ? (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
                        <Check className="size-4" />
                        服务器已连接
                      </div>
                      <p className="mt-2 text-sm">
                        {selectedServer.name} · {selectedServer.user}@
                        {selectedServer.host}:{selectedServer.port}
                      </p>
                    </div>
                    <Button
                      onClick={() => setChangingServer(true)}
                      size="sm"
                      variant="secondary"
                    >
                      更换服务器
                    </Button>
                  </div>
                  <p className="mt-3 text-xs font-medium text-emerald-800 dark:text-emerald-300">
                    下一步：填写项目访问地址
                  </p>
                </div>
              ) : (
                <>
                  {servers.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-sm font-semibold">
                        选择配置中心已有服务器
                      </div>
                      {servers.map((server) => (
                        <button
                          className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.serverId === server.id ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20" : "border-[var(--border)]"}`}
                          key={server.id}
                          onClick={() => void selectServer(server)}
                          type="button"
                        >
                          <span>
                            <span className="block text-sm font-semibold">
                              {server.name}
                            </span>
                            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                              {server.user}@{server.host}:{server.port}
                            </span>
                          </span>
                          {activePath?.serverId === server.id ? (
                            <Check className="size-4 text-emerald-600" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="rounded-xl border border-[var(--border)] p-4">
                    <div className="font-semibold">连接新的服务器</div>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                      验证成功后默认保存到配置中心，其他项目可以复用。
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="server-name">名称</Label>
                        <Input
                          id="server-name"
                          onChange={(event) =>
                            setServerDraft((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          value={serverDraft.name}
                        />
                      </div>
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="server-host">服务器地址</Label>
                        <Input
                          id="server-host"
                          onChange={(event) =>
                            setServerDraft((current) => ({
                              ...current,
                              host: event.target.value,
                              hostFingerprint: undefined,
                            }))
                          }
                          value={serverDraft.host}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="server-user">登录用户</Label>
                        <Input
                          id="server-user"
                          onChange={(event) =>
                            setServerDraft((current) => ({
                              ...current,
                              user: event.target.value,
                            }))
                          }
                          value={serverDraft.user}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="server-port">端口</Label>
                        <Input
                          id="server-port"
                          min={1}
                          max={65535}
                          onChange={(event) =>
                            setServerDraft((current) => ({
                              ...current,
                              port: Number(event.target.value) || 22,
                              hostFingerprint: undefined,
                            }))
                          }
                          type="number"
                          value={serverDraft.port}
                        />
                      </div>
                    </div>
                    {serverDraft.hostFingerprint ? (
                      <>
                        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs leading-5 dark:border-amber-800 dark:bg-amber-950/20">
                          <div className="font-semibold text-sm">
                            确认连接这台服务器
                          </div>
                          <p className="mt-1 text-[var(--muted-foreground)]">
                            这是服务器返回的身份指纹。确认地址无误后继续，系统才会安装登录密钥。
                          </p>
                          <div className="mt-2 break-all font-mono">
                            {serverDraft.hostFingerprint}
                          </div>
                        </div>
                        <div className="mt-3 space-y-2">
                          <Label htmlFor="server-password">
                            最后一步：输入服务器登录密码
                          </Label>
                          <Input
                            aria-describedby={
                              serverPasswordError
                                ? "server-password-error"
                                : "server-password-help"
                            }
                            aria-invalid={Boolean(serverPasswordError)}
                            autoComplete="new-password"
                            autoFocus
                            className={
                              serverPasswordError
                                ? "border-red-500 focus-visible:ring-red-500"
                                : undefined
                            }
                            id="server-password"
                            onChange={(event) => {
                              setServerPassword(event.target.value);
                              if (event.target.value)
                                setServerPasswordError("");
                            }}
                            placeholder="输入云服务器的登录密码"
                            ref={serverPasswordInputRef}
                            type="password"
                            value={serverPassword}
                          />
                          {serverPasswordError ? (
                            <p
                              className="text-xs font-medium text-red-600"
                              id="server-password-error"
                              role="alert"
                            >
                              {serverPasswordError}
                            </p>
                          ) : (
                            <p
                              className="text-xs leading-5 text-[var(--muted-foreground)]"
                              id="server-password-help"
                            >
                              密码只使用这一次，不会保存。填写后点击下方按钮；连接成功后，客户端会使用后台生成的专用密钥自动登录。
                            </p>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">
                        下一步会先核对服务器身份，不会修改服务器。
                      </p>
                    )}
                    <Button
                      className="mt-4 w-full"
                      disabled={
                        !serverDraft.host.trim() ||
                        !serverDraft.user.trim() ||
                        busy === "server"
                      }
                      onClick={() => void saveNewServer()}
                    >
                      {busy === "server" ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      {serverDraft.hostFingerprint
                        ? "确认并连接服务器"
                        : "检查服务器"}
                    </Button>
                  </div>
                </>
              )}

              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold">
                    项目打开后从哪里访问
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    系统已经根据服务器地址自动生成；首次上线后可以直接打开，需要时也可以改成自己的域名。
                  </p>
                </div>
                {routeDrafts.map((route, index) => (
                  <div
                    className="rounded-xl border border-[var(--border)] p-4"
                    key={`${route.service}-${index}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <select
                        aria-label={`第 ${index + 1} 个访问地址对应的服务`}
                        className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                        onChange={(event) =>
                          setRouteDrafts((current) =>
                            current.map((candidate, position) =>
                              position === index
                                ? { ...candidate, service: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                        value={route.service}
                      >
                        {workspace.inspection.services
                          .filter((service) => service.kind !== "worker")
                          .map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.package_name || service.id}
                            </option>
                          ))}
                      </select>
                      {routeDrafts.length > 1 ? (
                        <Button
                          aria-label="删除这个访问地址"
                          onClick={() =>
                            setRouteDrafts((current) =>
                              current.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </div>
                    <div className="mt-3 space-y-2">
                      <Label htmlFor={`public-address-${index}`}>
                        访问地址（已自动生成）
                      </Label>
                      <Input
                        id={`public-address-${index}`}
                        onChange={(event) =>
                          setRouteDrafts((current) =>
                            current.map((candidate, position) =>
                              position === index
                                ? { ...candidate, host: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                        placeholder="例如 app.example.com"
                        value={route.host}
                      />
                    </div>
                  </div>
                ))}
                <Button
                  className="w-full"
                  disabled={
                    !workspace.inspection.services.some(
                      (service) => service.kind !== "worker",
                    )
                  }
                  onClick={() => {
                    const service = workspace.inspection.services.find(
                      (candidate) => candidate.kind !== "worker",
                    );
                    if (service)
                      setRouteDrafts((current) => [
                        ...current,
                        { service: service.id, host: "", path: "/" },
                      ]);
                  }}
                  variant="ghost"
                >
                  <Plus />
                  添加访问地址
                </Button>
                <Button
                  className="w-full"
                  disabled={
                    !routeDrafts.length ||
                    routeDrafts.some((route) => !route.host.trim()) ||
                    busy === "address"
                  }
                  onClick={() => void saveAddress()}
                >
                  {busy === "address" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  使用这个地址并继续
                </Button>
              </div>

              <div className="border-t border-[var(--border)] pt-6">
                {activePath ? (
                  <RuntimeConfigFields
                    displayName="运行"
                    environment={activePath.id as `path-${string}`}
                    onError={onError}
                    onReadyChange={(ready, checking) =>
                      !checking && setRuntimeConfigReady(ready)
                    }
                    path={path}
                    secretVariables={workspace.inspection.environment_variables
                      .filter((variable) => variable.secret)
                      .map((variable) => variable.name)}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={setEditingName} open={editingName}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>线路设置</SheetTitle>
            <SheetDescription>
              名称只用于帮助你区分不同服务器线路。
            </SheetDescription>
          </SheetHeader>
          <div className="mt-8 space-y-2">
            <Label htmlFor="path-name">线路名称</Label>
            <Input
              id="path-name"
              onChange={(event) => setNameDraft(event.target.value)}
              value={nameDraft}
            />
          </div>
          <Button
            className="mt-5 w-full"
            disabled={!nameDraft.trim() || busy === "name"}
            onClick={() => void savePathName()}
          >
            保存名称
          </Button>
          <div className="mt-auto pt-12">
            <Button
              className="w-full"
              disabled={activePath?.state === "deploying" || busy === "delete"}
              onClick={() => void removeActivePath()}
              variant="destructive"
            >
              <Trash2 />
              删除这条线路
            </Button>
            <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
              删除线路不会删除配置中心里的连接，也不会自动停止服务器上正在运行的项目。
            </p>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog onOpenChange={setConfirmingDeploy} open={confirmingDeploy}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认第一次上线</DialogTitle>
            <DialogDescription>
              系统会使用你电脑里此刻的项目内容，生成版本并放到下面这台服务器。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--muted)]/35 p-4 text-sm">
            <div>
              <span className="text-[var(--muted-foreground)]">本地项目：</span>
              {workspace.inspection.project_name}
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">
                运行服务器：
              </span>
              {selectedServer
                ? `${selectedServer.name} · ${selectedServer.host}`
                : "尚未选择"}
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">访问地址：</span>
              {activePath?.routes.map((route) => route.host).join("、") ||
                "尚未填写"}
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => setConfirmingDeploy(false)}
              variant="secondary"
            >
              返回检查
            </Button>
            <Button
              onClick={() => {
                setConfirmingDeploy(false);
                void deployActivePath();
              }}
            >
              <Rocket />
              确认并开始上线
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
