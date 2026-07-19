import { openUrl } from "@tauri-apps/plugin-opener";
import {
  clear as clearClipboard,
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Database,
  ExternalLink,
  FolderGit2,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  Rocket,
  Server,
  Square,
  Tags,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseDocument } from "yaml";
import {
  bindProjectServer,
  cancelLocalPreviewStart,
  checkCnbRepositoryAccess,
  checkCnbSecretRepositoryAccess,
  checkSavedRegistryCredentials,
  checkServer,
  connectCnb,
  detectDnsProvider,
  discoverSshIdentities,
  ensureCnbRepository,
  generateSshIdentity,
  getAppSetting,
  getAppSettings,
  getCnbAccount,
  getLocalDevelopmentSupport,
  getLocalInfrastructureStatus,
  getLocalPreviewStatus,
  getRuntimeConfigSyncStatus,
  getSecretStatus,
  inspectServerRouteConflicts,
  installServerKeyWithPassword,
  listProjectEnvironments,
  listProjectVersions,
  listVersionValidations,
  listServers,
  loadRuntimeConfig,
  openStagingPreviewTunnel,
  prepareCnbSecretBundle,
  prepareLocalDevelopment,
  prepareLocalInfrastructure,
  preparePipelineIdentity,
  reapplyDeploymentRoutes,
  replaceRegistryCredentials,
  retryDeploymentCertificates,
  selectPrivateKey,
  setAppSetting,
  setVersionValidation,
  setLocalInfrastructureService,
  startLocalPreview,
  startLocalPreviewService,
  stopManagedLocalPortOwner,
  stopLocalPreview,
  stopLocalPreviewService,
  takeOverServerRoutes,
} from "../api";
import { issueFromProvider, issueFromUnknown } from "../lib/errors";
import {
  buildReleaseCenterModel,
  buildReleaseModel,
  projectSectionFromStoredScene as normalizeStoredProjectSection,
  type ProjectSection as ReleaseProjectSection,
  type ReleaseCenterModel,
} from "../lib/release-model";
import {
  legacySetupStepBlocker,
  recoveryTaskCopy,
  setupTaskCopy,
  type ReleaseSetupBlocker,
} from "../lib/release-task-copy";
import {
  deploymentNeedsActionStatus,
  deploymentVersionKey,
  friendlyVersionTitle,
  primaryVersionTitle,
  verifiedRunIdsFromSetting,
  verifiedVersionKeysFromSetting,
  type ProjectSetupProgressStage,
} from "../lib/projects";
import type {
  CnbAccount,
  CnbSecretBundle,
  DeploymentRun,
  DnsProviderHint,
  LocalInfrastructureStatus,
  LocalDevelopmentSupport,
  LocalPreviewStatus,
  ProviderCheck,
  PublicRouteStatus,
  ProjectEnvironment,
  ProjectVersion,
  RouteConflictCheck,
  RuntimeConfigFile,
  ServerForm,
  ServerResource,
  UserFacingIssue,
  VersionValidation,
  WorkspacePreview,
} from "../types";
import { parseEnvFields, RuntimeConfigFields } from "./RuntimeConfigFields";
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
import { Progress } from "./ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";

export type ProjectSection = ReleaseProjectSection;
// `test` and `production` are retained as contextual detail views so an old
// saved route or an activity notification can resume exactly where it stopped.
// They are no longer top-level navigation destinations.
export type ProjectScene = ProjectSection | "test" | "production";
type ReleaseTaskPanel = "settings" | "test" | "production";

export function projectSectionForScene(scene: ProjectScene): ProjectSection {
  return scene === "test" || scene === "production" ? "overview" : scene;
}

export function projectSectionFromStoredScene(
  value: string | null | undefined,
): ProjectSection | undefined {
  return normalizeStoredProjectSection(value);
}
type LocalMilestone = "idle" | "success" | "warning";
type StoredLocalIssue = {
  code: string;
  nextStep: string;
  recordedAt: string;
  summary?: string;
  title: string;
};

const CNB_REQUIRED_PERMISSIONS = [
  { code: "repo-code:rw", label: "读写项目代码" },
  { code: "repo-cnb-history:r", label: "读取构建记录" },
  { code: "repo-cnb-detail:r", label: "读取构建详情" },
  { code: "repo-manage:rw", label: "管理仓库设置" },
  { code: "repo-cnb-trigger:rw", label: "触发自动构建" },
  { code: "group-resource:rw", label: "创建代码仓库" },
] as const;
type CnbAuthorizationFeedback = {
  message: string;
  title: string;
  tone: "error" | "warning";
};
type LocalStartRetry = { kind: "all" } | { kind: "service"; serviceId: string };
type ManagedPortConflict = {
  owner: string;
  port: number;
  retry: LocalStartRetry;
};
type VersionSetupStep = Extract<
  ProjectSetupProgressStage,
  "repository" | "registry" | "test-environment" | "remote"
>;

const EXTERNAL_STATUS_RECHECK_MS = 30_000;

