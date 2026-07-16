import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { preferredProjectTask } from "../lib/projects";
import type { DeploymentRun, RecentProject } from "../types";
import {
  activityCompletedLabels,
  activityProgress,
  activityStageLabel,
  activityUserMessage,
  AppShell,
  completedActivitySummary,
  completedTestVerified,
  completedVersionLabel,
  stableSidebarProjects,
} from "./AppShell";

describe("AppShell multi-project workspace", () => {
  it("keeps the sidebar stable when opening a project updates recent order", () => {
    const initial = projects();
    const refreshed = [
      { ...initial[1], latestMessage: "刚刚检查过正式版" },
      initial[0],
    ];

    const stable = stableSidebarProjects(
      refreshed,
      initial.map((project) => project.path),
    );

    expect(stable.map((project) => project.path)).toEqual([
      "/projects/finagent",
      "/projects/crm",
    ]);
    expect(stable[1].latestMessage).toBe("刚刚检查过正式版");

    const added = {
      ...initial[0],
      id: "new-project",
      name: "new-project",
      path: "/projects/new-project",
    };
    expect(
      stableSidebarProjects(
        [added, ...refreshed],
        stable.map((item) => item.path),
      ).map((project) => project.path),
    ).toEqual(["/projects/new-project", "/projects/finagent", "/projects/crm"]);
  });

  it("keeps projects visible and exposes independent deployment states", () => {
    const onOpenProject = vi.fn();
    const onOpenDeployment = vi.fn();
    const onShowProjects = vi.fn();
    render(
      <AppShell
        activePath="/projects/crm"
        taskRuns={[activeRun()]}
        activeView="project"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={onOpenDeployment}
        onOpenProject={onOpenProject}
        onShowConfiguration={vi.fn()}
        onShowProjects={onShowProjects}
        preflight={null}
        projects={projects()}
      >
        <div>当前工作区</div>
      </AppShell>,
    );

    expect(screen.getByText("正在部署测试版")).toBeInTheDocument();
    expect(screen.getByText("正式版可以访问")).toBeInTheDocument();
    expect(screen.getByText("当前工作区")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "所有项目" })).toHaveAttribute(
      "aria-label",
      "所有项目",
    );
    expect(
      screen.getByRole("button", { name: "finagent 正在部署测试版" }),
    ).toHaveAttribute("aria-label", "finagent 正在部署测试版");

    fireEvent.click(screen.getByRole("button", { name: /finagent/ }));
    expect(onOpenProject).toHaveBeenCalledWith(projects()[0]);
    fireEvent.click(screen.getByRole("button", { name: "所有项目" }));
    expect(onShowProjects).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /部署任务/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/正在部署测试版 · 生成版本/)).toBeInTheDocument();
    expect(screen.getByText("自动处理中 ›")).toBeInTheDocument();
    expect(
      screen.getByText("正在生成版本；可以离开页面，远程任务会继续。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/已经完成：准备项目/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "30",
    );
    expect(screen.getByText("最近完成")).toBeInTheDocument();
    expect(screen.getByText(/正式版发布完成/)).toBeInTheDocument();
    expect(
      screen.getByText(/测试通过的同一版本已经上线，正式地址可以访问/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/镜像摘要/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /finagent/ }));
    expect(onOpenDeployment).toHaveBeenCalledWith(projects()[0], activeRun());
  });

  it("does not claim local runtime is ready when only cloud deployment is ready", () => {
    render(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={{
          architecture: "aarch64",
          operating_system: "macos",
          ready_for_cloud_deploy: true,
          ready_for_local_preview: false,
          tools: [],
        }}
        projects={[]}
      >
        <div />
      </AppShell>,
    );

    expect(screen.getByText("本机环境待准备")).toBeInTheDocument();
    expect(screen.queryByText("本机可部署")).not.toBeInTheDocument();
  });

  it("keeps an unknown local environment neutral and lets the user retry a failed check", () => {
    const onRetryPreflight = vi.fn();
    const view = render(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onRetryPreflight={onRetryPreflight}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        preflightChecking
        projects={[]}
      >
        <div />
      </AppShell>,
    );

    expect(screen.getByText("正在检查本机环境")).toBeInTheDocument();
    expect(screen.queryByText("本机环境待准备")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新检查本机环境" }),
    ).not.toBeInTheDocument();

    view.rerender(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onRetryPreflight={onRetryPreflight}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        preflightChecking={false}
        projects={[]}
      >
        <div />
      </AppShell>,
    );

    expect(screen.getByText("本机环境检查未完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查本机环境" }));
    expect(onRetryPreflight).toHaveBeenCalledTimes(1);
  });

  it("keeps the task center useful when no deployment needs attention", () => {
    render(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[]}
      >
        <div />
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "部署任务" }));
    expect(screen.getByText("当前没有待处理任务")).toBeInTheDocument();
  });

  it("keeps a moved project in the task center and starts folder recovery", () => {
    const onOpenProject = vi.fn();
    const moved = {
      ...projects()[1],
      id: "moved-crm",
      path: "/projects/old-crm",
      pathExists: false,
    };
    render(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={onOpenProject}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[moved]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: "crm 需要重新找到项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务 1/ }));
    expect(screen.getByText("重新找到项目 ›")).toBeInTheDocument();
    fireEvent.click(
      screen.getByText("重新找到项目 ›").closest("button") as HTMLElement,
    );
    expect(onOpenProject).toHaveBeenCalledWith(moved);
  });

  it("keeps an interrupted first-time setup visible across every global entry", () => {
    const onOpenSetup = vi.fn();
    const project = {
      ...projects()[0],
      currentStep: "workspace" as const,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };
    const setupTask = {
      environment: "staging" as const,
      projectPath: project.path,
      stage: "save-page-opened" as const,
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenSetup={onOpenSetup}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[setupTask]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: /部署任务 1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /finagent 还差网页保存/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务 1/ }));
    const taskDialog = screen.getByRole("dialog", { name: "部署任务" });
    expect(screen.queryByText(/当前没有.*任务/)).not.toBeInTheDocument();
    expect(within(taskDialog).getByText("还差网页保存")).toBeInTheDocument();
    expect(within(taskDialog).getByText("继续保存 ›")).toBeInTheDocument();
    expect(
      within(taskDialog).getByText(
        "配置内容已经准备好；打开项目复制并粘贴到代码平台网页保存。",
      ),
    ).toBeInTheDocument();
    expect(
      within(taskDialog).getByText("进度已保存，打开后会回到当前步骤"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(taskDialog)
        .getByText("还差网页保存")
        .closest("button") as HTMLElement,
    );
    expect(onOpenSetup).toHaveBeenCalledWith(project, setupTask);
  });

  it("separates work waiting for the user from work the system is already handling", () => {
    const [runningProject, setupProjectSource] = projects();
    const setupProject = {
      ...setupProjectSource,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[runningProject, setupProject]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: setupProject.path,
            stage: "save-page-opened",
          },
        ]}
        taskRuns={[activeRun()]}
      >
        <div />
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /部署任务 2/ }));
    const taskDialog = screen.getByRole("dialog", { name: "部署任务" });
    expect(screen.getByText("等待你处理")).toBeInTheDocument();
    expect(screen.getByText("自动处理中")).toBeInTheDocument();
    expect(within(taskDialog).getByText("还差网页保存")).toBeInTheDocument();
    expect(screen.getByText("正在部署测试版 · 生成版本")).toBeInTheDocument();
    expect(
      screen.queryByText("自动处理中与需要你处理"),
    ).not.toBeInTheDocument();
  });

  it("turns completed setup into a clear first deployment action", () => {
    const onOpenSetup = vi.fn();
    const project = {
      ...projects()[0],
      currentStep: "workspace" as const,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };
    const setupTask = {
      environment: "staging" as const,
      projectPath: project.path,
      stage: "first-deploy" as const,
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenSetup={onOpenSetup}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[setupTask]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: /finagent 下一步：部署测试版/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务 1/ }));
    expect(screen.getByText("现在可以继续")).toBeInTheDocument();
    expect(screen.getByText("首次上线设置已完成")).toBeInTheDocument();
    expect(
      screen.getByText("上线设置已完成，打开后会进入测试版"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "进入测试版后会先核对服务器、配置和地址；确认仍然有效后即可部署当前代码。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByText("首次上线设置已完成").closest("button") as HTMLElement,
    );
    expect(onOpenSetup).toHaveBeenCalledWith(project, setupTask);
  });

  it("does not let a stale first-deployment hint override a real result", () => {
    const project = {
      ...projects()[1],
      latestStatus: "success" as const,
      latestEnvironment: "production" as const,
      activeRunCount: 0,
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: project.path,
            stage: "first-deploy",
          },
        ]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: /crm 正式版可以访问/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "部署任务" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/下一步：部署测试版/)).not.toBeInTheDocument();
  });

  it("keeps successful test deployment visible until the user confirms it", () => {
    const onOpenVerification = vi.fn();
    const run = {
      ...activeRun(),
      status: "success" as const,
      currentStage: "complete",
      completedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
        "healthcheck",
      ],
    };
    const project = {
      ...projects()[0],
      currentStep: "workspace" as const,
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: run.id,
      latestMessage: "测试地址可以访问",
      activeRunCount: 0,
    };
    const verificationTask = {
      projectPath: project.path,
      runId: run.id,
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        completedRuns={[run]}
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenVerification={onOpenVerification}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        taskRuns={[]}
        verificationTasks={[verificationTask]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: /finagent 等待确认测试结果/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务 1/ }));
    expect(screen.getByText("等待你确认")).toBeInTheDocument();
    expect(screen.getByText("确认测试结果")).toBeInTheDocument();
    expect(
      screen.getByText(
        "测试版已经可以访问，请打开主要页面确认功能是否符合预期。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/测试版部署完成/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByText("确认测试结果").closest("button") as HTMLElement,
    );
    expect(onOpenVerification).toHaveBeenCalledWith(project, verificationTask);
  });

  it("shows late deployment work as confirming the version instead of rebuilding it", () => {
    const run = {
      ...activeRun(),
      currentStage: "verify-release",
      completedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
      ],
    };
    expect(activityStageLabel(run.currentStage)).toBe("确认版本可用");
    expect(activityStageLabel("build", "production")).toBe("确认版本");
    expect(activityProgress(run)).toBeGreaterThanOrEqual(82);
    expect(activityCompletedLabels(run.completedSteps)).toEqual([
      "准备项目",
      "生成版本",
      "启动服务",
    ]);
    expect(activityCompletedLabels(run.completedSteps, "production")).toEqual([
      "准备项目",
      "确认版本",
      "启动服务",
    ]);
  });

  it("surfaces an interrupted early setup step without provider terminology", () => {
    const project = {
      ...projects()[0],
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };
    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: project.path,
            stage: "test-environment",
          },
        ]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", { name: /finagent 还差准备测试环境/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务/ }));
    expect(
      screen.getByText("运行服务器、测试配置或测试地址还需要继续准备。"),
    ).toBeInTheDocument();
    expect(screen.getByText("准备测试环境 ›")).toBeInTheDocument();
    expect(screen.queryByText(/CNB|TCR|SSH|Caddy/)).not.toBeInTheDocument();
  });

  it("keeps implementation details out of completed task summaries", () => {
    expect(completedActivitySummary(projects()[1])).toBe(
      "测试通过的同一版本已经上线，正式地址可以访问",
    );
    expect(
      completedActivitySummary({
        ...projects()[0],
        latestStatus: "success",
        latestEnvironment: "staging",
      }),
    ).toBe("测试版已经正常运行，可以查看当前结果");
    expect(
      completedActivitySummary(
        {
          ...projects()[0],
          latestStatus: "success",
          latestEnvironment: "staging",
        },
        undefined,
        true,
      ),
    ).toBe("测试结果已经确认，可以查看当前版本");
    expect(
      completedVersionLabel({
        ...activeRun(),
        sourceTitle: "API custom event",
      }),
    ).toContain("的版本");
    expect(
      completedVersionLabel(
        {
          ...activeRun(),
          environment: "production",
          sourceRunId: "tested-version",
          sourceTitle: "API custom event",
        },
        [
          {
            ...activeRun(),
            id: "tested-version",
            sourceTitle: "initialize project for ABCDeploy",
          },
        ],
      ),
    ).toContain("的版本");
  });

  it("keeps the latest successful test and production task separately", () => {
    const onOpenDeployment = vi.fn();
    const project = {
      ...projects()[0],
      activeRunCount: 0,
      latestStatus: "success" as const,
      latestEnvironment: "production" as const,
    };
    const staging: DeploymentRun = {
      ...activeRun(),
      id: "successful-staging",
      status: "success",
      currentStage: "complete",
      sourceTitle: "修复登录并优化首页速度",
      completedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
        "healthcheck",
      ],
      startedAt: "2026-07-15T00:00:00Z",
      updatedAt: "2026-07-15T01:00:00Z",
    };
    const production: DeploymentRun = {
      ...staging,
      id: "successful-production",
      environment: "production",
      sourceRunId: staging.id,
      startedAt: "2026-07-14T00:00:00Z",
      updatedAt: "2026-07-16T00:00:00Z",
    };

    render(
      <AppShell
        activePath=""
        activeView="projects"
        completedRuns={[production, staging]}
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={onOpenDeployment}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "部署任务" }));
    expect(
      screen.getByText("当前没有自动处理或需要你操作的任务"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("正式版发布完成 · 修复登录并优化首页速度"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("测试已通过 · 修复登录并优化首页速度"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /查看结果/ })[0],
    ).toHaveAccessibleName(/测试已通过/);
    fireEvent.click(
      screen
        .getByText("测试已通过 · 修复登录并优化首页速度")
        .closest("button") as HTMLElement,
    );
    expect(onOpenDeployment).toHaveBeenCalledWith(project, staging);
    expect(
      completedTestVerified(project, staging, [production, staging], new Set()),
    ).toBe(true);
    expect(
      completedTestVerified(
        project,
        staging,
        [{ ...production, status: "needs_action" }, staging],
        new Set(),
      ),
    ).toBe(true);
    expect(
      completedTestVerified(
        project,
        staging,
        [staging],
        new Set([project.path]),
      ),
    ).toBe(true);
    expect(completedTestVerified(project, staging, [staging], new Set())).toBe(
      false,
    );
  });

  it("keeps the task center focused on only the latest completed results", () => {
    const completedProjects = Array.from({ length: 6 }, (_, index) => ({
      ...projects()[1],
      id: `completed-${index}`,
      path: `/projects/completed-${index}`,
      name: `completed-${index}`,
      latestEnvironment: "staging" as const,
    }));
    const completedRuns = completedProjects.map((project, index) => ({
      ...activeRun(),
      id: `completed-run-${index}`,
      projectPath: project.path,
      projectName: project.name,
      status: "success" as const,
      currentStage: "complete",
      startedAt: `2026-07-${String(15 - index).padStart(2, "0")}T00:00:00Z`,
      updatedAt: `2026-07-${String(15 - index).padStart(2, "0")}T00:10:00Z`,
    }));

    render(
      <AppShell
        activePath=""
        activeView="projects"
        completedRuns={completedRuns}
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={completedProjects}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "部署任务" }));
    const taskDialog = screen.getByRole("dialog", { name: "部署任务" });
    expect(
      within(taskDialog).getAllByRole("button", { name: /查看结果/ }),
    ).toHaveLength(4);
    expect(within(taskDialog).getByText("只显示最近 4 项")).toBeInTheDocument();
    expect(
      within(taskDialog).getByText("其余结果可在对应项目中查看"),
    ).toBeInTheDocument();
    expect(within(taskDialog).getByText("completed-0")).toBeInTheDocument();
    expect(
      within(taskDialog).queryByText("completed-4"),
    ).not.toBeInTheDocument();
  });

  it("keeps completed milestones when a deployment stops and reopens the exact task", () => {
    const onOpenDeployment = vi.fn();
    const failed = {
      ...projects()[0],
      activeRunCount: 0,
      latestStatus: "failed" as const,
      latestEnvironment: "production" as const,
      latestMessage: "正式地址还没有生效",
      latestCurrentStage: "healthcheck",
      latestCompletedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
      ],
    };
    render(
      <AppShell
        activePath=""
        taskRuns={[]}
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={onOpenDeployment}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[failed]}
      >
        <div />
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /部署任务/ }));
    const taskDialog = screen.getByRole("dialog", { name: "部署任务" });
    expect(
      within(taskDialog).getByText("正式发布没有完成"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已经完成：准备项目、确认版本、启动服务/),
    ).toBeInTheDocument();
    expect(screen.getByText(/任务停在：检查访问地址/)).toBeInTheDocument();
    expect(screen.getByText("查看处理方法 ›")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /finagent/ }));
    expect(onOpenDeployment).toHaveBeenCalledWith(failed);
  });

  it("keeps a production task visible after a newer staging version succeeds", () => {
    const onOpenDeployment = vi.fn();
    const project = {
      ...projects()[0],
      activeRunCount: 0,
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestMessage: "新的测试版已经正常运行",
    };
    const productionTask: DeploymentRun = {
      ...activeRun(),
      id: "pending-production",
      environment: "production",
      status: "needs_action",
      currentStage: "healthcheck",
      sourceRunId: "tested-version",
      actionKind: "route-check",
      issueCode: "AD-NET-201",
      message: "正式地址还没有生效",
      completedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
      ],
      startedAt: "2026-07-13T00:00:00Z",
      updatedAt: "2026-07-15T00:00:00Z",
    };
    render(
      <AppShell
        activePath=""
        activeView="projects"
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={onOpenDeployment}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[project]}
        taskRuns={[productionTask]}
      >
        <div />
      </AppShell>,
    );

    expect(
      screen.getByRole("button", {
        name: /finagent 正式版已部署，还差地址/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /部署任务/ }));
    const taskDialog = screen.getByRole("dialog", { name: "部署任务" });
    expect(
      within(taskDialog).getByText("正式版已部署，还差地址"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "服务已经启动；打开项目查看需要设置的正式地址，完成后返回自动检查。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("设置正式地址 ›")).toBeInTheDocument();
    expect(screen.getByText(/任务停在：设置正式地址/)).toBeInTheDocument();
    expect(screen.getByText("最近完成")).toBeInTheDocument();
    expect(screen.getByText(/测试版部署完成/)).toBeInTheDocument();
    fireEvent.click(
      within(taskDialog)
        .getByText("正式版已部署，还差地址")
        .closest("button") as HTMLElement,
    );
    expect(onOpenDeployment).toHaveBeenCalledWith(project, productionTask);
  });

  it("uses time instead of a technical commit sentence in recent results", () => {
    const run = {
      ...activeRun(),
      id: "technical-title-complete",
      status: "success" as const,
      environment: "staging" as const,
      sourceTitle: "harden ABCDeploy staging recovery",
      startedAt: "2026-07-14T08:36:00Z",
      updatedAt: "2026-07-14T08:36:00Z",
    };
    render(
      <AppShell
        activePath=""
        activeView="projects"
        completedRuns={[run]}
        loading={false}
        onAddProject={vi.fn()}
        onOpenDeployment={vi.fn()}
        onOpenProject={vi.fn()}
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
        preflight={null}
        projects={[projects()[0]]}
        taskRuns={[]}
      >
        <div />
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /部署任务/ }));
    expect(screen.getByText(/的版本/)).toBeInTheDocument();
    expect(
      screen.queryByText(/harden ABCDeploy staging recovery/),
    ).not.toBeInTheDocument();
  });

  it("keeps raw provider responses out of the task center", () => {
    const project = {
      ...projects()[0],
      activeRunCount: 0,
      latestStatus: "needs_action" as const,
      latestIssueCode: "AD-CNB-103",
      latestMessage:
        'CNB API 请求失败 (403)：{"errcode":10023,"errmsg":"Missing required scopes"}',
    };

    expect(activityUserMessage(project)).toBe(
      "CNB 权限还差一步；打开项目后可以从当前步骤继续。",
    );
    expect(activityUserMessage(project)).not.toContain("errcode");
  });

  it("prioritizes the task that most needs the user across environments", () => {
    const runningStaging = {
      ...activeRun(),
      updatedAt: "2026-07-15T02:00:00Z",
    };
    const failedProduction = {
      ...activeRun(),
      id: "failed-production",
      environment: "production" as const,
      status: "failed" as const,
      updatedAt: "2026-07-15T01:00:00Z",
    };
    const waitingProduction = {
      ...failedProduction,
      id: "waiting-production",
      status: "needs_action" as const,
      updatedAt: "2026-07-15T00:00:00Z",
    };

    expect(
      preferredProjectTask(
        [runningStaging, failedProduction, waitingProduction],
        "/projects/finagent",
      ),
    ).toEqual(waitingProduction);
  });
});

function activeRun(): DeploymentRun {
  return {
    id: "run-finagent",
    projectPath: "/projects/finagent",
    projectName: "finagent",
    environment: "staging",
    status: "running",
    currentStage: "build",
    buildSerial: "42",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    sourceRunId: null,
    candidateTag: null,
    artifacts: [],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: "demo/finagent",
    branch: "main",
    message: "正在生成测试版本",
    completedSteps: ["write-config"],
    startedAt: "2026-07-14T00:00:00Z",
    updatedAt: "2026-07-14T00:00:00Z",
  };
}

function projects(): RecentProject[] {
  return [
    {
      id: "finagent",
      path: "/projects/finagent",
      name: "finagent",
      currentStep: "deploying",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-11T00:00:00Z",
      pathExists: true,
      latestStatus: "running",
      latestEnvironment: "staging",
      latestMessage: "正在构建",
      activeRunCount: 1,
    },
    {
      id: "crm",
      path: "/projects/crm",
      name: "crm",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-11T00:00:00Z",
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "production",
      latestMessage: "生产正常",
      activeRunCount: 0,
    },
  ];
}
