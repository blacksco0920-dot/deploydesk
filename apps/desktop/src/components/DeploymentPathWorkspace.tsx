import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  CloudCog,
  ExternalLink,
  FolderCode,
  History,
  LoaderCircle,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Trash2,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import type { DeploymentWorkflowNodeModel } from "./DeploymentWorkflowCanvas";

const DeploymentWorkflowCanvas = lazy(() =>
  import("./DeploymentWorkflowCanvas").then((module) => ({
    default: module.DeploymentWorkflowCanvas,
  })),
);

type PathNode = "local" | "build" | "registry" | "server";
type NodeTone = "ready" | "waiting" | "working" | "error";
type NodePanelMode =
  | "summary"
  | "select"
  | "create"
  | "repository"
  | "addresses"
  | "runtime"
  | "repair";

interface DeploymentPathWorkspaceProps {
  autoCreateDefault?: boolean;
  onBack?: () => void;
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
  label: string;
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

function repositoryConfigured(value: string) {
  const repository = value.trim();
  return (
    repository.includes("/") &&
    !repository.includes("replace-me") &&
    !repository.startsWith("owner/")
  );
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
  return "尚未完成";
}

function runProblemNode(run: DeploymentRun | undefined): PathNode | null {
  if (!run || !["failed", "needs_action"].includes(run.status)) return null;
  if (["local", "prepare", "sync-source"].includes(run.currentStage))
    return "local";
  if (["build", "trigger-build"].includes(run.currentStage)) return "build";
  if (run.currentStage === "registry") return "registry";
  return "server";
}

const stageNodeMap: Record<string, PathNode> = {
  local: "local",
  prepare: "local",
  "prepare-config": "local",
  "sync-source": "local",
  "snapshot-source": "local",
  "write-config": "local",
  build: "build",
  "cloud-setup": "build",
  "trigger-build": "build",
  "verify-build": "build",
  publish: "registry",
  "publish-images": "registry",
  registry: "registry",
  complete: "server",
  deploy: "server",
  healthcheck: "server",
  "prepare-server": "server",
  server: "server",
  "verify-release": "server",
};

function taskNode(run: DeploymentRun | undefined): PathNode | null {
  if (!run) return null;
  return stageNodeMap[run.currentStage] ?? null;
}

function projectedTaskTone(
  run: DeploymentRun | undefined,
  node: PathNode,
): NodeTone | null {
  if (!run || run.status === "success") return null;
  if (
    !["queued", "running", "needs_action", "failed", "cancelled"].includes(
      run.status,
    )
  )
    return null;
  const current = taskNode(run);
  if (!current) return null;
  const currentIndex = nodeMeta.findIndex(
    (candidate) => candidate.id === current,
  );
  const nodeIndex = nodeMeta.findIndex((candidate) => candidate.id === node);
  if (nodeIndex < currentIndex) return "ready";
  if (nodeIndex > currentIndex) return "waiting";
  return ["queued", "running"].includes(run.status) ? "working" : "error";
}

function taskStatusLabel(node: PathNode, tone: NodeTone) {
  if (tone === "working") {
    return {
      local: "正在读取项目",
      build: "正在构建版本",
      registry: "正在保存版本",
      server: "正在部署服务",
    }[node];
  }
  if (tone === "error") {
    return {
      local: "项目读取受阻",
      build: "版本构建受阻",
      registry: "版本保存受阻",
      server: "服务部署受阻",
    }[node];
  }
  if (tone === "ready") return "本阶段已完成";
  return {
    local: "等待读取项目",
    build: "等待构建版本",
    registry: "等待保存版本",
    server: "等待部署服务",
  }[node];
}

function deploymentPathStateLabel(state: DeploymentPath["state"]) {
  return {
    deploying: "上线中",
    draft: "尚未配置",
    needs_action: "需要处理",
    online: "已上线",
    ready: "可以上线",
  }[state];
}

function deploymentRunStatusLabel(status: DeploymentRun["status"]) {
  return {
    cancelled: "已取消",
    failed: "上线失败",
    needs_action: "等待处理",
    queued: "等待上线",
    running: "正在上线",
    success: "上线成功",
  }[status];
}

function deploymentStageLabel(stage: string) {
  if (
    [
      "local",
      "prepare",
      "prepare-config",
      "snapshot-source",
      "sync-source",
      "write-config",
    ].includes(stage)
  ) {
    return "读取本地项目";
  }
  if (
    ["build", "cloud-setup", "trigger-build", "verify-build"].includes(stage)
  ) {
    return "生成可运行版本";
  }
  if (["publish", "publish-images", "registry"].includes(stage)) {
    return "保存上线版本";
  }
  if (["prepare-server", "server"].includes(stage)) {
    return "准备运行服务器";
  }
  if (stage === "deploy") return "启动项目服务";
  if (["healthcheck", "verify-release"].includes(stage)) {
    return "检查服务可用性";
  }
  if (["complete", "completed"].includes(stage)) return "已完成";
  return "处理中";
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
    title: "代码来源",
    description: "确定本次上线使用的代码",
    icon: FolderCode,
  },
  {
    id: "build",
    title: "版本构建",
    description: "把代码生成可运行版本",
    icon: CloudCog,
  },
  {
    id: "registry",
    title: "版本存储",
    description: "保存不可变的上线版本",
    icon: PackageOpen,
  },
  {
    id: "server",
    title: "部署运行",
    description: "运行项目并提供访问地址",
    icon: Server,
  },
];

