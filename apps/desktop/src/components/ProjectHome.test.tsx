import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentRun, RecentProject } from "../types";
import { ProjectHome } from "./ProjectHome";

describe("ProjectHome", () => {
  it("shows a familiar operating-system name", () => {
    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={{
          architecture: "aarch64",
          operating_system: "macos",
          ready_for_cloud_deploy: true,
          ready_for_local_preview: true,
          tools: [],
        }}
        projects={[]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(screen.getByText("本机环境可用 · macOS")).toBeInTheDocument();
  });

  it("does not briefly claim this is a new workspace while recent projects are loading", () => {
    render(
      <ProjectHome
        embedded
        loading
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "正在恢复工作区" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "部署第一个项目" }),
    ).not.toBeInTheDocument();
  });

  it("shows the useful deployment state instead of an internal navigation step", () => {
    const project: RecentProject = {
      id: "finagent",
      path: "/projects/finagent",
      name: "finagent",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 3,
      lastOpenedAt: new Date().toISOString(),
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "production",
      latestMessage: "生产正常",
      activeRunCount: 0,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(screen.getByText("3 个服务 · 正式版可以访问")).toBeInTheDocument();
    expect(screen.queryByText(/已进入项目工作台/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "添加项目" }),
    ).not.toBeInTheDocument();
    const projectOptions = screen.getByRole("button", {
      name: "移除 finagent 的本机项目记录",
    });
    expect(
      screen.queryByRole("button", { name: "移除 finagent" }),
    ).not.toBeInTheDocument();
    fireEvent.click(projectOptions);
    expect(
      screen.getByRole("heading", {
        name: "移除 finagent 的本机记录？",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "确认移除 finagent 的本机记录",
      }),
    ).toBeInTheDocument();
  });

  it("shows the exact interrupted setup action instead of waiting deployment", () => {
    const project: RecentProject = {
      id: "new-project",
      path: "/projects/new-project",
      name: "new-project",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: new Date().toISOString(),
      pathExists: true,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: project.path,
            stage: "save-page-opened",
          },
        ]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(screen.getByText("2 个服务 · 还差网页保存")).toBeInTheDocument();
    expect(screen.queryByText(/等待部署/)).not.toBeInTheDocument();
  });

  it("summarizes attention and keeps actionable projects above recent healthy ones", () => {
    const healthy: RecentProject = {
      id: "healthy",
      path: "/projects/healthy",
      name: "healthy",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-15T09:00:00Z",
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "production",
      latestMessage: "正式版正常",
      activeRunCount: 0,
    };
    const automatic: RecentProject = {
      ...healthy,
      id: "automatic",
      path: "/projects/automatic",
      name: "automatic",
      lastOpenedAt: "2026-07-15T08:00:00Z",
      latestStatus: "running",
      latestEnvironment: "staging",
      latestMessage: "正在部署",
      activeRunCount: 1,
    };
    const waiting: RecentProject = {
      ...healthy,
      id: "waiting",
      path: "/projects/waiting",
      name: "waiting",
      lastOpenedAt: "2026-07-01T00:00:00Z",
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[healthy, automatic, waiting]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: waiting.path,
            stage: "save-page-opened",
          },
        ]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "等待你处理 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "自动处理中 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "其他项目 1" }),
    ).toBeInTheDocument();
    const projectButtons = screen.getAllByRole("button", { name: /个服务/ });
    expect(projectButtons[0]).toHaveAccessibleName(/waiting.*还差网页保存/);
    expect(projectButtons[1]).toHaveAccessibleName(/automatic.*正在部署/);
    expect(projectButtons[2]).toHaveAccessibleName(/healthy.*正式版可以访问/);
  });

  it("shows the first deployment action after setup is complete", () => {
    const project: RecentProject = {
      id: "ready-project",
      path: "/projects/ready-project",
      name: "ready-project",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: new Date().toISOString(),
      pathExists: true,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        setupTasks={[
          {
            environment: "staging",
            projectPath: project.path,
            stage: "first-deploy",
          },
        ]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(
      screen.getByText("2 个服务 · 下一步：部署测试版"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/等待部署/)).not.toBeInTheDocument();
  });

  it("shows that a healthy test version still needs business confirmation", () => {
    const project: RecentProject = {
      id: "pending-verification",
      path: "/projects/pending-verification",
      name: "pending-verification",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: new Date().toISOString(),
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "staging",
      latestMessage: "测试地址可以访问",
      latestRunId: "successful-test-run",
      activeRunCount: 0,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        showDemo={false}
        taskRuns={[]}
        verificationTasks={[
          {
            projectPath: project.path,
            runId: "successful-test-run",
          },
        ]}
      />,
    );

    expect(screen.getByText("2 个服务 · 等待确认测试结果")).toBeInTheDocument();
    expect(screen.queryByText(/测试版正在运行/)).not.toBeInTheDocument();
  });

  it("shows a production task that needs attention over a newer staging success", () => {
    const project: RecentProject = {
      id: "finagent",
      path: "/projects/finagent",
      name: "finagent",
      currentStep: "deploying",
      manifestExists: true,
      serviceCount: 3,
      lastOpenedAt: new Date().toISOString(),
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "staging",
      latestMessage: "测试环境正常",
      activeRunCount: 0,
    };
    const task: DeploymentRun = {
      id: "production-needs-action",
      projectPath: project.path,
      projectName: project.name,
      environment: "production",
      status: "needs_action",
      currentStage: "healthcheck",
      buildSerial: "42",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: "staging-success",
      candidateTag: "candidate-42",
      artifacts: [],
      actionKind: "route-check",
      actionUrl: null,
      issueCode: "AD-NET-201",
      repository: "demo/finagent",
      branch: "main",
      message: "正式地址还没有生效",
      completedSteps: ["write-config", "verify-build", "deploy"],
      startedAt: "2026-07-15T00:00:00Z",
      updatedAt: "2026-07-15T01:00:00Z",
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        showDemo={false}
        taskRuns={[task]}
      />,
    );

    expect(
      screen.getByText("3 个服务 · 正式版已部署，还差地址"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/测试版正在运行/)).not.toBeInTheDocument();
  });

  it("turns a missing folder into one clear recovery action", () => {
    const onOpen = vi.fn();
    const project: RecentProject = {
      id: "moved-project",
      path: "/projects/old-location",
      name: "moved-project",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: new Date().toISOString(),
      pathExists: false,
      latestStatus: "success",
      latestEnvironment: "staging",
      latestMessage: "测试正常",
      activeRunCount: 0,
    };

    render(
      <ProjectHome
        embedded
        loading={false}
        onDemo={vi.fn()}
        onForget={vi.fn()}
        onOpen={onOpen}
        onSelect={vi.fn()}
        preflight={null}
        projects={[project]}
        showDemo={false}
        taskRuns={[]}
      />,
    );

    expect(screen.getByText("找不到原文件夹")).toBeInTheDocument();
    expect(screen.getByText("2 个服务 · 需要重新找到项目")).toBeInTheDocument();
    expect(screen.getByText("重新找到")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /moved-project.*需要重新找到项目/,
      }),
    );
    expect(onOpen).toHaveBeenCalledWith(project);
  });
});
