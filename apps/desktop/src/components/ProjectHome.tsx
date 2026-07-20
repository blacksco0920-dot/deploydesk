import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DeploymentRun, RecentProject, SystemPreflight } from "../types";
import {
  isFirstDeployTask,
  preferredProjectTask,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface ProjectHomeProps {
  embedded?: boolean;
  loading: boolean;
  preflight: SystemPreflight | null;
  projects: RecentProject[];
  releaseReadyPaths?: string[];
  selectingProject?: boolean;
  selectionIssue?: {
    message: string;
    title: string;
  } | null;
  setupTasks?: ProjectSetupTask[];
  verificationTasks?: ProjectVerificationTask[];
  taskRuns: DeploymentRun[];
  showDemo: boolean;
  onSelect: () => void;
  onDemo: () => void;
  onOpen: (project: RecentProject) => void;
  onForget: (project: RecentProject) => void;
}

export function ProjectHome({
  embedded = false,
  loading,
  preflight,
  projects,
  releaseReadyPaths = [],
  selectingProject = false,
  selectionIssue = null,
  setupTasks = [],
  verificationTasks = [],
  taskRuns,
  showDemo,
  onSelect,
  onDemo,
  onOpen,
  onForget,
}: ProjectHomeProps) {
  const [query, setQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<RecentProject | null>(
    null,
  );
  const releaseReadyProjectPaths = new Set(releaseReadyPaths);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(normalized) ||
        project.path.toLocaleLowerCase().includes(normalized),
    );
  }, [projects, query]);
  const visibleProjects = filtered
    .map((project) => {
      const task = preferredProjectTask(taskRuns, project.path);
      const setupTask = setupTasks.find(
        (item) =>
          item.projectPath === project.path &&
          (!isFirstDeployTask(item) || project.latestStatus === null),
      );
      const verificationTask = verificationTasks.find(
        (item) =>
          item.projectPath === project.path &&
          item.runId === project.latestRunId &&
          project.latestStatus === "success" &&
          project.latestEnvironment === "staging",
      );
      return {
        project,
        setupTask,
        state: projectListState(project, task, setupTask, verificationTask),
        task,
        verificationTask,
      };
    })
    .sort(
      (left, right) =>
        projectListStatePriority(left.state) -
        projectListStatePriority(right.state),
    );
  const userActionCount = visibleProjects.filter(
    ({ state }) => state === "user-action",
  ).length;
  const automaticCount = visibleProjects.filter(
    ({ state }) => state === "automatic",
  ).length;
  const visibleProjectGroups = [
    {
      key: "user-action",
      label: "等待你处理",
      projects: visibleProjects.filter(({ state }) => state === "user-action"),
    },
    {
      key: "automatic",
      label: "自动处理中",
      projects: visibleProjects.filter(({ state }) => state === "automatic"),
    },
    {
      key: "normal",
      label: userActionCount || automaticCount ? "其他项目" : "项目",
      projects: visibleProjects.filter(({ state }) => state === "normal"),
    },
  ].filter((group) => group.projects.length > 0);
  const recoveringProjects = loading && projects.length === 0;
  const projectSelectionBlocked = recoveringProjects || selectingProject;

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
        <header
          className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5"
          data-tauri-drag-region
        >
          {embedded ? (
            <strong className="text-sm font-medium">所有项目</strong>
          ) : (
            <Brand />
          )}
          {!embedded ? (
            <Button
              disabled={projectSelectionBlocked}
              onClick={onSelect}
              size="sm"
            >
              {selectingProject ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Plus />
              )}
              添加项目
            </Button>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-auto">
          <div
            className={`mx-auto w-full max-w-[900px] px-6 ${embedded ? "py-8" : "py-12"}`}
          >
            <div className="mb-9 flex items-end justify-between gap-6">
              <div>
                <h1 className="m-0 text-[28px] font-semibold leading-tight">
                  {recoveringProjects
                    ? "正在恢复工作区"
                    : projects.length
                      ? "继续你的项目"
                      : "部署第一个项目"}
                </h1>
                <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                  {recoveringProjects
                    ? "正在查找这台电脑上已经保存的项目和部署进度。"
                    : projects.length
                      ? "项目、连接和部署进度已经保存在这台电脑上。"
                      : "选择 AI 生成的整个项目文件夹，系统会先只读识别。"}
                </p>
              </div>
              {projects.length > 4 ? (
                <label className="relative block w-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--subtle-foreground)]" />
                  <Input
                    className="pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="查找项目"
                    value={query}
                  />
                </label>
              ) : null}
            </div>

            {selectionIssue ? (
              <div
                className="mb-5 flex items-start justify-between gap-5 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-3"
                role="alert"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                  <div>
                    <strong className="text-sm">{selectionIssue.title}</strong>
                    <p className="mb-0 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                      {selectionIssue.message}
                    </p>
                  </div>
                </div>
                <Button
                  disabled={selectingProject}
                  onClick={onSelect}
                  size="sm"
                >
                  <FolderOpen />
                  重新选择文件夹
                </Button>
              </div>
            ) : null}

            {recoveringProjects ? (
              <section className="flex min-h-[240px] flex-col items-center justify-center border-y border-[var(--border)] py-12 text-center">
                <LoaderCircle className="size-6 animate-spin-slow text-[var(--accent)]" />
                <strong className="mt-4 text-sm">正在读取最近项目</strong>
                <span className="mt-1 text-xs text-[var(--muted-foreground)]">
                  如果有上次打开的项目，会直接回到它的发布中心。
                </span>
              </section>
            ) : projects.length ? (
              <section
                aria-label="按当前状态分组的项目"
                className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              >
                {visibleProjectGroups.map((group) => (
                  <div
                    className="border-b border-[var(--border)] last:border-b-0"
                    key={group.key}
                  >
                    <h2 className="m-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--muted)] px-4 py-2 text-xs font-medium text-[var(--muted-foreground)]">
                      <span>{group.label}</span>
                      <span>{group.projects.length}</span>
                    </h2>
                    {group.projects.map(
                      ({ project, setupTask, task, verificationTask }) => {
                        return (
                          <div
                            className="group flex min-h-[76px] items-center gap-3 border-b border-[var(--border)] px-4 last:border-b-0 hover:bg-[var(--muted)]"
                            key={project.id}
                          >
                            <button
                              className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]"
                              onClick={() => onOpen(project)}
                              type="button"
                            >
                              <span className="grid size-10 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]">
                                <FolderOpen className="size-[18px]" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <strong className="truncate text-sm font-medium">
                                    {project.name}
                                  </strong>
                                  {!project.pathExists ? (
                                    <span className="text-xs text-[var(--warning)]">
                                      找不到原文件夹
                                    </span>
                                  ) : null}
                                </span>
                                <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]">
                                  {project.serviceCount} 个服务 ·{" "}
                                  {recentProjectStatus(
                                    project,
                                    task,
                                    setupTask,
                                    verificationTask,
                                    releaseReadyProjectPaths.has(project.path),
                                  )}
                                </span>
                              </span>
                              {project.pathExists ? (
                                <span className="hidden items-center gap-1.5 text-xs text-[var(--subtle-foreground)] sm:flex">
                                  <Clock3 className="size-3.5" />
                                  {formatRelativeTime(project.lastOpenedAt)}
                                </span>
                              ) : (
                                <span className="hidden text-xs font-medium text-[var(--warning)] sm:block">
                                  重新找到
                                </span>
                              )}
                              <ArrowRight className="size-4 shrink-0 text-[var(--subtle-foreground)]" />
                            </button>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  aria-label={`从列表隐藏 ${project.name}`}
                                  className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                                  onClick={() => setPendingRemoval(project)}
                                  size="icon"
                                  variant="ghost"
                                >
                                  <MoreHorizontal />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>从列表隐藏</TooltipContent>
                            </Tooltip>
                          </div>
                        );
                      },
                    )}
                  </div>
                ))}
                {!visibleProjects.length ? (
                  <div className="px-5 py-12 text-center text-sm text-[var(--muted-foreground)]">
                    没有匹配的项目
                  </div>
                ) : null}
              </section>
            ) : (
              <section className="flex min-h-[280px] flex-col items-center justify-center border-y border-[var(--border)] py-12 text-center">
                <span className="mb-5 grid size-12 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                  <FolderOpen className="size-5" />
                </span>
                <h2 className="m-0 text-base font-semibold">从本机项目开始</h2>
                <p className="mb-6 mt-2 max-w-md text-sm leading-6 text-[var(--muted-foreground)]">
                  选择包含前端、后端等完整代码的最外层文件夹，不要只选其中一个子文件夹。识别过程不会运行代码，也不会读取配置值。
                </p>
                <div className="flex items-center gap-2">
                  <Button disabled={selectingProject} onClick={onSelect}>
                    <FolderOpen />
                    选择整个项目文件夹
                  </Button>
                  {showDemo ? (
                    <Button onClick={onDemo} variant="secondary">
                      查看示例
                    </Button>
                  ) : null}
                </div>
              </section>
            )}

            <div className="mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <CheckCircle2
                className={
                  preflight?.ready_for_local_preview
                    ? "size-4 text-[var(--success)]"
                    : "size-4 text-[var(--warning)]"
                }
              />
              <span>
                {preflight
                  ? preflight.ready_for_local_preview
                    ? `本机环境可用 · ${friendlyOperatingSystem(preflight.operating_system)}`
                    : "本机环境还需要准备，进入项目后会给出具体原因"
                  : "正在检查本机部署能力"}
              </span>
            </div>
          </div>
        </main>
      </div>

      <Dialog
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        open={Boolean(pendingRemoval)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              从列表隐藏 {pendingRemoval?.name ?? "这个项目"}？
            </DialogTitle>
            <DialogDescription>
              只会从 ABCDeploy 的项目列表中隐藏。项目代码、连接、项目设置、
              配置引用、版本和部署历史都会保留；以后重新添加同一路径时会自动恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPendingRemoval(null)} variant="secondary">
              取消
            </Button>
            <Button
              aria-label={`确认从列表隐藏 ${pendingRemoval?.name ?? "这个项目"}`}
              onClick={() => {
                if (pendingRemoval) onForget(pendingRemoval);
                setPendingRemoval(null);
              }}
              variant="destructive"
            >
              <Trash2 />
              从列表隐藏
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

export type ProjectListState = "user-action" | "automatic" | "normal";

export function projectListState(
  project: RecentProject,
  task?: DeploymentRun,
  setupTask?: ProjectSetupTask,
  verificationTask?: ProjectVerificationTask,
): ProjectListState {
  if (!project.pathExists) return "user-action";
  if (task?.status === "failed" || task?.status === "needs_action") {
    return "user-action";
  }
  if (task?.status === "queued" || task?.status === "running") {
    return "automatic";
  }
  if (project.activeRunCount > 0) return "automatic";
  if (setupTask || verificationTask) return "user-action";
  if (
    project.latestStatus === "failed" ||
    project.latestStatus === "needs_action"
  ) {
    return "user-action";
  }
  return "normal";
}

function projectListStatePriority(state: ProjectListState) {
  return state === "user-action" ? 0 : state === "automatic" ? 1 : 2;
}

export function friendlyOperatingSystem(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "macos" || normalized === "darwin") return "macOS";
  if (normalized === "windows" || normalized === "win32") return "Windows";
  if (normalized === "linux") return "Linux";
  return value;
}

function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30
    ? `${days} 天前`
    : new Date(value).toLocaleDateString("zh-CN");
}