export function DeploymentPathWorkspace({
  autoCreateDefault = false,
  onBack,
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
  const [runtimeConfigChecked, setRuntimeConfigChecked] = useState(false);
  const [runtimeConfigLoadFailed, setRuntimeConfigLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [activePathId, setActivePathId] = useState("");
  const [activeNode, setActiveNode] = useState<PathNode | null>(null);
  const [nodePanelMode, setNodePanelMode] = useState<NodePanelMode>("summary");
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [resourceView, setResourceView] = useState<"paths" | "connections">(
    "paths",
  );
  const [editingName, setEditingName] = useState(false);
  const [confirmingDeletePath, setConfirmingDeletePath] = useState(false);
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
  const serverPasswordInputRef = useRef<HTMLInputElement>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  const autoCreateAttempted = useRef(false);
  const activePathRef = useRef<DeploymentPath | null>(null);

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
      setRuntimeConfigChecked(false);
      setRuntimeConfigLoadFailed(false);
      return;
    }
    let active = true;
    setRuntimeConfigChecked(false);
    setRuntimeConfigLoadFailed(false);
    loadRuntimeConfig(path, activePathId as `path-${string}`)
      .then((config) => {
        if (!active) return;
        setRuntimeConfigRequired(Boolean(config.requiredVariables.length));
        setRuntimeConfigReady(
          config.stored || config.requiredVariables.length === 0,
        );
        setRuntimeConfigChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setRuntimeConfigRequired(false);
        setRuntimeConfigReady(false);
        setRuntimeConfigLoadFailed(true);
        setRuntimeConfigChecked(true);
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
  useEffect(() => {
    activePathRef.current = activePath ?? null;
  }, [activePath]);
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
  const routeAddressRepairRequired =
    activeRun?.status === "needs_action" &&
    activeRun.actionKind === "deployment-path-route-check";

  useEffect(() => {
    if (!activeNode && !showRunHistory) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeInspector();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeNode, showRunHistory]);

  const nodeStatuses = useMemo<Record<PathNode, NodeStatus>>(() => {
    const localReady =
      workspace.inspection.services.length > 0 && workspace.validation.valid;
    const repositoryReady = repositoryConfigured(repository);
    const buildReady = repositoryReady && connectionReady(selectedSource);
    const registryReady =
      Boolean(manifestRegistry && manifestNamespace) &&
      connectionReady(selectedRegistry);
    const serverReady = Boolean(
      selectedServer &&
      activePath?.routes.length &&
      activePath.routes.every((route) => route.host.trim()) &&
      runtimeConfigChecked &&
      !runtimeConfigLoadFailed &&
      (runtimeConfigReady || !runtimeConfigRequired),
    );
    const baseStatuses: Record<PathNode, NodeStatus> = {
      local: {
        label: localReady ? "项目可用" : "项目需要检查",
        tone: problemNode === "local" || !localReady ? "error" : "ready",
        summary:
          problemNode === "local"
            ? freshLocalSnapshotRequired
              ? "需要重新读取当前项目"
              : (activeRun?.message ?? "本地项目需要处理")
            : localReady
              ? `已识别 ${workspace.inspection.services.length} 个项目服务`
              : "项目结构还需要处理",
        provider: "本地项目",
      },
      build: {
        label: buildReady
          ? "构建服务可用"
          : connectionReady(selectedSource)
            ? "需要设置代码仓库"
            : "需要连接构建服务",
        tone:
          problemNode === "build" ? "error" : buildReady ? "ready" : "waiting",
        summary:
          problemNode === "build"
            ? freshLocalSnapshotRequired
              ? "需要重新读取当前项目"
              : (activeRun?.message ?? "构建服务需要处理")
            : buildReady
              ? "连接可用"
              : connectionReady(selectedSource)
                ? "还差代码仓库"
                : "还没有完成连接",
        provider: selectedSource?.provider.toUpperCase() || "CNB",
      },
      registry: {
        label: registryReady ? "版本仓库可用" : "需要连接版本仓库",
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
        label: serverReady
          ? "运行服务器可用"
          : runtimeConfigLoadFailed
            ? "运行配置读取失败"
            : selectedServer
              ? !activePath?.routes.length
                ? "需要设置访问地址"
                : !runtimeConfigChecked
                  ? "正在检查运行配置"
                  : runtimeConfigRequired && !runtimeConfigReady
                    ? "需要填写运行配置"
                    : "需要检查运行服务器"
              : "需要连接运行服务器",
        tone:
          problemNode === "server"
            ? "error"
            : serverReady
              ? "ready"
              : "waiting",
        summary:
          problemNode === "server"
            ? routeAddressRepairRequired
              ? "还差可用访问地址"
              : (activeRun?.message ?? "运行服务器需要处理")
            : selectedServer
              ? !activePath?.routes.length
                ? "还差访问地址"
                : runtimeConfigLoadFailed
                  ? "无法读取运行配置，请重新检查"
                  : !runtimeConfigChecked
                    ? "正在检查运行配置"
                    : runtimeConfigRequired &&
                        !runtimeConfigReady &&
                        !freshLocalSnapshotRequired
                      ? "还差运行配置"
                      : `${activePath.routes.length} 个访问地址`
              : "还没有选择服务器",
        provider: selectedServer?.host,
      },
    };
    return Object.fromEntries(
      nodeMeta.map((node) => {
        const taskTone = projectedTaskTone(activeRun, node.id);
        if (!taskTone) return [node.id, baseStatuses[node.id]];
        const current = taskNode(activeRun);
        return [
          node.id,
          {
            ...baseStatuses[node.id],
            label: taskStatusLabel(node.id, taskTone),
            summary:
              node.id === current
                ? activeRun?.message || baseStatuses[node.id].summary
                : taskTone === "ready"
                  ? "本次上线已通过此阶段"
                  : "等待前一步完成",
            tone: taskTone,
          },
        ];
      }),
    ) as Record<PathNode, NodeStatus>;
  }, [
    activePath?.address,
    activePath?.routes,
    activeRun?.status,
    activeRun?.currentStage,
    activeRun?.message,
    routeAddressRepairRequired,
    freshLocalSnapshotRequired,
    manifestNamespace,
    manifestRegistry,
    repository,
    runtimeConfigReady,
    runtimeConfigRequired,
    runtimeConfigChecked,
    runtimeConfigLoadFailed,
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
        ? connectionReady(selectedSource)
          ? "设置代码仓库"
          : "连接构建服务"
        : firstBlockedNode === "registry"
          ? "连接版本仓库"
          : firstBlockedNode === "server"
            ? routeAddressRepairRequired
              ? "更换访问地址"
              : selectedServer
                ? !activePath?.routes.length
                  ? "设置访问地址"
                  : runtimeConfigLoadFailed
                    ? "检查运行配置"
                    : runtimeConfigRequired && !runtimeConfigReady
                      ? "填写运行配置"
                      : "检查运行服务器"
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
      const localReady =
        workspace.inspection.services.length > 0 && workspace.validation.valid;
      const sourceReady =
        repositoryConfigured(repository) && sourceCandidates.length === 1;
      const registryReady =
        Boolean(manifestRegistry && manifestNamespace) &&
        registryCandidates.length === 1;
      const firstIncomplete: PathNode = !localReady
        ? "local"
        : !sourceReady
          ? "build"
          : !registryReady
            ? "registry"
            : "server";
      setNodePanelMode(
        firstIncomplete === "local"
          ? "summary"
          : firstIncomplete === "build"
            ? sourceCandidates.length
              ? repositoryConfigured(repository)
                ? "summary"
                : "repository"
              : connections.some((connection) => connection.kind === "source")
                ? "select"
                : "create"
            : firstIncomplete === "registry"
              ? connections.some((connection) => connection.kind === "registry")
                ? "select"
                : "create"
              : servers.length
                ? "select"
                : "create",
      );
      setActiveNode(firstIncomplete);
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

  function initialPanelMode(node: PathNode): NodePanelMode {
    if (problemNode === node) return "repair";
    if (node === "local") return "summary";
    if (node === "build") {
      if (selectedSource && connectionReady(selectedSource)) {
        return repositoryConfigured(repository) ? "summary" : "repository";
      }
      return connections.some((connection) => connection.kind === "source")
        ? "select"
        : "create";
    }
    if (node === "registry") {
      if (selectedRegistry && connectionReady(selectedRegistry))
        return "summary";
      return connections.some((connection) => connection.kind === "registry")
        ? "select"
        : "create";
    }
    if (!selectedServer) return servers.length ? "select" : "create";
    if (!activePath?.routes.length) return "addresses";
    if (
      runtimeConfigLoadFailed ||
      !runtimeConfigChecked ||
      (runtimeConfigRequired && !runtimeConfigReady)
    )
      return "runtime";
    return "summary";
  }

  function rememberInspectorTrigger() {
    if (document.activeElement instanceof HTMLElement) {
      inspectorTriggerRef.current = document.activeElement;
    }
  }

  function closeInspector() {
    setActiveNode(null);
    setShowRunHistory(false);
    const trigger = inspectorTriggerRef.current;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  function openNode(node: PathNode, selectedPath = activePath) {
    if (!selectedPath) return;
    rememberInspectorTrigger();
    setShowRunHistory(false);
    setActivePathId(selectedPath.id);
    setNodePanelMode(initialPanelMode(node));
    setActiveNode(node);
    setNameDraft(selectedPath.name);
    setRepositoryDraft(repository);
    const pathRegistry = connections.find(
      (connection) => connection.id === selectedPath.registryConnectionId,
    );
    setRegistryEndpoint(
      pathRegistry?.metadata.endpoint ||
        manifestRegistry ||
        "ccr.ccs.tencentyun.com",
    );
    setRegistryNamespace(pathRegistry?.metadata.namespace || manifestNamespace);
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
    // Several node actions intentionally save more than once in one async
    // chain (for example: save a repaired route, then attach the prepared
    // retry task). React has not necessarily rendered the first save before
    // the second one starts, so spreading the render-time `activePath` here
    // can silently restore the previous routes or connection binding. Keep a
    // synchronous reference to the last persisted record so every subsequent
    // write is based on the newest deployment-line state.
    const latest =
      activePathRef.current?.id === activePath.id
        ? activePathRef.current
        : activePath;
    const saved = await saveDeploymentPath({
      ...latest,
      ...changes,
      projectPath: path,
    });
    activePathRef.current = saved;
    await refreshResources();
    setActivePathId(saved.id);
    return saved;
  }

  async function markNodeRepaired(node: PathNode | "routes") {
    if (!activeRun || activeRun.status !== "needs_action") return;
    const updated = await prepareDeploymentPathRetry(activeRun.id, node);
    onRunUpdated(updated);
    await updateActivePath({ lastRunId: updated.id });
  }

  function advanceAfterBuild() {
    if (nodeStatuses.registry.tone !== "ready") {
      setNodePanelMode(initialPanelMode("registry"));
      setActiveNode("registry");
      return;
    }
    if (nodeStatuses.server.tone !== "ready") {
      setNodePanelMode(initialPanelMode("server"));
      setActiveNode("server");
      return;
    }
    setActiveNode(null);
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
    if (!repositoryConfigured(nextRepository)) {
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
      if (firstBlockedNode === "build") {
        advanceAfterBuild();
      } else {
        setActiveNode(null);
      }
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  async function chooseSourceBeforeRepository(connectionId: string) {
    setBusy("source");
    try {
      await updateActivePath({ sourceConnectionId: connectionId });
      setNodePanelMode("repository");
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
      advanceAfterBuild();
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
      setNodePanelMode(servers.length ? "select" : "create");
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
      setNodePanelMode(servers.length ? "select" : "create");
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
      setNodePanelMode("addresses");
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
      setNodePanelMode("addresses");
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
      await markNodeRepaired(routeAddressRepairRequired ? "routes" : "server");
      setAddressDraft(address);
      if (runtimeConfigRequired && !runtimeConfigReady) {
        setNodePanelMode("runtime");
      } else {
        setActiveNode(null);
      }
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
      // An explicitly deleted final path must stay deleted instead of being
      // recreated by the one-time new-project convenience flow.
      autoCreateAttempted.current = true;
      setActiveNode(null);
      setConfirmingDeletePath(false);
      await refreshResources();
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  function panelBackButton(target: NodePanelMode, label: string) {
    return (
      <Button
        className="mb-5 -ml-3"
        onClick={() => setNodePanelMode(target)}
        variant="ghost"
      >
        <ArrowLeft />
        {label}
      </Button>
    );
  }

  function reusableConnectionNote() {
    return (
      <div className="rounded-xl bg-[var(--muted)]/55 px-4 py-3 text-xs leading-5 text-[var(--muted-foreground)]">
        验证成功后会保存到配置中心，其他项目以后可以直接选择使用。
      </div>
    );
  }

  function renderRepairPanel() {
    const message =
      activeRun?.actionKind === "deployment-path-route-takeover"
        ? "访问地址正在由服务器原配置使用"
        : activeRun?.message || nodeStatuses[activeNode!].summary;
    return (
      <div className="mt-8 space-y-5">
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/20">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
            <div>
              <div className="font-semibold">{message}</div>
              <p className="mt-2 leading-6 text-[var(--muted-foreground)]">
                已经完成的节点和当前在线服务会保留，只处理这里的问题。
              </p>
            </div>
          </div>
        </div>

        {activeNode === "local" ? (
          <Button
            className="w-full"
            disabled={busy === "deploy"}
            onClick={() => void deployActivePath(true)}
          >
            {busy === "deploy" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            重新读取项目并上线
          </Button>
        ) : activeNode === "build" ? (
          <Button
            className="w-full"
            onClick={() =>
              setNodePanelMode(
                connections.some((connection) => connection.kind === "source")
                  ? "select"
                  : "create",
              )
            }
          >
            更换构建服务
          </Button>
        ) : activeNode === "registry" ? (
          <Button
            className="w-full"
            onClick={() =>
              setNodePanelMode(
                connections.some((connection) => connection.kind === "registry")
                  ? "select"
                  : "create",
              )
            }
          >
            更换版本仓库
          </Button>
        ) : activeRun?.actionKind === "deployment-path-route-check" ? (
          <div className="space-y-3">
            <Button
              className="w-full"
              onClick={() => setNodePanelMode("addresses")}
            >
              更换访问地址
            </Button>
            <Button
              className="w-full"
              disabled={busy === "refresh"}
              onClick={() => void refreshActiveRun()}
              variant="secondary"
            >
              {busy === "refresh" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              重新检查当前地址
            </Button>
          </div>
        ) : activeRun?.actionKind === "deployment-path-route-takeover" ? (
          <Button
            className="w-full"
            disabled={busy === "takeover"}
            onClick={() => void takeOverActiveRoutes()}
          >
            {busy === "takeover" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            确认接管并继续上线
          </Button>
        ) : activeRun?.actionKind === "deployment-path-preparation-retry" ? (
          <Button
            className="w-full"
            disabled={busy === "deploy"}
            onClick={() => void deployActivePath()}
          >
            {busy === "deploy" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Rocket />
            )}
            初始化服务器并继续
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={() =>
              setNodePanelMode(servers.length ? "select" : "create")
            }
          >
            更换运行服务器
          </Button>
        )}

        <details className="rounded-xl border border-[var(--border)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
          <summary className="cursor-pointer font-medium text-[var(--foreground)]">
            查看技术详情
          </summary>
          <div className="mt-3 space-y-1 break-words leading-5">
            <div>问题编号：{activeRun?.issueCode || "未提供"}</div>
            <div>当前停点：{activeRun?.currentStage || "节点检查"}</div>
          </div>
        </details>
      </div>
    );
  }

  function renderLocalPanel() {
    return (
      <div className="mt-8 space-y-5">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/20">
          <div className="flex items-center gap-2 font-semibold">
            <Check className="size-4 text-emerald-600" />
            项目已经识别
          </div>
          <div className="mt-2 text-[var(--muted-foreground)]">
            {workspace.inspection.project_name} ·{" "}
            {workspace.inspection.services.length}
            个项目服务
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
          每次点击上线时，系统都会重新读取你电脑里当时的项目内容。
        </p>
        <Button className="w-full" onClick={() => setActiveNode(null)}>
          完成
        </Button>
      </div>
    );
  }

  function renderBuildPanel() {
    const sourceConnections = connections.filter(
      (connection) => connection.kind === "source",
    );
    if (nodePanelMode === "repository" && selectedSource) {
      return (
        <div className="mt-8 space-y-5">
          <div>
            <div className="text-sm font-semibold">设置项目代码仓库</div>
            <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
              构建账号已经连接，现在只需告诉系统这个项目在代码平台中的位置。
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/35 p-4 text-sm">
            <div className="font-medium">继续使用 {selectedSource.name}</div>
            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
              已保存的授权会自动复用，不需要再次输入访问令牌。
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="repository">项目代码仓库</Label>
            <Input
              id="repository"
              onChange={(event) => setRepositoryDraft(event.target.value)}
              placeholder="组织/仓库"
              value={repositoryDraft}
            />
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">
              例如：team/customer-portal
            </p>
          </div>
          <Button
            className="w-full"
            disabled={
              !repositoryConfigured(repositoryDraft) || busy === "source"
            }
            onClick={() => void selectSource(selectedSource.id)}
          >
            {busy === "source" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            验证并保存代码仓库
          </Button>
          <Button
            className="w-full"
            onClick={() => setNodePanelMode("select")}
            variant="secondary"
          >
            更换构建服务
          </Button>
        </div>
      );
    }
    if (nodePanelMode === "summary" && selectedSource) {
      return (
        <div className="mt-8 space-y-5">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 font-semibold">
              <Check className="size-4 text-emerald-600" />
              构建服务已连接
            </div>
            <dl className="mt-5 grid grid-cols-[96px_1fr] gap-3 border-t border-emerald-200 pt-4 text-sm dark:border-emerald-900">
              <dt className="text-[var(--muted-foreground)]">服务</dt>
              <dd className="m-0 text-right">{selectedSource.name}</dd>
              <dt className="text-[var(--muted-foreground)]">代码仓库</dt>
              <dd className="m-0 break-all text-right">{repository}</dd>
              <dt className="text-[var(--muted-foreground)]">最近验证</dt>
              <dd className="m-0 text-right">
                {selectedSource.lastCheckedAt
                  ? new Date(selectedSource.lastCheckedAt).toLocaleString(
                      "zh-CN",
                    )
                  : "已保存"}
              </dd>
            </dl>
          </div>
          <Button className="w-full" onClick={() => setNodePanelMode("select")}>
            更换构建服务
          </Button>
          <Button
            className="w-full"
            onClick={() => setActiveNode(null)}
            variant="secondary"
          >
            完成
          </Button>
        </div>
      );
    }
    if (nodePanelMode === "select") {
      return (
        <div className="mt-8">
          {selectedSource ? panelBackButton("summary", "返回当前配置") : null}
          <div className="mb-3 text-sm font-semibold">选择配置中心已有连接</div>
          <div className="space-y-2">
            {sourceConnections.map((connection) => (
              <button
                className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.sourceConnectionId === connection.id ? "border-[var(--focus)] bg-[var(--muted)]/55" : "border-[var(--border)]"}`}
                key={connection.id}
                onClick={() =>
                  void (repositoryConfigured(repositoryDraft)
                    ? selectSource(connection.id)
                    : chooseSourceBeforeRepository(connection.id))
                }
                type="button"
              >
                <span>
                  <span className="block text-sm font-semibold">
                    {connection.name}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                    配置中心已有连接
                  </span>
                </span>
                {activePath?.sourceConnectionId === connection.id ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
              </button>
            ))}
          </div>
          <Button
            className="mt-4 w-full"
            onClick={() => setNodePanelMode("create")}
            variant="secondary"
          >
            <Plus />
            添加新的构建服务
          </Button>
        </div>
      );
    }
    return (
      <div className="mt-8">
        {selectedSource || sourceConnections.length
          ? panelBackButton(
              selectedSource ? "summary" : "select",
              selectedSource ? "返回当前配置" : "返回选择连接",
            )
          : null}
        <div className="mb-5">
          <div className="text-sm font-semibold">连接新的构建服务</div>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            填写项目代码位置和代码平台授权。
          </p>
        </div>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="repository">项目代码仓库</Label>
            <Input
              id="repository"
              onChange={(event) => setRepositoryDraft(event.target.value)}
              placeholder="组织/仓库"
              value={repositoryDraft}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cnb-token">访问令牌</Label>
            <Input
              autoComplete="off"
              id="cnb-token"
              onChange={(event) => setCnbToken(event.target.value)}
              type="password"
              value={cnbToken}
            />
          </div>
          {reusableConnectionNote()}
          <Button
            className="w-full"
            disabled={!cnbToken.trim() || busy === "source"}
            onClick={() => void connectBuildService()}
          >
            {busy === "source" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            验证并保存构建服务
          </Button>
        </div>
      </div>
    );
  }

  function renderRegistryPanel() {
    const registryConnections = connections.filter(
      (connection) => connection.kind === "registry",
    );
    if (nodePanelMode === "summary" && selectedRegistry) {
      return (
        <div className="mt-8 space-y-5">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 font-semibold">
              <Check className="size-4 text-emerald-600" />
              版本仓库已连接
            </div>
            <dl className="mt-5 grid grid-cols-[96px_1fr] gap-3 border-t border-emerald-200 pt-4 text-sm dark:border-emerald-900">
              <dt className="text-[var(--muted-foreground)]">服务</dt>
              <dd className="m-0 text-right">{selectedRegistry.name}</dd>
              <dt className="text-[var(--muted-foreground)]">仓库地址</dt>
              <dd className="m-0 break-all text-right">
                {selectedRegistry.metadata.endpoint || manifestRegistry}
              </dd>
              <dt className="text-[var(--muted-foreground)]">命名空间</dt>
              <dd className="m-0 text-right">
                {selectedRegistry.metadata.namespace || manifestNamespace}
              </dd>
            </dl>
          </div>
          <Button className="w-full" onClick={() => setNodePanelMode("select")}>
            更换版本仓库
          </Button>
          <Button
            className="w-full"
            onClick={() => setActiveNode(null)}
            variant="secondary"
          >
            完成
          </Button>
        </div>
      );
    }
    if (nodePanelMode === "select") {
      return (
        <div className="mt-8">
          {selectedRegistry ? panelBackButton("summary", "返回当前配置") : null}
          <div className="mb-3 text-sm font-semibold">选择配置中心已有连接</div>
          <div className="space-y-2">
            {registryConnections.map((connection) => (
              <button
                className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.registryConnectionId === connection.id ? "border-[var(--focus)] bg-[var(--muted)]/55" : "border-[var(--border)]"}`}
                key={connection.id}
                onClick={() => void selectRegistryConnection(connection)}
                type="button"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">
                    {connection.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
                    {connection.metadata.endpoint} ·{" "}
                    {connection.metadata.namespace}
                  </span>
                </span>
                {activePath?.registryConnectionId === connection.id ? (
                  <Check className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <ChevronRight className="size-4 shrink-0" />
                )}
              </button>
            ))}
          </div>
          <Button
            className="mt-4 w-full"
            onClick={() => setNodePanelMode("create")}
            variant="secondary"
          >
            <Plus />
            添加新的版本仓库
          </Button>
        </div>
      );
    }
    return (
      <div className="mt-8">
        {selectedRegistry || registryConnections.length
          ? panelBackButton(
              selectedRegistry ? "summary" : "select",
              selectedRegistry ? "返回当前配置" : "返回选择连接",
            )
          : null}
        <div className="mb-5">
          <div className="text-sm font-semibold">连接新的版本仓库</div>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            用于安全保存每次上线生成的完整版本。
          </p>
        </div>
        <div className="space-y-5">
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
                onChange={(event) => setRegistryUsername(event.target.value)}
                value={registryUsername}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="registry-password">访问密码</Label>
              <Input
                autoComplete="off"
                id="registry-password"
                onChange={(event) => setRegistryPassword(event.target.value)}
                type="password"
                value={registryPassword}
              />
            </div>
          </div>
          {reusableConnectionNote()}
          <Button
            className="w-full"
            disabled={busy === "registry"}
            onClick={() => void saveRegistryConnection()}
          >
            {busy === "registry" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            验证并保存版本仓库
          </Button>
        </div>
      </div>
    );
  }

  function renderServerCreatePanel() {
    return (
      <div className="mt-8">
        {selectedServer || servers.length
          ? panelBackButton(
              selectedServer ? "summary" : "select",
              selectedServer ? "返回当前配置" : "返回选择服务器",
            )
          : null}
        <div className="mb-5">
          <div className="text-sm font-semibold">连接新的服务器</div>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            只需准备服务器地址、登录用户和密码；专用密钥由客户端后台生成。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
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
              max={65535}
              min={1}
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
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs leading-5 dark:border-amber-800 dark:bg-amber-950/20">
              <div className="text-sm font-semibold">确认连接这台服务器</div>
              <p className="mt-1 text-[var(--muted-foreground)]">
                这是服务器返回的身份指纹。确认地址无误后输入一次登录密码。
              </p>
              <div className="mt-2 break-all font-mono">
                {serverDraft.hostFingerprint}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-password">服务器登录密码</Label>
              <Input
                aria-invalid={Boolean(serverPasswordError)}
                autoComplete="new-password"
                id="server-password"
                onChange={(event) => {
                  setServerPassword(event.target.value);
                  if (event.target.value) setServerPasswordError("");
                }}
                ref={serverPasswordInputRef}
                type="password"
                value={serverPassword}
              />
              <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                密码只使用这一次，不会保存。连接成功后自动改用专用密钥。
              </p>
              {serverPasswordError ? (
                <p className="text-xs font-medium text-red-600" role="alert">
                  {serverPasswordError}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs leading-5 text-[var(--muted-foreground)]">
            下一步只核对服务器身份，不会修改服务器。
          </p>
        )}
        <div className="mt-4">{reusableConnectionNote()}</div>
        <Button
          className="mt-4 w-full"
          disabled={
            !serverDraft.host.trim() ||
            !serverDraft.user.trim() ||
            busy === "server"
          }
          onClick={() => void saveNewServer()}
        >
          {busy === "server" ? <LoaderCircle className="animate-spin" /> : null}
          {serverDraft.hostFingerprint ? "确认并连接服务器" : "检查服务器"}
        </Button>
      </div>
    );
  }

  function renderServerAddressesPanel() {
    return (
      <div className="mt-8">
        {selectedServer ? panelBackButton("summary", "返回服务器摘要") : null}
        <div className="mb-5">
          <div className="text-sm font-semibold">项目访问地址</div>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            已根据服务器自动生成；需要时可以改成自己的域名。
          </p>
        </div>
        <div className="space-y-3">
          {routeDrafts.map((route, index) => (
            <div
              className="rounded-xl border border-[var(--border)] p-4"
              key={`${route.service}-${index}`}
            >
              <select
                aria-label={`第 ${index + 1} 个访问地址对应的服务`}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
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
              <div className="mt-3 space-y-2">
                <Label htmlFor={`workflow-public-address-${index}`}>
                  访问地址
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`workflow-public-address-${index}`}
                    onChange={(event) =>
                      setRouteDrafts((current) =>
                        current.map((candidate, position) =>
                          position === index
                            ? { ...candidate, host: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                    value={route.host}
                  />
                  {routeDrafts.length > 1 ? (
                    <Button
                      aria-label="删除这个访问地址"
                      onClick={() =>
                        setRouteDrafts((current) =>
                          current.filter((_, position) => position !== index),
                        )
                      }
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
        <Button
          className="mt-3 w-full"
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
          className="mt-3 w-full"
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
          保存访问地址
        </Button>
      </div>
    );
  }

  function renderServerPanel() {
    if (nodePanelMode === "summary" && selectedServer) {
      return (
        <div className="mt-8 space-y-5">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 font-semibold">
              <Check className="size-4 text-emerald-600" />
              运行服务器已连接
            </div>
            <dl className="mt-5 grid grid-cols-[96px_1fr] gap-3 border-t border-emerald-200 pt-4 text-sm dark:border-emerald-900">
              <dt className="text-[var(--muted-foreground)]">服务器</dt>
              <dd className="m-0 text-right">{selectedServer.name}</dd>
              <dt className="text-[var(--muted-foreground)]">连接地址</dt>
              <dd className="m-0 text-right">
                {selectedServer.user}@{selectedServer.host}:
                {selectedServer.port}
              </dd>
              <dt className="text-[var(--muted-foreground)]">访问地址</dt>
              <dd className="m-0 text-right">
                {activePath?.routes.length || 0} 个
              </dd>
              <dt className="text-[var(--muted-foreground)]">运行配置</dt>
              <dd className="m-0 text-right">
                {runtimeConfigReady || !runtimeConfigRequired
                  ? "已准备"
                  : "还需补充"}
              </dd>
            </dl>
          </div>
          <Button className="w-full" onClick={() => setNodePanelMode("select")}>
            更换运行服务器
          </Button>
          <Button
            className="w-full"
            onClick={() => setNodePanelMode("addresses")}
            variant="secondary"
          >
            维护访问地址
          </Button>
          <Button
            className="w-full"
            onClick={() => setNodePanelMode("runtime")}
            variant="secondary"
          >
            维护运行配置
          </Button>
        </div>
      );
    }
    if (nodePanelMode === "select") {
      return (
        <div className="mt-8">
          {selectedServer ? panelBackButton("summary", "返回当前配置") : null}
          <div className="mb-3 text-sm font-semibold">
            选择配置中心已有服务器
          </div>
          <div className="space-y-2">
            {servers.map((server) => (
              <button
                className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${activePath?.serverId === server.id ? "border-[var(--focus)] bg-[var(--muted)]/55" : "border-[var(--border)]"}`}
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
          <Button
            className="mt-4 w-full"
            onClick={() => setNodePanelMode("create")}
            variant="secondary"
          >
            <Plus />
            添加新的服务器
          </Button>
        </div>
      );
    }
    if (nodePanelMode === "create") return renderServerCreatePanel();
    if (nodePanelMode === "addresses") return renderServerAddressesPanel();
    return (
      <div className="mt-8">
        {panelBackButton("summary", "返回服务器摘要")}
        {activePath ? (
          <RuntimeConfigFields
            displayName="运行"
            environment={activePath.id as `path-${string}`}
            onError={onError}
            onReadyChange={(ready, checking) => {
              if (checking) return;
              setRuntimeConfigReady(ready);
              setRuntimeConfigChecked(true);
              setRuntimeConfigLoadFailed(false);
            }}
            path={path}
            secretVariables={workspace.inspection.environment_variables
              .filter((variable) => variable.secret)
              .map((variable) => variable.name)}
          />
        ) : null}
      </div>
    );
  }

  function renderNodePanel() {
    if (!activeNode) return null;
    if (nodePanelMode === "repair") return renderRepairPanel();
    if (activeNode === "local") return renderLocalPanel();
    if (activeNode === "build") return renderBuildPanel();
    if (activeNode === "registry") return renderRegistryPanel();
    return renderServerPanel();
  }

  function runStudioPrimaryAction() {
    if (!activePath) return;
    if (activeRun && ["queued", "running"].includes(activeRun.status)) {
      void refreshActiveRun();
      return;
    }
    if (activeRun?.status === "needs_action") {
      if (freshLocalSnapshotRequired) {
        void deployActivePath(true);
        return;
      }
      if (activeRun.actionKind === "deployment-path-preparation-retry") {
        void deployActivePath();
        return;
      }
      if (
        [
          "deployment-path-route-check",
          "deployment-path-route-takeover",
        ].includes(activeRun.actionKind || "")
      ) {
        openNode("server");
        return;
      }
      void refreshActiveRun();
      return;
    }
    if (!allReady && firstBlockedNode) {
      openNode(firstBlockedNode);
      return;
    }
    requestDeploy();
  }

  function studioPrimaryLabel() {
    if (activeRun && ["queued", "running"].includes(activeRun.status)) {
      return "刷新进度";
    }
    if (freshLocalSnapshotRequired) return "重新读取并上线";
    if (activeRun?.status === "needs_action") {
      if (activeRun.actionKind === "deployment-path-preparation-retry") {
        return activeRun.currentStage === "prepare-server"
          ? "初始化并继续"
          : "重试并继续";
      }
      if (
        [
          "deployment-path-route-check",
          "deployment-path-route-takeover",
        ].includes(activeRun.actionKind || "")
      ) {
        return "处理访问地址";
      }
      return "继续上线";
    }
    if (!allReady && firstBlockedNode) return nextActionLabel;
    return activePath?.state === "online" ? "更新上线" : "开始上线";
  }

  function renderRunHistoryPanel() {
    return (
      <div className="space-y-3 pt-5">
        {pathRuns.length ? (
          pathRuns.map((run) => {
            const recordedAddresses = Array.from(
              new Set(
                (run.routeChecks ?? [])
                  .map((check) => check.url.trim())
                  .filter(Boolean),
              ),
            );
            const currentPathAddresses = Array.from(
              new Set(
                (activePath?.routes.length
                  ? activePath.routes.map((route) => route.host)
                  : [activePath?.address ?? ""]
                )
                  .map(normalizedAddress)
                  .filter(Boolean),
              ),
            );
            return (
              <article
                className="rounded-xl border border-[var(--border)] p-4"
                key={run.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">
                      {run.sourceTitle ||
                        `${new Date(run.startedAt).toLocaleString("zh-CN")} 的上线`}
                    </strong>
                    <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                      {run.message}
                    </span>
                  </div>
                  {run.status === "success" && run.artifacts.length ? (
                    <Button
                      disabled={
                        busy === `version:${run.id}` ||
                        run.id === activePath?.lastRunId
                      }
                      onClick={() => void redeployVersion(run)}
                      size="sm"
                      variant="secondary"
                    >
                      {run.id === activePath?.lastRunId
                        ? "当前版本"
                        : "重新上线"}
                    </Button>
                  ) : null}
                </div>
                <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-[var(--muted-foreground)]">线路名</dt>
                  <dd className="m-0 break-words">{activePath?.name}</dd>
                  <dt className="text-[var(--muted-foreground)]">开始时间</dt>
                  <dd className="m-0">
                    {new Date(run.startedAt).toLocaleString("zh-CN")}
                  </dd>
                  <dt className="text-[var(--muted-foreground)]">结果</dt>
                  <dd className="m-0">
                    {deploymentRunStatusLabel(run.status)}
                  </dd>
                  <dt className="text-[var(--muted-foreground)]">当前阶段</dt>
                  <dd className="m-0 break-all">
                    {deploymentStageLabel(run.currentStage)}
                  </dd>
                  {selectedServer ? (
                    <>
                      <dt className="text-[var(--muted-foreground)]">
                        当前线路服务器
                      </dt>
                      <dd className="m-0 break-words">
                        {selectedServer.name} · {selectedServer.host}
                      </dd>
                    </>
                  ) : null}
                  {recordedAddresses.length ? (
                    <>
                      <dt className="text-[var(--muted-foreground)]">
                        访问地址
                      </dt>
                      <dd className="m-0 space-y-1 break-all">
                        {recordedAddresses.map((address) => (
                          <div key={address}>{address}</div>
                        ))}
                      </dd>
                    </>
                  ) : currentPathAddresses.length ? (
                    <>
                      <dt className="text-[var(--muted-foreground)]">
                        当前线路访问地址
                      </dt>
                      <dd className="m-0 space-y-1 break-all">
                        {currentPathAddresses.map((address) => (
                          <div key={address}>{address}</div>
                        ))}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {run.commitSha || run.buildSerial || run.artifacts.length ? (
                  <details className="mt-4 text-xs text-[var(--muted-foreground)]">
                    <summary className="cursor-pointer font-medium text-[var(--foreground)]">
                      技术信息
                    </summary>
                    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                      {run.commitSha ? (
                        <>
                          <dt>完整提交</dt>
                          <dd className="m-0 break-all font-mono">
                            {run.commitSha}
                          </dd>
                        </>
                      ) : null}
                      {run.buildSerial ? (
                        <>
                          <dt>构建号</dt>
                          <dd className="m-0 break-all font-mono">
                            {run.buildSerial}
                          </dd>
                        </>
                      ) : null}
                      <dt>内部阶段</dt>
                      <dd className="m-0 break-all font-mono">
                        {run.currentStage}
                      </dd>
                    </dl>
                    {run.artifacts.length ? (
                      <div className="mt-3 space-y-2">
                        {run.artifacts.map((artifact) => (
                          <dl
                            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-[var(--muted)]/55 p-3"
                            key={`${run.id}-${artifact.service}`}
                          >
                            <dt>服务</dt>
                            <dd className="m-0 break-all">
                              {artifact.service}
                            </dd>
                            <dt>镜像</dt>
                            <dd className="m-0 break-all font-mono">
                              {artifact.image}
                            </dd>
                            <dt>Digest</dt>
                            <dd className="m-0 break-all font-mono">
                              {artifact.digest}
                            </dd>
                          </dl>
                        ))}
                      </div>
                    ) : null}
                  </details>
                ) : null}
              </article>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
            这条线路还没有运行记录。
          </div>
        )}
      </div>
    );
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

  if (!activePath) {
    return (
      <main className="flex h-full min-h-0 flex-col bg-[#f7f7fb] dark:bg-[#18181c]">
        <header
          className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4"
          data-tauri-drag-region
        >
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label="返回所有项目"
              onClick={onBack}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <strong className="block truncate text-sm">
                {workspace.inspection.project_name}
              </strong>
              <span className="block text-[10px] text-[var(--muted-foreground)]">
                部署工作流
              </span>
            </div>
          </div>
          <Button
            disabled={busy === "create"}
            onClick={() => void createPath()}
          >
            {busy === "create" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
            创建上线线路
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[196px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
            <div className="grid grid-cols-2 gap-1 border-b border-[var(--border)] p-2">
              <button
                className={`rounded-lg px-3 py-2 text-xs ${resourceView === "paths" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
                onClick={() => setResourceView("paths")}
                type="button"
              >
                线路
              </button>
              <button
                className={`rounded-lg px-3 py-2 text-xs ${resourceView === "connections" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
                onClick={() => setResourceView("connections")}
                type="button"
              >
                连接
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
              {resourceView === "paths" ? (
                <>
                  <div className="flex items-center justify-between text-[11px] font-medium text-[var(--muted-foreground)]">
                    <span>部署线路</span>
                    <Button
                      aria-label="新增线路"
                      disabled={busy === "create"}
                      onClick={() => void createPath()}
                      size="icon"
                      variant="ghost"
                    >
                      <Plus />
                    </Button>
                  </div>
                  <p className="mt-4 text-xs leading-5 text-[var(--muted-foreground)]">
                    还没有线路。创建后会自动放入四类基础节点。
                  </p>
                </>
              ) : (
                <>
                  <div className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    已保存连接
                  </div>
                  <div className="mt-3 space-y-2 text-xs">
                    {[...connections, ...servers].map((resource) => (
                      <div
                        className="rounded-lg border border-[var(--border)] px-3 py-2"
                        key={resource.id}
                      >
                        <strong className="block truncate">
                          {resource.name}
                        </strong>
                        <span className="mt-1 block truncate text-[10px] text-[var(--muted-foreground)]">
                          {"provider" in resource
                            ? resource.provider.toUpperCase()
                            : resource.host}
                        </span>
                      </div>
                    ))}
                    {!connections.length && !servers.length ? (
                      <p className="py-5 text-center leading-5 text-[var(--muted-foreground)]">
                        配置节点时保存的连接会出现在这里。
                      </p>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </aside>

          <section
            className="grid min-h-0 place-items-center px-6"
            style={{
              backgroundImage:
                "radial-gradient(circle, rgba(126,128,145,.24) 1px, transparent 1px)",
              backgroundSize: "16px 16px",
            }}
          >
            <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-8 py-9 text-center shadow-sm">
              <span className="mx-auto grid size-11 place-items-center rounded-xl bg-[#eef0ff] text-[#5b5cf0] dark:bg-[#292a4b]">
                <Rocket className="size-5" />
              </span>
              <h1 className="mb-0 mt-5 text-lg font-semibold">
                创建第一条上线线路
              </h1>
              <p className="mb-5 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                系统会从当前项目出发，依次准备版本构建、版本存储和运行服务器。
              </p>
              <Button
                disabled={busy === "create"}
                onClick={() => void createPath()}
              >
                {busy === "create" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus />
                )}
                创建上线线路
              </Button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const studio = activePath
    ? (() => {
        const workflowNodes: DeploymentWorkflowNodeModel[] = nodeMeta.map(
          (node) => ({
            connectionName:
              node.id === "build"
                ? selectedSource?.name
                : node.id === "registry"
                  ? selectedRegistry?.name
                  : node.id === "server"
                    ? selectedServer?.name
                    : undefined,
            description: node.description,
            id: node.id,
            provider: nodeStatuses[node.id].provider,
            statusLabel: nodeStatuses[node.id].label,
            summary: nodeStatuses[node.id].summary,
            title: node.title,
            tone: nodeStatuses[node.id].tone,
          }),
        );
        const inspectorOpen = Boolean(activeNode || showRunHistory);
        const primaryBusy = ["deploy", "refresh"].includes(busy);
        return (
          <main className="flex h-full min-h-0 flex-col bg-[#f7f7fb] dark:bg-[#18181c]">
            <header
              className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4"
              data-tauri-drag-region
            >
              <div className="flex min-w-0 items-center gap-3">
                <Button
                  aria-label="返回所有项目"
                  onClick={onBack}
                  size="icon"
                  variant="ghost"
                >
                  <ArrowLeft />
                </Button>
                <div className="min-w-0">
                  <strong className="block truncate text-sm">
                    {workspace.inspection.project_name}
                  </strong>
                  <span className="block text-[10px] text-[var(--muted-foreground)]">
                    部署工作流
                  </span>
                </div>
                <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--subtle-foreground)]">
                  配置自动保存
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="查看运行记录"
                        onClick={() => {
                          rememberInspectorTrigger();
                          setActiveNode(null);
                          setShowRunHistory(true);
                        }}
                        size="icon"
                        variant="secondary"
                      >
                        <History />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>运行记录</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Button
                  disabled={primaryBusy || activePath.state === "deploying"}
                  onClick={runStudioPrimaryAction}
                >
                  {primaryBusy || activePath.state === "deploying" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Rocket />
                  )}
                  {studioPrimaryLabel()}
                </Button>
              </div>
            </header>

            <div
              className={`grid min-h-0 flex-1 ${inspectorOpen ? "grid-cols-[196px_minmax(0,1fr)_380px]" : "grid-cols-[196px_minmax(0,1fr)]"}`}
            >
              <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
                <div className="grid grid-cols-2 gap-1 border-b border-[var(--border)] p-2">
                  <button
                    className={`rounded-lg px-3 py-2 text-xs ${resourceView === "paths" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
                    onClick={() => setResourceView("paths")}
                    type="button"
                  >
                    线路
                  </button>
                  <button
                    className={`rounded-lg px-3 py-2 text-xs ${resourceView === "connections" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
                    onClick={() => setResourceView("connections")}
                    type="button"
                  >
                    连接
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
                  {resourceView === "paths" ? (
                    <>
                      <div className="mb-2 flex items-center justify-between px-2">
                        <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                          部署线路
                        </span>
                        <Button
                          aria-label="新增线路"
                          disabled={busy === "create"}
                          onClick={() => void createPath()}
                          size="icon"
                          variant="ghost"
                        >
                          <Plus />
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {paths.map((candidate) => (
                          <button
                            aria-current={
                              candidate.id === activePath.id
                                ? "page"
                                : undefined
                            }
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${candidate.id === activePath.id ? "bg-[#eef0ff] text-[#4f46e5] dark:bg-[#292a4b] dark:text-[#aaa7ff]" : "hover:bg-[var(--muted)]"}`}
                            key={candidate.id}
                            onClick={() => {
                              setActivePathId(candidate.id);
                              setActiveNode(null);
                              setShowRunHistory(false);
                            }}
                            type="button"
                          >
                            <span className="truncate">{candidate.name}</span>
                            <span
                              className={`shrink-0 text-[10px] font-medium ${candidate.state === "online" ? "text-emerald-600" : candidate.state === "needs_action" ? "text-amber-600" : "text-[var(--muted-foreground)]"}`}
                            >
                              {deploymentPathStateLabel(candidate.state)}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="mb-2 mt-6 flex items-center justify-between px-2 text-[11px] font-medium text-[var(--muted-foreground)]">
                        <span>节点类型</span>
                        <span>{nodeMeta.length}</span>
                      </div>
                      <div className="space-y-1">
                        {nodeMeta.map((node) => {
                          const Icon = node.icon;
                          return (
                            <button
                              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--muted)]"
                              key={node.id}
                              onClick={() => openNode(node.id)}
                              type="button"
                            >
                              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#eef0ff] text-[#5b5cf0] dark:bg-[#292a4b]">
                                <Icon className="size-3.5" />
                              </span>
                              <span className="min-w-0">
                                <strong className="block truncate text-xs">
                                  {node.title}
                                </strong>
                                <span className="mt-0.5 block truncate text-[10px] text-[var(--muted-foreground)]">
                                  {node.description}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-2 text-[11px] font-medium text-[var(--muted-foreground)]">
                        已保存连接
                      </div>
                      <div className="mt-2 space-y-1">
                        {connections.map((connection) => (
                          <button
                            className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--muted)]"
                            key={connection.id}
                            onClick={() =>
                              openNode(
                                connection.kind === "source"
                                  ? "build"
                                  : "registry",
                              )
                            }
                            type="button"
                          >
                            <span className="min-w-0">
                              <strong className="block truncate text-xs">
                                {connection.name}
                              </strong>
                              <span className="mt-0.5 block text-[10px] uppercase text-[var(--muted-foreground)]">
                                {connection.provider}
                              </span>
                            </span>
                            <span className="shrink-0 text-[10px] font-medium text-emerald-600">
                              {connectionReady(connection)
                                ? "可用"
                                : "需要验证"}
                            </span>
                          </button>
                        ))}
                        {servers.map((server) => (
                          <button
                            className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--muted)]"
                            key={server.id}
                            onClick={() => openNode("server")}
                            type="button"
                          >
                            <span className="min-w-0">
                              <strong className="block truncate text-xs">
                                {server.name}
                              </strong>
                              <span className="mt-0.5 block truncate text-[10px] text-[var(--muted-foreground)]">
                                {server.host}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 text-[10px] font-medium ${server.keyPathExists ? "text-emerald-600" : "text-amber-600"}`}
                            >
                              {server.keyPathExists ? "密钥已保存" : "密钥缺失"}
                            </span>
                          </button>
                        ))}
                        {!connections.length && !servers.length ? (
                          <p className="px-3 py-6 text-center text-xs leading-5 text-[var(--muted-foreground)]">
                            配置节点时保存的连接会出现在这里。
                          </p>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </aside>

              <section className="relative min-h-0 min-w-0">
                <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg bg-white/90 px-3 py-2 shadow-sm backdrop-blur dark:bg-[#242429]/90">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      线路
                    </span>
                    <strong className="text-sm">{activePath.name}</strong>
                    <button
                      aria-label="修改线路名称"
                      className="pointer-events-auto rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                      onClick={() => {
                        setNameDraft(activePath.name);
                        setEditingName(true);
                      }}
                      type="button"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </div>
                  <p className="mb-0 mt-1 max-w-[420px] text-[11px] text-[var(--muted-foreground)]">
                    {activeRun?.message ||
                      (firstBlockedNode
                        ? `下一步：${nextActionLabel}`
                        : "所有节点已就绪，可以开始上线。")}
                  </p>
                </div>
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-sm text-[var(--muted-foreground)]">
                      <span className="inline-flex items-center gap-2">
                        <LoaderCircle className="size-4 animate-spin" />
                        正在打开工作流
                      </span>
                    </div>
                  }
                >
                  <DeploymentWorkflowCanvas
                    activeNode={activeNode}
                    fitViewRevision={
                      inspectorOpen ? "inspector-open" : "canvas-only"
                    }
                    nodes={workflowNodes}
                    onSelectNode={openNode}
                  />
                </Suspense>
              </section>

              {inspectorOpen ? (
                <aside
                  aria-label={
                    showRunHistory
                      ? "运行记录"
                      : (nodeMeta.find((node) => node.id === activeNode)
                          ?.title ?? "节点配置")
                  }
                  className="min-h-0 overflow-auto border-l border-[var(--border)] bg-[var(--surface)]"
                  role="dialog"
                >
                  <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
                    <div>
                      <span className="text-[10px] text-[var(--muted-foreground)]">
                        {showRunHistory ? "项目记录" : "节点配置"}
                      </span>
                      <h2 className="mb-0 mt-1 text-lg font-semibold">
                        {showRunHistory
                          ? "运行记录"
                          : nodeMeta.find((node) => node.id === activeNode)
                              ?.title}
                      </h2>
                      {!showRunHistory ? (
                        <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                          {
                            nodeMeta.find((node) => node.id === activeNode)
                              ?.description
                          }
                        </p>
                      ) : null}
                    </div>
                    <Button
                      aria-label="关闭"
                      onClick={closeInspector}
                      size="icon"
                      variant="ghost"
                    >
                      ×
                    </Button>
                  </header>
                  <div className="px-5 pb-8">
                    {showRunHistory
                      ? renderRunHistoryPanel()
                      : renderNodePanel()}
                  </div>
                </aside>
              ) : null}
            </div>

            <Dialog onOpenChange={setEditingName} open={editingName}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>线路设置</DialogTitle>
                  <DialogDescription>
                    名称只用于帮助你区分不同的部署线路。
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="studio-path-name">线路名称</Label>
                  <Input
                    id="studio-path-name"
                    onChange={(event) => setNameDraft(event.target.value)}
                    value={nameDraft}
                  />
                </div>
                <div className="rounded-xl border border-red-200 bg-red-50/70 p-4 dark:border-red-900 dark:bg-red-950/20">
                  <div className="text-sm font-medium">删除当前线路</div>
                  <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    删除后无法恢复，但不会删除配置中心里的连接，也不会自动停止服务器上正在运行的项目。
                  </p>
                  <Button
                    className="mt-3"
                    disabled={
                      activePath.state === "deploying" || busy === "delete"
                    }
                    onClick={() => {
                      setEditingName(false);
                      setConfirmingDeletePath(true);
                    }}
                    variant="destructive"
                  >
                    <Trash2 />
                    删除这条线路
                  </Button>
                </div>
                <DialogFooter>
                  <Button
                    disabled={!nameDraft.trim() || busy === "name"}
                    onClick={() => void savePathName()}
                  >
                    保存名称
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog
              onOpenChange={setConfirmingDeletePath}
              open={confirmingDeletePath}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>确认删除线路</DialogTitle>
                  <DialogDescription>
                    确定删除“{activePath.name}
                    ”吗？此操作无法撤销。配置中心里的连接和服务器上正在运行的项目不会被删除。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    onClick={() => setConfirmingDeletePath(false)}
                    variant="secondary"
                  >
                    取消
                  </Button>
                  <Button
                    disabled={
                      activePath.state === "deploying" || busy === "delete"
                    }
                    onClick={() => void removeActivePath()}
                    variant="destructive"
                  >
                    {busy === "delete" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                    确认删除线路
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog onOpenChange={setConfirmingDeploy} open={confirmingDeploy}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>确认开始上线</DialogTitle>
                  <DialogDescription>
                    系统会读取此刻的项目，生成不可变版本并部署到服务器。
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--muted)]/35 p-4 text-sm">
                  <div>代码来源：{workspace.inspection.project_name}</div>
                  <div>
                    部署运行：
                    {selectedServer
                      ? `${selectedServer.name} · ${selectedServer.host}`
                      : "尚未选择"}
                  </div>
                  <div>
                    访问地址：
                    {activePath.routes.map((route) => route.host).join("、") ||
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
      })()
    : null;
  if (studio) return studio;

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
            <section className="relative min-h-[560px] overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--background)] bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:22px_22px] shadow-sm">
              <div className="min-w-[860px] p-6">
                <header className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]/95 px-5 py-4 shadow-sm backdrop-blur">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-semibold">
                        {activePath.name}
                      </h2>
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
                  <div className="flex items-center gap-2">
                    <Button
                      aria-label={`查看${activePath.name}的运行记录`}
                      onClick={() => setShowRunHistory(true)}
                      variant="secondary"
                    >
                      <History />
                      运行记录
                    </Button>
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
                  </div>
                </header>

                <div className="mt-20 grid grid-cols-[175px_40px_175px_40px_175px_40px_175px] items-center justify-center">
                  {nodeMeta.map((node, index) => {
                    const status = nodeStatuses[node.id];
                    const Icon = node.icon;
                    return [
                      <button
                        aria-label={`${node.title}：${statusCopy(status.tone)}，${status.summary}`}
                        className={`group relative min-h-[184px] rounded-2xl border bg-[var(--surface)] p-4 text-left shadow-md outline-none transition-all hover:-translate-y-1 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${activeNode === node.id ? "ring-2 ring-[var(--focus)] ring-offset-4 ring-offset-[var(--background)]" : ""} ${status.tone === "ready" ? "border-emerald-300 dark:border-emerald-800" : status.tone === "error" ? "border-amber-400 dark:border-amber-700" : "border-[var(--border)]"}`}
                        key={node.id}
                        onClick={() => openNode(node.id)}
                        type="button"
                      >
                        <div className="mb-6 flex items-start justify-between gap-2">
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
                        <div className="text-base font-semibold">
                          {node.title}
                        </div>
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
                          className="flex items-center"
                          key={`${node.id}-arrow`}
                        >
                          <span
                            className={`h-0.5 flex-1 ${status.tone === "ready" ? "bg-emerald-400" : status.tone === "error" ? "bg-amber-400" : "bg-[var(--border)]"}`}
                          />
                          <ChevronRight
                            className={`-ml-1 size-5 ${status.tone === "ready" ? "text-emerald-500" : status.tone === "error" ? "text-amber-500" : "text-[var(--subtle-foreground)]"}`}
                          />
                        </div>
                      ) : null,
                    ];
                  })}
                </div>

                <footer
                  className={`mt-20 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-[var(--surface)]/95 px-5 py-4 shadow-sm backdrop-blur ${freshLocalSnapshotRequired ? "border-amber-300" : "border-[var(--border)]"}`}
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
                      ) : [
                          "deployment-path-route-check",
                          "deployment-path-route-takeover",
                        ].includes(activeRun.actionKind || "") ? (
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
                        {busy === "deploy" ||
                        activePath.state === "deploying" ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Rocket />
                        )}
                        {activePath.state === "online"
                          ? "更新上线"
                          : "开始上线"}
                      </Button>
                    )}
                  </div>
                </footer>
              </div>
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

          {renderNodePanel()}
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={setShowRunHistory} open={showRunHistory}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>运行记录</SheetTitle>
            <SheetDescription>
              {activePath?.name || "当前线路"}的每次上线与不可变版本。
            </SheetDescription>
          </SheetHeader>
          <div className="mt-8 space-y-3">
            {pathRuns.length ? (
              pathRuns.map((run) => (
                <article
                  className="rounded-xl border border-[var(--border)] p-4"
                  key={run.id}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {run.sourceTitle ||
                          `${new Date(run.startedAt).toLocaleString("zh-CN")} 的上线`}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {run.status === "success"
                          ? "上线成功"
                          : run.status === "failed"
                            ? "上线失败"
                            : run.status === "needs_action"
                              ? "等待处理"
                              : "正在上线"}
                        {run.commitSha ? ` · ${run.commitSha.slice(0, 8)}` : ""}
                      </div>
                    </div>
                    {run.status === "success" && run.artifacts.length ? (
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
                    ) : null}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">
                    {run.message}
                  </p>
                  {run.artifacts.length ? (
                    <details className="mt-3 text-xs text-[var(--muted-foreground)]">
                      <summary className="cursor-pointer font-medium text-[var(--foreground)]">
                        查看 {run.artifacts.length} 个版本产物
                      </summary>
                      <div className="mt-2 space-y-2">
                        {run.artifacts.map((artifact) => (
                          <div
                            className="break-all rounded-lg bg-[var(--muted)]/55 p-2 font-mono"
                            key={`${run.id}-${artifact.service}`}
                          >
                            {artifact.service} · {artifact.digest.slice(0, 20)}…
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-10 text-center text-sm text-[var(--muted-foreground)]">
                这条线路还没有运行记录。
              </div>
            )}
          </div>
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
