import { isTauri } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { parseDocument } from "yaml";
import {
  applyManifest,
  bindProjectServer,
  bootstrapServerCaddy,
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
  openProject,
  promoteProductionDeployment,
  previewManifest,
  refreshDeployment,
  relinkProject,
  resumeStagingDeployment,
  saveManifestDraft,
  saveProjectStep,
  selectProjectDirectory,
  setAppSetting,
  startStagingDeployment,
  syncExternalDeployments,
  syncProjectToCnb,
} from "./api";
import { AppShell } from "./components/AppShell";
import { ConfigurationCenter } from "./components/ConfigurationCenter";
import {
  ProductWorkspace,
  secretRepositoryFromManifest,
} from "./components/ProductWorkspace";
import { ProjectHome } from "./components/ProjectHome";
import { issueFromUnknown } from "./lib/errors";
import {
  deploymentVersionKey,
  deploymentVersionVerified,
  isFirstDeployTask,
  preferredProjectTask,
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
  WorkspacePreview,
} from "./types";

type AppScreen = "home" | "configuration" | "project";
type ProjectScene = "local" | "versions" | "test" | "production";
type ProjectLoadMode = "recognizing" | "restoring";
export type ProjectSelectionIssue = {
  message: string;
  title: string;
};
type ProjectNavigationIntent = {
  scene: ProjectScene;
  productionVersionId: string;
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
    return "versions";
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
    return "versions";
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
  return task.environment === "production" ? "production" : "versions";
}

