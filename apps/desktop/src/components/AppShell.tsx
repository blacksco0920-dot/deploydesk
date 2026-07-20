import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Circle,
  FolderKanban,
  LayoutGrid,
  LoaderCircle,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DeploymentRun, RecentProject, SystemPreflight } from "../types";
import { issueFromUnknown } from "../lib/errors";
import {
  deploymentNeedsActionStatus,
  isFirstDeployTask,
  preferredProjectTask,
  primaryVersionTitle,
  projectSetupStatus,
  recentProjectStatus,
  type ProjectSetupTask,
  type ProjectVerificationTask,
} from "../lib/projects";
import { Brand } from "./Brand";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Progress } from "./ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

const RECENT_COMPLETED_TASK_LIMIT = 4;

export function stableSidebarProjects(
  projects: RecentProject[],
  previousOrder: string[],
) {
  if (!previousOrder.length) return projects;
  const byPath = new Map(projects.map((project) => [project.path, project]));
  const previousPaths = new Set(previousOrder);
  const added = projects.filter((project) => !previousPaths.has(project.path));
  const retained = previousOrder.flatMap((path) => {
    const project = byPath.get(path);
    return project ? [project] : [];
  });
  return [...added, ...retained];
}

interface AppShellProps {
  activeView: "projects" | "configuration" | "project";
  activePath: string;
  completedRuns?: DeploymentRun[];
  setupTasks?: ProjectSetupTask[];
  verificationTasks?: ProjectVerificationTask[];
  taskRuns: DeploymentRun[];
  children: ReactNode;
  loading: boolean;
  onAddProject: () => void;
  onOpenDeployment: (project: RecentProject, run?: DeploymentRun) => void;
  onOpenSetup?: (project: RecentProject, task: ProjectSetupTask) => void;
  onOpenVerification?: (
    project: RecentProject,
    task: ProjectVerificationTask,
  ) => void;
  onShowConfiguration: () => void;
  onOpenProject: (project: RecentProject) => void;
  onShowProjects: () => void;
  preflight: SystemPreflight | null;
  preflightChecking?: boolean;
  onRetryPreflight?: () => void;
  projects: RecentProject[];
  releaseReadyPaths?: string[];
}