function CnbAuthorizationDialog({
  description,
  feedback,
  fieldId,
  fieldLabel = "新的访问令牌",
  onOpenChange,
  onSubmit,
  onTokenChange,
  open,
  repository,
  submitDisabled = false,
  submitLabel,
  title,
  token,
  working,
}: {
  description: string;
  feedback?: CnbAuthorizationFeedback | null;
  fieldId: string;
  fieldLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  onTokenChange: (token: string) => void;
  open: boolean;
  repository?: string;
  submitDisabled?: boolean;
  submitLabel: string;
  title: string;
  token: string;
  working: boolean;
}) {
  const [permissionsCopied, setPermissionsCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      setPermissionsCopied(false);
      setCopyFailed(false);
    }
  }, [open]);

  async function copyRequiredPermissions() {
    try {
      await copyText(
        CNB_REQUIRED_PERMISSIONS.map((permission) => permission.code).join(
          "\n",
        ),
      );
      setPermissionsCopied(true);
      setCopyFailed(false);
    } catch {
      setPermissionsCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && working) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--muted)]/45 px-3 py-2.5 text-sm">
          <span className="text-[var(--muted-foreground)]">
            还没有访问令牌？创建后回到这里粘贴。
          </span>
          <Button
            onClick={() =>
              void openUrl("https://cnb.cool/profile/token/create")
            }
            size="sm"
            variant="secondary"
          >
            <ExternalLink />
            前往 CNB 创建令牌
          </Button>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="m-0 text-xs font-medium text-[var(--muted-foreground)]">
              授权范围：在创建令牌页面勾选这 6 项
            </p>
            <Button
              onClick={() => void copyRequiredPermissions()}
              size="sm"
              variant="ghost"
            >
              {permissionsCopied ? <Check /> : <Copy />}
              {permissionsCopied ? "权限代码已复制" : "复制权限代码"}
            </Button>
          </div>
          <ul className="m-0 grid list-none gap-1.5 rounded-md bg-[var(--muted)] px-3 py-2.5 text-xs">
            {CNB_REQUIRED_PERMISSIONS.map((permission) => (
              <li
                className="flex items-center justify-between gap-3"
                key={permission.code}
              >
                <span>{permission.label}</span>
                <code className="text-[11px] text-[var(--muted-foreground)]">
                  {permission.code}
                </code>
              </li>
            ))}
          </ul>
          {copyFailed ? (
            <p className="m-0 text-xs text-[var(--warning)]" role="alert">
              没有复制成功，请按照上面的中文清单逐项勾选。
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-[var(--border)] px-3 py-2.5 text-xs leading-5">
          <strong className="block text-sm">还要检查使用范围</strong>
          <span className="mt-1 block text-[var(--muted-foreground)]">
            {repository ? (
              <>
                CNB
                令牌需要同时设置“授权范围”和“使用范围”。使用范围必须包含当前仓库{" "}
                <code className="text-[11px]">{repository}</code>
                ，或选择全部仓库。
              </>
            ) : (
              "首次创建仓库时，使用范围请选择全部仓库；创建完成后也可以改为只包含对应仓库。"
            )}
          </span>
        </div>
        <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
          令牌统一保存在本机系统密钥库，符合使用范围的项目可以复用。连接时不会为了测试权限创建仓库或触发构建；真正使用前仍会再次核对。
        </p>
        {feedback ? (
          <div
            aria-live="polite"
            className={`rounded-md border px-3 py-2.5 text-sm ${
              feedback.tone === "error"
                ? "border-[var(--destructive)]/35 bg-[var(--destructive)]/5"
                : "border-[var(--warning)]/35 bg-[var(--warning-soft)]"
            }`}
            role="alert"
          >
            <strong className="block">{feedback.title}</strong>
            <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
              {feedback.message}
            </span>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>{fieldLabel}</Label>
          <Input
            autoComplete="off"
            id={fieldId}
            onChange={(event) => onTokenChange(event.target.value)}
            type="password"
            value={token}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={working}
            onClick={() => onOpenChange(false)}
            variant="secondary"
          >
            取消
          </Button>
          <Button
            disabled={working || submitDisabled || !token.trim()}
            onClick={onSubmit}
          >
            {working ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <KeyRound />
            )}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cnbAuthorizationFeedbackMessage(error: unknown): string {
  const issue = issueFromUnknown(error);
  return issue.message === issue.title
    ? issue.message
    : `${issue.title}：${issue.message}`;
}

function stillNeedsCnbAuthorization(
  run: DeploymentRun | null | undefined,
): boolean {
  if (!run || run.status !== "needs_action") return false;
  if (["AD-CNB-101", "AD-CNB-103"].includes(run.issueCode ?? "")) return true;
  return (
    run.actionKind === "cnb-builds" &&
    /授权|权限|令牌|scope|permission|access/i.test(run.message)
  );
}

function cnbRepositoryAccessFailure(check: ProviderCheck): string | null {
  if (check.ok) return null;
  return `${check.code ?? "AD-CNB-103"}：${check.summary}`;
}

type CnbAuthorizationOpenReporter = (source: string, open: boolean) => void;

export function updateCnbAuthorizationOpenSources(
  sources: Set<string>,
  source: string,
  open: boolean,
): boolean {
  if (open) sources.add(source);
  else sources.delete(source);
  return sources.size > 0;
}

function useCnbAuthorizationDialogVisibility(
  open: boolean,
  source: string,
  report?: CnbAuthorizationOpenReporter,
) {
  useEffect(() => {
    report?.(source, open);
    return () => {
      if (open) report?.(source, false);
    };
  }, [open, report, source]);
}

function dnsHostRecord(host: string, providers: DnsProviderHint[]): string {
  const normalizedHost = host.trim().toLowerCase();
  const provider = [...providers]
    .sort((left, right) => right.zone.length - left.zone.length)
    .find((current) => {
      const zone = current.zone.trim().toLowerCase();
      return normalizedHost === zone || normalizedHost.endsWith(`.${zone}`);
    });
  if (!provider) return "";
  const zone = provider.zone.trim().toLowerCase();
  if (normalizedHost === zone) return "@";
  return normalizedHost.slice(0, -(zone.length + 1));
}

export function dnsHostRecordLabel(
  host: string,
  providers: DnsProviderHint[],
  checking: boolean,
): string {
  const record = dnsHostRecord(host, providers);
  if (record) return `主机记录 ${record}`;
  return checking
    ? "正在识别主机记录"
    : "主机记录暂未识别，请以域名平台显示为准";
}

export function publicRouteStatusPresentation(
  check: PublicRouteStatus | undefined,
  checking: boolean,
): {
  state: "active" | "idle" | "success" | "warning";
  status: string;
} {
  if (!check) {
    return checking
      ? { state: "active", status: "正在检查" }
      : { state: "idle", status: "等待检查" };
  }
  if (check.reachable || check.phase === "ready") {
    return { state: "success", status: "可以访问" };
  }
  if (check.phase === "dns") {
    return { state: "warning", status: "DNS 未解析" };
  }
  if (check.phase === "https") {
    return { state: "warning", status: "DNS 已生效，等待 HTTPS" };
  }
  if (check.phase === "tcp") {
    return { state: "warning", status: "TCP/443 不可达" };
  }
  if (check.phase === "route-conflict") {
    return { state: "warning", status: "正在使用旧服务" };
  }
  if (check.phase === "route-missing") {
    return { state: "warning", status: "服务器尚未启用" };
  }
  if (check.phase === "check") {
    return { state: "warning", status: "检查中断" };
  }
  if (check.phase === "domain-policy") {
    return { state: "warning", status: "域名访问受限" };
  }
  if (check.phase === "application") {
    return { state: "warning", status: "服务响应异常" };
  }
  return { state: "warning", status: "地址尚未就绪" };
}

export function certificateOnlyRouteFailure(
  checks: PublicRouteStatus[],
): boolean {
  const failures = checks.filter(
    (check) => !check.reachable && check.phase !== "ready",
  );
  return (
    failures.length > 0 && failures.every((check) => check.phase === "https")
  );
}

export function versionSetupStep(
  value: string | null,
): VersionSetupStep | null {
  return value === "repository" ||
    value === "registry" ||
    value === "test-environment" ||
    value === "remote"
    ? value
    : null;
}

function storedLocalIssue(value: string | null): StoredLocalIssue | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredLocalIssue>;
    if (
      typeof parsed.code !== "string" ||
      typeof parsed.title !== "string" ||
      !parsed.title.trim() ||
      typeof parsed.nextStep !== "string" ||
      !parsed.nextStep.trim()
    )
      return null;
    const normalized = issueFromUnknown(
      `${parsed.code}：${typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : parsed.title}`,
    );
    const useNormalized = normalized.title !== "操作没有完成";
    return {
      code: parsed.code,
      nextStep: useNormalized
        ? (normalized.nextSteps[0] ?? parsed.nextStep)
        : parsed.nextStep,
      recordedAt:
        typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.slice(0, 400)
          : undefined,
      title: useNormalized ? normalized.title : parsed.title,
    };
  } catch {
    return null;
  }
}

function managedPortConflict(
  code: string,
  message: string,
  retry: LocalStartRetry | undefined,
): ManagedPortConflict | null {
  if (code !== "AD-LOC-120" || !retry) return null;
  const match = message.match(
    /^项目 (.+) 正在使用本项目需要的 (\d{1,5}) 端口$/,
  );
  const port = Number(match?.[2]);
  if (
    !match?.[1]?.trim() ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return null;
  return { owner: match[1].trim(), port, retry };
}

function environmentCurrentRun(
  environment: ProjectEnvironment | undefined,
  runs: DeploymentRun[],
) {
  if (
    !environment ||
    (!environment.currentRunId && !environment.currentVersionKey)
  ) {
    return undefined;
  }
  const exact = environment.currentRunId
    ? runs.find((run) => run.id === environment.currentRunId)
    : undefined;
  if (exact) return exact;
  if (!environment.currentVersionKey) return undefined;

  if (environment.environment === "staging") {
    return runs.find(
      (run) =>
        run.environment === "staging" &&
        run.status === "success" &&
        run.actionKind !== "production-approval" &&
        versionKey(run) === environment.currentVersionKey,
    );
  }
  if (environment.environment === "production") {
    const stagingRuns = runs.filter((run) => run.environment === "staging");
    return runs.find(
      (run) =>
        run.environment === "production" &&
        run.status === "success" &&
        (versionKeyForSource(run.sourceRunId, stagingRuns) ===
          environment.currentVersionKey ||
          versionKey(run) === environment.currentVersionKey),
    );
  }
  return undefined;
}

interface ProductWorkspaceProps {
  initialProductionVersionId?: string;
  initialScene?: ProjectScene;
  initialTaskPanel?: ReleaseTaskPanel;
  /** @deprecated Standalone previews may still provide one shared server. */
  initialServer?: ServerForm;
  initialStagingServer?: ServerForm;
  initialProductionServer?: ServerForm;
  onDeployTest: (
    server: ServerForm,
    repository: string,
    useCommittedCode?: boolean,
  ) => Promise<void>;
  onCnbAuthorizationOpenChange?: (open: boolean) => void;
  onError: (message: string) => void;
  onPromote: (run: DeploymentRun, server: ServerForm) => Promise<void>;
  onRefresh: (run: DeploymentRun) => Promise<DeploymentRun>;
  onRecognitionDismiss?: () => void;
  onReselectProject?: () => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  onSceneChange?: (scene: ProjectScene) => void;
  onServerChange: (server: ServerForm) => void;
  onProductionServerChange?: (server: ServerForm) => void;
  onStagingServerChange?: (server: ServerForm) => void;
  onSetupProgressChange?: () => void;
  onSyncVersions?: () => Promise<void>;
  path: string;
  runs: DeploymentRun[];
  saving: boolean;
  showRecognitionSummary?: boolean;
  workspace: WorkspacePreview;
}

export function ProductWorkspace({
  initialProductionVersionId = "",
  initialScene,
  initialTaskPanel,
  initialServer,
  initialProductionServer,
  initialStagingServer,
  onDeployTest,
  onCnbAuthorizationOpenChange,
  onError,
  onPromote,
  onRefresh,
  onRecognitionDismiss,
  onReselectProject,
  onSaveManifest,
  onSceneChange,
  onServerChange,
  onProductionServerChange,
  onStagingServerChange,
  onSetupProgressChange,
  onSyncVersions,
  path,
  runs,
  saving,
  showRecognitionSummary = false,
  workspace,
}: ProductWorkspaceProps) {
  const cnbAuthorizationOpenSources = useRef(new Set<string>());
  const reportCnbAuthorizationOpen = useCallback<CnbAuthorizationOpenReporter>(
    (source, open) => {
      onCnbAuthorizationOpenChange?.(
        updateCnbAuthorizationOpenSources(
          cnbAuthorizationOpenSources.current,
          source,
          open,
        ),
      );
    },
    [onCnbAuthorizationOpenChange],
  );
  useEffect(
    () => () => {
      cnbAuthorizationOpenSources.current.clear();
      onCnbAuthorizationOpenChange?.(false);
    },
    [onCnbAuthorizationOpenChange],
  );
  const stagingServer = initialStagingServer ?? initialServer;
  const productionServer = initialProductionServer ?? initialServer;
  // App.tsx normally supplies the durable project section. A standalone
  // workspace must still open on the release center, which is the product's
  // default task surface rather than an implementation-specific environment.
  const [scene, setScene] = useState<ProjectScene>(initialScene ?? "overview");
  // `initialScene` and `initialProductionVersionId` are navigation inputs for
  // this mounted workspace. The parent mirrors later scene changes so it can
  // restore them after a restart; those mirrored props must not reset a version
  // the user has just selected for publishing or restoring.
  const initialSceneRequest = useRef(initialScene);
  const initialProductionVersionRequest = useRef(initialProductionVersionId);
  const [versionValidations, setVersionValidations] = useState<
    VersionValidation[]
  >([]);
  const [projectEnvironments, setProjectEnvironments] = useState<
    ProjectEnvironment[] | null
  >(null);
  const [projectVersions, setProjectVersions] = useState<
    ProjectVersion[] | null
  >(null);
  const [selectedVersionId, setSelectedVersionId] = useState(
    initialProductionVersionId,
  );
  const [localMilestone, setLocalMilestone] = useState<LocalMilestone>("idle");
  const [projectSettingsLoaded, setProjectSettingsLoaded] = useState(false);
  const [versionSetupComplete, setVersionSetupComplete] = useState<
    boolean | null
  >(null);
  const [releaseSetupBlocker, setReleaseSetupBlocker] =
    useState<ReleaseSetupBlocker | null>(null);
  const initialTaskPanelRequest = useRef(initialTaskPanel);
  const [releaseTaskPanel, setReleaseTaskPanel] =
    useState<ReleaseTaskPanel | null>(initialTaskPanel ?? null);
  const [versionSetupStartRequested, setVersionSetupStartRequested] =
    useState(false);
  const [productionWebSavePending, setProductionWebSavePending] =
    useState(false);
  const [testDeployStartRequested, setTestDeployStartRequested] =
    useState(false);
  const stagingAttempts = runs.filter(
    (run) =>
      run.environment === "staging" && run.actionKind !== "production-approval",
  );
  const hasSuccessfulStagingAttempt = stagingAttempts.some(
    (run) => run.status === "success",
  );
  const legacyStagingRuns = collapseVersionRuns(stagingAttempts);
  // During the migration, an older backend can legitimately return no
  // first-class versions even though historical successful runs still exist.
  // Once at least one Version exists (or there are no legacy successes), the
  // Version collection becomes authoritative and failed attempts stay out.
  const authoritativeVersions =
    projectVersions &&
    (projectVersions.length > 0 ||
      !legacyStagingRuns.some((run) => run.status === "success"))
      ? projectVersions
      : null;
  const stagingRuns = authoritativeVersions
    ? authoritativeVersions.map((version) =>
        deploymentRunForProjectVersion(
          version,
          stagingAttempts,
          path,
          workspace.inspection.project_name,
        ),
      )
    : legacyStagingRuns;
  const releaseRuns = authoritativeVersions
    ? [
        ...runs.filter(
          (run) =>
            !(
              run.environment === "staging" &&
              run.status === "success" &&
              run.actionKind !== "production-approval"
            ),
        ),
        ...stagingRuns,
      ]
    : runs;
  const storedVerifiedVersionKeys = versionValidations
    .filter((validation) => validation.state === "passed")
    .map((validation) => validation.versionKey);
  const rejectedVersionKeys = versionValidations
    .filter((validation) => validation.state === "rejected")
    .map((validation) => validation.versionKey);
  const verifiedVersionKeys = new Set(storedVerifiedVersionKeys);
  const releaseModel = buildReleaseModel(releaseRuns, verifiedVersionKeys);
  const stagingEnvironment = projectEnvironments?.find(
    (environment) => environment.environment === "staging",
  );
  const productionEnvironment = projectEnvironments?.find(
    (environment) => environment.environment === "production",
  );
  const staging = releaseModel.staging.latestRun ?? undefined;
  const stagingVerified = Boolean(
    staging && verifiedVersionKeys.has(versionKey(staging)),
  );
  const stagingRejected = Boolean(
    staging && rejectedVersionKeys.includes(versionKey(staging)),
  );
  const liveStaging =
    environmentCurrentRun(stagingEnvironment, releaseRuns) ??
    releaseModel.staging.deployedRun ??
    undefined;
  const production = releaseModel.production.latestRun ?? undefined;
  const liveProduction =
    environmentCurrentRun(productionEnvironment, releaseRuns) ??
    releaseModel.production.deployedRun ??
    undefined;
  const liveProductionSourceKey =
    productionEnvironment?.currentVersionKey ??
    versionKeyForSource(liveProduction?.sourceRunId, stagingAttempts);
  const currentProductionVersion = stagingRuns.find(
    (run) => versionKey(run) === liveProductionSourceKey,
  );
  const productionVersion = stagingRuns.find(
    (run) =>
      versionKey(run) ===
      versionKeyForSource(production?.sourceRunId, stagingAttempts),
  );
  const activeProductionTask =
    production && production.status !== "success" ? production : undefined;
  const activeProductionSourceKey = versionKeyForSource(
    activeProductionTask?.sourceRunId,
    stagingAttempts,
  );
  const verifiedRuns = stagingRuns.filter(
    (run) =>
      run.status === "success" && verifiedVersionKeys.has(versionKey(run)),
  );
  const verifiedVersionRunIds = verifiedRuns.map((run) => run.id);
  const verifiedRun =
    verifiedRuns.find((run) => run.id === selectedVersionId) ??
    productionVersion ??
    verifiedRuns[0];
  const verifiedRunVersionKey = verifiedRun ? versionKey(verifiedRun) : "";
  const releaseCenter = buildReleaseCenterModel({
    setup: {
      ready: versionSetupComplete === true,
      nextStep:
        versionSetupComplete === true
          ? null
          : (releaseSetupBlocker ?? "source-connection"),
    },
    runs: releaseRuns,
    versionVerifications: stagingRuns.map((run) => {
      const key = versionKey(run);
      return {
        versionKey: key,
        state: rejectedVersionKeys.includes(key)
          ? ("rejected" as const)
          : verifiedVersionKeys.has(key)
            ? ("passed" as const)
            : ("awaiting" as const),
      };
    }),
    productionWebPending: productionWebSavePending,
    productionWebVersionKey: verifiedRunVersionKey || null,
  });
  const settingKey = useMemo(
    () => `project.${encodeURIComponent(path)}`,
    [path],
  );
  const productionWebProgressKey = `${settingKey}.cnb-secret-progress.production`;
  const productionCandidateKey = `${settingKey}.production-pending-version`;
  const rejectedVersionSettingKey = `${settingKey}.rejected-version`;
  const setupStepKey = `${settingKey}.version-setup-step`;

  const environmentRefreshKey = useMemo(
    () =>
      runs
        .map((run) => `${run.id}:${run.status}:${run.updatedAt}`)
        .sort()
        .join("|"),
    [runs],
  );

  useEffect(() => {
    let active = true;
    void listProjectEnvironments(path)
      .then((environments) => {
        if (active) setProjectEnvironments(environments);
      })
      .catch(() => {
        // Older backends do not expose environment pointers. Keep the
        // deployment-run fallback so an upgrade never empties a healthy card.
        if (active) setProjectEnvironments(null);
      });
    return () => {
      active = false;
    };
  }, [environmentRefreshKey, path]);

  useEffect(() => {
    let active = true;
    void listProjectVersions(path)
      .then((versions) => {
        if (active) setProjectVersions(versions);
      })
      .catch(() => {
        // Keep the successful-run compatibility read for a single upgrade
        // cycle; a slow or older backend must not make known versions vanish.
        if (active) setProjectVersions(null);
      });
    return () => {
      active = false;
    };
  }, [environmentRefreshKey, path]);

  useEffect(() => {
    setProjectEnvironments(null);
    setProjectVersions(null);
    setReleaseTaskPanel(initialTaskPanelRequest.current ?? null);
    setProjectSettingsLoaded(false);
    setVersionSetupComplete(null);
    setReleaseSetupBlocker(null);
    setProductionWebSavePending(false);
    setVersionValidations([]);
    const sceneKey = `${settingKey}.scene`;
    const runKey = `${settingKey}.verified-run`;
    const verifiedVersionSettingKey = `${settingKey}.verified-version`;
    const milestoneKey = `${settingKey}.local-milestone`;
    const setupKey = `${settingKey}.version-setup-complete`;
    const keys = [
      runKey,
      verifiedVersionSettingKey,
      rejectedVersionSettingKey,
      milestoneKey,
      setupKey,
      setupStepKey,
      productionWebProgressKey,
      productionCandidateKey,
    ];
    if (!initialSceneRequest.current) keys.push(sceneKey);
    Promise.all([
      getAppSettings(keys),
      listVersionValidations(path).catch((): VersionValidation[] => []),
    ])
      .then(async ([settings, persistedValidations]) => {
        const storedScene = settings[sceneKey] ?? null;
        const storedRun = settings[runKey] ?? null;
        const storedVersions = settings[verifiedVersionSettingKey] ?? null;
        const storedRejectedVersions =
          settings[rejectedVersionSettingKey] ?? null;
        const storedLocalMilestone = settings[milestoneKey] ?? null;
        const storedVersionSetup = settings[setupKey] ?? null;
        const storedSetupStep = settings[setupStepKey] ?? null;
        const storedProductionWebProgress =
          settings[productionWebProgressKey] ?? null;
        const storedProductionCandidate =
          settings[productionCandidateKey] ?? null;
        if (initialSceneRequest.current) {
          setScene(initialSceneRequest.current);
        } else {
          setScene(projectSectionFromStoredScene(storedScene) ?? "overview");
        }
        // Version validation is now a durable domain record. Older releases
        // stored the same decision in app settings, so migrate only versions
        // that do not already have an authoritative backend decision. If a
        // migration write fails, keep that legacy decision for this session so
        // upgrading never makes an already approved version disappear.
        const validationsByVersion = new Map(
          persistedValidations.map((validation) => [
            validation.versionKey,
            validation,
          ]),
        );
        const migrationCandidates = new Map<
          string,
          { run: DeploymentRun; state: "passed" | "rejected" }
        >();
        const legacyPassedRunIds = verifiedRunIdsFromSetting(storedRun);
        const legacyPassedKeys = new Set(
          verifiedVersionKeysFromSetting(storedVersions),
        );
        for (const runId of legacyPassedRunIds) {
          const run = stagingAttempts.find(
            (candidate) =>
              candidate.id === runId && candidate.status === "success",
          );
          if (run) legacyPassedKeys.add(versionKey(run));
        }
        for (const key of legacyPassedKeys) {
          if (validationsByVersion.has(key)) continue;
          const run = stagingAttempts.find(
            (candidate) =>
              candidate.status === "success" && versionKey(candidate) === key,
          );
          if (run) migrationCandidates.set(key, { run, state: "passed" });
        }
        for (const key of verifiedVersionKeysFromSetting(
          storedRejectedVersions,
        )) {
          if (validationsByVersion.has(key)) continue;
          const run = stagingAttempts.find(
            (candidate) =>
              candidate.status === "success" && versionKey(candidate) === key,
          );
          if (run) migrationCandidates.set(key, { run, state: "rejected" });
        }
        await Promise.all(
          Array.from(migrationCandidates.entries()).map(
            async ([key, candidate]) => {
              try {
                const migrated = await setVersionValidation(
                  path,
                  candidate.run.id,
                  candidate.state,
                );
                validationsByVersion.set(key, migrated);
              } catch {
                validationsByVersion.set(key, {
                  versionKey: key,
                  state: candidate.state,
                  runId: candidate.run.id,
                  verifiedAt: "",
                });
              }
            },
          ),
        );
        setVersionValidations(Array.from(validationsByVersion.values()));
        // A version choice is not a durable project preference. Preserve it
        // only while the user is paused at the external production web-save
        // checkpoint; otherwise reopen on the version that is actually online
        // instead of silently keeping an old rollback choice.
        const pendingProductionCandidate =
          storedProductionWebProgress === "save-page-opened" &&
          storedProductionCandidate
            ? stagingRuns.find(
                (run) => versionKey(run) === storedProductionCandidate,
              )
            : undefined;
        setSelectedVersionId(
          pendingProductionCandidate?.id ??
            initialProductionVersionRequest.current,
        );
        setLocalMilestone(
          storedLocalMilestone === "success" ||
            storedLocalMilestone === "warning"
            ? storedLocalMilestone
            : "idle",
        );
        setVersionSetupComplete(
          storedVersionSetup === "true" || hasSuccessfulStagingAttempt,
        );
        setReleaseSetupBlocker(
          storedVersionSetup === "true" || hasSuccessfulStagingAttempt
            ? null
            : inferredReleaseSetupBlocker(
                workspace.manifestYaml,
                stagingServer,
                storedSetupStep,
              ),
        );
        setProductionWebSavePending(
          storedProductionWebProgress === "save-page-opened",
        );
      })
      .catch(() => undefined)
      .finally(() => setProjectSettingsLoaded(true));
  }, [
    productionCandidateKey,
    productionWebProgressKey,
    rejectedVersionSettingKey,
    settingKey,
    setupStepKey,
    path,
  ]);

  useEffect(() => {
    if (hasSuccessfulStagingAttempt) {
      setVersionSetupComplete(true);
      setReleaseSetupBlocker(null);
    }
  }, [hasSuccessfulStagingAttempt]);

  function selectProductionVersion(selectedProductionVersion = "") {
    setSelectedVersionId(selectedProductionVersion);
    const selectedRun = stagingRuns.find(
      (run) => run.id === selectedProductionVersion,
    );
    if (selectedRun) {
      void setAppSetting(productionCandidateKey, versionKey(selectedRun));
    }
  }

  function openReleaseTaskPanel(
    next: ReleaseTaskPanel,
    selectedProductionVersion = "",
  ) {
    if (next !== "test") setTestDeployStartRequested(false);
    if (next === "production") {
      selectProductionVersion(selectedProductionVersion);
    }
    setReleaseTaskPanel(next);
  }

  function switchScene(
    next: ProjectScene,
    selectedProductionVersion = "",
    startVersionSetup = false,
  ) {
    setReleaseTaskPanel(null);
    if (next !== "test") setTestDeployStartRequested(false);
    if (next === "production") {
      selectProductionVersion(selectedProductionVersion);
    }
    setVersionSetupStartRequested(
      next === "versions" ? startVersionSetup : false,
    );
    setScene(next);
    onSceneChange?.(next);
    void setAppSetting(`${settingKey}.scene`, projectSectionForScene(next));
  }

  function updateStagingServer(server: ServerForm) {
    onServerChange(server);
    onStagingServerChange?.(server);
  }

  function updateProductionServer(server: ServerForm) {
    onProductionServerChange?.(server);
  }

  async function verifyTest(run: DeploymentRun) {
    try {
      const validation = await setVersionValidation(path, run.id, "passed");
      setVersionValidations((current) => [
        validation,
        ...current.filter(
          (candidate) => candidate.versionKey !== validation.versionKey,
        ),
      ]);
      setSelectedVersionId(run.id);
      onSetupProgressChange?.();
    } catch (error) {
      onError(issueFromUnknown(error).message);
    }
  }

  async function rejectTest(run: DeploymentRun) {
    try {
      const validation = await setVersionValidation(path, run.id, "rejected");
      setVersionValidations((current) => [
        validation,
        ...current.filter(
          (candidate) => candidate.versionKey !== validation.versionKey,
        ),
      ]);
      onSetupProgressChange?.();
    } catch (error) {
      onError(issueFromUnknown(error).message);
    }
  }

  function updateLocalMilestone(next: LocalMilestone) {
    setLocalMilestone(next);
    void setAppSetting(`${settingKey}.local-milestone`, next);
  }

  const refreshProductionWebSaveProgress = useCallback(() => {
    void getAppSetting(productionWebProgressKey)
      .then((value) =>
        setProductionWebSavePending(value === "save-page-opened"),
      )
      .catch(() => undefined);
    onSetupProgressChange?.();
  }, [onSetupProgressChange, productionWebProgressKey]);

  useEffect(() => {
    if (
      !projectSettingsLoaded ||
      !productionWebSavePending ||
      !verifiedRunVersionKey
    )
      return;
    void setAppSetting(productionCandidateKey, verifiedRunVersionKey);
  }, [
    productionCandidateKey,
    productionWebSavePending,
    projectSettingsLoaded,
    verifiedRunVersionKey,
  ]);

  const projectDisplayName =
    workspace.inspection.project_name.trim() ||
    path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ||
    "当前项目";
  const projectServiceCount = workspace.inspection.services.length;
  const projectIdentityLabel = `当前项目：${projectDisplayName}；项目路径：${path}；${projectServiceCount} 个项目服务`;

  return (
    <div className="grid h-full min-h-0 grid-rows-[58px_minmax(0,1fr)] bg-[var(--background)]">
      <header
        aria-label={projectIdentityLabel}
        className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6"
        data-tauri-drag-region
      >
        <div aria-hidden="true" className="min-w-0">
          <strong className="block truncate text-sm font-semibold">
            {projectDisplayName}
          </strong>
          <span className="block max-w-[540px] truncate text-[11px] text-[var(--muted-foreground)]">
            {path}
          </span>
        </div>
        <span
          aria-hidden="true"
          className="text-[11px] text-[var(--muted-foreground)]"
        >
          {projectServiceCount} 个项目服务
        </span>
      </header>

      <main className="min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-[1060px] px-6 py-7">
          <ProjectNavigation onChange={switchScene} scene={scene} />
          {!projectSettingsLoaded ? (
            <ProjectSceneRestoring scene={scene} />
          ) : scene === "overview" ? (
            <ReleaseOverviewScene
              liveProduction={liveProduction}
              liveStaging={liveStaging}
              onOpenProduction={(runId = "") =>
                openReleaseTaskPanel("production", runId)
              }
              onOpenSettings={() => openReleaseTaskPanel("settings")}
              onOpenTest={() => openReleaseTaskPanel("test")}
              onStartTest={() => {
                setTestDeployStartRequested(true);
                openReleaseTaskPanel("test");
              }}
              onOpenVersions={() => switchScene("versions")}
              production={production}
              productionEnvironment={productionEnvironment}
              productionWebSavePending={productionWebSavePending}
              releaseCenter={releaseCenter}
              setupComplete={versionSetupComplete === true}
              staging={staging}
              stagingEnvironment={stagingEnvironment}
              stagingRejected={stagingRejected}
              stagingRuns={stagingRuns}
              stagingVerified={stagingVerified}
              verifiedRuns={verifiedRuns}
              workspace={workspace}
            />
          ) : scene === "local" ? (
            <LocalScene
              localMilestone={localMilestone}
              onError={onError}
              onMilestoneChange={updateLocalMilestone}
              onPrepareDeployment={() => {
                onRecognitionDismiss?.();
                switchScene("settings");
              }}
              onReselectProject={onReselectProject}
              onSaveManifest={onSaveManifest}
              path={path}
              settingsLoaded={projectSettingsLoaded}
              showRecognitionSummary={showRecognitionSummary}
              workspace={workspace}
            />
          ) : scene === "versions" ? (
            <VersionScene
              cnbAuthorizationSource="scene-versions"
              deploymentAttempts={stagingAttempts}
              initialServer={stagingServer}
              initialStartRequested={false}
              onError={onError}
              onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
              onOpenProduction={(run) => {
                switchScene("production", run.id);
              }}
              onOpenTest={() => {
                setVersionSetupComplete(true);
                switchScene("test");
              }}
              onOpenSettings={() => switchScene("settings")}
              onSettingsDone={() => {
                setVersionSetupComplete(true);
                switchScene("overview");
              }}
              onSaveManifest={onSaveManifest}
              onServerChange={updateStagingServer}
              onSetupBlockerChange={setReleaseSetupBlocker}
              onSetupProgressChange={onSetupProgressChange}
              onSync={onSyncVersions ?? (async () => undefined)}
              path={path}
              productionRun={liveProduction}
              productionSourceKey={liveProductionSourceKey}
              productionWebSaveSourceKey={
                productionWebSavePending ? verifiedRunVersionKey : ""
              }
              rejectedVersionKeys={rejectedVersionKeys}
              runs={stagingRuns}
              saving={saving}
              testSourceKey={
                stagingEnvironment?.currentVersionKey ??
                (liveStaging ? versionKey(liveStaging) : "")
              }
              verifiedRunIds={verifiedVersionRunIds}
              view="versions"
              workspace={workspace}
            />
          ) : scene === "settings" ? (
            <VersionScene
              cnbAuthorizationSource="scene-settings"
              deploymentAttempts={stagingAttempts}
              initialServer={stagingServer}
              initialStartRequested={versionSetupStartRequested}
              onError={onError}
              onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
              onOpenProduction={(run) => {
                switchScene("production", run.id);
              }}
              onOpenTest={() => {
                setVersionSetupComplete(true);
                switchScene("overview");
              }}
              onOpenSettings={() => undefined}
              onSettingsDone={() => {
                setVersionSetupComplete(true);
                switchScene("overview");
              }}
              onSaveManifest={onSaveManifest}
              onServerChange={updateStagingServer}
              onSetupBlockerChange={setReleaseSetupBlocker}
              onSetupProgressChange={onSetupProgressChange}
              onSync={onSyncVersions ?? (async () => undefined)}
              path={path}
              productionRun={liveProduction}
              productionSourceKey={liveProductionSourceKey}
              productionWebSaveSourceKey={
                productionWebSavePending ? verifiedRunVersionKey : ""
              }
              rejectedVersionKeys={rejectedVersionKeys}
              runs={stagingRuns}
              saving={saving}
              testSourceKey={
                stagingEnvironment?.currentVersionKey ??
                (liveStaging ? versionKey(liveStaging) : "")
              }
              verifiedRunIds={verifiedVersionRunIds}
              view="settings"
              workspace={workspace}
            />
          ) : scene === "test" ? (
            <>
              <ContextBackButton onClick={() => switchScene("overview")} />
              <TestScene
                blockingProductionRun={
                  activeProductionTask &&
                  (!staging ||
                    activeProductionSourceKey !== versionKey(staging))
                    ? activeProductionTask
                    : undefined
                }
                initialServer={stagingServer}
                initialStartRequested={testDeployStartRequested}
                onDeploy={onDeployTest}
                onError={onError}
                cnbAuthorizationSource="scene-test"
                onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
                onOpenProduction={() => {
                  if (productionWebSavePending && verifiedRun) {
                    switchScene("production", verifiedRun.id);
                  } else if (activeProductionTask) {
                    switchScene("production", productionVersion?.id ?? "");
                  } else if (staging) {
                    switchScene("production", staging.id);
                  }
                }}
                onOpenSetup={() => switchScene("settings")}
                onRefresh={onRefresh}
                onReject={rejectTest}
                onVerify={verifyTest}
                onStartHandled={() => setTestDeployStartRequested(false)}
                path={path}
                productionRun={
                  staging &&
                  production &&
                  versionKeyForSource(
                    production.sourceRunId,
                    stagingAttempts,
                  ) === versionKey(staging)
                    ? production
                    : undefined
                }
                productionWebSaveVersionKey={
                  productionWebSavePending ? verifiedRunVersionKey : ""
                }
                run={staging}
                rejected={stagingRejected}
                setupComplete={versionSetupComplete}
                verified={stagingVerified}
                workspace={workspace}
              />
            </>
          ) : (
            <>
              <ContextBackButton onClick={() => switchScene("overview")} />
              <ProductionScene
                cnbAuthorizationSource="scene-production"
                currentTestVersion={liveStaging}
                initialWebSavePending={productionWebSavePending}
                initialServer={productionServer}
                key={
                  productionServer
                    ? `${productionServer.user}@${productionServer.host}:${productionServer.port}`
                    : "production-server-restoring"
                }
                onError={onError}
                onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
                onPromote={onPromote}
                onProgressChange={refreshProductionWebSaveProgress}
                onServerChange={updateProductionServer}
                onRefresh={onRefresh}
                onSaveManifest={onSaveManifest}
                onShowSettings={() => switchScene("settings")}
                onShowVersions={() => switchScene("versions")}
                onShowTest={() => switchScene("test")}
                path={path}
                production={production}
                currentProductionVersion={currentProductionVersion}
                productionVersion={productionVersion}
                saving={saving}
                setupComplete={versionSetupComplete === true}
                verifiedRun={verifiedRun}
                verifiedRuns={verifiedRuns}
                onSelectVersion={(runId) => {
                  setSelectedVersionId(runId);
                }}
                workspace={workspace}
              />
            </>
          )}
          <Sheet
            onOpenChange={(open) => {
              if (!open) {
                setReleaseTaskPanel(null);
                setTestDeployStartRequested(false);
              }
            }}
            open={releaseTaskPanel !== null}
          >
            <SheetContent className="sm:w-[min(820px,calc(100vw-32px))] sm:max-w-[820px]">
              <SheetTitle className="sr-only">
                {releaseTaskPanel === "settings"
                  ? "完成当前上线设置"
                  : releaseTaskPanel === "test"
                    ? "测试环境任务"
                    : "正式环境任务"}
              </SheetTitle>
              <SheetDescription className="sr-only">
                在发布中心原地完成当前任务，关闭后仍会回到同一项目状态。
              </SheetDescription>
              {releaseTaskPanel === "settings" ? (
                <VersionScene
                  cnbAuthorizationSource="panel-settings"
                  deploymentAttempts={stagingAttempts}
                  focusCurrentTask
                  initialServer={stagingServer}
                  initialStartRequested={versionSetupStartRequested}
                  onError={onError}
                  onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
                  onOpenProduction={(run) =>
                    openReleaseTaskPanel("production", run.id)
                  }
                  onOpenTest={() => {
                    setVersionSetupComplete(true);
                    openReleaseTaskPanel("test");
                  }}
                  onOpenSettings={() => undefined}
                  onSettingsDone={() => {
                    setVersionSetupComplete(true);
                    setReleaseTaskPanel(null);
                  }}
                  onSaveManifest={onSaveManifest}
                  onServerChange={updateStagingServer}
                  onSetupBlockerChange={setReleaseSetupBlocker}
                  onSetupProgressChange={onSetupProgressChange}
                  onSync={onSyncVersions ?? (async () => undefined)}
                  path={path}
                  productionRun={liveProduction}
                  productionSourceKey={liveProductionSourceKey}
                  productionWebSaveSourceKey={
                    productionWebSavePending ? verifiedRunVersionKey : ""
                  }
                  rejectedVersionKeys={rejectedVersionKeys}
                  runs={stagingRuns}
                  saving={saving}
                  testSourceKey={
                    stagingEnvironment?.currentVersionKey ??
                    (liveStaging ? versionKey(liveStaging) : "")
                  }
                  verifiedRunIds={verifiedVersionRunIds}
                  view="settings"
                  workspace={workspace}
                />
              ) : releaseTaskPanel === "test" ? (
                <TestScene
                  blockingProductionRun={
                    activeProductionTask &&
                    (!staging ||
                      activeProductionSourceKey !== versionKey(staging))
                      ? activeProductionTask
                      : undefined
                  }
                  initialServer={stagingServer}
                  initialCnbAuthorizationOpen={Boolean(
                    releaseCenter.phase === "recover-test-task" &&
                    ["AD-CNB-101", "AD-CNB-103"].includes(
                      releaseCenter.pendingTask?.run.issueCode ?? "",
                    ),
                  )}
                  initialStartRequested={testDeployStartRequested}
                  onDeploy={onDeployTest}
                  onError={onError}
                  cnbAuthorizationSource="panel-test"
                  onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
                  onOpenProduction={() => {
                    if (productionWebSavePending && verifiedRun) {
                      openReleaseTaskPanel("production", verifiedRun.id);
                    } else if (activeProductionTask) {
                      openReleaseTaskPanel(
                        "production",
                        productionVersion?.id ?? "",
                      );
                    } else if (staging) {
                      openReleaseTaskPanel("production", staging.id);
                    }
                  }}
                  onOpenSetup={() => openReleaseTaskPanel("settings")}
                  onRefresh={onRefresh}
                  onReject={rejectTest}
                  onVerify={verifyTest}
                  onStartHandled={() => setTestDeployStartRequested(false)}
                  path={path}
                  productionRun={
                    staging &&
                    production &&
                    versionKeyForSource(
                      production.sourceRunId,
                      stagingAttempts,
                    ) === versionKey(staging)
                      ? production
                      : undefined
                  }
                  productionWebSaveVersionKey={
                    productionWebSavePending ? verifiedRunVersionKey : ""
                  }
                  run={staging}
                  rejected={stagingRejected}
                  setupComplete={versionSetupComplete}
                  verified={stagingVerified}
                  workspace={workspace}
                />
              ) : releaseTaskPanel === "production" ? (
                <ProductionScene
                  cnbAuthorizationSource="panel-production"
                  currentTestVersion={liveStaging}
                  initialWebSavePending={productionWebSavePending}
                  initialCnbAuthorizationOpen={Boolean(
                    releaseCenter.phase === "recover-production-task" &&
                    ["AD-CNB-101", "AD-CNB-103"].includes(
                      releaseCenter.pendingTask?.run.issueCode ?? "",
                    ),
                  )}
                  initialServer={productionServer}
                  key={
                    productionServer
                      ? `${productionServer.user}@${productionServer.host}:${productionServer.port}`
                      : "production-server-restoring-panel"
                  }
                  onError={onError}
                  onCnbAuthorizationOpenChange={reportCnbAuthorizationOpen}
                  onPromote={onPromote}
                  onProgressChange={refreshProductionWebSaveProgress}
                  onServerChange={updateProductionServer}
                  onRefresh={onRefresh}
                  onSaveManifest={onSaveManifest}
                  onShowSettings={() => openReleaseTaskPanel("settings")}
                  onShowVersions={() => switchScene("versions")}
                  onShowTest={() => openReleaseTaskPanel("test")}
                  path={path}
                  production={production}
                  currentProductionVersion={currentProductionVersion}
                  productionVersion={productionVersion}
                  saving={saving}
                  setupComplete={versionSetupComplete === true}
                  verifiedRun={verifiedRun}
                  verifiedRuns={verifiedRuns}
                  onSelectVersion={(runId) => {
                    setSelectedVersionId(runId);
                  }}
                  workspace={workspace}
                />
              ) : null}
            </SheetContent>
          </Sheet>
        </div>
      </main>
    </div>
  );
}

function ProjectNavigation({
  onChange,
  scene,
}: {
  onChange: (scene: ProjectScene) => void;
  scene: ProjectScene;
}) {
  const activeSection = projectSectionForScene(scene);
  const items: Array<{ key: ProjectSection; label: string }> = [
    { key: "overview", label: "发布中心" },
    { key: "local", label: "在本机运行" },
    { key: "versions", label: "版本" },
    { key: "settings", label: "项目设置" },
  ];
  return (
    <nav
      aria-label="项目导航"
      className="mb-8 flex items-center gap-6 border-b border-[var(--border)] max-[760px]:grid max-[760px]:grid-cols-2 max-[760px]:gap-x-4"
    >
      {items.map((item) => (
        <button
          aria-current={activeSection === item.key ? "page" : undefined}
          className={`relative -mb-px min-h-11 border-b-2 px-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
            activeSection === item.key
              ? "border-[var(--foreground)] font-semibold text-[var(--foreground)]"
              : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
          key={item.key}
          onClick={() => onChange(item.key)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function ContextBackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button className="mb-5" onClick={onClick} size="sm" variant="ghost">
      ← 返回发布中心
    </Button>
  );
}

function environmentOnlineVersionTitle(
  environment: ProjectEnvironment | undefined,
  run: DeploymentRun | undefined,
) {
  if (run) return versionTitle(run);
  const key = environment?.currentVersionKey;
  if (!key) return null;
  if (key.startsWith("commit:")) return `代码 ${key.slice(7, 15)}`;
  if (key.startsWith("candidate:")) return key.slice(10);
  const digest = key.match(/sha256:([a-f0-9]{12})[a-f0-9]*/i)?.[1];
  if (digest) return `镜像 ${digest}`;
  return "已有在线版本";
}

function ReleaseOverviewScene({
  liveProduction,
  liveStaging,
  onOpenProduction,
  onOpenSettings,
  onOpenTest,
  onStartTest,
  onOpenVersions,
  production,
  productionEnvironment,
  productionWebSavePending,
  releaseCenter,
  setupComplete,
  staging,
  stagingEnvironment,
  stagingRejected,
  stagingRuns,
  stagingVerified,
  verifiedRuns,
  workspace,
}: {
  liveProduction?: DeploymentRun;
  liveStaging?: DeploymentRun;
  onOpenProduction: (runId?: string) => void;
  onOpenSettings: () => void;
  onOpenTest: () => void;
  onStartTest: () => void;
  onOpenVersions: () => void;
  production?: DeploymentRun;
  productionEnvironment?: ProjectEnvironment;
  productionWebSavePending: boolean;
  releaseCenter: ReleaseCenterModel;
  setupComplete: boolean;
  staging?: DeploymentRun;
  stagingEnvironment?: ProjectEnvironment;
  stagingRejected: boolean;
  stagingRuns: DeploymentRun[];
  stagingVerified: boolean;
  verifiedRuns: DeploymentRun[];
  workspace: WorkspacePreview;
}) {
  const productionVersionKey =
    productionEnvironment?.currentVersionKey ??
    versionKeyForSource(liveProduction?.sourceRunId, stagingRuns);
  const candidate = verifiedRuns.find(
    (run) => versionKey(run) !== productionVersionKey,
  );
  const stagingActive = Boolean(
    staging && ["queued", "running"].includes(staging.status),
  );
  const stagingNeedsAction = Boolean(
    staging && ["failed", "needs_action"].includes(staging.status),
  );
  const productionActive = Boolean(
    production && ["queued", "running"].includes(production.status),
  );
  const productionNeedsAction = Boolean(
    production && ["failed", "needs_action"].includes(production.status),
  );
  const testAddresses = environmentAddresses(workspace, "staging");
  const productionAddresses = environmentAddresses(workspace, "production");
  const stagingOnlineTitle = environmentOnlineVersionTitle(
    stagingEnvironment,
    liveStaging,
  );
  const productionOnlineRun =
    stagingRuns.find((run) => versionKey(run) === productionVersionKey) ??
    liveProduction;
  const productionOnlineTitle = environmentOnlineVersionTitle(
    productionEnvironment,
    productionOnlineRun,
  );
  const testAction = { label: "查看详情", onClick: onOpenTest };
  const productionAction =
    production ||
    liveProduction ||
    productionEnvironment?.currentVersionKey ||
    candidate
      ? {
          label: "查看详情",
          onClick: () => onOpenProduction(candidate?.id ?? ""),
        }
      : undefined;

  return (
    <div>
      <PageHeading
        action={
          <Button onClick={onOpenVersions} size="sm" variant="secondary">
            <Tags />
            查看全部版本
          </Button>
        }
        description="先看两个环境现在是什么状态；需要你操作时，这里只保留一个明确的下一步。"
        title="发布中心"
      />

      <ReleaseCenterTaskCard
        model={releaseCenter}
        onOpenProduction={onOpenProduction}
        onOpenSettings={onOpenSettings}
        onOpenTest={onOpenTest}
        onStartTest={onStartTest}
      />

      <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
        <EnvironmentOverviewCard
          action={testAction}
          address={testAddresses[0]?.url ?? "尚未生成测试地址"}
          detail={
            stagingNeedsAction && stagingOnlineTitle
              ? `上次更新未完成，仍在运行 ${stagingOnlineTitle}`
              : stagingOnlineTitle
                ? stagingOnlineTitle
                : "还没有部署版本"
          }
          environment="测试环境"
          status={
            stagingActive
              ? deploymentStatus(staging!)
              : stagingNeedsAction
                ? deploymentStatus(staging!)
                : stagingEnvironment?.currentVersionKey &&
                    stagingEnvironment.status !== "healthy"
                  ? "状态待确认"
                  : stagingRejected
                    ? "测试未通过"
                    : stagingVerified
                      ? "测试已通过"
                      : staging?.status === "success"
                        ? "等待你确认"
                        : setupComplete
                          ? "等待首次部署"
                          : "尚未准备"
          }
          tone={
            stagingNeedsAction || stagingRejected
              ? "warning"
              : stagingActive
                ? "active"
                : stagingEnvironment?.currentVersionKey &&
                    stagingEnvironment.status !== "healthy"
                  ? "idle"
                  : stagingVerified
                    ? "success"
                    : "idle"
          }
        />
        <EnvironmentOverviewCard
          action={productionAction}
          address={productionAddresses[0]?.url ?? "尚未设置正式地址"}
          detail={
            productionOnlineTitle ? productionOnlineTitle : "还没有正式版本"
          }
          environment="正式环境"
          status={
            productionActive
              ? deploymentStatus(production!)
              : productionNeedsAction
                ? deploymentStatus(production!)
                : productionWebSavePending
                  ? "等待继续发布"
                  : productionEnvironment?.currentVersionKey
                    ? productionEnvironment.status === "healthy"
                      ? "运行正常"
                      : "状态待确认"
                    : production?.status === "success"
                      ? "运行正常"
                      : candidate
                        ? "有版本可以发布"
                        : "尚未发布"
          }
          tone={
            productionNeedsAction || productionWebSavePending
              ? "warning"
              : productionActive
                ? "active"
                : productionEnvironment?.currentVersionKey
                  ? productionEnvironment.status === "healthy"
                    ? "success"
                    : "idle"
                  : production?.status === "success"
                    ? "success"
                    : candidate
                      ? "active"
                      : "idle"
          }
        />
      </div>

      <Section
        title="自动更新"
        trailing={setupComplete ? "已设置" : "等待设置"}
      >
        <div className="flex items-center justify-between gap-5">
          <div>
            <strong className="block text-sm">
              主分支更新后自动生成版本并部署到测试环境
            </strong>
            <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
              正式环境不会自动更新；只有测试通过的版本，才会在这里出现发布按钮。
            </span>
          </div>
          {candidate ? (
            <span className="shrink-0 rounded-full bg-[var(--success-soft)] px-3 py-1 text-xs text-[var(--success)]">
              {versionTitle(candidate)} 可发布
            </span>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function EnvironmentOverviewCard({
  action,
  address,
  detail,
  environment,
  status,
  tone,
}: {
  action?: { label: string; onClick: () => void };
  address: string;
  detail: string;
  environment: string;
  status: string;
  tone: "idle" | "active" | "success" | "warning";
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="text-xs text-[var(--muted-foreground)]">
            {environment}
          </span>
          <h2 className="mb-0 mt-1 text-lg font-semibold">{status}</h2>
        </div>
        <span
          aria-label={status}
          className={`mt-1 size-2.5 rounded-full ${
            tone === "success"
              ? "bg-[var(--success)]"
              : tone === "warning"
                ? "bg-[var(--warning)]"
                : tone === "active"
                  ? "bg-[var(--accent)]"
                  : "bg-[var(--muted-strong)]"
          }`}
        />
      </div>
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <strong className="block truncate text-sm">{detail}</strong>
        <span
          className="mt-1 block truncate text-xs text-[var(--muted-foreground)]"
          title={address}
        >
          {address}
        </span>
      </div>
      {action ? (
        <Button
          aria-label={`${environment}：${status}，${action.label}`}
          className="mt-5 w-full"
          onClick={action.onClick}
          size="sm"
          variant="secondary"
        >
          {action.label}
        </Button>
      ) : null}
    </section>
  );
}

function ReleaseCenterTaskCard({
  model,
  onOpenProduction,
  onOpenSettings,
  onOpenTest,
  onStartTest,
}: {
  model: ReleaseCenterModel;
  onOpenProduction: (runId?: string) => void;
  onOpenSettings: () => void;
  onOpenTest: () => void;
  onStartTest: () => void;
}) {
  const version = model.currentVersion
    ? versionTitle(model.currentVersion.run)
    : "";
  const exactSetupCopy = setupTaskCopy(model.setup.nextStep);
  const recoveryEnvironment =
    model.phase === "recover-production-task" ? "production" : "staging";
  const exactRecoveryCopy = recoveryTaskCopy(
    model.pendingTask?.run,
    recoveryEnvironment,
  );
  const productionWebRecoveryCopy = model.productionWebPending
    ? {
        title: "正式版还差网页保存",
        message:
          "去代码平台网页粘贴并保存已经准备好的正式配置；完成后会继续同一个版本。",
        action: "继续网页保存",
      }
    : exactRecoveryCopy;
  const copy: Record<
    ReleaseCenterModel["phase"],
    { title: string; message: string; action: string | null }
  > = {
    setup: {
      title:
        model.primaryAction.kind === "start-test-deployment"
          ? "准备生成第一个测试版"
          : exactSetupCopy.title,
      message:
        model.primaryAction.kind === "start-test-deployment"
          ? "项目已经准备好。现在可以生成第一个版本并部署到测试环境。"
          : exactSetupCopy.message,
      action:
        model.primaryAction.kind === "start-test-deployment"
          ? "生成第一个测试版"
          : exactSetupCopy.action,
    },
    "build-deploy-progress": {
      title: version ? `${version} 正在生成测试版` : "正在生成测试版",
      message: "任务会保留当前进度，可以离开页面后再回来查看。",
      action: "查看进度",
    },
    "recover-test-task": {
      ...exactRecoveryCopy,
    },
    "awaiting-test": {
      title: version ? `${version} 等待确认` : "测试版等待确认",
      message: "先打开测试地址确认主要功能，再记录测试通过或测试有问题。",
      action: "打开并确认测试版",
    },
    "test-rejected": {
      title: version ? `${version} 暂不发布` : "这个版本暂不发布",
      message:
        "测试问题已经记录。修改代码并更新主分支后，系统会自动生成一个新版本。",
      action: null,
    },
    eligible: {
      title: version ? `${version} 已经可以发布` : "这个版本已经可以发布",
      message: "正式版会使用测试通过的同一个版本，不会重新构建。",
      action: "发布到正式环境",
    },
    "production-progress": {
      title: version ? `${version} 正在发布正式版` : "正在发布正式版",
      message: "当前正式版在切换成功前会继续运行。",
      action: "查看发布进度",
    },
    "recover-production-task": {
      ...productionWebRecoveryCopy,
    },
    healthy: {
      title: "正式版运行正常",
      message: version ? `当前运行 ${version}。` : "当前正式环境运行正常。",
      action: "查看正式环境",
    },
  };
  const current = copy[model.phase];
  const warning =
    model.phase === "setup" ||
    model.phase === "recover-test-task" ||
    model.phase === "recover-production-task" ||
    model.phase === "test-rejected";
  const success = model.phase === "eligible" || model.phase === "healthy";

  function performPrimaryAction() {
    switch (model.primaryAction.kind) {
      case "continue-setup":
        onOpenSettings();
        break;
      case "start-test-deployment":
        onStartTest();
        break;
      case "publish-version":
      case "view-production-progress":
      case "recover-production-task":
      case "view-production":
        onOpenProduction(model.currentVersion?.run.id ?? "");
        break;
      case "wait-for-new-version":
        break;
      default:
        onOpenTest();
    }
  }

  return (
    <section
      aria-label="当前发布任务"
      className={`mb-5 rounded-lg border px-5 py-5 ${warning ? "border-[var(--warning)]/35 bg-[var(--warning-soft)]" : success ? "border-[var(--success)]/25 bg-[var(--success-soft)]" : "border-[var(--accent)]/25 bg-[var(--info-soft)]"}`}
    >
      <div className="flex items-center justify-between gap-5 max-[760px]:flex-col max-[760px]:items-stretch">
        <div>
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            当前要做的事
          </span>
          <h2 className="mb-0 mt-1 text-lg font-semibold">{current.title}</h2>
          <p className="mb-0 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
            {current.message}
          </p>
        </div>
        {current.action ? (
          <Button className="shrink-0" onClick={performPrimaryAction}>
            {current.action}
          </Button>
        ) : (
          <span className="shrink-0 rounded-full bg-[var(--surface)] px-3 py-1 text-xs text-[var(--muted-foreground)]">
            等待代码更新
          </span>
        )}
      </div>
    </section>
  );
}

function ProjectSceneRestoring({ scene }: { scene: ProjectScene }) {
  const copy: Record<ProjectScene, { description: string; title: string }> = {
    overview: {
      title: "发布中心",
      description: "正在恢复测试环境、正式环境和可发布版本。",
    },
    local: {
      title: "在本机运行",
      description: "正在恢复上次运行状态和必要配置。",
    },
    versions: {
      title: "版本",
      description: "正在恢复测试结果和版本记录。",
    },
    settings: {
      title: "项目设置",
      description: "正在恢复连接、环境和自动部署设置。",
    },
    test: {
      title: "部署测试版",
      description: "正在恢复测试版和你的验证结果。",
    },
    production: {
      title: "发布正式版",
      description: "正在恢复正式版和可发布版本。",
    },
  };
  return (
    <div>
      <PageHeading {...copy[scene]} />
      <div className="mt-6 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <LoaderCircle className="size-5 shrink-0 animate-spin-slow text-[var(--accent)]" />
        <div>
          <strong className="block text-sm">正在恢复项目状态</strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            只读取已经保存的信息，不会重新启动服务或执行部署。
          </span>
        </div>
      </div>
    </div>
  );
}

function LocalScene({
  localMilestone,
  onError,
  onMilestoneChange,
  onPrepareDeployment,
  onReselectProject,
  onSaveManifest,
  path,
  settingsLoaded,
  showRecognitionSummary,
  workspace,
}: {
  localMilestone: LocalMilestone;
  onError: (message: string) => void;
  onMilestoneChange: (milestone: LocalMilestone) => void;
  onPrepareDeployment: () => void;
  onReselectProject?: () => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  path: string;
  settingsLoaded: boolean;
  showRecognitionSummary: boolean;
  workspace: WorkspacePreview;
}) {
  const [preview, setPreview] = useState<LocalPreviewStatus | null>(null);
  const [infrastructure, setInfrastructure] =
    useState<LocalInfrastructureStatus | null>(null);
  const [developmentSupport, setDevelopmentSupport] =
    useState<LocalDevelopmentSupport | null>(null);
  const [runMode, setRunMode] = useState<"stable" | "development">("stable");
  const [runModeLoaded, setRunModeLoaded] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [previewChecked, setPreviewChecked] = useState(false);
  const [infrastructureChecked, setInfrastructureChecked] = useState(false);
  const [working, setWorking] = useState("");
  const [workingOperation, setWorkingOperation] = useState<
    "idle" | "start" | "stop"
  >("idle");
  const [blocker, setBlocker] = useState("");
  const [notice, setNotice] = useState("");
  const [lastLocalIssue, setLastLocalIssue] = useState<StoredLocalIssue | null>(
    null,
  );
  const [lastLocalIssueLoaded, setLastLocalIssueLoaded] = useState(false);
  const [startStartedAt, setStartStartedAt] = useState<number | null>(null);
  const [startElapsedSeconds, setStartElapsedSeconds] = useState(0);
  const [cancellingStart, setCancellingStart] = useState(false);
  const [portConflict, setPortConflict] = useState<ManagedPortConflict | null>(
    null,
  );
  const statusRequest = useRef(0);
  const requiredInfrastructure = useMemo(
    () => localInfrastructureRequirements(workspace),
    [workspace],
  );
  const lastLocalIssueKey = `project.${encodeURIComponent(path)}.local-last-issue`;

  const clearLastLocalIssue = useCallback(() => {
    setLastLocalIssue(null);
    void setAppSetting(lastLocalIssueKey, "").catch(() => undefined);
  }, [lastLocalIssueKey]);

  useEffect(() => {
    let active = true;
    setLastLocalIssueLoaded(false);
    void getAppSetting(lastLocalIssueKey)
      .then((value) => {
        if (active) setLastLocalIssue(storedLocalIssue(value));
      })
      .catch(() => {
        if (active) setLastLocalIssue(null);
      })
      .finally(() => {
        if (active) setLastLocalIssueLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [lastLocalIssueKey]);

  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    const isLatest = () => request === statusRequest.current;
    const modeKey = `project.${encodeURIComponent(path)}.local-run-mode`;
    setRunModeLoaded(false);
    setPreviewChecked(false);
    setInfrastructureChecked(false);
    setPreview(null);
    setInfrastructure(null);
    setDevelopmentSupport(null);
    setBlocker("");

    const previewRequest = getLocalPreviewStatus(path)
      .then((next) => {
        if (isLatest()) setPreview(next);
        return next;
      })
      .catch((error) => {
        if (isLatest()) {
          setBlocker(
            `本机状态没有完整读取：${issueFromUnknown(toMessage(error)).message}`,
          );
        }
        return null;
      })
      .finally(() => {
        if (isLatest()) setPreviewChecked(true);
      });
    const infrastructureRequest = requiredInfrastructure.length
      ? getLocalInfrastructureStatus()
          .then((next) => {
            if (isLatest()) setInfrastructure(next);
            return next;
          })
          .catch((error) => {
            if (isLatest()) {
              setBlocker(
                (current) =>
                  current ||
                  `本机状态没有完整读取：${issueFromUnknown(toMessage(error)).message}`,
              );
            }
            return null;
          })
          .finally(() => {
            if (isLatest()) setInfrastructureChecked(true);
          })
      : Promise.resolve(null).then((next) => {
          if (isLatest()) setInfrastructureChecked(true);
          return next;
        });
    const supportRequest = getLocalDevelopmentSupport(path)
      .then((next) => {
        if (isLatest()) setDevelopmentSupport(next);
        return next;
      })
      .catch(() => null);
    const storedModeRequest = getAppSetting(modeKey).catch(() => null);
    const [, , nextSupport, storedMode] = await Promise.all([
      previewRequest,
      infrastructureRequest,
      supportRequest,
      storedModeRequest,
    ]);
    if (isLatest()) {
      setRunMode(
        nextSupport?.available && storedMode === "development"
          ? "development"
          : "stable",
      );
      setRunModeLoaded(true);
    }
  }, [path, requiredInfrastructure.length]);

  useEffect(() => {
    void refresh();
    return () => {
      statusRequest.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (
      settingsLoaded &&
      localMilestone !== "success" &&
      preview?.services.length &&
      preview.services.every((service) => service.running)
    ) {
      onMilestoneChange("success");
      clearLastLocalIssue();
    }
  }, [
    clearLastLocalIssue,
    localMilestone,
    onMilestoneChange,
    preview,
    settingsLoaded,
  ]);

  useEffect(() => {
    if (!configReady) return;
    setBlocker((current) =>
      current.startsWith("本机配置还没有保存") ||
      current.startsWith("还有必填配置没有值")
        ? ""
        : current,
    );
  }, [configReady]);

  useEffect(() => {
    if (startStartedAt === null) return;
    const updateElapsed = () => {
      setStartElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startStartedAt) / 1000)),
      );
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [startStartedAt]);

  const statusLoaded =
    previewChecked && (!requiredInfrastructure.length || infrastructureChecked);
  const allServicesRunning = Boolean(
    preview?.services.length &&
    preview.services.every((service) => service.running),
  );
  const someServicesRunning = Boolean(
    preview?.services.some((service) => service.running),
  );
  const runnableServices =
    preview?.services.filter(
      (service) => service.buildStrategy !== "needs_input",
    ) ?? [];
  const runnableServiceCount = runnableServices.length;
  const blockedServiceCount =
    (preview?.services.length ?? 0) - runnableServiceCount;
  const allRunnableServicesRunning = Boolean(
    runnableServiceCount &&
    runnableServices.every((service) => service.running),
  );
  const retryingUnexplainedFailure = Boolean(
    localMilestone === "warning" &&
    lastLocalIssueLoaded &&
    !lastLocalIssue &&
    !someServicesRunning,
  );
  const bulkStartLabel = retryingUnexplainedFailure
    ? blockedServiceCount
      ? `重新启动可运行的 ${runnableServiceCount} 个服务`
      : "重新启动并记录原因"
    : blockedServiceCount
      ? `启动可运行的 ${runnableServiceCount} 个服务`
      : "一键启动全部";
  const bulkStartHint = retryingUnexplainedFailure
    ? blockedServiceCount
      ? "可以逐个重试，也可以一次重新启动可运行服务；本轮失败会保留原因。"
      : "可以逐个重试，也可以一次重新启动全部服务；本轮失败会保留原因。"
    : "";
  const infrastructureReady = requiredInfrastructure.every((service) =>
    service === "postgres"
      ? infrastructure?.postgresRunning
      : infrastructure?.redisRunning,
  );
  const developmentMode = runMode === "development";

  async function selectRunMode(next: "stable" | "development") {
    if (preview?.services.some((service) => service.running)) {
      setBlocker("请先停止全部项目服务，再切换运行方式。");
      return;
    }
    setWorking("run-mode");
    setBlocker("");
    try {
      if (next === "development") {
        setDevelopmentSupport(await prepareLocalDevelopment(path));
      }
      setRunMode(next);
      await setAppSetting(
        `project.${encodeURIComponent(path)}.local-run-mode`,
        next,
      );
    } catch (error) {
      const message = `切换运行方式未完成：${toMessage(error)}`;
      setBlocker(message);
      onError(message);
    } finally {
      setWorking("");
    }
  }

  async function runProjectAction(
    id: string,
    actionLabel: string,
    action: () => Promise<LocalPreviewStatus>,
    recordsStartResult = false,
    retry?: LocalStartRetry,
  ) {
    setWorking(id);
    setWorkingOperation(recordsStartResult ? "start" : "stop");
    setBlocker("");
    setNotice("");
    setPortConflict(null);
    if (recordsStartResult) {
      setStartStartedAt(Date.now());
      setStartElapsedSeconds(0);
      setCancellingStart(false);
    }
    try {
      const nextPreview = await action();
      setPreview(nextPreview);
      if (
        recordsStartResult &&
        nextPreview.services.some((service) => service.running)
      ) {
        onMilestoneChange(
          nextPreview.services.every((service) => service.running)
            ? "success"
            : "idle",
        );
        clearLastLocalIssue();
      }
    } catch (error) {
      const rawMessage = toMessage(error);
      const issue = issueFromUnknown(rawMessage);
      setPortConflict(managedPortConflict(issue.code, issue.message, retry));
      if (issue.code === "AD-LOC-118") {
        setNotice("已经停止这次启动，原来正在运行的其他服务不会受影响。");
        return;
      }
      if (recordsStartResult) {
        onMilestoneChange("warning");
        const storedIssue: StoredLocalIssue = {
          code: issue.code,
          nextStep:
            issue.nextSteps[0] || "处理上次提示的问题后，重新启动项目服务",
          recordedAt: new Date().toISOString(),
          summary:
            issue.code === "AD-LOC-112"
              ? issue.message.slice(0, 400)
              : undefined,
          title: issue.title,
        };
        setLastLocalIssue(storedIssue);
        void setAppSetting(
          lastLocalIssueKey,
          JSON.stringify(storedIssue),
        ).catch(() => undefined);
      }
      const message = `${actionLabel}未完成：${issue.message}`;
      setBlocker(message);
      onError(rawMessage);
    } finally {
      setWorking("");
      setWorkingOperation("idle");
      if (recordsStartResult) {
        setStartStartedAt(null);
        setCancellingStart(false);
      }
    }
  }

  async function cancelStart() {
    setCancellingStart(true);
    try {
      const accepted = await cancelLocalPreviewStart(path);
      if (!accepted) {
        setBlocker("本次启动刚刚已经结束，正在刷新最新运行状态。");
        setPreview(await getLocalPreviewStatus(path));
        setWorking("");
        setStartStartedAt(null);
        setCancellingStart(false);
      }
    } catch (error) {
      const rawMessage = toMessage(error);
      setBlocker(`停止本次启动未完成：${issueFromUnknown(rawMessage).message}`);
      onError(rawMessage);
      setCancellingStart(false);
    }
  }

  async function resolvePortConflict() {
    const conflict = portConflict;
    if (!conflict) return;
    setWorking("port-conflict");
    setBlocker("");
    try {
      await stopManagedLocalPortOwner(conflict.port);
      setPortConflict(null);
      if (conflict.retry.kind === "all") await startAll();
      else await startService(conflict.retry.serviceId);
    } catch (error) {
      const rawMessage = toMessage(error);
      const issue = issueFromUnknown(rawMessage);
      setBlocker(`自动处理端口冲突未完成：${issue.message}`);
      onError(rawMessage);
    } finally {
      setWorking("");
    }
  }

  function scrollToNecessaryConfig() {
    const section = document.getElementById("necessary-config");
    if (typeof section?.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth" });
    }
  }

  async function startAll() {
    if (!configReady) {
      setBlocker(
        preview?.envReady === false
          ? "本机配置还没有保存。先补齐必要配置并点击“保存本机配置”，系统会自动生成项目运行配置文件。"
          : "还有必填配置没有值。先补齐必要配置，再启动项目服务。",
      );
      scrollToNecessaryConfig();
      return;
    }
    if (!infrastructureReady && requiredInfrastructure.length) {
      setBlocker(
        "项目需要的运行依赖尚未启动。先准备运行依赖，再启动项目服务。",
      );
      return;
    }
    await runProjectAction(
      "all",
      retryingUnexplainedFailure ? "重新启动项目服务" : "启动全部项目服务",
      () => startLocalPreview(path, developmentMode),
      true,
      { kind: "all" },
    );
  }

  async function startService(serviceId: string) {
    if (!configReady) {
      setBlocker(
        preview?.envReady === false
          ? "本机配置还没有保存。先补齐必要配置并点击“保存本机配置”，系统会自动生成项目运行配置文件。"
          : "还有必填配置没有值。先补齐必要配置，再启动这个服务。",
      );
      scrollToNecessaryConfig();
      return;
    }
    if (!infrastructureReady && requiredInfrastructure.length) {
      setBlocker(
        "项目需要的运行依赖尚未启动。先准备运行依赖，再启动这个服务。",
      );
      return;
    }
    const index = workspace.inspection.services.findIndex(
      (service) => service.id === serviceId,
    );
    const service = workspace.inspection.services[index];
    const label = serviceDisplayName(
      serviceId,
      service?.kind ?? "",
      Math.max(index, 0),
      workspace.inspection.services.length,
    );
    await runProjectAction(
      serviceId,
      `启动${label}`,
      () => startLocalPreviewService(path, serviceId, developmentMode),
      true,
      { kind: "service", serviceId },
    );
  }

  async function toggleInfrastructure(
    service: "postgres" | "redis",
    running: boolean,
  ) {
    setWorking(service);
    setBlocker("");
    try {
      setInfrastructure(await setLocalInfrastructureService(service, running));
    } catch (error) {
      const label = service === "postgres" ? "本地数据库" : "缓存服务";
      const message = `${running ? "启动" : "停止"}${label}未完成：${toMessage(error)}`;
      setBlocker(message);
      onError(message);
    } finally {
      setWorking("");
    }
  }

  async function prepareInfrastructure() {
    setWorking("infrastructure");
    setBlocker("");
    try {
      setInfrastructure(await prepareLocalInfrastructure());
    } catch (error) {
      const message = `准备运行依赖未完成：${toMessage(error)}`;
      setBlocker(message);
      onError(message);
    } finally {
      setWorking("");
    }
  }

  async function copyProblem() {
    const details = [
      "请修复这个项目的本机启动问题。",
      `项目目录：${path}`,
      blocker ? `错误摘要：${blocker}` : "错误摘要：项目服务无法完整启动",
      lastLocalIssue
        ? `上次原因：${lastLocalIssue.summary || lastLocalIssue.title}`
        : "",
      lastLocalIssue?.nextStep ? `建议处理：${lastLocalIssue.nextStep}` : "",
      `项目服务：${workspace.inspection.services.map((service) => service.id).join(", ")}`,
      "请保留现有部署配置和环境变量名称，不要提交真实密钥。",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await writeText(details);
    } catch {
      onError("无法复制问题信息，请稍后重试");
    }
  }

  const secretVariables = workspace.inspection.environment_variables
    .filter((variable) => variable.secret)
    .map((variable) => variable.name);
  const runningServiceCount =
    preview?.services.filter((service) => service.running).length ?? 0;
  const localRetryHint = someServicesRunning
    ? "可以在项目服务中继续启动未运行的服务。"
    : `可以使用下方“${bulkStartLabel}”重新尝试。`;
  const localRecoveryMessage = lastLocalIssue
    ? `${runningServiceCount ? `当前 ${runningServiceCount}/${preview?.services.length ?? workspace.inspection.services.length} 个服务正在运行。` : "当前项目服务均未启动。"} 上次原因：${lastLocalIssue.summary || lastLocalIssue.title}。${lastLocalIssue.nextStep}`
    : `${runningServiceCount ? `当前 ${runningServiceCount}/${preview?.services.length ?? workspace.inspection.services.length} 个服务正在运行。` : "当前项目服务均未启动。"} 上次没有留下可用原因。${someServicesRunning ? localRetryHint : `点击下方“${bulkStartLabel}”；如果仍然失败，页面会保留原因和下一步。`}`;
  const lastIssueNeedsDevelopment = Boolean(
    lastLocalIssue &&
    ["AD-LOC-111", "AD-LOC-112", "AD-LOC-113", "AD-LOC-115"].includes(
      lastLocalIssue.code,
    ),
  );
  const recognizedServiceCount = workspace.inspection.services.length;
  const visibleServices = preview?.services ?? workspace.inspection.services;

  return (
    <div>
      <PageHeading
        description="快捷启动、停止项目服务，并检查后续部署需要的配置。"
        title="在本机运行"
      />
      {showRecognitionSummary ? (
        <div
          className={`mb-5 flex items-start justify-between gap-5 rounded-lg border px-4 py-3 ${recognizedServiceCount ? "border-[var(--success)]/25 bg-[var(--success-soft)]" : "border-[var(--warning)]/30 bg-[var(--warning-soft)]"}`}
          role="status"
        >
          <div className="flex items-start gap-3">
            {recognizedServiceCount ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
            )}
            <div>
              <strong className="text-sm">
                {recognizedServiceCount ? "项目识别完成" : "没有识别到项目服务"}
              </strong>
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                {recognizedServiceCount
                  ? `发现 ${recognizedServiceCount} 个项目服务。准备上线只需完成一次设置；本机运行不是上线前置条件。`
                  : "这通常是文件夹层级不对。请选择包含前后端等完整代码的最外层文件夹。"}
              </p>
            </div>
          </div>
          <Button
            onClick={
              recognizedServiceCount ? onPrepareDeployment : onReselectProject
            }
            size="sm"
            variant="secondary"
          >
            {recognizedServiceCount ? "准备上线" : "重新选择文件夹"}
          </Button>
        </div>
      ) : null}
      {!statusLoaded ? (
        <div className="mb-5 flex items-center gap-2 rounded-md bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin-slow text-[var(--accent)]" />
          正在读取本机状态，项目内容已经可以查看
        </div>
      ) : null}
      {runModeLoaded && developmentSupport?.available ? (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <strong className="text-sm font-medium">运行方式</strong>
            <span className="text-xs text-[var(--muted-foreground)]">
              只影响本机
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ChoiceCard
              checked={runMode === "stable"}
              description="接近正式环境，修改代码后需要重新启动"
              label="稳定运行"
              onClick={() => void selectRunMode("stable")}
            />
            <ChoiceCard
              checked={runMode === "development"}
              description="修改代码后自动重启或刷新页面"
              label="开发调试"
              onClick={() => void selectRunMode("development")}
            />
          </div>
        </section>
      ) : null}
      {blocker ? (
        <IssueBanner
          action={
            blocker.startsWith("本机状态没有完整读取") ? (
              <Button
                onClick={() => void refresh()}
                size="sm"
                variant="secondary"
              >
                <RefreshCw />
                重新读取状态
              </Button>
            ) : blocker.startsWith("本机配置还没有保存") ? (
              <Button
                onClick={scrollToNecessaryConfig}
                size="sm"
                variant="secondary"
              >
                去保存配置
              </Button>
            ) : portConflict ? (
              <Button
                disabled={working === "port-conflict"}
                onClick={() => void resolvePortConflict()}
                size="sm"
                variant="secondary"
              >
                {working === "port-conflict" ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <Square />
                )}
                停止 {portConflict.owner} 并继续
              </Button>
            ) : (
              <Button
                onClick={() => void copyProblem()}
                size="sm"
                variant="secondary"
              >
                <Copy />
                {lastIssueNeedsDevelopment ? "复制给开发工具" : "复制问题信息"}
              </Button>
            )
          }
          message={blocker}
          title="项目还没有完整运行"
        />
      ) : notice ? (
        <NoticeBanner message={notice} title="已停止本次启动" />
      ) : allServicesRunning && infrastructureReady && configReady ? (
        <SuccessBanner
          message="项目服务、运行依赖和必要配置均已准备。"
          title="项目已经可以打开"
        />
      ) : localMilestone === "warning" && lastLocalIssueLoaded ? (
        <IssueBanner
          action={
            lastIssueNeedsDevelopment ? (
              <Button
                onClick={() => void copyProblem()}
                size="sm"
                variant="secondary"
              >
                <Copy />
                复制给开发工具
              </Button>
            ) : null
          }
          message={localRecoveryMessage}
          title="上次启动没有完成"
        />
      ) : null}

      <div id="project-services">
        <Section
          title="项目服务"
          trailing={
            visibleServices.length === 0 && previewChecked
              ? "未识别"
              : preview
                ? `${preview.services.filter((service) => service.running).length}/${preview.services.length} 运行中`
                : previewChecked
                  ? "状态未知"
                  : "正在读取"
          }
        >
          <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            {visibleServices.length ? (
              visibleServices.map((service, index, list) => {
                const planned = "running" in service ? service : null;
                const checking = planned === null && !previewChecked;
                const unknown = planned === null && previewChecked;
                const running = planned?.running ?? false;
                const blocked = planned?.buildStrategy === "needs_input";
                const displayName = serviceDisplayName(
                  service.id,
                  service.kind,
                  index,
                  list.length,
                );
                const starting =
                  workingOperation === "start" &&
                  (working === service.id || (working === "all" && !running));
                const stopping =
                  workingOperation === "stop" &&
                  (working === service.id ||
                    (working === "stop-all" && running));
                return (
                  <StatusRow
                    action={
                      checking || unknown ? undefined : blocked ? (
                        <Button
                          aria-label={`把${displayName}交给开发工具`}
                          onClick={() => void copyProblem()}
                          size="sm"
                          variant="secondary"
                        >
                          交给开发工具
                        </Button>
                      ) : running ? (
                        <>
                          {planned?.url ? (
                            <Button
                              aria-label={`打开${displayName}`}
                              onClick={() => openUrl(planned.url ?? "")}
                              size="sm"
                              variant="ghost"
                            >
                              <ArrowUpRight />
                              打开
                            </Button>
                          ) : null}
                          <Button
                            aria-label={
                              stopping
                                ? `正在停止${displayName}`
                                : `停止${displayName}`
                            }
                            disabled={Boolean(working)}
                            onClick={() =>
                              void runProjectAction(
                                service.id,
                                `停止${displayName}`,
                                () => stopLocalPreviewService(path, service.id),
                              )
                            }
                            size="sm"
                            variant="secondary"
                          >
                            {stopping ? (
                              <LoaderCircle className="animate-spin-slow" />
                            ) : null}
                            {stopping ? "正在停止" : "停止"}
                          </Button>
                          <Button
                            aria-label={`重新启动${displayName}`}
                            disabled={Boolean(working)}
                            onClick={() =>
                              void runProjectAction(
                                service.id,
                                `重新启动${displayName}`,
                                () =>
                                  startLocalPreviewService(
                                    path,
                                    service.id,
                                    developmentMode,
                                  ),
                                true,
                              )
                            }
                            size="sm"
                            variant="secondary"
                          >
                            重新启动
                          </Button>
                        </>
                      ) : (
                        <Button
                          aria-label={
                            starting
                              ? `正在启动${displayName}`
                              : `启动${displayName}`
                          }
                          disabled={Boolean(working)}
                          onClick={() => void startService(service.id)}
                          size="sm"
                          variant="secondary"
                        >
                          {starting ? (
                            <LoaderCircle className="animate-spin-slow" />
                          ) : (
                            <Play />
                          )}
                          {starting ? "正在启动" : "启动"}
                        </Button>
                      )
                    }
                    detail={
                      checking
                        ? "正在读取上次运行状态"
                        : unknown
                          ? "暂时没有读取到这个服务的运行状态"
                          : starting
                            ? `正在构建并启动 · 已等待 ${formatElapsed(startElapsedSeconds)}`
                            : stopping
                              ? "正在停止，只影响当前选择的项目服务"
                              : blocked
                                ? "项目缺少可靠运行配置，需要回到开发工具修复"
                                : running
                                  ? developmentMode
                                    ? "正在监听代码修改"
                                    : "上次启动成功"
                                  : developmentMode
                                    ? "启动后自动刷新"
                                    : localMilestone === "success"
                                      ? "上次随全部服务启动成功"
                                      : "等待启动"
                    }
                    key={service.id}
                    label={displayName}
                    state={
                      checking
                        ? "active"
                        : unknown
                          ? "warning"
                          : starting
                            ? "active"
                            : stopping
                              ? "active"
                              : blocked
                                ? "warning"
                                : running
                                  ? "success"
                                  : "idle"
                    }
                    status={
                      checking
                        ? "正在读取"
                        : unknown
                          ? "状态未知"
                          : starting
                            ? "正在准备"
                            : stopping
                              ? "正在停止"
                              : blocked
                                ? "需要开发处理"
                                : running
                                  ? "运行中"
                                  : "未启动"
                    }
                  />
                );
              })
            ) : (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                没有找到可管理的项目服务。请重新选择包含完整项目代码的最外层文件夹。
              </div>
            )}
            {visibleServices.length ? (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--muted)]/35 px-4 py-3 max-[760px]:flex-col max-[760px]:items-stretch">
                <span className="text-[11px] text-[var(--muted-foreground)]">
                  {startStartedAt === null
                    ? preview
                      ? retryingUnexplainedFailure
                        ? bulkStartHint
                        : blockedServiceCount
                          ? runnableServiceCount === 0
                            ? `当前 ${blockedServiceCount} 个服务都需要开发工具补齐运行配置；处理后回到这里启动。`
                            : allRunnableServicesRunning
                              ? `可运行的 ${runnableServiceCount} 个服务已经启动；另有 ${blockedServiceCount} 个需要开发工具处理。`
                              : `可以逐个启动，也可以一次启动 ${runnableServiceCount} 个可运行服务；另有 ${blockedServiceCount} 个需要开发工具处理。`
                          : allRunnableServicesRunning
                            ? "全部项目服务正在运行，也可以逐个或一次停止。"
                            : someServicesRunning
                              ? "可以逐个控制，也可以一次启动未运行的服务或停止全部服务。"
                              : "可以逐个启动，也可以一次启动全部服务。"
                      : previewChecked
                        ? "重新读取状态后即可启动或停止服务。"
                        : "状态读取完成后即可启动或停止服务。"
                    : `首次构建可能需要几分钟，已有进展会继续等待 · ${formatElapsed(startElapsedSeconds)}`}
                </span>
                <div className="flex flex-wrap justify-end gap-2">
                  {startStartedAt !== null ? (
                    <Button
                      disabled={cancellingStart}
                      onClick={() => void cancelStart()}
                      size="sm"
                      variant="secondary"
                    >
                      {cancellingStart ? (
                        <LoaderCircle className="animate-spin-slow" />
                      ) : (
                        <Square />
                      )}
                      {cancellingStart ? "正在停止" : "停止本次启动"}
                    </Button>
                  ) : null}
                  {startStartedAt === null && preview && someServicesRunning ? (
                    <Button
                      disabled={Boolean(working)}
                      onClick={() =>
                        void runProjectAction(
                          "stop-all",
                          "停止全部项目服务",
                          () => stopLocalPreview(path),
                        )
                      }
                      size="sm"
                      variant="secondary"
                    >
                      <Square />
                      全部停止
                    </Button>
                  ) : null}
                  {startStartedAt === null &&
                  preview &&
                  runnableServiceCount > 0 &&
                  !allRunnableServicesRunning ? (
                    <Button
                      disabled={Boolean(working)}
                      onClick={() => void startAll()}
                      size="sm"
                    >
                      {working === "all" ? (
                        <LoaderCircle className="animate-spin-slow" />
                      ) : (
                        <Play />
                      )}
                      {working === "all"
                        ? blockedServiceCount
                          ? "正在启动可运行服务"
                          : "正在启动全部"
                        : bulkStartLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </Section>
      </div>

      <Section
        title="运行依赖"
        trailing={
          requiredInfrastructure.length
            ? infrastructure
              ? `${requiredInfrastructure.filter((service) => (service === "postgres" ? infrastructure.postgresRunning : infrastructure.redisRunning)).length}/${requiredInfrastructure.length} 运行中`
              : infrastructureChecked
                ? "状态未知"
                : "正在读取"
            : "项目未声明"
        }
      >
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          {requiredInfrastructure.length ? (
            requiredInfrastructure.map((service) => {
              const displayName =
                service === "postgres" ? "本地数据库" : "缓存服务";
              const checking =
                infrastructure === null && !infrastructureChecked;
              const unknown = infrastructure === null && infrastructureChecked;
              const running =
                service === "postgres"
                  ? infrastructure?.postgresRunning
                  : infrastructure?.redisRunning;
              return (
                <StatusRow
                  action={
                    checking || unknown ? undefined : infrastructure?.state ===
                        "not_prepared" || running ? undefined : (
                      <Button
                        aria-label={`启动${displayName}`}
                        disabled={Boolean(working)}
                        onClick={() => void toggleInfrastructure(service, true)}
                        size="sm"
                        variant="secondary"
                      >
                        启动
                      </Button>
                    )
                  }
                  detail={
                    checking
                      ? "正在读取运行依赖状态"
                      : unknown
                        ? "暂时没有读取到运行依赖状态"
                        : running
                          ? "已启动，可以连接；由 ABCDeploy 统一维护"
                          : "项目服务启动前需要先运行"
                  }
                  key={service}
                  label={displayName}
                  state={
                    checking
                      ? "active"
                      : unknown
                        ? "warning"
                        : running
                          ? "success"
                          : "idle"
                  }
                  status={
                    checking
                      ? "正在读取"
                      : unknown
                        ? "状态未知"
                        : running
                          ? "运行正常"
                          : "未启动"
                  }
                />
              );
            })
          ) : (
            <div className="px-4 py-5 text-sm text-[var(--muted-foreground)]">
              项目没有声明需要单独启动的数据库或缓存服务。
            </div>
          )}
          {requiredInfrastructure.length &&
          infrastructure?.state === "not_prepared" ? (
            <div className="flex justify-end border-t border-[var(--border)] px-4 py-3">
              <Button
                disabled={Boolean(working)}
                onClick={() => void prepareInfrastructure()}
                size="sm"
              >
                {working === "infrastructure" ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <Database />
                )}
                自动准备运行依赖
              </Button>
            </div>
          ) : null}
        </div>
      </Section>

      <section className="mt-7" id="necessary-config">
        <RuntimeConfigFields
          environment="development"
          onError={(message) => setBlocker(message)}
          onMarkOptional={(key) =>
            onSaveManifest(
              runtimeVariableOptionalManifest(workspace.manifestYaml, key),
            )
          }
          onReadyChange={setConfigReady}
          path={path}
          secretVariables={secretVariables}
        />
      </section>
    </div>
  );
}

function VersionScene({
  cnbAuthorizationSource,
  deploymentAttempts,
  focusCurrentTask = false,
  initialServer,
  initialStartRequested,
  onError,
  onCnbAuthorizationOpenChange,
  onOpenProduction,
  onOpenSettings,
  onOpenTest,
  onSettingsDone,
  onSaveManifest,
  onServerChange,
  onSetupBlockerChange,
  onSetupProgressChange,
  onSync,
  path,
  productionRun,
  productionSourceKey,
  productionWebSaveSourceKey,
  rejectedVersionKeys,
  runs,
  saving,
  testSourceKey,
  verifiedRunIds,
  view,
  workspace,
}: {
  cnbAuthorizationSource: string;
  deploymentAttempts: DeploymentRun[];
  focusCurrentTask?: boolean;
  initialServer?: ServerForm;
  initialStartRequested: boolean;
  onError: (message: string) => void;
  onCnbAuthorizationOpenChange: CnbAuthorizationOpenReporter;
  onOpenProduction: (run: DeploymentRun) => void;
  onOpenSettings: () => void;
  onOpenTest: () => void;
  onSettingsDone: () => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  onServerChange: (server: ServerForm) => void;
  onSetupBlockerChange?: (blocker: ReleaseSetupBlocker | null) => void;
  onSetupProgressChange?: () => void;
  onSync: () => Promise<void>;
  path: string;
  productionRun?: DeploymentRun;
  productionSourceKey: string;
  productionWebSaveSourceKey: string;
  rejectedVersionKeys: string[];
  runs: DeploymentRun[];
  saving: boolean;
  testSourceKey: string;
  verifiedRunIds: string[];
  view: "settings" | "versions";
  workspace: WorkspacePreview;
}) {
  const [showSetup, setShowSetup] = useState(view === "settings");
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [setupStarted, setSetupStarted] = useState(view === "settings");
  const [setupAlreadyComplete, setSetupAlreadyComplete] = useState(false);
  const [openStep, setOpenStep] = useState<VersionSetupStep | "">("repository");
  const configuredRepository = readRepository(workspace.manifestYaml);
  const restoredRepository = usableRepository(configuredRepository)
    ? configuredRepository
    : (runs[0]?.repository ?? configuredRepository);
  const [repository, setRepository] = useState(() => restoredRepository);
  // A saved repository slug is only an address. It does not prove that the
  // current token can read code, build history/details and deployment setup.
  const [repositoryReady, setRepositoryReady] = useState(false);
  const restoredRepositoryRef = useRef(restoredRepository);
  const [registryReady, setRegistryReady] = useState(false);
  const [registryChecking, setRegistryChecking] = useState(true);
  const [server, setServer] = useState<ServerForm | undefined>(initialServer);
  const [runtimeConfigFieldChecking, setRuntimeConfigFieldChecking] =
    useState(false);
  const {
    addressReady,
    cloudConfigReady,
    runtimeConfigReady,
    setAddressReady,
    setCloudConfigReady,
    setRuntimeConfigReady,
  } = useStagingPreparationStatus(path, server, workspace);
  const [syncing, setSyncing] = useState(false);
  const [syncBlocker, setSyncBlocker] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [foundationsExpanded, setFoundationsExpanded] = useState(false);
  const [testEnvironmentReviewResolved, setTestEnvironmentReviewResolved] =
    useState(false);
  const [detailRun, setDetailRun] = useState<DeploymentRun | null>(null);
  const [incompleteOpen, setIncompleteOpen] = useState(false);
  const syncedProject = useRef("");
  const automaticRegistryReuseStarted = useRef(false);
  const automaticSetupFinishStarted = useRef(false);
  const setupOpenStepAligned = useRef("");
  const setupKey = `project.${encodeURIComponent(path)}.version-setup-complete`;
  const setupActiveKey = `project.${encodeURIComponent(path)}.version-setup-active`;
  const setupStepKey = `project.${encodeURIComponent(path)}.version-setup-step`;
  // A failed or interrupted first attempt is not proof that project setup is
  // complete. Only a successful test deployment is a trustworthy legacy
  // fallback when the explicit setup marker is missing.
  const hasDeploymentHistory = runs.some(
    (run) => run.environment === "staging" && run.status === "success",
  );

  useEffect(() => setServer(initialServer), [initialServer]);
  useEffect(() => {
    if (restoredRepositoryRef.current === restoredRepository) return;
    restoredRepositoryRef.current = restoredRepository;
    // saveRepository may have already moved local state to this exact value
    // after a successful capability check. Do not turn that success back into
    // an unchecked state when the parent subsequently supplies the saved YAML.
    if (repository === restoredRepository) return;
    setRepository(restoredRepository);
    setRepositoryReady(false);
  }, [repository, restoredRepository]);
  const cnbRegistryRepositoryReady =
    readRegistry(workspace.manifestYaml).kind === "cnb"
      ? repositoryReady
      : null;
  useEffect(() => {
    const registry = readRegistry(workspace.manifestYaml);
    if (registry.kind === "cnb") {
      // CNB stores images alongside the real code repository. A placeholder
      // such as `owner/project` is only a template value, not a usable version
      // location, so it must not make the second setup step look complete.
      setRegistryReady(Boolean(cnbRegistryRepositoryReady));
      setRegistryChecking(false);
      return;
    }
    let active = true;
    setRegistryChecking(true);
    const prefix = registry.kind === "tcr" ? "registry.tcr.v2" : "registry.oci";
    Promise.all([
      getSecretStatus(`${prefix}.username`),
      getSecretStatus(`${prefix}.password`),
      getAppSetting(registryVerificationKey(prefix)),
    ])
      .then(([username, password, verifiedEndpoint]) => {
        const ready =
          usableRegistryNamespace(registry.namespace) &&
          username.stored &&
          password.stored &&
          verifiedEndpoint === registry.endpoint;
        if (active) setRegistryReady(ready);
        if (ready && registry.kind === "tcr") {
          void rememberTcrPreference(registry.namespace).catch(() => undefined);
        }
      })
      .catch(() => {
        if (active) setRegistryReady(false);
      })
      .finally(() => {
        if (active) setRegistryChecking(false);
      });
    return () => {
      active = false;
    };
  }, [cnbRegistryRepositoryReady, workspace.manifestYaml]);
  useEffect(() => {
    const registry = readRegistry(workspace.manifestYaml);
    if (
      !setupStarted ||
      registry.kind !== "cnb" ||
      (workspace.manifestExists && !workspace.adoption.freshDraft) ||
      automaticRegistryReuseStarted.current
    )
      return;
    automaticRegistryReuseStarted.current = true;
    let active = true;
    Promise.all([
      getAppSetting("registry.mode"),
      getAppSetting("registry.tcr.namespace"),
      getSecretStatus("registry.tcr.v2.username"),
      getSecretStatus("registry.tcr.v2.password"),
      getAppSetting(registryVerificationKey("registry.tcr.v2")),
    ])
      .then(([mode, namespace, user, secret, verifiedEndpoint]) => {
        if (
          !active ||
          mode !== "tcr" ||
          !namespace?.trim() ||
          !user.stored ||
          !secret.stored ||
          verifiedEndpoint !== "ccr.ccs.tencentyun.com"
        )
          return;
        return checkSavedRegistryCredentials(
          "ccr.ccs.tencentyun.com",
          "registry.tcr.v2",
        ).then(async (check) => {
          if (!active) return;
          if (!check.ok) {
            if (check.retryable === false) {
              await setAppSetting(
                registryVerificationKey("registry.tcr.v2"),
                "",
              );
            }
            return;
          }
          return onSaveManifest(
            tcrRegistryManifest(workspace.manifestYaml, namespace.trim()),
          );
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [
    onSaveManifest,
    setupStarted,
    workspace.adoption.freshDraft,
    workspace.manifestExists,
    workspace.manifestYaml,
  ]);
  useEffect(() => {
    Promise.all([getAppSetting(setupKey), getAppSetting(setupActiveKey)])
      .then(([completedSetup, activeSetup]) => {
        setSetupAlreadyComplete(completedSetup === "true");
        setShowSetup(view === "settings");
        setSetupStarted(
          view === "settings" ||
            initialStartRequested ||
            activeSetup === "true",
        );
      })
      .catch(() => {
        setSetupAlreadyComplete(false);
        setShowSetup(view === "settings");
        setSetupStarted(view === "settings" || initialStartRequested);
      })
      .finally(() => setSetupLoaded(true));
  }, [initialStartRequested, setupActiveKey, setupKey, view]);
  useEffect(() => {
    if (!setupLoaded || showSetup || syncedProject.current === path) return;
    syncedProject.current = path;
    void onSync().catch((error) => setSyncBlocker(toMessage(error)));
  }, [onSync, path, setupLoaded, showSetup]);
  const testEnvironmentReady =
    Boolean(server) && runtimeConfigReady === true && addressReady;
  const hasSuccessfulTestDeployment = runs.some(
    (run) => run.environment === "staging" && run.status === "success",
  );
  const hasTrustedTestEnvironment =
    hasSuccessfulTestDeployment ||
    verifiedRunIds.length > 0 ||
    Boolean(productionSourceKey);
  const testEnvironmentRestoring =
    Boolean(server) && runtimeConfigReady === null;
  const testEnvironmentChecking =
    runtimeConfigFieldChecking || testEnvironmentRestoring;
  const displayedTestEnvironmentReady = testEnvironmentDisplayReady(
    testEnvironmentReady,
    testEnvironmentChecking,
    hasTrustedTestEnvironment,
    testEnvironmentReviewResolved,
  );
  const previousTestEnvironmentReady = useRef(testEnvironmentReady);
  useEffect(() => {
    const becameReady =
      testEnvironmentReady && !previousTestEnvironmentReady.current;
    previousTestEnvironmentReady.current = testEnvironmentReady;
    if (
      becameReady &&
      setupStarted &&
      showSetup &&
      !hasDeploymentHistory &&
      openStep === "test-environment"
    )
      setOpenStep("remote");
  }, [
    hasDeploymentHistory,
    openStep,
    setupStarted,
    showSetup,
    testEnvironmentReady,
  ]);
  const handleRuntimeConfigReady = useCallback(
    (next: boolean, checking: boolean) => {
      setRuntimeConfigFieldChecking(checking);
      if (!checking) {
        setRuntimeConfigReady(next);
        setTestEnvironmentReviewResolved(true);
      }
    },
    [setRuntimeConfigReady],
  );
  const ready =
    repositoryReady &&
    registryReady &&
    testEnvironmentReady &&
    cloudConfigReady;
  const completed = [
    repositoryReady,
    registryReady,
    displayedTestEnvironmentReady,
    cloudConfigReady,
  ].filter(Boolean).length;
  const pendingSetupStep: VersionSetupStep = !repositoryReady
    ? "repository"
    : !registryReady
      ? "registry"
      : !displayedTestEnvironmentReady
        ? "test-environment"
        : "remote";
  const remainingSetupSteps = 4 - completed;
  const setupChecking = registryChecking || testEnvironmentChecking;
  const currentSetupBlocker: ReleaseSetupBlocker | null = !repositoryReady
    ? "source-connection"
    : !registryReady
      ? "registry-connection"
      : !server
        ? "test-server"
        : runtimeConfigReady !== true
          ? "test-config"
          : !addressReady
            ? "test-address"
            : !cloudConfigReady
              ? "automation"
              : null;
  const focusedSetupCopy = setupTaskCopy(currentSetupBlocker);
  useEffect(() => {
    if (setupChecking) return;
    onSetupBlockerChange?.(currentSetupBlocker);
  }, [currentSetupBlocker, onSetupBlockerChange, setupChecking]);
  const setupProgressLabel = setupChecking
    ? `${completed} 项已准备 · 后台确认中`
    : remainingSetupSteps
      ? `已准备 ${completed} 项 · 还差 ${remainingSetupSteps} 项`
      : "4 项已准备";
  const foundationsCollapsed =
    repositoryReady &&
    registryReady &&
    displayedTestEnvironmentReady &&
    openStep === "remote" &&
    !foundationsExpanded;
  useEffect(() => {
    if (
      !setupLoaded ||
      !setupStarted ||
      !showSetup ||
      setupAlreadyComplete ||
      hasDeploymentHistory ||
      (repositoryReady && registryChecking) ||
      setupOpenStepAligned.current === path
    )
      return;
    setupOpenStepAligned.current = path;
    setOpenStep(pendingSetupStep);
  }, [
    hasDeploymentHistory,
    path,
    pendingSetupStep,
    registryChecking,
    repositoryReady,
    setupLoaded,
    setupStarted,
    showSetup,
  ]);
  useEffect(() => {
    if (
      !setupLoaded ||
      !setupStarted ||
      !showSetup ||
      setupAlreadyComplete ||
      hasDeploymentHistory ||
      (repositoryReady && registryChecking)
    )
      return;
    let active = true;
    void Promise.all([
      setAppSetting(setupActiveKey, "true"),
      setAppSetting(setupStepKey, pendingSetupStep),
    ])
      .then(() => {
        if (active) onSetupProgressChange?.();
      })
      .catch((error) => {
        if (!active) return;
        setSetupStarted(false);
        onError(`没有保存上线设置进度：${toMessage(error)}`);
      });
    return () => {
      active = false;
    };
  }, [
    hasDeploymentHistory,
    onError,
    onSetupProgressChange,
    pendingSetupStep,
    registryChecking,
    repositoryReady,
    setupActiveKey,
    setupLoaded,
    setupStarted,
    setupStepKey,
    showSetup,
  ]);
  useEffect(() => {
    if (
      !setupLoaded ||
      !setupStarted ||
      !showSetup ||
      setupAlreadyComplete ||
      hasDeploymentHistory ||
      setupChecking ||
      !ready ||
      automaticSetupFinishStarted.current
    )
      return;
    automaticSetupFinishStarted.current = true;
    void Promise.all([
      setAppSetting(setupKey, "true"),
      setAppSetting(setupActiveKey, "false"),
    ])
      .then(() => {
        setSetupAlreadyComplete(true);
        setShowSetup(false);
        onSetupProgressChange?.();
        onSettingsDone();
      })
      .catch((error) => {
        automaticSetupFinishStarted.current = false;
        onError(toMessage(error));
      });
  }, [
    hasDeploymentHistory,
    onError,
    onSettingsDone,
    ready,
    setupChecking,
    setupAlreadyComplete,
    setupActiveKey,
    setupKey,
    setupLoaded,
    setupStarted,
    showSetup,
  ]);
  const previousRegistryChecking = useRef(registryChecking);
  useEffect(() => {
    const checkFinished = previousRegistryChecking.current && !registryChecking;
    previousRegistryChecking.current = registryChecking;
    if (
      checkFinished &&
      setupStarted &&
      showSetup &&
      !hasDeploymentHistory &&
      openStep !== "repository"
    ) {
      if (registryReady && openStep === "registry") {
        setOpenStep(
          !repositoryReady
            ? "repository"
            : testEnvironmentReady
              ? "remote"
              : "test-environment",
        );
      } else if (!registryReady) {
        setOpenStep("registry");
      }
    }
  }, [
    hasDeploymentHistory,
    openStep,
    registryChecking,
    registryReady,
    repositoryReady,
    setupStarted,
    showSetup,
    testEnvironmentReady,
  ]);

  async function finishSetup() {
    if (hasDeploymentHistory) {
      onSettingsDone();
      return;
    }
    if (!ready) return;
    await Promise.all([
      setAppSetting(setupKey, "true"),
      setAppSetting(setupActiveKey, "false"),
    ]);
    setSetupAlreadyComplete(true);
    setShowSetup(false);
    onSetupProgressChange?.();
    onSettingsDone();
  }

  async function sync() {
    setSyncing(true);
    setSyncBlocker("");
    setLastSyncedAt("");
    try {
      await onSync();
      setLastSyncedAt(
        new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date()),
      );
    } catch (error) {
      setSyncBlocker(toMessage(error));
    } finally {
      setSyncing(false);
    }
  }

  const syncIssue = syncBlocker ? issueFromUnknown(syncBlocker) : null;

  if (!setupLoaded) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-[var(--muted-foreground)]">
        <LoaderCircle className="mr-2 size-4 animate-spin-slow" />
        正在读取项目设置
      </div>
    );
  }

  if (showSetup && !hasDeploymentHistory && !setupStarted) {
    return (
      <div>
        <PageHeading
          description="这里保存每次可以测试或发布的项目版本。首次只需完成一遍设置。"
          title="版本"
        />
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
          <Tags className="mx-auto size-9 text-[var(--subtle-foreground)]" />
          <h2 className="mb-0 mt-4 text-lg font-semibold">
            还没有可部署的版本
          </h2>
          <p className="mx-auto mb-5 mt-2 max-w-lg text-sm leading-6 text-[var(--muted-foreground)]">
            设置完成后，把准备上线的代码合并到项目主分支，系统会自动生成新版本并更新测试版；不会直接发布正式版。
          </p>
          <Button onClick={() => setSetupStarted(true)}>
            <Rocket />
            准备自动生成版本
          </Button>
        </div>
      </div>
    );
  }

  if (showSetup) {
    return (
      <div>
        <PageHeading
          description={
            focusCurrentTask
              ? focusedSetupCopy.message
              : "代码平台、镜像仓库、运行环境和自动部署都在这里维护；授权失效时也从这里直接更换。"
          }
          title={focusCurrentTask ? focusedSetupCopy.title : "项目设置"}
        />
        {!focusCurrentTask || currentSetupBlocker === "test-config" ? (
          <div className="mb-5 rounded-lg border border-[var(--accent)]/20 bg-[var(--info-soft)] px-4 py-3 text-xs leading-5 text-[var(--muted-foreground)]">
            测试和正式环境使用的运行配置会引用配置中心中的配置项，不需要在每次部署时重新填写。
          </div>
        ) : null}
        <div className="mb-4 flex justify-end">
          <span className="rounded-full bg-[var(--muted)] px-3 py-1 text-xs text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1.5">
              {setupChecking ? (
                <LoaderCircle className="size-3 animate-spin-slow" />
              ) : null}
              {setupProgressLabel}
            </span>
          </span>
        </div>
        <div className="space-y-3">
          {!focusCurrentTask && foundationsCollapsed ? (
            <button
              className="flex min-h-[56px] w-full items-center justify-between gap-4 rounded-lg border border-[var(--success)]/20 bg-[var(--success-soft)] px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              onClick={() => setFoundationsExpanded(true)}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-3">
                <CheckCircle2 className="size-5 shrink-0 text-[var(--success)]" />
                <span>
                  <strong className="block text-sm">前 3 项已准备</strong>
                  <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                    代码平台、镜像仓库和测试环境
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-xs text-[var(--success)]">
                查看设置 ›
              </span>
            </button>
          ) : (
            <>
              {!focusCurrentTask || pendingSetupStep === "repository" ? (
                <PreparationStep
                  current={pendingSetupStep === "repository"}
                  description="保存项目代码，并自动发现准备上线的更新"
                  done={repositoryReady}
                  index={1}
                  name="连接代码平台"
                  onOpen={() => setOpenStep("repository")}
                  open={openStep === "repository"}
                >
                  <RepositoryPreparation
                    cnbAuthorizationSource={cnbAuthorizationSource}
                    onCnbAuthorizationOpenChange={onCnbAuthorizationOpenChange}
                    onError={onError}
                    onReady={(next) => {
                      if (next) setRepository(next);
                      if (next && !repositoryReady && openStep === "repository")
                        setOpenStep(
                          registryReady ||
                            readRegistry(workspace.manifestYaml).kind === "cnb"
                            ? testEnvironmentReady
                              ? "remote"
                              : "test-environment"
                            : "registry",
                        );
                      setRepositoryReady(Boolean(next));
                    }}
                    onSaveManifest={onSaveManifest}
                    repository={repository}
                    workspace={workspace}
                  />
                </PreparationStep>
              ) : null}
              {!focusCurrentTask || pendingSetupStep === "registry" ? (
                <PreparationStep
                  checking={registryChecking}
                  current={pendingSetupStep === "registry"}
                  description="保存构建后的不可变镜像，供测试和正式环境选择"
                  done={registryReady}
                  index={2}
                  name="连接镜像仓库"
                  onOpen={() => setOpenStep("registry")}
                  open={openStep === "registry"}
                >
                  {registryChecking ? (
                    <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                      <LoaderCircle className="size-4 animate-spin-slow" />
                      正在确认项目版本保存位置
                    </div>
                  ) : (
                    <RegistryPreparation
                      onError={onError}
                      onReady={(next) => {
                        if (next && !registryReady && openStep === "registry")
                          setOpenStep(
                            !repositoryReady
                              ? "repository"
                              : testEnvironmentReady
                                ? "remote"
                                : "test-environment",
                          );
                        setRegistryReady(next);
                      }}
                      onSaveManifest={onSaveManifest}
                      readyFromParent={registryReady}
                      workspace={workspace}
                    />
                  )}
                </PreparationStep>
              ) : null}
              {!focusCurrentTask || pendingSetupStep === "test-environment" ? (
                <PreparationStep
                  checking={testEnvironmentChecking}
                  current={pendingSetupStep === "test-environment"}
                  description="复用服务器并补齐测试配置"
                  done={displayedTestEnvironmentReady}
                  index={3}
                  name="准备测试环境"
                  onOpen={() => {
                    setTestEnvironmentReviewResolved(false);
                    setOpenStep("test-environment");
                  }}
                  open={openStep === "test-environment"}
                >
                  {!repositoryReady || !registryReady ? (
                    <SetupDependencyNotice
                      message="连接代码平台后，系统会自动准备项目版本，再带你连接测试服务器。"
                      title="先完成前面的项目设置"
                    />
                  ) : testEnvironmentRestoring ? (
                    <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                      <LoaderCircle className="size-4 animate-spin-slow" />
                      正在恢复已保存的测试环境
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <ServerPreparation
                        environment="staging"
                        initialServer={server}
                        onError={onError}
                        onReady={(next) => {
                          setServer(next);
                          onServerChange(next);
                        }}
                        path={path}
                      />
                      {server ? (
                        <div className="border-t border-[var(--border)] pt-4">
                          <RuntimeConfigFields
                            environment="staging"
                            onError={onError}
                            onMarkOptional={(key) =>
                              onSaveManifest(
                                runtimeVariableOptionalManifest(
                                  workspace.manifestYaml,
                                  key,
                                ),
                              )
                            }
                            onReadyChange={handleRuntimeConfigReady}
                            path={path}
                            server={server}
                            secretVariables={workspace.inspection.environment_variables
                              .filter((item) => item.secret)
                              .map((item) => item.name)}
                            verifiedReady={runtimeConfigReady === true}
                          />
                        </div>
                      ) : null}
                      {server && runtimeConfigReady === true ? (
                        <div className="border-t border-[var(--border)] pt-4">
                          <TestAddressPreparation
                            onReadyChange={setAddressReady}
                            onSaveManifest={onSaveManifest}
                            saving={saving}
                            server={server}
                            workspace={workspace}
                          />
                        </div>
                      ) : null}
                    </div>
                  )}
                </PreparationStep>
              ) : null}
            </>
          )}
          {!focusCurrentTask || pendingSetupStep === "remote" ? (
            <PreparationStep
              activeLabel="需要你完成"
              current={pendingSetupStep === "remote"}
              description="代码合并到主分支后，自动生成版本并更新测试版"
              done={cloudConfigReady}
              index={4}
              name="开启自动部署"
              onOpen={() => setOpenStep("remote")}
              open={openStep === "remote"}
            >
              {!repositoryReady ||
              !registryReady ||
              !displayedTestEnvironmentReady ? (
                <SetupDependencyNotice
                  message="系统会依次带你完成代码平台、项目版本和测试环境；准备好后再开启自动部署。"
                  title="先完成前面的上线设置"
                />
              ) : (
                <CnbSecretSetup
                  environment="staging"
                  onError={onError}
                  onProgressChange={onSetupProgressChange}
                  onReadyChange={setCloudConfigReady}
                  onSaveManifest={onSaveManifest}
                  path={path}
                  runtimeReady={runtimeConfigReady === true && registryReady}
                  server={server}
                  workspace={workspace}
                />
              )}
            </PreparationStep>
          ) : null}
        </div>
        <div className="mt-6 flex justify-end border-t border-[var(--border)] pt-5">
          {hasDeploymentHistory ? (
            <Button onClick={() => void finishSetup()}>
              <Check />
              返回发布中心
            </Button>
          ) : ready ? (
            <span className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <LoaderCircle className="size-4 animate-spin-slow" />
              设置完成，正在返回发布中心
            </span>
          ) : (
            <span className="text-sm text-[var(--muted-foreground)]">
              {focusCurrentTask
                ? "完成当前这一项后会自动进入下一项；关闭面板也不会丢失进度"
                : "系统会依次带你完成剩余设置，全部完成后返回发布中心"}
            </span>
          )}
        </div>
      </div>
    );
  }

  const versions = availableVersionRuns(runs);
  const productionVersion = versions.find(
    (run) => versionKey(run) === productionSourceKey,
  );
  // 只有最新一次部署仍未完成时才需要用户继续处理。更早的失败已经被
  // 后续部署替代，继续把它们显示成“需要处理”会让用户误以为项目仍有
  // 十几项故障，尤其是在当前测试版已经正常运行的情况下。
  const sortedDeploymentAttempts = [...deploymentAttempts].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const latestRun = sortedDeploymentAttempts[0];
  const currentIncompleteDeployment =
    latestRun && ["failed", "needs_action"].includes(latestRun.status)
      ? latestRun
      : null;
  const currentProgressDeployment =
    latestRun && ["queued", "running"].includes(latestRun.status)
      ? latestRun
      : null;
  const historicalIncompleteDeployments = sortedDeploymentAttempts.filter(
    (run) =>
      run.status !== "success" &&
      run.id !== currentIncompleteDeployment?.id &&
      run.id !== currentProgressDeployment?.id,
  );
  const detailIsHistorical = Boolean(
    detailRun &&
    detailRun.status !== "success" &&
    detailRun.id !== currentIncompleteDeployment?.id,
  );
  const detailIssue =
    detailRun && detailRun.status !== "success"
      ? issueFromUnknown(
          detailRun.issueCode
            ? `${detailRun.issueCode}：${deploymentStateMessage(detailRun)}`
            : deploymentStateMessage(detailRun),
          "这次部署没有完成",
        )
      : null;

  function catalogRow(
    run: DeploymentRun,
    incompleteKind?: "current" | "historical",
  ) {
    const incomplete = Boolean(incompleteKind);
    const historical = incompleteKind === "historical";
    const verified = verifiedRunIds.includes(run.id);
    const rejected = rejectedVersionKeys.includes(versionKey(run));
    const currentInTest = !incomplete && testSourceKey === versionKey(run);
    const currentInProduction =
      !incomplete && productionSourceKey === versionKey(run);
    const currentProductionWebSavePending =
      !incomplete &&
      !currentInProduction &&
      productionWebSaveSourceKey === versionKey(run);
    const restoring =
      !incomplete &&
      Boolean(productionVersion) &&
      isOlderVersion(run, productionVersion);
    const canPublish =
      !incomplete &&
      verified &&
      !currentInProduction &&
      !currentProductionWebSavePending;
    const canContinueProduction = Boolean(
      currentInProduction && productionRun?.status === "needs_action",
    );
    const rowTitle = incomplete
      ? deploymentAttemptLabel(run)
      : versionTitle(run);
    const rowMeta = run.commitSha ? versionMeta(run) : "尚未生成代码版本";
    const detailAction = historical
      ? "查看记录"
      : incomplete
        ? "查看处理方法"
        : "技术信息";
    const publishAction = restoring ? "用此版本恢复正式版" : "发布正式版";
    const continueProductionAction =
      productionRun?.issueCode === "AD-NET-202"
        ? "重新检查正式地址"
        : productionRun?.actionKind === "route-check"
          ? "继续设置正式地址"
          : productionRun?.actionKind === "route-repair"
            ? "继续修复正式地址"
            : "继续完成正式发布";
    return (
      <div
        className="flex items-center justify-between gap-5 px-5 py-4 max-[760px]:flex-col max-[760px]:items-stretch"
        key={run.id}
      >
        <div className="min-w-0">
          <strong className="block truncate text-sm">
            {incomplete ? deploymentAttemptLabel(run) : versionTitle(run)}
          </strong>
          <span
            className="mt-1 block truncate text-xs text-[var(--muted-foreground)]"
            title={rowMeta}
          >
            {run.commitSha ? versionMeta(run) : "尚未生成代码版本"}
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${historical ? "bg-[var(--muted)] text-[var(--muted-foreground)]" : incomplete || rejected ? "bg-[var(--warning-soft)] text-[var(--warning)]" : verified ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}
            >
              {historical
                ? "已被后续部署替代"
                : incomplete
                  ? deploymentStatus(run)
                  : rejected
                    ? "测试未通过 · 等待代码更新"
                    : verified
                      ? "测试通过"
                      : currentInTest
                        ? "等待确认测试结果"
                        : "未完成测试 · 不可发布"}
            </span>
            {currentInTest ? (
              <span className="rounded-full bg-[var(--info-soft)] px-2 py-0.5 text-[10px] text-[var(--accent)]">
                测试环境当前版本
              </span>
            ) : null}
            {currentInProduction ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] ${productionRun?.status === "success" ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--warning-soft)] text-[var(--warning)]"}`}
              >
                {productionRun?.status === "success"
                  ? "正式版可以访问"
                  : productionRun?.status === "needs_action"
                    ? deploymentNeedsActionStatus(
                        "production",
                        productionRun.actionKind,
                      )
                    : "正式环境运行中"}
              </span>
            ) : null}
            {currentProductionWebSavePending ? (
              <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[10px] text-[var(--warning)]">
                正式版还差网页保存
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            aria-label={`${detailAction}：${rowTitle}，${rowMeta}`}
            onClick={() => setDetailRun(run)}
            size="sm"
            variant="ghost"
          >
            {detailAction}
          </Button>
          {!incomplete && testSourceKey === versionKey(run) && !verified ? (
            <Button
              aria-label={`前往验证：${rowTitle}，${rowMeta}`}
              onClick={onOpenTest}
              size="sm"
            >
              前往验证
            </Button>
          ) : null}
          {canContinueProduction ? (
            <Button
              aria-label={`${continueProductionAction}：${rowTitle}，${rowMeta}`}
              onClick={() => onOpenProduction(run)}
              size="sm"
              variant="secondary"
            >
              {continueProductionAction}
            </Button>
          ) : null}
          {currentProductionWebSavePending ? (
            <Button
              aria-label={`继续网页保存：${rowTitle}，${rowMeta}`}
              onClick={() => onOpenProduction(run)}
              size="sm"
              variant="secondary"
            >
              继续网页保存
            </Button>
          ) : null}
          {canPublish ? (
            <Button
              aria-label={`${publishAction}：${rowTitle}，${rowMeta}`}
              onClick={() => onOpenProduction(run)}
              size="sm"
              variant="secondary"
            >
              {publishAction}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeading
        action={
          <div className="flex flex-col items-end gap-1.5">
            <Button
              disabled={syncing}
              onClick={() => void sync()}
              variant="secondary"
            >
              <RefreshCw className={syncing ? "animate-spin-slow" : ""} />
              {syncing ? "正在刷新版本记录" : "刷新版本记录"}
            </Button>
            {lastSyncedAt ? (
              <span
                aria-live="polite"
                className="text-[11px] text-[var(--muted-foreground)]"
              >
                版本记录已于 {lastSyncedAt} 更新
              </span>
            ) : null}
          </div>
        }
        description="每个版本只生成一次；通过测试后，可以选择部署到正式环境。"
        title="版本"
      />
      <div className="mb-5 flex items-center justify-between rounded-lg border border-[var(--accent)]/20 bg-[var(--info-soft)] px-4 py-3">
        <div>
          <strong className="text-sm">
            {syncBlocker
              ? "项目设置需要更新"
              : runs.length
                ? "测试环境自动更新已开启"
                : "等待首次测试部署"}
          </strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {syncBlocker
              ? "先处理下面的问题，再继续同步版本"
              : runs.length
                ? "代码合并后 → 生成版本 → 更新测试版"
                : "完成项目设置后，主分支更新会自动部署到测试环境"}
          </span>
        </div>
        <Button onClick={onOpenSettings} size="sm" variant="ghost">
          项目设置
        </Button>
      </div>
      {syncBlocker ? (
        <IssueBanner
          action={
            ["AD-CNB-101", "AD-CNB-103"].some((code) =>
              syncBlocker.includes(code),
            ) ? (
              <Button onClick={onOpenSettings} size="sm">
                <KeyRound />
                更新 CNB 授权
              </Button>
            ) : (
              <Button onClick={() => void sync()} size="sm" variant="secondary">
                重新检查
              </Button>
            )
          }
          message={syncIssue?.message ?? syncBlocker}
          technicalCode={syncIssue?.code}
          technicalDetails={syncIssue?.technicalDetails}
          title="暂时无法刷新版本记录"
        />
      ) : null}
      <Section
        title="版本记录"
        trailing={`${versions.length} 个版本 · ${verifiedRunIds.length} 个测试通过`}
      >
        {versions.length ? (
          <div className="-mx-5 -my-4 divide-y divide-[var(--border)]">
            {versions.map((run) => catalogRow(run))}
          </div>
        ) : (
          <div className="py-10 text-center">
            <Tags className="mx-auto size-8 text-[var(--subtle-foreground)]" />
            <strong className="mt-3 block text-sm">正在等待第一个版本</strong>
            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
              把准备上线的代码合并到项目主分支后，新版本会自动出现在这里并更新测试版。
            </span>
          </div>
        )}
      </Section>
      {currentIncompleteDeployment ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-[var(--warning)]/35 bg-[var(--warning-soft)]">
          <div className="flex items-center justify-between gap-5 px-5 py-4">
            <div>
              <strong className="block text-sm">最新一次部署没有完成</strong>
              <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                查看停止原因，然后前往测试版继续处理。
              </span>
            </div>
            <Button
              onClick={() => setDetailRun(currentIncompleteDeployment)}
              size="sm"
            >
              查看处理方法
            </Button>
          </div>
        </div>
      ) : null}
      {currentProgressDeployment ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-[var(--accent)]/20 bg-[var(--info-soft)]">
          <div className="flex items-center justify-between gap-5 px-5 py-4">
            <div>
              <strong className="block text-sm">新版本正在自动部署</strong>
              <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                可以离开当前页面，系统会继续更新进度。
              </span>
            </div>
            <Button onClick={onOpenTest} size="sm" variant="secondary">
              查看部署进度
            </Button>
          </div>
        </div>
      ) : null}
      {historicalIncompleteDeployments.length ? (
        <details
          className="mt-6 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]"
          onToggle={(event) => setIncompleteOpen(event.currentTarget.open)}
          open={incompleteOpen}
        >
          <summary className="cursor-pointer px-5 py-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
            {historicalIncompleteDeployments.length} 条历史部署记录
            <span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">
              已被后续部署替代，无需处理
            </span>
          </summary>
          <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {historicalIncompleteDeployments.map((run) =>
              catalogRow(run, "historical"),
            )}
          </div>
        </details>
      ) : null}
      <Dialog
        onOpenChange={(open) => !open && setDetailRun(null)}
        open={Boolean(detailRun)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {detailRun
                ? detailRun.status === "success"
                  ? versionTitle(detailRun)
                  : deploymentAttemptLabel(detailRun)
                : "版本详情"}
            </DialogTitle>
            <DialogDescription>
              {detailRun?.status === "success"
                ? "这些技术信息用于排查和确认版本，一般不需要处理。"
                : detailIsHistorical
                  ? "这次部署没有完成，但已经被后续部署替代。"
                  : "这里记录当前部署停止的位置和继续方法。"}
            </DialogDescription>
          </DialogHeader>
          {detailRun ? (
            <div className="space-y-3">
              {detailRun.status !== "success" ? (
                detailIsHistorical ? (
                  <div className="rounded-md border border-[var(--success)]/25 bg-[var(--success-soft)] px-4 py-3">
                    <strong className="text-sm">这条记录不需要处理</strong>
                    <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                      后续部署已经接替了这次操作，不会影响当前测试版或正式版。
                    </p>
                  </div>
                ) : (
                  <div className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-3">
                    <strong className="text-sm">{detailIssue?.title}</strong>
                    <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                      {detailIssue?.message}
                    </p>
                    {detailIssue?.nextSteps[0] ? (
                      <p className="mb-0 mt-2 text-xs font-medium">
                        下一步：{detailIssue.nextSteps[0]}
                      </p>
                    ) : null}
                  </div>
                )
              ) : null}
              {detailIsHistorical && detailIssue ? (
                <details className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-xs">
                  <summary className="cursor-pointer font-medium">
                    查看当时停止的原因
                  </summary>
                  <div className="mt-2 space-y-1 text-[var(--muted-foreground)]">
                    <strong className="block text-[var(--foreground)]">
                      {detailIssue.title}
                    </strong>
                    <p className="mb-0 leading-5">{detailIssue.message}</p>
                  </div>
                </details>
              ) : null}
              <div className="grid grid-cols-[88px_1fr] gap-3 text-sm">
                <span className="text-[var(--muted-foreground)]">构建编号</span>
                <span className="text-xs">
                  {detailRun.buildSerial || "未记录"}
                </span>
                <span className="text-[var(--muted-foreground)]">代码提交</span>
                <code className="break-all text-xs">
                  {detailRun.commitSha || "未生成"}
                </code>
                <span className="text-[var(--muted-foreground)]">
                  {detailIsHistorical ? "当时结果" : "测试结果"}
                </span>
                <span>
                  {verifiedRunIds.includes(detailRun.id)
                    ? "业务测试通过"
                    : deploymentStatus(detailRun)}
                </span>
              </div>
              <div className="divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)]">
                {detailRun.artifacts.length ? (
                  detailRun.artifacts.map((artifact) => (
                    <div className="px-3 py-2.5" key={artifact.service}>
                      <strong className="block text-xs">
                        {artifact.service}
                      </strong>
                      <code className="mt-1 block break-all text-[10px] text-[var(--muted-foreground)]">
                        {artifact.image}@{artifact.digest}
                      </code>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-4 text-xs text-[var(--muted-foreground)]">
                    {detailRun.status === "success"
                      ? "版本文件会在测试部署完成后自动核对。"
                      : "这次部署还没有完成版本文件核对。"}
                  </div>
                )}
              </div>
              {detailRun.status !== "success" && detailRun.issueCode ? (
                <details className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-xs">
                  <summary className="cursor-pointer text-[var(--muted-foreground)]">
                    技术详情
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p className="mb-0 text-[var(--muted-foreground)]">
                      错误编号：{detailRun.issueCode}
                    </p>
                    <code className="block max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] text-[var(--muted-foreground)]">
                      {detailRun.message}
                    </code>
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setDetailRun(null)} variant="secondary">
              关闭
            </Button>
            {detailRun &&
            detailRun.status !== "success" &&
            !detailIsHistorical ? (
              <Button
                onClick={() => {
                  setDetailRun(null);
                  onOpenTest();
                }}
              >
                前往部署测试版
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

async function rememberTcrPreference(namespace: string) {
  const reusableNamespace = namespace.trim();
  if (!reusableNamespace) return;
  await Promise.all([
    setAppSetting("registry.mode", "tcr"),
    setAppSetting("registry.tcr.namespace", reusableNamespace),
  ]);
}

function registryVerificationKey(secretPrefix: string) {
  return `${secretPrefix}.verified-endpoint`;
}

function registryCredentialError(error: unknown): UserFacingIssue {
  const issue = issueFromUnknown(error, "这次没有完成登录验证");
  if (issue.code !== "AD-APP-001") return issue;
  return {
    ...issue,
    message: "系统暂时无法读取或验证已保存的登录信息。",
    nextSteps: [
      "关闭可能存在的系统授权提示后重新验证；仍失败时重新填写登录信息",
    ],
    title: "这次没有完成登录验证",
  };
}

function registryCredentialIssue(check: ProviderCheck): UserFacingIssue {
  return issueFromProvider(
    {
      ...check,
      code:
        check.code ?? (check.retryable === false ? "AD-REG-102" : "AD-REG-103"),
    },
    "登录信息还不能使用",
  );
}

function RegistryPreparation({
  onError,
  onReady,
  onSaveManifest,
  readyFromParent,
  workspace,
}: {
  onError: (message: string) => void;
  onReady: (ready: boolean) => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  readyFromParent: boolean;
  workspace: WorkspacePreview;
}) {
  const registry = readRegistry(workspace.manifestYaml);
  const needsCredentials = registry.kind !== "cnb";
  // Fresh app-owned entries avoid stale access control left by old ad-hoc
  // signed test builds in the macOS Keychain.
  const prefix = registry.kind === "tcr" ? "registry.tcr.v2" : "registry.oci";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ready, setReady] = useState(readyFromParent);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [namespace, setNamespace] = useState(() =>
    usableRegistryNamespace(registry.namespace) ? registry.namespace : "",
  );
  const [working, setWorking] = useState(false);
  const [credentialIssue, setCredentialIssue] =
    useState<UserFacingIssue | null>(null);
  const [preferredTcrNamespace, setPreferredTcrNamespace] = useState("");

  useEffect(() => {
    setReady(readyFromParent);
  }, [readyFromParent]);

  useEffect(() => {
    setNamespace(
      usableRegistryNamespace(registry.namespace) ? registry.namespace : "",
    );
  }, [registry.namespace]);

  useEffect(() => {
    if (registry.kind !== "cnb") {
      setPreferredTcrNamespace("");
      return;
    }
    let active = true;
    Promise.all([
      getAppSetting("registry.mode"),
      getAppSetting("registry.tcr.namespace"),
    ])
      .then(([mode, namespace]) => {
        if (!active || mode !== "tcr" || !namespace?.trim()) return;
        setPreferredTcrNamespace(namespace.trim());
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [registry.kind]);

  async function save() {
    if (
      !username.trim() ||
      !password ||
      (registry.kind === "tcr" && !usableRegistryNamespace(namespace))
    )
      return;
    setWorking(true);
    setCredentialIssue(null);
    try {
      const check = await replaceRegistryCredentials(
        registry.endpoint,
        prefix,
        username.trim(),
        password,
      );
      if (!check.ok) {
        setCredentialIssue(registryCredentialIssue(check));
        return;
      }
      if (
        registry.kind === "tcr" &&
        (registry.namespace !== namespace.trim() ||
          !usableRegistryNamespace(registry.namespace)) &&
        !(await onSaveManifest(
          tcrRegistryManifest(workspace.manifestYaml, namespace.trim()),
        ))
      ) {
        setCredentialIssue(
          issueFromUnknown(
            "AD-REG-105：登录信息已经验证，但项目版本保存位置没有保存，请重新尝试",
          ),
        );
        return;
      }
      await setAppSetting(registryVerificationKey(prefix), registry.endpoint);
      if (registry.kind === "tcr") {
        await rememberTcrPreference(namespace.trim());
      }
      setUsername("");
      setPassword("");
      setEditingCredentials(false);
      setReady(true);
      onReady(true);
    } catch (error) {
      const issue = registryCredentialError(error);
      setCredentialIssue(issue);
      onError(issue.message);
    } finally {
      setWorking(false);
    }
  }

  async function authorizeSavedCredentials() {
    if (registry.kind === "tcr" && !usableRegistryNamespace(namespace)) return;
    setWorking(true);
    setCredentialIssue(null);
    try {
      const check = await checkSavedRegistryCredentials(
        registry.endpoint,
        prefix,
      );
      if (!check.ok) {
        if (check.retryable === false) {
          await setAppSetting(registryVerificationKey(prefix), "");
        }
        setCredentialIssue(registryCredentialIssue(check));
        setReady(false);
        onReady(false);
        return;
      }
      if (
        registry.kind === "tcr" &&
        (registry.namespace !== namespace.trim() ||
          !usableRegistryNamespace(registry.namespace)) &&
        !(await onSaveManifest(
          tcrRegistryManifest(workspace.manifestYaml, namespace.trim()),
        ))
      ) {
        setCredentialIssue(
          issueFromUnknown(
            "AD-REG-105：已保存登录信息可以使用，但项目版本保存位置没有保存",
          ),
        );
        return;
      }
      await setAppSetting(registryVerificationKey(prefix), registry.endpoint);
      if (registry.kind === "tcr") {
        await rememberTcrPreference(namespace.trim());
      }
      setReady(true);
      onReady(true);
    } catch (error) {
      const issue = registryCredentialError(error);
      setCredentialIssue(issue);
      onError(issue.message);
    } finally {
      setWorking(false);
    }
  }

  async function usePreferredTcr() {
    if (!preferredTcrNamespace) return;
    setWorking(true);
    setCredentialIssue(null);
    try {
      const check = await checkSavedRegistryCredentials(
        "ccr.ccs.tencentyun.com",
        "registry.tcr.v2",
      );
      if (!check.ok) {
        if (check.retryable === false) {
          await setAppSetting(registryVerificationKey("registry.tcr.v2"), "");
        }
        setCredentialIssue(registryCredentialIssue(check));
        return;
      }
      await setAppSetting(
        registryVerificationKey("registry.tcr.v2"),
        "ccr.ccs.tencentyun.com",
      );
      if (
        await onSaveManifest(
          tcrRegistryManifest(workspace.manifestYaml, preferredTcrNamespace),
        )
      ) {
        setReady(false);
        onReady(false);
      }
    } catch (error) {
      const issue = registryCredentialError(error);
      setCredentialIssue(issue);
      onError(issue.message);
    } finally {
      setWorking(false);
    }
  }

  if (!needsCredentials) {
    return (
      <div className="space-y-3">
        {readyFromParent ? (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="size-4 text-[var(--success)]" />
            <div>
              <strong className="block text-sm">项目版本保存在 CNB</strong>
              <span className="text-xs text-[var(--muted-foreground)]">
                {registry.repository || "跟随代码仓库"}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--muted)]/35 px-3 py-3">
            <Circle className="mt-0.5 size-4 shrink-0 text-[var(--subtle-foreground)]" />
            <div>
              <strong className="block text-sm">跟随代码仓库保存</strong>
              <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
                先完成“连接代码平台”，系统会自动准备项目版本位置，不需要再次填写。
              </span>
            </div>
          </div>
        )}
        {preferredTcrNamespace ? (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--border)] bg-[var(--muted)]/35 px-3 py-2.5">
              <div>
                <strong className="block text-sm">已保存的项目版本位置</strong>
                <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                  腾讯云 TCR · ccr.ccs.tencentyun.com/
                  {preferredTcrNamespace} · 使用前会先检查登录信息
                </span>
              </div>
              <Button
                disabled={working}
                onClick={() => void usePreferredTcr()}
                size="sm"
                variant="secondary"
              >
                {working ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : null}
                {working ? "正在检查" : "检查并使用"}
              </Button>
            </div>
            {credentialIssue ? (
              <IssueBanner
                message={`${credentialIssue.message} 原来的项目版本保存位置没有改变。`}
                nextStep={credentialIssue.nextSteps[0]}
                technicalCode={credentialIssue.code}
                technicalDetails={credentialIssue.technicalDetails}
                title={credentialIssue.title}
              />
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <strong className="block text-sm">项目版本保存位置</strong>
        <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
          {registry.kind === "tcr" ? "腾讯云 TCR · " : null}
          {registry.endpoint}/
          {usableRegistryNamespace(namespace) ? namespace : "尚未选择命名空间"}
        </span>
      </div>
      {ready && !editingCredentials ? (
        <div className="flex items-center justify-between gap-4 rounded-md bg-[var(--success-soft)] px-3 py-2.5">
          <span className="text-sm text-[var(--success)]">
            登录信息已安全保存
            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
              再次使用时如果已经失效，系统会在当前步骤提示更新
            </span>
          </span>
          <Button
            onClick={() => {
              setCredentialIssue(null);
              setEditingCredentials(true);
            }}
            size="sm"
            variant="ghost"
          >
            更换登录信息
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {ready && editingCredentials ? (
            <div className="rounded-md bg-[var(--info-soft)] px-3 py-2.5 text-xs leading-5 text-[var(--muted-foreground)]">
              当前登录信息仍然有效；只有新信息验证并完整保存后才会替换。
            </div>
          ) : null}
          {registry.kind === "tcr" ? (
            <div className="space-y-1.5">
              <Label htmlFor="registry-namespace">TCR 命名空间</Label>
              <Input
                id="registry-namespace"
                onChange={(event) => {
                  setNamespace(event.target.value.trim().toLowerCase());
                  setCredentialIssue(null);
                }}
                placeholder="例如 finagent"
                value={namespace}
              />
              <span className="block text-[11px] leading-4 text-[var(--muted-foreground)]">
                在腾讯云容器镜像服务的“命名空间”中查看或创建；同一账号下的项目可以复用。
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-md bg-[var(--muted)]/35 px-3 py-2.5">
            <span className="text-xs text-[var(--muted-foreground)]">
              以前保存过登录信息？验证通过后可以直接复用。
            </span>
            <Button
              disabled={
                working ||
                (registry.kind === "tcr" && !usableRegistryNamespace(namespace))
              }
              onClick={() => void authorizeSavedCredentials()}
              size="sm"
              variant="secondary"
            >
              {working ? <LoaderCircle className="animate-spin-slow" /> : null}
              验证已保存登录信息
            </Button>
          </div>
          {registry.kind === "tcr" ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--muted)]/35 px-3 py-2.5">
              <span className="text-xs leading-5 text-[var(--muted-foreground)]">
                还没有登录信息？个人版初始化密码，企业版创建长期访问凭证。
              </span>
              <Button
                onClick={() =>
                  void openUrl("https://console.cloud.tencent.com/tcr")
                }
                size="sm"
                variant="secondary"
              >
                <ExternalLink />
                前往腾讯云获取凭据
              </Button>
            </div>
          ) : null}
          {credentialIssue ? (
            <IssueBanner
              message={`${credentialIssue.message} 未通过验证的信息不会保存，也不会标记为已准备。`}
              nextStep={credentialIssue.nextSteps[0]}
              technicalCode={credentialIssue.code}
              technicalDetails={credentialIssue.technicalDetails}
              title={credentialIssue.title}
            />
          ) : null}
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="registry-username">登录用户名</Label>
              <Input
                id="registry-username"
                onChange={(event) => {
                  setUsername(event.target.value);
                  setCredentialIssue(null);
                }}
                value={username}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="registry-password">访问密码</Label>
              <Input
                id="registry-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setCredentialIssue(null);
                }}
                type="password"
                value={password}
              />
            </div>
            <Button
              className="w-full md:w-auto"
              disabled={
                working ||
                !username.trim() ||
                !password ||
                (registry.kind === "tcr" && !usableRegistryNamespace(namespace))
              }
              onClick={() => void save()}
            >
              {working ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <KeyRound />
              )}
              {working ? "正在验证" : "验证并安全保存"}
            </Button>
          </div>
          {ready && editingCredentials ? (
            <div className="flex justify-end">
              <Button
                disabled={working}
                onClick={() => {
                  setCredentialIssue(null);
                  setEditingCredentials(false);
                  setUsername("");
                  setPassword("");
                  setNamespace(registry.namespace);
                }}
                size="sm"
                variant="ghost"
              >
                取消更换
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TestScene({
  blockingProductionRun,
  cnbAuthorizationSource,
  initialCnbAuthorizationOpen = false,
  initialServer,
  initialStartRequested,
  onDeploy,
  onCnbAuthorizationOpenChange,
  onError,
  onOpenProduction,
  onOpenSetup,
  onRefresh,
  onReject,
  onVerify,
  onStartHandled,
  path,
  productionRun,
  productionWebSaveVersionKey,
  rejected,
  run,
  setupComplete,
  verified,
  workspace,
}: {
  blockingProductionRun?: DeploymentRun;
  cnbAuthorizationSource: string;
  initialCnbAuthorizationOpen?: boolean;
  initialServer?: ServerForm;
  initialStartRequested: boolean;
  onDeploy: (
    server: ServerForm,
    repository: string,
    useCommittedCode?: boolean,
  ) => Promise<void>;
  onCnbAuthorizationOpenChange: CnbAuthorizationOpenReporter;
  onError: (message: string) => void;
  onOpenProduction: () => void;
  onOpenSetup: () => void;
  onRefresh: (run: DeploymentRun) => Promise<DeploymentRun>;
  onReject: (run: DeploymentRun) => Promise<void>;
  onVerify: (run: DeploymentRun) => Promise<void>;
  onStartHandled: () => void;
  path: string;
  productionRun?: DeploymentRun;
  productionWebSaveVersionKey: string;
  rejected: boolean;
  run?: DeploymentRun;
  setupComplete: boolean | null;
  verified: boolean;
  workspace: WorkspacePreview;
}) {
  const repository = readRepository(workspace.manifestYaml);
  const setupServer = setupComplete ? initialServer : undefined;
  const { addressReady, cloudConfigReady, runtimeConfigReady } =
    useStagingPreparationStatus(path, setupServer, workspace);
  const [deploying, setDeploying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [deploymentBlocker, setDeploymentBlocker] = useState("");
  const [showPreparation, setShowPreparation] = useState(!run);
  const [cnbAuthorizationDialog, setCnbAuthorizationDialog] = useState(
    initialCnbAuthorizationOpen,
  );
  const [cnbToken, setCnbToken] = useState("");
  const [authorizingCnb, setAuthorizingCnb] = useState(false);
  const [cnbAuthorizationFeedback, setCnbAuthorizationFeedback] =
    useState<CnbAuthorizationFeedback | null>(null);
  useCnbAuthorizationDialogVisibility(
    cnbAuthorizationDialog,
    cnbAuthorizationSource,
    onCnbAuthorizationOpenChange,
  );
  const [openedVersionKey, setOpenedVersionKey] = useState("");
  const automaticStartAttempted = useRef(false);
  const deploymentStartInFlight = useRef(false);

  const checkingSetup =
    setupComplete === null ||
    (setupComplete && Boolean(initialServer) && runtimeConfigReady === null);
  const ready = Boolean(
    setupComplete &&
    usableRepository(repository) &&
    initialServer &&
    runtimeConfigReady === true &&
    cloudConfigReady &&
    addressReady,
  );
  const address = testAddress(workspace, initialServer);
  const productionWebSavePending = Boolean(productionWebSaveVersionKey);
  const productionWebSaveForCurrentVersion = Boolean(
    run && productionWebSaveVersionKey === versionKey(run),
  );
  const productionTaskPending = Boolean(
    productionWebSavePending ||
    (productionRun && productionRun.status !== "success") ||
    blockingProductionRun,
  );

  async function deploy(useCommittedCode = false) {
    if (!ready || !initialServer || deploymentStartInFlight.current) return;
    deploymentStartInFlight.current = true;
    if (initialStartRequested && !automaticStartAttempted.current) {
      automaticStartAttempted.current = true;
      onStartHandled();
    }
    setDeploying(true);
    setDeploymentBlocker("");
    try {
      await onDeploy(initialServer, repository, useCommittedCode);
      setShowPreparation(false);
    } catch (error) {
      setDeploymentBlocker(toMessage(error));
    } finally {
      deploymentStartInFlight.current = false;
      setDeploying(false);
    }
  }

  useEffect(() => {
    if (
      !initialStartRequested ||
      automaticStartAttempted.current ||
      run ||
      !ready
    )
      return;
    void deploy();
  }, [initialStartRequested, onStartHandled, ready, run]);

  async function openSecurePreview(currentRun: DeploymentRun) {
    setPreviewing(true);
    try {
      const preview = await openStagingPreviewTunnel(currentRun.id);
      setPreviewUrl(preview.url);
      await openUrl(preview.url);
      setOpenedVersionKey(versionKey(currentRun));
      await onRefresh(currentRun);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function openTestAddress(currentRun: DeploymentRun, url: string) {
    try {
      await openUrl(url);
      setOpenedVersionKey(versionKey(currentRun));
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function authorizeCnbAndContinue(currentRun: DeploymentRun) {
    if (!cnbToken.trim()) return;
    setAuthorizingCnb(true);
    setCnbAuthorizationFeedback(null);
    try {
      try {
        await connectCnb(cnbToken, true, currentRun.repository);
      } catch (error) {
        setCnbAuthorizationFeedback({
          message: cnbAuthorizationFeedbackMessage(error),
          title: "新令牌未保存，当前任务仍使用原授权",
          tone: "error",
        });
        return;
      }
      setCnbToken("");
      let refreshed: DeploymentRun;
      try {
        refreshed = await onRefresh(currentRun);
      } catch (error) {
        setCnbAuthorizationFeedback({
          message: `${cnbAuthorizationFeedbackMessage(error)}。稍后可以直接重新检查当前任务。`,
          title: "新令牌已保存，但这次状态检查没有完成",
          tone: "warning",
        });
        return;
      }
      if (stillNeedsCnbAuthorization(refreshed)) {
        setCnbAuthorizationFeedback({
          message: `请同时检查授权范围和使用范围；使用范围必须包含 ${currentRun.repository} 或全部仓库。`,
          title: "新令牌已保存，但 CNB 仍拒绝读取当前仓库",
          tone: "warning",
        });
        return;
      }
      setCnbAuthorizationFeedback(null);
      setCnbAuthorizationDialog(false);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setAuthorizingCnb(false);
    }
  }

  if (run && !showPreparation) {
    const usesSecurePreview = run.actionKind === "local-preview";
    const displayAddress = previewUrl || (usesSecurePreview ? "" : address);
    const testOpened =
      verified || openedVersionKey === versionKey(run) || Boolean(previewUrl);
    return (
      <div>
        <PageHeading
          action={
            run.status === "success" && !productionTaskPending ? (
              <Button
                onClick={() => setShowPreparation(true)}
                variant="secondary"
              >
                <Rocket />
                手动部署测试版
              </Button>
            ) : undefined
          }
          description={
            run.status === "success"
              ? verified
                ? "测试结果已保存，不会因为关闭应用而丢失。"
                : usesSecurePreview
                  ? "测试版仍在服务器运行，可以从这台电脑直接打开确认。"
                  : "打开测试地址，确认主要功能是否符合预期。"
              : "部署状态会自动保存，可以关闭应用后再回来。"
          }
          title={
            run.status === "success"
              ? verified
                ? "测试版已通过验证"
                : "验证测试版"
              : deploymentTitle(run)
          }
        />
        <CurrentVersionBanner label="当前测试版本" run={run} />
        <DeploymentState
          action={
            run.status === "needs_action" &&
            ["AD-CNB-101", "AD-CNB-103"].includes(run.issueCode ?? "") ? (
              <Button onClick={() => setCnbAuthorizationDialog(true)} size="sm">
                <KeyRound />
                更新 CNB 授权
              </Button>
            ) : run.status === "needs_action" &&
              run.issueCode === "AD-CNB-202" ? (
              <Button onClick={() => setShowPreparation(true)} size="sm">
                <Rocket />
                重新部署当前代码
              </Button>
            ) : run.status === "needs_action" &&
              run.actionKind === "retry-staging-preparation" ? (
              <Button onClick={() => setShowPreparation(true)} size="sm">
                <Rocket />
                继续当前部署
              </Button>
            ) : run.status === "needs_action" &&
              ["cloud-config", "cloud-setup"].includes(run.actionKind ?? "") ? (
              <Button onClick={onOpenSetup} size="sm">
                <Tags />
                继续完成上线设置
              </Button>
            ) : run.status === "needs_action" &&
              run.environment === "staging" &&
              run.actionKind === "route-check" ? (
              <Button
                disabled={previewing}
                onClick={() => void openSecurePreview(run)}
                size="sm"
              >
                {previewing ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <ExternalLink />
                )}
                打开测试版
              </Button>
            ) : undefined
          }
          messageOverride={
            run.status === "success" && verified
              ? "测试版正在服务器运行"
              : undefined
          }
          onError={onError}
          pauseAutoRecheck={cnbAuthorizationDialog}
          run={run}
          onRefresh={onRefresh}
        />
        {run.status === "success" && displayAddress.startsWith("http") ? (
          <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
            <a
              className="text-lg font-semibold text-[var(--accent)]"
              href={displayAddress}
              onClick={(event) => {
                event.preventDefault();
                void openTestAddress(run, displayAddress);
              }}
            >
              {displayAddress}
            </a>
            <div className="mt-4">
              <Button
                onClick={() => void openTestAddress(run, displayAddress)}
                variant="secondary"
              >
                <ExternalLink />
                打开测试版
              </Button>
            </div>
            <TestVerificationPrompt
              canVerify={testOpened}
              onReject={() => void onReject(run)}
              onOpenProduction={onOpenProduction}
              onVerify={() => void onVerify(run)}
              blockingProductionRun={blockingProductionRun}
              productionRun={productionRun}
              productionWebSaveForCurrentVersion={
                productionWebSaveForCurrentVersion
              }
              productionWebSavePending={productionWebSavePending}
              rejected={rejected}
              verified={verified}
            />
          </div>
        ) : run.status === "success" && usesSecurePreview ? (
          <div className="mt-5">
            <IssueBanner
              action={
                <Button
                  disabled={previewing}
                  onClick={() => void openSecurePreview(run)}
                  size="sm"
                  variant={verified ? "secondary" : "default"}
                >
                  {previewing ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : (
                    <ExternalLink />
                  )}
                  重新打开测试版
                </Button>
              }
              message="只会重新打开测试地址，不会重新部署项目。"
              title={verified ? "复查测试版" : "下一步：重新打开测试版"}
            />
            {verified ? (
              <TestVerificationPrompt
                canVerify={testOpened}
                onReject={() => void onReject(run)}
                onOpenProduction={onOpenProduction}
                onVerify={() => void onVerify(run)}
                blockingProductionRun={blockingProductionRun}
                productionRun={productionRun}
                productionWebSaveForCurrentVersion={
                  productionWebSaveForCurrentVersion
                }
                productionWebSavePending={productionWebSavePending}
                rejected={rejected}
                verified
              />
            ) : previewUrl ? (
              <TestVerificationPrompt
                canVerify={testOpened}
                onReject={() => void onReject(run)}
                onOpenProduction={onOpenProduction}
                onVerify={() => void onVerify(run)}
                blockingProductionRun={blockingProductionRun}
                productionRun={productionRun}
                productionWebSaveForCurrentVersion={
                  productionWebSaveForCurrentVersion
                }
                productionWebSavePending={productionWebSavePending}
                rejected={rejected}
                verified={false}
              />
            ) : (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
                <strong className="text-sm">还差一次业务确认</strong>
                <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                  先重新打开测试版，确认主要功能符合预期后，才能标记测试通过。
                </p>
              </div>
            )}
          </div>
        ) : run.status === "success" ? (
          <div className="mt-5">
            <IssueBanner
              action={
                <Button
                  onClick={() => setShowPreparation(true)}
                  size="sm"
                  variant="secondary"
                >
                  检查运行服务器
                </Button>
              }
              message="部署已经完成，但当前项目的测试服务器信息没有恢复，暂时无法生成可点击地址。"
              title="还不能打开测试地址"
            />
            {verified ? (
              <TestVerificationPrompt
                canVerify={testOpened}
                onReject={() => void onReject(run)}
                onOpenProduction={onOpenProduction}
                onVerify={() => void onVerify(run)}
                blockingProductionRun={blockingProductionRun}
                productionRun={productionRun}
                productionWebSaveForCurrentVersion={
                  productionWebSaveForCurrentVersion
                }
                productionWebSavePending={productionWebSavePending}
                rejected={rejected}
                verified
              />
            ) : null}
          </div>
        ) : run.status === "failed" ? (
          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => setShowPreparation(true)}
              variant="secondary"
            >
              检查后重新部署
            </Button>
          </div>
        ) : null}
        <CnbAuthorizationDialog
          description="保存新授权后会继续检查这次测试部署，已经生成并启动的版本不会重做。"
          feedback={cnbAuthorizationFeedback}
          fieldId="test-cnb-token"
          onOpenChange={(open) => {
            setCnbAuthorizationDialog(open);
            if (!open) setCnbAuthorizationFeedback(null);
          }}
          onSubmit={() => void authorizeCnbAndContinue(run)}
          onTokenChange={(value) => {
            setCnbToken(value);
            setCnbAuthorizationFeedback(null);
          }}
          open={cnbAuthorizationDialog}
          repository={run.repository}
          submitLabel="保存授权并继续"
          title="更新 CNB 授权"
          token={cnbToken}
          working={authorizingCnb}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeading
        description={
          setupComplete
            ? "使用已经保存的上线设置，不需要重新填写服务器、配置或地址。"
            : "一次性设置统一在“项目设置”完成，这里不重复要求填写。"
        }
        title={run ? "手动部署测试版" : "部署测试版"}
      />
      {deploymentBlocker ? (
        <DeploymentBlockerBanner
          deploying={deploying}
          message={deploymentBlocker}
          onDeployCommitted={() => void deploy(true)}
          onOpenSetup={onOpenSetup}
          onRetry={() => void deploy()}
        />
      ) : null}
      {checkingSetup ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="size-4 animate-spin-slow" />
          正在确认已保存的上线设置
        </div>
      ) : !setupComplete ? (
        <IssueBanner
          action={
            <Button onClick={onOpenSetup} size="sm">
              <Tags />
              继续完成设置
            </Button>
          }
          message="系统会直接打开当前还没完成的一项；全部完成后会自动进入测试版。"
          title="上线设置还没有完成"
        />
      ) : !ready ? (
        <IssueBanner
          action={
            <Button onClick={onOpenSetup} size="sm" variant="secondary">
              检查上线设置
            </Button>
          }
          message="已保存的服务器、测试配置或地址发生了变化。检查后可以从这里继续，不需要重新生成已经完成的版本。"
          title="上线设置需要检查"
        />
      ) : !deploymentBlocker ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-start justify-between gap-5">
            <div className="flex min-w-0 gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[var(--success)]" />
              <div>
                <strong className="block text-sm font-semibold">
                  上线设置已准备
                </strong>
                <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                  以后把准备上线的代码合并到项目主分支，系统会自动生成版本并更新测试版；现在也可以立即部署当前代码。
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={onOpenSetup} size="sm" variant="ghost">
                查看上线设置
              </Button>
              <Button
                disabled={deploying}
                onClick={() => void deploy()}
                size="sm"
              >
                {deploying ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <Rocket />
                )}
                {deploying ? "正在开始部署" : "立即部署测试版"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TestVerificationPrompt({
  blockingProductionRun,
  canVerify,
  onOpenProduction,
  onReject,
  onVerify,
  productionRun,
  productionWebSaveForCurrentVersion,
  productionWebSavePending,
  rejected,
  verified,
}: {
  blockingProductionRun?: DeploymentRun;
  canVerify: boolean;
  onOpenProduction: () => void;
  onReject: () => void;
  onVerify: () => void;
  productionRun?: DeploymentRun;
  productionWebSaveForCurrentVersion: boolean;
  productionWebSavePending: boolean;
  rejected: boolean;
  verified: boolean;
}) {
  if (verified) {
    const productionComplete = productionRun?.status === "success";
    const activeProductionRun =
      productionRun && !productionComplete
        ? productionRun
        : blockingProductionRun;
    const activeProductionForCurrentVersion =
      activeProductionRun === productionRun;
    const productionWebSaveNeedsAction = Boolean(
      !productionRun && !blockingProductionRun && productionWebSavePending,
    );
    let activeProductionAction = "继续完成正式发布";
    let activeProductionTitle = activeProductionForCurrentVersion
      ? "正式发布还需要处理"
      : "另一个版本的正式发布需要处理";
    let activeProductionMessage = activeProductionForCurrentVersion
      ? "这个测试通过的版本已经开始正式发布；打开后会回到保留的步骤。"
      : "另一个测试通过的版本正在正式发布；先完成那次任务，再决定是否发布当前版本。";
    if (activeProductionRun?.status === "failed") {
      activeProductionAction = "查看处理方法";
      activeProductionTitle = activeProductionForCurrentVersion
        ? "正式发布没有完成"
        : "另一个版本发布没有完成";
      activeProductionMessage = activeProductionForCurrentVersion
        ? "这次正式发布没有完成；打开后可以查看已经保留的原因和处理方法。"
        : "另一个测试通过的版本发布没有完成；先处理那次发布，再决定是否发布当前版本。";
    } else if (
      activeProductionRun?.status === "queued" ||
      activeProductionRun?.status === "running"
    ) {
      activeProductionAction = "查看正式发布进度";
      activeProductionTitle = activeProductionForCurrentVersion
        ? "正式版正在发布"
        : "另一个版本正在发布";
      activeProductionMessage = activeProductionForCurrentVersion
        ? "系统正在发布这个测试通过的版本；可以打开查看当前进度。"
        : "系统正在发布另一个测试通过的版本；先等待那次任务完成，再决定是否发布当前版本。";
    } else if (activeProductionRun?.actionKind === "route-check") {
      const checkInterrupted = activeProductionRun.issueCode === "AD-NET-202";
      activeProductionAction = checkInterrupted
        ? "重新检查正式地址"
        : "继续设置正式地址";
      activeProductionTitle = checkInterrupted
        ? activeProductionForCurrentVersion
          ? "正式地址检查暂时中断"
          : "另一个版本的地址检查暂时中断"
        : activeProductionForCurrentVersion
          ? "正式版还差设置地址"
          : "另一个版本还差设置正式地址";
      activeProductionMessage = checkInterrupted
        ? "版本已经在正式服务器运行；确认本机网络后重新检查即可，不会重复部署。"
        : activeProductionForCurrentVersion
          ? "这个测试通过的版本已经在正式服务器运行，但正式地址还不能访问；继续完成地址设置即可。"
          : "另一个测试通过的版本已经在正式服务器运行，但正式地址还不能访问；先完成那次地址设置，再决定是否发布当前版本。";
    } else if (activeProductionRun?.actionKind === "route-repair") {
      activeProductionAction = "继续修复正式地址";
      activeProductionTitle = activeProductionForCurrentVersion
        ? "正式版还差修复地址"
        : "另一个版本还差修复正式地址";
      activeProductionMessage = activeProductionForCurrentVersion
        ? "这个测试通过的版本已经在正式服务器运行，但正式地址需要修复；打开后会回到原任务。"
        : "另一个测试通过的版本已经在正式服务器运行，但正式地址需要修复；先完成那次任务，再决定是否发布当前版本。";
    }
    return (
      <SuccessBanner
        action={
          productionComplete ? undefined : (
            <Button onClick={onOpenProduction} size="sm">
              {productionWebSaveNeedsAction ? (
                <ExternalLink />
              ) : activeProductionRun?.status === "failed" ? (
                <AlertCircle />
              ) : (
                <Rocket />
              )}
              {productionWebSaveNeedsAction
                ? "继续网页保存"
                : activeProductionRun
                  ? activeProductionAction
                  : "准备发布正式版"}
            </Button>
          )
        }
        message={
          productionComplete
            ? "正式环境正在使用这个版本，正式地址可以访问。"
            : productionWebSaveNeedsAction
              ? productionWebSaveForCurrentVersion
                ? "这个测试通过的版本已经开始准备正式版；完成网页保存后会继续原任务，不会重新构建。"
                : "另一个测试通过的版本正在准备正式版；先完成那次网页保存，再决定是否发布当前版本。"
              : activeProductionRun
                ? activeProductionMessage
                : "发布时会继续使用这个测试版本，不会重新构建。"
        }
        title={
          productionComplete
            ? "当前版本已完成正式发布"
            : productionWebSaveNeedsAction
              ? productionWebSaveForCurrentVersion
                ? "正式版还差网页保存"
                : "已有正式发布等待网页保存"
              : activeProductionRun
                ? activeProductionTitle
                : "下一步：准备正式版"
        }
      />
    );
  }
  if (rejected) {
    return (
      <div className="mt-7 border-t border-[var(--border)] pt-6 text-center">
        <h2 className="m-0 text-base font-semibold">这个版本暂不发布</h2>
        <p className="mb-0 mt-2 text-sm text-[var(--muted-foreground)]">
          测试结果已记录为有问题。修改代码并更新主分支后，系统会生成一个新版本；当前正式版不受影响。
        </p>
      </div>
    );
  }
  return (
    <div className="mt-7 border-t border-[var(--border)] pt-6 text-center">
      <h2 className="m-0 text-base font-semibold">测试结果符合你的预期吗？</h2>
      <p className="mb-5 mt-2 text-sm text-[var(--muted-foreground)]">
        {canVerify
          ? "只记录这次测试结论，不会自动发布正式版。"
          : "请先打开测试版，确认主要功能后再记录结果。"}
      </p>
      <div className="flex justify-center gap-2">
        <Button disabled={!canVerify} onClick={onReject} variant="secondary">
          测试有问题
        </Button>
        <Button disabled={!canVerify} onClick={onVerify}>
          <Check />
          确认测试通过
        </Button>
      </div>
    </div>
  );
}

function ProductionScene({
  cnbAuthorizationSource,
  currentProductionVersion,
  currentTestVersion,
  initialCnbAuthorizationOpen = false,
  initialWebSavePending,
  initialServer: savedServer,
  onError,
  onCnbAuthorizationOpenChange,
  onPromote,
  onProgressChange,
  onRefresh,
  onSaveManifest,
  onServerChange,
  onSelectVersion,
  onShowSettings,
  onShowVersions,
  onShowTest,
  path,
  production,
  productionVersion,
  saving,
  setupComplete,
  verifiedRun,
  verifiedRuns,
  workspace,
}: {
  cnbAuthorizationSource: string;
  currentProductionVersion?: DeploymentRun;
  currentTestVersion?: DeploymentRun;
  initialCnbAuthorizationOpen?: boolean;
  initialWebSavePending: boolean;
  initialServer?: ServerForm;
  onError: (message: string) => void;
  onCnbAuthorizationOpenChange: CnbAuthorizationOpenReporter;
  onPromote: (run: DeploymentRun, server: ServerForm) => Promise<void>;
  onProgressChange?: () => void;
  onRefresh: (run: DeploymentRun) => Promise<DeploymentRun>;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  onServerChange: (server: ServerForm) => void;
  onSelectVersion: (runId: string) => void;
  onShowSettings: () => void;
  onShowVersions: () => void;
  onShowTest: () => void;
  path: string;
  production?: DeploymentRun;
  productionVersion?: DeploymentRun;
  saving: boolean;
  setupComplete: boolean;
  verifiedRun?: DeploymentRun;
  verifiedRuns: DeploymentRun[];
  workspace: WorkspacePreview;
}) {
  const [initialServer, setInitialServer] = useState(savedServer);
  useEffect(() => setInitialServer(savedServer), [savedServer]);
  const restoreWebSaveSnapshot = Boolean(
    initialServer && initialWebSavePending,
  );
  const runtimeReadyKey = initialServer
    ? runtimeConfigReadyCacheKey(path, "production", initialServer)
    : "";
  const [runtimeConfigReady, setRuntimeConfigReady] = useState<boolean | null>(
    restoreWebSaveSnapshot ? true : null,
  );
  const [runtimeConfigChecking, setRuntimeConfigChecking] = useState(
    Boolean(initialServer) && !restoreWebSaveSnapshot,
  );
  const [runtimeReadyCacheLoaded, setRuntimeReadyCacheLoaded] = useState(
    !initialServer || restoreWebSaveSnapshot,
  );
  const [runtimeConfigVerifiedReady, setRuntimeConfigVerifiedReady] = useState(
    restoreWebSaveSnapshot,
  );
  const [cloudConfigReady, setCloudConfigReady] = useState<boolean | null>(
    restoreWebSaveSnapshot ? false : null,
  );
  const [domainReady, setDomainReady] = useState(
    productionDomainsReady(workspace),
  );
  const [publishing, setPublishing] = useState(false);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [editingDomains, setEditingDomains] = useState(false);
  const [selectingVersion, setSelectingVersion] = useState(false);
  const [dnsTargetCopied, setDnsTargetCopied] = useState(false);
  const [dnsProviders, setDnsProviders] = useState<DnsProviderHint[]>([]);
  const [dnsProviderChecking, setDnsProviderChecking] = useState(false);
  const [publicRouteStatuses, setPublicRouteStatuses] = useState<
    PublicRouteStatus[]
  >(production?.routeChecks ?? []);
  const [retryingCertificates, setRetryingCertificates] = useState(false);
  const [cnbAuthorizationDialog, setCnbAuthorizationDialog] = useState(
    initialCnbAuthorizationOpen,
  );
  const [cnbToken, setCnbToken] = useState("");
  const [authorizingCnb, setAuthorizingCnb] = useState(false);
  const [cnbAuthorizationFeedback, setCnbAuthorizationFeedback] =
    useState<CnbAuthorizationFeedback | null>(null);
  useCnbAuthorizationDialogVisibility(
    cnbAuthorizationDialog,
    cnbAuthorizationSource,
    onCnbAuthorizationOpenChange,
  );
  const [routeCheck, setRouteCheck] = useState<RouteConflictCheck | null>(null);
  const [checkingRoutes, setCheckingRoutes] = useState(false);
  const [takeoverDialog, setTakeoverDialog] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [reapplyingRoutes, setReapplyingRoutes] = useState(false);
  const [checkingProduction, setCheckingProduction] = useState(false);
  const [productionCheckedAt, setProductionCheckedAt] = useState("");
  const [productionCheckFailed, setProductionCheckFailed] = useState(false);
  const [productionCheckLoaded, setProductionCheckLoaded] = useState(false);
  const [
    productionCheckCompletedThisSession,
    setProductionCheckCompletedThisSession,
  ] = useState(false);
  const cloudConfigPendingKey = `project.${encodeURIComponent(path)}.cnb-secret-pending.production`;
  const productionHealthCheckKey = production?.id
    ? `project.${encodeURIComponent(path)}.production-health-check.${production.id}`
    : "";
  const productionSecretReferenceReady = secretReferenceReady(
    workspace,
    "production",
  );
  async function copyDnsTarget() {
    if (!initialServer?.host) return;
    try {
      await copyText(initialServer.host);
      setDnsTargetCopied(true);
    } catch (error) {
      onError(toMessage(error));
    }
  }
  useEffect(() => setDnsTargetCopied(false), [initialServer?.host]);
  useEffect(() => {
    let active = true;
    setProductionCheckedAt("");
    setProductionCheckFailed(false);
    setProductionCheckCompletedThisSession(false);
    setProductionCheckLoaded(!productionHealthCheckKey);
    if (productionHealthCheckKey) {
      void getAppSetting(productionHealthCheckKey)
        .then((value) => {
          if (active && value && !Number.isNaN(new Date(value).getTime())) {
            setProductionCheckedAt(value);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) setProductionCheckLoaded(true);
        });
    }
    return () => {
      active = false;
    };
  }, [productionHealthCheckKey]);
  useEffect(() => {
    let active = true;
    if (!initialServer || !runtimeReadyKey) {
      setRuntimeConfigReady(null);
      setRuntimeConfigChecking(false);
      setRuntimeConfigVerifiedReady(false);
      setRuntimeReadyCacheLoaded(true);
      return () => {
        active = false;
      };
    }
    if (restoreWebSaveSnapshot) {
      // Reopening an interrupted web handoff must immediately show the exact
      // saved next step. Rechecking the runtime file here would temporarily
      // replace it with a generic checking page even though reaching this
      // checkpoint already proved that the server-side configuration exists.
      setRuntimeConfigReady(true);
      setRuntimeConfigChecking(false);
      setRuntimeConfigVerifiedReady(true);
      setRuntimeReadyCacheLoaded(true);
      return () => {
        active = false;
      };
    }
    setRuntimeConfigReady(null);
    setRuntimeConfigChecking(true);
    setRuntimeConfigVerifiedReady(false);
    setRuntimeReadyCacheLoaded(false);
    // `RuntimeConfigFields` owns the real file and server check. This layer only
    // restores a previous success while that single check runs; duplicating the
    // same API/SSH work here caused a fast `false` result to overwrite the
    // child's still-running check and briefly render the wrong next step.
    void getAppSetting(runtimeReadyKey)
      .then((cached) => {
        if (!active) return;
        const previouslyVerified = cached === "true";
        setRuntimeConfigVerifiedReady(previouslyVerified);
        if (previouslyVerified) setRuntimeConfigReady(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setRuntimeReadyCacheLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [initialServer, path, restoreWebSaveSnapshot, runtimeReadyKey]);
  useEffect(() => {
    let active = true;
    if (restoreWebSaveSnapshot) {
      setCloudConfigReady(false);
      return () => {
        active = false;
      };
    }
    setCloudConfigReady(null);
    if (!productionSecretReferenceReady) {
      setCloudConfigReady(false);
      return () => {
        active = false;
      };
    }
    void getAppSetting(cloudConfigPendingKey)
      .then((pending) => {
        if (active) setCloudConfigReady(pending !== "true");
      })
      .catch(() => {
        if (active) setCloudConfigReady(false);
      });
    return () => {
      active = false;
    };
  }, [
    cloudConfigPendingKey,
    productionSecretReferenceReady,
    restoreWebSaveSnapshot,
  ]);
  const handleRuntimeConfigReady = useCallback(
    (next: boolean, checking: boolean) => {
      setRuntimeConfigChecking(checking);
      if (checking) return;
      setRuntimeConfigReady(next);
      setRuntimeConfigVerifiedReady(next);
      if (runtimeReadyKey)
        void setAppSetting(runtimeReadyKey, String(next)).catch(
          () => undefined,
        );
    },
    [runtimeReadyKey],
  );
  // 服务器尚未恢复，或刚从另一个服务器切换过来时，不能沿用上一轮
  // `false` 先渲染“需要保存”。组件会按服务器身份重新挂载，此处只在
  // 当前服务器存在时采用它自己的核对结果。
  const visibleRuntimeConfigReady = initialServer ? runtimeConfigReady : null;
  const productionConfigChecking =
    !initialServer ||
    !runtimeReadyCacheLoaded ||
    runtimeConfigChecking ||
    visibleRuntimeConfigReady === null ||
    cloudConfigReady === null;
  const displayedRuntimeConfigReady = productionConfigChecking
    ? null
    : visibleRuntimeConfigReady;
  const displayedCloudConfigReady = productionConfigChecking
    ? null
    : cloudConfigReady;
  // 正式配置需要同时存在于云端密钥仓库和目标服务器。
  const configReady =
    cloudConfigReady === true && visibleRuntimeConfigReady === true;
  const productionAddresses = useMemo(
    () => environmentAddresses(workspace, "production"),
    [workspace.manifestYaml],
  );
  const showsDetailedRouteStatus =
    production?.actionKind === "route-check" ||
    production?.actionKind === "route-takeover" ||
    production?.actionKind === "route-repair";
  const dnsRecordType = dnsRecordTypeForTarget(initialServer?.host);
  useEffect(() => {
    setPublicRouteStatuses(
      showsDetailedRouteStatus ? (production?.routeChecks ?? []) : [],
    );
  }, [production?.id, production?.routeChecks, showsDetailedRouteStatus]);
  const publicRouteStatusByHost = useMemo(
    () =>
      new Map(
        publicRouteStatuses.map((check) => [
          check.host.trim().toLowerCase(),
          check,
        ]),
      ),
    [publicRouteStatuses],
  );
  const readyPublicRouteCount = publicRouteStatuses.filter(
    (check) => check.reachable || check.phase === "ready",
  ).length;
  const conflictingRouteCount = publicRouteStatuses.filter(
    (check) => check.phase === "route-conflict",
  ).length;
  const missingRouteCount = publicRouteStatuses.filter(
    (check) => check.phase === "route-missing",
  ).length;
  const hasCertificatePendingRoute =
    certificateOnlyRouteFailure(publicRouteStatuses);
  useEffect(() => {
    const hosts = Array.from(
      new Set(productionAddresses.map((address) => address.host)),
    );
    if (production?.actionKind !== "route-check" || !hosts.length) {
      setDnsProviders([]);
      setDnsProviderChecking(false);
      return;
    }
    let active = true;
    setDnsProviderChecking(true);
    void (async () => {
      const discovered: DnsProviderHint[] = [];
      const inspectedZones: string[] = [];
      for (const host of hosts) {
        const normalizedHost = host.toLowerCase();
        if (
          inspectedZones.some(
            (zone) =>
              normalizedHost === zone || normalizedHost.endsWith(`.${zone}`),
          )
        )
          continue;
        const provider = await detectDnsProvider(host).catch(() => null);
        if (provider) inspectedZones.push(provider.zone);
        if (
          provider?.managementUrl &&
          !discovered.some(
            (current) => current.managementUrl === provider.managementUrl,
          )
        ) {
          discovered.push(provider);
          if (active) setDnsProviders([...discovered]);
        }
      }
      if (active && !discovered.length) setDnsProviders([]);
    })().finally(() => {
      if (active) setDnsProviderChecking(false);
    });
    return () => {
      active = false;
    };
  }, [production?.actionKind, productionAddresses]);
  useEffect(() => {
    if (!initialServer || !domainReady) {
      setRouteCheck(null);
      return;
    }
    let active = true;
    setCheckingRoutes(true);
    inspectServerRouteConflicts(path, "production", initialServer)
      .then((result) => {
        if (active) setRouteCheck(result);
      })
      .catch(() => {
        if (active) setRouteCheck(null);
      })
      .finally(() => {
        if (active) setCheckingRoutes(false);
      });
    return () => {
      active = false;
    };
  }, [domainReady, initialServer, path, workspace.manifestYaml]);
  const showingCurrentProduction = Boolean(
    production &&
    productionVersion &&
    (!verifiedRun || versionKey(verifiedRun) === versionKey(productionVersion)),
  );
  if (production && productionVersion && showingCurrentProduction) {
    const currentProduction = production;
    const verifiedCandidate = productionVersion;
    const addresses = productionAddresses;
    const needsCnbAuthorization = ["AD-CNB-101", "AD-CNB-103"].includes(
      production.issueCode ?? "",
    );
    const needsNewTestVersion = production.issueCode === "AD-REL-204";
    const needsRouteTakeover = production.issueCode === "AD-SRV-206";
    const needsRouteRepair = production.issueCode === "AD-SRV-209";
    const addressCheckInterrupted = production.issueCode === "AD-NET-202";
    const canRetry = Boolean(
      initialServer &&
      production.actionKind !== "route-check" &&
      (production.actionKind === "retry-production-preparation" ||
        production.issueCode === "AD-CNB-202" ||
        (production.status === "failed" &&
          !needsCnbAuthorization &&
          !needsNewTestVersion &&
          !needsRouteTakeover &&
          !needsRouteRepair)),
    );
    async function authorizeAndRetry() {
      if (!cnbToken.trim()) return;
      setAuthorizingCnb(true);
      setCnbAuthorizationFeedback(null);
      try {
        try {
          await connectCnb(cnbToken, true, currentProduction.repository);
        } catch (error) {
          setCnbAuthorizationFeedback({
            message: cnbAuthorizationFeedbackMessage(error),
            title: "新令牌未保存，当前任务仍使用原授权",
            tone: "error",
          });
          return;
        }
        setCnbToken("");
        // 授权属于当前生产任务的停点。保存后只恢复这一个任务，不能
        // 新建 production run，也不能重新构建已经测试通过的镜像。
        let refreshed: DeploymentRun;
        try {
          refreshed = await onRefresh(currentProduction);
        } catch (error) {
          setCnbAuthorizationFeedback({
            message: `${cnbAuthorizationFeedbackMessage(error)}。稍后可以直接重新检查当前任务。`,
            title: "新令牌已保存，但这次状态检查没有完成",
            tone: "warning",
          });
          return;
        }
        if (stillNeedsCnbAuthorization(refreshed)) {
          setCnbAuthorizationFeedback({
            message: `请同时检查授权范围和使用范围；使用范围必须包含 ${currentProduction.repository} 或全部仓库。`,
            title: "新令牌已保存，但 CNB 仍拒绝读取当前仓库",
            tone: "warning",
          });
          return;
        }
        setCnbAuthorizationFeedback(null);
        setCnbAuthorizationDialog(false);
      } catch (error) {
        onError(toMessage(error));
      } finally {
        setAuthorizingCnb(false);
      }
    }
    async function takeOverAndRetry() {
      if (!initialServer) return;
      setTakingOver(true);
      try {
        const latestCheck = await inspectServerRouteConflicts(
          path,
          "production",
          initialServer,
        );
        setRouteCheck(latestCheck);
        if (!latestCheck.conflicts.length) {
          await onRefresh(currentProduction);
        } else if (!latestCheck.takeoverAvailable) {
          throw new Error(
            "这些地址属于另一个受管项目，不能自动接管，请先调整正式地址",
          );
        } else {
          await takeOverServerRoutes(path, "production", initialServer);
          // 镜像和容器已经发布完成，这里只切换统一 Caddy 路由并复核，
          // 不再重复触发一次 CNB 生产部署。
          await onRefresh(currentProduction);
        }
        setTakeoverDialog(false);
      } catch (error) {
        onError(toMessage(error));
      } finally {
        setTakingOver(false);
      }
    }
    async function reapplyRoutes() {
      setReapplyingRoutes(true);
      try {
        await reapplyDeploymentRoutes(currentProduction.id);
        await onRefresh(currentProduction);
      } catch (error) {
        onError(toMessage(error));
      } finally {
        setReapplyingRoutes(false);
      }
    }
    async function retryCertificates() {
      if (retryingCertificates) return;
      setRetryingCertificates(true);
      try {
        const checks = await retryDeploymentCertificates(currentProduction.id);
        setPublicRouteStatuses(checks);
        const refreshed = await onRefresh(currentProduction);
        if (refreshed.routeChecks?.length) {
          setPublicRouteStatuses(refreshed.routeChecks);
        }
      } catch (error) {
        onError(`重试 HTTPS 证书没有完成：${toMessage(error)}`);
      } finally {
        setRetryingCertificates(false);
      }
    }
    async function checkProduction() {
      if (checkingProduction) return;
      setCheckingProduction(true);
      setProductionCheckFailed(false);
      try {
        const checked = await onRefresh(currentProduction);
        if (checked.status !== "success") {
          setProductionCheckCompletedThisSession(false);
          return;
        }
        const checkedAt = new Date().toISOString();
        setProductionCheckedAt(checkedAt);
        setProductionCheckCompletedThisSession(true);
        if (productionHealthCheckKey) {
          void setAppSetting(productionHealthCheckKey, checkedAt).catch(
            () => undefined,
          );
        }
      } catch {
        setProductionCheckFailed(true);
        setProductionCheckCompletedThisSession(false);
        onError("运行状态检查没有完成，当前页面仍保留上一次可信结果");
      } finally {
        setCheckingProduction(false);
      }
    }
    return (
      <div>
        <PageHeading
          action={
            production.status === "success" ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  disabled={checkingProduction}
                  onClick={() => void checkProduction()}
                  variant="ghost"
                >
                  <RefreshCw
                    className={checkingProduction ? "animate-spin-slow" : ""}
                  />
                  {checkingProduction ? "正在检查" : "检查运行状态"}
                </Button>
                <Button onClick={onShowVersions} variant="secondary">
                  <Tags />
                  发布或更换版本
                </Button>
              </div>
            ) : undefined
          }
          description={
            production.actionKind === "redeploy-test"
              ? "项目增加了新服务，先部署并验证一个新的测试版本。"
              : production.actionKind === "route-check"
                ? addressCheckInterrupted
                  ? "服务已经在服务器运行；这次地址检查没有完成，网络恢复后会自动继续。"
                  : "服务已经在服务器运行，现在只需要设置正式地址。"
                : production.actionKind === "route-takeover"
                  ? "新版本已经运行；未冲突地址可以先恢复，旧地址由你确认是否切换。"
                  : production.actionKind === "route-repair"
                    ? "服务已经在服务器运行，现在只需要重新应用正式地址。"
                    : production.status === "success"
                      ? addresses.length
                        ? "当前使用测试通过的同一版本，正式地址可以访问。"
                        : "当前使用测试通过的同一版本，服务运行正常。"
                      : "正式版使用测试通过的同一版本。"
          }
          title={
            production.status === "success"
              ? "正式版已上线"
              : deploymentTitle(production)
          }
        />
        {production.status === "success" ? (
          <p
            aria-live="polite"
            className={`-mt-4 mb-5 text-xs ${productionCheckFailed ? "font-medium text-[var(--warning)]" : "text-[var(--muted-foreground)]"}`}
          >
            {productionCheckFailed
              ? productionCheckedAt
                ? `这次检查没有完成，仍显示上次可信结果；上次成功检查：${deploymentUpdatedAtLabel(productionCheckedAt)}。`
                : "这次检查没有完成，仍显示最近一次部署结果。"
              : !productionCheckLoaded
                ? "正在读取上次检查记录"
                : productionCheckedAt
                  ? `${productionCheckCompletedThisSession ? "最近检查" : "上次成功检查"}：${deploymentUpdatedAtLabel(productionCheckedAt)} · 正式版仍可访问`
                  : "还没有在这台电脑检查过运行状态 · 页面显示最近一次部署结果"}
          </p>
        ) : null}
        {currentProductionVersion ? (
          <CurrentVersionBanner
            label="当前正式版本"
            run={currentProductionVersion}
          />
        ) : null}
        {!currentProductionVersion ||
        versionKey(currentProductionVersion) !==
          versionKey(verifiedCandidate) ? (
          <CurrentVersionBanner
            label={
              production.status === "success" ? "当前正式版本" : "本次发布版本"
            }
            run={verifiedCandidate}
          />
        ) : null}
        {production.status !== "success" ? (
          <DeploymentState
            compactCheckStatus={
              addressCheckInterrupted
                ? "本次检查中断"
                : hasCertificatePendingRoute
                  ? "DNS 已生效，HTTPS 证书未就绪"
                  : undefined
            }
            compactMessage={
              production.actionKind === "route-check"
                ? addressCheckInterrupted
                  ? "服务已经启动，不会重复部署。请确认本机网络，恢复后系统会自动继续检查。"
                  : hasCertificatePendingRoute
                    ? "服务和 DNS 都已准备好。点击“重试证书”只会重新加载 Caddy 并检查 HTTPS，不会重复部署。"
                    : "服务已经启动，不会重复部署。请根据下方每个地址的状态继续处理。"
                : production.actionKind === "route-takeover"
                  ? missingRouteCount > 0
                    ? "新版本已经在服务器运行。你可以先恢复未冲突地址，不会切换正在使用的旧服务；旧地址稍后再确认接管。"
                    : "新版本已经在服务器运行，未冲突的地址会继续使用；确认后只切换仍在使用旧服务的地址。"
                  : production.actionKind === "route-repair"
                    ? "新版本已经在服务器运行，只需恢复下方尚未启用的访问地址。"
                    : undefined
            }
            compactTitle={
              production.actionKind === "route-check"
                ? addressCheckInterrupted
                  ? "地址检查暂时没有完成"
                  : hasCertificatePendingRoute
                    ? "还差 HTTPS 证书"
                    : "还差设置正式地址"
                : production.actionKind === "route-takeover"
                  ? `${conflictingRouteCount || 1} 个地址仍在使用旧服务`
                  : production.actionKind === "route-repair"
                    ? `${missingRouteCount || 1} 个地址尚未启用`
                    : undefined
            }
            secondaryAction={
              needsRouteTakeover && missingRouteCount > 0 ? (
                <Button
                  disabled={reapplyingRoutes}
                  onClick={() => void reapplyRoutes()}
                  size="sm"
                  variant="secondary"
                >
                  {reapplyingRoutes ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : (
                    <RefreshCw />
                  )}
                  {reapplyingRoutes ? "正在恢复其他地址" : "先恢复其他地址"}
                </Button>
              ) : production.actionKind === "route-check" &&
                initialServer &&
                !addressCheckInterrupted ? (
                <Button
                  onClick={() => void copyDnsTarget()}
                  size="sm"
                  variant="secondary"
                >
                  <Copy />
                  {dnsTargetCopied ? "记录值已复制" : "复制记录值"}
                </Button>
              ) : undefined
            }
            action={
              needsNewTestVersion ? (
                <Button onClick={onShowTest} size="sm">
                  <Rocket />
                  重新部署测试版
                </Button>
              ) : needsCnbAuthorization ? (
                <Button
                  onClick={() => setCnbAuthorizationDialog(true)}
                  size="sm"
                >
                  <KeyRound />
                  更新 CNB 授权
                </Button>
              ) : needsRouteTakeover ? (
                <Button
                  disabled={!initialServer || checkingRoutes}
                  onClick={() => setTakeoverDialog(true)}
                  size="sm"
                >
                  <ArrowUpRight />
                  接管现有地址
                </Button>
              ) : needsRouteRepair ? (
                <Button
                  disabled={reapplyingRoutes}
                  onClick={() => void reapplyRoutes()}
                  size="sm"
                >
                  {reapplyingRoutes ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : (
                    <RefreshCw />
                  )}
                  重新应用地址
                </Button>
              ) : hasCertificatePendingRoute ? (
                <Button
                  disabled={retryingCertificates}
                  onClick={() => void retryCertificates()}
                  size="sm"
                >
                  <RefreshCw
                    className={retryingCertificates ? "animate-spin-slow" : ""}
                  />
                  {retryingCertificates ? "正在重试证书" : "重试证书"}
                </Button>
              ) : canRetry ? (
                <Button
                  disabled={publishing}
                  onClick={async () => {
                    if (!initialServer) return;
                    setPublishing(true);
                    try {
                      await onPromote(verifiedCandidate, initialServer);
                    } catch {
                      // 失败已经由 App 写回当前 durable task；继续显示该任务。
                    } finally {
                      setPublishing(false);
                    }
                  }}
                  size="sm"
                >
                  {publishing ? (
                    <LoaderCircle className="animate-spin-slow" />
                  ) : (
                    <Rocket />
                  )}
                  重新发布同一版本
                </Button>
              ) : undefined
            }
            onError={onError}
            pauseAutoRecheck={cnbAuthorizationDialog || retryingCertificates}
            run={production}
            onRefresh={onRefresh}
          />
        ) : null}
        {showsDetailedRouteStatus && initialServer && addresses.length ? (
          <Section
            title="正式访问地址状态"
            trailing={`${readyPublicRouteCount}/${addresses.length} 可以访问`}
          >
            <div className="mb-3 flex flex-col items-start gap-3 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
              <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
                {production.actionKind === "route-takeover"
                  ? missingRouteCount > 0
                    ? "未冲突的地址可以单独恢复；只有标记为旧服务的地址需要你确认切换。"
                    : "未冲突的地址会继续使用；只有标记为旧服务的地址需要你确认切换。"
                  : production.actionKind === "route-repair"
                    ? "服务已经启动；重新应用地址只会修复 Caddy 路由，不会重新部署版本。"
                    : "系统会分别检查 DNS 和 HTTPS；根据每个地址右侧的实际状态继续处理即可。"}
              </p>
              {dnsProviders.length ? (
                <div className="flex flex-wrap gap-2">
                  {dnsProviders.map((provider) => (
                    <Button
                      key={provider.managementUrl}
                      onClick={() => void openUrl(provider.managementUrl!)}
                      size="sm"
                      variant="secondary"
                    >
                      <ExternalLink />
                      打开{provider.provider}
                      {dnsProviders.length > 1 ? ` · ${provider.zone}` : ""}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              {addresses.map((item) => {
                const check = publicRouteStatusByHost.get(
                  item.host.trim().toLowerCase(),
                );
                const presentation = publicRouteStatusPresentation(
                  check,
                  publicRouteStatuses.length === 0,
                );
                const recordDetail = `${dnsHostRecordLabel(item.host, dnsProviders, dnsProviderChecking)} · 类型 ${dnsRecordType} · 记录值 ${initialServer.host}`;
                const detail = check?.message
                  ? check.phase === "dns"
                    ? `${recordDetail} · ${check.message}`
                    : check.message
                  : recordDetail;
                return (
                  <StatusRow
                    action={
                      presentation.state === "success" ? (
                        <Button
                          onClick={() => void openUrl(item.url)}
                          size="sm"
                          variant="ghost"
                        >
                          <ExternalLink />
                          打开
                        </Button>
                      ) : undefined
                    }
                    detail={detail}
                    key={item.service}
                    label={item.host}
                    state={presentation.state}
                    status={presentation.status}
                  />
                );
              })}
            </div>
          </Section>
        ) : null}
        {production.status === "success" && addresses.length ? (
          <Section
            title="正式访问地址"
            trailing={`${addresses.length} 个服务可访问`}
          >
            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              {addresses.map((item, index) => (
                <StatusRow
                  action={
                    <Button
                      onClick={() => void openUrl(item.url)}
                      size="sm"
                      variant={index === 0 ? "secondary" : "ghost"}
                    >
                      <ExternalLink />
                      打开{item.label}
                    </Button>
                  }
                  detail={item.url}
                  key={item.service}
                  label={item.label}
                  state="success"
                  status="可以访问"
                />
              ))}
            </div>
          </Section>
        ) : null}
        <CnbAuthorizationDialog
          description="保存新授权后会继续发布当前选中的测试通过版本，不会重新构建镜像。"
          feedback={cnbAuthorizationFeedback}
          fieldId="production-cnb-token"
          onOpenChange={(open) => {
            setCnbAuthorizationDialog(open);
            if (!open) setCnbAuthorizationFeedback(null);
          }}
          onSubmit={() => void authorizeAndRetry()}
          onTokenChange={(value) => {
            setCnbToken(value);
            setCnbAuthorizationFeedback(null);
          }}
          open={cnbAuthorizationDialog}
          repository={currentProduction.repository}
          submitLabel="保存授权并继续发布"
          title="更新 CNB 授权"
          token={cnbToken}
          working={authorizingCnb}
        />
        <Dialog onOpenChange={setTakeoverDialog} open={takeoverDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>把现有地址切换到新版本？</DialogTitle>
              <DialogDescription>
                新版本已经在服务器启动。系统会先备份原地址设置，再一次性切换并校验；任何一步失败都会恢复原设置。
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-4 py-3 text-sm">
              {(routeCheck?.conflicts ?? []).length ? (
                <>
                  <div className="font-medium">将接管以下地址</div>
                  <div className="mt-1 text-[var(--muted-foreground)]">
                    {routeCheck?.conflicts.map((item) => item.host).join("、")}
                  </div>
                </>
              ) : (
                <div className="text-[var(--muted-foreground)]">
                  确认时会再次检查服务器上的实际占用情况。
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                disabled={takingOver}
                onClick={() => setTakeoverDialog(false)}
                variant="secondary"
              >
                取消
              </Button>
              <Button
                disabled={takingOver || !initialServer}
                onClick={() => void takeOverAndRetry()}
              >
                {takingOver ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <Rocket />
                )}
                接管并完成发布
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }
  if (!verifiedRun) {
    const needsInitialSetup = !setupComplete;
    return (
      <div>
        <PageHeading
          description="把测试通过的版本发布给真实用户。"
          title="发布正式版"
        />
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
          <Circle className="mx-auto size-9 text-[var(--subtle-foreground)]" />
          <h2 className="mb-0 mt-4 text-lg font-semibold">
            {needsInitialSetup ? "先完成一次上线设置" : "还没有测试通过的版本"}
          </h2>
          <p className="mx-auto mb-5 mt-2 max-w-lg text-sm leading-6 text-[var(--muted-foreground)]">
            {needsInitialSetup
              ? "完成后系统会生成并部署测试版；只有你确认通过的版本才能发布给真实用户。"
              : "正式版必须使用你已经验证过的测试版本，不会重新生成另一个版本。"}
          </p>
          <Button onClick={needsInitialSetup ? onShowSettings : onShowTest}>
            {needsInitialSetup ? "继续完成设置" : "前往测试版"}
          </Button>
        </div>
      </div>
    );
  }
  const candidate = verifiedRun;
  const restoring = isOlderVersion(candidate, currentProductionVersion);
  const activePreparation = !initialServer
    ? "server"
    : productionConfigChecking || !configReady || editingConfig
      ? "config"
      : !domainReady || editingDomains
        ? "domain"
        : "publish";
  const cloudWebSavePending =
    !productionConfigChecking &&
    !editingConfig &&
    displayedRuntimeConfigReady === true &&
    displayedCloudConfigReady === false;
  const preparationTitle = productionConfigChecking
    ? "正在确认正式发布条件"
    : activePreparation === "config"
      ? cloudWebSavePending
        ? "在网页保存正式配置"
        : "先完成正式配置"
      : activePreparation === "domain"
        ? "还需要填写正式地址"
        : restoring
          ? "可以恢复正式版"
          : "可以发布正式版";
  async function publish() {
    if (!initialServer || !configReady || !domainReady) return;
    setPublishing(true);
    try {
      await onPromote(candidate, initialServer);
      setPublishConfirmationOpen(false);
    } catch {
      // App 会把失败原因持久化到同一个正式发布任务，并负责统一提示。
      // 这里吞掉已处理的拒绝，避免 `void publish()` 产生未处理 Promise，
      // 同时让父层传回的 needs_action 任务接管后续“继续发布”界面。
    } finally {
      setPublishing(false);
    }
  }
  return (
    <div>
      <PageHeading
        description={
          restoring
            ? "系统会使用测试通过的历史版本，不会重新构建。"
            : "系统会使用测试通过的同一版本，不会重新构建。"
        }
        title={preparationTitle}
      />
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <StatusRow
          action={
            verifiedRuns.length > 1 ? (
              <Button
                onClick={() => setSelectingVersion((current) => !current)}
                size="sm"
                variant="ghost"
              >
                {selectingVersion ? "收起版本" : "更换版本"}
              </Button>
            ) : (
              <Button onClick={onShowVersions} size="sm" variant="ghost">
                查看版本记录
              </Button>
            )
          }
          detail={`${versionTitle(candidate)} · ${versionMeta(candidate)}`}
          label={restoring ? "准备恢复的版本" : "准备发布的版本"}
          state="success"
          status="测试通过"
        />
        <StatusRow
          action={
            configReady ? (
              <Button
                onClick={() => {
                  setEditingConfig(true);
                  setEditingDomains(false);
                }}
                size="sm"
                variant="ghost"
              >
                修改
              </Button>
            ) : undefined
          }
          detail={productionConfigDetail(
            displayedRuntimeConfigReady,
            displayedCloudConfigReady,
          )}
          label="正式配置"
          state={
            productionConfigChecking
              ? "idle"
              : configReady
                ? "success"
                : "warning"
          }
          status={
            productionConfigChecking
              ? "正在确认"
              : configReady
                ? "已准备"
                : productionConfigStatus(
                    displayedRuntimeConfigReady,
                    displayedCloudConfigReady,
                  )
          }
        />
        <StatusRow
          action={
            domainReady && configReady ? (
              <Button
                onClick={() => {
                  setEditingDomains(true);
                  setEditingConfig(false);
                }}
                size="sm"
                variant="ghost"
              >
                修改
              </Button>
            ) : undefined
          }
          detail={
            domainReady
              ? productionAddress(workspace) || "所有服务地址均已填写"
              : productionConfigChecking
                ? "确认正式配置后再填写"
                : configReady
                  ? "填写用户最终访问项目的地址"
                  : "完成正式配置后再填写"
          }
          label="正式地址"
          state={domainReady ? "success" : configReady ? "warning" : "idle"}
          status={
            domainReady ? "已准备" : configReady ? "需要填写" : "随后处理"
          }
        />
      </div>
      {selectingVersion ? (
        <Section
          title="更换测试通过的版本"
          trailing={`${verifiedRuns.length} 个可发布`}
        >
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            {verifiedRuns.map((run) => (
              <button
                aria-pressed={run.id === candidate.id}
                className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${run.id === candidate.id ? "bg-[var(--info-soft)]" : "hover:bg-[var(--muted)]/50"}`}
                key={run.id}
                onClick={() => {
                  onSelectVersion(run.id);
                  setSelectingVersion(false);
                }}
                type="button"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm">
                    {versionTitle(run)}
                  </strong>
                  <span
                    className="mt-1 block truncate text-xs text-[var(--muted-foreground)]"
                    title={versionMeta(run)}
                  >
                    {versionMeta(run)}
                  </span>
                </span>
                <span className="text-xs text-[var(--success)]">
                  {currentTestVersion &&
                  versionKey(run) === versionKey(currentTestVersion)
                    ? run.id === candidate.id
                      ? "当前测试版 · 已选择"
                      : "当前测试版 · 推荐"
                    : run.id === candidate.id
                      ? "已选择"
                      : "测试通过"}
                </span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      {activePreparation === "server" ? (
        <Section title="正式环境服务器" trailing="首次发布前设置">
          <p className="mb-4 mt-0 text-xs leading-5 text-[var(--muted-foreground)]">
            选择正式版本实际运行的服务器。它可以和测试服务器不同，保存后以后会自动复用。
          </p>
          <ServerPreparation
            environment="production"
            onError={onError}
            onReady={(next) => {
              setInitialServer(next);
              onServerChange(next);
            }}
            path={path}
          />
        </Section>
      ) : activePreparation === "config" ? (
        <Section
          title={
            productionConfigChecking
              ? "正在确认正式配置"
              : cloudWebSavePending
                ? "在代码平台网页保存"
                : "配置内容"
          }
          trailing={
            cloudWebSavePending
              ? undefined
              : productionConfigStatus(
                  displayedRuntimeConfigReady,
                  displayedCloudConfigReady,
                )
          }
        >
          <div className="mb-3 flex items-center justify-between gap-4">
            <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
              {cloudWebSavePending
                ? "打开网页，粘贴已经准备好的文件名和配置内容并保存；完成后返回这里继续。"
                : "有需要填写的内容会列在下面；没有时直接使用当前配置继续。"}
            </p>
            {configReady && editingConfig ? (
              <Button
                onClick={() => setEditingConfig(false)}
                size="sm"
                variant="ghost"
              >
                完成查看
              </Button>
            ) : null}
          </div>
          {runtimeReadyCacheLoaded && !cloudWebSavePending ? (
            <RuntimeConfigFields
              environment="production"
              onError={onError}
              onMarkOptional={(key) =>
                onSaveManifest(
                  runtimeVariableOptionalManifest(workspace.manifestYaml, key),
                )
              }
              onReadyChange={handleRuntimeConfigReady}
              path={path}
              server={initialServer}
              secretVariables={workspace.inspection.environment_variables
                .filter((item) => item.secret)
                .map((item) => item.name)}
              verifiedReady={runtimeConfigVerifiedReady}
            />
          ) : !runtimeReadyCacheLoaded ? (
            <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--muted-foreground)]">
              <LoaderCircle className="size-4 animate-spin-slow" />
              正在恢复已确认的正式配置
            </div>
          ) : null}
          {productionConfigChecking ? (
            <div className="mt-3 flex items-center gap-2 rounded-md bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin-slow text-[var(--accent)]" />
              正在确认已保存的正式配置，完成后会显示准确下一步
            </div>
          ) : (
            <CnbSecretSetup
              environment="production"
              onError={onError}
              onProgressChange={onProgressChange}
              onReadyChange={setCloudConfigReady}
              onSaveManifest={onSaveManifest}
              path={path}
              runtimeReady={visibleRuntimeConfigReady === true}
              server={initialServer}
              workspace={workspace}
            />
          )}
        </Section>
      ) : activePreparation === "domain" ? (
        <Section title="下一步：填写正式地址" trailing="最后一项准备">
          <p className="mb-4 mt-0 text-xs leading-5 text-[var(--muted-foreground)]">
            填写用户最终访问项目的地址，系统会自动配置服务器访问和 HTTPS。
          </p>
          {initialServer?.host ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--muted)]/45 px-3 py-2.5">
              <div className="min-w-0">
                <strong className="block text-sm">
                  域名需要指向这台服务器
                </strong>
                <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
                  在域名服务商添加 {dnsRecordType} 记录，目标填写{" "}
                  {initialServer.host}。发布后系统会自动检查是否生效。
                </span>
              </div>
              <Button
                onClick={() => void copyDnsTarget()}
                size="sm"
                variant="secondary"
              >
                {dnsTargetCopied ? <Check /> : <Copy />}
                {dnsTargetCopied ? "服务器 IP 已复制" : "复制服务器 IP"}
              </Button>
            </div>
          ) : null}
          <DomainFields
            environment="production"
            onReadyChange={setDomainReady}
            onSaveManifest={onSaveManifest}
            saving={saving}
            workspace={workspace}
          />
          {domainReady && editingDomains ? (
            <div className="mt-3 flex justify-end">
              <Button
                onClick={() => setEditingDomains(false)}
                size="sm"
                variant="ghost"
              >
                完成查看
              </Button>
            </div>
          ) : null}
        </Section>
      ) : (
        <SuccessBanner
          message={
            restoring && currentProductionVersion
              ? `正式网站将从“${versionComparisonTitle(currentProductionVersion)}”恢复到“${versionComparisonTitle(candidate)}”。`
              : `“${versionTitle(candidate)}”的配置和地址均已准备。`
          }
          title={restoring ? "恢复条件已经准备完成" : "发布条件已经准备完成"}
        />
      )}
      {routeCheck?.conflicts.length ? (
        <IssueBanner
          message={`服务器上的旧版本正在使用 ${routeCheck.conflicts
            .map((item) => item.host)
            .join(
              "、",
            )}。系统不会直接覆盖；新版本启动成功后，会请你确认是否接管这些地址。`}
          title="正式地址正在被旧版本使用"
        />
      ) : checkingRoutes ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="size-4 animate-spin-slow" />
          正在确认正式地址是否可以安全切换
        </div>
      ) : null}
      {activePreparation === "publish" ? (
        <div className="mt-6 flex items-center justify-between gap-5 border-t border-[var(--border)] pt-5">
          <span className="text-xs text-[var(--muted-foreground)]">
            发布前还会让你最后确认一次
          </span>
          <Button
            disabled={!initialServer || publishing}
            onClick={() => setPublishConfirmationOpen(true)}
          >
            {publishing ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Rocket />
            )}
            {restoring ? "恢复正式版" : "发布正式版"}
          </Button>
        </div>
      ) : null}
      <Dialog
        onOpenChange={setPublishConfirmationOpen}
        open={publishConfirmationOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {restoring ? "恢复这个正式版本？" : "发布这个正式版本？"}
            </DialogTitle>
            <DialogDescription>
              {productionConfirmationMessage({
                candidateTitle: versionComparisonTitle(candidate),
                currentTitle: currentProductionVersion
                  ? versionComparisonTitle(currentProductionVersion)
                  : undefined,
                restoring,
                target: productionAddress(workspace),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={publishing}
              onClick={() => setPublishConfirmationOpen(false)}
              variant="secondary"
            >
              取消
            </Button>
            <Button disabled={publishing} onClick={() => void publish()}>
              {publishing ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Rocket />
              )}
              {restoring ? "确认恢复" : "确认发布"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CnbSecretSetup({
  environment,
  onError,
  onProgressChange,
  onReadyChange,
  onSaveManifest,
  path,
  runtimeReady,
  server,
  workspace,
}: {
  environment: "staging" | "production";
  onError: (message: string) => void;
  onProgressChange?: () => void;
  onReadyChange: (ready: boolean) => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  path: string;
  runtimeReady: boolean;
  server?: ServerForm;
  workspace: WorkspacePreview;
}) {
  const pendingKey = `project.${encodeURIComponent(path)}.cnb-secret-pending.${environment}`;
  const repositoryKey = `project.${encodeURIComponent(path)}.cnb-secret-repository`;
  const progressKey = `project.${encodeURIComponent(path)}.cnb-secret-progress.${environment}`;
  const [ready, setReady] = useState(false);
  const [repository, setRepository] = useState(() =>
    suggestedSecretRepository(workspace),
  );
  const [repositoryPreviouslyUsed, setRepositoryPreviouslyUsed] =
    useState(false);
  const [repositoryLoaded, setRepositoryLoaded] = useState(false);
  const [repositoryAvailability, setRepositoryAvailability] = useState<
    "idle" | "checking" | "available" | "missing" | "error"
  >("idle");
  const [resumeStage, setResumeStage] = useState<
    | "loading"
    | "creation-page-opened"
    | "repository-ready"
    | "save-page-opened"
    | null
  >("loading");
  const [bundle, setBundle] = useState<CnbSecretBundle | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [saveConfirmationOpen, setSaveConfirmationOpen] = useState(false);
  const [creationHint, setCreationHint] = useState("");
  const [repositoryEditorOpen, setRepositoryEditorOpen] = useState(false);
  const [savePageOpened, setSavePageOpened] = useState(false);
  const [redoingSave, setRedoingSave] = useState(false);
  const [editing, setEditing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [working, setWorking] = useState(false);
  const automaticResumeStarted = useRef(false);
  const copiedSecretContent = useRef("");
  const copiedSecretCleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const verifiedRepository = useRef("");
  const repositoryCheckRequest = useRef<{
    promise: ReturnType<typeof checkCnbSecretRepositoryAccess>;
    repository: string;
  } | null>(null);
  const repositoryRecorded = recordedSecretRepository(
    workspace,
    environment,
    repository,
  );
  const reusableRepositoryReady = repositoryAvailability === "available";
  const resumingSave = resumeStage === "save-page-opened";
  const contentCopied = copyStatus.startsWith("配置内容已复制");
  const resumedSaveChoice = resumingSave && !redoingSave && !contentCopied;

  function stopTrackingCopiedSecret() {
    if (copiedSecretCleanupTimer.current) {
      clearTimeout(copiedSecretCleanupTimer.current);
      copiedSecretCleanupTimer.current = null;
    }
    copiedSecretContent.current = "";
  }

  async function clearCopiedSecret() {
    const content = copiedSecretContent.current;
    stopTrackingCopiedSecret();
    if (content) await clearClipboardIfUnchanged(content);
  }

  function trackCopiedSecret(content: string) {
    stopTrackingCopiedSecret();
    copiedSecretContent.current = content;
    copiedSecretCleanupTimer.current = setTimeout(
      () => {
        const current = copiedSecretContent.current;
        stopTrackingCopiedSecret();
        if (current) void clearClipboardIfUnchanged(current);
      },
      2 * 60 * 1000,
    );
  }

  useEffect(
    () => () => {
      void clearCopiedSecret();
    },
    [],
  );

  function requestRepositoryAccess(repositoryName: string) {
    const existing = repositoryCheckRequest.current;
    if (existing?.repository === repositoryName) return existing.promise;
    const promise = checkCnbSecretRepositoryAccess(repositoryName).finally(
      () => {
        if (repositoryCheckRequest.current?.promise === promise) {
          repositoryCheckRequest.current = null;
        }
      },
    );
    repositoryCheckRequest.current = {
      promise,
      repository: repositoryName,
    };
    return promise;
  }

  useEffect(() => {
    let active = true;
    if (!secretReferenceReady(workspace, environment)) {
      setReady(false);
      onReadyChange(false);
      return () => {
        active = false;
      };
    }
    getAppSetting(pendingKey)
      .then((pending) => {
        if (!active) return;
        const next = pending !== "true";
        setReady(next);
        onReadyChange(next);
      })
      .catch(() => {
        if (!active) return;
        setReady(false);
        onReadyChange(false);
      });
    return () => {
      active = false;
    };
  }, [environment, onReadyChange, pendingKey, workspace]);

  useEffect(() => {
    let active = true;
    setRepositoryLoaded(false);
    const existing =
      secretRepositoryFromManifest(workspace, environment) ||
      secretRepositoryFromManifest(workspace, "staging");
    if (existing) {
      setRepository(existing);
      setRepositoryPreviouslyUsed(true);
      setRepositoryLoaded(true);
      void setAppSetting("cnb.secret-repository", existing).catch(
        () => undefined,
      );
      return () => {
        active = false;
      };
    }
    Promise.all([
      getAppSetting(repositoryKey),
      getAppSetting("cnb.secret-repository"),
    ])
      .then(([savedForProject, savedForAccount]) => {
        if (!active) return;
        // A verified account-level location is intentionally reusable across
        // projects. A project-scoped value can be a suggested name left by an
        // interrupted handoff, so it must not override the reusable location.
        const saved = savedForAccount?.includes("/")
          ? savedForAccount
          : savedForProject?.includes("/")
            ? savedForProject
            : "";
        if (saved) {
          setRepository(saved);
          setRepositoryPreviouslyUsed(saved === savedForAccount);
        } else {
          setRepositoryPreviouslyUsed(false);
        }
        setRepositoryLoaded(true);
      })
      .catch(() => {
        if (active) setRepositoryLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [environment, repositoryKey, workspace]);

  useEffect(() => {
    let active = true;
    setResumeStage("loading");
    getAppSetting(progressKey)
      .then((saved) => {
        if (!active) return;
        setResumeStage(
          saved === "creation-page-opened" ||
            saved === "repository-ready" ||
            saved === "save-page-opened"
            ? saved
            : null,
        );
      })
      .catch(() => {
        if (active) setResumeStage(null);
      });
    return () => {
      active = false;
    };
  }, [progressKey]);

  useEffect(() => {
    let active = true;
    // Opening CNB is an explicit handoff. Keep the recovery actions visible
    // until the user returns and asks us to verify, otherwise a background
    // check can replace the explicit "created, open configuration" recovery
    // action before the user has a chance to use it.
    if (resumeStage === "creation-page-opened") {
      setRepositoryAvailability("idle");
      return () => {
        active = false;
      };
    }
    if (
      !repositoryLoaded ||
      resumeStage === "loading" ||
      !repository.includes("/") ||
      (!repositoryPreviouslyUsed &&
        !repositoryRecorded &&
        resumeStage !== "repository-ready" &&
        resumeStage !== "save-page-opened")
    ) {
      setRepositoryAvailability("idle");
      return () => {
        active = false;
      };
    }
    const normalizedRepository = repository.trim();
    if (verifiedRepository.current === normalizedRepository) {
      setRepositoryAvailability("available");
      return () => {
        active = false;
      };
    }
    setRepositoryAvailability("checking");
    requestRepositoryAccess(normalizedRepository)
      .then((result) => {
        if (!active) return;
        if (result.ok) verifiedRepository.current = normalizedRepository;
        setRepositoryAvailability(result.ok ? "available" : "missing");
        if (!result.ok) {
          setRepositoryPreviouslyUsed(false);
          setCreationHint(
            "CNB 网页上还没有找到这个安全位置。可能上次没有完成创建，重新创建即可。",
          );
        }
      })
      .catch(() => {
        if (active) setRepositoryAvailability("error");
      });
    return () => {
      active = false;
    };
  }, [
    repository,
    repositoryLoaded,
    repositoryPreviouslyUsed,
    repositoryRecorded,
    resumeStage,
  ]);

  async function saveResumeStage(
    next:
      "creation-page-opened" | "repository-ready" | "save-page-opened" | null,
  ) {
    await setAppSetting(progressKey, next ?? "");
    setResumeStage(next);
    onProgressChange?.();
  }

  async function verifyRepository(): Promise<boolean> {
    const normalizedRepository = repository.trim();
    if (verifiedRepository.current === normalizedRepository) {
      setRepositoryAvailability("available");
      return true;
    }
    setRepositoryAvailability("checking");
    try {
      const result = await requestRepositoryAccess(normalizedRepository);
      if (!result.ok) {
        setRepositoryAvailability("missing");
        setRepositoryPreviouslyUsed(false);
        setCreationHint(
          "CNB 网页上还没有找到这个安全位置。请先完成创建，再回到这里继续。",
        );
        return false;
      }
      verifiedRepository.current = normalizedRepository;
      setRepositoryAvailability("available");
      setRepositoryPreviouslyUsed(true);
      setCreationHint("");
      return true;
    } catch (error) {
      setRepositoryAvailability("error");
      onError(toMessage(error));
      return false;
    }
  }

  async function generate(resumeSavePage = false, openAfterGenerate = false) {
    if (!server || !repository.includes("/")) return;
    setGenerating(true);
    setWorking(true);
    try {
      // A persisted `save-page-opened` checkpoint lets the remote location
      // check and safe local bundle regeneration run in parallel. The check
      // still gates what the user can see and confirm; this only avoids making
      // the same CNB request again inside bundle generation.
      const trustedSaveCheckpoint =
        resumeSavePage && resumeStage === "save-page-opened";
      if (
        !trustedSaveCheckpoint &&
        !(
          repositoryAvailability === "available" &&
          verifiedRepository.current === repository.trim()
        ) &&
        !(await verifyRepository())
      )
        return;
      await Promise.all([
        setAppSetting(repositoryKey, repository.trim()),
        setAppSetting("cnb.secret-repository", repository.trim()),
      ]);
      setRepositoryPreviouslyUsed(true);
      if (!resumeSavePage) await saveResumeStage("repository-ready");
      const generated = await prepareCnbDeploymentBundle(
        path,
        environment,
        repository.trim(),
        server,
        resumeSavePage,
      );
      if (generated.missingVariables.length) {
        throw new Error(
          `还有 ${generated.missingVariables.length} 项配置没有值，请先补齐后再生成`,
        );
      }
      setBundle(generated);
      setSavePageOpened(resumeSavePage);
      setCopyStatus("");
      if (openAfterGenerate) {
        setRedoingSave(true);
        await copyText(generated.filename);
        setCopyStatus("文件名已复制");
        await openUrl(cnbNewFileUrl(repository, generated.filename));
        await saveResumeStage("save-page-opened");
        setSavePageOpened(true);
      }
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setGenerating(false);
      setWorking(false);
    }
  }

  async function openSecretRepositoryCreation() {
    const name = repository.trim().split("/").filter(Boolean).pop();
    if (!name) return;
    setWorking(true);
    try {
      await copyText(name);
      stopTrackingCopiedSecret();
      await setAppSetting(repositoryKey, repository.trim());
      setCreationHint(
        "名称已经复制。请在网页中粘贴名称，选择“密钥仓库”并创建，完成后回到这里。",
      );
      await openUrl("https://cnb.cool/new/repos");
      await saveResumeStage("creation-page-opened");
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function copyBundle(currentBundle: CnbSecretBundle) {
    setWorking(true);
    try {
      await copyText(currentBundle.content);
      trackCopiedSecret(currentBundle.content);
      setCopyStatus("配置内容已复制，请回到网页粘贴并保存");
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function openBundleSavePage(currentBundle: CnbSecretBundle) {
    setRedoingSave(true);
    setWorking(true);
    try {
      // CNB currently ignores the filename query parameter on its Web editor.
      // Copy the filename before opening so the first paste has one clear
      // destination; the user can then return here to copy the secret content.
      await copyText(currentBundle.filename);
      stopTrackingCopiedSecret();
      setCopyStatus("文件名已复制");
      await openUrl(cnbNewFileUrl(repository, currentBundle.filename));
      await saveResumeStage("save-page-opened");
      setSavePageOpened(true);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function restartBundleSave(currentBundle: CnbSecretBundle) {
    setRedoingSave(true);
    await openBundleSavePage(currentBundle);
  }

  async function confirmSaved(currentBundle: CnbSecretBundle) {
    setWorking(true);
    try {
      if (!(await verifyRepository())) return;
      const document = parseDocument(workspace.manifestYaml);
      document.setIn(
        ["environments", environment, "secrets_ref"],
        currentBundle.fileUrl,
      );
      if (
        environment === "staging" &&
        !secretReferenceReady(workspace, "production")
      ) {
        document.setIn(
          ["environments", "production", "secrets_ref"],
          currentBundle.fileUrl.replace(/\.staging\.yml$/, ".production.yml"),
        );
      }
      if (!(await onSaveManifest(document.toString({ lineWidth: 0 })))) {
        throw new Error("云端安全配置没有保存成功，请重试");
      }
      await setAppSetting(pendingKey, "false");
      await setAppSetting("cnb.secret-repository", repository.trim());
      await saveResumeStage(null);
      if (
        environment === "staging" &&
        !secretReferenceReady(workspace, "production")
      ) {
        await setAppSetting(
          `project.${encodeURIComponent(path)}.cnb-secret-pending.production`,
          "true",
        );
      }
      await clearClipboardIfUnchanged(currentBundle.content);
      stopTrackingCopiedSecret();
      setBundle(null);
      setCopyStatus("");
      setEditing(false);
      setReady(true);
      onReadyChange(true);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function confirmResumedSave() {
    if (!server || !repository.includes("/")) return;
    setWorking(true);
    try {
      const generated = await prepareCnbDeploymentBundle(
        path,
        environment,
        repository.trim(),
        server,
      );
      if (generated.missingVariables.length) {
        throw new Error(
          `还有 ${generated.missingVariables.length} 项配置没有值，请先补齐后再继续`,
        );
      }
      await confirmSaved(generated);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  function requestSavedConfirmation() {
    if (!contentCopied) {
      setSaveConfirmationOpen(true);
      return;
    }
    if (bundle) void confirmSaved(bundle);
    else void confirmResumedSave();
  }

  function finishSavedConfirmation() {
    setSaveConfirmationOpen(false);
    if (bundle) void confirmSaved(bundle);
    else void confirmResumedSave();
  }

  useEffect(() => {
    if (!resumingSave) {
      automaticResumeStarted.current = false;
      return;
    }
    if (
      automaticResumeStarted.current ||
      bundle ||
      generating ||
      working ||
      !server ||
      !repository.includes("/") ||
      (repositoryAvailability !== "checking" &&
        repositoryAvailability !== "available")
    )
      return;
    automaticResumeStarted.current = true;
    void generate(true, false);
  }, [
    bundle,
    generating,
    repository,
    repositoryAvailability,
    resumingSave,
    server,
    working,
  ]);

  if (ready && !editing) {
    const readyTitle =
      environment === "staging" ? "自动部署已经开启" : "正式发布配置已准备";
    const readyDescription =
      environment === "staging"
        ? "以后把代码合并到主分支，系统会自动生成版本并更新测试版；正式版仍由你确认发布。"
        : "以后发布正式版时会使用这里保存的配置，不需要重复填写。";
    return (
      <div className="mt-3 flex items-center justify-between rounded-md border border-[var(--success)]/20 bg-[var(--success-soft)] px-4 py-3">
        <div>
          <strong className="text-sm">{readyTitle}</strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {readyDescription}
          </span>
        </div>
        <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
          重新设置
        </Button>
      </div>
    );
  }

  if (!runtimeReady) {
    return (
      <p className="mb-0 mt-3 text-xs text-[var(--muted-foreground)]">
        {`先完成${environment === "staging" ? "测试" : "正式"}配置，随后系统会引导你在代码平台网页安全保存。`}
      </p>
    );
  }

  if (!server) {
    return (
      <IssueBanner
        message="先连接运行服务器，系统才能生成完整的云端安全配置。"
        title="还缺少服务器信息"
      />
    );
  }

  if (
    resumeStage === "loading" ||
    !repositoryLoaded ||
    repositoryAvailability === "checking"
  ) {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--muted)]/25 px-4 py-4">
        <LoaderCircle className="size-4 shrink-0 animate-spin-slow text-[var(--accent)]" />
        <div>
          <strong className="block text-xs">
            {repositoryAvailability === "checking"
              ? "正在确认安全位置"
              : "正在恢复上次进度"}
          </strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {repositoryAvailability === "checking"
              ? "正在向 CNB 确认这个位置确实存在。"
              : "正在确认是否有尚未完成的网页保存。"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--muted)]/25 p-4">
      <strong className="text-sm">
        {bundle
          ? resumedSaveChoice
            ? "继续上次的网页保存"
            : contentCopied
              ? "最后一步：在网页粘贴并保存"
              : "把配置复制到网页"
          : repositoryAvailability === "missing"
            ? "先完成安全位置创建"
            : resumingSave
              ? "安全配置已经准备好"
              : resumeStage === "creation-page-opened"
                ? "继续刚才的安全位置创建"
                : reusableRepositoryReady || resumeStage === "repository-ready"
                  ? "准备这次要保存的配置"
                  : "在网页完成一次安全保存"}
      </strong>
      <p className="mb-4 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
        {repositoryAvailability === "missing"
          ? "系统刚刚检查过，CNB 上还没有这个位置。重新创建即可继续，不会修改其他项目。"
          : repositoryAvailability === "error"
            ? "暂时无法确认这个位置是否可用。重新检查后再继续，避免把配置保存到无效页面。"
            : resumedSaveChoice
              ? "系统已保留本项目的位置和配置。先确认网页是否已经保存。"
              : bundle
                ? "敏感配置只保存在代码平台，不会写入项目代码。"
                : reusableRepositoryReady
                  ? "系统找到了以前使用的安全位置，本项目只会新增一份配置。"
                  : "为了让自动部署读取这套配置，需要你在 CNB 网页确认一次。系统会准备好名称和内容，ABCDeploy 不会把敏感信息放进项目代码。"}
      </p>
      {repositoryEditorOpen ? (
        <div className="rounded-md bg-[var(--surface)] px-4 py-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${environment}-secret-repository`}>
              已有的 CNB 密钥仓库位置
            </Label>
            <Input
              id={`${environment}-secret-repository`}
              onBlur={() => {
                if (repository.includes("/"))
                  void setAppSetting(repositoryKey, repository.trim());
              }}
              onChange={(event) => {
                void clearCopiedSecret();
                setRepository(event.target.value);
                setRepositoryPreviouslyUsed(false);
                setRepositoryAvailability("idle");
                verifiedRepository.current = "";
                repositoryCheckRequest.current = null;
                setBundle(null);
                setCopyStatus("");
                setCreationHint("");
                setSavePageOpened(false);
                setRedoingSave(false);
              }}
              placeholder="例如 team/project-secrets"
              value={repository}
            />
            <span className="block text-xs leading-5 text-[var(--muted-foreground)]">
              只有这个位置已经是密钥仓库时才直接继续。
            </span>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              disabled={working}
              onClick={() => setRepositoryEditorOpen(false)}
              size="sm"
              variant="secondary"
            >
              返回创建新仓库
            </Button>
            <Button
              disabled={working || !repository.includes("/")}
              onClick={() => {
                setRepositoryEditorOpen(false);
                void generate(false, true);
              }}
              size="sm"
            >
              使用并打开配置页面
            </Button>
          </div>
        </div>
      ) : resumingSave ? null : (
        <div className="rounded-md bg-[var(--surface)] px-4 py-3">
          <strong className="block text-xs">
            {repositoryAvailability === "missing"
              ? "这个位置还没有创建"
              : repositoryAvailability === "error"
                ? "还不能确认这个位置"
                : reusableRepositoryReady
                  ? "已找到以前使用的位置"
                  : "新位置名称已经准备好"}
          </strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {repositoryAvailability === "missing"
              ? "名称仍然保留，打开 CNB 完成创建即可。"
              : repositoryAvailability === "error"
                ? "网络或授权可能暂时不可用，请重新检查。"
                : reusableRepositoryReady
                  ? "当前授权的使用范围包含此位置时可以复用，不需要重新创建。"
                  : "无需填写，打开网页时会自动复制仓库名称。"}
          </span>
        </div>
      )}
      {repositoryEditorOpen ? null : repositoryAvailability === "error" ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            disabled={working || !repository.includes("/")}
            onClick={() => void verifyRepository()}
            size="sm"
          >
            <RefreshCw />
            重新检查
          </Button>
        </div>
      ) : repositoryAvailability === "missing" ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            disabled={working}
            onClick={() => {
              setRepositoryAvailability("idle");
              setRepositoryEditorOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            使用其他位置
          </Button>
          <Button
            disabled={working}
            onClick={() => void openSecretRepositoryCreation()}
            size="sm"
          >
            <ExternalLink />
            打开 CNB 创建
          </Button>
          <Button
            disabled={working || !repository.includes("/")}
            onClick={() => void generate(false, true)}
            size="sm"
          >
            <Check />
            我已创建，打开配置页面
          </Button>
        </div>
      ) : generating ? (
        <div className="mt-4 flex items-center gap-3 rounded-md bg-[var(--surface)] px-4 py-4">
          <LoaderCircle className="size-4 shrink-0 animate-spin-slow text-[var(--accent)]" />
          <div>
            <strong className="block text-xs">正在准备下一步</strong>
            <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
              正在整理服务器连接和{environment === "staging" ? "测试" : "正式"}
              配置，通常只需要几秒。
            </span>
          </div>
        </div>
      ) : bundle ? (
        <div className="mt-4 rounded-md bg-[var(--surface)] px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2">
            <div className="min-w-0">
              <span className="block text-xs text-[var(--muted-foreground)]">
                {savePageOpened
                  ? "第 1 步已完成：网页已经打开"
                  : "第 1 步：打开网页并粘贴文件名"}
              </span>
              <code className="mt-1 block break-all text-xs">
                {bundle.filename}
              </code>
            </div>
          </div>
          {!savePageOpened ? (
            <>
              <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
                点击后文件名会自动复制。到网页粘贴文件名，再回到这里继续。
              </p>
              <div className="mt-3 flex justify-end">
                <Button
                  disabled={working}
                  onClick={() => void openBundleSavePage(bundle)}
                  size="sm"
                >
                  <ExternalLink />
                  复制文件名并打开 CNB
                </Button>
              </div>
            </>
          ) : resumedSaveChoice ? (
            <>
              <div className="flex gap-3">
                <Circle className="mt-0.5 size-4 shrink-0 text-[var(--subtle-foreground)]" />
                <div>
                  <strong className="block text-xs">
                    上次已经打开过保存网页
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
                    已经粘贴并保存就直接继续；还没保存则重新打开，系统会接着提示。
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  disabled={working}
                  onClick={() => void restartBundleSave(bundle)}
                  size="sm"
                  variant="secondary"
                >
                  <ExternalLink />
                  还没保存，重新打开网页
                </Button>
                <Button
                  disabled={working}
                  onClick={requestSavedConfirmation}
                  size="sm"
                >
                  <Check />
                  网页已保存，继续
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-3">
                {contentCopied ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-[var(--subtle-foreground)]" />
                )}
                <div>
                  <strong className="block text-xs">
                    {contentCopied
                      ? "第 2 步已完成：配置内容已经复制"
                      : "第 2 步：复制配置内容"}
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
                    {contentCopied
                      ? "回到刚才的网页粘贴并保存，完成后再回来继续。"
                      : "复制后回到刚才的网页，粘贴到编辑区并保存。"}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  disabled={working}
                  onClick={() => void restartBundleSave(bundle)}
                  size="sm"
                  variant="secondary"
                >
                  <ExternalLink />
                  重新打开网页
                </Button>
                {contentCopied ? (
                  <Button
                    disabled={working}
                    onClick={requestSavedConfirmation}
                    size="sm"
                  >
                    <Check />
                    我已粘贴并保存
                  </Button>
                ) : (
                  <Button
                    disabled={working}
                    onClick={() => void copyBundle(bundle)}
                    size="sm"
                  >
                    <Copy />
                    复制配置内容
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      ) : resumingSave ? (
        <div className="mt-4 rounded-md bg-[var(--surface)] px-4 py-3">
          <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
            尚未保存就重新打开网页；已经保存则直接继续。客户端会重新准备文件名和配置内容。
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              disabled={working || !repository.includes("/")}
              onClick={() => {
                setRedoingSave(true);
                void generate(true, true);
              }}
              size="sm"
              variant="secondary"
            >
              <ExternalLink />
              重新复制文件名并打开网页
            </Button>
            <Button
              disabled={working || !repository.includes("/")}
              onClick={requestSavedConfirmation}
              size="sm"
            >
              {working ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Check />
              )}
              我已在网页保存
            </Button>
          </div>
        </div>
      ) : reusableRepositoryReady || resumeStage === "repository-ready" ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            disabled={working}
            onClick={() => {
              setRepositoryPreviouslyUsed(false);
              setRepositoryEditorOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            更换位置
          </Button>
          <Button
            disabled={working || !repository.includes("/")}
            onClick={() => void generate(false, true)}
            size="sm"
          >
            {working ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Copy />
            )}
            准备配置并打开 CNB
          </Button>
        </div>
      ) : creationHint || resumeStage === "creation-page-opened" ? (
        <div className="mt-4 rounded-md border border-[var(--primary)]/20 bg-[var(--surface)] px-4 py-3">
          <p className="m-0 text-xs leading-5 text-[var(--muted-foreground)]">
            {creationHint ||
              "上次已经打开过创建页面。完成创建后继续；如果网页已经关闭，也可以再次打开。"}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              disabled={working}
              onClick={() => void openSecretRepositoryCreation()}
              size="sm"
              variant="secondary"
            >
              <ExternalLink />
              重新复制名称并打开网页
            </Button>
            <Button
              disabled={working || !repository.includes("/")}
              onClick={() => void generate(false, true)}
              size="sm"
            >
              <Check />
              我已创建，打开配置页面
            </Button>
          </div>
        </div>
      ) : repositoryEditorOpen ? null : (
        <div className="mt-4 text-right">
          <Button
            disabled={working || !repository.includes("/")}
            onClick={() => void openSecretRepositoryCreation()}
            size="sm"
          >
            <ExternalLink />
            打开 CNB 创建保存位置
          </Button>
          <Button
            className="ml-auto mt-2"
            disabled={working}
            onClick={() => setRepositoryEditorOpen(true)}
            size="sm"
            variant="ghost"
          >
            我已经有保存位置
          </Button>
        </div>
      )}
      <Dialog
        onOpenChange={setSaveConfirmationOpen}
        open={saveConfirmationOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认网页已经保存</DialogTitle>
            <DialogDescription>
              为保护密钥，客户端无法读取网页中的配置内容。请确认你已经在 CNB
              网页粘贴配置并点击保存；如果还没有，先返回继续操作。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setSaveConfirmationOpen(false)}
              variant="secondary"
            >
              返回继续操作
            </Button>
            <Button disabled={working} onClick={finishSavedConfirmation}>
              <Check />
              已经保存，继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export async function prepareCnbDeploymentBundle(
  path: string,
  environment: CnbSecretBundle["environment"],
  repository: string,
  server: ServerForm,
  identityAlreadyPrepared = false,
): Promise<CnbSecretBundle> {
  // A persisted `save-page-opened` checkpoint can only be written after this
  // identity was installed successfully. Reinstalling the same public key on
  // every resume is idempotent but costs another SSH connection. Bundle
  // generation still verifies the server fingerprint and reads the existing
  // private key; a damaged checkpoint therefore fails safely.
  if (!identityAlreadyPrepared) await preparePipelineIdentity(path, server);
  return prepareCnbSecretBundle(path, environment, repository, server);
}

export function cnbRepositoryUrl(repository: string) {
  return `https://cnb.cool/${repository.trim().replace(/^\/+|\/+$/g, "")}`;
}

export function cnbNewFileUrl(repository: string, filename = "") {
  const url = `${cnbRepositoryUrl(repository)}/-/new/main`;
  return filename ? `${url}?file_name=${encodeURIComponent(filename)}` : url;
}

export function recordedSecretRepository(
  workspace: WorkspacePreview,
  environment: "staging" | "production",
  repository: string,
) {
  const recorded =
    secretRepositoryFromManifest(workspace, environment) ||
    secretRepositoryFromManifest(workspace, "staging");
  return Boolean(
    recorded && cnbRepositoryUrl(recorded) === cnbRepositoryUrl(repository),
  );
}

export function productionConfigStatus(
  runtimeReady: boolean | null,
  cloudReady: boolean | null,
) {
  if (runtimeReady === null || cloudReady === null) return "正在确认";
  if (!runtimeReady) return "未完成";
  return cloudReady ? "已准备" : "等待网页保存";
}

export function productionConfigDetail(
  runtimeReady: boolean | null,
  cloudReady: boolean | null,
) {
  if (runtimeReady === null || cloudReady === null)
    return "正在核对已经保存的正式配置";
  if (!runtimeReady) return "保存后继续完成网页安全配置";
  return cloudReady
    ? "配置内容和自动发布均已准备"
    : "配置内容已齐全，运行服务器已准备";
}

export function testEnvironmentDisplayReady(
  currentReady: boolean,
  checking: boolean,
  hasTrustedHistory: boolean,
  reviewResolved: boolean,
) {
  return currentReady || (hasTrustedHistory && (checking || !reviewResolved));
}

function useStagingPreparationStatus(
  path: string,
  server: ServerForm | undefined,
  workspace: WorkspacePreview,
) {
  const runtimeReadyKey = server
    ? runtimeConfigReadyCacheKey(path, "staging", server)
    : "";
  const [runtimeConfigReady, setRuntimeConfigReady] = useState<boolean | null>(
    server ? null : false,
  );
  const [cloudConfigReady, setCloudConfigReady] = useState(
    secretReferenceReady(workspace, "staging"),
  );
  const [addressReady, setAddressReady] = useState(() =>
    stagingAddressConfigured(workspace),
  );

  useEffect(() => {
    setAddressReady(stagingAddressConfigured(workspace));
  }, [workspace.manifestYaml]);

  useEffect(() => {
    let active = true;
    const pendingKey = `project.${encodeURIComponent(path)}.cnb-secret-pending.staging`;
    getAppSetting(pendingKey)
      .then((pending) => {
        if (active) {
          setCloudConfigReady(
            secretReferenceReady(workspace, "staging") && pending !== "true",
          );
        }
      })
      .catch(() => {
        if (active) setCloudConfigReady(false);
      });
    return () => {
      active = false;
    };
  }, [path, workspace.manifestYaml]);

  useEffect(() => {
    let active = true;
    if (!server) {
      setRuntimeConfigReady(false);
      return () => {
        active = false;
      };
    }
    setRuntimeConfigReady(null);
    let verificationFinished = false;
    const cachedReady = getAppSetting(runtimeReadyKey).catch(() => null);
    void cachedReady.then((cached) => {
      if (active && !verificationFinished && cached === "true")
        setRuntimeConfigReady(true);
    });
    Promise.all([
      loadRuntimeConfig(path, "staging", false),
      getRuntimeConfigSyncStatus(path, "staging", server),
    ])
      .then(async ([config, sync]) => {
        verificationFinished = true;
        const cached = await cachedReady;
        if (!active) return;
        if (config.authorizationRequired && cached === "true") {
          setRuntimeConfigReady(true);
          return;
        }
        const next =
          runtimeConfigStoredReady(config) && sync.stored && sync.synchronized;
        setRuntimeConfigReady(next);
        void setAppSetting(runtimeReadyKey, String(next)).catch(
          () => undefined,
        );
      })
      .catch(async () => {
        verificationFinished = true;
        const cached = await cachedReady;
        if (active) setRuntimeConfigReady(cached === "true");
      });
    return () => {
      active = false;
    };
  }, [path, runtimeReadyKey, server]);

  const updateRuntimeConfigReady = useCallback(
    (next: boolean) => {
      setRuntimeConfigReady(next);
      if (runtimeReadyKey)
        void setAppSetting(runtimeReadyKey, String(next)).catch(
          () => undefined,
        );
    },
    [runtimeReadyKey],
  );

  return {
    addressReady,
    cloudConfigReady,
    runtimeConfigReady,
    setAddressReady,
    setCloudConfigReady,
    setRuntimeConfigReady: updateRuntimeConfigReady,
  };
}

export function runtimeConfigReadyCacheKey(
  path: string,
  environment: "staging" | "production",
  server: ServerForm,
) {
  const target = `${server.user}@${server.host}:${server.port}`;
  return `project.${encodeURIComponent(path)}.${environment}-runtime-ready.${encodeURIComponent(target)}`;
}

export function stagingAddressConfigured(workspace: WorkspacePreview) {
  return (
    Object.keys(readEnvironmentDomains(workspace.manifestYaml, "staging"))
      .length > 0
  );
}

export function runtimeConfigStoredReady(config: RuntimeConfigFile) {
  if (!config.stored || config.authorizationRequired) return false;
  const values = new Map(
    parseEnvFields(config.content, config.requiredVariables).map((field) => [
      field.key,
      field.value,
    ]),
  );
  return config.requiredVariables.every(
    (variable) =>
      variable === "DATABASE_URL" ||
      variable === "REDIS_URL" ||
      Boolean(values.get(variable)?.trim()),
  );
}

export function runtimeVariableOptionalManifest(
  manifestYaml: string,
  variableName: string,
) {
  const document = parseDocument(manifestYaml);
  const manifest = document.toJS() as {
    services?: Array<{
      runtime_env?: Array<{ name?: string; required?: boolean }>;
    }>;
  };
  for (const [serviceIndex, service] of (manifest.services ?? []).entries()) {
    for (const [variableIndex, variable] of (
      service.runtime_env ?? []
    ).entries()) {
      if (variable.name === variableName) {
        document.setIn(
          ["services", serviceIndex, "runtime_env", variableIndex, "required"],
          false,
        );
      }
    }
  }
  return document.toString({ lineWidth: 0 });
}

function RepositoryPreparation({
  cnbAuthorizationSource,
  onCnbAuthorizationOpenChange,
  onError,
  onReady,
  onSaveManifest,
  repository,
  workspace,
}: {
  cnbAuthorizationSource: string;
  onCnbAuthorizationOpenChange: CnbAuthorizationOpenReporter;
  onError: (message: string) => void;
  onReady: (repository: string) => void;
  onSaveManifest: (manifestYaml: string) => Promise<boolean>;
  repository: string;
  workspace: WorkspacePreview;
}) {
  const [account, setAccount] = useState<CnbAccount | null>(null);
  const [accountError, setAccountError] = useState("");
  const [accountSlow, setAccountSlow] = useState(false);
  const [tokenDialog, setTokenDialog] = useState(false);
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [customRepository, setCustomRepository] = useState("");
  const [existingRepository, setExistingRepository] = useState("");
  const [editing, setEditing] = useState(false);
  const [repositoryAccessError, setRepositoryAccessError] = useState("");
  const [repositoryChecking, setRepositoryChecking] = useState(false);
  const [authorizationFeedback, setAuthorizationFeedback] =
    useState<CnbAuthorizationFeedback | null>(null);
  useCnbAuthorizationDialogVisibility(
    tokenDialog,
    `${cnbAuthorizationSource}:repository`,
    onCnbAuthorizationOpenChange,
  );
  const onReadyRef = useRef(onReady);
  const accountLoadSequence = useRef(0);
  const accountSlowTimer = useRef<number | null>(null);
  const loadAccount = useCallback(() => {
    const sequence = accountLoadSequence.current + 1;
    accountLoadSequence.current = sequence;
    if (accountSlowTimer.current !== null)
      window.clearTimeout(accountSlowTimer.current);
    setAccount(null);
    setAccountError("");
    setAccountSlow(false);
    accountSlowTimer.current = window.setTimeout(() => {
      if (accountLoadSequence.current === sequence) setAccountSlow(true);
    }, 2500);
    getCnbAccount()
      .then((next) => {
        if (accountLoadSequence.current !== sequence) return;
        if (accountSlowTimer.current !== null)
          window.clearTimeout(accountSlowTimer.current);
        accountSlowTimer.current = null;
        setAccount(next);
        setAccountError("");
        setAccountSlow(false);
      })
      .catch((error) => {
        if (accountLoadSequence.current !== sequence) return;
        if (accountSlowTimer.current !== null)
          window.clearTimeout(accountSlowTimer.current);
        accountSlowTimer.current = null;
        setAccount(null);
        setAccountError(toMessage(error));
        setAccountSlow(false);
      });
  }, []);
  useEffect(
    () => () => {
      accountLoadSequence.current += 1;
      if (accountSlowTimer.current !== null)
        window.clearTimeout(accountSlowTimer.current);
    },
    [],
  );
  useEffect(() => {
    // 已保存的仓库不依赖账号资料接口才能恢复；账号和组织信息只在首次
    // 选仓库时需要。这样慢网络或仓库级令牌不会挡住项目的既有配置。
    if (usableRepository(repository)) return;
    loadAccount();
  }, [loadAccount, repository]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    if (!usableRepository(repository)) {
      setRepositoryAccessError("");
      setRepositoryChecking(false);
      onReadyRef.current("");
      return;
    }
    let cancelled = false;
    setRepositoryAccessError("");
    setRepositoryChecking(true);
    // 已保存的仓库在背景重新核权时先保留当前显示状态。如果这里
    // 立即回传未完成，父层会收起并重新挂载此步骤，导致重复请求。
    // 只在服务端真正拒绝访问后才回退为未完成；首次保存仓库
    // 仍由 saveRepository 保证必须先通过核权。
    checkCnbRepositoryAccess(repository)
      .then((check) => {
        if (cancelled) return;
        const failure = cnbRepositoryAccessFailure(check);
        if (failure) {
          setRepositoryAccessError(failure);
          onReadyRef.current("");
          return;
        }
        setRepositoryAccessError("");
        onReadyRef.current(repository);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = toMessage(error);
        setRepositoryAccessError(message);
        onReadyRef.current("");
      })
      .finally(() => {
        if (!cancelled) setRepositoryChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);
  async function connect() {
    if (!token.trim()) return;
    setWorking(true);
    setAuthorizationFeedback(null);
    try {
      let connected: CnbAccount;
      try {
        connected = await connectCnb(
          token,
          true,
          usableRepository(repository) ? repository : undefined,
        );
      } catch (error) {
        setAuthorizationFeedback({
          message: cnbAuthorizationFeedbackMessage(error),
          title: "新令牌未保存，仍保留原来的 CNB 连接",
          tone: "error",
        });
        return;
      }
      setAccount(connected);
      setAccountError("");
      setToken("");
      setAuthorizationFeedback(null);
      if (usableRepository(repository)) {
        setRepositoryChecking(true);
        try {
          const check = await checkCnbRepositoryAccess(repository);
          const failure = cnbRepositoryAccessFailure(check);
          if (failure) throw new Error(failure);
          setRepositoryAccessError("");
          onReadyRef.current(repository);
          setTokenDialog(false);
        } catch (error) {
          const message = toMessage(error);
          setRepositoryAccessError(message);
          onReadyRef.current("");
          setAuthorizationFeedback({
            message: cnbAuthorizationFeedbackMessage(error),
            title: "新令牌已保存，但 CNB 仍拒绝读取当前仓库",
            tone: "error",
          });
        } finally {
          setRepositoryChecking(false);
        }
      } else {
        setRepositoryAccessError("");
        setTokenDialog(false);
      }
    } finally {
      setWorking(false);
    }
  }
  async function saveRepository(next: string) {
    try {
      const check = await checkCnbRepositoryAccess(next);
      const failure = cnbRepositoryAccessFailure(check);
      if (failure) throw new Error(failure);
      setRepositoryAccessError("");
    } catch (error) {
      setRepositoryAccessError(toMessage(error));
      return;
    }
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(["providers", "build", "repository"], next);
    document.setIn(["source", "repository"], next);
    const registryKind = document.getIn(["providers", "registry", "kind"]);
    if (registryKind === "cnb")
      document.setIn(["providers", "registry", "repository"], next);
    if (await onSaveManifest(document.toString({ lineWidth: 0 }))) {
      onReady(next);
      setEditing(false);
    }
  }
  async function create() {
    if (!account?.connected) return setTokenDialog(true);
    setWorking(true);
    try {
      const name = safeRepositoryName(workspace.inspection.project_name);
      const result = await ensureCnbRepository(account.defaultNamespace, name);
      if (result.created) {
        await saveRepository(result.repository);
      } else {
        setExistingRepository(result.repository);
      }
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }
  async function createAlternative() {
    if (!account?.connected) return;
    setWorking(true);
    try {
      const name = `${safeRepositoryName(workspace.inspection.project_name)}-deploy`;
      const result = await ensureCnbRepository(account.defaultNamespace, name);
      if (!result.created) {
        setExistingRepository(result.repository);
        onError(
          "建议的新仓库名称也已存在，请填写一个确认属于当前项目的已有仓库",
        );
        return;
      }
      setExistingRepository("");
      await saveRepository(result.repository);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }
  const authorizationDialog = (
    <CnbAuthorizationDialog
      description="连接后，授权会统一保存在本机。创建令牌时需要同时设置授权范围和使用范围。"
      feedback={authorizationFeedback}
      fieldId="cnb-token"
      fieldLabel="访问令牌"
      onOpenChange={(open) => {
        setTokenDialog(open);
        if (!open) setAuthorizationFeedback(null);
      }}
      onSubmit={() => void connect()}
      onTokenChange={(value) => {
        setToken(value);
        setAuthorizationFeedback(null);
      }}
      open={tokenDialog}
      repository={usableRepository(repository) ? repository : undefined}
      submitLabel="验证账号并连接"
      title="连接 CNB"
      token={token}
      working={working}
    />
  );
  const repositoryIssue = repositoryAccessError
    ? issueFromUnknown(repositoryAccessError)
    : null;
  if (!editing && usableRepository(repository)) {
    return (
      <>
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-xs text-[var(--muted-foreground)]">
              {account?.connected
                ? `CNB 账号：${account.displayName}`
                : "CNB 代码仓库"}
            </span>
            <strong className="mt-1 block text-sm">{repository}</strong>
            <span
              className={`mt-1 block text-xs ${repositoryIssue ? "text-[var(--warning)]" : repositoryChecking ? "text-[var(--muted-foreground)]" : "text-[var(--success)]"}`}
            >
              {repositoryIssue
                ? repositoryIssue.title
                : repositoryChecking
                  ? "正在检查代码仓库"
                  : "代码仓库可用"}
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-[var(--muted-foreground)]">
              授权统一保存在本机；只有使用范围包含此仓库时才能复用。
            </span>
          </div>
          <div className="flex gap-1">
            <Button
              onClick={() => setTokenDialog(true)}
              size="sm"
              variant="ghost"
            >
              更新授权
            </Button>
            <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
              更换仓库
            </Button>
          </div>
        </div>
        {authorizationDialog}
      </>
    );
  }
  return (
    <>
      <p className="m-0 text-sm leading-6 text-[var(--muted-foreground)]">
        用于保存项目代码，并在代码更新后自动生成测试版本。
      </p>
      {(accountError || accountSlow) && !account?.connected ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-[var(--warning-soft)] px-3 py-2.5 text-sm">
          <div>
            <strong className="block">
              {accountError
                ? "暂时无法读取已保存的代码平台账号"
                : "读取已保存的代码平台账号用时较长"}
            </strong>
            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
              {accountError
                ? "不用重复填写，可以先重试；仍未恢复时再重新连接账号。"
                : "不用一直等待，可以重试；仍未恢复时再重新连接账号。"}
            </span>
          </div>
          <div className="flex gap-2">
            <Button onClick={loadAccount} size="sm" variant="secondary">
              重试读取
            </Button>
            <Button onClick={() => setTokenDialog(true)} size="sm">
              重新连接
            </Button>
          </div>
        </div>
      ) : account === null ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="size-4 animate-spin-slow" />
          正在读取已保存的 CNB 授权
        </div>
      ) : account?.connected ? (
        <div className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 text-[var(--success)]" />
            <span>
              <span className="block">CNB 账号：{account.displayName}</span>
              <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                已安全保存在本机；使用范围包含项目仓库时可以复用
              </span>
            </span>
          </span>
          <Button
            onClick={() => setTokenDialog(true)}
            size="sm"
            variant="ghost"
          >
            更新授权
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-[var(--warning-soft)] px-3 py-2.5 text-sm">
          <span>还没有连接 CNB 账号</span>
          <Button onClick={() => setTokenDialog(true)} size="sm">
            连接 CNB
          </Button>
        </div>
      )}
      {repositoryIssue ? (
        <div className="mt-4">
          <IssueBanner
            action={
              <Button onClick={() => setTokenDialog(true)} size="sm">
                <KeyRound />
                更新授权
              </Button>
            }
            message={repositoryIssue.message}
            nextStep={repositoryIssue.nextSteps[0]}
            technicalCode={repositoryIssue.code}
            technicalDetails={repositoryIssue.technicalDetails}
            title={repositoryIssue.title}
          />
        </div>
      ) : null}
      {account?.connected ? (
        <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--muted)]/35 p-4">
          {existingRepository ? (
            <div className="mb-4 rounded-md border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-3">
              <strong className="block text-sm">发现同名代码仓库</strong>
              <p className="mb-3 mt-1 text-xs text-[var(--muted-foreground)]">
                {existingRepository}{" "}
                可能属于旧项目。确认后再复用，客户端不会直接覆盖。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void saveRepository(existingRepository)}
                  size="sm"
                  variant="secondary"
                >
                  确认复用
                </Button>
                <Button
                  disabled={working}
                  onClick={() => void createAlternative()}
                  size="sm"
                >
                  创建新仓库
                </Button>
              </div>
            </div>
          ) : null}
          <span className="text-xs text-[var(--muted-foreground)]">
            推荐创建
          </span>
          <strong className="mt-1 block text-sm">
            {safeRepositoryName(workspace.inspection.project_name)} · 私有仓库
          </strong>
          <p className="mb-4 mt-1 text-xs text-[var(--muted-foreground)]">
            只有你和授权成员可以访问，原项目文件不会被删除。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={working} onClick={() => void create()} size="sm">
              {working ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <FolderGit2 />
              )}
              创建代码仓库
            </Button>
            <div className="flex min-w-[320px] flex-1 gap-2 max-[760px]:min-w-0 max-[760px]:basis-full max-[760px]:flex-col">
              <Input
                aria-label="已有代码仓库"
                onChange={(event) => {
                  setCustomRepository(event.target.value);
                  setRepositoryAccessError("");
                }}
                placeholder="或填写已有仓库，例如 team/project"
                value={customRepository}
              />
              <Button
                disabled={!customRepository.includes("/")}
                onClick={() => void saveRepository(customRepository.trim())}
                className="max-[760px]:w-full"
                size="sm"
                variant="secondary"
              >
                使用已有仓库
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {authorizationDialog}
    </>
  );
}

export function ServerPreparation({
  environment = "staging",
  initialServer,
  onError,
  onReady,
  path,
}: {
  environment?: "staging" | "production";
  initialServer?: ServerForm;
  onError: (message: string) => void;
  onReady: (server: ServerForm) => void;
  path: string;
}) {
  const [form, setForm] = useState<ServerForm>(
    initialServer ?? {
      name: environment === "production" ? "正式服务器" : "测试服务器",
      host: "",
      user: "ubuntu",
      port: 22,
      keyPath: "",
    },
  );
  const [working, setWorking] = useState(false);
  const [fingerprint, setFingerprint] = useState("");
  const [editing, setEditing] = useState(false);
  const [savedServers, setSavedServers] = useState<ServerResource[]>([]);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [connectionIssue, setConnectionIssue] = useState("");
  const automaticReuseStarted = useRef(false);
  useEffect(() => {
    if (initialServer) setForm(initialServer);
  }, [initialServer]);
  useEffect(() => {
    let active = true;
    listServers()
      .then((servers) => {
        if (!active) return;
        const reusable = servers.filter(
          (server) => server.keyPathExists && Boolean(server.hostFingerprint),
        );
        setSavedServers(reusable);
        if (
          !initialServer &&
          reusable.length === 1 &&
          !automaticReuseStarted.current
        ) {
          automaticReuseStarted.current = true;
          const selected = serverFormFromResource(reusable[0]);
          setForm(selected);
          void connect(false, selected);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [initialServer, path]);

  async function finishConnection(next: ServerForm) {
    const bound = await bindProjectServer(path, environment, next);
    const ready = {
      ...next,
      hostFingerprint: bound.hostFingerprint ?? next.hostFingerprint,
    };
    setForm(ready);
    setEditing(false);
    setFingerprint("");
    setPasswordRequired(false);
    setPassword("");
    setConnectionIssue("");
    onReady(ready);
  }

  async function connect(
    confirmFingerprint = false,
    selectedForm: ServerForm = form,
  ) {
    setWorking(true);
    setConnectionIssue("");
    try {
      let next = {
        ...selectedForm,
        hostFingerprint: confirmFingerprint
          ? fingerprint
          : selectedForm.hostFingerprint,
      };
      const reusable = reusableServer(next, await listServers());
      if (reusable) {
        next = {
          ...next,
          name: reusable.name,
          keyPath: reusable.keyPath,
          hostFingerprint: reusable.hostFingerprint,
        };
        setForm(next);
      }
      if (!next.keyPath) {
        const identities = await discoverSshIdentities();
        const identity =
          identities[0] ?? (await generateSshIdentity()).identity;
        next = { ...next, keyPath: identity.path };
        setForm(next);
      }
      const result = await checkServer(next);
      if (
        !result.ok &&
        result.provider === "ssh-host-key" &&
        result.details[0]
      ) {
        setForm(next);
        setFingerprint(result.details[0]);
        return;
      }
      if (!result.ok && result.code === "AD-SSH-105") {
        setForm(next);
        setFingerprint("");
        setPasswordRequired(true);
        setConnectionIssue(result.summary);
        return;
      }
      if (!result.ok) {
        setConnectionIssue(result.summary);
        throw new Error(result.summary);
      }
      await finishConnection(next);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function installAccess() {
    if (!password) return;
    setWorking(true);
    setConnectionIssue("");
    try {
      const result = await installServerKeyWithPassword(form, password);
      setPassword("");
      if (!result.ok) {
        setConnectionIssue(result.summary);
        return;
      }
      await finishConnection(form);
    } catch (error) {
      setPassword("");
      const message = toMessage(error);
      setConnectionIssue(message);
      onError(message);
    } finally {
      setWorking(false);
    }
  }

  async function chooseExistingIdentity() {
    const selected = await selectPrivateKey(form.keyPath || undefined);
    if (!selected) return;
    const next = { ...form, keyPath: selected };
    setForm(next);
    setPassword("");
    setPasswordRequired(false);
    setConnectionIssue("");
    await connect(false, next);
  }
  if (!editing && initialServer?.hostFingerprint)
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <strong className="text-sm">
            {initialServer.name || "运行服务器"}
          </strong>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {initialServer.user}@{initialServer.host}:{initialServer.port}
          </span>
          <span className="mt-1 block text-xs text-[var(--success)]">
            服务器信息已保存
            <span className="mt-1 block text-[var(--muted-foreground)]">
              部署时如果连接失效，系统会在当前步骤提示处理
            </span>
          </span>
        </div>
        <Button
          onClick={() => {
            setForm({ ...initialServer, hostFingerprint: undefined });
            setEditing(true);
          }}
          size="sm"
          variant="ghost"
        >
          更换或修复连接
        </Button>
      </div>
    );
  return (
    <>
      <p className="m-0 text-sm text-[var(--muted-foreground)]">
        填写云服务器的公网 IP 和登录用户名。后续安全连接由系统自动处理。
      </p>
      {savedServers.length ? (
        <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--muted)]/35 p-3">
          <strong className="text-sm">使用已保存的服务器</strong>
          <div className="mt-2 grid gap-2">
            {savedServers.map((server) => {
              const selected = serverFormFromResource(server);
              return (
                <div
                  className="flex items-center justify-between gap-3 rounded-md bg-[var(--surface)] px-3 py-2 max-[760px]:flex-col max-[760px]:items-stretch"
                  key={server.id}
                >
                  <span className="text-xs text-[var(--muted-foreground)]">
                    <strong className="mr-2 text-[var(--foreground)]">
                      {server.name}
                    </strong>
                    {server.user}@{server.host}:{server.port}
                  </span>
                  <Button
                    disabled={working}
                    onClick={() => {
                      setForm(selected);
                      void connect(false, selected);
                    }}
                    className="max-[760px]:w-full"
                    size="sm"
                    variant="secondary"
                  >
                    使用这台服务器
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-[minmax(240px,1fr)_160px_100px] gap-3 max-[760px]:grid-cols-1">
        <div className="space-y-1.5">
          <Label htmlFor="server-host">服务器公网 IP</Label>
          <Input
            id="server-host"
            onChange={(event) => {
              const host = event.target.value;
              setPassword("");
              setPasswordRequired(false);
              setConnectionIssue("");
              setForm((current) => ({
                ...current,
                host,
                ...(host === current.host
                  ? {}
                  : { hostFingerprint: undefined, keyPath: "" }),
              }));
            }}
            placeholder="例如 123.123.123.123"
            value={form.host}
          />
          <span className="block text-[11px] leading-4 text-[var(--muted-foreground)]">
            在云服务器控制台的实例详情中复制“公网 IP”。
          </span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="server-user">登录用户名</Label>
          <Input
            id="server-user"
            onChange={(event) => {
              const user = event.target.value;
              setPassword("");
              setPasswordRequired(false);
              setConnectionIssue("");
              setForm((current) => ({
                ...current,
                user,
                ...(user === current.user
                  ? {}
                  : { hostFingerprint: undefined, keyPath: "" }),
              }));
            }}
            placeholder="例如 ubuntu"
            value={form.user}
          />
          <span className="block text-[11px] leading-4 text-[var(--muted-foreground)]">
            Ubuntu 通常是 ubuntu，其他系统可在实例详情中查看。
          </span>
        </div>
        <div className="flex items-end">
          <Button
            className="w-full"
            disabled={working || !form.host || !form.user}
            onClick={() => void connect()}
          >
            {working ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Server />
            )}
            连接
          </Button>
        </div>
      </div>
      {fingerprint ? (
        <div className="mt-4 rounded-md border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-4">
          <strong className="text-sm">确认连接这台服务器</strong>
          <p className="my-2 text-xs leading-5 text-[var(--muted-foreground)]">
            你正在连接 {form.host}
            。如果这是你刚才填写的服务器，请确认；系统会记住它，今后身份变化时会阻止连接。
          </p>
          <details className="rounded-md border border-[var(--warning)]/20 bg-[var(--surface)]/65 px-3 py-2 text-xs">
            <summary className="cursor-pointer text-[var(--muted-foreground)]">
              查看服务器指纹
            </summary>
            <code className="mt-2 block break-all">{fingerprint}</code>
          </details>
          <div className="mt-3">
            <Button
              disabled={working}
              onClick={() => void connect(true)}
              size="sm"
            >
              确认这是我的服务器
            </Button>
          </div>
        </div>
      ) : null}
      {passwordRequired ? (
        <div className="mt-4 rounded-md border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-4">
          <strong className="text-sm">还差一次服务器授权</strong>
          <p className="mb-3 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
            {connectionIssue || "服务器还不认识这台电脑。"}
            填写当前登录用户的服务器密码，ABCDeploy
            会建立后续自动连接；密码只使用这一次，不会保存。
          </p>
          <div className="grid grid-cols-[minmax(240px,1fr)_auto] items-end gap-3 max-[760px]:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="server-password">服务器登录密码</Label>
              <Input
                autoComplete="off"
                id="server-password"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </div>
            <Button
              className="max-[760px]:w-full"
              disabled={working || !password}
              onClick={() => void installAccess()}
            >
              {working ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <KeyRound />
              )}
              建立安全连接
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--warning)]/20 pt-3 max-[760px]:flex-col max-[760px]:items-stretch">
            <span className="text-xs text-[var(--muted-foreground)]">
              创建服务器时下载过登录文件？可以直接使用，不需要密码。
            </span>
            <Button
              disabled={working}
              onClick={() => void chooseExistingIdentity()}
              className="max-[760px]:w-full"
              size="sm"
              variant="secondary"
            >
              改用已有登录文件
            </Button>
          </div>
        </div>
      ) : connectionIssue ? (
        <p className="mb-0 mt-3 text-xs text-[var(--warning)]">
          {connectionIssue}
        </p>
      ) : null}
    </>
  );
}

export function reusableServer(
  form: ServerForm,
  servers: ServerResource[],
): ServerResource | undefined {
  const host = form.host.trim().toLowerCase();
  const user = form.user.trim();
  return servers.find(
    (server) =>
      server.keyPathExists &&
      server.host.trim().toLowerCase() === host &&
      server.user.trim() === user &&
      server.port === form.port,
  );
}

export function serverFormFromResource(server: ServerResource): ServerForm {
  return {
    name: server.name,
    host: server.host,
    user: server.user,
    port: server.port,
    keyPath: server.keyPath,
    hostFingerprint: server.hostFingerprint,
  };
}

function TestAddressPreparation({
  onReadyChange,
  onSaveManifest,
  saving,
  server,
  workspace,
}: {
  onReadyChange: (ready: boolean) => void;
  onSaveManifest: (manifest: string) => Promise<boolean>;
  saving: boolean;
  server?: ServerForm;
  workspace: WorkspacePreview;
}) {
  const [generating, setGenerating] = useState(false);
  const [domainReady, setDomainReady] = useState(() =>
    stagingAddressConfigured(workspace),
  );
  const [stored, setStored] = useState(() =>
    stagingAddressConfigured(workspace),
  );
  useEffect(() => {
    if (!domainReady) setStored(false);
  }, [domainReady]);
  useEffect(
    () => onReadyChange(stored && domainReady),
    [domainReady, onReadyChange, stored],
  );
  const automaticDomains = automaticTestDomains(workspace, server);
  async function generateAutomaticAddress() {
    if (!automaticDomains) return;
    setGenerating(true);
    try {
      const document = parseDocument(workspace.manifestYaml);
      document.setIn(
        ["environments", "staging", "domains"],
        Object.entries(automaticDomains).map(([service, host]) => ({
          service,
          host,
          path: "/",
        })),
      );
      if (await onSaveManifest(document.toString({ lineWidth: 0 }))) {
        setDomainReady(true);
        setStored(true);
      }
    } finally {
      setGenerating(false);
    }
  }
  if (stored)
    return (
      <div className="flex items-center justify-between">
        <div>
          <strong className="text-sm">测试域名已设置</strong>
          <span className="mt-1 block text-xs text-[var(--success)]">
            部署完成后可以直接打开
          </span>
        </div>
        <Button onClick={() => setStored(false)} size="sm" variant="ghost">
          重新设置
        </Button>
      </div>
    );
  return (
    <div>
      <p className="m-0 text-sm text-[var(--muted-foreground)]">
        测试版需要一个访问域名，系统会自动配置访问和 HTTPS。
      </p>
      {automaticDomains ? (
        <div className="mt-4 flex items-center justify-between rounded-md bg-[var(--muted)] px-3 py-3">
          <span className="text-sm">没有测试域名也可以继续</span>
          <Button
            disabled={saving || generating}
            onClick={() => void generateAutomaticAddress()}
            size="sm"
            variant="secondary"
          >
            {generating ? <LoaderCircle className="animate-spin-slow" /> : null}
            自动生成测试地址
          </Button>
        </div>
      ) : null}
      <div className="mt-4">
        <DomainFields
          environment="staging"
          onReadyChange={setDomainReady}
          onSaveManifest={onSaveManifest}
          saving={saving}
          workspace={workspace}
        />
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          disabled={!domainReady}
          onClick={() => setStored(true)}
          size="sm"
        >
          确认测试地址
        </Button>
      </div>
    </div>
  );
}

export function automaticTestDomains(
  workspace: WorkspacePreview,
  server?: ServerForm,
): Record<string, string> | null {
  const octets = server?.host
    .trim()
    .split(".")
    .map((part) => Number(part));
  if (
    !octets ||
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  const project = workspace.inspection.project_name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const address = octets.join("-");
  return Object.fromEntries(
    workspace.inspection.services
      .filter((service) => service.kind !== "worker")
      .map((service) => {
        const id = service.id
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20);
        return [service.id, `${project}-${id}-test.${address}.sslip.io`];
      }),
  );
}

function DomainFields({
  environment,
  onReadyChange,
  onSaveManifest,
  saving,
  workspace,
}: {
  environment: "staging" | "production";
  onReadyChange: (ready: boolean) => void;
  onSaveManifest: (manifest: string) => Promise<boolean>;
  saving: boolean;
  workspace: WorkspacePreview;
}) {
  const services = useMemo(
    () =>
      workspace.inspection.services.filter(
        (service) => service.kind !== "worker",
      ),
    [workspace.inspection.services],
  );
  const [domains, setDomains] = useState(() =>
    readEnvironmentDomains(workspace.manifestYaml, environment),
  );
  const missingServices = services.filter(
    (service) => !domains[service.id]?.trim(),
  );
  useEffect(() => {
    const next = readEnvironmentDomains(workspace.manifestYaml, environment);
    setDomains(next);
    onReadyChange(
      services.length > 0 &&
        services.every((service) => Boolean(next[service.id])),
    );
  }, [environment, onReadyChange, services, workspace.manifestYaml]);
  async function save() {
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", environment, "domains"],
      services
        .filter((service) => domains[service.id]?.trim())
        .map((service) => ({
          service: service.id,
          host: domains[service.id].trim(),
          path: "/",
        })),
    );
    const success = await onSaveManifest(document.toString({ lineWidth: 0 }));
    if (success)
      onReadyChange(
        services.every((service) => Boolean(domains[service.id]?.trim())),
      );
  }
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)]">
      {services.map((service, index) => (
        <div
          className="grid grid-cols-[180px_1fr] items-center gap-3 border-b border-[var(--border)] px-3 py-3 last:border-b-0 max-[760px]:grid-cols-1 max-[760px]:gap-1.5"
          key={service.id}
        >
          <Label htmlFor={`${environment}-${service.id}`}>
            {serviceDisplayName(
              service.id,
              service.kind,
              index,
              services.length,
            )}
          </Label>
          <Input
            id={`${environment}-${service.id}`}
            onChange={(event) =>
              setDomains((current) => ({
                ...current,
                [service.id]: event.target.value,
              }))
            }
            placeholder={
              environment === "production"
                ? "例如 app.example.com"
                : "例如 test.example.com"
            }
            value={domains[service.id] ?? ""}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] px-3 py-2.5 max-[760px]:flex-col max-[760px]:items-stretch">
        <span
          className={`text-xs ${missingServices.length ? "text-[var(--warning)]" : "text-[var(--success)]"}`}
        >
          {missingServices.length
            ? `还缺少：${missingServices.map((service, index) => serviceDisplayName(service.id, service.kind, index, services.length)).join("、")}`
            : "所有服务地址都已填写"}
        </span>
        <Button
          className="max-[760px]:w-full"
          disabled={saving || Boolean(missingServices.length)}
          onClick={() => void save()}
          size="sm"
        >
          保存{environment === "production" ? "正式" : "测试"}地址
        </Button>
      </div>
    </div>
  );
}

function SetupDependencyNotice({
  message,
  title,
}: {
  message: string;
  title: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--muted)]/35 px-3 py-3">
      <Circle className="mt-0.5 size-4 shrink-0 text-[var(--subtle-foreground)]" />
      <div>
        <strong className="block text-sm">{title}</strong>
        <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">
          {message}
        </span>
      </div>
    </div>
  );
}

function PreparationStep({
  activeLabel = "现在完成",
  children,
  checking = false,
  current,
  description,
  done,
  index,
  name,
  onOpen,
  open,
}: {
  activeLabel?: string;
  children: React.ReactNode;
  checking?: boolean;
  current: boolean;
  description: string;
  done: boolean;
  index: number;
  name: string;
  onOpen: () => void;
  open: boolean;
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border bg-[var(--surface)] ${open ? "border-[var(--accent)]/45" : "border-[var(--border)]"}`}
    >
      <button
        className={`grid w-full grid-cols-[32px_1fr_auto] items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)] ${done && !open ? "min-h-[52px]" : "min-h-[68px]"}`}
        onClick={onOpen}
        type="button"
      >
        <span
          className={`grid size-7 place-items-center rounded-full text-xs ${done ? "bg-[var(--success)] text-white" : current && !checking ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}
        >
          {done ? (
            "✓"
          ) : checking ? (
            <LoaderCircle className="size-3.5 animate-spin-slow" />
          ) : (
            index
          )}
        </span>
        <span>
          <strong className="block text-sm font-semibold">{name}</strong>
          <span
            className={`mt-1 text-xs text-[var(--muted-foreground)] ${done && !open ? "hidden" : "block"}`}
          >
            {description}
          </span>
        </span>
        <span
          className={
            done
              ? "text-xs text-[var(--success)]"
              : "text-xs text-[var(--muted-foreground)]"
          }
        >
          {done
            ? "已准备"
            : checking
              ? "正在确认"
              : current
                ? activeLabel
                : open
                  ? "正在查看"
                  : "随后处理"}{" "}
          ›
        </span>
      </button>
      {open ? (
        <div className="border-t border-[var(--border)] px-5 py-5 pl-[64px]">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function DeploymentState({
  action,
  compactCheckStatus,
  compactMessage,
  compactTitle,
  messageOverride,
  onError,
  onRefresh,
  pauseAutoRecheck = false,
  run,
  secondaryAction,
}: {
  action?: React.ReactNode;
  compactCheckStatus?: string;
  compactMessage?: string;
  compactTitle?: string;
  messageOverride?: string;
  onError: (message: string) => void;
  onRefresh: (run: DeploymentRun) => Promise<DeploymentRun>;
  pauseAutoRecheck?: boolean;
  run: DeploymentRun;
  secondaryAction?: React.ReactNode;
}) {
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState("");
  const initialRecheck = useRef("");
  const checkingRef = useRef(false);
  const runRef = useRef(run);
  const onRefreshRef = useRef(onRefresh);
  const onErrorRef = useRef(onError);
  runRef.current = run;
  onRefreshRef.current = onRefresh;
  onErrorRef.current = onError;
  const active = run.status === "queued" || run.status === "running";
  const issue = run.status === "failed" || run.status === "needs_action";
  const recheckOnReturn = autoRechecksDeployment(run);
  const stateMessage = messageOverride || deploymentStateMessage(run);
  const userIssue = issue
    ? issueFromUnknown(
        run.issueCode ? `${run.issueCode}：${stateMessage}` : stateMessage,
        deploymentTitle(run),
      )
    : null;
  const title = compactTitle ?? userIssue?.title ?? stateMessage;
  const message = compactTitle
    ? (compactMessage ?? "")
    : (userIssue?.message ?? stateMessage);
  const milestones = deploymentMilestones(run);
  const recordUpdatedAt = deploymentUpdatedAtLabel(run.updatedAt);
  const completedMilestones = milestones
    .filter((milestone) => milestone.state === "done")
    .map((milestone) => milestone.label);
  const activeMilestone =
    milestones.find((milestone) => milestone.state === "active")?.label ??
    stageLabel(run.currentStage);
  const refresh = useCallback(async (announceFailure = false) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckFailed(false);
    try {
      const checked = await onRefreshRef.current(runRef.current);
      if (checked) {
        setLastCheckedAt(
          new Intl.DateTimeFormat("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(new Date()),
        );
      }
    } catch {
      setCheckFailed(true);
      if (announceFailure) {
        onErrorRef.current("状态检查没有完成，当前任务和已完成步骤仍然保留");
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (!recheckOnReturn || pauseAutoRecheck) return;
    let timer = 0;
    let interval = 0;
    const scheduleRecheck = (identity = "") => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (identity) initialRecheck.current = identity;
        void refresh();
      }, 500);
    };
    const recheckOnFocus = () => scheduleRecheck();
    window.addEventListener("focus", recheckOnFocus);
    document.addEventListener("visibilitychange", recheckOnFocus);
    const recheckIdentity = `${run.id}:${run.actionKind ?? ""}:${run.issueCode ?? ""}`;
    if (initialRecheck.current !== recheckIdentity) {
      // 恢复项目时父层还会补齐任务、版本和配置。只有定时器真正执行时
      // 才记录“已经自动复核”，避免中途重渲染取消定时器后永远不再检查。
      scheduleRecheck(recheckIdentity);
    }
    interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, EXTERNAL_STATUS_RECHECK_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", recheckOnFocus);
      document.removeEventListener("visibilitychange", recheckOnFocus);
    };
  }, [
    pauseAutoRecheck,
    recheckOnReturn,
    refresh,
    run.actionKind,
    run.id,
    run.issueCode,
  ]);
  return (
    <div
      className={`rounded-lg border p-5 ${issue ? "border-[var(--warning)]/35 bg-[var(--warning-soft)]" : run.status === "success" ? "border-[var(--success)]/25 bg-[var(--success-soft)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
    >
      <div className="flex items-start justify-between gap-4 max-[760px]:flex-col max-[760px]:items-stretch">
        <div className="flex gap-3">
          {active ? (
            <LoaderCircle className="mt-0.5 size-5 animate-spin-slow text-[var(--accent)]" />
          ) : issue ? (
            <AlertCircle className="mt-0.5 size-5 text-[var(--warning)]" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-5 text-[var(--success)]" />
          )}
          <div>
            <strong className="text-sm">{title}</strong>
            {compactTitle && message ? (
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--foreground)]/80">
                {message}
              </p>
            ) : issue && message !== title ? (
              <p className="mb-0 mt-1 text-xs leading-5 text-[var(--foreground)]/80">
                {message}
              </p>
            ) : null}
            {!compactTitle && (issue || active) ? (
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                {issue
                  ? `任务停在：${activeMilestone}`
                  : `当前进度：${activeMilestone}`}
              </p>
            ) : null}
            {!compactTitle && issue && completedMilestones.length ? (
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                已经完成：{completedMilestones.join("、")}
              </p>
            ) : null}
            {!compactTitle && issue ? (
              <p className="mb-0 mt-2 text-xs font-medium text-[var(--foreground)]">
                下一步：{deploymentNextStep(run, userIssue?.nextSteps[0])}
              </p>
            ) : null}
            {!compactTitle && recheckOnReturn ? (
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                前往网页或云平台处理后直接回来即可；回来时会立即检查，停留本页时也会每
                30 秒自动检查。
              </p>
            ) : null}
            {lastCheckedAt && !checking ? (
              <p
                aria-live="polite"
                className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]"
              >
                {compactTitle ? (
                  <>
                    最近检查：{lastCheckedAt}
                    {run.actionKind === "route-check"
                      ? ` · ${compactCheckStatus ?? "地址还未生效"}`
                      : ""}
                  </>
                ) : run.status === "success" ? (
                  <>
                    最近检查：{lastCheckedAt} ·{" "}
                    {run.environment === "production"
                      ? "正式版服务仍在服务器运行"
                      : "测试版仍在服务器运行"}
                  </>
                ) : (
                  <>已于 {lastCheckedAt} 重新检查，任务记录已保存</>
                )}
              </p>
            ) : recordUpdatedAt && (active || issue) && !checking ? (
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                {compactTitle ? "任务记录：" : "任务记录更新于 "}
                <time dateTime={run.updatedAt}>{recordUpdatedAt}</time>
                {compactTitle ? "" : "，已完成步骤已保存"}
              </p>
            ) : null}
            {checkFailed && !checking ? (
              <p
                aria-live="polite"
                className="mb-0 mt-2 text-xs font-medium text-[var(--warning)]"
              >
                {run.status === "success"
                  ? "这次检查没有完成，仍显示上一次部署结果；请确认网络后再次点击“检查运行状态”。"
                  : `这次检查没有完成，任务仍停在这里；请确认网络后再次点击“${deploymentRefreshLabel(run)}”。`}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {secondaryAction}
          {action}
          {!action && run.actionUrl ? (
            <Button
              onClick={() => void openUrl(run.actionUrl ?? "")}
              size="sm"
              variant="secondary"
            >
              <ExternalLink />
              {issue ? "前往处理" : "查看发布记录"}
            </Button>
          ) : null}
          {!action && run.status !== "failed" && run.status !== "cancelled" ? (
            <Button
              disabled={checking}
              onClick={() => void refresh(true)}
              size="sm"
              variant="secondary"
            >
              <RefreshCw className={checking ? "animate-spin-slow" : ""} />
              {checking ? "正在检查" : deploymentRefreshLabel(run)}
            </Button>
          ) : null}
        </div>
      </div>
      {active || (issue && !compactTitle) ? (
        <div className="mt-4 space-y-3">
          <Progress value={deploymentProgress(run)} />
          <div className="grid grid-cols-4 gap-2" aria-label="本次部署进度">
            {milestones.map((milestone) => (
              <div
                className={`flex items-center gap-1.5 text-[11px] ${milestone.state === "done" ? "text-[var(--success)]" : milestone.state === "active" ? (issue ? "font-medium text-[var(--warning)]" : "font-medium text-[var(--foreground)]") : "text-[var(--subtle-foreground)]"}`}
                key={milestone.label}
              >
                {milestone.state === "done" ? (
                  <CheckCircle2 className="size-3.5 shrink-0" />
                ) : milestone.state === "active" ? (
                  issue ? (
                    <AlertCircle className="size-3.5 shrink-0" />
                  ) : (
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin-slow text-[var(--accent)]" />
                  )
                ) : (
                  <Circle className="size-3.5 shrink-0" />
                )}
                <span>{milestone.label}</span>
              </div>
            ))}
          </div>
          <p className="m-0 text-[11px] leading-5 text-[var(--muted-foreground)]">
            {issue
              ? `这次任务和已完成步骤都已保留；处理后会从“${activeMilestone}”继续。`
              : "可以离开当前页面，远程任务会继续运行。"}
          </p>
        </div>
      ) : null}
      {issue ? (
        <details className="mt-4 text-xs text-[var(--muted-foreground)]">
          <summary className="cursor-pointer">查看技术详情</summary>
          <div className="mt-2">
            错误编号：{run.issueCode ?? "未提供"} · 仓库：
            {run.repository || "尚未确定"}
          </div>
          {userIssue?.technicalDetails.length ? (
            <div className="mt-2 space-y-1">
              {userIssue.technicalDetails.map((detail, index) => (
                <code
                  className="block max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]"
                  key={`${run.id}:${index}`}
                >
                  {detail}
                </code>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function CurrentVersionBanner({
  label,
  run,
}: {
  label: string;
  run: DeploymentRun;
}) {
  return (
    <div
      aria-label={label}
      className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
    >
      <div className="min-w-0">
        <span className="block text-xs text-[var(--muted-foreground)]">
          {label}
        </span>
        <strong className="mt-1 block truncate text-sm">
          {versionTitle(run)}
        </strong>
      </div>
      <span
        className="max-w-[60%] truncate text-xs text-[var(--muted-foreground)]"
        title={versionMeta(run)}
      >
        {versionMeta(run)}
      </span>
    </div>
  );
}

function StatusRow({
  action,
  detail,
  label,
  state,
  status,
}: {
  action?: React.ReactNode;
  detail: string;
  label: string;
  state: "active" | "idle" | "success" | "warning";
  status: string;
}) {
  return (
    <div className="flex min-h-[66px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0 max-[760px]:flex-wrap max-[760px]:py-3">
      <span
        aria-hidden="true"
        className={`a11y-status-dot size-2 shrink-0 rounded-full ${state === "success" ? "bg-[var(--success)]" : state === "warning" ? "bg-[var(--warning)]" : state === "active" ? "bg-[var(--accent)]" : "bg-[var(--muted-strong)]"}`}
        data-status={state}
      />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium">{label}</strong>
        <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
          {detail}
        </span>
      </span>
      <span
        className={`text-xs ${state === "success" ? "text-[var(--success)]" : state === "warning" ? "text-[var(--warning)]" : state === "active" ? "font-medium text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
      >
        {status}
      </span>
      {action ? (
        <div className="flex gap-2 max-[760px]:basis-full max-[760px]:flex-wrap max-[760px]:justify-end max-[760px]:pl-5">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  children,
  title,
  trailing,
}: {
  children: React.ReactNode;
  title: string;
  trailing?: string;
}) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {trailing ? (
          <span className="text-xs text-[var(--muted-foreground)]">
            {trailing}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PageHeading({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-5 max-[760px]:flex-col max-[760px]:items-stretch">
      <div>
        <h1 className="m-0 text-2xl font-semibold">{title}</h1>
        <p className="mb-0 mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function IssueBanner({
  action,
  message,
  nextStep,
  technicalCode,
  technicalDetails,
  title,
}: {
  action?: React.ReactNode;
  message: string;
  nextStep?: string;
  technicalCode?: string;
  technicalDetails?: string[];
  title: string;
}) {
  return (
    <div
      className="mb-5 flex items-start justify-between gap-5 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-3 max-[760px]:flex-col max-[760px]:items-stretch"
      role="alert"
    >
      <div>
        <strong className="text-sm">{title}</strong>
        <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
          {message}
        </p>
        {nextStep ? (
          <p className="mb-0 mt-2 text-xs font-medium leading-5">
            下一步：{nextStep}
          </p>
        ) : null}
        {technicalDetails?.length ? (
          <details className="mt-2 text-xs text-[var(--muted-foreground)]">
            <summary className="cursor-pointer">查看技术详情</summary>
            {technicalCode ? (
              <div className="mt-2">错误编号：{technicalCode}</div>
            ) : null}
            <div className="mt-2 space-y-1">
              {technicalDetails.map((detail, index) => (
                <code
                  className="block max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]"
                  key={`${technicalCode ?? "issue"}:${index}`}
                >
                  {detail}
                </code>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function DeploymentBlockerBanner({
  deploying,
  message,
  onDeployCommitted,
  onOpenSetup,
  onRetry,
}: {
  deploying: boolean;
  message: string;
  onDeployCommitted: () => void;
  onOpenSetup?: () => void;
  onRetry?: () => void;
}) {
  const issue = issueFromUnknown(message, "测试版还没有部署成功");
  const shouldCheckSetup = [
    "AD-CFG-",
    "AD-SSH-",
    "AD-SRV-",
    "AD-IMG-",
    "AD-DB-",
    "AD-CACHE-",
    "AD-INF-",
    "AD-CNB-101",
    "AD-CNB-103",
  ].some((prefix) => issue.code.startsWith(prefix));
  return (
    <IssueBanner
      action={
        issue.code === "AD-GIT-101" ? (
          <Button disabled={deploying} onClick={onDeployCommitted} size="sm">
            {deploying ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <Rocket />
            )}
            部署已提交版本
          </Button>
        ) : shouldCheckSetup && onOpenSetup ? (
          <Button
            disabled={deploying}
            onClick={onOpenSetup}
            size="sm"
            variant="secondary"
          >
            <Tags />
            检查上线设置
          </Button>
        ) : onRetry ? (
          <Button disabled={deploying} onClick={onRetry} size="sm">
            {deploying ? (
              <LoaderCircle className="animate-spin-slow" />
            ) : (
              <RefreshCw />
            )}
            重新尝试
          </Button>
        ) : undefined
      }
      message={issue.message}
      nextStep={issue.nextSteps[0]}
      technicalCode={issue.code}
      technicalDetails={issue.technicalDetails}
      title={issue.title}
    />
  );
}

function SuccessBanner({
  action,
  message,
  title,
}: {
  action?: React.ReactNode;
  message: string;
  title: string;
}) {
  return (
    <div className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--success)]/25 bg-[var(--success-soft)] px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
        <div>
          <strong className="text-sm">{title}</strong>
          <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
            {message}
          </p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function NoticeBanner({ message, title }: { message: string; title: string }) {
  return (
    <div className="my-5 flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--muted)]/45 px-4 py-3">
      <Square className="mt-0.5 size-4 text-[var(--muted-foreground)]" />
      <div>
        <strong className="text-sm">{title}</strong>
        <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
          {message}
        </p>
      </div>
    </div>
  );
}

function ChoiceCard({
  checked,
  description,
  label,
  onClick,
}: {
  checked: boolean;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={checked}
      className={`rounded-lg border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${checked ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
      onClick={onClick}
      type="button"
    >
      <strong className="block text-sm">{label}</strong>
      <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
        {description}
      </span>
    </button>
  );
}

function localInfrastructureRequirements(
  workspace: WorkspacePreview,
): Array<"postgres" | "redis"> {
  const variables = new Set(
    workspace.inspection.environment_variables.map((item) => item.name),
  );
  const result: Array<"postgres" | "redis"> = [];
  if (
    workspace.inspection.prisma_schemas.length ||
    variables.has("DATABASE_URL")
  )
    result.push("postgres");
  if (variables.has("REDIS_URL")) result.push("redis");
  return result;
}

function serviceDisplayName(
  id: string,
  kind: string,
  index: number,
  total: number,
) {
  const normalized = id.toLowerCase();
  if (normalized.includes("admin")) return "管理后台";
  if (normalized === "api" || normalized.includes("backend")) return "后端服务";
  if (normalized.includes("web") || normalized.includes("frontend"))
    return "用户网站";
  const base =
    kind === "api" ? "后端服务" : kind === "worker" ? "任务服务" : "网页服务";
  return total > 1 ? `${base} · ${id}` : base || `项目服务 ${index + 1}`;
}

function readRepository(manifestYaml: string) {
  try {
    const value = parseDocument(manifestYaml).getIn([
      "providers",
      "build",
      "repository",
    ]);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function usableRepository(repository: string) {
  return Boolean(
    repository &&
    repository.includes("/") &&
    !repository.includes("replace-me") &&
    !repository.startsWith("owner/"),
  );
}

function usableRegistryNamespace(namespace: string) {
  const value = namespace.trim();
  return Boolean(value && !value.includes("replace-me"));
}

export function inferredReleaseSetupBlocker(
  manifestYaml: string,
  stagingServer: ServerForm | undefined,
  storedStep: string | null | undefined,
): ReleaseSetupBlocker {
  const repository = readRepository(manifestYaml);
  if (!usableRepository(repository)) return "source-connection";

  const storedBlocker = legacySetupStepBlocker(storedStep);
  const registry = readRegistry(manifestYaml);
  if (
    registry.kind !== "cnb" &&
    (!usableRegistryNamespace(registry.namespace) ||
      !storedBlocker ||
      storedBlocker === "registry-connection")
  ) {
    return "registry-connection";
  }
  if (!stagingServer) return "test-server";
  if (
    storedBlocker === "test-config" ||
    storedBlocker === "test-address" ||
    storedBlocker === "automation"
  ) {
    return storedBlocker;
  }
  // The manifest and server do not prove that required runtime values are
  // present. The focused task panel verifies the saved bindings and advances
  // to address/automation without asking the user to navigate elsewhere.
  return "test-config";
}

function readRegistry(manifestYaml: string): {
  endpoint: string;
  kind: "cnb" | "tcr" | "oci";
  namespace: string;
  repository: string;
} {
  try {
    const document = parseDocument(manifestYaml);
    const kindValue = String(
      document.getIn(["providers", "registry", "kind"]) ?? "cnb",
    );
    const kind =
      kindValue === "tcr" ? "tcr" : kindValue === "oci" ? "oci" : "cnb";
    return {
      endpoint: String(
        document.getIn([
          "providers",
          "registry",
          kind === "tcr" ? "registry" : "push_registry",
        ]) ?? "",
      ),
      kind,
      namespace: String(
        document.getIn(["providers", "registry", "namespace"]) ?? "",
      ),
      repository: String(
        document.getIn(["providers", "registry", "repository"]) ?? "",
      ),
    };
  } catch {
    return { endpoint: "", kind: "cnb", namespace: "", repository: "" };
  }
}

export function tcrRegistryManifest(manifestYaml: string, namespace: string) {
  const document = parseDocument(manifestYaml);
  document.setIn(["providers", "registry"], {
    kind: "tcr",
    registry: "ccr.ccs.tencentyun.com",
    namespace: namespace.trim(),
  });
  return document.toString({ lineWidth: 0 });
}

function versionLabel(run: DeploymentRun) {
  return `${formatRunTime(run.startedAt)} 的版本`;
}

export function versionTitle(run: DeploymentRun) {
  return primaryVersionTitle(run.sourceTitle) || versionLabel(run);
}

export function versionComparisonTitle(run: DeploymentRun) {
  const title = primaryVersionTitle(run.sourceTitle);
  return title
    ? `${title}（${formatRunTime(run.startedAt)}）`
    : versionLabel(run);
}

function deploymentAttemptLabel(run: DeploymentRun) {
  return `${formatRunTime(run.startedAt)} 的部署`;
}

export function availableVersionRuns(runs: DeploymentRun[]) {
  return runs.filter((run) => run.status === "success");
}

export function versionMeta(run: DeploymentRun) {
  const title = friendlyVersionTitle(run.sourceTitle);
  const revision = `代码 ${shortRevision(run)}`;
  if (!title) return revision;
  return primaryVersionTitle(run.sourceTitle)
    ? `${formatRunTime(run.startedAt)} · ${revision}`
    : `修改说明：${title} · ${revision}`;
}

function versionKey(run: DeploymentRun) {
  return deploymentVersionKey(run);
}

export function isOlderVersion(
  candidate: DeploymentRun,
  current: DeploymentRun | undefined,
) {
  if (!current || versionKey(candidate) === versionKey(current)) return false;
  const candidateTime = Date.parse(candidate.startedAt);
  const currentTime = Date.parse(current.startedAt);
  return (
    Number.isFinite(candidateTime) &&
    Number.isFinite(currentTime) &&
    candidateTime < currentTime
  );
}

export function productionConfirmationMessage({
  candidateTitle,
  currentTitle,
  restoring,
  target,
}: {
  candidateTitle: string;
  currentTitle?: string;
  restoring: boolean;
  target?: string;
}) {
  const targetLabel = target ? `正式网站（${target}）` : "正式网站";
  if (!currentTitle) {
    return `${targetLabel}将使用“${candidateTitle}”。这是测试通过的同一版本，不会重新构建。`;
  }
  return `${targetLabel}将从“${currentTitle}”${restoring ? "恢复" : "切换"}到“${candidateTitle}”。这是测试通过的${restoring ? "历史" : "同一"}版本，不会重新构建；如果目标版本启动失败，系统会自动恢复“${currentTitle}”。`;
}

function versionKeyForSource(
  sourceRunId: string | null | undefined,
  runs: DeploymentRun[],
) {
  if (!sourceRunId) return "";
  const source = runs.find((run) => run.id === sourceRunId);
  return source ? versionKey(source) : sourceRunId;
}

/**
 * Transitional adapter while deployment commands still accept the successful
 * staging run that produced a Version. Display facts come from ProjectVersion;
 * the real run id is retained only as the command hand-off identifier.
 */
export function deploymentRunForProjectVersion(
  version: ProjectVersion,
  stagingAttempts: DeploymentRun[],
  projectPath: string,
  projectName: string,
): DeploymentRun {
  const successfulAttempts = stagingAttempts.filter(
    (run) =>
      run.environment === "staging" &&
      run.status === "success" &&
      run.actionKind !== "production-approval",
  );
  const matchingRun =
    successfulAttempts.find((run) => run.id === version.stagingRunId) ??
    successfulAttempts.find(
      (run) => deploymentVersionKey(run) === version.versionKey,
    );
  if (matchingRun) return matchingRun;

  return {
    id:
      version.stagingRunId ??
      version.validation?.runId ??
      `version:${version.id}`,
    projectPath,
    projectName: projectName || "project",
    environment: "staging",
    status: "success",
    currentStage: "complete",
    buildSerial: version.sourceBuildId,
    commitSha: version.commitSha,
    sourceTitle: version.sourceTitle,
    sourceRunId: null,
    candidateTag: version.candidateTag,
    artifacts: version.artifacts,
    // A successful run can still carry the access hand-off used to inspect
    // that version (for example a local secure preview tunnel). Preserve the
    // hand-off without inheriting any failure state from deployment history.
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: version.repository ?? "",
    branch: version.branch ?? "main",
    message: "不可变版本已生成",
    completedSteps: ["complete"],
    startedAt: version.createdAt || version.updatedAt,
    updatedAt: version.updatedAt || version.createdAt,
  };
}

function collapseVersionRuns(runs: DeploymentRun[]) {
  const versions = new Map<string, DeploymentRun>();
  for (const run of runs) {
    const key = versionKey(run);
    const current = versions.get(key);
    if (!current || versionRunRank(run) > versionRunRank(current)) {
      versions.set(key, run);
    }
  }
  return Array.from(versions.values()).sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

function versionRunRank(run: DeploymentRun) {
  if (run.status === "success") return 5;
  if (isDeployedRun(run)) return 4;
  if (run.status === "running") return 3;
  if (run.status === "queued") return 2;
  if (run.status === "needs_action") return 1;
  return 0;
}

function isDeployedRun(run: DeploymentRun) {
  return (
    run.status === "success" ||
    (run.status === "needs_action" && run.artifacts.length > 0)
  );
}

function formatRunTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function safeRepositoryName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "abcdeploy-project"
  );
}

function readEnvironmentDomains(
  manifestYaml: string,
  environment: "staging" | "production",
) {
  try {
    const data = parseDocument(manifestYaml).toJS() as {
      environments?: Record<
        string,
        { domains?: Array<{ service?: string; host?: string }> }
      >;
    };
    return Object.fromEntries(
      (data.environments?.[environment]?.domains ?? [])
        .filter((item) => item.service && item.host)
        .map((item) => [item.service as string, item.host as string]),
    );
  } catch {
    return {};
  }
}

function productionDomainsReady(workspace: WorkspacePreview) {
  const domains = readEnvironmentDomains(workspace.manifestYaml, "production");
  const services = workspace.inspection.services.filter(
    (service) => service.kind !== "worker",
  );
  return (
    services.length > 0 &&
    services.every((service) => Boolean(domains[service.id]))
  );
}

function secretReferenceReady(
  workspace: WorkspacePreview,
  environment: "staging" | "production",
) {
  const reference = parseDocument(workspace.manifestYaml).getIn([
    "environments",
    environment,
    "secrets_ref",
  ]);
  return (
    typeof reference === "string" &&
    reference.includes("cnb.cool/") &&
    !reference.includes("replace-me")
  );
}

export function secretRepositoryFromManifest(
  workspace: WorkspacePreview,
  environment: "staging" | "production",
) {
  const reference = parseDocument(workspace.manifestYaml).getIn([
    "environments",
    environment,
    "secrets_ref",
  ]);
  if (typeof reference !== "string" || reference.includes("replace-me"))
    return "";
  return reference.match(/^https:\/\/cnb\.cool\/(.+?)\/-\/blob\//)?.[1] ?? "";
}

function suggestedSecretRepository(workspace: WorkspacePreview) {
  const repository = readRepository(workspace.manifestYaml);
  if (repository.includes("/")) {
    const [namespace] = repository.split("/");
    return `${namespace}/${safeRepositoryName(workspace.inspection.project_name)}-secrets`;
  }
  return `owner/${safeRepositoryName(workspace.inspection.project_name)}-secrets`;
}

async function copyText(value: string) {
  if ("__TAURI_INTERNALS__" in window) {
    await writeText(value);
    return;
  }
  if (!navigator.clipboard)
    throw new Error("当前环境无法使用剪贴板，请在桌面客户端中重试");
  await navigator.clipboard.writeText(value);
}

export async function clearClipboardIfUnchanged(value: string) {
  if (!value) return false;
  try {
    if ("__TAURI_INTERNALS__" in window) {
      if ((await readText()) !== value) return false;
      await clearClipboard();
      return true;
    }
    if (
      !navigator.clipboard ||
      typeof navigator.clipboard.readText !== "function"
    )
      return false;
    if ((await navigator.clipboard.readText()) !== value) return false;
    await navigator.clipboard.writeText("");
    return true;
  } catch {
    // Clipboard access is best-effort. A successful deployment setup must not
    // be turned into an error if the operating system refuses a cleanup read.
    return false;
  }
}

function productionAddress(workspace: WorkspacePreview) {
  return environmentAddresses(workspace, "production")[0]?.host ?? "";
}

export function testAddress(workspace: WorkspacePreview, server?: ServerForm) {
  return (
    environmentAddresses(workspace, "staging", server)[0]?.url ??
    "测试地址将在部署后显示"
  );
}

export function environmentAddresses(
  workspace: WorkspacePreview,
  environment: "staging" | "production",
  server?: ServerForm,
) {
  const domains = readEnvironmentDomains(workspace.manifestYaml, environment);
  const services = workspace.inspection.services.filter(
    (service) => service.kind !== "worker",
  );
  const addresses = services
    .map((service, index) => {
      const host = domains[service.id]?.trim();
      if (!host) return null;
      const website =
        service.kind === "web" ||
        service.kind === "static" ||
        /(^|[-_])(web|h5|site|frontend|admin)([-_]|$)/i.test(service.id);
      const scheme =
        environment === "staging" && host.toLowerCase().endsWith(".sslip.io")
          ? "http"
          : "https";
      return {
        service: service.id,
        label: serviceDisplayName(
          service.id,
          service.kind,
          index,
          services.length,
        ),
        host,
        url: `${scheme}://${host}`,
        priority: website ? 0 : service.kind === "api" ? 1 : 2,
        index,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort(
      (left, right) =>
        left.priority - right.priority || left.index - right.index,
    )
    .map(({ index: _index, priority: _priority, ...item }) => item);
  if (addresses.length || environment === "production" || !server?.host)
    return addresses;
  return [
    {
      service: "server",
      label: "测试地址",
      host: server.host,
      url: `http://${server.host}`,
    },
  ];
}

export function dnsRecordTypeForTarget(target?: string): "A" | "AAAA" {
  return target?.includes(":") ? "AAAA" : "A";
}

function deploymentStatus(run: DeploymentRun) {
  if (run.issueCode === "AD-NET-202") return "地址检查中断";
  if (run.actionKind === "route-check") return "还差设置地址";
  if (run.actionKind === "route-repair") return "地址未生效";
  if (run.status === "queued") return "等待系统开始";
  if (run.status === "running")
    return run.environment === "production"
      ? "正在发布正式版"
      : "正在部署测试版";
  if (run.status === "needs_action")
    return deploymentNeedsActionStatus(run.environment, run.actionKind);
  if (run.status === "success")
    return run.environment === "production"
      ? "正式版可以访问"
      : "测试版可以使用";
  if (run.status === "failed")
    return run.environment === "production"
      ? "正式发布没有完成"
      : "测试部署没有完成";
  return "已取消";
}

export function deploymentStateMessage(run: DeploymentRun) {
  if (run.status === "success") {
    return run.environment === "production"
      ? "正式版正在使用测试通过的同一版本，访问地址正常"
      : "测试版正在正常运行，可以打开并确认功能";
  }
  return run.message;
}

export function deploymentUpdatedAtLabel(
  value: string,
  reference = new Date(),
) {
  const updated = new Date(value);
  if (Number.isNaN(updated.getTime())) return "";
  const sameDay =
    updated.getFullYear() === reference.getFullYear() &&
    updated.getMonth() === reference.getMonth() &&
    updated.getDate() === reference.getDate();
  if (sameDay) {
    return `今天 ${new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(updated)}`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year:
      updated.getFullYear() === reference.getFullYear() ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(updated);
}

export function autoRechecksDeployment(run: DeploymentRun) {
  return (
    run.status === "needs_action" &&
    [
      "route-check",
      "route-repair",
      "route-takeover",
      "verify-release",
      "cnb-builds",
    ].includes(run.actionKind ?? "")
  );
}

export function deploymentRefreshLabel(run: DeploymentRun) {
  if (run.actionKind === "route-check")
    return run.environment === "production"
      ? "检查并完成发布"
      : "检查并打开测试版";
  if (run.actionKind === "route-repair") return "重新检查地址";
  if (run.status === "needs_action" && run.issueCode === "AD-CTR-201")
    return "检查服务原因";
  if (
    run.status === "needs_action" &&
    run.currentStage === "healthcheck" &&
    run.artifacts.length
  )
    return "重新检查服务";
  if (run.status === "needs_action") return "重新检查部署结果";
  if (run.status === "queued" || run.status === "running") return "刷新进度";
  if (run.status === "success") return "检查运行状态";
  return "重新检查结果";
}

export function deploymentNextStep(run: DeploymentRun, fallback = "") {
  if (["AD-CNB-101", "AD-CNB-103"].includes(run.issueCode ?? ""))
    return "点击“更新 CNB 授权”，保存新令牌后继续当前任务";
  if (run.issueCode === "AD-CNB-202")
    return run.environment === "production"
      ? "点击“重新发布同一版本”，继续使用已经测试通过的版本"
      : "点击“重新部署当前代码”，重新创建远程测试任务";
  if (run.actionKind === "retry-staging-preparation")
    return "点击“继续当前部署”，系统会从刚才中断的位置重新检查并继续同一个任务";
  if (run.actionKind === "retry-production-preparation")
    return "点击“重新发布同一版本”，系统会继续同一个正式发布任务";
  if (run.issueCode === "AD-CTR-201")
    return run.status === "needs_action"
      ? "点击“检查服务原因”，系统会读取启动日志并给出具体处理建议"
      : "点击下方“检查后重新部署”，系统会重新核对服务状态";
  if (run.issueCode === "AD-NET-202")
    return "确认本机网络可用后点击“检查并完成发布”；系统只检查地址，不会重新部署";
  if (run.actionKind === "route-check") {
    return run.environment === "production"
      ? "设置好域名后点击“检查并完成发布”，不会重新部署服务"
      : "点击“打开测试版”，系统会在这台电脑建立临时访问地址，不会重新部署项目";
  }
  if (run.actionKind === "route-repair")
    return "点击“重新应用地址”，只修复访问入口，不会重新生成版本";
  if (run.actionKind === "cloud-setup")
    return "完成当前上线设置后返回这里，继续部署同一份代码";
  if (
    run.status === "needs_action" &&
    run.currentStage === "healthcheck" &&
    run.artifacts.length
  )
    return fallback
      ? `${fallback}；处理后点击“重新检查服务”`
      : "按上面的提示处理后，点击“重新检查服务”";
  if (run.status === "failed")
    return run.environment === "production"
      ? "查看原因并处理后，重新发布同一个测试通过版本"
      : "处理失败原因后，重新部署测试版";
  if (run.status === "needs_action")
    return fallback || "完成上面提示后，点击“重新检查部署结果”";
  return fallback || "等待当前操作完成";
}

function deploymentTitle(run: DeploymentRun) {
  if (run.issueCode === "AD-NET-202")
    return run.environment === "production"
      ? "正式版已经部署，地址检查暂时中断"
      : "测试版已经部署，地址检查暂时中断";
  if (run.actionKind === "route-check")
    return run.environment === "production"
      ? "正式版已经部署"
      : "测试版已经部署";
  if (run.actionKind === "route-repair")
    return run.environment === "production"
      ? "正式版地址没有生效"
      : "测试版地址没有生效";
  if (run.status === "success")
    return run.environment === "production"
      ? "正式版已上线"
      : "测试版已经可以使用";
  if (run.status === "failed")
    return run.environment === "production"
      ? "正式发布没有完成"
      : "测试版部署没有完成";
  if (run.status === "needs_action")
    return deploymentNeedsActionStatus(run.environment, run.actionKind);
  return run.environment === "production" ? "正在发布正式版" : "正在部署测试版";
}

function stageLabel(stage: string) {
  return (
    (
      {
        queued: "等待开始",
        prepare: "准备部署",
        "cloud-setup": "保存远程配置",
        "prepare-config": "准备运行配置",
        build: "构建项目",
        publish: "发送项目",
        "prepare-server": "准备运行服务器",
        deploy: "启动服务",
        healthcheck: "检查服务和地址",
        "verify-release": "确认版本可用",
        rollback: "恢复上个版本",
        complete: "已经完成",
      } as Record<string, string>
    )[stage] ?? stage
  );
}

export function deploymentMilestones(run: DeploymentRun) {
  const completed = new Set(run.completedSteps);
  const currentStage = run.currentStage;
  const successful = run.status === "success";
  const awaitingAddressConfirmation =
    ["failed", "needs_action"].includes(run.status) &&
    ["route-check", "route-repair", "route-takeover"].includes(
      run.actionKind ?? "",
    );
  const milestones = [
    {
      label: "准备项目",
      done: completed.has("write-config"),
      stages: ["queued", "prepare", "cloud-setup", "prepare-config"],
    },
    {
      label: run.environment === "production" ? "确认版本" : "生成版本",
      done: completed.has("verify-build") && completed.has("publish-images"),
      stages: ["build", "publish"],
    },
    {
      label: "启动服务",
      done: completed.has("prepare-server") && completed.has("deploy"),
      stages: ["prepare-server", "deploy"],
    },
    {
      label: awaitingAddressConfirmation
        ? run.environment === "production"
          ? "确认正式地址"
          : "确认测试地址"
        : "确认可用",
      done: completed.has("healthcheck"),
      addressConfirmation: true,
      stages: ["verify-release", "healthcheck", "complete"],
    },
  ];
  return milestones.map((milestone) => ({
    label: milestone.label,
    state:
      awaitingAddressConfirmation && milestone.addressConfirmation
        ? ("active" as const)
        : successful || milestone.done
          ? ("done" as const)
          : milestone.stages.includes(currentStage)
            ? ("active" as const)
            : ("pending" as const),
  }));
}

function deploymentProgress(run: DeploymentRun) {
  const steps = [
    "write-config",
    "verify-build",
    "publish-images",
    "prepare-server",
    "deploy",
    "healthcheck",
  ];
  const completedProgress = Math.round(
    (run.completedSteps.filter((step) => steps.includes(step)).length /
      steps.length) *
      100,
  );
  const stageFloor =
    {
      queued: 5,
      prepare: 10,
      "cloud-setup": 10,
      "prepare-config": 15,
      build: 30,
      publish: 50,
      "prepare-server": 60,
      deploy: 70,
      "verify-release": 82,
      healthcheck: 90,
      complete: 100,
    }[run.currentStage] ?? 0;
  return Math.max(completedProgress, stageFloor);
}

function shortRevision(run: DeploymentRun) {
  return run.commitSha
    ? run.commitSha.slice(0, 8)
    : (run.candidateTag ?? "当前测试版本");
}

function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分钟`;
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
