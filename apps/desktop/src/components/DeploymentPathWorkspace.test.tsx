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

// The workspace tests exercise deployment-path state and node-panel behavior.
// FlowGram owns canvas geometry and observes real element sizes, which jsdom
// cannot provide. Keep that dependency behind this small contract fake here;
// the canvas integration has its own focused test.
vi.mock("./DeploymentWorkflowCanvas", () => ({
  DeploymentWorkflowCanvas: ({
    nodes,
    onSelectNode,
  }: {
    nodes: Array<{
      id: "local" | "build" | "registry" | "server";
      statusLabel: string;
      summary: string;
      title: string;
    }>;
    onSelectNode: (node: "local" | "build" | "registry" | "server") => void;
  }) => (
    <section aria-label="部署工作流画布">
      {nodes.map((node) => (
        <button
          aria-label={`${node.title}：${node.statusLabel}，${node.summary}`}
          key={node.id}
          onClick={() => onSelectNode(node.id)}
          type="button"
        >
          {node.title}
        </button>
      ))}
    </section>
  ),
}));

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
  workspacePreview = workspace,
  onSaveManifest = vi.fn(async () => true),
) {
  return render(
    <DeploymentPathWorkspace
      autoCreateDefault={autoCreateDefault}
      onDeploy={onDeploy}
      onError={vi.fn()}
      onRefresh={vi.fn()}
      onRunUpdated={vi.fn()}
      onSaveManifest={onSaveManifest}
      path="/demo/sample"
      runs={runs}
      workspace={workspacePreview}
    />,
  );
}