export function AppShell({
  activeView,
  activePath,
  completedRuns = [],
  setupTasks = [],
  verificationTasks = [],
  taskRuns,
  children,
  loading,
  onAddProject,
  onOpenDeployment,
  onOpenSetup,
  onOpenVerification,
  onShowConfiguration,
  onOpenProject,
  onShowProjects,
  preflight,
  preflightChecking,
  onRetryPreflight,
  projects,
  releaseReadyPaths = [],
}: AppShellProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const sidebarProjectOrder = useRef<string[]>([]);
  const sidebarProjects = stableSidebarProjects(
    projects,
    sidebarProjectOrder.current,
  );
  sidebarProjectOrder.current = sidebarProjects.map((project) => project.path);
  const releaseReadyProjectPaths = new Set(releaseReadyPaths);
  const checkingLocalEnvironment = preflightChecking ?? preflight === null;
  const localEnvironmentStatus = checkingLocalEnvironment
    ? {
        label: "正在检查本机环境",
        tone: "active",
      }
    : preflight?.ready_for_local_preview
      ? {
          label: "本机环境可用",
          tone: "success",
        }
      : preflight
        ? {
            label: "本机环境待准备",
            tone: "warning",
          }
        : {
            label: "本机环境检查未完成",
            tone: "warning",
          };
  const canRetryLocalEnvironment =
    !checkingLocalEnvironment && !preflight && Boolean(onRetryPreflight);
  const taskProjectPaths = new Set(taskRuns.map((run) => run.projectPath));
  const verificationAttentionItems = verificationTasks.flatMap((task) => {
    if (taskProjectPaths.has(task.projectPath)) return [];
    const project = projects.find((item) => item.path === task.projectPath);
    return project?.pathExists &&
      project.latestStatus === "success" &&
      project.latestEnvironment === "staging" &&
      project.latestRunId === task.runId
      ? [{ project, task }]
      : [];
  });
  const verificationProjectPaths = new Set(
    verificationAttentionItems.map(({ project }) => project.path),
  );
  const setupAttentionItems = setupTasks.flatMap((task) => {
    if (taskProjectPaths.has(task.projectPath)) return [];
    const project = projects.find((item) => item.path === task.projectPath);
    if (!project?.pathExists) return [];
    if (isFirstDeployTask(task) && project.latestStatus !== null) return [];
    return project ? [{ project, task }] : [];
  });
  const setupProjectPaths = new Set(
    setupAttentionItems.map(({ project }) => project.path),
  );
  const fallbackAttentionProjects = projects.filter(
    (project) =>
      !taskProjectPaths.has(project.path) &&
      !verificationProjectPaths.has(project.path) &&
      !setupProjectPaths.has(project.path) &&
      (project.activeRunCount > 0 ||
        !project.pathExists ||
        project.latestStatus === "needs_action" ||
        project.latestStatus === "failed"),
  );
  const attentionItems: Array<{
    project: RecentProject;
    run?: DeploymentRun;
  }> = [
    ...taskRuns.flatMap((run) => {
      const project = projects.find((item) => item.path === run.projectPath);
      return project ? [{ project, run }] : [];
    }),
    ...fallbackAttentionProjects.map((project) => ({ project })),
  ];
  const automaticAttentionItems = attentionItems.filter(({ project, run }) =>
    deploymentTaskActive(project, run),
  );
  const manualAttentionItems = attentionItems.filter(
    ({ project, run }) => !deploymentTaskActive(project, run),
  );
  const hasUserAttention = Boolean(
    setupAttentionItems.length ||
    verificationAttentionItems.length ||
    manualAttentionItems.length,
  );
  const hasBlockingAttention =
    setupAttentionItems.some(({ task }) => !isFirstDeployTask(task)) ||
    attentionItems.some(({ project, run }) => {
      if (!project.pathExists) return true;
      const status = run?.status ?? project.latestStatus;
      return status === "failed" || status === "needs_action";
    });
  const onlyReadyToDeploy =
    setupAttentionItems.length > 0 &&
    setupAttentionItems.every(({ task }) => isFirstDeployTask(task)) &&
    verificationAttentionItems.length === 0 &&
    manualAttentionItems.length === 0;
  const onlyWaitingForVerification =
    verificationAttentionItems.length > 0 &&
    setupAttentionItems.length === 0 &&
    manualAttentionItems.length === 0;
  const verificationRunIds = new Set(
    verificationAttentionItems.map(({ task }) => task.runId),
  );
  const completedRunKeys = new Set(
    completedRuns.map((run) => `${run.projectPath}:${run.environment}`),
  );
  const allCompletedItems: Array<{
    project: RecentProject;
    run?: DeploymentRun;
  }> = [
    ...completedRuns.flatMap((run) => {
      if (verificationRunIds.has(run.id)) return [];
      const project = projects.find((item) => item.path === run.projectPath);
      return project?.pathExists ? [{ project, run }] : [];
    }),
    ...projects
      .filter(
        (project) =>
          project.latestStatus === "success" &&
          !verificationProjectPaths.has(project.path) &&
          !completedRunKeys.has(
            `${project.path}:${project.latestEnvironment ?? "staging"}`,
          ),
      )
      .map((project) => ({ project, run: undefined })),
  ].sort((left, right) =>
    (
      right.run?.startedAt ??
      right.project.latestUpdatedAt ??
      right.project.lastOpenedAt
    ).localeCompare(
      left.run?.startedAt ??
        left.project.latestUpdatedAt ??
        left.project.lastOpenedAt,
    ),
  );
  const completedItems = allCompletedItems.slice(
    0,
    RECENT_COMPLETED_TASK_LIMIT,
  );
  const hiddenCompletedCount = allCompletedItems.length - completedItems.length;

  function openActivityProject(project: RecentProject, run?: DeploymentRun) {
    setActivityOpen(false);
    if (!project.pathExists) {
      onOpenProject(project);
      return;
    }
    if (run) onOpenDeployment(project, run);
    else onOpenDeployment(project);
  }

  function openSetupProject(project: RecentProject, task: ProjectSetupTask) {
    setActivityOpen(false);
    if (onOpenSetup) onOpenSetup(project, task);
    else onOpenDeployment(project);
  }

  function openVerificationProject(
    project: RecentProject,
    task: ProjectVerificationTask,
  ) {
    setActivityOpen(false);
    if (onOpenVerification) onOpenVerification(project, task);
    else onOpenDeployment(project);
  }

  return (
    <TooltipProvider delayDuration={350}>
      <div className="grid h-full min-h-0 grid-cols-[236px_minmax(0,1fr)] bg-[var(--background)] max-[900px]:grid-cols-[72px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] px-3 py-3 max-[900px]:px-2">
          <div className="flex h-10 items-center px-1 max-[900px]:justify-center">
            <div className="max-[900px]:hidden">
              <Brand />
            </div>
            <div className="hidden max-[900px]:block">
              <Brand compact />
            </div>
          </div>

          <nav className="mt-4" aria-label="工作区">
            <SidebarButton
              active={activeView === "projects"}
              icon={LayoutGrid}
              label="所有项目"
              onClick={onShowProjects}
            />
            <SidebarButton
              active={activeView === "configuration"}
              icon={SlidersHorizontal}
              label="配置中心"
              onClick={onShowConfiguration}
            />
            <SidebarButton
              active={false}
              badge={
                setupAttentionItems.length +
                  verificationAttentionItems.length +
                  manualAttentionItems.length || undefined
              }
              badgeTone={hasBlockingAttention ? "warning" : "accent"}
              icon={Activity}
              label="待处理"
              onClick={() => setActivityOpen(true)}
            />
          </nav>

          <div className="mt-5 flex items-center justify-between px-2 max-[900px]:justify-center max-[900px]:px-0">
            <span className="text-[10px] font-medium text-[var(--subtle-foreground)] max-[900px]:hidden">
              项目
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="添加项目"
                  disabled={loading}
                  onClick={onAddProject}
                  size="icon"
                  variant="ghost"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">添加整个项目文件夹</TooltipContent>
            </Tooltip>
          </div>

          <div
            className="mt-1 min-h-0 flex-1 space-y-1 overflow-y-auto"
            data-testid="project-sidebar"
          >
            {sidebarProjects.map((project) => {
              const task = preferredProjectTask(taskRuns, project.path);
              const setupTask = setupTasks.find(
                (item) =>
                  item.projectPath === project.path &&
                  (!isFirstDeployTask(item) || project.latestStatus === null),
              );
              const verificationTask = verificationAttentionItems.find(
                (item) => item.project.path === project.path,
              )?.task;
              return (
                <ProjectButton
                  active={project.path === activePath}
                  key={project.id}
                  onClick={() => onOpenProject(project)}
                  project={project}
                  releaseReady={releaseReadyProjectPaths.has(project.path)}
                  setupTask={setupTask}
                  task={task}
                  verificationTask={verificationTask}
                />
              );
            })}
          </div>

          <div className="mt-3 flex h-9 items-center gap-2 border-t border-[var(--border)] px-2 pt-3 max-[900px]:justify-center max-[900px]:px-0">
            <span
              aria-hidden="true"
              className={`a11y-status-dot size-2 shrink-0 rounded-full ${
                localEnvironmentStatus.tone === "success"
                  ? "bg-[var(--success)]"
                  : localEnvironmentStatus.tone === "active"
                    ? "bg-[var(--accent)]"
                    : "bg-[var(--warning)]"
              }`}
              data-status={localEnvironmentStatus.tone}
            />
            <span
              aria-live="polite"
              className="truncate text-[10px] text-[var(--muted-foreground)] max-[900px]:hidden"
            >
              {localEnvironmentStatus.label}
            </span>
            {canRetryLocalEnvironment ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="重新检查本机环境"
                    className="ml-auto size-7 p-0 max-[900px]:ml-0"
                    onClick={onRetryPreflight}
                    size="icon"
                    variant="ghost"
                  >
                    <RefreshCw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">重新检查本机环境</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </aside>

        <section className="min-h-0 min-w-0">{children}</section>
      </div>
      <Dialog onOpenChange={setActivityOpen} open={activityOpen}>
        <DialogContent className="max-h-[78vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>待处理与最近活动</DialogTitle>
            <DialogDescription>
              这里只汇总需要你处理的事项和最近结果；部署操作从对应项目的发布中心发起。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            {hasUserAttention ? (
              <section>
                <h3 className="mb-2 mt-0 text-xs font-medium text-[var(--muted-foreground)]">
                  {onlyReadyToDeploy
                    ? "现在可以继续"
                    : onlyWaitingForVerification
                      ? "等待你确认"
                      : "等待你处理"}
                </h3>
                <div className="space-y-2">
                  {setupAttentionItems.map(({ project, task }) => (
                    <button
                      className={`block w-full rounded-lg border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${isFirstDeployTask(task) ? "border-[var(--accent)]/30 bg-[var(--accent-soft)] hover:brightness-[0.98]" : "border-[var(--warning)]/30 bg-[var(--warning-soft)]/35 hover:bg-[var(--warning-soft)]/55"}`}
                      key={`setup:${project.id}`}
                      onClick={() => openSetupProject(project, task)}
                      type="button"
                    >
                      <span className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                          <strong className="block truncate text-sm">
                            {project.name}
                          </strong>
                          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                            {setupTaskCardTitle(task)}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-xs ${isFirstDeployTask(task) ? "text-[var(--accent)]" : "text-[var(--warning)]"}`}
                        >
                          {setupTaskCardAction(task)} ›
                        </span>
                      </span>
                      <span className="mt-3 block text-xs leading-5 text-[var(--muted-foreground)]">
                        {setupTaskUserMessage(task)}
                      </span>
                      <span className="mt-3 block rounded-md bg-[var(--surface)]/75 px-3 py-2 text-[11px] leading-5 text-[var(--muted-foreground)]">
                        {isFirstDeployTask(task)
                          ? "上线设置已完成，打开后会进入测试版"
                          : "进度已保存，打开后会回到当前步骤"}
                      </span>
                    </button>
                  ))}
                  {verificationAttentionItems.map(({ project, task }) => (
                    <button
                      className="block w-full rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-soft)] p-4 text-left outline-none hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      key={`verification:${task.runId}`}
                      onClick={() => openVerificationProject(project, task)}
                      type="button"
                    >
                      <span className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                          <strong className="block truncate text-sm">
                            {project.name}
                          </strong>
                          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                            确认测试结果
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-[var(--accent)]">
                          去确认 ›
                        </span>
                      </span>
                      <span className="mt-3 block text-xs leading-5 text-[var(--muted-foreground)]">
                        测试版已经可以访问，请打开主要页面确认功能是否符合预期。
                      </span>
                      <span className="mt-3 block rounded-md bg-[var(--surface)]/75 px-3 py-2 text-[11px] leading-5 text-[var(--muted-foreground)]">
                        系统检查已经通过
                        <span className="mx-1.5">·</span>
                        当前：等待确认测试结果
                      </span>
                    </button>
                  ))}
                  {manualAttentionItems.map(({ project, run }) => (
                    <DeploymentTaskCard
                      key={run?.id ?? project.id}
                      onOpen={() => openActivityProject(project, run)}
                      project={project}
                      run={run}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {automaticAttentionItems.length ? (
              <section>
                <h3 className="mb-2 mt-0 text-xs font-medium text-[var(--muted-foreground)]">
                  自动处理中
                </h3>
                <div className="space-y-2">
                  {automaticAttentionItems.map(({ project, run }) => (
                    <DeploymentTaskCard
                      key={run?.id ?? project.id}
                      onOpen={() => openActivityProject(project, run)}
                      project={project}
                      run={run}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {!hasUserAttention && !automaticAttentionItems.length ? (
              completedItems.length ? (
                <div className="flex items-center gap-2 rounded-md bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success)]">
                  <CheckCircle2 className="size-4 shrink-0" />
                  当前没有自动处理或需要你操作的任务
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-8 text-center">
                  <CheckCircle2 className="mx-auto size-6 text-[var(--success)]" />
                  <strong className="mt-3 block text-sm">
                    当前没有待处理任务
                  </strong>
                  <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                    新的远程部署会自动出现在这里。
                  </span>
                </div>
              )
            ) : null}
            {completedItems.length ? (
              <section>
                <div className="mb-2 flex items-center justify-between gap-4">
                  <h3 className="m-0 text-xs font-medium text-[var(--muted-foreground)]">
                    最近完成
                  </h3>
                  {hiddenCompletedCount > 0 ? (
                    <span className="text-[11px] text-[var(--subtle-foreground)]">
                      只显示最近 {RECENT_COMPLETED_TASK_LIMIT} 项
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {completedItems.map(({ project, run }) => {
                    const environment =
                      run?.environment ?? project.latestEnvironment;
                    const testVerified = completedTestVerified(
                      project,
                      run,
                      [...completedRuns, ...taskRuns],
                      releaseReadyProjectPaths,
                    );
                    return (
                      <button
                        className="flex w-full items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left outline-none hover:bg-[var(--muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                        key={run?.id ?? project.id}
                        onClick={() => openActivityProject(project, run)}
                        type="button"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" />
                          <span className="min-w-0">
                            <strong className="block truncate text-sm">
                              {project.name}
                            </strong>
                            <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
                              {environment === "production"
                                ? "正式版发布完成"
                                : testVerified
                                  ? "测试已通过"
                                  : "测试版部署完成"}
                              {run
                                ? ` · ${completedVersionLabel(run, completedRuns)}`
                                : ""}
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-[var(--subtle-foreground)]">
                              {completedActivitySummary(
                                project,
                                run,
                                testVerified,
                              )}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-[var(--success)]">
                          查看结果 ›
                        </span>
                      </button>
                    );
                  })}
                </div>
                {hiddenCompletedCount > 0 ? (
                  <p className="mb-0 mt-2 text-right text-[11px] text-[var(--subtle-foreground)]">
                    其余结果可在对应项目中查看
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

export function deploymentTaskActive(
  project: RecentProject,
  run?: DeploymentRun,
) {
  if (!project.pathExists) return false;
  if (run) return run.status === "queued" || run.status === "running";
  return (
    project.activeRunCount > 0 ||
    project.latestStatus === "queued" ||
    project.latestStatus === "running"
  );
}

function DeploymentTaskCard({
  onOpen,
  project,
  run,
}: {
  onOpen: () => void;
  project: RecentProject;
  run?: DeploymentRun;
}) {
  const active = deploymentTaskActive(project, run);
  const status = run?.status ?? project.latestStatus;
  const environment =
    run?.environment ?? project.latestEnvironment ?? "staging";
  const currentStage =
    run?.currentStage ??
    project.latestCurrentStage ??
    (active ? "queued" : "prepare");
  const completedSteps =
    run?.completedSteps ?? project.latestCompletedSteps ?? [];
  const completed = activityCompletedLabels(completedSteps, environment);
  const actionKind = run?.actionKind ?? project.latestActionKind;
  const pendingStep = activityPendingStepLabel(
    actionKind,
    environment,
    currentStage,
  );
  const title = active
    ? `${environment === "deployment" ? "正在上线" : environment === "production" ? "正在发布正式版" : "正在部署测试版"} · ${activityStageLabel(currentStage, environment)}`
    : status === "needs_action"
      ? deploymentNeedsActionStatus(environment, run?.actionKind)
      : status === "failed"
        ? environment === "deployment"
          ? "上次上线没有完成"
          : environment === "production"
            ? "正式发布没有完成"
            : "测试部署没有完成"
        : recentProjectStatus(project, run);
  const tone = active
    ? "border-[var(--accent)]/30 bg-[var(--accent-soft)]"
    : status === "failed"
      ? "border-[var(--destructive)]/25 bg-[var(--destructive-soft)]/40"
      : "border-[var(--warning)]/30 bg-[var(--warning-soft)]/35";
  const ActionIcon = active
    ? LoaderCircle
    : status === "failed"
      ? XCircle
      : AlertCircle;

  return (
    <button
      className={`block w-full rounded-lg border p-4 text-left outline-none hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${tone}`}
      onClick={onOpen}
      type="button"
    >
      <span className="flex items-start justify-between gap-4">
        <span className="flex min-w-0 gap-3">
          <ActionIcon
            className={`mt-0.5 size-4 shrink-0 ${active ? "animate-spin-slow text-[var(--accent)]" : status === "failed" ? "text-[var(--destructive)]" : "text-[var(--warning)]"}`}
          />
          <span className="min-w-0">
            <strong className="block truncate text-sm">{project.name}</strong>
            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
              {title}
            </span>
          </span>
        </span>
        <span
          className={`shrink-0 text-xs ${active ? "text-[var(--accent)]" : status === "failed" ? "text-[var(--destructive)]" : "text-[var(--warning)]"}`}
        >
          {activityTaskAction(project, run)} ›
        </span>
      </span>
      <span className="mt-3 block text-xs leading-5 text-[var(--muted-foreground)]">
        {activityUserMessage(project, run)}
      </span>
      {active && run ? (
        <span className="mt-3 block">
          <Progress value={activityProgress(run)} />
        </span>
      ) : null}
      {completed.length ? (
        <span className="mt-3 block rounded-md bg-[var(--surface)]/75 px-3 py-2 text-[11px] leading-5 text-[var(--muted-foreground)]">
          已经完成：{completed.join("、")}
          {!active ? (
            <>
              <span className="mx-1.5">·</span>
              任务停在：{pendingStep}
            </>
          ) : null}
        </span>
      ) : !active ? (
        <span className="mt-3 block rounded-md bg-[var(--surface)]/75 px-3 py-2 text-[11px] leading-5 text-[var(--muted-foreground)]">
          任务停在：{pendingStep}
        </span>
      ) : null}
    </button>
  );
}

export function activityTaskAction(
  project: RecentProject,
  run?: DeploymentRun,
) {
  if (!project.pathExists) return "重新找到项目";
  if (deploymentTaskActive(project, run)) return "自动处理中";
  const status = run?.status ?? project.latestStatus;
  if (status === "failed") return "查看处理方法";
  const environment =
    run?.environment ?? project.latestEnvironment ?? "staging";
  const actionKind = run?.actionKind ?? project.latestActionKind;
  if (status === "needs_action") {
    return (
      {
        "deployment-path-route-check": "检查访问地址",
        "deployment-path-route-repair": "修复访问地址",
        "deployment-path-route-takeover": "确认地址接管",
        "deployment-path-retry": "继续上线",
        "route-check":
          environment === "deployment"
            ? "检查访问地址"
            : environment === "production"
              ? "设置正式地址"
              : "验证测试版",
        "route-repair": "修复访问地址",
        "route-takeover": "确认地址接管",
        "local-preview": "验证测试版",
        "cloud-config": "准备配置",
        "cloud-setup": "准备配置",
        "cnb-builds": "更新授权",
        "verify-release": "核对部署结果",
        "artifact-mismatch": "查看版本问题",
        "redeploy-test": "重新部署测试版",
      }[actionKind ?? ""] ??
      ((run?.issueCode ?? project.latestIssueCode) === "AD-CTR-201"
        ? "检查服务原因"
        : "查看处理方法")
    );
  }
  return "查看结果";
}

function activityPendingStepLabel(
  actionKind: string | null | undefined,
  environment: DeploymentRun["environment"],
  currentStage: string,
) {
  return (
    {
      "deployment-path-route-check": "检查访问地址",
      "deployment-path-route-repair": "修复访问地址",
      "deployment-path-route-takeover": "确认地址接管",
      "deployment-path-retry": "继续上线",
      "route-check":
        environment === "deployment"
          ? "检查访问地址"
          : environment === "production"
            ? "设置正式地址"
            : "验证测试版",
      "route-repair": "修复访问地址",
      "route-takeover": "确认地址接管",
      "local-preview": "验证测试版",
      "cloud-config": "准备配置",
      "cloud-setup": "准备配置",
      "cnb-builds": "更新授权",
      "verify-release": "核对部署结果",
      "artifact-mismatch": "核对正式版本",
      "redeploy-test": "重新部署测试版",
    }[actionKind ?? ""] ?? activityStageLabel(currentStage, environment)
  );
}

export function completedActivitySummary(
  project: RecentProject,
  run?: DeploymentRun,
  testVerified = false,
) {
  const environment = run?.environment ?? project.latestEnvironment;
  return environment === "deployment"
    ? "上线完成，访问地址可以打开"
    : environment === "production"
      ? "测试通过的同一版本已经上线，正式地址可以访问"
      : testVerified
        ? "测试结果已经确认，可以查看当前版本"
        : "测试版已经正常运行，可以查看当前结果";
}

export function completedTestVerified(
  project: RecentProject,
  run: DeploymentRun | undefined,
  relatedRuns: DeploymentRun[],
  releaseReadyProjectPaths: ReadonlySet<string>,
) {
  if ((run?.environment ?? project.latestEnvironment) !== "staging") {
    return false;
  }
  if (releaseReadyProjectPaths.has(project.path)) return true;
  return Boolean(
    run &&
    relatedRuns.some(
      (candidate) =>
        candidate.environment === "production" &&
        candidate.sourceRunId === run.id,
    ),
  );
}

export function completedVersionLabel(
  run: DeploymentRun,
  relatedRuns: DeploymentRun[] = [],
) {
  const source = run.sourceRunId
    ? relatedRuns.find((candidate) => candidate.id === run.sourceRunId)
    : undefined;
  const title =
    primaryVersionTitle(run.sourceTitle) ||
    primaryVersionTitle(source?.sourceTitle);
  if (title) return title;
  const time = new Date(run.startedAt);
  if (!Number.isNaN(time.getTime())) {
    return `${new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(time)} 的版本`;
  }
  return "已保存的部署记录";
}

export function activityUserMessage(
  project: RecentProject,
  run?: DeploymentRun,
) {
  if (run && (run.status === "queued" || run.status === "running")) {
    return `正在${activityStageLabel(run.currentStage, run.environment)}；可以离开页面，远程任务会继续。`;
  }
  const status = run?.status ?? project.latestStatus;
  const message = run?.message ?? project.latestMessage ?? "";
  const issueCode = run?.issueCode ?? project.latestIssueCode;
  if (status === "failed" || status === "needs_action") {
    const environment = run?.environment ?? project.latestEnvironment;
    const actionKind = run?.actionKind ?? project.latestActionKind;
    if (
      actionKind === "route-check" ||
      actionKind === "deployment-path-route-check"
    ) {
      return environment === "deployment"
        ? "应用已经启动；打开项目处理访问地址，完成后继续检查，不会重新构建。"
        : environment === "production"
          ? "服务已经启动；打开项目查看需要设置的正式地址，完成后返回自动检查。"
          : "测试版已经启动；打开项目后可以从这台电脑验证。";
    }
    if (
      actionKind === "route-repair" ||
      actionKind === "deployment-path-route-repair"
    ) {
      return "服务已经启动；打开项目修复访问地址，不会重新部署版本。";
    }
    const issue = issueFromUnknown(
      issueCode ? `${issueCode}：${message}` : message,
      status === "failed" ? "部署没有完成" : "部署还需要处理",
    );
    const title =
      issueCode === "AD-NET-201"
        ? environment === "deployment"
          ? "访问地址还没有准备好"
          : environment === "production"
            ? "正式地址还没有准备好"
            : "测试地址还没有准备好"
        : issue.title;
    return `${title}；打开项目后可以从当前步骤继续。`;
  }
  return message || "打开项目查看详情";
}

export function setupTaskUserMessage(task: ProjectSetupTask) {
  const target = task.environment === "production" ? "正式版" : "测试版";
  if (task.stage === "first-deploy") {
    return "进入测试版后会先核对服务器、配置和地址；确认仍然有效后即可部署当前代码。";
  }
  if (task.stage === "repository") {
    return "代码平台还没有连接完成；回到项目后可以从这里继续。";
  }
  if (task.stage === "registry") {
    return "版本文件还没有准备完成；已经填写的内容会继续保留。";
  }
  if (task.stage === "test-environment") {
    return "运行服务器、测试配置或测试地址还需要继续准备。";
  }
  if (task.stage === "remote") {
    return "打开项目完成一次网页安全保存，之后会自动进入测试版。";
  }
  if (task.stage === "creation-page-opened") {
    return `还差在代码平台网页创建一次安全位置；打开项目即可继续设置${target}。`;
  }
  if (task.stage === "repository-ready") {
    return `安全保存位置已经确认；还需要准备并保存当前项目的${target}配置。`;
  }
  return "配置内容已经准备好；打开项目复制并粘贴到代码平台网页保存。";
}

function setupTaskCardTitle(task: ProjectSetupTask) {
  if (isFirstDeployTask(task)) return "首次上线设置已完成";
  return projectSetupStatus(task);
}

function setupTaskCardAction(task: ProjectSetupTask) {
  if (isFirstDeployTask(task)) return "去部署";
  if (task.stage === "repository") return "连接代码平台";
  if (task.stage === "registry") return "准备项目版本";
  if (task.stage === "test-environment") return "准备测试环境";
  if (task.stage === "remote") return "开启自动部署";
  if (task.stage === "creation-page-opened") return "继续网页创建";
  if (task.stage === "repository-ready") return "继续准备配置";
  if (task.stage === "save-page-opened") return "继续保存";
  return "继续上线设置";
}

function SidebarButton({
  active,
  badge,
  badgeTone = "warning",
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  badgeTone?: "accent" | "warning";
  icon: typeof LayoutGrid;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={badge ? `${label} ${badge}` : label}
          aria-current={active ? "page" : undefined}
          className={`relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[900px]:justify-center max-[900px]:px-0 ${
            active
              ? "bg-[var(--muted)] font-medium text-[var(--foreground)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
          onClick={onClick}
          type="button"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate max-[900px]:hidden">{label}</span>
          {badge ? (
            <span
              className={`a11y-count-badge ml-auto grid min-w-4 place-items-center rounded-full border border-transparent px-1 text-[9px] font-semibold text-white max-[900px]:absolute max-[900px]:right-1 max-[900px]:top-1 ${badgeTone === "accent" ? "bg-[var(--accent)]" : "bg-[var(--warning)]"}`}
            >
              {badge}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="hidden max-[900px]:block" side="right">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function activityProgress(
  run: Pick<DeploymentRun, "completedSteps" | "currentStage">,
) {
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

export function activityCompletedLabels(
  completedSteps: string[],
  environment: DeploymentRun["environment"] = "staging",
) {
  const completed = new Set(completedSteps);
  return [
    {
      label: "准备项目",
      done: completed.has("write-config"),
    },
    {
      label: environment === "production" ? "确认版本" : "生成版本",
      done: completed.has("verify-build") || completed.has("publish-images"),
    },
    {
      label: "启动服务",
      done: completed.has("deploy"),
    },
    {
      label: "确认可用",
      done: completed.has("healthcheck"),
    },
  ]
    .filter((item) => item.done)
    .map((item) => item.label);
}

export function activityStageLabel(
  stage: string,
  environment: DeploymentRun["environment"] = "staging",
) {
  return (
    {
      queued: "等待开始",
      prepare: "准备项目",
      "cloud-setup": "保存远程配置",
      "prepare-config": "准备运行配置",
      build: environment === "production" ? "确认版本" : "生成版本",
      publish: environment === "production" ? "确认版本" : "保存版本",
      "prepare-server": "准备运行服务器",
      deploy: "启动服务",
      healthcheck: "检查访问地址",
      "verify-release": "确认版本可用",
      rollback: "恢复上个版本",
      complete: "已经完成",
    }[stage] ?? "正在处理"
  );
}

function ProjectButton({
  active,
  onClick,
  project,
  releaseReady,
  setupTask,
  task,
  verificationTask,
}: {
  active: boolean;
  onClick: () => void;
  project: RecentProject;
  releaseReady: boolean;
  setupTask?: ProjectSetupTask;
  task?: DeploymentRun;
  verificationTask?: ProjectVerificationTask;
}) {
  const taskActive = task && ["queued", "running"].includes(task.status);
  const taskNeedsAction = task?.status === "needs_action";
  const taskFailed = task?.status === "failed";
  const firstDeploy = isFirstDeployTask(setupTask);
  const StatusIcon = !project.pathExists
    ? AlertCircle
    : taskActive
      ? LoaderCircle
      : taskNeedsAction
        ? AlertCircle
        : taskFailed
          ? XCircle
          : project.activeRunCount
            ? LoaderCircle
            : verificationTask
              ? Circle
              : project.latestStatus === "success"
                ? CheckCircle2
                : project.latestStatus === "failed"
                  ? XCircle
                  : project.latestStatus === "needs_action"
                    ? AlertCircle
                    : setupTask && !firstDeploy
                      ? AlertCircle
                      : Circle;
  const statusClass = !project.pathExists
    ? "text-[var(--warning)]"
    : taskActive
      ? "text-[var(--accent)]"
      : taskNeedsAction
        ? "text-[var(--warning)]"
        : taskFailed
          ? "text-[var(--destructive)]"
          : project.activeRunCount
            ? "text-[var(--accent)]"
            : verificationTask
              ? "text-[var(--accent)]"
              : project.latestStatus === "success"
                ? "text-[var(--success)]"
                : project.latestStatus === "failed"
                  ? "text-[var(--destructive)]"
                  : project.latestStatus === "needs_action"
                    ? "text-[var(--warning)]"
                    : firstDeploy
                      ? "text-[var(--accent)]"
                      : setupTask
                        ? "text-[var(--warning)]"
                        : "text-[var(--subtle-foreground)]";
  const status = recentProjectStatus(
    project,
    task,
    setupTask,
    verificationTask,
    releaseReady,
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${project.name} ${status}`}
          aria-current={active ? "page" : undefined}
          className={`flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[900px]:justify-center ${
            active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--muted)]"
          }`}
          onClick={onClick}
          type="button"
        >
          <span className="relative grid size-8 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]">
            <FolderKanban className="size-4" />
            <StatusIcon
              className={`absolute -bottom-1 -right-1 size-3.5 rounded-full bg-[var(--surface)] ${statusClass} ${taskActive || (!task && project.activeRunCount) ? "animate-spin-slow" : ""}`}
            />
          </span>
          <span className="min-w-0 flex-1 max-[900px]:hidden">
            <strong className="block truncate text-xs font-medium">
              {project.name}
            </strong>
            <span className="mt-0.5 block truncate text-[10px] text-[var(--muted-foreground)]">
              {status}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="hidden max-[900px]:block" side="right">
        {project.name} · {status}
      </TooltipContent>
    </Tooltip>
  );
}
