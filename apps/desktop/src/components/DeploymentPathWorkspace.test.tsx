import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { saveDeploymentPath } from "../api";
import type { DeploymentRun, WorkspacePreview } from "../types";
import { DeploymentPathWorkspace } from "./DeploymentPathWorkspace";

const workspace: WorkspacePreview = {
  inspection: {
    project_root: "/demo/sample",
    project_name: "sample",
    package_manager: "pnpm",
    monorepo: false,
    frameworks: [],
    services: [
      {
        id: "web",
        package_name: "网页服务",
        path: ".",
        kind: "web",
        framework: "vite",
        dockerfile: "Dockerfile",
        suggested_port: 3000,
        build_command: "pnpm build",
        start_command: "pnpm start",
        dependency_file: "package.json",
        confidence: 1,
      },
    ],
    prisma_schemas: [],
    dockerfiles: ["Dockerfile"],
    environment_files: [".env.example"],
    environment_variables: [],
    diagnostics: [],
  },
  manifestYaml: `version: 1
project:
  name: sample
source:
  provider: cnb
  repository: demo/sample
  release_branch: main
providers:
  build:
    kind: cnb
    repository: demo/sample
  registry:
    kind: tcr
    registry: ccr.ccs.tencentyun.com
    namespace: demo
environments:
  staging:
    domains: []
  production:
    domains: []
`,
  validation: { valid: true, issues: [] },
  plan: {
    id: "plan-1",
    project: "sample",
    generated_at: "2026-07-18T00:00:00Z",
    environments: [],
    changes: [],
    steps: [],
    user_actions: [],
    warnings: [],
  },
  manifestExists: true,
  adoption: {
    mode: "fresh",
    detected: false,
    repository: "demo/sample",
    pipelineExists: false,
    historyImportAfter: null,
    freshDraft: false,
  },
};

function renderWorkspace(
  autoCreateDefault = true,
  runs: DeploymentRun[] = [],
  onDeploy = vi.fn(),
) {
  return render(
    <DeploymentPathWorkspace
      autoCreateDefault={autoCreateDefault}
      onDeploy={onDeploy}
      onError={vi.fn()}
      onRefresh={vi.fn()}
      onRunUpdated={vi.fn()}
      onSaveManifest={vi.fn(async () => true)}
      path="/demo/sample"
      runs={runs}
      workspace={workspace}
    />,
  );
}