export function projectSceneFromSetting(
  value: string | null,
): ProjectScene | undefined {
  return value && ["local", "versions", "test", "production"].includes(value)
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
  const [preflight, setPreflight] = useState<SystemPreflight | null>(null);
  const [preflightChecking, setPreflightChecking] = useState(true);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [workspace, setWorkspace] = useState<WorkspacePreview | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [runs, setRuns] = useState<DeploymentRun[]>([]);
  const [activeRuns, setActiveRuns] = useState<DeploymentRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<DeploymentRun[]>([]);
  const [completedRuns, setCompletedRuns] = useState<DeploymentRun[]>([]);
  const [setupTasks, setSetupTasks] = useState<ProjectSetupTask[]>([]);
  const [verificationTasks, setVerificationTasks] = useState<
    ProjectVerificationTask[]
  >([]);
  const [releaseReadyPaths, setReleaseReadyPaths] = useState<string[]>([]);
  const [server, setServer] = useState<ServerForm | undefined>();
  const [loading, setLoading] = useState(true);
  const [selectingProject, setSelectingProject] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projectViewRevision, setProjectViewRevision] = useState(0);
  const [projectNavigationIntent, setProjectNavigationIntent] =
    useState<ProjectNavigationIntent | null>(null);
  const [projectInitialScene, setProjectInitialScene] =
    useState<ProjectScene>();
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
          let verificationTask = projectVerificationTask(project, verifiedRuns);
          const verifiedRunIds = verifiedRunIdsFromSetting(verifiedRuns);
          const storedVersionKeys =
            verifiedVersionKeysFromSetting(verifiedVersions);
          let knownVerifiedVersionKeys = storedVersionKeys;
          if (
            (verificationTask &&
              (verifiedRunIds.length || storedVersionKeys.length)) ||
            (verifiedRunIds.length && !storedVersionKeys.length)
          ) {
            const projectRuns = await listDeploymentRuns(project.path).catch(
              () => [],
            );
            const migratedVersionKeys = projectRuns
              .filter((run) => verifiedRunIds.includes(run.id))
              .map(deploymentVersionKey);
            const verifiedVersionKeys = Array.from(
              new Set([...storedVersionKeys, ...migratedVersionKeys]),
            );
            knownVerifiedVersionKeys = verifiedVersionKeys;
            if (
              verifiedVersionKeys.length > storedVersionKeys.length &&
              verifiedVersionKeys.length > 0
            ) {
              await setAppSetting(
                `${setupPrefix}.verified-version`,
                JSON.stringify(verifiedVersionKeys),
              ).catch(() => undefined);
            }
            if (
              verificationTask &&
              deploymentVersionVerified(
                verificationTask.runId,
                projectRuns,
                verifiedRunIds,
                verifiedVersionKeys,
              )
            ) {
              verificationTask = null;
            }
          }
          return {
            releaseReady:
              project.latestStatus === "success" &&
              project.latestEnvironment === "staging" &&
              !verificationTask &&
              Boolean(verifiedRunIds.length || knownVerifiedVersionKeys.length),
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
  const handleSetupProgressChange = useCallback(() => {
    void refreshProjects(true);
  }, [refreshProjects]);

  const loadProject = useCallback(
    async (
      path: string,
      navigationIntent: ProjectNavigationIntent | null = null,
      announceRecognition = false,
    ) => {
      const request = ++projectLoadRequest.current;
      setLoading(true);
      setProjectSelectionIssue(null);
      setProjectLoadMode(announceRecognition ? "recognizing" : "restoring");
      if (!announceRecognition) setRecognizedProjectPath("");
      setProjectNavigationIntent(navigationIntent);
      setProjectInitialScene(navigationIntent?.scene);
      setServer(undefined);
      setWorkspace(null);
      setProjectPath(path);
      setScreen("project");
      try {
        const settingKey = `project.${encodeURIComponent(path)}`;
        const [opened, projectRuns, boundServer, storedScene] =
          await Promise.all([
            openProject(path),
            listDeploymentRuns(path),
            getProjectServer(path, "staging"),
            getAppSetting(`${settingKey}.scene`).catch(() => null),
          ]);
        if (request !== projectLoadRequest.current) return;
        setProjectInitialScene(
          navigationIntent?.scene ??
            projectSceneFromSetting(storedScene) ??
            "local",
        );
        setWorkspace(opened);
        setRuns(projectRuns);
        if (announceRecognition) {
          setRecognizedProjectPath(path);
        }
        const reusableSecretRepository =
          secretRepositoryFromManifest(opened, "staging") ||
          secretRepositoryFromManifest(opened, "production");
        if (reusableSecretRepository) {
          void setAppSetting(
            "cnb.secret-repository",
            reusableSecretRepository,
          ).catch(() => undefined);
        }
        const reusable =
          boundServer?.keyPathExists && boundServer.hostFingerprint
            ? boundServer
            : null;
        if (reusable) {
          setServer({
            name: reusable.name,
            host: reusable.host,
            user: reusable.user,
            port: reusable.port,
            keyPath: reusable.keyPath,
            hostFingerprint: reusable.hostFingerprint,
          });
        } else {
          setServer(undefined);
        }
        // The project is already usable at this point. Remembering the last
        // project and refreshing sidebar metadata must not keep the page behind
        // a loading screen.
        void Promise.all([
          setAppSetting("active-project", path),
          saveProjectStep(path, "workspace"),
        ])
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
    if (!appForeground || loading) return;
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
  }, [appForeground, loading, refreshActiveRuns]);

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
        // 定期复核真实上游，但不再每 30 秒重复 SSH/HTTPS 检查。
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
      !deploymentRepositoryReady(workspace.manifestYaml) ||
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
    void sync();
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
    projectPath,
    projectWorkspaceReady,
    refreshExternalProjectRuns,
    refreshProjects,
    screen,
    workspace,
  ]);

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
    const deploymentTask = preferredProjectTask(taskRuns, project.path);
    if (deploymentTask) {
      void openDeploymentTask(project, deploymentTask);
      return;
    }
    if (verificationTasks.some((task) => task.projectPath === project.path)) {
      void openVerificationTask(project);
      return;
    }
    const setupTask = setupTasks.find(
      (task) =>
        task.projectPath === project.path &&
        (!isFirstDeployTask(task) || project.latestStatus === null),
    );
    if (setupTask) {
      void openSetupTask(project, setupTask);
      return;
    }
    if (
      project.latestStatus === "success" &&
      project.latestEnvironment === "production"
    ) {
      void openProjectScene(project, "production");
      return;
    }
    if (releaseReadyPaths.includes(project.path)) {
      void openProjectScene(project, "production");
      return;
    }
    if (loading && projectPath === project.path) {
      setProjectNavigationIntent(null);
      setScreen("project");
      return;
    }
    if (
      shouldReuseProjectWorkspace(projectPath, project.path, Boolean(workspace))
    ) {
      if (projectNavigationIntent) {
        setProjectNavigationIntent(null);
        setProjectViewRevision((current) => current + 1);
      }
      setScreen("project");
      return;
    }
    void loadProject(project.path);
  }

  async function openDeploymentTask(
    project: RecentProject,
    taskRun?: DeploymentRun,
  ) {
    const scene = taskRun
      ? deploymentSceneForRun(taskRun)
      : deploymentSceneForProject(project);
    const sourceVersion = taskRun
      ? deploymentVersionForRun(taskRun)
      : deploymentVersionForProject(project);
    const settingKey = `project.${encodeURIComponent(project.path)}`;
    const navigationIntent = {
      scene,
      productionVersionId: sourceVersion ?? "",
    };
    setProjectInitialScene(scene);
    void setAppSetting(`${settingKey}.scene`, scene).catch(() => undefined);
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

  async function openSetupTask(project: RecentProject, task: ProjectSetupTask) {
    const scene = setupSceneForTask(task);
    const settingKey = `project.${encodeURIComponent(project.path)}`;
    const navigationIntent = { scene, productionVersionId: "" };
    setProjectInitialScene(scene);
    void setAppSetting(`${settingKey}.scene`, scene).catch(() => undefined);
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

  async function openVerificationTask(project: RecentProject) {
    await openProjectScene(project, "test");
  }

  async function openProjectScene(project: RecentProject, scene: ProjectScene) {
    const settingKey = `project.${encodeURIComponent(project.path)}`;
    const navigationIntent = { scene, productionVersionId: "" };
    setProjectInitialScene(scene);
    void setAppSetting(`${settingKey}.scene`, scene).catch(() => undefined);
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
      toast.success("已移除本机项目记录");
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
  ) {
    if (!workspace || !projectPath) return;
    const requestedPath = projectPath;
    const manifestYaml = workspace.manifestYaml;
    try {
      const resumable = runs.find(
        (run) =>
          run.environment === "staging" &&
          run.status === "needs_action" &&
          run.actionKind === "cloud-setup",
      );
      if (resumable) {
        await applyManifest(requestedPath, manifestYaml);
        const resumed = await resumeStagingDeployment(
          resumable.id,
          resumable.commitSha ?? undefined,
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
        return;
      }
      const serverCheck = await bootstrapServerCaddy(nextServer);
      if (!serverCheck.ok) throw new Error(serverCheck.summary);
      await Promise.all([
        bindProjectServer(requestedPath, "staging", nextServer),
        bindProjectServer(requestedPath, "production", nextServer),
      ]);
      await applyManifest(requestedPath, manifestYaml);
      const source = await syncProjectToCnb(
        requestedPath,
        repository,
        "main",
        useCommittedCode,
      );
      const run = await startStagingDeployment(
        requestedPath,
        source.commitSha,
        true,
      );
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, run));
        setServer(nextServer);
      }
      setActiveRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      await refreshProjects(true);
    } catch (error) {
      reportError(toMessage(error));
      throw error;
    }
  }

  async function promote(run: DeploymentRun, nextServer: ServerForm) {
    const requestedPath = run.projectPath;
    try {
      await bindProjectServer(requestedPath, "production", nextServer);
      const promoted = await promoteProductionDeployment(run.id);
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns((current) => mergeDeploymentRun(current, promoted));
      }
      setActiveRuns((current) => [
        promoted,
        ...current.filter((item) => item.id !== promoted.id),
      ]);
      await refreshProjects();
    } catch (error) {
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

  async function syncVersions() {
    if (!projectPath) return;
    const requestedPath = projectPath;
    try {
      const synced = await refreshExternalProjectRuns(requestedPath);
      if (shouldApplyProjectResult(currentProjectPath.current, requestedPath)) {
        setRuns(synced);
      }
      setCompletedRuns(await listRecentSuccessfulDeploymentRuns());
      await refreshProjects(true);
    } catch (error) {
      reportError(toMessage(error));
      throw error;
    }
  }

  const content =
    screen === "home" ? (
      <ProjectHome
        embedded
        loading={loading}
        onDemo={() => void loadProject("/demo/ecat-energy")}
        onForget={(project) => void forgetRecent(project)}
        onOpen={openRecentProject}
        onSelect={() => void selectProject()}
        preflight={preflight}
        projects={projects}
        releaseReadyPaths={releaseReadyPaths}
        selectingProject={selectingProject}
        selectionIssue={projectSelectionIssue}
        showDemo={!isTauri()}
        setupTasks={setupTasks}
        taskRuns={taskRuns}
        verificationTasks={verificationTasks}
      />
    ) : screen === "configuration" ? (
      <ConfigurationCenter onError={reportError} />
    ) : workspace ? (
      <ProductWorkspace
        key={`${projectPath}:${projectViewRevision}`}
        initialProductionVersionId={
          projectNavigationIntent?.productionVersionId
        }
        initialScene={projectNavigationIntent?.scene ?? projectInitialScene}
        initialServer={server}
        onDeployTest={deployTest}
        onError={reportError}
        onPromote={promote}
        onRefresh={refreshRun}
        onSaveManifest={saveManifest}
        onSetupProgressChange={handleSetupProgressChange}
        onRecognitionDismiss={() => setRecognizedProjectPath("")}
        onReselectProject={() => void selectProject()}
        onSceneChange={(scene) => {
          setProjectInitialScene(scene);
          if (scene !== "local") setRecognizedProjectPath("");
        }}
        onServerChange={setServer}
        onSyncVersions={syncVersions}
        path={projectPath}
        runs={runs}
        saving={saving}
        showRecognitionSummary={recognizedProjectPath === projectPath}
        workspace={workspace}
      />
    ) : (
      <ProjectLoadingState
        mode={projectLoadMode}
        path={projectPath}
        project={projects.find((project) => project.path === projectPath)}
      />
    );

  return (
    <>
      <AppShell
        activePath={screen === "project" ? projectPath : ""}
        completedRuns={completedRuns}
        setupTasks={setupTasks}
        taskRuns={taskRuns}
        verificationTasks={verificationTasks}
        activeView={
          screen === "configuration"
            ? "configuration"
            : screen === "home"
              ? "projects"
              : "project"
        }
        loading={selectingProject || (loading && projects.length === 0)}
        onAddProject={() => void selectProject()}
        onOpenDeployment={(project, run) =>
          void openDeploymentTask(project, run)
        }
        onOpenSetup={(project, task) => void openSetupTask(project, task)}
        onOpenVerification={(project) => void openVerificationTask(project)}
        onOpenProject={openRecentProject}
        onShowConfiguration={() => {
          setRecognizedProjectPath("");
          setScreen("configuration");
        }}
        onShowProjects={() => {
          setRecognizedProjectPath("");
          setScreen("home");
        }}
        preflight={preflight}
        preflightChecking={preflightChecking}
        onRetryPreflight={() => void refreshPreflight(true)}
        projects={projects}
        releaseReadyPaths={releaseReadyPaths}
      >
        {content}
      </AppShell>

      <Toaster closeButton position="top-right" richColors />
    </>
  );
}

