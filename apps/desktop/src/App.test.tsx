import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import * as api from "./api";
import type {
  DeploymentRun,
  RecentProject,
  ServerForm,
  WorkspacePreview,
} from "./types";
import App, {
  deploymentRefreshDelay,
  deploymentRepositoryReady,
  deploymentSceneForProject,
  deploymentSceneForRun,
  deploymentVersionForProject,
  deploymentVersionForRun,
  mergeDeploymentRun,
  projectSceneFromSetting,
  projectSelectionIssueFromMessage,
  sameProjectPath,
  setupSceneForTask,
  shouldApplyProjectResult,
  shouldRefreshDeploymentStatus,
  shouldReuseProjectWorkspace,
  workspaceAllowsExternalSync,
} from "./App";
import { deploymentVersionKey } from "./lib/projects";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

describe("ABCDeploy 场景化主线", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("只在项目场景刷新部署状态", () => {
    expect(shouldRefreshDeploymentStatus("home")).toBe(false);
    expect(shouldRefreshDeploymentStatus("configuration")).toBe(false);
    expect(shouldRefreshDeploymentStatus("project")).toBe(true);
  });

  it("没有部署任务时降低后台刷新频率", () => {
    expect(deploymentRefreshDelay(true)).toBe(8_000);
    expect(deploymentRefreshDelay(false)).toBe(60_000);
  });

  it("只把异步结果写回发起请求的项目", () => {
    expect(shouldApplyProjectResult("/demo/a", "/demo/a")).toBe(true);
    expect(shouldApplyProjectResult("/demo/b", "/demo/a")).toBe(false);
    expect(shouldApplyProjectResult("", "/demo/a")).toBe(false);
  });

  it("刷新历史记录不会把它误认为当前部署", () => {
    const newer = deploymentRun("/demo/stable-order", {
      id: "newer",
      commitSha: null,
      candidateTag: null,
    });
    const older = deploymentRun("/demo/stable-order", {
      id: "older",
      commitSha: null,
      candidateTag: null,
    });
    newer.startedAt = "2026-07-15T10:00:00.000Z";
    newer.updatedAt = "2026-07-15T10:01:00.000Z";
    older.startedAt = "2026-07-14T10:00:00.000Z";
    older.updatedAt = "2026-07-14T10:01:00.000Z";
    const refreshedOlder = {
      ...older,
      message: "刚刚重新检查过历史版本",
      updatedAt: "2026-07-15T11:00:00.000Z",
    };

    const merged = mergeDeploymentRun([newer, older], refreshedOlder);

    expect(merged.map((run) => run.id)).toEqual(["newer", "older"]);
    expect(merged[1]).toEqual(refreshedOlder);
  });

  it("只有配置好真实代码仓库后才自动查询远程版本", () => {
    expect(
      deploymentRepositoryReady(
        `providers:\n  build:\n    repository: team/app\n`,
      ),
    ).toBe(true);
    expect(
      deploymentRepositoryReady(
        `providers:\n  build:\n    repository: owner/replace-me\n`,
      ),
    ).toBe(false);
    expect(deploymentRepositoryReady("not: [valid")).toBe(false);
  });

  it("只有接管完成或已保存的新项目才允许同步远程部署", () => {
    const adoption = {
      detected: true,
      repository: "team/app",
      pipelineExists: true,
      historyImportAfter: null,
      freshDraft: false,
    };
    expect(
      workspaceAllowsExternalSync({
        adoption: { ...adoption, mode: "pending" },
      }),
    ).toBe(false);
    expect(
      workspaceAllowsExternalSync({
        adoption: { ...adoption, mode: "managed" },
      }),
    ).toBe(true);
    expect(
      workspaceAllowsExternalSync({
        adoption: { ...adoption, mode: "fresh", freshDraft: true },
      }),
    ).toBe(false);
    expect(
      workspaceAllowsExternalSync({
        adoption: { ...adoption, mode: "fresh", freshDraft: false },
      }),
    ).toBe(true);
  });

  it("发现已有上线时先让用户选择，继续管理后只同步一次再进入发布中心", async () => {
    const path = "/demo/adopt-existing-deployment";
    const workspace = await api.openProject(path);
    const manifest = parseDocument(workspace.manifestYaml);
    manifest.setIn(["providers", "build", "repository"], "team/existing");
    const pending: WorkspacePreview = {
      ...workspace,
      manifestYaml: manifest.toString(),
      adoption: {
        mode: "pending",
        detected: true,
        repository: "team/existing",
        pipelineExists: true,
        historyImportAfter: null,
        freshDraft: false,
      },
    };
    const managed: WorkspacePreview = {
      ...pending,
      adoption: { ...pending.adoption, mode: "managed" },
    };
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([
      recentProject(path, "existing-deployment"),
    ]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(pending);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    const getServer = vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const adopt = vi
      .spyOn(api, "continueExistingDeployment")
      .mockResolvedValue(managed);
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockResolvedValue([]);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "检测到已有上线配置" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "发布中心" }),
    ).not.toBeInTheDocument();
    expect(syncExternal).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续管理已有部署" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "检测到已有上线配置" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("发布中心", { selector: "h1" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(adopt).toHaveBeenCalledWith(path));
    await waitFor(() => expect(syncExternal).toHaveBeenCalledTimes(1));
    expect(syncExternal).toHaveBeenCalledWith(path);
    expect(getServer).toHaveBeenCalledWith(path, "staging");
    expect(getServer).toHaveBeenCalledWith(path, "production");
    await act(async () => Promise.resolve());
    expect(syncExternal).toHaveBeenCalledTimes(1);
  });

  it("历史同步失败也保留接管结果并给出错误", async () => {
    const path = "/demo/adoption-sync-failure";
    const workspace = await api.openProject(path);
    const pending: WorkspacePreview = {
      ...workspace,
      adoption: {
        mode: "pending",
        detected: true,
        repository: "team/sync-failure",
        pipelineExists: true,
        historyImportAfter: null,
        freshDraft: false,
      },
    };
    const managed: WorkspacePreview = {
      ...pending,
      adoption: { ...pending.adoption, mode: "managed" },
    };
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([
      recentProject(path, "sync-failure"),
    ]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(pending);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    vi.spyOn(api, "continueExistingDeployment").mockResolvedValue(managed);
    vi.spyOn(api, "syncExternalDeployments").mockRejectedValue(
      new Error("CNB 暂时不可用"),
    );

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "继续管理已有部署" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "检测到已有上线配置" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("发布中心", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/历史部署暂时没有同步成功/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "检测到已有上线配置" }),
    ).not.toBeInTheDocument();
  });

  it("重新设置会清空当前展示状态并从发布中心原地打开项目设置", async () => {
    const path = "/demo/reset-existing-deployment";
    const workspace = await api.openProject(path);
    const pending: WorkspacePreview = {
      ...workspace,
      adoption: {
        mode: "pending",
        detected: true,
        repository: "team/reset-existing",
        pipelineExists: true,
        historyImportAfter: null,
        freshDraft: false,
      },
    };
    const fresh: WorkspacePreview = {
      ...pending,
      adoption: {
        ...pending.adoption,
        mode: "fresh",
        freshDraft: true,
        historyImportAfter: "2026-07-17T10:00:00.000Z",
      },
    };
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([
      recentProject(path, "reset-existing"),
    ]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(pending);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const reset = vi
      .spyOn(api, "resetProjectDeployment")
      .mockResolvedValue(fresh);
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockResolvedValue([]);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "重新设置部署" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "确定重新设置部署？",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "确认重新设置" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "完成当前上线设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("发布中心", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith(path);
    expect(syncExternal).not.toHaveBeenCalled();
  });

  it("应用进入后台后暂停轮询，回到前台立即补查一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = vi
      .spyOn(api, "listActiveDeploymentRuns")
      .mockResolvedValue([]);

    render(<App />);
    await vi.waitFor(() => expect(active.mock.calls.length).toBeGreaterThan(1));
    await act(async () => Promise.resolve());
    const beforeBlur = active.mock.calls.length;

    act(() => window.dispatchEvent(new Event("blur")));
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
      await Promise.resolve();
    });
    expect(active).toHaveBeenCalledTimes(beforeBlur);

    act(() => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() =>
      expect(active.mock.calls.length).toBeGreaterThan(beforeBlur),
    );
  });

  it("尚未配置代码仓库的项目不在后台访问 CNB", async () => {
    const path = "/demo/local-only-project";
    const workspace = await api.openProject(path);
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([
      recentProject(path, "local-only-project"),
    ]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockResolvedValue([]);

    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    await act(async () => Promise.resolve());
    expect(syncExternal).not.toHaveBeenCalled();
  });

  it("浏览版本不创建待办，明确开始后才记录上线任务", async () => {
    const path = "/demo/read-only-version-browsing";
    const project = recentProject(path, "read-only-version-browsing");
    const workspace = await api.openProject(path);
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);
    await screen.findByRole("heading", { name: "发布中心" });

    fireEvent.click(screen.getByRole("button", { name: "版本" }));
    expect(
      await screen.findByRole("heading", { name: "版本" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "版本记录" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在等待第一个版本")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待处理" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /read-only-version-browsing.*尚未开始上线/,
      }),
    ).toBeInTheDocument();

    const projectNavigation = screen.getByLabelText("项目导航");
    fireEvent.click(
      within(projectNavigation).getByRole("button", { name: "项目设置" }),
    );
    await screen.findByRole("heading", { name: "项目设置" });
    expect(
      within(projectNavigation).getByRole("button", { name: "项目设置" }),
    ).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /待处理 1/ }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", {
        name: /read-only-version-browsing.*还差连接代码平台/,
      }),
    ).toBeInTheDocument();
  });

  it("前后台切换时复用尚未完成的远程同步", async () => {
    const path = "/demo/deduplicate-remote-sync";
    const workspace = await api.openProject(path);
    const manifest = parseDocument(workspace.manifestYaml);
    manifest.setIn(
      ["providers", "build", "repository"],
      "team/deduplicate-remote-sync",
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([
      recentProject(path, "deduplicate-remote-sync"),
    ]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue({
      ...workspace,
      manifestYaml: manifest.toString(),
    });
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    let finishSync: ((runs: DeploymentRun[]) => void) | undefined;
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishSync = resolve;
          }),
      );

    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(syncExternal).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event("blur")));
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => Promise.resolve());
    expect(syncExternal).toHaveBeenCalledTimes(1);

    act(() => finishSync?.([]));
    await act(async () => Promise.resolve());
  });

  it("后台发现新的部署任务时不改变用户正在看的项目页面", async () => {
    const path = "/demo/background-run-keeps-current-page";
    const workspace = await api.openProject(path);
    const manifest = parseDocument(workspace.manifestYaml);
    manifest.setIn(
      ["providers", "build", "repository"],
      "team/background-run-keeps-current-page",
    );
    const project = recentProject(path, "background-run-keeps-current-page");
    const running = deploymentRun(path, {
      id: "background-staging-run",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    running.status = "running";
    running.currentStage = "build";

    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue({
      ...workspace,
      manifestYaml: manifest.toString(),
    });
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    let externalSyncFinished = false;
    const listRuns = vi
      .spyOn(api, "listDeploymentRuns")
      .mockImplementation(async () => (externalSyncFinished ? [running] : []));
    let finishSync: (() => void) | undefined;
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockImplementation(
        () =>
          new Promise<DeploymentRun[]>((resolve) => {
            finishSync = () => resolve([]);
          }),
      );

    render(<App />);
    await screen.findByRole("heading", { name: "发布中心" });
    fireEvent.click(screen.getByRole("button", { name: "在本机运行" }));
    await screen.findByRole("heading", { name: "在本机运行" });
    await waitFor(() => expect(syncExternal).toHaveBeenCalledWith(path));

    const listCallsBeforeSync = listRuns.mock.calls.length;
    act(() => {
      externalSyncFinished = true;
      finishSync?.();
    });
    await waitFor(() =>
      expect(listRuns.mock.calls.length).toBeGreaterThan(listCallsBeforeSync),
    );
    expect(
      screen.getByRole("heading", { name: "在本机运行" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在本机运行" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "发布中心" }));
    const testEnvironment = await screen.findByRole("button", {
      name: /测试环境：/,
    });
    await waitFor(() =>
      expect(testEnvironment).toHaveAccessibleName(/测试环境：正在部署测试版/),
    );
  });

  it("重新进入当前项目时直接复用已经加载的工作区", () => {
    expect(shouldReuseProjectWorkspace("/demo/app", "/demo/app", true)).toBe(
      true,
    );
    expect(shouldReuseProjectWorkspace("/demo/app", "/demo/other", true)).toBe(
      false,
    );
    expect(shouldReuseProjectWorkspace("/demo/app", "/demo/app", false)).toBe(
      false,
    );
  });

  it("重新找到被移动的项目后保留记录并直接继续", async () => {
    const oldPath = "/demo/original-location";
    const newPath = "/demo/moved-location";
    const workspace = await api.openProject(newPath);
    let recovered = false;
    const missing = {
      ...recentProject(oldPath, "moved-project"),
      pathExists: false,
    };
    vi.spyOn(api, "listRecentProjects").mockImplementation(async () => [
      recovered ? { ...missing, path: newPath, pathExists: true } : missing,
    ]);
    vi.spyOn(api, "selectProjectDirectory").mockResolvedValue(newPath);
    const relink = vi
      .spyOn(api, "relinkProject")
      .mockImplementation(async (oldProjectPath, selectedPath) => {
        expect(oldProjectPath).toBe(oldPath);
        expect(selectedPath).toBe(newPath);
        recovered = true;
        return { path: newPath, name: "moved-project" };
      });
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);
    const recovery = await screen.findByRole("button", {
      name: /moved-project.*2 个服务.*需要重新找到项目/,
    });
    fireEvent.click(recovery);

    await waitFor(() => expect(relink).toHaveBeenCalledWith(oldPath, newPath));
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
  });

  it("从待处理只进入任务对应的处理场景", () => {
    expect(
      deploymentSceneForProject({
        latestActionKind: "cloud-setup",
        latestEnvironment: "staging",
        latestStatus: "needs_action",
      }),
    ).toBe("settings");
    expect(
      deploymentSceneForProject({
        latestActionKind: "route-check",
        latestEnvironment: "production",
        latestStatus: "failed",
      }),
    ).toBe("production");
    expect(
      deploymentSceneForProject({
        latestActionKind: null,
        latestEnvironment: "staging",
        latestStatus: "running",
      }),
    ).toBe("test");
    expect(
      deploymentVersionForProject({
        latestEnvironment: "production",
        latestSourceRunId: "tested-version",
      }),
    ).toBe("tested-version");
    expect(
      deploymentVersionForProject({
        latestEnvironment: "staging",
        latestSourceRunId: "ignored-production-source",
      }),
    ).toBeNull();
    expect(
      deploymentSceneForRun({
        actionKind: "route-check",
        environment: "production",
        status: "needs_action",
      }),
    ).toBe("production");
    expect(
      deploymentSceneForRun({
        actionKind: "cloud-setup",
        environment: "staging",
        status: "needs_action",
      }),
    ).toBe("settings");
    expect(
      deploymentVersionForRun({
        environment: "production",
        sourceRunId: "exact-tested-version",
      }),
    ).toBe("exact-tested-version");
    expect(
      setupSceneForTask({
        environment: "staging",
        projectPath: "/demo/app",
        stage: "save-page-opened",
      }),
    ).toBe("settings");
    expect(
      setupSceneForTask({
        environment: "production",
        projectPath: "/demo/app",
        stage: "save-page-opened",
      }),
    ).toBe("production");
    expect(
      setupSceneForTask({
        environment: "staging",
        projectPath: "/demo/app",
        stage: "first-deploy",
      }),
    ).toBe("test");
  });

  it("恢复新项目场景并把旧环境页迁移到发布中心", () => {
    expect(projectSceneFromSetting("overview")).toBe("overview");
    expect(projectSceneFromSetting("local")).toBe("local");
    expect(projectSceneFromSetting("versions")).toBe("versions");
    expect(projectSceneFromSetting("settings")).toBe("settings");
    expect(projectSceneFromSetting("test")).toBe("overview");
    expect(projectSceneFromSetting("production")).toBe("overview");
    expect(projectSceneFromSetting("unknown")).toBeUndefined();
    expect(projectSceneFromSetting(null)).toBeUndefined();
  });

  it("把空目录校验改写成选择文件夹的恢复提示", () => {
    expect(
      projectSelectionIssueFromMessage(
        "部署配置校验失败: services: 至少需要声明一个可部署服务",
      ),
    ).toEqual({
      title: "没有识别到项目服务",
      message:
        "这通常是文件夹层级不对。请重新选择包含前后端等完整代码的最外层文件夹。",
    });
    expect(projectSelectionIssueFromMessage("网络连接失败")).toBeNull();
  });

  it("识别相同项目路径时忽略尾部分隔符和 Windows 路径差异", () => {
    expect(sameProjectPath("/demo/project/", "/demo/project")).toBe(true);
    expect(sameProjectPath("C:\\Demo\\Project\\", "c:/demo/project")).toBe(
      true,
    );
    expect(sameProjectPath("/demo/project-a", "/demo/project-b")).toBe(false);
  });

  it("把中断的首次上线步骤恢复成全局待办并由待办在发布中心原地展开", async () => {
    const path = "/demo/interrupted-version-setup";
    const project = recentProject(path, "interrupted-version-setup");
    const other = {
      ...recentProject("/demo/other-project", "other-project"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-active`,
      "true",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-step`,
      "registry",
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project, other]);

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /interrupted-version-setup 还差保存项目版本/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /interrupted-version-setup 还差保存项目版本/,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByLabelText("项目导航")).getByRole("button", {
        name: "发布中心",
      }),
    ).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: /待处理 1/ }));
    const taskDialog = screen.getByRole("dialog", {
      name: "待处理与最近活动",
    });
    const setupTaskCard = within(taskDialog)
      .getByText("还差保存项目版本")
      .closest("button") as HTMLElement;
    expect(setupTaskCard).toHaveTextContent("准备项目版本 ›");
    expect(setupTaskCard).toHaveTextContent("进度已保存，打开后会回到当前步骤");
    fireEvent.click(setupTaskCard);
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("项目导航")).getByText("发布中心", {
          selector: "button",
        }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        screen.getByRole("dialog", { name: "完成当前上线设置" }),
      ).toBeInTheDocument();
      expect(
        within(
          screen.getByRole("dialog", { name: "完成当前上线设置" }),
        ).getByRole("heading", { name: "先连接代码平台" }),
      ).toBeInTheDocument();
    });
  });

  it("上线设置完成后把第一次部署恢复成明确的全局下一步", async () => {
    const path = "/demo/ready-for-first-deployment";
    const project = recentProject(path, "ready-for-first-deployment");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-complete`,
      "true",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-active`,
      "false",
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /ready-for-first-deployment 下一步：部署测试版/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /待处理 1/ }));
    expect(screen.getByText("首次上线设置已完成")).toBeInTheDocument();
    fireEvent.click(
      screen.getByText("首次上线设置已完成").closest("button") as HTMLElement,
    );
    await screen.findByRole("dialog", { name: "测试环境任务" });
    expect(
      within(screen.getByLabelText("项目导航")).getByText("发布中心", {
        selector: "button",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("测试地址正常但尚未人工确认时保留全局下一步", async () => {
    const path = "/demo/pending-test-verification";
    const project = {
      ...recentProject(path, "pending-test-verification"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "successful-test-run",
      latestMessage: "测试地址可以访问",
    };
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /pending-test-verification 等待确认测试结果/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /待处理 1/ }));
    expect(screen.getByText("等待你确认")).toBeInTheDocument();
    expect(screen.getByText("确认测试结果")).toBeInTheDocument();
  });

  it("同一版本重复部署后不再要求重复确认测试结果", async () => {
    const path = "/demo/redeployed-verified-version";
    const project = {
      ...recentProject(path, "redeployed-verified-version"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "current-attempt",
      latestMessage: "测试地址可以访问",
    };
    const older = deploymentRun(path, {
      id: "older-attempt",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    const current = deploymentRun(path, {
      id: "current-attempt",
      commitSha: older.commitSha,
      candidateTag: older.candidateTag,
    });
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([older.id]),
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([current, older]);
    const migrateValidation = vi
      .spyOn(api, "setVersionValidation")
      .mockResolvedValue({
        versionKey: deploymentVersionKey(older),
        state: "passed",
        runId: older.id,
        verifiedAt: "2026-07-17T00:00:00.000Z",
      });

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /redeployed-verified-version 测试已通过，可发布/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /等待确认测试结果/ }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(migrateValidation).toHaveBeenCalledWith(
        path,
        current.id,
        "passed",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /redeployed-verified-version 测试已通过，可发布/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发布中心" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "发布到正式环境",
      }),
    );
    await screen.findByRole("heading", {
      name: /正在确认正式发布条件|先完成正式配置/,
    });

    const productionTask = screen.getByRole("dialog", {
      name: "正式环境任务",
    });
    fireEvent.click(
      within(productionTask).getByRole("button", { name: "关闭" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "正式环境任务" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "所有项目" }));
    const recentProjects = await screen.findByRole("region", {
      name: "按当前状态分组的项目",
    });
    expect(
      within(recentProjects).getByRole("button", {
        name: /redeployed-verified-version 2 个服务 · 测试已通过，可发布/,
      }),
    ).toBeInTheDocument();
    expect(
      within(recentProjects).getByRole("heading", { name: "项目 1" }),
    ).toBeInTheDocument();
    expect(
      within(recentProjects).queryByRole("heading", {
        name: /等待你处理/,
      }),
    ).not.toBeInTheDocument();
  });

  it("项目摘要优先使用持久化版本验证记录", async () => {
    const path = "/demo/durable-version-validation";
    const project = {
      ...recentProject(path, "durable-version-validation"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "current-attempt",
      latestMessage: "测试地址可以访问",
    };
    const current = deploymentRun(path, {
      id: "current-attempt",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([current]);
    vi.spyOn(api, "listVersionValidations").mockResolvedValue([
      {
        versionKey: deploymentVersionKey(current),
        state: "passed",
        runId: current.id,
        verifiedAt: "2026-07-17T00:00:00.000Z",
      },
    ]);
    const migrate = vi.spyOn(api, "setVersionValidation");

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /durable-version-validation 测试已通过，可发布/,
      }),
    ).toBeInTheDocument();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("点击健康正式版项目先到总览，再从总览查看正式环境", async () => {
    const path = "/demo/healthy-production";
    const workspace = await api.openProject(path);
    const project = {
      ...recentProject(path, "healthy-production"),
      latestStatus: "success" as const,
      latestEnvironment: "production" as const,
      latestRunId: "healthy-production-run",
      latestMessage: "正式环境运行正常",
    };
    const staging = deploymentRun(path, {
      id: "healthy-staging-run",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    const production: DeploymentRun = {
      ...staging,
      id: "healthy-production-run",
      environment: "production",
      sourceRunId: staging.id,
      message: "正式环境运行正常",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "test");
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([
      production,
      staging,
    ]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    vi.spyOn(api, "refreshDeployment").mockResolvedValue(production);
    let holdSupportingReads = false;
    let finishSupportingReads: ((runs: DeploymentRun[]) => void) | undefined;
    const supportingReads = new Promise<DeploymentRun[]>((resolve) => {
      finishSupportingReads = resolve;
    });
    vi.spyOn(api, "listAttentionDeploymentRuns").mockImplementation(() =>
      holdSupportingReads ? supportingReads : Promise.resolve([]),
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /healthy-production 正式版可以访问/,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "发布中心" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "正式环境：运行正常，查看详情",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "正式版已上线" }),
    ).toBeInTheDocument();

    holdSupportingReads = true;
    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    expect(await screen.findByText(/最近检查：/)).toHaveTextContent(
      "正式版仍可访问",
    );
    expect(screen.getByRole("button", { name: "检查运行状态" })).toBeEnabled();
    await act(async () => finishSupportingReads?.([]));
  });

  it("历史部署任务不在本机时仍按已保存版本恢复测试确认", async () => {
    const path = "/demo/persisted-version-confirmation";
    const project = {
      ...recentProject(path, "persisted-version-confirmation"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "current-attempt",
      latestMessage: "测试地址可以访问",
    };
    const current = deploymentRun(path, {
      id: "current-attempt",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify(["removed-historical-attempt"]),
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-version`,
      JSON.stringify([deploymentVersionKey(current)]),
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([current]);

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /persisted-version-confirmation 测试已通过，可发布/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /等待确认测试结果/ }),
    ).not.toBeInTheDocument();
  });

  it("同一提交重新构建出不同镜像时仍要求确认测试结果", async () => {
    const path = "/demo/rebuilt-unverified-version";
    const project = {
      ...recentProject(path, "rebuilt-unverified-version"),
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "rebuilt-attempt",
      latestMessage: "测试地址可以访问",
    };
    const verified = deploymentRun(path, {
      id: "verified-attempt",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    const rebuilt = deploymentRun(path, {
      id: "rebuilt-attempt",
      commitSha: verified.commitSha,
      candidateTag: verified.candidateTag,
    });
    rebuilt.artifacts = [
      {
        service: "api",
        image: "registry/demo/api",
        digest: `sha256:${"2".repeat(64)}`,
      },
    ];
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([verified.id]),
    );
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([rebuilt, verified]);

    render(<App />);

    expect(
      await screen.findByRole("button", {
        name: /rebuilt-unverified-version 等待确认测试结果/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /待处理 1/ }));
    expect(screen.getByText("确认测试结果")).toBeInTheDocument();
  });

  it("本机预检很慢时也先显示项目入口", async () => {
    const preflight = vi
      .spyOn(api, "getPreflight")
      .mockImplementation(() => new Promise<never>(() => undefined));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "部署第一个项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在检查本机环境")).toBeInTheDocument();
    expect(screen.queryByText("本机环境待准备")).not.toBeInTheDocument();
    preflight.mockRestore();
  });

  it("本机预检失败时不打断启动，并从原位置重新检查", async () => {
    const preflight = vi
      .spyOn(api, "getPreflight")
      .mockRejectedValueOnce(new Error("local verifier unavailable"))
      .mockResolvedValue({
        architecture: "aarch64",
        operating_system: "macos",
        ready_for_cloud_deploy: true,
        ready_for_local_preview: true,
        tools: [],
      });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "部署第一个项目" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("本机环境检查未完成")).toBeInTheDocument();
    expect(
      screen.queryByText(/local verifier unavailable/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新检查本机环境" }));
    expect(await screen.findByText("本机环境可用")).toBeInTheDocument();
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("添加项目后立即说明识别结果和安全的下一步", async () => {
    const path = "/demo/newly-recognized-project";
    const workspace = await api.openProject(path);
    localStorage.clear();
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([]);
    vi.spyOn(api, "selectProjectDirectory").mockResolvedValue(path);
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);
    expect(
      await screen.findByText(
        "选择包含前端、后端等完整代码的最外层文件夹，不要只选其中一个子文件夹。识别过程不会运行代码，也不会读取配置值。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择整个项目文件夹" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText(
        `当前项目：${workspace.inspection.project_name}；项目路径：${path}；${workspace.inspection.services.length} 个项目服务`,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("先连接代码平台")).toBeInTheDocument();
    expect(
      screen.getByText(
        "选择一个可用的 CNB 连接和代码仓库，后续更新授权不需要重新添加项目。",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "测试环境：尚未准备，查看详情",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "在本机运行" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接代码平台" }));
    expect(
      await screen.findByRole("heading", { name: "先连接代码平台" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /连接镜像仓库/ }),
    ).not.toBeInTheDocument();
  });

  it("已有项目列表可用时不让慢项目恢复锁死添加入口", async () => {
    const path = "/demo/slow-workspace-restore";
    const project = recentProject(path, "slow-workspace-restore");
    const workspace = await api.openProject(path);
    let finishOpen: ((value: WorkspacePreview) => void) | undefined;
    const slowOpen = new Promise<WorkspacePreview>((resolve) => {
      finishOpen = resolve;
    });
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockReturnValue(slowOpen);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "添加项目" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("heading", { name: "正在恢复项目" }),
    ).toBeInTheDocument();

    await act(async () => {
      finishOpen?.(workspace);
      await slowOpen;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
  });

  it("文件夹选择窗口未返回时不重复打开选择器", async () => {
    let finishSelection: ((value: string | null) => void) | undefined;
    const select = vi.spyOn(api, "selectProjectDirectory").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSelection = resolve;
        }),
    );

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "选择整个项目文件夹" }),
    );

    const sidebarAdd = screen.getByRole("button", { name: "添加项目" });
    expect(sidebarAdd).toBeDisabled();
    fireEvent.click(sidebarAdd);
    expect(select).toHaveBeenCalledTimes(1);

    act(() => finishSelection?.(null));
    await waitFor(() => expect(sidebarAdd).toBeEnabled());
  });

  it("选到空文件夹后保留面向用户的重新选择入口", async () => {
    const path = "/demo/empty-project-folder";
    localStorage.clear();
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([]);
    vi.spyOn(api, "selectProjectDirectory").mockResolvedValue(path);
    vi.spyOn(api, "openProject").mockRejectedValue(
      new Error("部署配置校验失败: services: 至少需要声明一个可部署服务"),
    );
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "选择整个项目文件夹" }),
    );

    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(
      "没有识别到项目服务",
    );
    expect(
      screen.getByText(
        "这通常是文件夹层级不对。请重新选择包含前后端等完整代码的最外层文件夹。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新选择文件夹" }),
    ).toBeEnabled();
    expect(screen.queryByText(/部署配置校验失败/)).not.toBeInTheDocument();
  });

  it("重复添加已有项目时打开原进度而不再次宣称新识别", async () => {
    const path = "/demo/already-added-project";
    const workspace = await api.openProject(path);
    const project = recentProject(path, "already-added-project");
    const other = recentProject("/demo/another-project", "another-project");
    localStorage.clear();
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project, other]);
    vi.spyOn(api, "selectProjectDirectory").mockResolvedValue(`${path}/`);
    const open = vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key.endsWith(".scene") ? "local" : null,
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "添加项目" }));

    expect(await screen.findByText("项目已经在列表中")).toBeInTheDocument();
    expect(
      screen.getByText("已打开保存的部署进度，不会创建重复项目。"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("项目识别完成")).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(path);
  });

  it("新项目扫描期间使用只读识别文案而不是恢复旧项目", async () => {
    const path = "/demo/recognition-in-progress";
    const workspace = await api.openProject(path);
    let finishOpen: ((value: WorkspacePreview) => void) | undefined;
    localStorage.clear();
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([]);
    vi.spyOn(api, "selectProjectDirectory").mockResolvedValue(path);
    vi.spyOn(api, "openProject").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "选择整个项目文件夹" }),
    );

    expect(
      await screen.findByRole("heading", { name: "正在识别项目" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "正在只读检查项目结构和服务，不会运行项目代码，也不会读取配置值。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("正在恢复项目")).not.toBeInTheDocument();

    await act(async () => {
      finishOpen?.(workspace);
    });
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
  });

  it("恢复上次项目时直接显示对应项目而不闪回所有项目", async () => {
    const path = "/demo/restore-without-home-flash";
    const workspace = await api.openProject(path);
    const configuredManifest = parseDocument(workspace.manifestYaml);
    configuredManifest.setIn(
      ["providers", "build", "repository"],
      "team/restore-without-home-flash",
    );
    const configuredWorkspace = {
      ...workspace,
      manifestYaml: configuredManifest.toString(),
    };
    const project = recentProject(path, "restore-without-home-flash");
    let finishOpen: ((value: WorkspacePreview) => void) | undefined;
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const syncExternal = vi
      .spyOn(api, "syncExternalDeployments")
      .mockResolvedValue([]);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "正在恢复项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText(path)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "继续你的项目" }),
    ).not.toBeInTheDocument();
    expect(syncExternal).not.toHaveBeenCalled();

    act(() => finishOpen?.(configuredWorkspace));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(syncExternal).toHaveBeenCalledWith(path));
  });

  it("恢复项目首屏后再扫描全部项目的部署待办", async () => {
    const path = "/demo/restore-before-guidance-scan";
    const workspace = await api.openProject(path);
    const project = recentProject(path, "restore-before-guidance-scan");
    let finishOpen: ((value: WorkspacePreview) => void) | undefined;
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    const settings = vi.spyOn(api, "getAppSettings").mockResolvedValue({});
    vi.spyOn(api, "openProject").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const activeRuns = vi
      .spyOn(api, "listActiveDeploymentRuns")
      .mockResolvedValue([]);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "正在恢复项目" }),
    ).toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled();
    expect(activeRuns).not.toHaveBeenCalled();

    act(() => finishOpen?.(workspace));

    await screen.findByRole("heading", { name: "发布中心" });
    await waitFor(() =>
      expect(
        settings.mock.calls.some(([keys]) =>
          keys.some((key) => key.endsWith(".cnb-secret-progress.staging")),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(activeRuns).toHaveBeenCalled());
  });

  it("项目页面不等待最近记录写入完成", async () => {
    const path = "/demo/non-blocking-project-metadata";
    const workspace = await api.openProject(path);
    const project = recentProject(path, "non-blocking-project-metadata");
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    vi.spyOn(api, "setAppSetting").mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    vi.spyOn(api, "saveProjectStep").mockImplementation(
      () => new Promise<void>(() => undefined),
    );

    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "发布中心" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: "正在恢复项目" }),
    ).not.toBeInTheDocument();
  });

  it("打开已上线项目时自动记住可供其他项目复用的 CNB 安全位置", async () => {
    const path = "/demo/remember-shared-secret-repository";
    const workspace = await api.openProject(path);
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", "staging", "secrets_ref"],
      "https://cnb.cool/demo/shared-deploy-secrets/-/blob/main/env.remember-shared-secret-repository.staging.yml",
    );
    workspace.manifestYaml = document.toString({ lineWidth: 0 });
    const project = recentProject(path, "remember-shared-secret-repository");
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) =>
      key === "active-project" ? path : null,
    );
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);
    const saveSetting = vi
      .spyOn(api, "setAppSetting")
      .mockResolvedValue(undefined);

    render(<App />);

    await screen.findByRole("heading", { name: "发布中心" });
    expect(saveSetting).toHaveBeenCalledWith(
      "cnb.secret-repository",
      "demo/shared-deploy-secrets",
    );
  });

  it("恢复项目时直接回发布中心，不等待或恢复上次浏览页面", async () => {
    const path = "/demo/restore-production-scene";
    const workspace = await api.openProject(path);
    const project = recentProject(path, "restore-production-scene");
    vi.spyOn(api, "listRecentProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getAppSetting").mockImplementation(async (key) => {
      if (key === "active-project") return path;
      if (key === `project.${encodeURIComponent(path)}.scene`) return "local";
      return null;
    });
    vi.spyOn(api, "openProject").mockResolvedValue(workspace);
    vi.spyOn(api, "listDeploymentRuns").mockResolvedValue([]);
    vi.spyOn(api, "getProjectServer").mockResolvedValue(null);

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "发布中心" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
  });

  it("先保存测试部署任务，失败时暂停同一任务，重试也复用原 task id", async () => {
    const path = "/demo/durable-staging-task";
    await seedReadyDeploymentProject(path);
    const createTask = vi.spyOn(api, "createDeploymentTask");
    const bootstrap = vi.spyOn(api, "bootstrapServerCaddy");
    const pauseTask = vi.spyOn(api, "pauseDeploymentTask");
    const syncSource = vi
      .spyOn(api, "syncProjectToCnb")
      .mockRejectedValueOnce(new Error("上传代码时网络中断"))
      .mockResolvedValue({
        repository: "demo/durable-task-project",
        branch: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        committed: true,
      });
    const startDeployment = vi.spyOn(api, "startStagingDeployment");

    render(<App />);
    await screen.findByRole("heading", { name: "发布中心" });
    fireEvent.click(
      await screen.findByRole("button", { name: "生成第一个测试版" }),
    );
    await screen.findByRole("heading", { name: "部署测试版" });

    await waitFor(() => expect(pauseTask).toHaveBeenCalledTimes(1));
    const task = await createTask.mock.results[0].value;
    expect(createTask).toHaveBeenCalledWith(path, "staging");
    expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0],
    );
    expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(
      syncSource.mock.invocationCallOrder[0],
    );
    expect(pauseTask).toHaveBeenCalledWith(
      task.id,
      "sync-source",
      expect.any(String),
      "上传代码时网络中断",
      "retry-staging-preparation",
    );
    expect(startDeployment).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "重新尝试" }));
    await waitFor(() => expect(startDeployment).toHaveBeenCalledTimes(1));

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(syncSource).toHaveBeenCalledTimes(2);
    expect(syncSource.mock.calls[1]).toEqual([
      path,
      "demo/durable-task-project",
      "main",
      false,
      task.id,
    ]);
    expect(startDeployment).toHaveBeenCalledWith(
      path,
      "0123456789abcdef0123456789abcdef01234567",
      true,
      task.id,
    );
  });

  it("正式环境准备失败时保留任务，修复后继续同一个正式发布", async () => {
    const path = "/demo/durable-production-task";
    const { productionServer, stagingRun } = await seedReadyDeploymentProject(
      path,
      true,
    );
    if (!stagingRun) throw new Error("测试夹具没有生成测试版本");
    const createTask = vi.spyOn(api, "createDeploymentTask");
    const originalBindProjectServer = api.bindProjectServer;
    const bindServer = vi
      .spyOn(api, "bindProjectServer")
      .mockRejectedValueOnce(new Error("正式服务器连接暂时中断"))
      .mockImplementation(originalBindProjectServer);
    const pauseTask = vi.spyOn(api, "pauseDeploymentTask");
    const promoteDeployment = vi.spyOn(api, "promoteProductionDeployment");

    render(<App />);
    await screen.findByRole("heading", { name: "发布中心" });
    fireEvent.click(
      await screen.findByRole("button", { name: "发布到正式环境" }),
    );
    const publish = await screen.findByRole("button", {
      name: "发布正式版",
    });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await screen.findByRole("heading", { name: "发布这个正式版本？" });
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() => expect(pauseTask).toHaveBeenCalledTimes(1));
    const task = await createTask.mock.results[0].value;
    expect(createTask).toHaveBeenCalledWith(path, "production", stagingRun.id);
    expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(
      bindServer.mock.invocationCallOrder[0],
    );
    expect(pauseTask).toHaveBeenCalledWith(
      task.id,
      "prepare-server",
      expect.any(String),
      "正式服务器连接暂时中断",
      "retry-production-preparation",
    );
    expect(promoteDeployment).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "重新发布同一版本" }),
    );
    await waitFor(() => expect(promoteDeployment).toHaveBeenCalledTimes(1));

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(bindServer).toHaveBeenLastCalledWith(
      path,
      "production",
      productionServer,
    );
    expect(promoteDeployment).toHaveBeenCalledWith(stagingRun.id, task.id);
  });

  it("从发布中心进入环境详情并完成本机、测试和正式发布", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "部署第一个项目" });
    fireEvent.click(screen.getByRole("button", { name: "查看示例" }));

    await screen.findByRole("heading", { name: "发布中心" });
    expect(screen.getByRole("button", { name: "发布中心" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "在本机运行" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "版本" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "项目设置" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "部署测试版" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发布正式版" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "在本机运行" }));
    await screen.findByRole("heading", { name: "在本机运行" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "全部停止" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "一键启动全部" }),
      ).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "一键启动全部" }));
    expect(
      screen.getByText(
        "本机配置还没有保存。先补齐必要配置并点击“保存本机配置”，系统会自动生成项目运行配置文件。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "去保存配置" }),
    ).toBeInTheDocument();

    await fillRequiredConfig("development");
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "保存本机配置" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/本机配置还没有保存/)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "自动准备运行依赖" }));
    await waitFor(() =>
      expect(
        screen.getByText(/已启动，可以连接；由 ABCDeploy 统一维护/),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "一键启动全部" }));
    await waitFor(() =>
      expect(screen.getByText("项目已经可以打开")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "全部停止" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "发布中心" }));
    await screen.findByRole("heading", { name: "发布中心" });
    expect(screen.getByText("先连接代码平台")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接代码平台" }));
    await screen.findByRole("heading", { name: "先连接代码平台" });
    fireEvent.click(await screen.findByRole("button", { name: "连接 CNB" }));
    expect(
      screen.getByRole("button", { name: "前往 CNB 创建令牌" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("访问令牌"), {
      target: { value: "demo-token" },
    });
    expect(
      screen.getByText(
        /令牌统一保存在本机系统密钥库，符合使用范围的项目可以复用/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "验证账号并连接" }));
    await screen.findByText("CNB 账号：示例用户");
    fireEvent.click(screen.getByRole("button", { name: "创建代码仓库" }));

    await screen.findByLabelText("服务器公网 IP");
    fireEvent.change(screen.getByLabelText("服务器公网 IP"), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await screen.findByText("确认连接这台服务器");
    fireEvent.click(screen.getByRole("button", { name: "确认这是我的服务器" }));

    await screen.findByText("测试配置");
    await fillRequiredConfig("staging");
    fireEvent.click(screen.getByRole("button", { name: "保存测试配置" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "自动生成测试地址" }),
    );
    await screen.findByText("测试域名已设置");
    fireEvent.click(screen.getByRole("button", { name: /^4 开启自动部署/ }));
    await saveCloudConfig();
    await screen.findByRole("heading", { name: "发布中心" });
    fireEvent.click(screen.getByRole("button", { name: "生成第一个测试版" }));
    await screen.findByRole("heading", { name: "正在部署测试版" });
    fireEvent.click(screen.getByRole("button", { name: "刷新进度" }));
    await screen.findByRole("heading", { name: "验证测试版" });
    expect(screen.getByLabelText("当前测试版本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开测试版" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "确认测试通过" }),
    );
    await screen.findByText("下一步：准备正式版");
    expect(screen.getByText("测试版正在服务器运行")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "手动部署测试版" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "部署新版本" }),
    ).not.toBeInTheDocument();

    const testTask = screen.getByRole("dialog", { name: "测试环境任务" });
    fireEvent.click(within(testTask).getByRole("button", { name: "关闭" }));
    await screen.findByRole("heading", { name: "发布中心" });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("project-sidebar")).queryByRole("button", {
          name: /等待确认测试结果/,
        }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "发布到正式环境" }));
    await screen.findByRole("heading", {
      name: /正在确认正式发布条件|先完成正式配置/,
    });
    await fillRequiredConfig("production");
    fireEvent.click(screen.getByRole("button", { name: "保存正式配置" }));
    await saveCloudConfig();
    const domainHeading = await screen.findByRole("heading", {
      name: "下一步：填写正式地址",
    });
    const domainSection = domainHeading.parentElement?.parentElement;
    expect(domainSection).not.toBeNull();
    const domainInputs = within(domainSection as HTMLElement).getAllByRole(
      "textbox",
    );
    domainInputs.forEach((input, index) =>
      fireEvent.change(input, {
        target: { value: `service-${index}.example.com` },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存正式地址" }));
    const publish = await screen.findByRole(
      "button",
      { name: "发布正式版" },
      { timeout: 3_000 },
    );
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await screen.findByRole("heading", { name: "发布这个正式版本？" });
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await screen.findByRole("heading", { name: "正在发布正式版" });
    fireEvent.click(screen.getByRole("button", { name: "刷新进度" }));
    await screen.findByRole("heading", { name: "正式版已上线" });
  }, 10_000);
});

async function seedReadyDeploymentProject(
  path: string,
  includeVerifiedProductionCandidate = false,
): Promise<{
  productionServer: ServerForm;
  stagingRun?: DeploymentRun;
}> {
  const workspace = await api.openProject(path);
  const manifest = parseDocument(workspace.manifestYaml);
  manifest.setIn(
    ["providers", "build", "repository"],
    "demo/durable-task-project",
  );
  manifest.setIn(
    ["providers", "registry", "repository"],
    "demo/durable-task-project",
  );
  manifest.setIn(
    ["environments", "staging", "domains"],
    [{ service: "api", host: "staging.example.com", path: "/" }],
  );
  manifest.setIn(
    ["environments", "staging", "secrets_ref"],
    "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.staging.yml",
  );
  manifest.setIn(
    ["environments", "production", "domains"],
    [
      { service: "api", host: "api.example.com", path: "/" },
      { service: "admin", host: "admin.example.com", path: "/" },
      { service: "miniapp", host: "app.example.com", path: "/" },
    ],
  );
  manifest.setIn(
    ["environments", "production", "secrets_ref"],
    "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.production.yml",
  );
  await api.saveManifestDraft(path, manifest.toString({ lineWidth: 0 }));

  const runtimeConfig = [
    "DEPLOYDESK_ENV=staging",
    "DATABASE_URL=postgresql://database/example",
    "APP_SECRET=durable-task-secret",
    "PUBLIC_SITE_URL=https://staging.example.com",
    "",
  ].join("\n");
  await api.storeRuntimeConfig(path, "staging", runtimeConfig);
  await api.storeRuntimeConfig(
    path,
    "production",
    runtimeConfig.replace(/staging/g, "production"),
  );

  const stagingServer: ServerForm = {
    name: "测试服务器",
    host: "203.0.113.10",
    user: "ubuntu",
    port: 22,
    keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
    hostFingerprint: "SHA256:DurableStagingServer",
  };
  const productionServer: ServerForm = {
    name: "正式服务器",
    host: "203.0.113.11",
    user: "ubuntu",
    port: 22,
    keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
    hostFingerprint: "SHA256:DurableProductionServer",
  };
  await api.bindProjectServer(path, "staging", stagingServer);
  await api.bindProjectServer(path, "production", productionServer);

  const settingKey = `project.${encodeURIComponent(path)}`;
  await api.setAppSetting("active-project", path);
  await api.setAppSetting(`${settingKey}.version-setup-complete`, "true");
  await api.setAppSetting(`${settingKey}.scene`, "overview");

  let stagingRun: DeploymentRun | undefined;
  if (includeVerifiedProductionCandidate) {
    const task = await api.createDeploymentTask(path, "staging");
    const running = await api.startStagingDeployment(
      path,
      "0123456789abcdef0123456789abcdef01234567",
      true,
      task.id,
    );
    stagingRun = await api.refreshDeployment(running.id);
    await api.setAppSetting(
      `${settingKey}.verified-run`,
      JSON.stringify([stagingRun.id]),
    );
    await api.setAppSetting(
      `${settingKey}.verified-version`,
      JSON.stringify([deploymentVersionKey(stagingRun)]),
    );
  }

  return { productionServer, stagingRun };
}

function recentProject(path: string, name: string): RecentProject {
  return {
    id: path,
    path,
    name,
    currentStep: "workspace",
    manifestExists: true,
    serviceCount: 2,
    lastOpenedAt: "2026-07-15T00:00:00.000Z",
    pathExists: true,
    latestStatus: null,
    latestEnvironment: null,
    latestMessage: null,
    activeRunCount: 0,
  };
}

function deploymentRun(
  projectPath: string,
  overrides: Pick<DeploymentRun, "id" | "commitSha" | "candidateTag">,
): DeploymentRun {
  return {
    ...overrides,
    projectPath,
    projectName: projectPath.split("/").pop() ?? "demo",
    environment: "staging",
    status: "success",
    currentStage: "complete",
    buildSerial: null,
    sourceRunId: null,
    artifacts: [
      {
        service: "api",
        image: "registry/demo/api",
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: "demo/project",
    branch: "main",
    message: "测试环境运行正常",
    completedSteps: ["healthcheck"],
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:10:00.000Z",
  };
}

async function saveCloudConfig() {
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "准备配置并打开 CNB" }) ??
        screen.queryByRole("button", {
          name: "打开 CNB 创建保存位置",
        }) ??
        screen.queryByRole("button", { name: "我已经有保存位置" }),
    ).toBeInTheDocument(),
  );
  const firstAction =
    screen.queryByRole("button", { name: "准备配置并打开 CNB" }) ??
    screen.queryByRole("button", { name: "打开 CNB 创建保存位置" }) ??
    screen.getByRole("button", { name: "我已经有保存位置" });
  if (firstAction.textContent?.includes("准备配置并打开 CNB")) {
    fireEvent.click(firstAction);
  } else if (firstAction.textContent?.includes("打开 CNB 创建保存位置")) {
    fireEvent.click(firstAction);
    fireEvent.click(
      await screen.findByRole("button", { name: "我已创建，打开配置页面" }),
    );
  } else {
    fireEvent.click(firstAction);
    const repository = await screen.findByLabelText("已有的 CNB 密钥仓库位置");
    fireEvent.change(repository, {
      target: { value: "demo/shared-deploy-secrets" },
    });
    fireEvent.blur(repository);
    await waitFor(() =>
      expect(
        localStorage.getItem(
          "abcdeploy.setting.project.%2Fdemo%2Fecat-energy.cnb-secret-repository",
        ),
      ).toBe("demo/shared-deploy-secrets"),
    );
    fireEvent.click(screen.getByRole("button", { name: "使用并打开配置页面" }));
  }
  fireEvent.click(await screen.findByRole("button", { name: "复制配置内容" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  const confirm = await screen.findByRole("button", {
    name: "我已粘贴并保存",
  });
  expect(confirm).toHaveAttribute("data-variant", "default");
  fireEvent.click(confirm);
  await waitFor(() => {
    const manifest = localStorage.getItem(
      "abcdeploy.demo.manifest.%2Fdemo%2Fecat-energy",
    );
    expect(manifest).toMatch(
      /secrets_ref: https:\/\/cnb\.cool\/demo\/.+-secrets\//,
    );
    expect(manifest).not.toContain("replace-me");
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "我已粘贴并保存" }),
    ).not.toBeInTheDocument(),
  );
}

async function fillRequiredConfig(
  environment: "development" | "staging" | "production",
) {
  const label =
    environment === "development"
      ? "保存本机配置"
      : environment === "staging"
        ? "保存测试配置"
        : "保存正式配置";
  await screen.findByRole("button", { name: label });
  if (environment === "development") {
    fireEvent.change(await screen.findByLabelText("数据库连接地址"), {
      target: { value: `postgresql://localhost/${environment}` },
    });
  }
  const appSecret = screen.queryByLabelText("应用内部安全密钥");
  if (appSecret) {
    fireEvent.change(appSecret, {
      target: { value: `${environment}-secret` },
    });
  }
}
