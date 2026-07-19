import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import * as api from "../api";
import { openProject } from "../api";
import { deploymentVersionKey } from "../lib/projects";
import type {
  CnbSecretBundle,
  DeploymentRun,
  ProviderCheck,
  ServerResource,
} from "../types";
import {
  autoRechecksDeployment,
  availableVersionRuns,
  automaticTestDomains,
  cnbNewFileUrl,
  cnbRepositoryUrl,
  CnbSecretSetup,
  certificateOnlyRouteFailure,
  clearClipboardIfUnchanged,
  DeploymentBlockerBanner,
  deploymentNextStep,
  deploymentStateMessage,
  deploymentUpdatedAtLabel,
  dnsRecordTypeForTarget,
  dnsHostRecordLabel,
  environmentAddresses,
  deploymentRefreshLabel,
  prepareCnbDeploymentBundle,
  productionConfirmationMessage,
  productionConfigDetail,
  productionConfigStatus,
  publicRouteStatusPresentation,
  recordedSecretRepository,
  isOlderVersion,
  ProductWorkspace,
  type ProjectScene,
  ServerPreparation,
  deploymentMilestones,
  reusableServer,
  runtimeConfigReadyCacheKey,
  runtimeConfigStoredReady,
  runtimeVariableOptionalManifest,
  serverFormFromResource,
  stagingAddressConfigured,
  testAddress,
  testEnvironmentDisplayReady,
  updateCnbAuthorizationOpenSources,
  versionComparisonTitle,
  versionMeta,
  versionSetupStep,
  versionTitle,
} from "./ProductWorkspace";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

function projectNavigation() {
  return screen.getByRole("navigation", { name: "项目导航" });
}

async function openOverview() {
  const navigation = await screen.findByRole("navigation", {
    name: "项目导航",
  });
  const button = within(navigation).getByRole("button", { name: "发布中心" });
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "发布中心" });
  return button;
}

async function openLocal() {
  const navigation = await screen.findByRole("navigation", {
    name: "项目导航",
  });
  const button = within(navigation).getByRole("button", { name: "在本机运行" });
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "在本机运行" });
  return button;
}

async function openVersions() {
  const navigation = await screen.findByRole("navigation", {
    name: "项目导航",
  });
  const button = within(navigation).getByRole("button", { name: "版本" });
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "版本" });
  return button;
}

async function openProjectSettings() {
  const navigation = await screen.findByRole("navigation", {
    name: "项目导航",
  });
  const button = within(navigation).getByRole("button", { name: "项目设置" });
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "项目设置" });
  return button;
}

async function openTestEnvironmentDetails() {
  await openOverview();
  fireEvent.click(await screen.findByRole("button", { name: /^测试环境：/ }));
  await screen.findByRole("dialog", { name: "测试环境任务" });
}

async function openProductionEnvironmentDetails() {
  await openOverview();
  fireEvent.click(await screen.findByRole("button", { name: /^正式环境：/ }));
  await screen.findByRole("dialog", { name: "正式环境任务" });
}

function closeReleaseTaskPanel() {
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }),
  );
}

function expectOverviewTopLevelActive() {
  expect(
    within(projectNavigation()).getByRole("button", { name: "发布中心" }),
  ).toHaveAttribute("aria-current", "page");
}

async function beginFirstVersionSetup() {
  await openProjectSettings();
  expect(
    await screen.findByRole("heading", { name: "项目设置" }),
  ).toBeInTheDocument();
}

function configureCnbRepository(
  workspace: Awaited<ReturnType<typeof openProject>>,
  repository: string,
) {
  const document = parseDocument(workspace.manifestYaml);
  document.setIn(["source", "repository"], repository);
  document.setIn(["providers", "build", "repository"], repository);
  document.setIn(["providers", "registry", "repository"], repository);
  workspace.manifestExists = true;
  workspace.manifestYaml = document.toString({ lineWidth: 0 });
}

function successfulStagingRun(
  path: string,
  overrides: Partial<DeploymentRun> = {},
): DeploymentRun {
  return {
    id: "staging-success",
    projectPath: path,
    projectName: "demo",
    environment: "staging",
    status: "success",
    currentStage: "complete",
    buildSerial: "101",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    sourceRunId: null,
    sourceTitle: "修复登录问题",
    candidateTag: "candidate-101",
    artifacts: [],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: "demo/project",
    branch: "main",
    message: "测试环境运行正常",
    completedSteps: ["healthcheck"],
    startedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:05:00.000Z",
    ...overrides,
  };
}