describe("DeploymentPathWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("添加新项目后自动生成一条从本地到服务器的固定线路", async () => {
    renderWorkspace();
    expect(
      await screen.findByRole("heading", { name: "部署线路" }),
    ).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "本地项目" });
    expect(within(dialog).getByText("项目已经识别")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(
      await screen.findByRole("button", { name: "上线" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /本地项目：已就绪/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /构建服务：待配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本仓库：待配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /运行服务器：待配置/ }),
    ).toBeInTheDocument();
  });

  it("创建线路后只展开最近的节点，并保留四个独立可维护节点", async () => {
    renderWorkspace();
    expect(
      await screen.findByRole("dialog", { name: "本地项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "上线" })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /本地项目：已就绪/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /构建服务：待配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本仓库：待配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /运行服务器：待配置/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /连接构建服务/ }),
    ).toBeInTheDocument();
  });

  it("允许为同一项目新增独立线路而不引入测试版或正式版导航", async () => {
    renderWorkspace();
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "本地项目" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "新增线路" }));
    expect(
      await screen.findByRole("dialog", { name: "本地项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(
      await screen.findByRole("button", { name: "上线 2" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("测试版")).not.toBeInTheDocument();
    expect(screen.queryByText("正式版")).not.toBeInTheDocument();
    expect(screen.queryByText("发布中心")).not.toBeInTheDocument();
  });

  it("地址冲突时把任务停在服务器节点并提供明确的接管动作", async () => {
    await saveDeploymentPath({
      id: "path-online",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "app.example.com",
      routes: [{ service: "web", host: "app.example.com", path: "/" }],
      state: "needs_action",
      lastRunId: "run-route-conflict",
      lastSuccessfulRevision: null,
    });
    const run: DeploymentRun = {
      id: "run-route-conflict",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "needs_action",
      currentStage: "server",
      buildSerial: "1001",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceTitle: "当前本地项目",
      sourceRunId: null,
      candidateTag: "deploydesk-01234567",
      artifacts: [
        {
          service: "web",
          image: "registry.example.com/demo/web",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      actionKind: "deployment-path-route-takeover",
      actionUrl: null,
      issueCode: "AD-SRV-206",
      repository: "demo/sample",
      branch: "main",
      message: "访问地址仍由服务器原配置使用",
      completedSteps: ["build", "registry"],
      startedAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:01:00Z",
    };

    renderWorkspace(false, [run]);
    fireEvent.click(
      await screen.findByRole("button", { name: "处理访问地址" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "运行服务器" });
    expect(
      within(dialog).getByText("访问地址正在由服务器原配置使用"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "确认接管并继续上线" }),
    ).toBeInTheDocument();
  });

  it("本地临时任务失效后只要求重新读取项目，不让用户重配部署线路", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue([
      {
        id: "source",
        kind: "source",
        provider: "cnb",
        name: "CNB",
        status: "ready",
        lastCheckedAt: "2026-07-18T00:00:00Z",
        capabilities: [],
        metadata: {},
      },
      {
        id: "registry",
        kind: "registry",
        provider: "tcr",
        name: "TCR",
        status: "ready",
        lastCheckedAt: "2026-07-18T00:00:00Z",
        capabilities: [],
        metadata: {
          endpoint: "ccr.ccs.tencentyun.com",
          namespace: "demo",
        },
      },
    ]);
    vi.spyOn(api, "listServers").mockResolvedValue([
      {
        id: "server",
        name: "运行服务器",
        host: "203.0.113.10",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
        keyPathExists: true,
        hostFingerprint: "SHA256:server",
        lastCheckedAt: "2026-07-18T00:00:00Z",
      },
    ]);
    await saveDeploymentPath({
      id: "path-restart",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: "source",
      registryConnectionId: "registry",
      serverId: "server",
      configProfileIds: [],
      address: "sample-web.203-0-113-10.sslip.io",
      routes: [
        {
          service: "web",
          host: "sample-web.203-0-113-10.sslip.io",
          path: "/",
        },
      ],
      state: "needs_action",
      lastRunId: "run-missing-local-state",
      lastSuccessfulRevision: null,
    });
    const run: DeploymentRun = {
      id: "run-missing-local-state",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "needs_action",
      currentStage: "local",
      buildSerial: null,
      commitSha: null,
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: "deployment-path-source-retry",
      actionUrl: null,
      issueCode: "AD-GIT-102",
      repository: "demo/sample",
      branch: "main",
      message: "这次上线缺少本地项目快照，请重新开始上线",
      completedSteps: [],
      startedAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:01:00Z",
    };
    const onDeploy = vi.fn().mockResolvedValue({
      ...run,
      id: "run-restarted",
      status: "queued",
      currentStage: "prepare",
      message: "正在重新读取当前项目",
    });

    renderWorkspace(false, [run], onDeploy);

    expect(
      await screen.findByText("只需重新读取你电脑里的当前项目"),
    ).toBeInTheDocument();
    expect(screen.getByText(/都不需要重新设置/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续上线" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重新读取项目并上线" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新读取项目并上线" }));

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));
    expect(onDeploy).toHaveBeenCalledWith(
      "path-restart",
      null,
      expect.objectContaining({ host: "203.0.113.10" }),
      "demo/sample",
      true,
    );
  });

  it("服务器初始化失败后继续最新任务，不再误跳回旧的本地错误", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue([
      {
        id: "source",
        kind: "source",
        provider: "cnb",
        name: "CNB",
        status: "ready",
        lastCheckedAt: "2026-07-18T00:00:00Z",
        capabilities: [],
        metadata: {},
      },
      {
        id: "registry",
        kind: "registry",
        provider: "tcr",
        name: "TCR",
        status: "ready",
        lastCheckedAt: "2026-07-18T00:00:00Z",
        capabilities: [],
        metadata: {
          endpoint: "ccr.ccs.tencentyun.com",
          namespace: "demo",
        },
      },
    ]);
    vi.spyOn(api, "listServers").mockResolvedValue([
      {
        id: "server",
        name: "运行服务器",
        host: "203.0.113.10",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
        keyPathExists: true,
        hostFingerprint: "SHA256:server",
        lastCheckedAt: "2026-07-18T00:00:00Z",
      },
    ]);
    await saveDeploymentPath({
      id: "path-server-bootstrap",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: "source",
      registryConnectionId: "registry",
      serverId: "server",
      configProfileIds: [],
      address: "sample-web.203-0-113-10.sslip.io",
      routes: [
        {
          service: "web",
          host: "sample-web.203-0-113-10.sslip.io",
          path: "/",
        },
      ],
      state: "needs_action",
      lastRunId: "run-stale-source-error",
      lastSuccessfulRevision: null,
    });
    const staleRun: DeploymentRun = {
      id: "run-stale-source-error",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "needs_action",
      currentStage: "server",
      buildSerial: null,
      commitSha: null,
      sourceTitle: "当前本地项目",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: "deployment-path-retry",
      actionUrl: null,
      issueCode: "AD-GIT-102",
      repository: "demo/sample",
      branch: "main",
      message: "运行服务器的新配置已经验证",
      completedSteps: [],
      startedAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:01:00Z",
    };
    const latestRun: DeploymentRun = {
      ...staleRun,
      id: "run-server-bootstrap",
      currentStage: "prepare-server",
      actionKind: "deployment-path-preparation-retry",
      issueCode: "AD-SRV-101",
      message: "服务器尚未安装 Docker，系统会自动初始化后继续",
      startedAt: "2026-07-18T00:02:00Z",
      updatedAt: "2026-07-18T00:03:00Z",
    };
    vi.spyOn(api, "listDeploymentPathRuns").mockResolvedValue([
      latestRun,
      staleRun,
    ]);
    const onDeploy = vi.fn().mockResolvedValue(latestRun);

    renderWorkspace(false, [staleRun, latestRun], onDeploy);

    expect(
      await screen.findByRole("button", { name: "初始化服务器并继续" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("只需重新读取你电脑里的当前项目"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "初始化服务器并继续" }));

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));
    expect(onDeploy).toHaveBeenCalledWith(
      "path-server-bootstrap",
      "run-server-bootstrap",
      expect.objectContaining({ host: "203.0.113.10" }),
      "demo/sample",
      true,
    );
  });

  it("新服务器只要求一次密码并在后台生成专用密钥", async () => {
    const serverResource = {
      id: "server",
      name: "运行服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
      keyPathExists: true,
      hostFingerprint: "SHA256:server",
      lastCheckedAt: "2026-07-18T00:00:00Z",
    };
    vi.spyOn(api, "listServers").mockResolvedValue([serverResource]);
    const generate = vi.spyOn(api, "generateSshIdentity").mockResolvedValue({
      identity: {
        name: "abcdeploy_ed25519",
        path: "/Users/demo/.ssh/abcdeploy_ed25519",
        source: "ABCDeploy 专用身份",
        fingerprint: "SHA256:local",
        managed: true,
      },
      publicKey: "ssh-ed25519 demo abcdeploy",
      created: true,
    });
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
    const bind = vi
      .spyOn(api, "bindProjectServer")
      .mockResolvedValue(serverResource);

    renderWorkspace();
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "本地项目" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /运行服务器：待配置/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "运行服务器" });

    expect(
      within(dialog).queryByLabelText("SSH 私钥文件"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "选择文件" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/服务器登录密码/),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("服务器地址"), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "检查服务器" }));

    expect(
      await within(dialog).findByText("确认连接这台服务器"),
    ).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      within(dialog).getByRole("button", { name: "确认并连接服务器" }),
    ).toBeEnabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "确认并连接服务器" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "请先输入这台服务器的登录密码",
    );
    expect(install).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/服务器登录密码/), {
      target: { value: "one-time-password" },
    });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "确认并连接服务器" }),
    );

    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "203.0.113.10",
        keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
        hostFingerprint: "SHA256:server",
      }),
      "one-time-password",
    );
    expect(await within(dialog).findByText("服务器已连接")).toBeInTheDocument();
    expect(
      within(dialog).getByText("下一步：填写项目访问地址"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/服务器登录密码/),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/访问地址（已自动生成）/)).toHaveValue(
      "sample-web.203-0-113-10.sslip.io",
    );
    expect(
      within(dialog).getByRole("button", { name: "使用这个地址并继续" }),
    ).toBeEnabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "使用这个地址并继续" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "运行服务器" }),
      ).not.toBeInTheDocument(),
    );
  });
});