describe("DeploymentPathWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("在线路设置中确认删除最后一条线路后回到空状态", async () => {
    await saveDeploymentPath({
      id: "path-only",
      projectPath: "/demo/sample",
      name: "唯一线路",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
      state: "draft",
      lastRunId: null,
      lastSuccessfulRevision: null,
    });

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "修改线路名称" }),
    );
    const settings = await screen.findByRole("dialog", { name: "线路设置" });
    expect(
      within(settings).getByText(/删除后无法恢复.*不会删除配置中心里的连接/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(settings).getByRole("button", { name: "删除这条线路" }),
    );

    const confirmation = await screen.findByRole("dialog", {
      name: "确认删除线路",
    });
    expect(
      within(confirmation).getByText(/确定删除“唯一线路”吗？此操作无法撤销/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "确认删除线路" }),
    );

    expect(
      await screen.findByRole("heading", { name: "创建第一条上线线路" }),
    ).toBeInTheDocument();
    await expect(api.listDeploymentPaths("/demo/sample")).resolves.toEqual([]);
  });

  it("正式运行记录展示真实关键事实并折叠完整技术信息", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const commitSha = "fedcba9876543210fedcba9876543210fedcba98";
    vi.spyOn(api, "listServers").mockResolvedValue([
      {
        id: "server-current",
        name: "当前生产机",
        host: "203.0.113.20",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
        keyPathExists: true,
        lastCheckedAt: "2026-07-19T00:00:00Z",
      },
    ]);
    await saveDeploymentPath({
      id: "path-history",
      projectPath: "/demo/sample",
      name: "生产线路",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: "server-current",
      configProfileIds: [],
      address: "current.example.com",
      routes: [{ service: "web", host: "current.example.com", path: "/" }],
      state: "online",
      lastRunId: "run-history",
      lastSuccessfulRevision: commitSha,
    });
    const run: DeploymentRun = {
      id: "run-history",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "success",
      currentStage: "verify-release",
      buildSerial: "2048",
      commitSha,
      sourceTitle: "验收版本",
      sourceRunId: null,
      candidateTag: "deploydesk-fedcba98",
      artifacts: [
        {
          service: "web",
          image: "registry.example.com/demo/web:2048",
          digest,
        },
      ],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/sample",
      branch: "main",
      message: "版本已经上线",
      completedSteps: ["build", "registry", "deploy"],
      routeChecks: [
        {
          host: "release.example.com",
          url: "https://release.example.com",
          phase: "ready",
          reachable: true,
          httpStatus: 200,
          message: "访问正常",
        },
      ],
      startedAt: "2026-07-19T02:03:04Z",
      updatedAt: "2026-07-19T02:05:00Z",
    };
    vi.spyOn(api, "listDeploymentPathRuns").mockResolvedValue([run]);

    renderWorkspace(false, [run]);
    fireEvent.click(
      await screen.findByRole("button", { name: "查看运行记录" }),
    );
    const history = await screen.findByRole("dialog", { name: "运行记录" });

    expect(within(history).getByText("线路名")).toBeInTheDocument();
    expect(within(history).getByText("生产线路")).toBeInTheDocument();
    expect(within(history).getByText("开始时间")).toBeInTheDocument();
    expect(within(history).getByText("上线成功")).toBeInTheDocument();
    expect(within(history).getByText("检查服务可用性")).toBeInTheDocument();
    expect(within(history).getByText("当前线路服务器")).toBeInTheDocument();
    expect(
      within(history).getByText("当前生产机 · 203.0.113.20"),
    ).toBeInTheDocument();
    expect(
      within(history).getByText("https://release.example.com"),
    ).toBeInTheDocument();
    expect(
      within(history).queryByText("当前线路访问地址"),
    ).not.toBeInTheDocument();

    const technicalDetails = within(history)
      .getByText("技术信息")
      .closest("details");
    expect(technicalDetails).not.toHaveAttribute("open");
    fireEvent.click(within(history).getByText("技术信息"));
    expect(within(history).getByText("内部阶段")).toBeInTheDocument();
    expect(within(history).getByText("verify-release")).toBeInTheDocument();
    expect(within(history).getByText(commitSha)).toBeInTheDocument();
    expect(within(history).getByText("2048")).toBeInTheDocument();
    expect(within(history).getByText("web")).toBeInTheDocument();
    expect(
      within(history).getByText("registry.example.com/demo/web:2048"),
    ).toBeInTheDocument();
    expect(within(history).getByText(digest)).toBeInTheDocument();
  });

  it("服务器连接按密钥是否存在显示事实状态", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([
      {
        id: "server-key-ready",
        name: "密钥正常服务器",
        host: "203.0.113.30",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/ready",
        keyPathExists: true,
        lastCheckedAt: "2026-07-19T00:00:00Z",
      },
      {
        id: "server-key-missing",
        name: "密钥丢失服务器",
        host: "203.0.113.31",
        user: "ubuntu",
        port: 22,
        keyPath: "/Users/demo/.ssh/missing",
        keyPathExists: false,
        lastCheckedAt: "2026-07-19T00:00:00Z",
      },
    ]);
    await saveDeploymentPath({
      id: "path-server-status",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
      state: "draft",
      lastRunId: null,
      lastSuccessfulRevision: null,
    });

    renderWorkspace(false);
    fireEvent.click(await screen.findByRole("button", { name: "连接" }));

    expect(screen.getByText("密钥已保存")).toHaveClass("text-emerald-600");
    expect(screen.getByText("密钥缺失")).toHaveClass("text-amber-600");
  });

  it("添加新项目后自动生成一条从本地到服务器的固定线路", async () => {
    renderWorkspace();
    expect(await screen.findByText("部署工作流")).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "版本构建" });
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(
      await screen.findByRole("button", { name: /^上线\s+尚未配置$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /代码来源：项目可用/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本构建：需要连接构建服务/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本存储：需要连接版本仓库/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /部署运行：需要连接运行服务器/ }),
    ).toBeInTheDocument();
  });

  it("创建线路后只展开最近的节点，并保留四个独立可维护节点", async () => {
    renderWorkspace();
    expect(
      await screen.findByRole("dialog", { name: "版本构建" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^上线\s+尚未配置$/ }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /代码来源：项目可用/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本构建：需要连接构建服务/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本存储：需要连接版本仓库/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /部署运行：需要连接运行服务器/ }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /连接构建服务/ }),
    ).not.toHaveLength(0);
  });

  it("上线中按真实任务阶段展示已完成、当前和后续节点", async () => {
    await saveDeploymentPath({
      id: "path-running-build",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
      state: "deploying",
      lastRunId: "run-running-build",
      lastSuccessfulRevision: null,
    });
    const run: DeploymentRun = {
      id: "run-running-build",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "running",
      currentStage: "build",
      buildSerial: "1001",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: null,
      actionUrl: null,
      issueCode: null,
      repository: "demo/sample",
      branch: "main",
      message: "构建服务正在生成可运行版本",
      completedSteps: ["snapshot-source", "sync-source"],
      startedAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:01:00Z",
    };

    renderWorkspace(false, [run]);

    expect(
      await screen.findByRole("button", { name: /代码来源：本阶段已完成/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /版本构建：正在构建版本.*构建服务正在生成可运行版本/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本存储：等待保存版本/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /部署运行：等待部署服务/ }),
    ).toBeInTheDocument();
  });

  it("Escape 关闭节点 Inspector 并把焦点还给节点", async () => {
    renderWorkspace();
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "版本构建" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    const localNode = screen.getByRole("button", {
      name: /代码来源：项目可用/,
    });
    localNode.focus();
    fireEvent.click(localNode);
    expect(
      await screen.findByRole("dialog", { name: "代码来源" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "代码来源" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(localNode).toHaveFocus());
  });

  it("已复用构建账号但仓库仍是占位值时只要求补代码仓库", async () => {
    const placeholderWorkspace: WorkspacePreview = {
      ...workspace,
      manifestYaml: workspace.manifestYaml
        .split("demo/sample")
        .join("owner/sample"),
    };
    vi.spyOn(api, "listConnections").mockResolvedValue([
      {
        id: "source-ready",
        kind: "source",
        provider: "cnb",
        name: "CNB 构建服务",
        status: "ready",
        lastCheckedAt: "2026-07-19T00:00:00Z",
        capabilities: [],
        metadata: {},
      },
      {
        id: "registry-ready",
        kind: "registry",
        provider: "tcr",
        name: "腾讯云 TCR",
        status: "ready",
        lastCheckedAt: "2026-07-19T00:00:00Z",
        capabilities: [],
        metadata: {
          endpoint: "ccr.ccs.tencentyun.com",
          namespace: "demo",
        },
      },
    ]);
    const repositoryAccess = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockResolvedValue({
        provider: "cnb-repository",
        ok: true,
        summary: "代码仓库可用",
        details: [],
      });
    const onSaveManifest = vi.fn(async () => true);

    renderWorkspace(true, [], vi.fn(), placeholderWorkspace, onSaveManifest);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "版本构建" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );

    expect(
      await screen.findByRole("button", {
        name: /版本构建：需要设置代码仓库.*还差代码仓库/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /设置代码仓库/ }),
    ).not.toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", {
        name: /版本构建：需要设置代码仓库.*还差代码仓库/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "版本构建" });

    expect(within(dialog).getByText("设置项目代码仓库")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/不需要再次输入访问令牌/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("访问令牌")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("构建服务已连接"),
    ).not.toBeInTheDocument();
    const repositoryInput = within(dialog).getByLabelText("项目代码仓库");
    expect(repositoryInput).toHaveValue("owner/sample");
    fireEvent.change(repositoryInput, {
      target: { value: "team/customer-portal" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "验证并保存代码仓库" }),
    );

    await waitFor(() =>
      expect(repositoryAccess).toHaveBeenCalledWith("team/customer-portal"),
    );
    expect(onSaveManifest).toHaveBeenCalledWith(
      expect.stringContaining("repository: team/customer-portal"),
    );
    expect(
      await screen.findByRole("dialog", { name: "部署运行" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "版本存储" }),
    ).not.toBeInTheDocument();
  });

  it("允许为同一项目新增独立线路而不引入测试版或正式版导航", async () => {
    renderWorkspace();
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "版本构建" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "新增线路" }));
    expect(
      await screen.findByRole("dialog", { name: "版本构建" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(
      await screen.findByRole("button", { name: /^上线 2\s+尚未配置$/ }),
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
    const dialog = await screen.findByRole("dialog", { name: "部署运行" });
    expect(
      within(dialog).getByText("访问地址正在由服务器原配置使用"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "确认接管并继续上线" }),
    ).toBeInTheDocument();
  });

  it("公网地址不可用时直接引导更换地址且不重新部署容器", async () => {
    await saveDeploymentPath({
      id: "path-route-check",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: null,
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
      lastRunId: "run-route-check",
      lastSuccessfulRevision: null,
    });
    const run: DeploymentRun = {
      id: "run-route-check",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "needs_action",
      currentStage: "server",
      buildSerial: "1002",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceTitle: "当前本地项目",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [
        {
          service: "web",
          image: "registry.example.com/demo/web",
          digest: `sha256:${"b".repeat(64)}`,
        },
      ],
      actionKind: "deployment-path-route-check",
      actionUrl: null,
      issueCode: "AD-NET-201",
      repository: "demo/sample",
      branch: "main",
      message: "运行服务已经启动，访问地址还未就绪：临时地址被云厂商拦截",
      completedSteps: ["build", "registry"],
      startedAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:01:00Z",
    };
    const prepared = {
      ...run,
      issueCode: null,
      actionKind: "deployment-path-retry",
      message: "访问地址的新配置已经验证，点击“继续上线”后从这里继续",
    };
    const prepareRetry = vi
      .spyOn(api, "prepareDeploymentPathRetry")
      .mockResolvedValue(prepared);

    renderWorkspace(false, [run]);

    expect(
      await screen.findByRole("button", {
        name: /部署运行：服务部署受阻.*运行服务已经启动/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "处理访问地址" }));
    const repairDialog = await screen.findByRole("dialog", {
      name: "部署运行",
    });
    expect(
      within(repairDialog).getByRole("button", { name: "更换访问地址" }),
    ).toBeInTheDocument();
    expect(
      within(repairDialog).getByRole("button", {
        name: "重新检查当前地址",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(repairDialog).getByRole("button", { name: "更换访问地址" }),
    );
    const addressInput = within(repairDialog).getByLabelText("访问地址");
    fireEvent.change(addressInput, {
      target: { value: "crm.example.com" },
    });
    fireEvent.click(
      within(repairDialog).getByRole("button", { name: "保存访问地址" }),
    );

    await waitFor(() =>
      expect(prepareRetry).toHaveBeenCalledWith("run-route-check", "routes"),
    );
    await waitFor(async () => {
      const [savedPath] = await api.listDeploymentPaths("/demo/sample");
      expect(savedPath.routes).toEqual([
        { service: "web", host: "crm.example.com", path: "/" },
      ]);
      expect(savedPath.address).toBe("crm.example.com");
      expect(savedPath.lastRunId).toBe("run-route-check");
    });
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
      await screen.findByRole("button", { name: /版本构建：等待构建版本/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /版本存储：等待保存版本/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: /部署运行：等待部署服务.*等待前一步完成/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续上线" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重新读取并上线" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新读取并上线" }));

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
      await screen.findByRole("button", { name: "初始化并继续" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("只需重新读取你电脑里的当前项目"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "初始化并继续" }));

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));
    expect(onDeploy).toHaveBeenCalledWith(
      "path-server-bootstrap",
      "run-server-bootstrap",
      expect.objectContaining({ host: "203.0.113.10" }),
      "demo/sample",
      true,
    );
  });

  it("已就绪版本仓库只显示摘要，更换和新增配置互斥展示", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue([
      {
        id: "source-ready",
        kind: "source",
        provider: "cnb",
        name: "CNB 构建服务",
        status: "ready",
        lastCheckedAt: "2026-07-19T00:00:00Z",
        capabilities: [],
        metadata: {},
      },
      {
        id: "registry-ready",
        kind: "registry",
        provider: "tcr",
        name: "腾讯云 TCR",
        status: "ready",
        lastCheckedAt: "2026-07-19T00:00:00Z",
        capabilities: [],
        metadata: {
          endpoint: "ccr.ccs.tencentyun.com",
          namespace: "demo",
        },
      },
    ]);

    renderWorkspace();
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "部署运行" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /版本存储：版本仓库可用/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "版本存储" });

    expect(within(dialog).getByText("版本仓库已连接")).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("版本仓库地址"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("版本记录")).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "更换版本仓库" }),
    );
    expect(
      within(dialog).getByText("选择配置中心已有连接"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("版本仓库地址"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "添加新的版本仓库" }),
    );
    expect(within(dialog).getByLabelText("版本仓库地址")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("版本仓库已连接"),
    ).not.toBeInTheDocument();
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
      within(await screen.findByRole("dialog", { name: "版本构建" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /部署运行：需要连接运行服务器/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "部署运行" });

    expect(
      within(dialog).queryByLabelText("SSH 私钥文件"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "选择文件" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/服务器登录密码/),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("服务器地址"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "添加新的服务器" }),
    );
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
    expect(await within(dialog).findByText("项目访问地址")).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/服务器登录密码/),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("访问地址")).toHaveValue(
      "sample-web.203-0-113-10.sslip.io",
    );
    expect(
      within(dialog).getByRole("button", { name: "保存访问地址" }),
    ).toBeEnabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存访问地址" }),
    );
    expect(await within(dialog).findByText("运行配置")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("访问地址")).not.toBeInTheDocument();
  });

  it("访问地址已准备且不需要运行配置时立即点亮服务器节点", async () => {
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-address-refresh",
      filename: ".env.path-path-address-refresh",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
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
      id: "path-address-refresh",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: "source",
      registryConnectionId: "registry",
      serverId: "server",
      configProfileIds: [],
      address: "sample-web.203-0-113-10.sslip.io",
      routes: [],
      state: "draft",
      lastRunId: null,
      lastSuccessfulRevision: null,
    });

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /部署运行：需要设置访问地址/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "部署运行" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存访问地址" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "部署运行" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /部署运行：运行服务器可用/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始上线" })).toBeEnabled();
  });
});
