import { LoaderCircle } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { parseDocument } from "yaml";
import {
  applyManifest,
  bindProjectServer,
  bootstrapServerCaddy,
  beginDeploymentAttempt,
  continueExistingDeployment,
  createDeploymentTask,
  forgetProject,
  getAppSetting,
  getAppSettings,
  getProjectServer,
  getPreflight,
  listActiveDeploymentRuns,
  listAttentionDeploymentRuns,
  listDeploymentRuns,
  listRecentSuccessfulDeploymentRuns,
  listRecentProjects,
  listVersionValidations,
  openProject,
  pauseDeploymentTask,
  previewManifest,
  refreshDeployment,
  relinkProject,
  resetProjectDeployment,
  resumeStagingDeployment,
  saveManifestDraft,
  saveProjectStep,
  selectProjectDirectory,
  setAppSetting,
  setVersionValidation,
  startDeploymentPath,
  startStagingDeployment,
  syncExternalDeployments,
  syncProjectToCnb,
} from "./api";
import { ApplicationFrame } from "./components/ApplicationFrame";
import { ConfigurationCenter } from "./components/ConfigurationCenter";
import { ExistingDeploymentChoice } from "./components/ExistingDeploymentChoice";
import { secretRepositoryFromManifest } from "./components/ProductWorkspace";
import { ProjectGallery } from "./components/ProjectGallery";
import { issueFromUnknown } from "./lib/errors";
import {
  deploymentVersionKey,
  deploymentVersionVerified,
  projectVerificationTask,
  projectSetupProgressStage,
  verifiedRunIdsFromSetting,
  verifiedVersionKeysFromSetting,
  type ProjectSetupTask,
  type ProjectVerificationTask,
} from "./lib/projects";
import type {
  DeploymentRun,
  RecentProject,
  ServerForm,
  SystemPreflight,
  VersionValidation,
  WorkspacePreview,
} from "./types";

const DeploymentPathWorkspace = lazy(() =>
  import("./components/DeploymentPathWorkspace").then((module) => ({
    default: module.DeploymentPathWorkspace,
  })),
);

type AppScreen = "home" | "configuration" | "project";
type ProjectScene =
  "overview" | "local" | "versions" | "settings" | "test" | "production";
type ProjectTaskPanel = "settings" | "test" | "production";
type ProjectLoadMode = "recognizing" | "restoring";
export type ProjectSelectionIssue = {
  message: string;
  title: string;
};
type ProjectNavigationIntent = {
  scene: ProjectScene;
  productionVersionId: string;
  taskPanel?: ProjectTaskPanel;
};

const ACTIVE_DEPLOYMENT_REFRESH_MS = 8_000;
const IDLE_DEPLOYMENT_REFRESH_MS = 60_000;
const EXTERNAL_DEPLOYMENT_REFRESH_MS = 30_000;
const PRODUCTION_ROUTE_REFRESH_MS = 5 * 60_000;

export function deploymentRefreshDelay(hasActiveRuns: boolean) {
  return hasActiveRuns
    ? ACTIVE_DEPLOYMENT_REFRESH_MS
    : IDLE_DEPLOYMENT_REFRESH_MS;
}

export function shouldApplyProjectResult(
  currentPath: string,
  requestedPath: string,
) {
  return Boolean(requestedPath) && currentPath === requestedPath;
}

export function deploymentRepositoryReady(manifestYaml: string) {
  try {
    const repository = parseDocument(manifestYaml).getIn([
      "providers",
      "build",
      "repository",
    ]);
    return (
      typeof repository === "string" &&
      repository.includes("/") &&
      !repository.includes("replace-me") &&
      !repository.startsWith("owner/")
    );
  } catch {
    return false;
  }
}

export function workspaceAllowsExternalSync(
  workspace: Pick<WorkspacePreview, "adoption">,
) {
  return (
    workspace.adoption.mode === "managed" ||
    (workspace.adoption.mode === "fresh" && !workspace.adoption.freshDraft)
  );
}

function reusableServerForm(
  server: Awaited<ReturnType<typeof getProjectServer>> | undefined,
): ServerForm | undefined {
  return server?.keyPathExists && server.hostFingerprint
    ? {
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        keyPath: server.keyPath,
        hostFingerprint: server.hostFingerprint,
      }
    : undefined;
}