function ProjectLoadingState({
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
    <div className="grid h-full min-h-0 grid-rows-[58px_minmax(0,1fr)] bg-[var(--background)]">
      <header className="flex items-center border-b border-[var(--border)] bg-[var(--surface)] px-6">
        <div className="min-w-0">
          <strong className="block truncate text-sm font-semibold">
            {name}
          </strong>
          <span className="block max-w-[540px] truncate text-[11px] text-[var(--muted-foreground)]">
            {path}
          </span>
        </div>
      </header>
      <main className="min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-[1060px] px-6 py-7">
          <div className="mb-8 grid grid-cols-4 gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
            {["在本机运行", "管理版本", "部署测试版", "发布正式版"].map(
              (label) => (
                <div className="min-h-[62px] rounded-md px-4 py-3" key={label}>
                  <strong className="block text-sm font-semibold">
                    {label}
                  </strong>
                  <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                    {recognizing ? "等待识别" : "正在恢复"}
                  </span>
                </div>
              ),
            )}
          </div>
          <h1 className="m-0 text-[28px] font-semibold leading-tight">
            {recognizing ? "正在识别项目" : "正在恢复项目"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
            {recognizing
              ? "正在只读检查项目结构和服务，不会运行项目代码，也不会读取配置值。"
              : "已经找到上次打开的位置，正在读取项目服务、版本和部署记录。"}
          </p>
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-5 text-sm text-[var(--muted-foreground)]">
            <LoaderCircle className="size-5 shrink-0 animate-spin-slow text-[var(--accent)]" />
            {recognizing
              ? "识别完成后会告诉你发现了什么，以及下一步需要做什么。"
              : "页面准备好后会在这里直接恢复，不会重新执行部署。"}
          </div>
        </div>
      </main>
    </div>
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default App;