describe("ProductWorkspace blocking states", () => {
  it("keeps global CNB refresh paused until every authorization dialog closes", () => {
    const sources = new Set<string>();

    expect(updateCnbAuthorizationOpenSources(sources, "test", true)).toBe(true);
    expect(updateCnbAuthorizationOpenSources(sources, "settings", true)).toBe(
      true,
    );
    expect(updateCnbAuthorizationOpenSources(sources, "test", false)).toBe(
      true,
    );
    expect(updateCnbAuthorizationOpenSources(sources, "settings", false)).toBe(
      false,
    );
  });
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("clears copied secret content only while it is still the current clipboard value", async () => {
    let currentClipboard = "sensitive deployment configuration";
    const writeText = vi.fn(async (value: string) => {
      currentClipboard = value;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn(async () => currentClipboard),
        writeText,
      },
    });

    expect(await clearClipboardIfUnchanged(currentClipboard)).toBe(true);
    expect(currentClipboard).toBe("");
    expect(writeText).toHaveBeenCalledWith("");

    currentClipboard = "the user copied something else";
    expect(
      await clearClipboardIfUnchanged("sensitive deployment configuration"),
    ).toBe(false);
    expect(currentClipboard).toBe("the user copied something else");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("keeps the current project identity accessible and falls back to the folder name", async () => {
    const path = "/demo/wx";
    const workspace = await openProject(path);
    workspace.inspection.project_name = "wx";
    const serviceCount = workspace.inspection.services.length;
    const props = {
      onDeployTest: vi.fn(),
      onError: vi.fn(),
      onPromote: vi.fn(),
      onRefresh: vi.fn(),
      onSaveManifest: vi.fn().mockResolvedValue(true),
      onServerChange: vi.fn(),
      path,
      runs: [],
      saving: false,
      workspace,
    };
    const view = render(<ProductWorkspace {...props} />);

    expect(
      await screen.findByRole("banner", {
        name: `当前项目：wx；项目路径：${path}；${serviceCount} 个项目服务`,
      }),
    ).toBeInTheDocument();

    workspace.inspection.project_name = "";
    view.rerender(<ProductWorkspace {...props} />);

    expect(
      await screen.findByRole("banner", {
        name: `当前项目：wx；项目路径：${path}；${serviceCount} 个项目服务`,
      }),
    ).toBeInTheDocument();
  });

  it("keeps exactly four stable project entries", async () => {
    const path = "/demo/stable-project-navigation";
    const workspace = await openProject(path);

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await screen.findByRole("heading", { name: "发布中心" });
    expect(
      within(projectNavigation())
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["发布中心", "在本机运行", "版本", "项目设置"]);
    expect(await openLocal()).toHaveAttribute("aria-current", "page");
    expect(await openVersions()).toHaveAttribute("aria-current", "page");
    expect(await openProjectSettings()).toHaveAttribute("aria-current", "page");
    expect(await openOverview()).toHaveAttribute("aria-current", "page");
  });

  it("opens only the exact current setup task from the release center", async () => {
    const path = "/demo/focused-release-setup";
    const workspace = await openProject(path);

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("先连接代码平台")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接代码平台" }));

    expect(
      await screen.findByRole("heading", { name: "先连接代码平台" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: /连接代码平台.*现在完成/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /连接镜像仓库/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /准备测试环境/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /开启自动部署/ }),
    ).not.toBeInTheDocument();

    closeReleaseTaskPanel();
    await openProjectSettings();
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*随后处理/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /准备测试环境.*随后处理/ }),
    ).toBeInTheDocument();
  });

  it("does not mistake an interrupted first deployment for completed setup", async () => {
    const path = "/demo/interrupted-first-setup";
    const workspace = await openProject(path);
    const interrupted: DeploymentRun = {
      ...successfulStagingRun(path),
      id: "interrupted-first-setup",
      status: "needs_action",
      currentStage: "cloud-setup",
      actionKind: "cloud-setup",
      issueCode: "AD-CNB-201",
      message: "测试配置还需要准备",
    };

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[interrupted]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText("测试部署暂停在代码平台"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "更新代码平台授权" }),
    ).toBeInTheDocument();
    expect(screen.getByText("等待设置")).toBeInTheDocument();
  });

  it("shows test and production as independent environment states", async () => {
    const path = "/demo/independent-environment-status";
    const workspace = await openProject(path);
    const staging = successfulStagingRun(path);
    const production: DeploymentRun = {
      ...staging,
      id: "production-success",
      environment: "production",
      sourceRunId: staging.id,
      message: "正式环境运行正常",
      startedAt: "2026-07-16T00:10:00.000Z",
      updatedAt: "2026-07-16T00:15:00.000Z",
    };

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: "测试环境：等待你确认，查看详情",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "正式环境：运行正常，查看详情",
      }),
    ).toBeInTheDocument();
  });

  it("uses the durable environment pointer instead of guessing the online version from history", async () => {
    const path = "/demo/authoritative-environment-pointer";
    const workspace = await openProject(path);
    const online = successfulStagingRun(path, {
      id: "staging-online",
      commitSha: "a".repeat(40),
      sourceTitle: "当前在线版本",
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:05:00.000Z",
    });
    const newerHistory = successfulStagingRun(path, {
      id: "staging-newer-history",
      commitSha: "b".repeat(40),
      sourceTitle: "较新的历史记录",
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:05:00.000Z",
    });
    const listEnvironments = vi
      .spyOn(api, "listProjectEnvironments")
      .mockResolvedValue([
        {
          environment: "development",
          displayName: "本机环境",
          status: "unknown",
          currentVersionKey: null,
          currentRunId: null,
        },
        {
          environment: "staging",
          displayName: "测试环境",
          status: "healthy",
          currentVersionKey: deploymentVersionKey(online),
          currentRunId: online.id,
        },
        {
          environment: "production",
          displayName: "生产环境",
          status: "unknown",
          currentVersionKey: null,
          currentRunId: null,
        },
      ]);

    const view = render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[newerHistory, online]}
        saving={false}
        workspace={workspace}
      />,
    );

    const testEnvironmentButton = await screen.findByRole("button", {
      name: /^测试环境：/,
    });
    const card = testEnvironmentButton.closest("section");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("当前在线版本")).toBeInTheDocument();
    expect(within(card!).queryByText("较新的历史记录")).not.toBeInTheDocument();

    view.unmount();
    listEnvironments.mockRestore();
  });

  it("uses the immutable Version collection instead of treating every successful run as a version", async () => {
    const path = "/demo/authoritative-version-catalog";
    const workspace = await openProject(path);
    const realVersion = successfulStagingRun(path, {
      id: "real-version-run",
      commitSha: "c".repeat(40),
      sourceTitle: "权威稳定版本",
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:05:00.000Z",
    });
    const straySuccessfulRun = successfulStagingRun(path, {
      id: "stray-success-run",
      commitSha: "d".repeat(40),
      sourceTitle: "不应冒充版本的记录",
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:05:00.000Z",
    });
    const listVersions = vi
      .spyOn(api, "listProjectVersions")
      .mockResolvedValue([
        {
          id: "version-1",
          versionKey: deploymentVersionKey(realVersion),
          status: "available",
          commitSha: realVersion.commitSha,
          sourceTitle: realVersion.sourceTitle ?? null,
          sourceConnectionId: null,
          sourceBuildId: realVersion.buildSerial,
          repository: realVersion.repository,
          branch: realVersion.branch,
          candidateTag: realVersion.candidateTag,
          stagingRunId: realVersion.id,
          artifacts: realVersion.artifacts,
          validation: null,
          currentEnvironments: ["staging"],
          createdAt: realVersion.startedAt,
          updatedAt: realVersion.updatedAt,
        },
      ]);

    const view = render(
      <ProductWorkspace
        initialScene="versions"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[straySuccessfulRun, realVersion]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("权威稳定版本")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("不应冒充版本的记录")).not.toBeInTheDocument(),
    );

    view.unmount();
    listVersions.mockRestore();
  });

  it("returns from environment details to overview while keeping overview selected", async () => {
    const path = "/demo/contextual-environment-details";
    const workspace = await openProject(path);
    const staging = successfulStagingRun(path);
    const production: DeploymentRun = {
      ...staging,
      id: "production-success",
      environment: "production",
      sourceRunId: staging.id,
      message: "正式环境运行正常",
    };

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openTestEnvironmentDetails();
    closeReleaseTaskPanel();
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    expectOverviewTopLevelActive();

    await openProductionEnvironmentDetails();
    closeReleaseTaskPanel();
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    expectOverviewTopLevelActive();
  });

  it("keeps an unfinished production web save visible on the release overview", async () => {
    const path = "/demo/production-web-save-tab";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.cnb-secret-progress.production`,
      "save-page-opened",
    );

    render(
      <ProductWorkspace
        initialScene="overview"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "正式版还差网页保存" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "继续网页保存" }),
    ).toBeInTheDocument();
  });

  it("restores the exact production web-save page without a temporary checking page", async () => {
    const path = "/demo/production-web-save-resume";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
      "secrets_ref: https://cnb.cool/team/project-secrets/-/blob/main/env.production.yml",
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    const run: DeploymentRun = {
      id: "verified-before-production-web-save",
      projectPath: path,
      projectName: "production-web-save-resume",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "176",
      commitSha: "1763456789abcdef1763456789abcdef17634567",
      sourceRunId: null,
      candidateTag: "candidate-176",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const olderRun: DeploymentRun = {
      ...run,
      id: "verified-history-before-production-web-save",
      buildSerial: "175",
      commitSha: "1753456789abcdef1753456789abcdef17534567",
      sourceTitle: "已选择的历史稳定版本",
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    const server = {
      name: "生产服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([run.id, olderRun.id]),
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.cnb-secret-progress.production`,
      "save-page-opened",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.cnb-secret-pending.production`,
      "true",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.production-pending-version`,
      deploymentVersionKey(olderRun),
    );
    const loadConfig = vi
      .spyOn(api, "loadRuntimeConfig")
      .mockImplementation(async () => new Promise(() => undefined));

    render(
      <ProductWorkspace
        initialScene="production"
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run, olderRun]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "在网页保存正式配置",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "在代码平台网页保存" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "正在确认正式发布条件" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/已选择的历史稳定版本/)).toBeInTheDocument();
    expect(loadConfig).not.toHaveBeenCalled();
    expectOverviewTopLevelActive();
    await openTestEnvironmentDetails();
    expect(
      await screen.findByRole("heading", { name: "测试版已通过验证" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "手动部署测试版" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("已有正式发布等待网页保存")).toBeInTheDocument();
    expect(
      screen.getByText(
        "另一个测试通过的版本正在准备正式版；先完成那次网页保存，再决定是否发布当前版本。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "准备发布正式版" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续网页保存" }));
    expect(
      await screen.findByRole("heading", {
        name: "在网页保存正式配置",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/已选择的历史稳定版本/)).toBeInTheDocument();
    closeReleaseTaskPanel();
    await openVersions();
    expect(screen.getByText("正式版还差网页保存")).toHaveClass(
      "text-[var(--warning)]",
    );
    const continueWebSave = screen.getByRole("button", {
      name: /^继续网页保存：/,
    });
    expect(continueWebSave).toHaveAccessibleName(/已选择的历史稳定版本/);
    fireEvent.click(continueWebSave);
    expect(
      await screen.findByRole("heading", { name: "在网页保存正式配置" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/已选择的历史稳定版本/)).toBeInTheDocument();
    loadConfig.mockRestore();
  });

  it("restores the real pending setup section instead of a stale viewed section", async () => {
    const path = "/demo/restore-first-time-setup-step";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "registry:\n    kind: cnb\n    repository: owner/ecat-energy",
      "registry:\n    kind: tcr\n    registry: ccr.ccs.tencentyun.com\n    namespace: restore-test",
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "settings");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-active`,
      "true",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-step`,
      "registry",
    );
    const onSetupProgressChange = vi.fn();

    expect(versionSetupStep("repository")).toBe("repository");
    expect(versionSetupStep("save-page-opened")).toBeNull();
    render(
      <ProductWorkspace
        initialScene="settings"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        onSetupProgressChange={onSetupProgressChange}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: /连接代码平台.*现在完成/,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("保存项目代码，并自动发现准备上线的更新"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("填写镜像仓库地址和登录信息。"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*随后处理/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("系统会依次带你完成剩余设置，全部完成后返回发布中心"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        localStorage.getItem(
          `abcdeploy.setting.${settingKey}.version-setup-active`,
        ),
      ).toBe("true"),
    );
    const progressChangeCalls = onSetupProgressChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /准备测试环境/ }));
    expect(
      screen.getByRole("button", { name: /连接代码平台.*现在完成/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /准备测试环境.*正在查看/ }),
    ).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(
      localStorage.getItem(
        `abcdeploy.setting.${settingKey}.version-setup-step`,
      ),
    ).toBe("repository");
    expect(onSetupProgressChange).toHaveBeenCalledTimes(progressChangeCalls);
  });

  it("keeps version browsing read-only until the user starts setup", async () => {
    const path = "/demo/read-only-version-catalog";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    const onSaveManifest = vi.fn().mockResolvedValue(true);
    const onSetupProgressChange = vi.fn();

    render(
      <ProductWorkspace
        initialScene="versions"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={onSaveManifest}
        onServerChange={vi.fn()}
        onSetupProgressChange={onSetupProgressChange}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("正在等待第一个版本")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "版本" })).toBeInTheDocument();
    expect(
      screen.getByText(/新版本会自动出现在这里并更新测试版/),
    ).toBeInTheDocument();
    expect(
      localStorage.getItem(
        `abcdeploy.setting.${settingKey}.version-setup-active`,
      ),
    ).toBeNull();
    expect(onSaveManifest).not.toHaveBeenCalled();
    expect(onSetupProgressChange).not.toHaveBeenCalled();

    await beginFirstVersionSetup();
    await waitFor(() =>
      expect(
        localStorage.getItem(
          `abcdeploy.setting.${settingKey}.version-setup-active`,
        ),
      ).toBe("true"),
    );
    expect(onSetupProgressChange).toHaveBeenCalled();
  });

  it("does not count a placeholder CNB repository as a prepared version location", async () => {
    const path = "/demo/placeholder-cnb-version-location";
    const workspace = await openProject(path);

    render(
      <ProductWorkspace
        initialScene="versions"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    expect(
      await screen.findByText("已准备 0 项 · 还差 4 项"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*随后处理/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /连接镜像仓库/ }));
    expect(await screen.findByText("跟随代码仓库保存")).toBeInTheDocument();
    expect(
      screen.getByText(
        "先完成“连接代码平台”，系统会自动准备项目版本位置，不需要再次填写。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("项目版本保存在 CNB")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /准备测试环境/ }));
    expect(await screen.findByText("先完成前面的项目设置")).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器公网 IP")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /开启自动部署/ }));
    expect(await screen.findByText("先完成前面的上线设置")).toBeInTheDocument();
    expect(screen.queryByText("重新复制并打开网页")).not.toBeInTheDocument();
  });

  it("does not flash empty version results while saved project state is restoring", async () => {
    const path = "/demo/restoring-version-state";
    const workspace = await openProject(path);
    const run: DeploymentRun = {
      id: "verified-version",
      projectPath: path,
      projectName: "restoring-version-state",
      environment: "staging",
      status: "success",
      currentStage: "completed",
      buildSerial: "12",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      sourceRunId: null,
      sourceTitle: "优化登录体验",
      candidateTag: "candidate-12",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/restoring-version-state",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: ["write-config", "verify-build", "deploy", "healthcheck"],
      startedAt: "2026-07-15T00:00:00Z",
      updatedAt: "2026-07-15T00:05:00Z",
    };
    let finishVerifiedSetting:
      ((value: Record<string, string>) => void) | undefined;
    const settingKey = `project.${encodeURIComponent(path)}`;
    const setting = vi.spyOn(api, "getAppSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishVerifiedSetting = resolve;
        }),
    );

    render(
      <ProductWorkspace
        initialScene="versions"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(screen.getByRole("heading", { name: "版本" })).toBeInTheDocument();
    expect(
      within(projectNavigation()).getByRole("button", { name: "版本" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("正在恢复项目状态")).toBeInTheDocument();
    expect(screen.queryByText(/0 个测试通过/)).not.toBeInTheDocument();

    act(() =>
      finishVerifiedSetting?.({
        [`${settingKey}.verified-run`]: JSON.stringify([run.id]),
        [`${settingKey}.version-setup-complete`]: "true",
      }),
    );
    expect(
      await screen.findByText("1 个版本 · 1 个测试通过"),
    ).toBeInTheDocument();
    expect(setting).toHaveBeenCalledTimes(1);
    expect(setting.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        `${settingKey}.verified-run`,
        `${settingKey}.verified-version`,
        `${settingKey}.local-milestone`,
        `${settingKey}.version-setup-complete`,
      ]),
    );
    setting.mockRestore();
  });

  it("starts the first test deployment from the release center without a second deploy click", async () => {
    const path = "/demo/direct-first-test-deployment";
    const workspace = await openProject(path);
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(["source", "repository"], "demo/direct-first-test");
    document.setIn(
      ["providers", "build", "repository"],
      "demo/direct-first-test",
    );
    document.setIn(
      ["environments", "staging", "secrets_ref"],
      "https://cnb.cool/demo/deploy-secrets/-/blob/main/direct-first-test.staging.yml",
    );
    document.setIn(
      ["environments", "staging", "domains"],
      [{ service: "api", host: "direct-first-test.example.com", path: "/" }],
    );
    workspace.manifestExists = true;
    workspace.manifestYaml = document.toString({ lineWidth: 0 });
    const settingKey = `project.${encodeURIComponent(path)}`;
    const settings = vi.spyOn(api, "getAppSettings").mockResolvedValue({
      [`${settingKey}.version-setup-complete`]: "true",
    });
    const config = vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "APP_SECRET=saved",
      templateContent: "APP_SECRET=",
      requiredVariables: ["APP_SECRET"],
      stored: true,
      authorizationRequired: false,
    });
    const sync = vi
      .spyOn(api, "getRuntimeConfigSyncStatus")
      .mockResolvedValue({ stored: true, synchronized: true });
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/tmp/id_ed25519",
      hostFingerprint: "SHA256:direct-first-test",
    };
    let finishDeployment: (() => void) | undefined;
    const deploy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeployment = resolve;
        }),
    );

    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={deploy}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "生成第一个测试版" }),
    );
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith(
        server,
        "demo/direct-first-test",
        false,
      ),
    );
    const startingButton = await screen.findByRole("button", {
      name: "正在开始部署",
    });
    expect(startingButton).toBeDisabled();
    fireEvent.click(startingButton);
    expect(deploy).toHaveBeenCalledTimes(1);
    finishDeployment?.();

    settings.mockRestore();
    config.mockRestore();
    sync.mockRestore();
  });

  it("does not report local services as stopped before their real state is read", async () => {
    const path = "/demo/restoring-local-state";
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    let finishPreview: ((value: typeof stopped) => void) | undefined;
    const preview = vi.spyOn(api, "getLocalPreviewStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve;
        }),
    );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText("正在读取本机状态，项目内容已经可以查看"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "项目服务" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "运行依赖" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("正在读取").length).toBeGreaterThan(0);
    expect(
      screen.queryByText(`0/${stopped.services.length} 运行中`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();

    act(() => finishPreview?.(stopped));
    expect(
      await screen.findByText(`0/${stopped.services.length} 运行中`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键启动全部" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "全部停止" }),
    ).not.toBeInTheDocument();
    preview.mockRestore();
  });

  it("keeps an honest recovery path when a selected folder has no recognized services", async () => {
    const path = "/demo/no-recognized-services";
    const workspace = await openProject(path);
    workspace.inspection.services = [];
    const current = await api.getLocalPreviewStatus(path);
    const preview = vi.spyOn(api, "getLocalPreviewStatus").mockResolvedValue({
      ...current,
      services: [],
      state: "stopped",
    });
    const onReselectProject = vi.fn();

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRecognitionDismiss={vi.fn()}
        onRefresh={vi.fn()}
        onReselectProject={onReselectProject}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        showRecognitionSummary
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("没有识别到项目服务")).toBeInTheDocument();
    expect(
      screen.getByText(
        "这通常是文件夹层级不对。请选择包含前后端等完整代码的最外层文件夹。",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("未识别")).toBeInTheDocument();
    expect(screen.queryByText("0/0 运行中")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新选择文件夹" }));
    expect(onReselectProject).toHaveBeenCalledTimes(1);
    preview.mockRestore();
  });

  it("does not let one project stop shared local infrastructure", async () => {
    const path = "/demo/shared-local-infrastructure";
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      (await screen.findAllByText(/由 ABCDeploy 统一维护/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "停止本地数据库" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止缓存服务" }),
    ).not.toBeInTheDocument();
  });

  it("starts only runnable services when another service needs development work", async () => {
    const path = "/demo/partially-runnable-local-project";
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    const preview = vi.spyOn(api, "getLocalPreviewStatus").mockResolvedValue({
      ...stopped,
      services: [
        ...stopped.services.map((service) => ({
          ...service,
          buildStrategy: "existing" as const,
          running: false,
        })),
        {
          id: "toolbox",
          kind: "web",
          buildStrategy: "needs_input",
          dockerfile: "apps/toolbox/Dockerfile",
          hostPort: 4310,
          url: "http://127.0.0.1:4310",
          running: false,
        },
      ],
    });

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: `启动可运行的 ${stopped.services.length} 个服务`,
      }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        `可以逐个启动，也可以一次启动 ${stopped.services.length} 个可运行服务；另有 1 个需要开发工具处理。`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();
    preview.mockRestore();
  });

  it("does not invite the user to start zero runnable services", async () => {
    const path = "/demo/no-runnable-local-services";
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    const blockedServices = stopped.services.map((service) => ({
      ...service,
      buildStrategy: "needs_input" as const,
      running: false,
    }));
    const preview = vi.spyOn(api, "getLocalPreviewStatus").mockResolvedValue({
      ...stopped,
      services: blockedServices,
    });

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText(
        `当前 ${blockedServices.length} 个服务都需要开发工具补齐运行配置；处理后回到这里启动。`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/一次启动 0 个/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /启动可运行的 0 个服务/ }),
    ).not.toBeInTheDocument();
    preview.mockRestore();
  });

  it("does not wait for unused infrastructure or development preferences", async () => {
    const path = "/demo/no-local-infrastructure";
    const workspace = await openProject(path);
    workspace.inspection.environment_variables = [];
    workspace.inspection.prisma_schemas = [];
    const stopped = await api.getLocalPreviewStatus(path);
    let finishPreview: ((value: typeof stopped) => void) | undefined;
    const preview = vi.spyOn(api, "getLocalPreviewStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve;
        }),
    );
    const infrastructure = vi.spyOn(api, "getLocalInfrastructureStatus");
    const support = vi
      .spyOn(api, "getLocalDevelopmentSupport")
      .mockImplementation(() => new Promise(() => undefined));

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText("正在读取本机状态，项目内容已经可以查看"),
    ).toBeInTheDocument();
    act(() => finishPreview?.(stopped));
    expect(
      await screen.findByText(`0/${stopped.services.length} 运行中`),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("正在读取本机状态，项目内容已经可以查看"),
    ).not.toBeInTheDocument();
    expect(infrastructure).not.toHaveBeenCalled();

    preview.mockRestore();
    infrastructure.mockRestore();
    support.mockRestore();
  });

  it("keeps unknown local state honest and lets the user retry", async () => {
    const path = "/demo/retry-local-state";
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    const preview = vi
      .spyOn(api, "getLocalPreviewStatus")
      .mockRejectedValueOnce(new Error("Docker 暂时没有响应"))
      .mockResolvedValue(stopped);

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    const retry = await screen.findByRole("button", {
      name: "重新读取状态",
    });
    expect(screen.getAllByText("状态未知").length).toBeGreaterThan(0);
    expect(
      screen.queryByText(`0/${stopped.services.length} 运行中`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();

    fireEvent.click(retry);
    expect(
      await screen.findByText(`0/${stopped.services.length} 运行中`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键启动全部" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "全部停止" }),
    ).not.toBeInTheDocument();
    preview.mockRestore();
  });

  it("offers the committed version without including local uncommitted changes", () => {
    const retry = vi.fn();
    render(
      <DeploymentBlockerBanner
        deploying={false}
        message="AD-GIT-101：发现尚未提交的项目文件：src/app.ts。为避免部署旧代码，已暂停同步"
        onDeployCommitted={retry}
      />,
    );

    expect(screen.getByText("项目改动还没有提交")).toBeInTheDocument();
    expect(
      screen.getByText(
        "项目里还有尚未加入代码版本的改动。为了避免发布旧内容，系统已经暂停。",
      ),
    ).toBeInTheDocument();
    const technicalDetails = screen
      .getByText("查看技术详情")
      .closest("details");
    expect(technicalDetails).not.toHaveAttribute("open");
    expect(technicalDetails).toHaveTextContent("AD-GIT-101");
    expect(technicalDetails).toHaveTextContent("src/app.ts");
    fireEvent.click(screen.getByRole("button", { name: "部署已提交版本" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("always leaves a concrete recovery action when deployment has not started", () => {
    const retry = vi.fn();
    const openSetup = vi.fn();
    const { rerender } = render(
      <DeploymentBlockerBanner
        deploying={false}
        message="AD-BLD-201：项目没有通过构建"
        onDeployCommitted={vi.fn()}
        onOpenSetup={openSetup}
        onRetry={retry}
      />,
    );

    expect(screen.getByText("项目版本没有生成成功")).toBeInTheDocument();
    expect(screen.getByText(/下一步：.*编程工具/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(
      <DeploymentBlockerBanner
        deploying={false}
        message="AD-CFG-201：测试环境缺少 DATABASE_URL"
        onDeployCommitted={vi.fn()}
        onOpenSetup={openSetup}
        onRetry={retry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "检查上线设置" }));
    expect(openSetup).toHaveBeenCalledTimes(1);
  });

  it("reuses the verified SSH identity for a saved server", () => {
    const servers: ServerResource[] = [
      {
        id: "saved-server",
        name: "默认服务器",
        host: "server.example.com",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/verified-server",
        keyPathExists: true,
        hostFingerprint: "SHA256:verified",
        lastCheckedAt: "2026-07-13T12:00:00.000Z",
      },
      {
        id: "missing-key",
        name: "密钥已删除",
        host: "missing.example.com",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/missing",
        keyPathExists: false,
        lastCheckedAt: "2026-07-13T11:00:00.000Z",
      },
    ];

    expect(
      reusableServer(
        {
          name: "测试服务器",
          host: "SERVER.EXAMPLE.COM",
          user: "ubuntu",
          port: 22,
          keyPath: "",
        },
        servers,
      ),
    ).toEqual(servers[0]);
    expect(
      reusableServer(
        {
          name: "测试服务器",
          host: "missing.example.com",
          user: "ubuntu",
          port: 22,
          keyPath: "",
        },
        servers,
      ),
    ).toBeUndefined();

    expect(serverFormFromResource(servers[0])).toEqual({
      name: "默认服务器",
      host: "server.example.com",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/verified-server",
      hostFingerprint: "SHA256:verified",
    });
  });

  it("binds a first-time production server only to production after one-time authorization", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    vi.spyOn(api, "listServers").mockResolvedValue([]);
    vi.spyOn(api, "discoverSshIdentities").mockResolvedValue([
      {
        name: "abcdeploy_ed25519",
        path: "/Users/demo/.ssh/abcdeploy_ed25519",
        source: "ABCDeploy 专用身份",
        fingerprint: "SHA256:local",
        managed: true,
      },
    ]);
    const check = vi
      .spyOn(api, "checkServer")
      .mockImplementation(async (form) =>
        form.hostFingerprint
          ? {
              provider: "ssh-key-install",
              ok: false,
              summary: "服务器还不认识这台电脑",
              details: [],
              code: "AD-SSH-105",
              nextSteps: ["输入一次服务器登录密码"],
              retryable: true,
            }
          : {
              provider: "ssh-host-key",
              ok: false,
              summary: "请确认这台服务器的身份指纹",
              details: ["SHA256:server"],
            },
      );
    const install = vi
      .spyOn(api, "installServerKeyWithPassword")
      .mockResolvedValue({
        provider: "ssh",
        ok: true,
        summary: "服务器已建立安全连接",
        details: ["服务器密码未保存"],
      });
    const bind = vi.spyOn(api, "bindProjectServer").mockResolvedValue({
      id: "server",
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
      keyPathExists: true,
      hostFingerprint: "SHA256:server",
      lastCheckedAt: "2026-07-15T00:00:00Z",
    });

    render(
      <ServerPreparation
        environment="production"
        onError={onError}
        onReady={onReady}
        path="/demo/new-server"
      />,
    );
    expect(
      screen.getByText("在云服务器控制台的实例详情中复制“公网 IP”。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ubuntu 通常是 ubuntu，其他系统可在实例详情中查看。"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("服务器公网 IP"), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(await screen.findByText("确认连接这台服务器")).toBeInTheDocument();
    expect(screen.getByText(/你正在连接 203\.0\.113\.10/)).toBeInTheDocument();
    expect(screen.getByText("查看服务器指纹")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认这是我的服务器" }));

    expect(await screen.findByText("还差一次服务器授权")).toBeInTheDocument();
    expect(screen.getByText(/密码只使用这一次，不会保存/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("服务器登录密码"), {
      target: { value: "one-time-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "建立安全连接" }));

    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "203.0.113.10",
        hostFingerprint: "SHA256:server",
      }),
      "one-time-password",
    );
    expect(check).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith(
      "/demo/new-server",
      "production",
      expect.objectContaining({
        host: "203.0.113.10",
        hostFingerprint: "SHA256:server",
      }),
    );
    expect(bind).not.toHaveBeenCalledWith(
      "/demo/new-server",
      "staging",
      expect.anything(),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("服务器登录密码")).not.toBeInTheDocument();
  });

  it("creates temporary HTTP test addresses from a public IPv4 server", async () => {
    const workspace = await openProject("/demo/automatic-address");
    const domains = automaticTestDomains(workspace, {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
    });
    expect(domains).not.toBeNull();
    expect(Object.values(domains ?? {})).not.toHaveLength(0);
    expect(Object.values(domains ?? {})).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.203-0-113-10\.sslip\.io$/),
      ]),
    );
    expect(
      automaticTestDomains(workspace, {
        name: "域名服务器",
        host: "server.example.com",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/server",
      }),
    ).toBeNull();
    const updatedWorkspace = {
      ...workspace,
      manifestYaml:
        "environments:\n  staging:\n    domains:\n      - service: api\n        host: demo.42-193-229-35.sslip.io\n        path: /\n",
    };
    expect(testAddress(updatedWorkspace)).toBe(
      "http://demo.42-193-229-35.sslip.io",
    );
  });

  it("opens the user-facing website first and keeps every production service visible", async () => {
    const workspace = await openProject("/demo/production-addresses");
    const base = workspace.inspection.services[0];
    workspace.inspection.services = [
      { ...base, id: "api", kind: "api" },
      { ...base, id: "h5", kind: "web" },
      { ...base, id: "ocr", kind: "api" },
    ];
    workspace.manifestYaml = `environments:
  production:
    domains:
      - service: api
        host: api.example.com
      - service: h5
        host: example.com
      - service: ocr
        host: ocr.example.com
`;

    expect(
      environmentAddresses(workspace, "production").map(
        (address) => address.host,
      ),
    ).toEqual(["example.com", "api.example.com", "ocr.example.com"]);
  });

  it("creates the dedicated deployment connection before generating CNB secrets", async () => {
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    const identity = vi
      .spyOn(api, "preparePipelineIdentity")
      .mockResolvedValue({ created: true, fingerprint: "SHA256:pipeline" });
    const bundle = vi.spyOn(api, "prepareCnbSecretBundle").mockResolvedValue({
      environment: "staging",
      filename: "env.demo.staging.yml",
      fileUrl:
        "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.demo.staging.yml",
      content: "STAGING_SERVER_HOST: 203.0.113.10\n",
      missingVariables: [],
      deployKeyFingerprint: "SHA256:pipeline",
    });

    await prepareCnbDeploymentBundle(
      "/demo/project",
      "staging",
      "demo/deploy-secrets",
      server,
    );

    expect(identity).toHaveBeenCalledWith("/demo/project", server);
    expect(bundle).toHaveBeenCalledWith(
      "/demo/project",
      "staging",
      "demo/deploy-secrets",
      server,
    );
    expect(identity.mock.invocationCallOrder[0]).toBeLessThan(
      bundle.mock.invocationCallOrder[0],
    );
    identity.mockRestore();
    bundle.mockRestore();
  });

  it("keeps the repository root URL available and opens the new-file editor for setup", () => {
    expect(cnbRepositoryUrl(" demo/deploy-secrets/ ")).toBe(
      "https://cnb.cool/demo/deploy-secrets",
    );
    expect(cnbNewFileUrl(" demo/deploy-secrets/ ")).toBe(
      "https://cnb.cool/demo/deploy-secrets/-/new/main",
    );
    expect(
      cnbNewFileUrl("demo/deploy-secrets", "env.demo project.staging.yml"),
    ).toBe(
      "https://cnb.cool/demo/deploy-secrets/-/new/main?file_name=env.demo%20project.staging.yml",
    );
  });

  it("describes the pending cloud handoff without inventing a missing save or exposing the provider", async () => {
    const path = "/demo/runtime-config-not-ready";
    const workspace = await openProject(path);

    render(
      <CnbSecretSetup
        environment="production"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady={false}
        workspace={workspace}
      />,
    );

    expect(
      screen.getByText(
        "先完成正式配置，随后系统会引导你在代码平台网页安全保存。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/先保存上面的配置/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CNB/)).not.toBeInTheDocument();
  });

  it("describes completed cloud setup by the user outcome", async () => {
    const stagingPath = "/demo/completed-staging-cloud-setup";
    const stagingWorkspace = await openProject(stagingPath);
    const stagingDocument = parseDocument(stagingWorkspace.manifestYaml);
    stagingDocument.setIn(
      ["environments", "staging", "secrets_ref"],
      "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.demo.staging.yml",
    );
    stagingWorkspace.manifestYaml = stagingDocument.toString({ lineWidth: 0 });

    const stagingResult = render(
      <CnbSecretSetup
        environment="staging"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={stagingPath}
        runtimeReady
        workspace={stagingWorkspace}
      />,
    );

    expect(await screen.findByText("自动部署已经开启")).toBeInTheDocument();
    expect(
      screen.getByText(
        "以后把代码合并到主分支，系统会自动生成版本并更新测试版；正式版仍由你确认发布。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("安全配置位置已记录")).not.toBeInTheDocument();
    stagingResult.unmount();

    const productionPath = "/demo/completed-production-cloud-setup";
    const productionWorkspace = await openProject(productionPath);
    const productionDocument = parseDocument(productionWorkspace.manifestYaml);
    productionDocument.setIn(
      ["environments", "production", "secrets_ref"],
      "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.demo.production.yml",
    );
    productionWorkspace.manifestYaml = productionDocument.toString({
      lineWidth: 0,
    });

    render(
      <CnbSecretSetup
        environment="production"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={productionPath}
        runtimeReady
        workspace={productionWorkspace}
      />,
    );

    expect(await screen.findByText("正式发布配置已准备")).toBeInTheDocument();
    expect(
      screen.getByText(
        "以后发布正式版时会使用这里保存的配置，不需要重复填写。",
      ),
    ).toBeInTheDocument();
  });

  it("reuses one CNB secure location across projects without creating another repository", async () => {
    const path = "/demo/reuse-shared-secret-repository";
    const workspace = await openProject(path);
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    localStorage.setItem(
      "abcdeploy.setting.cnb.secret-repository",
      "demo/shared-deploy-secrets",
    );
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.cnb-secret-repository`,
      "demo/interrupted-suggested-name",
    );
    const identity = vi
      .spyOn(api, "preparePipelineIdentity")
      .mockResolvedValue({ created: true, fingerprint: "SHA256:pipeline" });
    const bundle = vi.spyOn(api, "prepareCnbSecretBundle").mockResolvedValue({
      environment: "staging",
      filename: "env.reuse-shared-secret-repository.staging.yml",
      fileUrl:
        "https://cnb.cool/demo/shared-deploy-secrets/-/blob/main/env.reuse-shared-secret-repository.staging.yml",
      content: "STAGING_SERVER_HOST: 203.0.113.10\n",
      missingVariables: [],
      deployKeyFingerprint: "SHA256:pipeline",
    });

    render(
      <CnbSecretSetup
        environment="staging"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady
        server={server}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已找到以前使用的位置")).toBeInTheDocument();
    expect(
      screen.getByText(
        "当前授权的使用范围包含此位置时可以复用，不需要重新创建。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开 CNB 创建保存位置" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "准备配置并打开 CNB" }));
    await waitFor(() =>
      expect(bundle).toHaveBeenCalledWith(
        path,
        "staging",
        "demo/shared-deploy-secrets",
        server,
      ),
    );
    expect(
      localStorage.getItem(
        `abcdeploy.setting.project.${encodeURIComponent(path)}.cnb-secret-repository`,
      ),
    ).toBe("demo/shared-deploy-secrets");
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        cnbNewFileUrl(
          "demo/shared-deploy-secrets",
          "env.reuse-shared-secret-repository.staging.yml",
        ),
      ),
    );

    identity.mockRestore();
    bundle.mockRestore();
  });

  it("does not claim an interrupted CNB secure location exists before CNB confirms it", async () => {
    const path = "/demo/missing-secret-repository";
    const workspace = await openProject(path);
    const repositoryKey = `project.${encodeURIComponent(path)}.cnb-secret-repository`;
    const progressKey = `project.${encodeURIComponent(path)}.cnb-secret-progress.staging`;
    localStorage.setItem(
      `abcdeploy.setting.${repositoryKey}`,
      "demo/missing-secret-repository-secrets",
    );
    localStorage.setItem(
      `abcdeploy.setting.${progressKey}`,
      "save-page-opened",
    );
    const access = vi
      .spyOn(api, "checkCnbSecretRepositoryAccess")
      .mockResolvedValue({
        provider: "cnb-secret-repository",
        ok: false,
        summary: "CNB 安全位置尚未创建",
        details: [],
      });

    render(
      <CnbSecretSetup
        environment="staging"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady
        server={{
          name: "测试服务器",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/Users/demo/.ssh/server",
          hostFingerprint: "SHA256:server",
        }}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText(
        "系统刚刚检查过，CNB 上还没有这个位置。重新创建即可继续，不会修改其他项目。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("已找到以前使用的位置")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开 CNB 创建" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "我已创建，打开配置页面" }),
    ).toBeInTheDocument();
    access.mockRestore();
  });

  it("keeps a clear retry path when restoring the web save cannot regenerate its local bundle", async () => {
    const path = "/demo/retry-interrupted-secret-bundle";
    const workspace = await openProject(path);
    const repository = "demo/retry-interrupted-secret-bundle-secrets";
    const repositoryKey = `project.${encodeURIComponent(path)}.cnb-secret-repository`;
    const progressKey = `project.${encodeURIComponent(path)}.cnb-secret-progress.staging`;
    localStorage.setItem(`abcdeploy.setting.${repositoryKey}`, repository);
    localStorage.setItem(
      `abcdeploy.setting.${progressKey}`,
      "save-page-opened",
    );
    const access = vi
      .spyOn(api, "checkCnbSecretRepositoryAccess")
      .mockResolvedValue({
        provider: "cnb-secret-repository",
        ok: true,
        summary: "CNB 安全位置可用",
        details: [],
      });
    const generatedBundle: CnbSecretBundle = {
      environment: "staging",
      filename: "env.retry-interrupted-secret-bundle.staging.yml",
      fileUrl: `https://cnb.cool/${repository}/-/blob/main/env.retry-interrupted-secret-bundle.staging.yml`,
      content: "STAGING_SERVER_HOST: 203.0.113.10\n",
      missingVariables: [],
      deployKeyFingerprint: "SHA256:pipeline",
    };
    const bundle = vi
      .spyOn(api, "prepareCnbSecretBundle")
      .mockRejectedValueOnce(new Error("系统密钥库暂时不可用"))
      .mockResolvedValue(generatedBundle);
    const onError = vi.fn();

    render(
      <CnbSecretSetup
        environment="staging"
        onError={onError}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady
        server={{
          name: "测试服务器",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/Users/demo/.ssh/server",
          hostFingerprint: "SHA256:server",
        }}
        workspace={workspace}
      />,
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("系统密钥库暂时不可用"),
    );
    const retry = await screen.findByRole("button", {
      name: "重新复制文件名并打开网页",
    });
    expect(
      screen.getByText(
        "尚未保存就重新打开网页；已经保存则直接继续。客户端会重新准备文件名和配置内容。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(retry);

    await waitFor(() => expect(bundle).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        cnbNewFileUrl(repository, generatedBundle.filename),
      ),
    );
    expect(
      screen.getByRole("button", { name: "复制配置内容" }),
    ).toBeInTheDocument();

    access.mockRestore();
    bundle.mockRestore();
  });

  it("restores the CNB repository creation handoff after reopening the app", async () => {
    const path = "/demo/resume-secret-repository-creation";
    const workspace = await openProject(path);
    const progressKey = `project.${encodeURIComponent(path)}.cnb-secret-progress.staging`;
    localStorage.setItem(
      `abcdeploy.setting.${progressKey}`,
      "creation-page-opened",
    );

    render(
      <CnbSecretSetup
        environment="staging"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady
        server={{
          name: "测试服务器",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/Users/demo/.ssh/server",
          hostFingerprint: "SHA256:server",
        }}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText(
        "上次已经打开过创建页面。完成创建后继续；如果网页已经关闭，也可以再次打开。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "我已创建，打开配置页面" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新复制名称并打开网页" }),
    ).toBeInTheDocument();
  });

  it("does not mistake an old suggested repository name for a reusable location", async () => {
    const path = "/demo/legacy-secret-repository-draft";
    const workspace = await openProject(path);
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.cnb-secret-repository`,
      "demo/legacy-secret-repository-draft-secrets",
    );

    render(
      <CnbSecretSetup
        environment="staging"
        onError={vi.fn()}
        onReadyChange={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        path={path}
        runtimeReady
        server={{
          name: "测试服务器",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/Users/demo/.ssh/server",
          hostFingerprint: "SHA256:server",
        }}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("新位置名称已经准备好")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开 CNB 创建保存位置" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "准备配置并打开 CNB" }),
    ).not.toBeInTheDocument();
  });

  it("reuses the recorded secret repository instead of asking production users to create it again", async () => {
    const workspace = await openProject("/demo/recorded-secret-repository");
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", "staging", "secrets_ref"],
      "https://cnb.cool/demo/deploy-secrets/-/blob/main/env.demo.staging.yml",
    );
    const configured = {
      ...workspace,
      manifestYaml: document.toString({ lineWidth: 0 }),
    };
    expect(
      recordedSecretRepository(configured, "production", "demo/deploy-secrets"),
    ).toBe(true);
    expect(
      recordedSecretRepository(configured, "production", "demo/other"),
    ).toBe(false);
  });

  it("restores completed test preparation without reopening every setup card", async () => {
    expect(
      runtimeConfigStoredReady({
        environment: "staging",
        filename: ".env.staging",
        sourceFiles: [".env.example"],
        content: "APP_SECRET=saved\nDATABASE_URL=\n",
        templateContent: "APP_SECRET=\nDATABASE_URL=\n",
        requiredVariables: ["APP_SECRET", "DATABASE_URL"],
        stored: true,
        authorizationRequired: false,
      }),
    ).toBe(true);
    expect(
      runtimeConfigStoredReady({
        environment: "staging",
        filename: ".env.staging",
        sourceFiles: [".env.example"],
        content: "APP_SECRET=\n",
        templateContent: "APP_SECRET=\n",
        requiredVariables: ["APP_SECRET"],
        stored: true,
        authorizationRequired: false,
      }),
    ).toBe(false);

    const workspace = await openProject("/demo/address-ready");
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", "staging", "domains"],
      [{ service: "api", host: "api.test.example.com", path: "/" }],
    );
    expect(
      stagingAddressConfigured({
        ...workspace,
        manifestYaml: document.toString({ lineWidth: 0 }),
      }),
    ).toBe(true);
  });

  it("marks the same runtime variable optional in every affected service", () => {
    const result = runtimeVariableOptionalManifest(
      `services:
  - id: api
    runtime_env:
      - name: OPTIONAL_API_KEY
        required: true
      - name: DATABASE_URL
        required: true
  - id: worker
    runtime_env:
      - name: OPTIONAL_API_KEY
        required: true
`,
      "OPTIONAL_API_KEY",
    );

    expect(result).toContain("name: OPTIONAL_API_KEY\n        required: false");
    expect(result).toContain("name: DATABASE_URL\n        required: true");
  });

  it("keeps a CNB action visible and explains why production is blocked", async () => {
    const path = "/demo/recovery";
    const workspace = await openProject(path);
    const run: DeploymentRun = {
      id: "run-needs-action",
      projectPath: path,
      projectName: "recovery",
      environment: "staging",
      status: "needs_action",
      currentStage: "cloud-setup",
      buildSerial: null,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: "cloud-setup",
      actionUrl: "https://cnb.cool/new/repos",
      issueCode: "AD-CNB-201",
      repository: "demo/recovery",
      branch: "main",
      message: "还差一次 CNB 安全配置，完成后可以继续",
      completedSteps: ["write-config"],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };

    render(
      <ProductWorkspace
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openTestEnvironmentDetails();
    expect(
      await screen.findByRole("heading", { name: "测试配置还需要准备" }),
    ).toBeInTheDocument();
    expect(screen.getByText(run.message)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "继续完成上线设置" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "检查并继续" }),
    ).not.toBeInTheDocument();

    closeReleaseTaskPanel();
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    expect(screen.getByText("尚未发布")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^正式环境：/ }),
    ).not.toBeInTheDocument();
  });

  it("sends a fresh project directly from production to its unfinished setup", async () => {
    const path = "/demo/fresh-production-entry";
    const workspace = await openProject(path);
    const onSceneChange = vi.fn();

    render(
      <ProductWorkspace
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onSceneChange={onSceneChange}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "先完成一次上线设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "完成后系统会生成并部署测试版；只有你确认通过的版本才能发布给真实用户。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "前往测试版" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续完成设置" }));

    expect(
      await screen.findByRole("heading", { name: "项目设置" }),
    ).toBeInTheDocument();
    expect(onSceneChange).toHaveBeenLastCalledWith("settings");
  });

  it("repairs staging CNB authorization from the exact stalled task", async () => {
    const path = "/demo/staging-cnb-authorization";
    const workspace = await openProject(path);
    const run: DeploymentRun = {
      id: "staging-cnb-authorization",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "needs_action",
      currentStage: "healthcheck",
      buildSerial: null,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: "AD-CNB-103",
      repository: "demo/project",
      branch: "main",
      message: "CNB API 请求失败 (403): Missing required scopes",
      completedSteps: [
        "write-config",
        "verify-build",
        "publish-images",
        "prepare-server",
        "deploy",
      ],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.scene`,
      "test",
    );
    const connect = vi.spyOn(api, "connectCnb").mockResolvedValue({
      connected: true,
      displayName: "示例用户",
      username: "demo",
      defaultNamespace: "demo",
      namespaces: [],
    });
    const onRefresh = vi.fn().mockResolvedValue(run);
    const view = render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openOverview();
    fireEvent.click(
      await screen.findByRole("button", { name: "更新代码平台授权" }),
    );
    expect(
      await screen.findByRole("heading", { name: "更新 CNB 授权" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("授权范围：在创建令牌页面勾选这 6 项"),
    ).toBeInTheDocument();
    expect(screen.getByText("读写项目代码")).toBeInTheDocument();
    expect(screen.getByText("读取构建记录")).toBeInTheDocument();
    expect(screen.getByText("读取构建详情")).toBeInTheDocument();
    expect(screen.getByText("管理仓库设置")).toBeInTheDocument();
    expect(screen.getByText("触发自动构建")).toBeInTheDocument();
    expect(screen.getByText("创建代码仓库")).toBeInTheDocument();
    expect(
      screen.getByText(
        /令牌统一保存在本机系统密钥库，符合使用范围的项目可以复用/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/CNB 令牌需要同时设置“授权范围”和“使用范围”/),
    ).toBeInTheDocument();
    expect(screen.getByText("demo/project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制权限代码" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        [
          "repo-code:rw",
          "repo-cnb-history:r",
          "repo-cnb-detail:r",
          "repo-manage:rw",
          "repo-cnb-trigger:rw",
          "group-resource:rw",
        ].join("\n"),
      ),
    );
    expect(
      screen.getByRole("button", { name: "权限代码已复制" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新的访问令牌"), {
      target: { value: "replacement-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存授权并继续" }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        "replacement-token",
        true,
        "demo/project",
      ),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(run));
    expect(
      await screen.findByText("新令牌已保存，但 CNB 仍拒绝读取当前仓库"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "请同时检查授权范围和使用范围；使用范围必须包含 demo/project 或全部仓库。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "更新 CNB 授权" })).toBeVisible();
    expect(screen.getByLabelText("新的访问令牌")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("dialog", { name: "更新 CNB 授权" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("当前 CNB 授权无法完成这项操作"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("代码平台授权还不完整，已经完成的部署步骤仍然保留。"),
    ).toBeInTheDocument();
    const deploymentTechnicalDetails = screen
      .getByText("查看技术详情")
      .closest("details");
    expect(deploymentTechnicalDetails).not.toHaveAttribute("open");
    expect(screen.getByText(/Missing required scopes/)).not.toBeVisible();

    view.rerender(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[
          {
            ...run,
            id: "staging-task-not-created",
            issueCode: "AD-CNB-202",
            message: "远程测试任务没有创建成功",
          },
        ]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "重新部署当前代码" }),
    ).toBeInTheDocument();
    connect.mockRestore();
  });

  it("keeps a rejected replacement CNB token in the dialog without refreshing the task", async () => {
    const path = "/demo/staging-cnb-token-rejected";
    const workspace = await openProject(path);
    const run: DeploymentRun = {
      id: "staging-cnb-token-rejected",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "needs_action",
      currentStage: "build",
      buildSerial: null,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: "cnb-builds",
      actionUrl: null,
      issueCode: "AD-CNB-103",
      repository: "demo/rejected-token",
      branch: "main",
      message: "当前授权无法读取构建结果",
      completedSteps: ["write-config"],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.scene`,
      "test",
    );
    let rejectConnect: ((reason: Error) => void) | undefined;
    const connect = vi.spyOn(api, "connectCnb").mockImplementation(
      async () =>
        new Promise((_, reject) => {
          rejectConnect = reject;
        }),
    );
    const onRefresh = vi.fn();
    const onError = vi.fn();
    const onCnbAuthorizationOpenChange = vi.fn();

    const view = render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onCnbAuthorizationOpenChange={onCnbAuthorizationOpenChange}
        onError={onError}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openOverview();
    fireEvent.click(
      await screen.findByRole("button", { name: "更新代码平台授权" }),
    );
    fireEvent.change(screen.getByLabelText("新的访问令牌"), {
      target: { value: "replacement-token-that-must-stay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存授权并继续" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(onCnbAuthorizationOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(
      screen.getByRole("dialog", { name: "更新 CNB 授权" }),
    ).toBeInTheDocument();
    await act(async () => {
      rejectConnect?.(
        new Error(
          'AD-CNB-103：CNB API 请求失败 (403)。原始信息：{"errmsg":"denied"}',
        ),
      );
    });

    expect(
      await screen.findByText("新令牌未保存，当前任务仍使用原授权"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("新的访问令牌")).toHaveValue(
      "replacement-token-that-must-stay",
    );
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText(/errmsg|denied/)).not.toBeInTheDocument();
    view.unmount();
    expect(onCnbAuthorizationOpenChange).toHaveBeenLastCalledWith(false);
    connect.mockRestore();
  });

  it("names the exact service whose production address is missing", async () => {
    const path = "/demo/missing-production-address";
    const workspace = await openProject(path);
    workspace.inspection.services = [
      workspace.inspection.services[0],
      {
        ...workspace.inspection.services[0],
        id: "ocr",
        package_name: "@demo/ocr",
      },
    ];
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "domains: []\n    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
      "domains:\n      - service: api\n        host: api.example.com\n        path: /\n    secrets_ref: https://cnb.cool/team/project-secrets/-/blob/main/env.production.yml",
    );
    const run: DeploymentRun = {
      id: "verified-staging",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "101",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "candidate-101",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: [],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      run.id,
    );

    render(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    expect(
      await screen.findByRole("heading", { name: "先完成正式配置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "配置内容" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "有需要填写的内容会列在下面；没有时直接使用当前配置继续。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "下一步：确认正式配置" }),
    ).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("应用内部安全密钥"), {
      target: { value: "production-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存正式配置" }));
    expect(
      await screen.findByRole("heading", {
        name: "下一步：填写正式地址",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("域名需要指向这台服务器")).toBeInTheDocument();
    expect(
      screen.getByText(/在域名服务商添加 A 记录，目标填写 203\.0\.113\.10/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制服务器 IP" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("203.0.113.10");
    expect(
      await screen.findByRole("button", { name: "服务器 IP 已复制" }),
    ).toBeInTheDocument();
    expect(screen.getByText("还缺少：后端服务 · ocr")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发布正式版" }),
    ).not.toBeInTheDocument();
  });

  it("turns a Caddy conflict into an explicit address takeover action", async () => {
    const path = "/demo/route-conflict";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "domains: []\n    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
      "domains:\n      - service: api\n        host: example.com\n        path: /\n      - service: admin\n        host: admin.example.com\n        path: /\n      - service: miniapp\n        host: app.other.net\n        path: /\n    secrets_ref: https://cnb.cool/team/project-secrets/-/blob/main/env.production.yml",
    );
    const verified: DeploymentRun = {
      id: "verified-route-candidate",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "100",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "candidate-100",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: [],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const failed: DeploymentRun = {
      ...verified,
      id: "failed-production-route",
      environment: "production",
      status: "needs_action",
      currentStage: "prepare-server",
      sourceRunId: verified.id,
      actionKind: "route-takeover",
      issueCode: "AD-SRV-206",
      message: "example.com 仍在使用旧服务，另外两个地址已经可以访问",
      routeChecks: [
        {
          host: "example.com",
          url: "https://example.com/",
          phase: "route-conflict",
          reachable: false,
          httpStatus: null,
          message: "example.com 仍由旧服务提供",
        },
        {
          host: "admin.example.com",
          url: "https://admin.example.com/",
          phase: "route-missing",
          reachable: false,
          httpStatus: null,
          message: "admin.example.com 已解析，但服务器尚未启用",
        },
        {
          host: "app.other.net",
          url: "https://app.other.net/",
          phase: "ready",
          reachable: true,
          httpStatus: 200,
          message: "app.other.net 可以访问",
        },
      ],
    };
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.scene`,
      "production",
    );
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.verified-run`,
      verified.id,
    );
    const inspection = vi
      .spyOn(api, "inspectServerRouteConflicts")
      .mockResolvedValue({
        conflicts: [{ host: "example.com", source: "main" }],
        takeoverAvailable: true,
      });
    const dnsProvider = vi
      .spyOn(api, "detectDnsProvider")
      .mockImplementation(async (host) =>
        host.endsWith("other.net")
          ? {
              zone: "other.net",
              provider: "阿里云云解析 DNS",
              managementUrl: "https://dns.console.aliyun.com/",
              nameServers: ["dns1.hichina.com"],
            }
          : {
              zone: "example.com",
              provider: "腾讯云 DNSPod",
              managementUrl: "https://console.cloud.tencent.com/cns",
              nameServers: ["cricket.dnspod.net"],
            },
      );

    const view = render(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[failed, verified]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    const takeover = await screen.findByRole("button", {
      name: "接管现有地址",
    });
    expect(
      screen.getByRole("heading", { name: "正式访问地址状态" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在使用旧服务")).toBeInTheDocument();
    expect(screen.getByText("服务器尚未启用")).toBeInTheDocument();
    expect(screen.getAllByText("可以访问")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "先恢复其他地址" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "未冲突的地址可以单独恢复；只有标记为旧服务的地址需要你确认切换。",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(takeover).toBeEnabled());
    fireEvent.click(takeover);
    expect(
      screen.getByRole("heading", { name: "把现有地址切换到新版本？" }),
    ).toBeInTheDocument();
    const takeoverDialog = screen.getByRole("dialog", {
      name: "把现有地址切换到新版本？",
    });
    expect(within(takeoverDialog).getByText("example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "接管并完成发布" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("button", { name: "刷新状态" }),
    ).not.toBeInTheDocument();
    const routePending: DeploymentRun = {
      ...failed,
      status: "needs_action",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      actionKind: "route-check",
      issueCode: "AD-NET-201",
      message: "应用已经部署成功，访问地址暂未就绪：example.com 尚未解析",
      routeChecks: [
        {
          host: "example.com",
          url: "https://example.com/",
          phase: "dns",
          reachable: false,
          httpStatus: null,
          message: "example.com 尚未解析",
        },
        {
          host: "admin.example.com",
          url: "https://admin.example.com/",
          phase: "dns",
          reachable: false,
          httpStatus: null,
          message: "admin.example.com 尚未解析",
        },
        {
          host: "app.other.net",
          url: "https://app.other.net/",
          phase: "ready",
          reachable: true,
          httpStatus: 200,
          message: "app.other.net 的 DNS、HTTPS 和 Caddy 路由均可访问",
        },
      ],
    };
    const routeStatusCheck = vi.spyOn(api, "checkDeploymentRoutes");
    const refreshRoute = vi.fn().mockResolvedValue(routePending);
    const pendingRouteError = vi.fn();
    const pendingRouteView = () => (
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={pendingRouteError}
        onPromote={vi.fn()}
        onRefresh={refreshRoute}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[routePending, verified]}
        saving={false}
        workspace={workspace}
      />
    );
    const intervalSpy = vi.spyOn(window, "setInterval");
    view.rerender(pendingRouteView());
    // 项目恢复时父层会连续补齐任务、版本和配置；即使自动检查定时器
    // 被中途重渲染取消，稳定后的页面仍必须真正执行一次复核。
    view.rerender(pendingRouteView());
    expect(
      screen.getByRole("heading", { name: "正式版已经部署" }),
    ).toBeInTheDocument();
    expect(screen.getByText("还差设置正式地址")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发布或更换版本" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "检查并完成发布" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制记录值" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
        "203.0.113.10",
      ),
    );
    expect(
      screen.getByRole("button", { name: "记录值已复制" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "服务已经启动，不会重复部署。请根据下方每个地址的状态继续处理。",
      ),
    ).toBeInTheDocument();
    const periodicCheck = intervalSpy.mock.calls.find(
      ([, delay]) => delay === 30_000,
    )?.[0];
    expect(periodicCheck).toBeTypeOf("function");
    expect(
      intervalSpy.mock.calls.filter(([, delay]) => delay === 30_000),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "正式访问地址状态" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/主机记录 @ · 类型 A · 记录值 203\.0\.113\.10/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/主机记录 admin · 类型 A · 记录值 203\.0\.113\.10/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("app.other.net 的 DNS、HTTPS 和 Caddy 路由均可访问"),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("DNS 未解析")).toHaveLength(2);
    expect(screen.getByText("可以访问")).toBeInTheDocument();
    expect(screen.queryByText("待添加或生效")).not.toBeInTheDocument();
    expect(routeStatusCheck).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", {
        name: "打开腾讯云 DNSPod · example.com",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "打开阿里云云解析 DNS · other.net",
      }),
    ).toBeInTheDocument();
    expect(dnsProvider).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("本次部署进度")).not.toBeInTheDocument();
    expect(screen.getByText(/任务记录：|最近检查：/)).toBeInTheDocument();
    expect(autoRechecksDeployment(routePending)).toBe(true);
    expect(
      autoRechecksDeployment({
        ...routePending,
        actionKind: "route-takeover",
      }),
    ).toBe(true);
    expect(deploymentRefreshLabel(routePending)).toBe("检查并完成发布");
    expect(deploymentNextStep(routePending)).toBe(
      "设置好域名后点击“检查并完成发布”，不会重新部署服务",
    );
    const interruptedRouteCheck: DeploymentRun = {
      ...routePending,
      issueCode: "AD-NET-202",
      message: "本机网络中断，地址状态没有完成复核",
    };
    expect(deploymentNextStep(interruptedRouteCheck)).toBe(
      "确认本机网络可用后点击“检查并完成发布”；系统只检查地址，不会重新部署",
    );
    const unhealthyService: DeploymentRun = {
      ...routePending,
      actionKind: null,
      issueCode: "AD-CTR-201",
      status: "needs_action",
    };
    expect(deploymentRefreshLabel(unhealthyService)).toBe("检查服务原因");
    expect(deploymentNextStep(unhealthyService)).toBe(
      "点击“检查服务原因”，系统会读取启动日志并给出具体处理建议",
    );
    const unknownBlocker: DeploymentRun = {
      ...routePending,
      actionKind: null,
      currentStage: "healthcheck",
      issueCode: "AD-UNKNOWN-999",
    };
    expect(deploymentRefreshLabel(unknownBlocker)).toBe("重新检查服务");
    expect(deploymentNextStep(unknownBlocker)).toBe(
      "按上面的提示处理后，点击“重新检查服务”",
    );
    await waitFor(() =>
      expect(refreshRoute).toHaveBeenCalledWith(routePending),
    );
    refreshRoute.mockClear();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(refreshRoute).toHaveBeenCalledWith(routePending),
    );
    expect(screen.getByText(/最近检查：/)).toHaveTextContent("地址还未生效");
    refreshRoute.mockClear();
    await act(async () => periodicCheck?.());
    await waitFor(() =>
      expect(refreshRoute).toHaveBeenCalledWith(routePending),
    );
    refreshRoute.mockRejectedValueOnce(new Error("temporary network error"));
    pendingRouteError.mockClear();
    await act(async () => periodicCheck?.());
    expect(
      await screen.findByText(
        "这次检查没有完成，任务仍停在这里；请确认网络后再次点击“检查并完成发布”。",
      ),
    ).toBeInTheDocument();
    expect(pendingRouteError).not.toHaveBeenCalled();
    intervalSpy.mockRestore();

    refreshRoute.mockRejectedValueOnce(new Error("temporary network error"));
    fireEvent.click(screen.getByRole("button", { name: "检查并完成发布" }));
    expect(
      await screen.findByText(
        "这次检查没有完成，任务仍停在这里；请确认网络后再次点击“检查并完成发布”。",
      ),
    ).toBeInTheDocument();
    expect(pendingRouteError).toHaveBeenCalledWith(
      "状态检查没有完成，当前任务和已完成步骤仍然保留",
    );
    expect(screen.getByText(/最近检查：/)).toHaveTextContent("地址还未生效");

    closeReleaseTaskPanel();
    await openVersions();
    const pendingProductionBadge =
      await screen.findByText("正式版已部署，还差地址");
    expect(pendingProductionBadge).toHaveClass("text-[var(--warning)]");
    expect(screen.queryByText("正式环境运行中")).not.toBeInTheDocument();
    const continueProduction = screen.getByRole("button", {
      name: /^继续设置正式地址：/,
    });
    expect(continueProduction).toHaveAccessibleName(/代码 01234567/);
    fireEvent.click(continueProduction);
    expect(
      await screen.findByRole("heading", { name: "正式版已经部署" }),
    ).toBeInTheDocument();

    const genericFailure: DeploymentRun = {
      ...failed,
      id: "failed-production-generic",
      status: "failed",
      currentStage: "deploy",
      actionKind: null,
      issueCode: "AD-DEP-201",
      message: "服务器没有完成部署",
      routeChecks: [],
    };
    const retryProduction = vi.fn().mockResolvedValue(undefined);
    view.rerender(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={retryProduction}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[genericFailure, verified]}
        saving={false}
        workspace={workspace}
      />,
    );
    expectOverviewTopLevelActive();
    expect(screen.queryByText("部署失败")).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "重新发布同一版本" }),
    );
    await waitFor(() =>
      expect(retryProduction).toHaveBeenCalledWith(
        verified,
        expect.objectContaining({ host: "203.0.113.10" }),
      ),
    );
    inspection.mockRestore();
    dnsProvider.mockRestore();
    routeStatusCheck.mockRestore();
  });

  it("offers a certificate-only retry when DNS already points to the server", async () => {
    const path = "/demo/certificate-retry";
    const workspace = await openProject(path);
    const service = workspace.inspection.services.find(
      (item) => item.kind !== "worker",
    );
    expect(service).toBeDefined();
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(
      ["environments", "production", "domains"],
      [
        {
          service: service!.id,
          host: "cert.example.com",
          path: "/",
        },
      ],
    );
    workspace.manifestYaml = document.toString({ lineWidth: 0 });
    const verified = successfulStagingRun(path, {
      id: "certificate-retry-staging",
    });
    const pending: DeploymentRun = {
      ...verified,
      id: "certificate-retry-production",
      environment: "production",
      status: "needs_action",
      currentStage: "healthcheck",
      sourceRunId: verified.id,
      artifacts: [
        {
          service: service!.id,
          image: `registry.example.com/demo/${service!.id}`,
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      actionKind: "route-check",
      issueCode: "AD-NET-201",
      message:
        "cert.example.com 已解析，但 HTTPS 尚未就绪；请稍候让 Caddy 申请证书",
      routeChecks: [
        {
          host: "cert.example.com",
          url: "https://cert.example.com/",
          phase: "https",
          reachable: false,
          httpStatus: null,
          message:
            "cert.example.com 已解析，但 HTTPS 尚未就绪；请稍候让 Caddy 申请证书",
        },
      ],
    };
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.scene`,
      "production",
    );
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.verified-run`,
      verified.id,
    );
    const readyChecks = [
      {
        host: "cert.example.com",
        url: "https://cert.example.com/",
        phase: "ready" as const,
        reachable: true,
        httpStatus: 200,
        message: "cert.example.com 的 DNS、HTTPS 和 Caddy 路由均可访问",
      },
    ];
    const initialPending: DeploymentRun = { ...pending, routeChecks: [] };
    const supplementalCheck = vi.spyOn(api, "checkDeploymentRoutes");
    let finishRetry: ((checks: typeof readyChecks) => void) | undefined;
    const retry = vi
      .spyOn(api, "retryDeploymentCertificates")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          }),
      );
    const onRefresh = vi.fn().mockResolvedValue({
      ...pending,
      routeChecks: readyChecks,
    });
    const intervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const workspaceView = (run: DeploymentRun) => (
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run, verified]}
        saving={false}
        workspace={workspace}
      />
    );
    const view = render(workspaceView(initialPending));

    await openProductionEnvironmentDetails();
    expect(await screen.findByText("正在检查")).toBeInTheDocument();
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(supplementalCheck).not.toHaveBeenCalled();
    onRefresh.mockClear();
    view.rerender(workspaceView(pending));
    expect(await screen.findByText("还差 HTTPS 证书")).toBeInTheDocument();
    expect(screen.getByText("DNS 已生效，等待 HTTPS")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试证书" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(pending.id));
    expect(
      await screen.findByRole("button", { name: "正在重试证书" }),
    ).toBeDisabled();
    const routeIntervalIndex = intervalSpy.mock.calls.findIndex(
      ([, delay]) => delay === 30_000,
    );
    expect(routeIntervalIndex).toBeGreaterThanOrEqual(0);
    const routeInterval = intervalSpy.mock.results[routeIntervalIndex]?.value;
    await waitFor(() =>
      expect(clearIntervalSpy).toHaveBeenCalledWith(routeInterval),
    );
    await act(async () => finishRetry?.(readyChecks));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(pending));
    expect(await screen.findByText("可以访问")).toBeInTheDocument();

    supplementalCheck.mockRestore();
    retry.mockRestore();
    intervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("把已保存的任务更新时间显示成用户能判断的新鲜度", () => {
    expect(
      deploymentUpdatedAtLabel(
        "2026-07-15T10:08:00+08:00",
        new Date("2026-07-15T18:00:00+08:00"),
      ),
    ).toMatch(/^今天 /);
    expect(
      deploymentUpdatedAtLabel(
        "2026-07-14T10:08:00+08:00",
        new Date("2026-07-15T18:00:00+08:00"),
      ),
    ).not.toMatch(/^今天 /);
    expect(deploymentUpdatedAtLabel("not-a-date")).toBe("");
  });

  it("offers a route-only repair when the deployed address is missing from Caddy", async () => {
    const path = "/demo/route-repair";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "domains: []\n    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
      "domains:\n      - service: api\n        host: example.com\n        path: /\n    secrets_ref: https://cnb.cool/team/project-secrets/-/blob/main/env.production.yml",
    );
    const verified: DeploymentRun = {
      id: "verified-route-repair-candidate",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "101",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "candidate-101",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: [],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const repair: DeploymentRun = {
      ...verified,
      id: "production-route-repair",
      environment: "production",
      status: "needs_action",
      currentStage: "prepare-server",
      sourceRunId: verified.id,
      actionKind: "route-repair",
      issueCode: "AD-SRV-209",
      message:
        "应用容器已经部署，但正式地址没有生效：example.com 还没有加载到统一 Caddy",
    };
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.scene`,
      "production",
    );
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.verified-run`,
      verified.id,
    );
    vi.spyOn(api, "inspectServerRouteConflicts").mockResolvedValue({
      conflicts: [],
      takeoverAvailable: false,
    });
    const reapply = vi.spyOn(api, "reapplyDeploymentRoutes").mockResolvedValue({
      provider: "caddy",
      ok: true,
      summary: "正式地址已重新应用",
      details: ["example.com"],
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "测试服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[repair, verified]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    expect(
      await screen.findByRole("heading", { name: "正式版地址没有生效" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新应用地址" }));
    await waitFor(() => expect(reapply).toHaveBeenCalledWith(repair.id));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(repair));
  });

  it("shows the exact failed local action inline and as an operation error", async () => {
    const path = "/demo/local-action-error";
    const workspace = await openProject(path);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "prepared");
    localStorage.setItem(
      "abcdeploy.demo.local-infrastructure-services",
      JSON.stringify({ postgres: false, redis: false }),
    );
    const onError = vi.fn();
    const failure = vi
      .spyOn(api, "setLocalInfrastructureService")
      .mockRejectedValueOnce(new Error("Docker 暂时不可用"));

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={onError}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    const start = await screen.findByRole("button", {
      name: "启动本地数据库",
    });
    fireEvent.click(start);

    const message = "启动本地数据库未完成：Docker 暂时不可用";
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(message);
    failure.mockRestore();
  });

  it("shows that a local service is being built instead of looking frozen", async () => {
    const path = "/demo/local-start-progress";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    let finishStart: ((value: typeof stopped) => void) | undefined;
    const start = vi.spyOn(api, "startLocalPreviewService").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );
    expect(
      await screen.findByText(/正在构建并启动 · 已等待/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "正在启动后端服务" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止本次启动" })).toBeEnabled();

    await act(async () => {
      finishStart?.({
        ...stopped,
        state: "partial",
        services: stopped.services.map((service, index) =>
          index === 0 ? { ...service, running: true } : service,
        ),
      });
    });
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开后端服务" }),
    ).toBeInTheDocument();
    start.mockRestore();
  });

  it("persists only a safe recovery summary when local start fails", async () => {
    const path = "/demo/local-start-safe-history";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    const start = vi
      .spyOn(api, "startLocalPreviewService")
      .mockRejectedValueOnce(
        new Error(
          "AD-LOC-116：本机端口 3000 已被其他程序占用；内部命令 docker compose up",
        ),
      );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );
    expect(
      await screen.findByText(/启动后端服务未完成：本机端口 3000/),
    ).toBeInTheDocument();

    const key = `abcdeploy.setting.project.${encodeURIComponent(path)}.local-last-issue`;
    await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem(key) || "{}") as Record<
      string,
      string
    >;
    expect(stored).toMatchObject({
      code: "AD-LOC-116",
      title: "本机端口已被占用",
    });
    expect(stored.nextStep).toContain("关闭占用提示端口的其他程序");
    expect(JSON.stringify(stored)).not.toContain("docker compose up");
    expect(JSON.stringify(stored)).not.toContain("3000");
    start.mockRestore();
  });

  it("names the failed service and keeps its safe build summary after restart", async () => {
    const path = "/demo/local-build-failure-summary";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    const start = vi
      .spyOn(api, "startLocalPreviewService")
      .mockRejectedValueOnce(
        new Error(
          "AD-LOC-112：后端服务（api）没有构建成功：发现 6 个 TypeScript 编译问题，其中缺少项目模块 @wx-toolbox/ai-router",
        ),
      );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );
    expect(
      await screen.findByText(/后端服务（api）没有构建成功/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "复制给开发工具" }),
    ).toBeInTheDocument();

    const key = `abcdeploy.setting.project.${encodeURIComponent(path)}.local-last-issue`;
    await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem(key) || "{}") as Record<
      string,
      string
    >;
    expect(stored.summary).toContain("6 个 TypeScript 编译问题");
    expect(stored.summary).toContain("@wx-toolbox/ai-router");
    start.mockRestore();
  });

  it("stops an ABCDeploy-managed port owner and continues the same start", async () => {
    const path = "/demo/managed-local-port-conflict";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    const stopped = await api.getLocalPreviewStatus(path);
    const started = {
      ...stopped,
      state: "partial" as const,
      services: stopped.services.map((service, index) =>
        index === 0 ? { ...service, running: true } : service,
      ),
    };
    const start = vi
      .spyOn(api, "startLocalPreviewService")
      .mockRejectedValueOnce(
        new Error("AD-LOC-120：项目 finagent 正在使用本项目需要的 3000 端口"),
      )
      .mockResolvedValueOnce(started);
    const releasePort = vi
      .spyOn(api, "stopManagedLocalPortOwner")
      .mockResolvedValue("finagent");

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "停止 finagent 并继续",
      }),
    );

    await waitFor(() => expect(releasePort).toHaveBeenCalledWith(3000));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    start.mockRestore();
    releasePort.mockRestore();
  });

  it("lets the user stop a local start without leaving an endless loading state", async () => {
    const path = "/demo/local-start-cancel";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    let rejectStart: ((reason: Error) => void) | undefined;
    const start = vi.spyOn(api, "startLocalPreviewService").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject;
        }),
    );
    const cancel = vi
      .spyOn(api, "cancelLocalPreviewStart")
      .mockImplementation(async () => {
        rejectStart?.(
          new Error("AD-LOC-118：本次启动已停止，已经运行的其他服务不会受影响"),
        );
        return true;
      });
    const onError = vi.fn();

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={onError}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "停止本次启动" }),
    );

    expect(cancel).toHaveBeenCalledWith(path);
    expect(await screen.findByText("已停止本次启动")).toBeInTheDocument();
    expect(
      screen.getByText("已经停止这次启动，原来正在运行的其他服务不会受影响。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/AD-LOC-118/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制问题信息" }),
    ).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "正在停止" }),
    ).not.toBeInTheDocument();
    start.mockRestore();
    cancel.mockRestore();
  });

  it("shows a stop operation as stopping instead of rebuilding", async () => {
    const path = "/demo/local-stop-progress";
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "running");
    const workspace = await openProject(path);
    const running = await api.getLocalPreviewStatus(path);
    let finishStop: ((value: typeof running) => void) | undefined;
    const stop = vi.spyOn(api, "stopLocalPreviewService").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStop = resolve;
        }),
    );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "停止后端服务" }),
    );
    expect((await screen.findAllByText("正在停止")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("正在停止，只影响当前选择的项目服务"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/正在构建并启动/)).not.toBeInTheDocument();

    await act(async () => {
      finishStop?.({
        ...running,
        state: "partial",
        services: running.services.map((service, index) =>
          index === 0 ? { ...service, running: false } : service,
        ),
      });
    });
    expect((await screen.findAllByText("未启动")).length).toBeGreaterThan(0);
    stop.mockRestore();
  });

  it("offers development mode only as a local preference", async () => {
    const path = "/demo/hot-reload";
    const workspace = await openProject(path);
    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /开发调试/ }));
    expect(
      (await screen.findAllByText("启动后自动刷新")).length,
    ).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        localStorage.getItem(
          `abcdeploy.setting.project.${encodeURIComponent(path)}.local-run-mode`,
        ),
      ).toBe("development"),
    );
    expect(workspace.manifestYaml).not.toContain("development_mode");
  });

  it("keeps the local milestone lit after a verified project is stopped", async () => {
    const path = "/demo/local-milestone";
    const workspace = await openProject(path);
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "running");

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    const localScene = await openLocal();
    expect(localScene).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(
        localStorage.getItem(
          `abcdeploy.setting.project.${encodeURIComponent(path)}.local-milestone`,
        ),
      ).toBe("success"),
    );
    expect(screen.getByRole("button", { name: "全部停止" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部停止" }));
    await waitFor(() =>
      expect(
        within(projectNavigation()).getByRole("button", {
          name: "在本机运行",
        }),
      ).toBeInTheDocument(),
    );
    expect(screen.getAllByText("上次随全部服务启动成功")).not.toHaveLength(0);
    expect(screen.getAllByText("未启动")).not.toHaveLength(0);
  });

  it("labels an old local failure as history instead of a current outage", async () => {
    const path = "/demo/historical-local-failure";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.local-milestone`,
      "warning",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.local-last-issue`,
      JSON.stringify({
        code: "AD-LOC-112",
        nextStep: "查看关键构建原因，让开发工具修复后重试",
        recordedAt: "2026-07-15T01:00:00.000Z",
        summary: "后端服务（api）没有构建成功：发现 6 个 TypeScript 编译问题",
        title: "项目没有通过容器构建",
      }),
    );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await openLocal()).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("上次启动没有完成")).toBeInTheDocument();
    expect(
      screen.getByText(/上次原因：后端服务（api）没有构建成功/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "复制给开发工具" }),
    ).toBeInTheDocument();
  });

  it("turns an unexplained old failure into a retry that records the result", async () => {
    const path = "/demo/local-failure-without-details";
    const workspace = await openProject(path);
    localStorage.setItem(
      `abcdeploy.setting.project.${encodeURIComponent(path)}.local-milestone`,
      "warning",
    );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText(/上次没有留下可用原因/)).toBeInTheDocument();
    expect(screen.getByText(/点击下方“重新启动并记录原因”/)).toHaveTextContent(
      "如果仍然失败，页面会保留原因和下一步",
    );
    expect(
      screen.queryByRole("button", { name: "一键启动全部" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新启动并记录原因" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "可以逐个重试，也可以一次重新启动全部服务；本轮失败会保留原因。",
      ),
    ).toBeInTheDocument();
  });

  it("clears an old local failure after every service is really running", async () => {
    const path = "/demo/recovered-local-failure";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.demo.local.${path}`, "running");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.local-milestone`,
      "warning",
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.local-last-issue`,
      JSON.stringify({
        code: "AD-LOC-116",
        nextStep: "关闭占用端口的程序后重新启动",
        recordedAt: "2026-07-15T01:00:00.000Z",
        title: "本机端口已被占用",
      }),
    );

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await openLocal()).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(
        localStorage.getItem(
          `abcdeploy.setting.${settingKey}.local-last-issue`,
        ),
      ).toBe(""),
    );
    expect(screen.queryByText("上次启动没有完成")).not.toBeInTheDocument();
  });

  it("removes a stale failure after a later single-service start succeeds", async () => {
    const path = "/demo/recovered-single-local-service";
    const content =
      "DATABASE_URL=postgresql://localhost/demo\nAPP_SECRET=saved\n";
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({ [`${path}:development:runtime-file`]: content }),
    );
    localStorage.setItem(`abcdeploy.demo.local-env.${path}`, content);
    localStorage.setItem("abcdeploy.demo.local-infrastructure", "running");
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    const issueKey = `abcdeploy.setting.${settingKey}.local-last-issue`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.local-milestone`,
      "warning",
    );
    localStorage.setItem(
      issueKey,
      JSON.stringify({
        code: "AD-LOC-112",
        nextStep: "修复项目代码后重新启动",
        recordedAt: "2026-07-15T01:00:00.000Z",
        summary: "后端服务上次没有构建成功",
        title: "项目没有通过容器构建",
      }),
    );
    const stopped = await api.getLocalPreviewStatus(path);
    const start = vi
      .spyOn(api, "startLocalPreviewService")
      .mockResolvedValueOnce({
        ...stopped,
        state: "partial",
        services: stopped.services.map((service, index) =>
          index === 0 ? { ...service, running: true } : service,
        ),
      });

    render(
      <ProductWorkspace
        initialScene="local"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("上次启动没有完成")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "启动后端服务" }),
    );

    expect(await screen.findByText("运行中")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("上次启动没有完成")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(localStorage.getItem(issueKey)).toBe(""));
    expect(
      within(projectNavigation()).getByRole("button", {
        name: "在本机运行",
      }),
    ).toHaveAttribute("aria-current", "page");
    start.mockRestore();
  });

  it("offers a real retry when CNB accepted production without creating a build", async () => {
    const path = "/demo/retry-production";
    const workspace = await openProject(path);
    const staging: DeploymentRun = {
      id: "staging-success",
      projectPath: path,
      projectName: "demo",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "cnb-staging-1",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "candidate-1",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: [],
      startedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const production: DeploymentRun = {
      ...staging,
      id: "production-missing-build",
      environment: "production",
      status: "needs_action",
      currentStage: "prepare",
      buildSerial: null,
      sourceRunId: staging.id,
      issueCode: "AD-CNB-202",
      message: "CNB 没有创建与测试通过版本匹配的生产任务，请重新发布",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      staging.id,
    );
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const connect = vi.spyOn(api, "connectCnb").mockResolvedValue({
      connected: true,
      displayName: "示例用户",
      username: "demo",
      defaultNamespace: "demo",
      namespaces: [],
    });

    const view = render(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "生产服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={onPromote}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    fireEvent.click(
      await screen.findByRole("button", { name: "重新发布同一版本" }),
    );
    await waitFor(() =>
      expect(onPromote).toHaveBeenCalledWith(staging, expect.any(Object)),
    );

    const authorizationProduction = {
      ...production,
      issueCode: "AD-CNB-101",
      message: "CNB 登录已失效，请重新连接后继续",
    };
    view.rerender(
      <ProductWorkspace
        initialServer={{
          host: "203.0.113.10",
          keyPath: "/tmp/id_ed25519",
          name: "生产服务器",
          port: 22,
          user: "ubuntu",
        }}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={onPromote}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[authorizationProduction, staging]}
        saving={false}
        workspace={workspace}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "更新 CNB 授权" }),
    );
    expect(
      await screen.findByRole("heading", { name: "更新 CNB 授权" }),
    ).toBeInTheDocument();
    expect(screen.getByText("触发自动构建")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "复制权限代码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /令牌统一保存在本机系统密钥库，符合使用范围的项目可以复用/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新的访问令牌"), {
      target: { value: "replacement-production-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存授权并继续发布" }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        "replacement-production-token",
        true,
        "demo/project",
      ),
    );
    await waitFor(() =>
      expect(onRefresh).toHaveBeenCalledWith(authorizationProduction),
    );
    expect(onPromote).toHaveBeenCalledTimes(1);
    connect.mockRestore();
  });

  it("separates usable versions from failed deployments and lets production choose independently", async () => {
    const path = "/demo/version-catalog";
    const workspace = await openProject(path);
    const first: DeploymentRun = {
      id: "staging-102",
      projectPath: path,
      projectName: "version-catalog",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "102",
      commitSha: "1023456789abcdef1023456789abcdef10234567",
      sourceTitle: "修复登录并优化首页速度",
      sourceRunId: null,
      candidateTag: "deploydesk-1023456789abcdef1023456789abcdef10234567",
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
      repository: "demo/version-catalog",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
    };
    const second: DeploymentRun = {
      ...first,
      id: "staging-101",
      buildSerial: "101",
      commitSha: "1013456789abcdef1013456789abcdef10134567",
      sourceTitle: "增加导出功能",
      candidateTag: "deploydesk-1013456789abcdef1013456789abcdef10134567",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"2".repeat(64)}`,
        },
      ],
      startedAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    };
    const failedRetry: DeploymentRun = {
      ...first,
      id: "staging-103-retry",
      status: "failed",
      buildSerial: "103",
      commitSha: "1033456789abcdef1033456789abcdef10334567",
      candidateTag: "deploydesk-1033456789abcdef1033456789abcdef10334567",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"3".repeat(64)}`,
        },
      ],
      message: "重复部署没有完成",
      startedAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    const historicalFailure: DeploymentRun = {
      ...failedRetry,
      id: "staging-historical-permission",
      status: "needs_action",
      buildSerial: "",
      commitSha: "",
      candidateTag: "",
      artifacts: [],
      issueCode: "AD-CNB-103",
      message:
        'CNB API 请求失败 (403): 权限不足。原始信息: {"errcode":10023,"errmsg":"Missing required scopes: repo-cnb-trigger:rw"}',
      startedAt: "2026-07-09T09:00:00.000Z",
      updatedAt: "2026-07-09T09:00:00.000Z",
    };
    const unverified: DeploymentRun = {
      ...first,
      id: "staging-100",
      buildSerial: "100",
      commitSha: "1003456789abcdef1003456789abcdef10034567",
      sourceTitle: "旧版未确认",
      candidateTag: "deploydesk-1003456789abcdef1003456789abcdef10034567",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
      startedAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T10:00:00.000Z",
    };
    const production: DeploymentRun = {
      ...first,
      id: "production-102",
      environment: "production",
      sourceRunId: first.id,
      message: "正式环境运行正常",
      startedAt: "2026-07-12T10:30:00.000Z",
      updatedAt: "2026-07-12T10:30:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([first.id, second.id]),
    );
    const onSyncVersions = vi.fn().mockResolvedValue(undefined);
    expect(
      availableVersionRuns([failedRetry, first, second, unverified]),
    ).toEqual([first, second, unverified]);
    expect(isOlderVersion(second, first)).toBe(true);
    expect(isOlderVersion(first, first)).toBe(false);

    function ParentMirroringScene() {
      const [initialScene, setInitialScene] =
        useState<ProjectScene>("versions");
      return (
        <ProductWorkspace
          initialScene={initialScene}
          initialServer={{
            host: "203.0.113.10",
            keyPath: "/tmp/id_ed25519",
            name: "生产服务器",
            port: 22,
            user: "ubuntu",
          }}
          onDeployTest={vi.fn()}
          onError={vi.fn()}
          onPromote={vi.fn()}
          onRefresh={vi.fn()}
          onSaveManifest={vi.fn().mockResolvedValue(true)}
          onSceneChange={setInitialScene}
          onServerChange={vi.fn()}
          onSyncVersions={onSyncVersions}
          path={path}
          runs={[
            failedRetry,
            production,
            first,
            second,
            unverified,
            historicalFailure,
          ]}
          saving={false}
          workspace={workspace}
        />
      );
    }

    render(<ParentMirroringScene />);

    await screen.findByRole("heading", { name: "版本" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "版本记录" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("3 个版本 · 2 个测试通过")).toBeInTheDocument();
    expect(screen.getByText("最新一次部署没有完成")).toBeInTheDocument();
    const historySummary = document.querySelector("summary")!;
    expect(historySummary).toHaveTextContent("1 条历史部署记录");
    expect(historySummary).toHaveTextContent("已被后续部署替代，无需处理");
    expect(historySummary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("修复登录并优化首页速度")).toBeInTheDocument();
    expect(screen.getByText(/7.*12.*代码 10234567/)).toBeInTheDocument();
    expect(screen.getByText(/增加导出功能/)).toBeInTheDocument();
    expect(screen.getByText(/7.*11.*代码 10134567/)).toBeInTheDocument();
    expect(screen.getByText("旧版未确认")).toBeInTheDocument();
    expect(
      screen
        .getAllByText("正式版可以访问")
        .some((element) => element.classList.contains("text-[var(--success)]")),
    ).toBe(true);
    expect(screen.getByText("未完成测试 · 不可发布")).toHaveClass(
      "text-[var(--muted-foreground)]",
    );
    const technicalInfoButtons = screen.getAllByRole("button", {
      name: /^技术信息：/,
    });
    expect(technicalInfoButtons).toHaveLength(3);
    expect(
      new Set(
        technicalInfoButtons.map((button) => button.getAttribute("aria-label")),
      ).size,
    ).toBe(3);
    expect(screen.queryByText(/构建 103/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看处理方法" }));
    expect(
      screen.getByRole("heading", { name: /7.*12.*的部署/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("重复部署没有完成")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "前往部署测试版" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    fireEvent.click(historySummary);
    fireEvent.click(screen.getByRole("button", { name: /^查看记录：/ }));
    expect(screen.getByText("这条记录不需要处理")).toBeInTheDocument();
    expect(
      screen.getByText(
        "后续部署已经接替了这次操作，不会影响当前测试版或正式版。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("查看当时停止的原因")).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
    expect(screen.getByText("未生成")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    await waitFor(() => expect(onSyncVersions).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "刷新版本记录" }));
    await waitFor(() => expect(onSyncVersions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/版本记录已于 .* 更新/)).toBeInTheDocument();

    await openProjectSettings();
    expect(
      screen.getByRole("button", {
        name: /连接代码平台.*已准备/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /准备测试环境.*已准备/,
      }),
    ).toBeInTheDocument();
    await openVersions();

    const restoreButtons = screen.getAllByRole("button", {
      name: /^用此版本恢复正式版：/,
    });
    expect(restoreButtons).toHaveLength(1);
    expect(restoreButtons[0]).toHaveAccessibleName(/增加导出功能.*7.*11/);
    restoreButtons.forEach((button) => expect(button).toHaveClass("border"));
    fireEvent.click(restoreButtons[0]);
    expect(await screen.findByText("准备恢复的版本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更换版本" }));
    expect(
      screen.getByRole("button", { name: /10134567.*已选择/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: /10234567.*当前测试版.*推荐/,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("2 个可发布")).toBeInTheDocument();

    await openVersions();
    expect(
      await screen.findByRole("button", {
        name: /用此版本恢复正式版：增加导出功能/,
      }),
    ).toBeInTheDocument();
    await openProductionEnvironmentDetails();
    const restoringVersion = await screen.findByText("准备恢复的版本");
    expect(restoringVersion.parentElement).toHaveTextContent("增加导出功能");
  });

  it("does not treat the production approval branch as a newer test deployment", async () => {
    const path = "/demo/production-approval-status";
    const workspace = await openProject(path);
    const staging: DeploymentRun = {
      id: "tested-staging",
      projectPath: path,
      projectName: "production-approval-status",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "staging-1",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
      artifacts: [],
      actionKind: "local-preview",
      actionUrl: null,
      issueCode: null,
      repository: "demo/production-approval-status",
      branch: "main",
      message: "测试已通过",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T09:46:00.000Z",
      updatedAt: "2026-07-14T09:55:00.000Z",
    };
    const approval: DeploymentRun = {
      ...staging,
      id: "production-approval",
      status: "cancelled",
      buildSerial: "approval-1",
      actionKind: "production-approval",
      message: "生产审批已完成，此记录不计为测试部署",
      startedAt: "2026-07-14T09:57:00.000Z",
      updatedAt: "2026-07-14T09:58:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([staging.id]),
    );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[approval, staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openOverview();
    expect(
      screen.getByRole("button", {
        name: "测试环境：测试已通过，查看详情",
      }),
    ).toBeInTheDocument();
  });

  it("keeps a successful test deployment pending until the user confirms it", async () => {
    const path = "/demo/unverified-test-version";
    const workspace = await openProject(path);
    const staging: DeploymentRun = {
      id: "unverified-staging",
      projectPath: path,
      projectName: "unverified-test-version",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "201",
      commitSha: "2123456789abcdef2123456789abcdef21234567",
      sourceTitle: "等待业务确认",
      sourceRunId: null,
      candidateTag: "deploydesk-2123456789abcdef2123456789abcdef21234567",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/unverified-test-version",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T09:46:00.000Z",
      updatedAt: "2026-07-14T09:55:00.000Z",
    };

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openOverview();
    const testScene = screen.getByRole("button", {
      name: "测试环境：等待你确认，查看详情",
    });
    expect(testScene).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: "测试环境：测试已通过，查看详情",
      }),
    ).not.toBeInTheDocument();
  });

  it("treats repeat deployments of one immutable version as already verified", async () => {
    const path = "/demo/redeployed-verified-version";
    const workspace = await openProject(path);
    const older: DeploymentRun = {
      id: "older-attempt",
      projectPath: path,
      projectName: "redeployed-verified-version",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "201",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceTitle: "修复登录问题",
      sourceRunId: null,
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
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
      repository: "demo/redeployed-verified-version",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T09:46:00.000Z",
      updatedAt: "2026-07-14T09:55:00.000Z",
    };
    const current: DeploymentRun = {
      ...older,
      id: "current-attempt",
      buildSerial: "202",
      startedAt: "2026-07-15T09:46:00.000Z",
      updatedAt: "2026-07-15T09:55:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([older.id]),
    );
    localStorage.setItem(
      "abcdeploy.demo.runs",
      JSON.stringify([current, older]),
    );

    const firstView = render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[current, older]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "测试版已通过验证" }),
    ).toBeInTheDocument();
    expectOverviewTopLevelActive();
    expect(screen.getByText("测试版正在服务器运行")).toBeInTheDocument();
    expect(screen.getByText("下一步：准备正式版")).toBeInTheDocument();
    expect(
      screen.getByText("发布时会继续使用这个测试版本，不会重新构建。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("你已经确认测试结果")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "测试结果符合你的预期吗？",
      }),
    ).not.toBeInTheDocument();
    const releaseButton = screen.getByRole("button", {
      name: "准备发布正式版",
    });
    expect(releaseButton).toBeInTheDocument();
    fireEvent.click(releaseButton);
    expect(
      await screen.findByRole("button", { name: "← 返回发布中心" }),
    ).toBeInTheDocument();
    expectOverviewTopLevelActive();

    await waitFor(async () =>
      expect(await api.listVersionValidations(path)).toEqual([
        expect.objectContaining({
          state: "passed",
          versionKey: deploymentVersionKey(older),
        }),
      ]),
    );
    firstView.unmount();
    localStorage.removeItem(`abcdeploy.setting.${settingKey}.verified-run`);

    render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[current]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "测试版已通过验证" }),
    ).toBeInTheDocument();
  });

  it("keeps a failed repeat attempt visible without duplicating its immutable version", async () => {
    const path = "/demo/failed-repeat-attempt";
    const workspace = await openProject(path);
    const successful = successfulStagingRun(path, {
      id: "successful-attempt",
      commitSha: "c123456789abcdefc123456789abcdefc1234567",
      sourceTitle: "同一个不可变版本",
      startedAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:05:00.000Z",
    });
    const failed: DeploymentRun = {
      ...successful,
      id: "failed-repeat-attempt",
      status: "failed",
      currentStage: "deploy",
      issueCode: "AD-CTR-201",
      message: "重新部署时服务没有启动",
      completedSteps: ["build"],
      startedAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:05:00.000Z",
    };

    render(
      <ProductWorkspace
        initialScene="versions"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[failed, successful]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText("1 个版本 · 0 个测试通过"),
    ).toBeInTheDocument();
    expect(screen.getByText("最新一次部署没有完成")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看处理方法" }),
    ).toBeInTheDocument();
  });

  it("keeps a rebuilt image pending even when its commit is already verified", async () => {
    const path = "/demo/rebuilt-unverified-version";
    const workspace = await openProject(path);
    const verified: DeploymentRun = {
      id: "verified-build",
      projectPath: path,
      projectName: "rebuilt-unverified-version",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "201",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceTitle: "修复登录问题",
      sourceRunId: null,
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
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
      repository: "demo/rebuilt-unverified-version",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T09:46:00.000Z",
      updatedAt: "2026-07-14T09:55:00.000Z",
    };
    const rebuilt: DeploymentRun = {
      ...verified,
      id: "rebuilt-build",
      buildSerial: "202",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"2".repeat(64)}`,
        },
      ],
      startedAt: "2026-07-15T09:46:00.000Z",
      updatedAt: "2026-07-15T09:55:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([verified.id]),
    );

    render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[rebuilt, verified]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByText("测试版正在正常运行，可以打开并确认功能"),
    ).toBeInTheDocument();
    expect(screen.queryByText("测试版已通过验证")).not.toBeInTheDocument();
    await openVersions();
    expect(screen.getByText("2 个版本 · 1 个测试通过")).toBeInTheDocument();
    await openOverview();
    expect(
      screen.getByRole("button", {
        name: "测试环境：等待你确认，查看详情",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "正式环境：有版本可以发布，查看详情",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看全部版本" }),
    ).toBeInTheDocument();
  });

  it("requires reopening a secure preview before business confirmation", async () => {
    const path = "/demo/secure-preview-verification";
    const workspace = await openProject(path);
    const staging: DeploymentRun = {
      id: "secure-preview-run",
      projectPath: path,
      projectName: "secure-preview-verification",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "preview-1",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
      artifacts: [],
      actionKind: "local-preview",
      actionUrl: null,
      issueCode: null,
      repository: "demo/secure-preview-verification",
      branch: "main",
      message: "测试版正在服务器运行",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:10:00.000Z",
    };
    const onRefresh = vi.fn().mockResolvedValue(staging);
    localStorage.setItem("abcdeploy.demo.runs", JSON.stringify([staging]));

    const view = render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[staging]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "验证测试版" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("测试版仍在服务器运行，可以从这台电脑直接打开确认。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前状态：已经完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/安全通道|开放端口/)).not.toBeInTheDocument();
    expect(screen.getByText("还差一次业务确认")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认测试通过" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(staging));
    expect(await screen.findByText(/最近检查：/)).toHaveTextContent(
      "测试版仍在服务器运行",
    );

    onRefresh.mockRejectedValueOnce(new Error("temporary network error"));
    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    expect(
      await screen.findByText(
        "这次检查没有完成，仍显示上一次部署结果；请确认网络后再次点击“检查运行状态”。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("测试版正在正常运行，可以打开并确认功能"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新打开测试版" }));

    expect(
      await screen.findByRole("heading", {
        name: "测试结果符合你的预期吗？",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认测试通过" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认测试通过" }));
    await waitFor(async () =>
      expect(await api.listVersionValidations(path)).toEqual([
        expect.objectContaining({
          state: "passed",
          versionKey: deploymentVersionKey(staging),
        }),
      ]),
    );
    expect(
      screen.getByText("测试结果已保存，不会因为关闭应用而丢失。"),
    ).toBeInTheDocument();
    view.unmount();
    const verifiedView = render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[staging]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(await screen.findByText("复查测试版")).toBeInTheDocument();
    expect(
      screen.getByText("只会重新打开测试地址，不会重新部署项目。"),
    ).toBeInTheDocument();
    const unhealthy = {
      ...staging,
      status: "needs_action" as const,
      currentStage: "healthcheck",
      issueCode: "AD-CTR-201",
      message: "服务容器 secure-preview-staging-api-1 启动后未通过健康检查",
    };
    verifiedView.rerender(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[unhealthy]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(await screen.findByText("服务没有正常启动")).toBeInTheDocument();
    expect(
      screen.getByText(/secure-preview-staging-api-1/),
    ).toBeInTheDocument();
    expect(screen.queryByText("测试版正在服务器运行")).not.toBeInTheDocument();
  });

  it("requires opening the test version and keeps a rejected result after reopening", async () => {
    const path = "/demo/rejected-test-version";
    const workspace = await openProject(path);
    const staging = successfulStagingRun(path, {
      id: "rejected-test-version",
      artifacts: [
        {
          service: "api",
          image: "registry/demo/api",
          digest: `sha256:${"9".repeat(64)}`,
        },
      ],
    });
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.version-setup-complete`,
      "true",
    );
    localStorage.setItem("abcdeploy.demo.runs", JSON.stringify([staging]));
    vi.mocked(openUrl).mockClear();
    const props = {
      initialServer: {
        host: "203.0.113.10",
        keyPath: "/tmp/id_ed25519",
        name: "测试服务器",
        port: 22,
        user: "ubuntu",
      },
      onDeployTest: vi.fn(),
      onError: vi.fn(),
      onPromote: vi.fn(),
      onRefresh: vi.fn(),
      onSaveManifest: vi.fn().mockResolvedValue(true),
      onServerChange: vi.fn(),
      path,
      runs: [staging],
      saving: false,
      workspace,
    };

    const view = render(<ProductWorkspace {...props} initialScene="test" />);

    const confirm = await screen.findByRole("button", {
      name: "确认测试通过",
    });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试有问题" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "打开测试版" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalled());
    expect(confirm).toBeEnabled();
    expect(screen.getByRole("button", { name: "测试有问题" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "测试有问题" }));
    expect(
      await screen.findByRole("heading", { name: "这个版本暂不发布" }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(await api.listVersionValidations(path)).toEqual([
        expect.objectContaining({
          state: "rejected",
          versionKey: deploymentVersionKey(staging),
        }),
      ]),
    );
    // A stale setting from an older build must not override the durable
    // rejection that was just saved.
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([staging.id]),
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-version`,
      JSON.stringify([deploymentVersionKey(staging)]),
    );

    view.unmount();
    render(<ProductWorkspace {...props} initialScene="overview" />);

    const currentTask = await screen.findByRole("region", {
      name: "当前发布任务",
    });
    expect(
      await within(currentTask).findByText(/暂不发布/),
    ).toBeInTheDocument();
    expect(within(currentTask).getByText("等待代码更新")).toBeInTheDocument();

    await openVersions();
    expect(screen.getByText("测试未通过 · 等待代码更新")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^发布正式版：/ }),
    ).not.toBeInTheDocument();
  });

  it("restores a real production state without relying on this device's test marker", async () => {
    const path = "/demo/cross-device-production";
    const workspace = await openProject(path);
    const staging: DeploymentRun = {
      id: "remote-tested-version",
      projectPath: path,
      projectName: "cross-device-production",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "201",
      commitSha: "2123456789abcdef2123456789abcdef21234567",
      sourceTitle: "修复支付结果页",
      sourceRunId: null,
      candidateTag: "deploydesk-2123456789abcdef2123456789abcdef21234567",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/cross-device-production",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
    };
    const production: DeploymentRun = {
      ...staging,
      id: "remote-production",
      environment: "production",
      sourceRunId: staging.id,
      message: "正式环境运行正常",
      startedAt: "2026-07-13T10:30:00.000Z",
      updatedAt: "2026-07-13T10:30:00.000Z",
    };
    const olderStaging: DeploymentRun = {
      ...staging,
      id: "older-tested-version",
      buildSerial: "200",
      commitSha: "2023456789abcdef2023456789abcdef20234567",
      sourceTitle: "较早的测试版本",
      startedAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([staging.id, olderStaging.id]),
    );
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.selected-version`,
      olderStaging.id,
    );

    const onError = vi.fn();
    const routeIssue: DeploymentRun = {
      ...production,
      status: "needs_action",
      actionKind: "route-check",
      issueCode: "AD-NET-201",
      message: "正式地址暂时无法访问",
      artifacts: [
        {
          service: "api",
          image: "registry.example.com/demo/api",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
    };
    const onRefresh = vi
      .fn()
      .mockResolvedValueOnce(routeIssue)
      .mockResolvedValue(production);
    const currentView = render(
      <ProductWorkspace
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={onError}
        onPromote={vi.fn()}
        onRefresh={onRefresh}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging, olderStaging]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "正式版已上线" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发布或更换版本" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("当前正式版本")).toHaveTextContent(
      "修复支付结果页",
    );
    expect(
      screen.getByText("当前使用测试通过的同一版本，服务运行正常。"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "还没有在这台电脑检查过运行状态 · 页面显示最近一次部署结果",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前状态：已经完成")).not.toBeInTheDocument();
    const healthCheckKey = `abcdeploy.setting.project.${encodeURIComponent(path)}.production-health-check.${production.id}`;
    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(production));
    expect(localStorage.getItem(healthCheckKey)).toBeNull();
    expect(screen.queryByText(/最近检查：/)).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "检查运行状态" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/最近检查：/)).toHaveTextContent(
      "正式版仍可访问",
    );
    expectOverviewTopLevelActive();
    expect(screen.queryByText("还没有测试通过的版本")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(localStorage.getItem(healthCheckKey)).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      ),
    );

    onRefresh.mockRejectedValueOnce(new Error("temporary network error"));
    fireEvent.click(screen.getByRole("button", { name: "检查运行状态" }));
    expect(
      await screen.findByText(
        /这次检查没有完成，仍显示上次可信结果；上次成功检查：今天/,
      ),
    ).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(
      "运行状态检查没有完成，当前页面仍保留上一次可信结果",
    );
    expect(screen.queryByText(/最近检查：/)).not.toBeInTheDocument();

    await openTestEnvironmentDetails();
    expect(
      await screen.findByText("当前版本已完成正式发布"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("正式环境正在使用这个版本，正式地址可以访问。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "准备发布正式版" }),
    ).not.toBeInTheDocument();

    currentView.unmount();
    const pendingProductionView = render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[routeIssue, staging, olderStaging]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(await screen.findByText("正式版还差设置地址")).toBeInTheDocument();
    expect(
      screen.getByText(
        "这个测试通过的版本已经在正式服务器运行，但正式地址还不能访问；继续完成地址设置即可。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前版本已经在线")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "手动部署测试版" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续设置正式地址" }));
    expect(
      await screen.findByRole("heading", { name: "正式版已经部署" }),
    ).toBeInTheDocument();
    pendingProductionView.unmount();

    const otherVersionRouteIssue: DeploymentRun = {
      ...routeIssue,
      id: "older-version-production-route-issue",
      sourceRunId: olderStaging.id,
    };
    const otherVersionPendingView = render(
      <ProductWorkspace
        initialScene="test"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[otherVersionRouteIssue, staging, olderStaging]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(
      await screen.findByText("另一个版本还差设置正式地址"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "另一个测试通过的版本已经在正式服务器运行，但正式地址还不能访问；先完成那次地址设置，再决定是否发布当前版本。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "手动部署测试版" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续设置正式地址" }));
    expect(
      await screen.findByRole("heading", { name: "正式版已经部署" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/较早的测试版本/)).toBeInTheDocument();
    otherVersionPendingView.unmount();

    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    const restoredCurrentView = render(
      <ProductWorkspace
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging, olderStaging]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(
      await screen.findByText(/上次成功检查：今天 .* · 正式版仍可访问/),
    ).toBeInTheDocument();
    restoredCurrentView.unmount();
    render(
      <ProductWorkspace
        initialProductionVersionId={olderStaging.id}
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[production, staging, olderStaging]}
        saving={false}
        workspace={workspace}
      />,
    );
    expect(await screen.findByText("准备恢复的版本")).toBeInTheDocument();
    expect(
      screen.getByText("系统会使用测试通过的历史版本，不会重新构建。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("较早的测试版本", { exact: false }),
    ).toBeInTheDocument();
  });

  it("keeps the online production version separate from a newer failed release", async () => {
    const path = "/demo/production-failure-keeps-online-version";
    const workspace = await openProject(path);
    const onlineVersion: DeploymentRun = {
      id: "staging-online-version",
      projectPath: path,
      projectName: "production-failure-keeps-online-version",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "401",
      commitSha: "a123456789abcdefa123456789abcdefa1234567",
      sourceTitle: "当前稳定版本",
      sourceRunId: null,
      candidateTag: "deploydesk-online",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/production-failure-keeps-online-version",
      branch: "main",
      message: "测试通过",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
    };
    const failedCandidate: DeploymentRun = {
      ...onlineVersion,
      id: "staging-failed-candidate",
      buildSerial: "402",
      commitSha: "b123456789abcdefb123456789abcdefb1234567",
      sourceTitle: "待发布的新版本",
      candidateTag: "deploydesk-candidate",
      startedAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    };
    const onlineProduction: DeploymentRun = {
      ...onlineVersion,
      id: "production-online-version",
      environment: "production",
      sourceRunId: onlineVersion.id,
      message: "正式环境运行正常",
      startedAt: "2026-07-14T11:00:00.000Z",
      updatedAt: "2026-07-14T11:00:00.000Z",
    };
    const failedProduction: DeploymentRun = {
      ...failedCandidate,
      id: "production-failed-candidate",
      environment: "production",
      status: "failed",
      currentStage: "deploy",
      sourceRunId: failedCandidate.id,
      issueCode: "AD-CNB-202",
      message: "新版本发布失败",
      completedSteps: ["prepare"],
      startedAt: "2026-07-15T11:00:00.000Z",
      updatedAt: "2026-07-15T11:00:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([onlineVersion.id, failedCandidate.id]),
    );

    render(
      <ProductWorkspace
        initialProductionVersionId={failedCandidate.id}
        initialScene="production"
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[
          failedProduction,
          failedCandidate,
          onlineProduction,
          onlineVersion,
        ]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByLabelText("当前正式版本")).toHaveTextContent(
      "当前稳定版本",
    );
    expect(screen.getByLabelText("本次发布版本")).toHaveTextContent(
      "待发布的新版本",
    );
  });

  it("makes the final production confirmation explicit and reversible", () => {
    expect(
      productionConfirmationMessage({
        candidateTitle: "优化正式版首页",
        currentTitle: "修复支付结果页",
        restoring: false,
        target: "example.com",
      }),
    ).toBe(
      "正式网站（example.com）将从“修复支付结果页”切换到“优化正式版首页”。这是测试通过的同一版本，不会重新构建；如果目标版本启动失败，系统会自动恢复“修复支付结果页”。",
    );
    expect(
      productionConfirmationMessage({
        candidateTitle: "较早的稳定版本",
        currentTitle: "当前正式版本",
        restoring: true,
        target: "example.com",
      }),
    ).toBe(
      "正式网站（example.com）将从“当前正式版本”恢复到“较早的稳定版本”。这是测试通过的历史版本，不会重新构建；如果目标版本启动失败，系统会自动恢复“当前正式版本”。",
    );
    expect(
      productionConfirmationMessage({
        candidateTitle: "第一个正式版本",
        restoring: false,
      }),
    ).toBe(
      "正式网站将使用“第一个正式版本”。这是测试通过的同一版本，不会重新构建。",
    );
  });

  it("uses time instead of a repeated setup action as the version name", () => {
    const base: DeploymentRun = {
      id: "same-title-current",
      projectPath: "/demo/same-title",
      projectName: "same-title",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "301",
      commitSha: "3123456789abcdef3123456789abcdef31234567",
      sourceTitle: "完成首次上线配置",
      sourceRunId: null,
      candidateTag: "candidate-301",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/same-title",
      branch: "main",
      message: "测试通过",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-15T01:00:00.000Z",
      updatedAt: "2026-07-15T01:00:00.000Z",
    };
    const earlier = {
      ...base,
      id: "same-title-earlier",
      commitSha: "3023456789abcdef3023456789abcdef30234567",
      startedAt: "2026-07-14T01:00:00.000Z",
      updatedAt: "2026-07-14T01:00:00.000Z",
    };

    expect(versionTitle(base)).toMatch(/的版本$/);
    expect(versionTitle(base)).not.toContain("完成首次上线配置");
    expect(versionMeta(base)).toContain("修改说明：完成首次上线配置");
    expect(versionComparisonTitle(base)).toBe(versionTitle(base));
    expect(versionComparisonTitle(earlier)).not.toBe(
      versionComparisonTitle(base),
    );
  });

  it("keeps technical commit text secondary to a readable version name", () => {
    const run: DeploymentRun = {
      id: "technical-source-title",
      projectPath: "/demo/technical-source-title",
      projectName: "technical-source-title",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "302",
      commitSha: "dc1c3456789abcdefdc1c3456789abcdefdc1c345",
      sourceTitle: "harden ABCDeploy staging recovery",
      sourceRunId: null,
      candidateTag: "candidate-302",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/technical-source-title",
      branch: "main",
      message: "测试通过",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T08:36:00.000Z",
      updatedAt: "2026-07-14T08:36:00.000Z",
    };

    expect(versionTitle(run)).toMatch(/的版本$/);
    expect(versionTitle(run)).not.toContain("harden");
    expect(versionMeta(run)).toContain(
      "修改说明：harden ABCDeploy staging recovery",
    );
    expect(versionComparisonTitle(run)).toBe(versionTitle(run));
  });

  it("keeps TCR credentials inside the one-time version setup", async () => {
    const path = "/demo/tcr-setup";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .replace("repository: owner/ecat-energy", "repository: demo/tcr-setup")
      .replace(
        "registry:\n    kind: cnb\n    repository: owner/ecat-energy",
        "registry:\n    kind: tcr\n    registry: ccr.ccs.tencentyun.com\n    namespace: demo",
      );
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      JSON.stringify({
        connected: true,
        displayName: "示例用户",
        username: "demo-user",
        defaultNamespace: "demo",
        namespaces: [],
      }),
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const status = vi
      .spyOn(api, "getSecretStatus")
      .mockImplementation(async (key) => ({ key, stored: false }));
    const replace = vi
      .spyOn(api, "replaceRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: true,
        summary: "镜像仓库登录信息可用",
        details: [],
      });

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    expect(
      await screen.findByRole("button", {
        name: /连接镜像仓库.*现在完成/,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText("项目版本保存位置")).toBeInTheDocument();
    expect(screen.getByText(/腾讯云 TCR ·/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "还没有登录信息？个人版初始化密码，企业版创建长期访问凭证。",
      ),
    ).toBeInTheDocument();
    const openTcr = screen.getByRole("button", {
      name: "前往腾讯云获取凭据",
    });
    fireEvent.click(openTcr);
    expect(openUrl).toHaveBeenCalledWith(
      "https://console.cloud.tencent.com/tcr",
    );
    fireEvent.change(await screen.findByLabelText("登录用户名"), {
      target: { value: "tcr-user" },
    });
    fireEvent.change(screen.getByLabelText("访问密码"), {
      target: { value: "tcr-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并安全保存" }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "ccr.ccs.tencentyun.com",
        "registry.tcr.v2",
        "tcr-user",
        "tcr-password",
      ),
    );
    await waitFor(() =>
      expect(localStorage.getItem("abcdeploy.setting.registry.mode")).toBe(
        "tcr",
      ),
    );
    expect(
      localStorage.getItem("abcdeploy.setting.registry.tcr.namespace"),
    ).toBe("demo");
    expect(
      localStorage.getItem(
        "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      ),
    ).toBe("ccr.ccs.tencentyun.com");
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*已准备/ }),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue("tcr-password")).not.toBeInTheDocument();
    status.mockRestore();
    replace.mockRestore();
  });

  it("does not save or advance when the registry rejects the credentials", async () => {
    const path = "/demo/tcr-invalid-credentials";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .replace("repository: owner/ecat-energy", "repository: demo/tcr-invalid")
      .replace(
        "registry:\n    kind: cnb\n    repository: owner/ecat-energy",
        "registry:\n    kind: tcr\n    registry: ccr.ccs.tencentyun.com\n    namespace: demo",
      );
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      JSON.stringify({
        connected: true,
        displayName: "示例用户",
        username: "demo-user",
        defaultNamespace: "demo",
        namespaces: [],
      }),
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const status = vi
      .spyOn(api, "getSecretStatus")
      .mockImplementation(async (key) => ({ key, stored: false }));
    const replace = vi
      .spyOn(api, "replaceRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: false,
        summary: "镜像仓库没有接受这组登录信息",
        details: [],
        code: "AD-REG-102",
        nextSteps: ["重新获取登录用户名和访问密码后再试"],
        retryable: false,
      });

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接镜像仓库/ }));
    fireEvent.change(await screen.findByLabelText("登录用户名"), {
      target: { value: "wrong-user" },
    });
    fireEvent.change(screen.getByLabelText("访问密码"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并安全保存" }));

    expect(await screen.findByText("登录信息没有通过验证")).toBeInTheDocument();
    expect(
      screen.getByText(/项目版本保存位置没有接受这组登录信息/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/重新获取登录用户名和访问密码/),
    ).toBeInTheDocument();
    expect(screen.getByText("镜像仓库没有接受这组登录信息")).not.toBeVisible();
    expect(screen.getByText(/未通过验证的信息不会保存/)).toBeInTheDocument();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*现在完成/ }),
    ).toBeInTheDocument();
    expect(
      localStorage.getItem(
        "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      ),
    ).toBeNull();

    status.mockRestore();
    replace.mockRestore();
  });

  it("does not expose automatic-deployment actions before the test environment", async () => {
    const path = "/demo/cloud-authorization-action";
    const workspace = await openProject(path);
    configureCnbRepository(workspace, "demo/cloud-authorization-action");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /开启自动部署/ }));
    expect(
      screen.getByRole("button", { name: /开启自动部署.*正在查看/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("代码合并到主分支后，自动生成版本并更新测试版"),
    ).toBeInTheDocument();
    expect(screen.getByText("先完成前面的上线设置")).toBeInTheDocument();
    expect(
      screen.queryByText(/在代码平台网页安全保存/),
    ).not.toBeInTheDocument();
  });

  it("shows one CNB action at a time and returns to the release overview", async () => {
    const path = "/demo/guided-cloud-authorization";
    const workspace = await openProject(path);
    let currentClipboard = "";
    const clipboardWrite = vi.fn(async (value: string) => {
      currentClipboard = value;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn(async () => currentClipboard),
        writeText: clipboardWrite,
      },
    });
    const document = parseDocument(workspace.manifestYaml);
    document.setIn(["source", "repository"], "demo/guided-cloud-authorization");
    document.setIn(
      ["providers", "build", "repository"],
      "demo/guided-cloud-authorization",
    );
    document.setIn(
      ["providers", "registry", "repository"],
      "demo/guided-cloud-authorization",
    );
    document.setIn(
      ["environments", "staging", "domains"],
      [{ service: "api", host: "test.example.com", path: "/" }],
    );
    workspace.manifestYaml = document.toString({ lineWidth: 0 });
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem(
      "abcdeploy.demo.runtime-configs",
      JSON.stringify({
        [`${path}:staging:runtime-file`]:
          "DATABASE_URL=\nAPP_SECRET=saved-for-test\n",
      }),
    );
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    const repositoryAccess = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockResolvedValue({
        provider: "cnb-repository",
        ok: true,
        summary: "代码仓库可用",
        details: [],
      });
    const availableSecretRepository = {
      provider: "cnb-secret-repository",
      ok: true,
      summary: "CNB 安全位置可用",
      details: [],
    };
    let finishRestoredRepositoryCheck: (() => void) | undefined;
    const secretRepositoryAccess = vi
      .spyOn(api, "checkCnbSecretRepositoryAccess")
      .mockResolvedValue(availableSecretRepository)
      .mockResolvedValueOnce(availableSecretRepository)
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            finishRestoredRepositoryCheck = () =>
              resolve(availableSecretRepository);
          }),
      );
    const identity = vi
      .spyOn(api, "preparePipelineIdentity")
      .mockResolvedValue({ created: true, fingerprint: "SHA256:pipeline" });
    const generatedBundle: CnbSecretBundle = {
      environment: "staging",
      filename: "env.demo.staging.yml",
      fileUrl:
        "https://cnb.cool/demo/guided-secrets/-/blob/main/env.demo.staging.yml",
      content: "STAGING_SERVER_HOST: 203.0.113.10\n",
      missingVariables: [],
      deployKeyFingerprint: "SHA256:pipeline",
    };
    let finishBundle: (() => void) | undefined;
    const bundle = vi.spyOn(api, "prepareCnbSecretBundle").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishBundle = () => resolve(generatedBundle);
        }),
    );

    const view = render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(
      await screen.findByRole("button", { name: /开启自动部署/ }),
    );
    await waitFor(() => expect(repositoryAccess).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: /前 3 项已准备/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "打开 CNB 创建保存位置",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "我已经有保存位置",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "我已经创建好了" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("demo/guided-cloud-authorization-secrets"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "我已粘贴并保存" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "打开 CNB 创建保存位置" }),
    );
    expect(
      await screen.findByText(/名称已经复制.*选择“密钥仓库”并创建/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "我已创建，打开配置页面" }),
    );
    expect(await screen.findByText("正在准备下一步")).toBeInTheDocument();
    await act(async () => {
      finishBundle?.();
    });
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
        generatedBundle.filename,
      ),
    );
    expect(openUrl).toHaveBeenCalledWith(
      cnbNewFileUrl("demo/ecat-energy-secrets", generatedBundle.filename),
    );
    expect(
      screen.queryByRole("button", { name: "我已粘贴并保存" }),
    ).not.toBeInTheDocument();
    const copyConfig = screen.getByRole("button", { name: "复制配置内容" });
    expect(copyConfig).toHaveAttribute("data-variant", "default");
    fireEvent.click(copyConfig);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
        generatedBundle.content,
      ),
    );
    expect(
      await screen.findByRole("button", { name: "我已粘贴并保存" }),
    ).toHaveAttribute("data-variant", "default");
    expect(
      screen.getByRole("button", { name: "重新打开网页" }),
    ).toHaveAttribute("data-variant", "secondary");
    expect(
      screen.getByText("第 2 步已完成：配置内容已经复制"),
    ).toBeInTheDocument();

    view.unmount();
    await waitFor(() => expect(clipboardWrite).toHaveBeenLastCalledWith(""));
    expect(currentClipboard).toBe("");
    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /开启自动部署/ }),
    );
    await waitFor(() => expect(bundle).toHaveBeenCalledTimes(2));
    expect(identity).toHaveBeenCalledTimes(1);
    expect(secretRepositoryAccess).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishBundle?.();
    });
    expect(screen.getByText("正在确认安全位置")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制配置内容" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finishRestoredRepositoryCheck?.();
    });
    expect(
      await screen.findByRole("button", {
        name: "还没保存，重新打开网页",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 1 步已完成：网页已经打开")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制配置内容" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "网页已保存，继续" }),
    ).toHaveAttribute("data-variant", "default");
    expect(screen.queryByText("还差在网页保存一次")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "网页已保存，继续" }));
    expect(
      await screen.findByRole("heading", { name: "确认网页已经保存" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/客户端无法读取网页中的配置内容/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已经保存，继续" }));
    await waitFor(() =>
      expect(secretRepositoryAccess).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByRole("heading", { name: "发布中心" }),
    ).toBeInTheDocument();
    expectOverviewTopLevelActive();
    expect(
      screen.queryByText("系统会依次带你完成剩余设置，全部完成后返回发布中心"),
    ).not.toBeInTheDocument();

    repositoryAccess.mockRestore();
    secretRepositoryAccess.mockRestore();
    identity.mockRestore();
    bundle.mockRestore();
  });

  it("lets the user explicitly authorize previously saved TCR credentials", async () => {
    const path = "/demo/tcr-saved-credentials";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "registry:\n    kind: cnb\n    repository: owner/ecat-energy",
      "registry:\n    kind: tcr\n    registry: ccr.ccs.tencentyun.com\n    namespace: finagent",
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const status = vi
      .spyOn(api, "getSecretStatus")
      .mockImplementation(async (key) => ({
        key,
        stored: false,
      }));
    const check = vi
      .spyOn(api, "checkSavedRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: true,
        summary: "镜像仓库登录信息可用",
        details: [],
      });

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接镜像仓库/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "验证已保存登录信息" }),
    );

    await waitFor(() =>
      expect(check).toHaveBeenCalledWith(
        "ccr.ccs.tencentyun.com",
        "registry.tcr.v2",
      ),
    );
    await waitFor(() =>
      expect(localStorage.getItem("abcdeploy.setting.registry.mode")).toBe(
        "tcr",
      ),
    );
    expect(
      localStorage.getItem("abcdeploy.setting.registry.tcr.namespace"),
    ).toBe("finagent");
    expect(
      localStorage.getItem(
        "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      ),
    ).toBe("ccr.ccs.tencentyun.com");
    expect(
      screen.getByRole("button", { name: /连接镜像仓库.*已准备/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /连接代码平台.*现在完成/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /准备测试环境.*随后处理/ }),
    ).toBeInTheDocument();
    status.mockRestore();
    check.mockRestore();
  });

  it("shows recovery progress instead of briefly claiming saved setup is incomplete", async () => {
    const path = "/demo/tcr-startup-check";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .replace(
        "repository: owner/ecat-energy",
        "repository: demo/tcr-startup-check",
      )
      .replace(
        "registry:\n    kind: cnb\n    repository: owner/ecat-energy",
        "registry:\n    kind: tcr\n    registry: ccr.ccs.tencentyun.com\n    namespace: demo",
      );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      "ccr.ccs.tencentyun.com",
    );
    const pendingChecks: Array<
      (value: { key: string; stored: boolean }) => void
    > = [];
    const status = vi.spyOn(api, "getSecretStatus").mockImplementation(
      async (key) =>
        new Promise((resolve) => {
          pendingChecks.push((value) => resolve({ ...value, key }));
        }),
    );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    expect(
      await screen.findByText(/项已准备 · 后台确认中/),
    ).toBeInTheDocument();
    await waitFor(() => expect(pendingChecks).toHaveLength(2));
    await act(async () => {
      for (const resolve of pendingChecks) resolve({ key: "", stored: true });
    });
    await waitFor(() =>
      expect(
        screen.queryByText(/项已准备 · 后台确认中/),
      ).not.toBeInTheDocument(),
    );
    status.mockRestore();
  });

  it("hides test-environment actions while restoring their remote state", async () => {
    const path = "/demo/staging-environment-recovery";
    const workspace = await openProject(path);
    configureCnbRepository(workspace, "demo/staging-environment-recovery");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    let finishConfig: (() => void) | undefined;
    let finishSync: (() => void) | undefined;
    const config = vi.spyOn(api, "loadRuntimeConfig").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishConfig = () =>
            resolve({
              environment: "staging",
              filename: ".env.staging",
              sourceFiles: [".env.example"],
              content: "APP_SECRET=\nDATABASE_URL=\n",
              templateContent: "APP_SECRET=\nDATABASE_URL=\n",
              requiredVariables: ["APP_SECRET", "DATABASE_URL"],
              stored: true,
              authorizationRequired: false,
            });
        }),
    );
    const sync = vi.spyOn(api, "getRuntimeConfigSyncStatus").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishSync = () => resolve({ stored: true, synchronized: true });
        }),
    );

    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(
      await screen.findByRole("button", { name: /准备测试环境/ }),
    );
    expect(
      await screen.findByText("正在恢复已保存的测试环境"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器公网 IP")).not.toBeInTheDocument();
    act(() => {
      finishConfig?.();
    });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    act(() => {
      finishSync?.();
    });
    await waitFor(() =>
      expect(
        screen.queryByText("正在恢复已保存的测试环境"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        "测试版需要一个访问域名，系统会自动配置访问和 HTTPS。",
      ),
    ).not.toBeInTheDocument();

    config.mockRestore();
    sync.mockRestore();
  });

  it("shows a previously verified test environment immediately while rechecking it", async () => {
    const path = "/demo/staging-environment-cached";
    const workspace = await openProject(path);
    configureCnbRepository(workspace, "demo/staging-environment-cached");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    localStorage.setItem(
      `abcdeploy.setting.${runtimeConfigReadyCacheKey(path, "staging", server)}`,
      "true",
    );
    let finishConfig: (() => void) | undefined;
    let finishSync: (() => void) | undefined;
    const config = vi.spyOn(api, "loadRuntimeConfig").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishConfig = () =>
            resolve({
              environment: "staging",
              filename: ".env.staging",
              sourceFiles: [".env.example"],
              content: "APP_SECRET=saved\nDATABASE_URL=\n",
              templateContent: "APP_SECRET=\nDATABASE_URL=\n",
              requiredVariables: ["APP_SECRET", "DATABASE_URL"],
              stored: true,
              authorizationRequired: false,
            });
        }),
    );
    const sync = vi.spyOn(api, "getRuntimeConfigSyncStatus").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishSync = () => resolve({ stored: true, synchronized: true });
        }),
    );

    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /准备测试环境/ }));
    await waitFor(() =>
      expect(
        screen.queryByText("正在恢复已保存的测试环境"),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("ubuntu@203.0.113.10:22", undefined, {
        timeout: 3_000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在读取测试配置")).toBeInTheDocument();
    expect(
      screen.getByText("测试版需要一个访问域名，系统会自动配置访问和 HTTPS。"),
    ).toBeInTheDocument();

    act(() => {
      finishConfig?.();
      finishSync?.();
    });
    await waitFor(() =>
      expect(screen.queryByText("正在读取测试配置")).not.toBeInTheDocument(),
    );
    config.mockRestore();
    sync.mockRestore();
  });

  it("does not reopen saved test configuration when only Keychain reading needs confirmation", async () => {
    const path = "/demo/staging-environment-keychain";
    const workspace = await openProject(path);
    configureCnbRepository(workspace, "demo/staging-environment-keychain");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const server = {
      name: "测试服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    const readyKey = runtimeConfigReadyCacheKey(path, "staging", server);
    localStorage.setItem(`abcdeploy.setting.${readyKey}`, "true");
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "staging",
      filename: ".env.staging",
      sourceFiles: [".env.example"],
      content: "APP_SECRET=\n",
      templateContent: "APP_SECRET=\n",
      requiredVariables: ["APP_SECRET"],
      stored: false,
      authorizationRequired: true,
    });
    vi.spyOn(api, "getRuntimeConfigSyncStatus").mockRejectedValue(
      new Error("需要确认后读取本机钥匙串"),
    );

    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(
      await screen.findByRole("button", { name: /准备测试环境/ }),
    );
    expect(
      await screen.findByText("配置已在运行服务器准备好"),
    ).toBeInTheDocument();
    expect(screen.getByText("可以继续部署")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "读取已保存配置" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(`abcdeploy.setting.${readyKey}`)).toBe("true");
  });

  it("keeps a previously verified production configuration neutral while rechecking it", async () => {
    const path = "/demo/production-environment-cached";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml.replace(
      "domains: []\n    secrets_ref: https://cnb.cool/replace-me/secret/-/blob/main/env.production.yml",
      "domains:\n      - service: api\n        host: app.example.com\n        path: /\n    secrets_ref: https://cnb.cool/team/project-secrets/-/blob/main/env.production.yml",
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    const server = {
      name: "生产服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/server",
      hostFingerprint: "SHA256:server",
    };
    localStorage.setItem(
      `abcdeploy.setting.${runtimeConfigReadyCacheKey(path, "production", server)}`,
      "true",
    );
    const run: DeploymentRun = {
      id: "verified-production-candidate",
      projectPath: path,
      projectName: "production-environment-cached",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "101",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: "candidate-101",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      run.id,
    );
    let finishConfig: (() => void) | undefined;
    let finishSync: (() => void) | undefined;
    const config = vi.spyOn(api, "loadRuntimeConfig").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishConfig = () =>
            resolve({
              environment: "production",
              filename: ".env.production",
              sourceFiles: [".env.example"],
              content: "APP_SECRET=saved\nDATABASE_URL=\n",
              templateContent: "APP_SECRET=\nDATABASE_URL=\n",
              requiredVariables: ["APP_SECRET", "DATABASE_URL"],
              stored: true,
              authorizationRequired: false,
            });
        }),
    );
    const sync = vi.spyOn(api, "getRuntimeConfigSyncStatus").mockImplementation(
      async () =>
        new Promise((resolve) => {
          finishSync = () => resolve({ stored: true, synchronized: true });
        }),
    );

    render(
      <ProductWorkspace
        initialServer={server}
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    expect(
      await screen.findByRole("heading", {
        name: "正在确认正式发布条件",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("正在确认").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("配置内容和自动发布均已准备"),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(config).toHaveBeenCalledTimes(1));
    act(() => {
      finishConfig?.();
    });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    act(() => {
      finishSync?.();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "还需要填写正式地址" }),
      ).toBeInTheDocument(),
    );
    expect(config).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    config.mockRestore();
    sync.mockRestore();
  });

  it("keeps production configuration neutral while its server is restoring", async () => {
    const path = "/demo/production-server-restoring";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    const run: DeploymentRun = {
      id: "verified-before-server-restores",
      projectPath: path,
      projectName: "production-server-restoring",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "102",
      commitSha: "1023456789abcdef1023456789abcdef10234567",
      sourceRunId: null,
      candidateTag: "candidate-102",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/project",
      branch: "main",
      message: "测试版运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "production");
    localStorage.setItem(
      `abcdeploy.setting.${settingKey}.verified-run`,
      JSON.stringify([run.id]),
    );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    await openProductionEnvironmentDetails();
    expect(
      await screen.findByRole("heading", {
        name: "正在确认正式发布条件",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "正式环境服务器" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/选择正式版本实际运行的服务器/),
    ).toBeInTheDocument();
    expect(screen.queryByText("先保存上面的配置")).not.toBeInTheDocument();
    expect(screen.queryByText("等待保存")).not.toBeInTheDocument();
  });

  it("reuses the saved TCR setup after an existing deployment is reset", async () => {
    const path = "/demo/reuse-tcr-setup";
    const workspace = await openProject(path);
    workspace.manifestExists = true;
    workspace.adoption = {
      ...workspace.adoption,
      mode: "fresh",
      freshDraft: true,
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem("abcdeploy.setting.registry.mode", "tcr");
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.namespace",
      "finagent",
    );
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      "ccr.ccs.tencentyun.com",
    );
    const status = vi
      .spyOn(api, "getSecretStatus")
      .mockImplementation(async (key) => ({ key, stored: true }));
    const check = vi
      .spyOn(api, "checkSavedRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: true,
        summary: "镜像仓库登录信息可用",
        details: [],
      });
    const onSaveManifest = vi.fn().mockResolvedValue(true);

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={onSaveManifest}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    await waitFor(() => expect(onSaveManifest).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledWith(
      "ccr.ccs.tencentyun.com",
      "registry.tcr.v2",
    );
    const savedManifest = onSaveManifest.mock.calls[0][0] as string;
    expect(savedManifest).toContain("kind: tcr");
    expect(savedManifest).toContain("registry: ccr.ccs.tencentyun.com");
    expect(savedManifest).toContain("namespace: finagent");
    expect(savedManifest).not.toContain(
      "registry:\n    kind: cnb\n    repository:",
    );
    status.mockRestore();
    check.mockRestore();
  });

  it("checks a saved TCR login before explicitly changing the project version location", async () => {
    const path = "/demo/check-preferred-tcr";
    const workspace = await openProject(path);
    workspace.manifestExists = true;
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem("abcdeploy.setting.registry.mode", "tcr");
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.namespace",
      "finagent",
    );
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      "ccr.ccs.tencentyun.com",
    );
    const check = vi
      .spyOn(api, "checkSavedRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: true,
        summary: "镜像仓库登录信息可用",
        details: [],
      });
    const onSaveManifest = vi.fn().mockResolvedValue(true);

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={onSaveManifest}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接镜像仓库/ }));
    fireEvent.click(await screen.findByRole("button", { name: "检查并使用" }));

    await waitFor(() =>
      expect(check).toHaveBeenCalledWith(
        "ccr.ccs.tencentyun.com",
        "registry.tcr.v2",
      ),
    );
    await waitFor(() => expect(onSaveManifest).toHaveBeenCalledTimes(1));
    expect(onSaveManifest.mock.calls[0][0]).toContain("kind: tcr");
    expect(onSaveManifest.mock.calls[0][0]).toContain("namespace: finagent");
    check.mockRestore();
  });

  it("keeps the current version location when the saved TCR login no longer works", async () => {
    const path = "/demo/rejected-preferred-tcr";
    const workspace = await openProject(path);
    workspace.manifestExists = true;
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    localStorage.setItem("abcdeploy.setting.registry.mode", "tcr");
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.namespace",
      "finagent",
    );
    localStorage.setItem(
      "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      "ccr.ccs.tencentyun.com",
    );
    const check = vi
      .spyOn(api, "checkSavedRegistryCredentials")
      .mockResolvedValue({
        provider: "registry",
        ok: false,
        summary: "镜像仓库没有接受这组登录信息",
        details: [],
        nextSteps: ["重新获取登录用户名和访问密码后再试"],
        retryable: false,
      });
    const onSaveManifest = vi.fn().mockResolvedValue(true);

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={onSaveManifest}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接镜像仓库/ }));
    fireEvent.click(await screen.findByRole("button", { name: "检查并使用" }));

    const warning = await screen.findByText("登录信息没有通过验证");
    expect(warning.closest('[role="alert"]')).toHaveTextContent(
      "原来的项目版本保存位置没有改变",
    );
    expect(screen.getByText("镜像仓库没有接受这组登录信息")).not.toBeVisible();
    expect(onSaveManifest).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(
        "abcdeploy.setting.registry.tcr.v2.verified-endpoint",
      ),
    ).toBe("");
    check.mockRestore();
  });

  it("automatically reuses the only verified server for a new project", async () => {
    const path = "/demo/reuse-only-server";
    const workspace = await openProject(path);
    configureCnbRepository(workspace, "demo/reuse-only-server");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const server: ServerResource = {
      id: "saved-server",
      name: "默认服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/verified-server",
      keyPathExists: true,
      hostFingerprint: "SHA256:verified",
      lastCheckedAt: "2026-07-14T00:00:00.000Z",
    };
    const list = vi.spyOn(api, "listServers").mockResolvedValue([server]);
    const check = vi.spyOn(api, "checkServer").mockResolvedValue({
      provider: "ssh",
      ok: true,
      summary: "服务器连接正常",
      details: [],
    });
    const bind = vi.spyOn(api, "bindProjectServer").mockResolvedValue(server);
    const onServerChange = vi.fn();

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={onServerChange}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(
      await screen.findByRole("button", { name: /准备测试环境/ }),
    );
    await waitFor(() => expect(onServerChange).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledWith(serverFormFromResource(server));
    expect(bind).toHaveBeenCalledWith(
      path,
      "staging",
      serverFormFromResource(server),
    );
    expect(
      await screen.findByText("已准备 2 项 · 还差 2 项"),
    ).toBeInTheDocument();
    list.mockRestore();
    check.mockRestore();
    bind.mockRestore();
  });

  it("keeps a trusted test environment complete until its background review finishes", () => {
    expect(testEnvironmentDisplayReady(false, true, true, true)).toBe(true);
    expect(testEnvironmentDisplayReady(false, false, true, false)).toBe(true);
    expect(testEnvironmentDisplayReady(false, false, true, true)).toBe(false);
    expect(testEnvironmentDisplayReady(false, true, false, false)).toBe(false);
    expect(testEnvironmentDisplayReady(true, false, false, true)).toBe(true);
  });

  it("does not briefly claim production configuration still needs saving while checking it", () => {
    expect(productionConfigStatus(null, false)).toBe("正在确认");
    expect(productionConfigStatus(true, null)).toBe("正在确认");
    expect(productionConfigStatus(false, false)).toBe("未完成");
    expect(productionConfigStatus(true, false)).toBe("等待网页保存");
    expect(productionConfigStatus(true, true)).toBe("已准备");
    expect(productionConfigDetail(null, false)).toBe(
      "正在核对已经保存的正式配置",
    );
    expect(productionConfigDetail(true, null)).toBe(
      "正在核对已经保存的正式配置",
    );
    expect(productionConfigDetail(false, false)).toBe(
      "保存后继续完成网页安全配置",
    );
    expect(productionConfigDetail(true, false)).toBe(
      "配置内容已齐全，运行服务器已准备",
    );
    expect(productionConfigDetail(true, true)).toBe(
      "配置内容和自动发布均已准备",
    );
  });

  it("turns internal deployment stages into four understandable milestones", () => {
    const run: DeploymentRun = {
      id: "milestone-run",
      projectPath: "/demo/milestones",
      projectName: "milestones",
      environment: "staging",
      status: "running",
      currentStage: "prepare-server",
      buildSerial: "88",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/milestones",
      branch: "main",
      message: "正在准备服务器",
      completedSteps: ["write-config", "verify-build", "publish-images"],
      startedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };

    expect(deploymentMilestones(run)).toEqual([
      { label: "准备项目", state: "done" },
      { label: "生成版本", state: "done" },
      { label: "启动服务", state: "active" },
      { label: "确认可用", state: "pending" },
    ]);

    expect(
      deploymentMilestones({
        ...run,
        currentStage: "verify-release",
        completedSteps: [
          "write-config",
          "verify-build",
          "publish-images",
          "prepare-server",
          "deploy",
        ],
      }),
    ).toEqual([
      { label: "准备项目", state: "done" },
      { label: "生成版本", state: "done" },
      { label: "启动服务", state: "done" },
      { label: "确认可用", state: "active" },
    ]);
    expect(
      deploymentStateMessage({
        ...run,
        environment: "production",
        status: "success",
        message: "生产环境已按测试通过的同一镜像摘要发布",
      }),
    ).toBe("正式版正在使用测试通过的同一版本，访问地址正常");
    expect(
      deploymentMilestones({ ...run, environment: "production" })[1],
    ).toEqual({ label: "确认版本", state: "done" });
    expect(
      deploymentMilestones({
        ...run,
        actionKind: "route-takeover",
        environment: "production",
        status: "needs_action",
        completedSteps: [
          "write-config",
          "verify-build",
          "publish-images",
          "prepare-server",
          "deploy",
        ],
      }),
    ).toEqual([
      { label: "准备项目", state: "done" },
      { label: "确认版本", state: "done" },
      { label: "启动服务", state: "done" },
      { label: "确认正式地址", state: "active" },
    ]);
  });

  it("does not silently reuse a same-name CNB repository", async () => {
    const path = "/demo/repository-collision";
    const workspace = await openProject(path);
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      JSON.stringify({
        connected: true,
        displayName: "示例用户",
        username: "demo-user",
        defaultNamespace: "demo",
        namespaces: [],
      }),
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const ensureRepository = vi
      .spyOn(api, "ensureCnbRepository")
      .mockResolvedValue({
        repository: "demo/repository-collision",
        created: false,
      });
    const onSaveManifest = vi.fn().mockResolvedValue(true);

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={onSaveManifest}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(
      await screen.findByRole("button", { name: "创建代码仓库" }),
    );

    expect(await screen.findByText("发现同名代码仓库")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认复用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建新仓库" }),
    ).toBeInTheDocument();
    expect(onSaveManifest).not.toHaveBeenCalled();
    ensureRepository.mockRestore();
  });

  it("keeps a CNB repository incomplete when build history access is missing", async () => {
    const path = "/demo/repository-permission";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .split("repository: owner/ecat-energy")
      .join("repository: demo/repository-permission");
    localStorage.setItem(
      "abcdeploy.demo.cnb-account",
      JSON.stringify({
        connected: true,
        displayName: "示例用户",
        username: "demo-user",
        defaultNamespace: "demo",
        namespaces: [],
      }),
    );
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const checkAccess = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockRejectedValue(
        new Error(
          "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）",
        ),
      );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接代码平台/ }));
    expect(
      await screen.findByText("当前令牌不能读取这个仓库的构建记录"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: /连接代码平台.*现在完成/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "更新授权" }),
    ).toBeInTheDocument();
    expect(checkAccess).toHaveBeenCalledWith("demo/repository-permission");
    checkAccess.mockRestore();
  });

  it("keeps the newly connected CNB account when the repository capability check fails", async () => {
    const path = "/demo/repository-new-token-capability";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .split("repository: owner/ecat-energy")
      .join("repository: demo/repository-new-token-capability");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    let finishInitialRepositoryCheck:
      ((value: ProviderCheck) => void) | undefined;
    const checkAccess = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            finishInitialRepositoryCheck = resolve;
          }),
      );
    const connect = vi.spyOn(api, "connectCnb").mockResolvedValue({
      connected: true,
      displayName: "刚刚连接的账号",
      username: "new-user",
      defaultNamespace: "demo",
      namespaces: [],
    });
    const onError = vi.fn();

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={onError}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接代码平台/ }));
    expect(await screen.findByText("正在检查代码仓库")).toBeInTheDocument();
    await act(async () => {
      finishInitialRepositoryCheck?.({
        provider: "cnb-repository",
        ok: true,
        summary: "CNB 仓库可用",
        details: [],
      });
    });
    const readyRepositoryStep = await screen.findByRole("button", {
      name: /连接代码平台.*已准备/,
    });
    fireEvent.click(readyRepositoryStep);
    checkAccess.mockRejectedValueOnce(
      new Error(
        "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "更新授权" }));
    fireEvent.change(screen.getByLabelText("访问令牌"), {
      target: { value: "new-account-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证账号并连接" }));

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        "new-account-token",
        true,
        "demo/repository-new-token-capability",
      ),
    );
    expect(
      await screen.findByText("CNB 账号：刚刚连接的账号"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("新令牌已保存，但 CNB 仍拒绝读取当前仓库"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "连接 CNB" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      await screen.findByRole("button", {
        name: /连接代码平台.*现在完成/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "连接 CNB" }),
    ).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
    connect.mockRestore();
    checkAccess.mockRestore();
  });

  it("keeps a saved repository usable without loading account details", async () => {
    const path = "/demo/repository-account-recovery";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .split("repository: owner/ecat-energy")
      .join("repository: demo/repository-account-recovery");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const account = vi.spyOn(api, "getCnbAccount");
    const checkAccess = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockRejectedValue(
        new Error(
          "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）",
        ),
      );

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接代码平台/ }));
    expect(screen.getByText("CNB 代码仓库")).toBeInTheDocument();
    expect(
      screen.getByText("demo/repository-account-recovery"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "授权统一保存在本机；只有使用范围包含此仓库时才能复用。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("还没有连接 CNB 账号")).not.toBeInTheDocument();
    expect(screen.queryByText("推荐创建")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建代码仓库" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "更新授权" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新授权" }));
    expect(
      screen.getByRole("heading", { name: "连接 CNB" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("还没有访问令牌？创建后回到这里粘贴。"),
    ).toBeInTheDocument();
    const createToken = screen.getByRole("button", {
      name: "前往 CNB 创建令牌",
    });
    expect(createToken).toBeInTheDocument();
    fireEvent.click(createToken);
    expect(openUrl).toHaveBeenCalledWith(
      "https://cnb.cool/profile/token/create",
    );
    expect(
      screen.getByText("授权范围：在创建令牌页面勾选这 6 项"),
    ).toBeInTheDocument();
    expect(screen.getByText("读写项目代码")).toBeInTheDocument();
    expect(screen.getByText("读取构建详情")).toBeInTheDocument();
    expect(screen.getByText("触发自动构建")).toBeInTheDocument();
    expect(
      screen.getByText(/CNB 令牌需要同时设置“授权范围”和“使用范围”/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog", { name: "连接 CNB" })).getByText(
        "demo/repository-account-recovery",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制权限代码" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        [
          "repo-code:rw",
          "repo-cnb-history:r",
          "repo-cnb-detail:r",
          "repo-manage:rw",
          "repo-cnb-trigger:rw",
          "group-resource:rw",
        ].join("\n"),
      ),
    );
    expect(
      screen.getByRole("button", { name: "权限代码已复制" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "更新授权" }));
    expect(
      screen.getByRole("button", { name: "复制权限代码" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("访问令牌")).toBeInTheDocument();
    expect(account).not.toHaveBeenCalled();
    expect(checkAccess).toHaveBeenCalledWith(
      "demo/repository-account-recovery",
    );
    account.mockRestore();
    checkAccess.mockRestore();
  });

  it("does not block an existing repository while saved account details load", async () => {
    const path = "/demo/repository-account-loading";
    const workspace = await openProject(path);
    workspace.manifestYaml = workspace.manifestYaml
      .split("repository: owner/ecat-energy")
      .join("repository: demo/repository-account-loading");
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const account = vi.spyOn(api, "getCnbAccount");

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        path={path}
        runs={[]}
        saving={false}
        workspace={workspace}
      />,
    );

    await beginFirstVersionSetup();
    fireEvent.click(screen.getByRole("button", { name: /连接代码平台/ }));
    expect(
      screen.getByText("demo/repository-account-loading"),
    ).toBeInTheDocument();
    expect(screen.queryByText("还没有连接 CNB 账号")).not.toBeInTheDocument();

    expect(screen.getByText("CNB 代码仓库")).toBeInTheDocument();
    expect(account).not.toHaveBeenCalled();
    account.mockRestore();
  });

  it("offers recovery instead of spinning forever while saved account details load", async () => {
    const path = "/demo/repository-account-slow";
    const workspace = await openProject(path);
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");
    const account = vi
      .spyOn(api, "getCnbAccount")
      .mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      render(
        <ProductWorkspace
          onDeployTest={vi.fn()}
          onError={vi.fn()}
          onPromote={vi.fn()}
          onRefresh={vi.fn()}
          onSaveManifest={vi.fn().mockResolvedValue(true)}
          onServerChange={vi.fn()}
          path={path}
          runs={[]}
          saving={false}
          workspace={workspace}
        />,
      );

      await beginFirstVersionSetup();
      expect(screen.getByText("正在读取已保存的 CNB 授权")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(
        screen.getByText("读取已保存的代码平台账号用时较长"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("不用一直等待，可以重试；仍未恢复时再重新连接账号。"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "重试读取" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "重新连接" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("正在读取已保存的 CNB 授权"),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      account.mockRestore();
    }
  });

  it("keeps a version-sync permission failure inline without raw CNB data", async () => {
    const path = "/demo/version-sync-permission";
    const workspace = await openProject(path);
    const run: DeploymentRun = {
      id: "staging-sync",
      projectPath: path,
      projectName: "version-sync",
      environment: "staging",
      status: "success",
      currentStage: "complete",
      buildSerial: "103",
      commitSha: "1033456789abcdef1033456789abcdef10334567",
      sourceRunId: null,
      candidateTag: "deploydesk-1033456789abcdef1033456789abcdef10334567",
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/version-sync",
      branch: "main",
      message: "测试环境运行正常",
      completedSteps: ["healthcheck"],
      startedAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
    };
    const settingKey = `project.${encodeURIComponent(path)}`;
    localStorage.setItem(`abcdeploy.setting.${settingKey}.scene`, "versions");

    render(
      <ProductWorkspace
        onDeployTest={vi.fn()}
        onError={vi.fn()}
        onPromote={vi.fn()}
        onRefresh={vi.fn()}
        onSaveManifest={vi.fn().mockResolvedValue(true)}
        onServerChange={vi.fn()}
        onSyncVersions={vi
          .fn()
          .mockRejectedValue(
            new Error("AD-CNB-103：当前 CNB 令牌缺少读取构建历史权限"),
          )}
        path={path}
        runs={[run]}
        saving={false}
        workspace={workspace}
      />,
    );

    expect(await screen.findByText("暂时无法刷新版本记录")).toBeInTheDocument();
    expect(screen.getByText("项目设置需要更新")).toBeInTheDocument();
    expect(
      screen.queryByText("main 自动部署测试已启用"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("代码平台授权还不完整，已经完成的部署步骤仍然保留。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("当前 CNB 令牌缺少读取构建历史权限"),
    ).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "更新 CNB 授权" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/版本记录已于 .* 更新/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看技术详情"));
    expect(screen.getByText("当前 CNB 令牌缺少读取构建历史权限")).toBeVisible();
    expect(
      screen.queryByText(/errmsg|Missing required scopes/),
    ).not.toBeInTheDocument();
  });
});

describe("DNS guidance", () => {
  it("offers certificate retry only when every failed route is waiting for HTTPS", () => {
    const httpsPending = {
      host: "cert.example.com",
      url: "https://cert.example.com/",
      phase: "https" as const,
      reachable: false,
      httpStatus: null,
      message: "HTTPS 尚未就绪",
    };
    const dnsPending = {
      ...httpsPending,
      host: "dns.example.com",
      url: "https://dns.example.com/",
      phase: "dns" as const,
      message: "尚未解析",
    };
    const ready = {
      ...httpsPending,
      host: "ready.example.com",
      url: "https://ready.example.com/",
      phase: "ready" as const,
      reachable: true,
      httpStatus: 200,
      message: "可以访问",
    };

    expect(certificateOnlyRouteFailure([httpsPending, ready])).toBe(true);
    expect(certificateOnlyRouteFailure([httpsPending, dnsPending])).toBe(false);
    expect(
      certificateOnlyRouteFailure([
        httpsPending,
        { ...dnsPending, phase: "tcp" },
      ]),
    ).toBe(false);
    expect(certificateOnlyRouteFailure([ready])).toBe(false);
  });

  it("distinguishes DNS, HTTPS certificate, and ready route states", () => {
    expect(
      publicRouteStatusPresentation(
        {
          host: "missing.example.com",
          url: "https://missing.example.com/",
          phase: "dns",
          reachable: false,
          httpStatus: null,
          message: "尚未解析",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "DNS 未解析" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "cert.example.com",
          url: "https://cert.example.com/",
          phase: "https",
          reachable: false,
          httpStatus: null,
          message: "HTTPS 尚未就绪",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "DNS 已生效，等待 HTTPS" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "ready.example.com",
          url: "https://ready.example.com/",
          phase: "ready",
          reachable: true,
          httpStatus: 200,
          message: "可以访问",
        },
        false,
      ),
    ).toEqual({ state: "success", status: "可以访问" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "closed.example.com",
          url: "https://closed.example.com/",
          phase: "tcp",
          reachable: false,
          httpStatus: null,
          message: "443 端口连接失败",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "TCP/443 不可达" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "unknown.example.com",
          url: "https://unknown.example.com/",
          phase: "check",
          reachable: false,
          httpStatus: null,
          message: "检查没有完成",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "检查中断" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "legacy.example.com",
          url: "https://legacy.example.com/",
          phase: "route-conflict",
          reachable: false,
          httpStatus: null,
          message: "仍由旧服务提供",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "正在使用旧服务" });
    expect(
      publicRouteStatusPresentation(
        {
          host: "inactive.example.com",
          url: "https://inactive.example.com/",
          phase: "route-missing",
          reachable: false,
          httpStatus: null,
          message: "服务器尚未启用",
        },
        false,
      ),
    ).toEqual({ state: "warning", status: "服务器尚未启用" });
  });

  it("uses the matching record type for IPv4 and IPv6 servers", () => {
    expect(dnsRecordTypeForTarget("203.0.113.10")).toBe("A");
    expect(dnsRecordTypeForTarget("2001:db8::10")).toBe("AAAA");
    expect(dnsRecordTypeForTarget()).toBe("A");
  });

  it("never presents a full domain as the DNS host record while detection is unresolved", () => {
    expect(dnsHostRecordLabel("fresh.finagent.cloud", [], true)).toBe(
      "正在识别主机记录",
    );
    expect(dnsHostRecordLabel("fresh.finagent.cloud", [], false)).toBe(
      "主机记录暂未识别，请以域名平台显示为准",
    );
    expect(
      dnsHostRecordLabel(
        "fresh.finagent.cloud",
        [
          {
            zone: "finagent.cloud",
            provider: "腾讯云 DNSPod",
            managementUrl: "https://console.cloud.tencent.com/cns",
            nameServers: ["cricket.dnspod.net"],
          },
        ],
        false,
      ),
    ).toBe("主机记录 fresh");
  });
});