function useAppForeground() {
  const [foreground, setForeground] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const windowFocused = useRef(true);

  useEffect(() => {
    const onFocus = () => {
      windowFocused.current = true;
      setForeground(document.visibilityState !== "hidden");
    };
    const onBlur = () => {
      windowFocused.current = false;
      setForeground(false);
    };
    const onVisibilityChange = () => {
      setForeground(
        document.visibilityState !== "hidden" && windowFocused.current,
      );
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return foreground;
}

export function shouldRefreshDeploymentStatus(screen: AppScreen) {
  return screen === "project";
}

export function shouldReuseProjectWorkspace(
  currentPath: string,
  targetPath: string,
  hasWorkspace: boolean,
) {
  return hasWorkspace && currentPath === targetPath;
}

export function deploymentSceneForProject(
  project: Pick<
    RecentProject,
    "latestActionKind" | "latestEnvironment" | "latestStatus"
  >,
): ProjectScene {
  if (project.latestEnvironment === "production") return "production";
  if (
    project.latestStatus === "needs_action" &&
    ["cloud-config", "cloud-setup"].includes(project.latestActionKind ?? "")
  ) {
    return "settings";
  }
  return "test";
}

export function deploymentVersionForProject(
  project: Pick<RecentProject, "latestEnvironment" | "latestSourceRunId">,
) {
  return project.latestEnvironment === "production"
    ? (project.latestSourceRunId ?? null)
    : null;
}

export function deploymentSceneForRun(
  run: Pick<DeploymentRun, "actionKind" | "environment" | "status">,
): ProjectScene {
  if (run.environment === "production") return "production";
  if (
    run.status === "needs_action" &&
    ["cloud-config", "cloud-setup"].includes(run.actionKind ?? "")
  ) {
    return "settings";
  }
  return "test";
}

export function deploymentVersionForRun(
  run: Pick<DeploymentRun, "environment" | "sourceRunId">,
) {
  return run.environment === "production" ? (run.sourceRunId ?? null) : null;
}

export function deploymentTaskRuns(
  activeRuns: DeploymentRun[],
  attentionRuns: DeploymentRun[],
) {
  const merged = new Map<string, DeploymentRun>();
  for (const run of [...attentionRuns, ...activeRuns]) merged.set(run.id, run);
  return Array.from(merged.values()).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function mergeDeploymentRun(
  current: DeploymentRun[],
  next: DeploymentRun,
) {
  const merged = current.some((run) => run.id === next.id)
    ? current.map((run) => (run.id === next.id ? next : run))
    : [...current, next];
  // `updatedAt` answers “when was this task checked”, not “which deployment
  // is newer”. A manual refresh of an old record must never make it the
  // current test or production deployment.
  return merged.sort((left, right) => {
    const byStartedAt = right.startedAt.localeCompare(left.startedAt);
    return byStartedAt || right.id.localeCompare(left.id);
  });
}

export function setupSceneForTask(task: ProjectSetupTask): ProjectScene {
  if (task.stage === "first-deploy") return "test";
  if (
    task.environment === "production" &&
    ["creation-page-opened", "repository-ready", "save-page-opened"].includes(
      task.stage,
    )
  ) {
    return "production";
  }
  return "settings";
}

export function projectSceneFromSetting(
  value: string | null,
): ProjectScene | undefined {
  if (value === "test" || value === "production") return "overview";
  return value && ["overview", "local", "versions", "settings"].includes(value)
    ? (value as ProjectScene)
    : undefined;
}

export function projectSelectionIssueFromMessage(
  message: string,
): ProjectSelectionIssue | null {
  if (
    /至少需要声明一个可部署服务|没有识别到(?:可运行|可部署)?服务|未发现(?:可运行|可部署)?服务/.test(
      message,
    )
  ) {
    return {
      title: "没有识别到项目服务",
      message:
        "这通常是文件夹层级不对。请重新选择包含前后端等完整代码的最外层文件夹。",
    };
  }
  return null;
}

export function sameProjectPath(left: string, right: string) {
  const normalize = (value: string) => {
    const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:\//.test(normalized)
      ? normalized.toLocaleLowerCase()
      : normalized;
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function App() {
  const [screen, setScreen] = useState<AppScreen>("home");
  const [, setPreflight] = useState<SystemPreflight | null>(null);
  const [, setPreflightChecking] = useState(true);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [workspace, setWorkspace] = useState<WorkspacePreview | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [runs, setRuns] = useState<DeploymentRun[]>([]);
  const [activeRuns, setActiveRuns] = useState<DeploymentRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<DeploymentRun[]>([]);
  const [, setCompletedRuns] = useState<DeploymentRun[]>([]);
  const [setupTasks, setSetupTasks] = useState<ProjectSetupTask[]>([]);
  const [verificationTasks, setVerificationTasks] = useState<
    ProjectVerificationTask[]
  >([]);
  const [releaseReadyPaths, setReleaseReadyPaths] = useState<string[]>([]);
  const [, setStagingServer] = useState<ServerForm | undefined>();
  const [, setProductionServer] = useState<ServerForm | undefined>();
  const [loading, setLoading] = useState(true);
  const [selectingProject, setSelectingProject] = useState(false);
  const [, setSaving] = useState(false);
  const [cnbAuthorizationOpen] = useState(false);
  const [adoptionAction, setAdoptionAction] = useState<
    "continue" | "reset" | null
  >(null);
  const [projectViewRevision, setProjectViewRevision] = useState(0);
  const [, setProjectNavigationIntent] =
    useState<ProjectNavigationIntent | null>(null);
  const [, setProjectInitialScene] = useState<ProjectScene>();
  const [projectLoadMode, setProjectLoadMode] =
    useState<ProjectLoadMode>("restoring");
  const [recognizedProjectPath, setRecognizedProjectPath] = useState("");
  const [projectSelectionIssue, setProjectSelectionIssue] =
    useState<ProjectSelectionIssue | null>(null);
  const activeRunsRefresh = useRef<Promise<boolean> | null>(null);
  const activeRunsRef = useRef<DeploymentRun[]>([]);
  const currentProjectPath = useRef("");
  const externalProjectRefreshes = useRef(
    new Map<string, Promise<DeploymentRun[]>>(),
  );
  const skipNextExternalProjectSync = useRef(new Set<string>());
  const productionRouteCheckedAt = useRef(new Map<string, number>());
  const guidanceTaskLoadRequest = useRef(0);
  const preflightRequest = useRef(0);
  const projectLoadRequest = useRef(0);
  const projectSelectionPending = useRef(false);
  const projectWorkspaceReady = workspace !== null;
  const appForeground = useAppForeground();
  activeRunsRef.current = activeRuns;
  currentProjectPath.current = projectPath;
  const taskRuns = deploymentTaskRuns(activeRuns, attentionRuns);

  const reportError = useCallback((message: string) => {
    const issue = issueFromUnknown(message, "当前操作没有完成");
    toast.error(issue.title, {
      description: [
        issue.message,
        issue.nextSteps[0] ? `下一步：${issue.nextSteps[0]}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      duration: 9000,
    });
  }, []);

  const refreshPreflight = useCallback(
    async (announceFailure = false) => {
      const request = ++preflightRequest.current;
      setPreflightChecking(true);
      try {
        const system = await getPreflight();
        if (request === preflightRequest.current) setPreflight(system);
      } catch {
        if (request !== preflightRequest.current) return;
        setPreflight(null);
        if (announceFailure) {
          reportError(
            "本机环境检查没有完成，当前项目和部署记录不受影响；请稍后重新检查",
          );
        }
      } finally {
        if (request === preflightRequest.current) setPreflightChecking(false);
      }
    },
    [reportError],
  );

  const refreshProjectGuidanceTasks = useCallback(
    async (recentProjects: RecentProject[]) => {
      const request = ++guidanceTaskLoadRequest.current;
      const readableProjects = recentProjects.filter(
        (project) => project.pathExists,
      );
      const settingKeys = readableProjects.flatMap((project) => {
        const prefix = `project.${encodeURIComponent(project.path)}`;
        return [
          `${prefix}.cnb-secret-progress.staging`,
          `${prefix}.cnb-secret-progress.production`,
          `${prefix}.version-setup-active`,
          `${prefix}.version-setup-step`,
          `${prefix}.version-setup-complete`,
          `${prefix}.verified-run`,
          `${prefix}.verified-version`,
          `${prefix}.rejected-version`,
        ];
      });
      const settings = await getAppSettings(settingKeys).catch(
        (): Record<string, string> => ({}),
      );
      const discovered = await Promise.all(
        readableProjects.map(async (project) => {
          const setupPrefix = `project.${encodeURIComponent(project.path)}`;
          const staging =
            settings[`${setupPrefix}.cnb-secret-progress.staging`] ?? null;
          const production =
            settings[`${setupPrefix}.cnb-secret-progress.production`] ?? null;
          const setupActive =
            settings[`${setupPrefix}.version-setup-active`] ?? null;
          const setupStep =
            settings[`${setupPrefix}.version-setup-step`] ?? null;
          const setupComplete =
            settings[`${setupPrefix}.version-setup-complete`] ?? null;
          const verifiedRuns = settings[`${setupPrefix}.verified-run`] ?? null;
          const verifiedVersions =
            settings[`${setupPrefix}.verified-version`] ?? null;
          const rejectedVersions =
            settings[`${setupPrefix}.rejected-version`] ?? null;
          const stagingStage = projectSetupProgressStage(staging);
          const productionStage = projectSetupProgressStage(production);
          const savedSetupStage = projectSetupProgressStage(setupStep);
          const environment = productionStage ? "production" : "staging";
          const stage =
            stagingStage ??
            productionStage ??
            (setupActive === "true"
              ? (savedSetupStage ?? "repository")
              : setupComplete === "true" && project.latestStatus === null
                ? "first-deploy"
                : null);
          const setupTask = stage
            ? ({
                environment,
                projectPath: project.path,
                stage,
              } satisfies ProjectSetupTask)
            : null;
          const [projectRuns, persistedValidations] = await Promise.all([
            listDeploymentRuns(project.path).catch(() => []),
            listVersionValidations(project.path).catch(
              (): VersionValidation[] => [],
            ),
          ]);
          const verifiedRunIds = verifiedRunIdsFromSetting(verifiedRuns);
          const storedVersionKeys =
            verifiedVersionKeysFromSetting(verifiedVersions);
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
          const legacyPassedKeys = new Set(storedVersionKeys);
          for (const runId of verifiedRunIds) {
            const run = projectRuns.find(
              (candidate) =>
                candidate.id === runId && candidate.status === "success",
            );
            if (run) legacyPassedKeys.add(deploymentVersionKey(run));
          }
          for (const key of legacyPassedKeys) {
            if (validationsByVersion.has(key)) continue;
            const run = projectRuns.find(
              (candidate) =>
                candidate.environment === "staging" &&
                candidate.status === "success" &&
                deploymentVersionKey(candidate) === key,
            );
            if (run) migrationCandidates.set(key, { run, state: "passed" });
          }
          for (const key of verifiedVersionKeysFromSetting(rejectedVersions)) {
            if (validationsByVersion.has(key)) continue;
            const run = projectRuns.find(
              (candidate) =>
                candidate.environment === "staging" &&
                candidate.status === "success" &&
                deploymentVersionKey(candidate) === key,
            );
            if (run) migrationCandidates.set(key, { run, state: "rejected" });
          }
          await Promise.all(
            Array.from(migrationCandidates.entries()).map(
              async ([key, candidate]) => {
                try {
                  const validation = await setVersionValidation(
                    project.path,
                    candidate.run.id,
                    candidate.state,
                  );
                  validationsByVersion.set(key, validation);
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
          const passedValidations = Array.from(
            validationsByVersion.values(),
          ).filter((validation) => validation.state === "passed");
          const passedRunIds = passedValidations.map(
            (validation) => validation.runId,
          );
          const passedVersionKeys = passedValidations.map(
            (validation) => validation.versionKey,
          );
          let verificationTask = projectVerificationTask(project, null);
          if (
            verificationTask &&
            deploymentVersionVerified(
              verificationTask.runId,
              projectRuns,
              passedRunIds,
              passedVersionKeys,
            )
          ) {
            verificationTask = null;
          }
          return {
            releaseReady:
              project.latestStatus === "success" &&
              project.latestEnvironment === "staging" &&
              !verificationTask &&
              passedValidations.length > 0,
            setupTask,
            verificationTask,
          };
        }),
      );
      if (request === guidanceTaskLoadRequest.current) {
        setSetupTasks(
          discovered.flatMap(({ setupTask }) => (setupTask ? [setupTask] : [])),
        );
        setVerificationTasks(
          discovered.flatMap(({ verificationTask }) =>
            verificationTask ? [verificationTask] : [],
          ),
        );
        setReleaseReadyPaths(
          discovered.flatMap(({ releaseReady }, index) =>
            releaseReady ? [readableProjects[index].path] : [],
          ),
        );
      }
    },
    [],
  );

  const refreshProjects = useCallback(
    async (includeSetupTasks = false) => {
      const recent = await listRecentProjects();
      setProjects(recent);
      if (includeSetupTasks) await refreshProjectGuidanceTasks(recent);
      return recent;
    },
    [refreshProjectGuidanceTasks],
  );
  const loadProject = useCallback(
    async (
      path: string,
      navigationIntent: ProjectNavigationIntent | null = null,
      announceRecognition = false,
    ) => {
      const request = ++projectLoadRequest.current;
      setLoading(true);
      setAdoptionAction(null);
      setProjectSelectionIssue(null);
      setProjectLoadMode(announceRecognition ? "recognizing" : "restoring");
      if (!announceRecognition) setRecognizedProjectPath("");
      setProjectNavigationIntent(navigationIntent);
      // Re-entering a project should always land on its stable release
      // overview. A stored browsing section (local / versions / settings) is
      // not a resumable task and made restarts feel like the product had
      // randomly jumped into the middle of a workflow. Explicit shortcuts
      // from the task centre can still provide a navigation intent.
      setProjectInitialScene(navigationIntent?.scene ?? "overview");
      setStagingServer(undefined);
      setProductionServer(undefined);
      setWorkspace(null);
      skipNextExternalProjectSync.current.delete(path);
      setProjectPath(path);
      setScreen("project");
      try {
        // Read the adoption decision before restoring any deployment state.
        // A checked-in deploy.yaml is only evidence that a deployment existed;
        // it is not permission to revive old tasks or connections in a clean
        // client before the user chooses how to proceed.
        const opened = await openProject(path);
        if (request !== projectLoadRequest.current) return;
        const restoreDeploymentState = workspaceAllowsExternalSync(opened);
        const [projectRuns, boundStagingServer, boundProductionServer] =
          restoreDeploymentState
            ? await Promise.all([
                listDeploymentRuns(path),
                getProjectServer(path, "staging"),
                getProjectServer(path, "production"),
              ])
            : [[], undefined, undefined];
        if (request !== projectLoadRequest.current) return;
        setProjectInitialScene(navigationIntent?.scene ?? "overview");
        setWorkspace(opened);
        setRuns(projectRuns);
        if (announceRecognition) {
          setRecognizedProjectPath(path);
        }
        const reusableSecretRepository =
          secretRepositoryFromManifest(opened, "staging") ||
          secretRepositoryFromManifest(opened, "production");
        if (restoreDeploymentState && reusableSecretRepository) {
          void setAppSetting(
            "cnb.secret-repository",
            reusableSecretRepository,
          ).catch(() => undefined);
        }
        setStagingServer(reusableServerForm(boundStagingServer));
        setProductionServer(reusableServerForm(boundProductionServer));
        // The project is already usable at this point. Remembering the last
        // project and refreshing sidebar metadata must not keep the page behind
        // a loading screen.
        const localStateWrites: Promise<unknown>[] = [
          setAppSetting("active-project", path),
        ];
        if (restoreDeploymentState) {
          localStateWrites.push(saveProjectStep(path, "workspace"));
        }
        void Promise.all(localStateWrites)
          .then(() => refreshProjects())
          .catch(() => undefined);
      } catch (error) {
        if (request !== projectLoadRequest.current) return;
        const message = toMessage(error);
        const selectionIssue = announceRecognition
          ? projectSelectionIssueFromMessage(message)
          : null;
        setWorkspace(null);
        setProjectPath("");
        setScreen("home");
        if (selectionIssue) setProjectSelectionIssue(selectionIssue);
        else reportError(message);
      } finally {
        if (request === projectLoadRequest.current) setLoading(false);
      }
    },
    [refreshProjects, reportError],
  );

  useEffect(() => {
    let active = true;
    // 项目恢复不能等待 Docker、Git 等本机预检。预检慢或失败时，用户仍应
    // 立即看到上次项目；底部运行状态随后在后台补齐。
    void refreshPreflight();
    Promise.all([listRecentProjects(), getAppSetting("active-project")])
      .then(async ([recent, activeProject]) => {
        if (!active) return;
        setProjects(recent);
        const resumable =
          recent.find(
            (project) => project.path === activeProject && project.pathExists,
          ) ?? (recent.length === 1 && recent[0].pathExists ? recent[0] : null);
        if (resumable) {
          // The sidebar task scan can read deployment history for every
          // project. Let the active workspace win the shared SQLite connection
          // and paint first, then fill in the non-critical task count.
          await loadProject(resumable.path);
          if (active) void refreshProjectGuidanceTasks(recent);
        } else {
          void refreshProjectGuidanceTasks(recent);
        }
      })
      .catch((error) => reportError(toMessage(error)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      preflightRequest.current += 1;
    };
  }, [loadProject, refreshPreflight, refreshProjectGuidanceTasks, reportError]);

  const refreshActiveRuns = useCallback(() => {
    if (activeRunsRefresh.current) return activeRunsRefresh.current;
    const refresh = (async () => {
      try {
        const active = await listActiveDeploymentRuns();
        activeRunsRef.current = active;
        setActiveRuns(active);
        await Promise.allSettled(
          active.map((run) => refreshDeployment(run.id)),
        );
        const [remaining, attention, completed] = await Promise.all([
          listActiveDeploymentRuns(),
          listAttentionDeploymentRuns(),
          listRecentSuccessfulDeploymentRuns(),
        ]);
        activeRunsRef.current = remaining;
        setActiveRuns(remaining);
        setAttentionRuns(attention);
        setCompletedRuns(completed);
        const requestedPath = currentProjectPath.current;
        if (requestedPath) {
          const projectRuns = await listDeploymentRuns(requestedPath);
          if (
            shouldApplyProjectResult(currentProjectPath.current, requestedPath)
          ) {
            setRuns(projectRuns);
          }
        }
        await refreshProjects(remaining.length < active.length);
        return remaining.length > 0;
      } catch {
        // 后台状态同步失败不弹出重复提示。用户进入对应项目后仍能主动刷新，
        // 并获得包含恢复动作的完整错误信息。
        return activeRunsRef.current.length > 0;
      }
    })();
    activeRunsRefresh.current = refresh;
    void refresh.finally(() => {
      if (activeRunsRefresh.current === refresh) {
        activeRunsRefresh.current = null;
      }
    });
    return refresh;
  }, [refreshProjects]);

  useEffect(() => {
    if (!appForeground || loading || cnbAuthorizationOpen) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const hasActiveRuns = await refreshActiveRuns();
      if (cancelled) return;
      timer = window.setTimeout(
        () => void poll(),
        deploymentRefreshDelay(hasActiveRuns),
      );
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [appForeground, cnbAuthorizationOpen, loading, refreshActiveRuns]);

  const refreshExternalProjectRuns = useCallback((path: string) => {
    const existing = externalProjectRefreshes.current.get(path);
    if (existing) return existing;
    const request = (async () => {
      await syncExternalDeployments(path);
      let synced = await listDeploymentRuns(path);
      const latestProduction = synced.find(
        (run) => run.environment === "production" && run.status === "success",
      );
      const now = Date.now();
      const lastRouteCheck = latestProduction
        ? (productionRouteCheckedAt.current.get(latestProduction.id) ?? 0)
        : 0;
      if (
        latestProduction &&
        now - lastRouteCheck >= PRODUCTION_ROUTE_REFRESH_MS
      ) {
        // 生产地址可能仍能访问、却被共享 Caddy 的旧规则接管。
        // 定期只读复核真实上游，但不再每 30 秒重复 SSH/HTTPS 检查；
        // 发现问题只生成待处理状态，绝不在后台改写 Caddy。
        productionRouteCheckedAt.current.set(latestProduction.id, now);
        try {
          await refreshDeployment(latestProduction.id);
        } catch (error) {
          productionRouteCheckedAt.current.delete(latestProduction.id);
          throw error;
        }
        synced = await listDeploymentRuns(path);
      }
      return synced;
    })();
    externalProjectRefreshes.current.set(path, request);
    const clear = () => {
      if (externalProjectRefreshes.current.get(path) === request) {
        externalProjectRefreshes.current.delete(path);
      }
    };
    void request.then(clear, clear);
    return request;
  }, []);

  useEffect(() => {
    if (
      !shouldRefreshDeploymentStatus(screen) ||
      !projectPath ||
      !projectWorkspaceReady ||
      !workspace ||
      !workspaceAllowsExternalSync(workspace) ||
      !deploymentRepositoryReady(workspace.manifestYaml) ||
      cnbAuthorizationOpen ||
      !appForeground
    )
      return;
    let cancelled = false;
    let syncing = false;
    const sync = async () => {
      if (syncing) return;
      syncing = true;
      try {
        // 先用本机记录立即渲染页面，再在后台同步 main 推送或 CNB 页面触发的部署。
        // 这样重新进入项目不会被网络请求卡住，远程自动部署完成后状态也能自行更新。
        const synced = await refreshExternalProjectRuns(projectPath);
        if (cancelled) return;
        setRuns(synced);
        await refreshProjects(true);
      } catch {
        // 后台同步失败不阻塞本机功能；用户主动检查新版本时仍会获得可操作的错误提示。
      } finally {
        syncing = false;
      }
    };
    if (skipNextExternalProjectSync.current.has(projectPath)) {
      // “继续管理已有部署”已经主动完成了一次只读同步。切换到正式
      // 工作区时不要紧接着再发起第二次请求；后续定时刷新照常进行。
      skipNextExternalProjectSync.current.delete(projectPath);
    } else {
      void sync();
    }
    const timer = window.setInterval(
      () => void sync(),
      EXTERNAL_DEPLOYMENT_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    appForeground,
    cnbAuthorizationOpen,
    projectPath,
    projectWorkspaceReady,
    refreshExternalProjectRuns,
    refreshProjects,
    screen,
    workspace,
  ]);

  async function continueDetectedDeployment() {
    if (!projectPath || !workspace || adoptionAction) return;
    const requestedPath = projectPath;
    setAdoptionAction("continue");
    try {
      const adopted = await continueExistingDeployment(requestedPath);
      if (!shouldApplyProjectResult(currentProjectPath.current, requestedPath))
        return;

      // Update the product state first. Importing remote history is a
      // best-effort, read-only follow-up and must never send the user back to
      // the adoption choice when CNB is temporarily unavailable.
      skipNextExternalProjectSync.current.add(requestedPath);
      setWorkspace(adopted);
      setProjectInitialScene("overview");
      setProjectNavigationIntent(null);

      const [localRuns, boundStagingServer, boundProductionServer] =
        await Promise.all([
          listDeploymentRuns(requestedPath).catch(() => []),
          getProjectServer(requestedPath, "staging").catch(() => null),
          getProjectServer(requestedPath, "production").catch(() => null),
        ]);
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns(localRuns);
        setStagingServer(reusableServerForm(boundStagingServer));
        setProductionServer(reusableServerForm(boundProductionServer));
      }

      try {
        await syncExternalDeployments(requestedPath);
        const synced = await listDeploymentRuns(requestedPath);
        if (
          shouldApplyProjectResult(currentProjectPath.current, requestedPath)
        ) {
          setRuns(synced);
        }
        toast.success("已接着管理原来的上线", {
          description: "已有版本和部署记录已同步，不会重新执行部署。",
        });
      } catch (error) {
        reportError(
          `已经开始管理这个项目，但历史部署暂时没有同步成功：${toMessage(error)}`,
        );
      }
      await refreshProjects(true).catch(() => undefined);
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setAdoptionAction(null);
      }
    }
  }

  async function resetDetectedDeployment() {
    if (!projectPath || !workspace || adoptionAction) return;
    const requestedPath = projectPath;
    setAdoptionAction("reset");
    try {
      const reset = await resetProjectDeployment(requestedPath);
      if (!shouldApplyProjectResult(currentProjectPath.current, requestedPath))
        return;

      skipNextExternalProjectSync.current.delete(requestedPath);
      setWorkspace(reset);
      setRuns([]);
      setActiveRuns((current) =>
        current.filter((run) => run.projectPath !== requestedPath),
      );
      setAttentionRuns((current) =>
        current.filter((run) => run.projectPath !== requestedPath),
      );
      setCompletedRuns((current) =>
        current.filter((run) => run.projectPath !== requestedPath),
      );
      setStagingServer(undefined);
      setProductionServer(undefined);
      setRecognizedProjectPath("");
      setProjectInitialScene("overview");
      setProjectNavigationIntent({
        scene: "overview",
        productionVersionId: "",
        taskPanel: "settings",
      });
      setProjectViewRevision((current) => current + 1);
      await refreshProjects(true).catch(() => undefined);
      toast.success("已为这个项目重新开始", {
        description: "先完成项目设置，再生成第一个测试版本。",
      });
    } catch (error) {
      reportError(toMessage(error));
    } finally {
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setAdoptionAction(null);
      }
    }
  }

  async function selectProject() {
    if (projectSelectionPending.current) return;
    projectSelectionPending.current = true;
    setSelectingProject(true);
    let selected: string | null;
    try {
      selected = await selectProjectDirectory();
    } finally {
      projectSelectionPending.current = false;
      setSelectingProject(false);
    }
    if (!selected) return;
    const existing = projects.find((project) =>
      sameProjectPath(project.path, selected),
    );
    if (existing) {
      setProjectSelectionIssue(null);
      setRecognizedProjectPath("");
      toast.info("项目已经在列表中", {
        description: "已打开保存的部署进度，不会创建重复项目。",
      });
      openRecentProject(existing);
      return;
    }
    await loadProject(selected, null, true);
  }

  async function recoverMovedProject(project: RecentProject) {
    const selected = await selectProjectDirectory(
      `重新找到“${project.name}”项目文件夹`,
    );
    if (!selected) return;
    setLoading(true);
    try {
      const recovered = await relinkProject(project.path, selected);
      await refreshProjects(true);
      toast.success("项目位置已更新，原来的配置和部署记录都已保留");
      await loadProject(recovered.path);
    } catch (error) {
      setLoading(false);
      reportError(toMessage(error));
    }
  }

  function openRecentProject(project: RecentProject) {
    setProjectSelectionIssue(null);
    if (!project.pathExists) {
      void recoverMovedProject(project);
      return;
    }
    // A project is a stable place, not a shortcut to whichever background task
    // happened to update last. Pending work is summarized inside the overview.
    void openProjectScene(project, "overview");
  }

  async function openProjectScene(project: RecentProject, scene: ProjectScene) {
    const settingKey = `project.${encodeURIComponent(project.path)}`;
    const navigationIntent = { scene, productionVersionId: "" };
    setProjectInitialScene(scene);
    void setAppSetting(
      `${settingKey}.scene`,
      scene === "test" || scene === "production" ? "overview" : scene,
    ).catch(() => undefined);
    if (
      shouldReuseProjectWorkspace(projectPath, project.path, Boolean(workspace))
    ) {
      setProjectNavigationIntent(navigationIntent);
      setProjectViewRevision((current) => current + 1);
      setScreen("project");
      return;
    }
    await loadProject(project.path, navigationIntent);
  }

  async function forgetRecent(project: RecentProject) {
    try {
      await forgetProject(project.path);
      if (project.path === projectPath) {
        setWorkspace(null);
        setProjectPath("");
        setRuns([]);
        setScreen("home");
        await setAppSetting("active-project", "");
      }
      await refreshProjects();
      toast.success("已从列表隐藏；重新添加同一路径会恢复原有设置");
    } catch (error) {
      reportError(toMessage(error));
    }
  }

  async function saveManifest(manifestYaml: string) {
    if (!projectPath) return false;
    const requestedPath = projectPath;
    setSaving(true);
    try {
      const preview = await previewManifest(requestedPath, manifestYaml);
      await saveManifestDraft(requestedPath, preview.manifestYaml);
      const refreshed = await openProject(requestedPath);
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setWorkspace(refreshed);
      }
      toast.success("项目设置已保存");
      return true;
    } catch (error) {
      reportError(toMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deployTest(
    nextServer: ServerForm,
    repository: string,
    useCommittedCode = false,
    deploymentPathId?: string,
    previousTaskId?: string | null,
  ) {
    if (!workspace || !projectPath) return;
    const requestedPath = projectPath;
    const manifestYaml = workspace.manifestYaml;
    let task: DeploymentRun | undefined;
    let taskStage:
      | "prepare"
      | "prepare-server"
      | "write-config"
      | "sync-source"
      | "trigger-build" = "prepare";
    try {
      const cloudSetupTask = runs.find(
        (run) =>
          (!deploymentPathId ||
            (Boolean(previousTaskId) && run.id === previousTaskId)) &&
          run.environment === "staging" &&
          run.status === "needs_action" &&
          run.actionKind === "cloud-setup",
      );
      if (cloudSetupTask) {
        await applyManifest(requestedPath, manifestYaml);
        const resumed = await resumeStagingDeployment(
          cloudSetupTask.id,
          cloudSetupTask.commitSha ?? undefined,
        );
        if (
          shouldApplyProjectResult(currentProjectPath.current, requestedPath)
        ) {
          setRuns((current) => mergeDeploymentRun(current, resumed));
        }
        setActiveRuns((current) => [
          resumed,
          ...current.filter((item) => item.id !== resumed.id),
        ]);
        await refreshProjects();
        return resumed;
      }
      task = runs.find(
        (run) =>
          (!deploymentPathId ||
            (Boolean(previousTaskId) && run.id === previousTaskId)) &&
          run.environment === "staging" &&
          run.status === "needs_action" &&
          run.actionKind === "retry-staging-preparation",
      );
      if (!task) {
        task = await createDeploymentTask(
          requestedPath,
          "staging",
          undefined,
          deploymentPathId,
        );
        if (
          shouldApplyProjectResult(currentProjectPath.current, requestedPath)
        ) {
          setRuns((current) => mergeDeploymentRun(current, task!));
        }
      }
      setActiveRuns((current) => [
        task!,
        ...current.filter((item) => item.id !== task!.id),
      ]);
      await beginDeploymentAttempt(task.id);
      taskStage = "prepare-server";
      const serverCheck = await bootstrapServerCaddy(nextServer);
      if (!serverCheck.ok) throw new Error(serverCheck.summary);
      await bindProjectServer(requestedPath, "staging", nextServer);
      taskStage = "write-config";
      await applyManifest(requestedPath, manifestYaml);
      taskStage = "sync-source";
      const source = await syncProjectToCnb(
        requestedPath,
        repository,
        "main",
        useCommittedCode,
        task.id,
      );
      taskStage = "trigger-build";
      const run = await startStagingDeployment(
        requestedPath,
        source.commitSha,
        true,
        task.id,
      );
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, run));
        setStagingServer(nextServer);
      }
      setActiveRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      await refreshProjects(true);
      return run;
    } catch (error) {
      if (task) {
        try {
          const issue = issueFromUnknown(toMessage(error));
          const paused = await pauseDeploymentTask(
            task.id,
            taskStage,
            issue.code,
            toMessage(error),
            "retry-staging-preparation",
          );
          if (
            shouldApplyProjectResult(currentProjectPath.current, requestedPath)
          ) {
            setRuns((current) => mergeDeploymentRun(current, paused));
          }
          setActiveRuns((current) =>
            current.filter((item) => item.id !== paused.id),
          );
          setAttentionRuns((current) => [
            paused,
            ...current.filter((item) => item.id !== paused.id),
          ]);
          await refreshProjects();
        } catch {
          // 保留原始失败；任务暂停失败会在下次后台恢复时继续显示。
        }
      }
      reportError(toMessage(error));
      throw error;
    }
  }

  // Kept as a compatibility adapter for previously persisted staging tasks;
  // the current product surface calls deployPath below.
  void deployTest;

  async function deployPath(
    deploymentPathId: string,
    previousTaskId: string | null,
    server: ServerForm,
    repository: string,
    _useCurrentLocalState = true,
  ) {
    if (!workspace || !projectPath) return;
    const requestedPath = projectPath;
    const manifestYaml = workspace.manifestYaml;
    let task = runs.find(
      (candidate) =>
        candidate.id === previousTaskId &&
        candidate.environment === "deployment" &&
        ["queued", "running", "needs_action"].includes(candidate.status),
    );
    if (task?.commitSha) {
      const resumed = await refreshDeployment(task.id);
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, resumed));
      }
      setActiveRuns((current) =>
        ["queued", "running"].includes(resumed.status)
          ? [resumed, ...current.filter((item) => item.id !== resumed.id)]
          : current.filter((item) => item.id !== resumed.id),
      );
      await refreshProjects(resumed.status === "success");
      return resumed;
    }
    let taskStage:
      | "prepare"
      | "prepare-server"
      | "write-config"
      | "sync-source"
      | "trigger-build" = "prepare";
    let preparationIssue: { code: string; message: string } | null = null;
    try {
      if (!task) {
        task = await createDeploymentTask(
          requestedPath,
          "deployment",
          undefined,
          deploymentPathId,
        );
      }
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, task!));
      }
      setActiveRuns((current) => [
        task!,
        ...current.filter((item) => item.id !== task!.id),
      ]);
      await beginDeploymentAttempt(task.id);

      taskStage = "prepare-server";
      const serverCheck = await bootstrapServerCaddy(server);
      if (!serverCheck.ok) {
        preparationIssue = {
          code: serverCheck.code ?? "AD-SRV-299",
          message: serverCheck.nextSteps?.[0]
            ? `${serverCheck.summary}。${serverCheck.nextSteps[0]}`
            : serverCheck.summary,
        };
        throw new Error(preparationIssue.message);
      }
      taskStage = "write-config";
      await applyManifest(requestedPath, manifestYaml);
      const branchDocument = parseDocument(manifestYaml);
      const branch = branchDocument.getIn(["source", "release_branch"]);
      taskStage = "sync-source";
      const source = await syncProjectToCnb(
        requestedPath,
        repository,
        typeof branch === "string" && branch.trim() ? branch.trim() : "main",
        true,
        task.id,
      );
      taskStage = "trigger-build";
      const run = await startDeploymentPath(
        requestedPath,
        source.commitSha,
        task.id,
      );
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, run));
      }
      setActiveRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      await refreshProjects(true);
      return run;
    } catch (error) {
      if (task) {
        try {
          const issue = preparationIssue ?? issueFromUnknown(toMessage(error));
          const paused = await pauseDeploymentTask(
            task.id,
            taskStage,
            issue.code,
            issue.message,
            "deployment-path-preparation-retry",
          );
          if (
            shouldApplyProjectResult(currentProjectPath.current, requestedPath)
          ) {
            setRuns((current) => mergeDeploymentRun(current, paused));
          }
          setAttentionRuns((current) => [
            paused,
            ...current.filter((item) => item.id !== paused.id),
          ]);
          reportError(issue.message);
          return paused;
        } catch {
          // The original failure remains visible if persistence itself failed.
        }
      }
      reportError(toMessage(error));
      throw error;
    }
  }

  async function refreshRun(run: DeploymentRun) {
    const requestedPath = run.projectPath;
    const refreshed = await refreshDeployment(run.id);
    if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
      setRuns((current) => mergeDeploymentRun(current, refreshed));
    }
    setActiveRuns((current) =>
      ["queued", "running"].includes(refreshed.status)
        ? [refreshed, ...current.filter((item) => item.id !== refreshed.id)]
        : current.filter((item) => item.id !== refreshed.id),
    );
    // The environment check itself is authoritative and already updated the
    // current run above. Task-center and sidebar summaries are supporting
    // reads: a slow or temporarily unavailable local index must not keep the
    // check button spinning or turn a completed health check into a failure.
    void (async () => {
      const [attention, completed] = await Promise.all([
        listAttentionDeploymentRuns(),
        listRecentSuccessfulDeploymentRuns(),
      ]);
      setAttentionRuns(attention);
      setCompletedRuns(completed);
      await refreshProjects(refreshed.status === "success");
    })().catch(() => undefined);
    return refreshed;
  }

  const content =
    screen === "home" ? (
      <ProjectGallery
        loading={loading}
        onForget={(project) => void forgetRecent(project)}
        onOpen={openRecentProject}
        onSelect={() => void selectProject()}
        projects={projects}
        releaseReadyPaths={releaseReadyPaths}
        selectingProject={selectingProject}
        selectionIssue={projectSelectionIssue}
        setupTasks={setupTasks}
        taskRuns={taskRuns}
        verificationTasks={verificationTasks}
      />
    ) : screen === "configuration" ? (
      <ConfigurationCenter onError={reportError} />
    ) : workspace?.adoption.mode === "pending" ? (
      <ExistingDeploymentChoice
        action={adoptionAction}
        onContinue={() => void continueDetectedDeployment()}
        onReset={() => void resetDetectedDeployment()}
        path={projectPath}
        workspace={workspace}
      />
    ) : workspace ? (
      <Suspense
        fallback={
          <div className="grid h-full min-h-0 place-items-center bg-[#f7f7fb] text-sm text-[var(--muted-foreground)] dark:bg-[#18181c]">
            <span className="inline-flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" />
              正在打开部署工作流
            </span>
          </div>
        }
      >
        <DeploymentPathWorkspace
          autoCreateDefault={recognizedProjectPath === projectPath}
          key={`${projectPath}:${projectViewRevision}`}
          onBack={() => {
            setRecognizedProjectPath("");
            setScreen("home");
          }}
          onDeploy={deployPath}
          onError={reportError}
          onRefresh={refreshRun}
          onRunUpdated={(run) => {
            setRuns((current) => mergeDeploymentRun(current, run));
            setActiveRuns((current) =>
              current.filter((item) => item.id !== run.id),
            );
            setAttentionRuns((current) => [
              run,
              ...current.filter((item) => item.id !== run.id),
            ]);
          }}
          onSaveManifest={saveManifest}
          path={projectPath}
          runs={runs}
          workspace={workspace}
        />
      </Suspense>
    ) : (
      <ProjectLoadingState
        mode={projectLoadMode}
        path={projectPath}
        project={projects.find((project) => project.path === projectPath)}
      />
    );

  return (
    <>
      <ApplicationFrame
        activeView={
          screen === "configuration"
            ? "configuration"
            : screen === "home"
              ? "projects"
              : "project"
        }
        onShowConfiguration={() => {
          setRecognizedProjectPath("");
          setScreen("configuration");
        }}
        onShowProjects={() => {
          setRecognizedProjectPath("");
          setScreen("home");
        }}
      >
        {content}
      </ApplicationFrame>

      <Toaster closeButton position="top-right" richColors />
    </>
  );
}

export function ProjectLoadingState({
  mode,
  path,
  project,
}: {
  mode: ProjectLoadMode;
  path: string;
  project?: RecentProject;
}) {
  const recognizing = mode === "recognizing";
  const name =
    project?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "项目";
  return (
    <div className="grid h-full min-h-0 grid-rows-[52px_minmax(0,1fr)] bg-[var(--canvas-background)]">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-4">
        <div className="min-w-0">
          <strong className="block truncate text-sm font-semibold leading-5">
            {name}
          </strong>
          <span className="block truncate text-xs leading-4 text-[var(--muted-foreground)]">
            部署工作流
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <LoaderCircle className="size-3.5 animate-spin-slow text-[var(--accent)]" />
          正在准备
        </span>
      </header>
      <main
        className="grid min-h-0 place-items-center px-6"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(126,128,145,.22) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      >
        <section
          aria-live="polite"
          className="flex w-full max-w-[360px] items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"
        >
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin-slow text-[var(--accent)]" />
          <div className="min-w-0">
            <h1 className="m-0 text-sm font-semibold leading-5">
              {recognizing ? "正在读取项目" : "正在恢复工作流"}
            </h1>
            <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
              {recognizing
                ? "正在识别项目服务，完成后会直接显示部署线路。"
                : "正在恢复上次保存的线路和画布位置，不会重新执行上线。"}
            </p>
            <p className="mb-0 mt-2 truncate text-[11px] leading-4 text-[var(--subtle-foreground)]">
              {path}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default App;
