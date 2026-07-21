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
import type {
  ConnectionResource,
  DeploymentPath,
  DeploymentRun,
  ServerResource,
  WorkspacePreview,
} from "../types";
import { DeploymentPathWorkspace } from "./DeploymentPathWorkspace";

// The workspace tests exercise deployment-path state and node-panel behavior.
// FlowGram owns canvas geometry and observes real element sizes, which jsdom
// cannot provide. Keep that dependency behind this small contract fake here;
// the canvas integration has its own focused test.
vi.mock("./DeploymentWorkflowCanvas", () => ({
  DeploymentWorkflowCanvas: ({
    initialNodePositions,
    nodes,
    onNodePositionsChange,
    onSelectNode,
  }: {
    initialNodePositions?: Record<
      "local" | "build" | "registry" | "server",
      { x: number; y: number }
    >;
    nodes: Array<{
      id: "local" | "build" | "registry" | "server";
      provider?: string;
      statusLabel: string;
      summary: string;
      title: string;
    }>;
    onNodePositionsChange?: (
      positions: Record<
        "local" | "build" | "registry" | "server",
        { x: number; y: number }
      >,
    ) => void;
    onSelectNode: (node: "local" | "build" | "registry" | "server") => void;
  }) => (
    <section
      aria-label="部署工作流画布"
      data-local-x={initialNodePositions?.local.x}
      data-server-y={initialNodePositions?.server.y}
    >
      {nodes.map((node) => (
        <button
          aria-label={`${node.title}：${node.statusLabel}，${node.summary}`}
          data-provider={node.provider}
          key={node.id}
          onClick={() => onSelectNode(node.id)}
          type="button"
        >
          {node.title}
        </button>
      ))}
      <button
        aria-label="模拟移动画布节点"
        onClick={() =>
          onNodePositionsChange?.({
            local: { x: 100, y: 120 },
            build: { x: 430, y: 120 },
            registry: { x: 760, y: 120 },
            server: { x: 1090, y: 120 },
          })
        }
        type="button"
      >
        移动画布节点
      </button>
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

async function savePathFixture(
  id: string,
  name: string,
  state: DeploymentPath["state"] = "draft",
) {
  await saveDeploymentPath({
    id,
    projectPath: "/demo/sample",
    name,
    sourceConnectionId: null,
    registryConnectionId: null,
    serverId: null,
    configProfileIds: [],
    address: "",
    routes: [],
    state,
    lastRunId: null,
    lastSuccessfulRevision: null,
  });
}

function deploymentConnectionFixtures(
  sourceStatus: ConnectionResource["status"] = "ready",
  registryStatus: ConnectionResource["status"] = "ready",
): ConnectionResource[] {
  return [
    {
      id: "source-fact",
      kind: "source",
      provider: "cnb",
      name: "我的 CNB 连接",
      status: sourceStatus,
      lastCheckedAt: "2026-07-21T08:00:00Z",
      capabilities: [],
      metadata: { username: "demo" },
    },
    {
      id: "registry-fact",
      kind: "registry",
      provider: "tcr",
      name: "公司 TCR",
      status: registryStatus,
      lastCheckedAt: "2026-07-21T08:00:00Z",
      capabilities: [],
      metadata: {
        endpoint: "ccr.ccs.tencentyun.com",
        namespace: "demo",
      },
    },
  ];
}

function deploymentServerFixture(keyPathExists = true): ServerResource {
  return {
    id: "server-fact",
    name: "线上服务器",
    host: "203.0.113.80",
    user: "ubuntu",
    port: 22,
    keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
    keyPathExists,
    hostFingerprint: "SHA256:server-fact",
    lastCheckedAt: "2026-07-21T08:00:00Z",
  };
}

async function saveFactCompletePath(id = "path-facts") {
  await saveDeploymentPath({
    id,
    projectPath: "/demo/sample",
    name: "上线",
    sourceConnectionId: "source-fact",
    registryConnectionId: "registry-fact",
    serverId: "server-fact",
    configProfileIds: [],
    address: "app.example.com",
    routes: [{ service: "web", host: "app.example.com", path: "/" }],
    state: "draft",
    lastRunId: null,
    lastSuccessfulRevision: null,
  });
}

describe("DeploymentPathWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("顶部线路标签为中性、加载、警告和成功状态提供一致图标语义", async () => {
    await savePathFixture("path-draft", "待配置线路", "draft");
    await savePathFixture("path-deploying", "上线中线路", "deploying");
    await savePathFixture("path-warning", "待处理线路", "needs_action");
    await savePathFixture("path-online", "在线线路", "online");

    renderWorkspace(false);

    const assertBadge = (
      label: string,
      tone: "neutral" | "processing" | "success" | "warning",
      iconClass: string,
    ) => {
      const badge = screen.getByLabelText(`线路状态：${label}`);
      expect(badge).toHaveAttribute("data-path-state-tone", tone);
      expect(badge).toHaveClass("h-5", "text-xs");
      expect(badge.querySelector(iconClass)).not.toBeNull();
    };

    await screen.findByLabelText("线路状态：尚未配置");
    assertBadge("尚未配置", "neutral", ".lucide-circle");

    fireEvent.click(
      screen.getByRole("button", { name: /^上线中线路\s+上线中$/ }),
    );
    assertBadge("上线中", "processing", ".lucide-loader-circle");

    fireEvent.click(
      screen.getByRole("button", { name: /^待处理线路\s+需要处理$/ }),
    );
    assertBadge("需要处理", "warning", ".lucide-circle-alert");

    fireEvent.click(
      screen.getByRole("button", { name: /^在线线路\s+已上线$/ }),
    );
    assertBadge("已上线", "success", ".lucide-check");
  });

  it("从线路列表重命名非当前线路时保持当前画布不变", async () => {
    await savePathFixture("path-primary", "主线路");
    await savePathFixture("path-standby", "备用线路");

    renderWorkspace(false);
    const primaryPath = await screen.findByRole("button", {
      name: /^主线路\s+尚未配置$/,
    });
    expect(primaryPath).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "管理线路：备用线路" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "重命名线路" }),
    );

    expect(primaryPath).toHaveAttribute("aria-current", "page");
    const settings = await screen.findByRole("dialog", {
      name: "重命名线路",
    });
    expect(within(settings).getByLabelText("线路名称")).toHaveValue("备用线路");
    fireEvent.change(within(settings).getByLabelText("线路名称"), {
      target: { value: "灾备线路" },
    });
    fireEvent.click(within(settings).getByRole("button", { name: "保存名称" }));

    const renamedPath = await screen.findByRole("button", {
      name: /^灾备线路\s+尚未配置$/,
    });
    expect(primaryPath).toHaveAttribute("aria-current", "page");
    expect(renamedPath).not.toHaveAttribute("aria-current");
    await expect(api.listDeploymentPaths("/demo/sample")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "path-primary", name: "主线路" }),
        expect.objectContaining({ id: "path-standby", name: "灾备线路" }),
      ]),
    );
  });

  it("从线路列表删除指定线路并禁用部署中线路的删除入口", async () => {
    await savePathFixture("path-primary", "主线路");
    await savePathFixture("path-standby", "备用线路");
    await savePathFixture("path-deploying", "上线中线路", "deploying");

    renderWorkspace(false);
    const primaryPath = await screen.findByRole("button", {
      name: /^主线路\s+尚未配置$/,
    });
    expect(primaryPath).toHaveAttribute("aria-current", "page");
    fireEvent.click(
      screen.getByRole("button", { name: "管理线路：上线中线路" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "删除线路" }),
    ).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", { name: "管理线路：备用线路" }));
    const deleteStandbyItem = (
      await screen.findAllByRole("menuitem", { name: "删除线路" })
    ).find((item) => item.getAttribute("aria-disabled") === "false");
    expect(deleteStandbyItem).toBeDefined();
    fireEvent.click(deleteStandbyItem!);
    expect(primaryPath).toHaveAttribute("aria-current", "page");
    const confirmation = await screen.findByRole("dialog", {
      name: "确认删除线路",
    });
    expect(
      within(confirmation).getByText(/确定删除“备用线路”吗/),
    ).toBeInTheDocument();
    expect(
      within(confirmation).getByText(/不会删除本地项目代码或配置中心里的连接/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "确认删除线路" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "管理线路：备用线路" }),
      ).not.toBeInTheDocument(),
    );
    expect(primaryPath).toHaveAttribute("aria-current", "page");
    const remainingPaths = await api.listDeploymentPaths("/demo/sample");
    expect(remainingPaths.map((candidate) => candidate.id)).toEqual([
      "path-primary",
      "path-deploying",
    ]);
  });

  it("按线路恢复并保存画布节点位置", async () => {
    await savePathFixture("path-primary", "主线路");
    await savePathFixture("path-standby", "备用线路");
    await api.saveDeploymentPathCanvasLayout("/demo/sample", "path-primary", {
      local: { x: 25, y: 35 },
      build: { x: 345, y: 35 },
      registry: { x: 665, y: 35 },
      server: { x: 985, y: 35 },
    });
    await api.saveDeploymentPathCanvasLayout("/demo/sample", "path-standby", {
      local: { x: -50, y: 75 },
      build: { x: 300, y: 75 },
      registry: { x: 650, y: 75 },
      server: { x: 1000, y: 75 },
    });

    renderWorkspace(false);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "部署工作流画布" }),
      ).toHaveAttribute("data-local-x", "25"),
    );

    fireEvent.click(screen.getByRole("button", { name: "模拟移动画布节点" }));
    await waitFor(async () =>
      expect(
        await api.getDeploymentPathCanvasLayout("/demo/sample", "path-primary"),
      ).toEqual({
        local: { x: 100, y: 120 },
        build: { x: 430, y: 120 },
        registry: { x: 760, y: 120 },
        server: { x: 1090, y: 120 },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /^备用线路\s+尚未配置$/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "部署工作流画布" }),
      ).toHaveAttribute("data-local-x", "-50"),
    );
  });

  it("在线路菜单中确认删除最后一条线路后回到空状态", async () => {
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

    const firstMount = renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "管理线路：唯一线路" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除线路" }));

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

    firstMount.unmount();
    renderWorkspace(false);

    expect(
      await screen.findByRole("heading", { name: "创建第一条上线线路" }),
    ).toBeInTheDocument();
    await expect(api.listDeploymentPaths("/demo/sample")).resolves.toEqual([]);

    const emptyState = screen
      .getByRole("heading", { name: "创建第一条上线线路" })
      .closest("div");
    expect(emptyState).not.toBeNull();
    fireEvent.click(
      within(emptyState!).getByRole("button", { name: "创建上线线路" }),
    );

    await waitFor(async () =>
      expect(await api.listDeploymentPaths("/demo/sample")).toHaveLength(1),
    );
    expect(
      screen.queryByRole("heading", { name: "创建第一条上线线路" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "部署工作流画布" }),
    ).toBeInTheDocument();
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

    expect(screen.getByText("密钥已保存")).toHaveClass("text-[var(--success)]");
    expect(screen.getByText("密钥缺失")).toHaveClass("text-[var(--warning)]");
  });

  it("节点检查器使用紧凑信息层级并只突出当前主动作", async () => {
    renderWorkspace();

    const inspector = await screen.findByRole("dialog", { name: "版本构建" });
    const title = within(inspector).getByRole("heading", { name: "版本构建" });
    expect(title).toHaveClass("text-base");
    expect(title.parentElement?.parentElement?.nextElementSibling).toHaveClass(
      "text-xs",
      "leading-[18px]",
    );
    const closeButton = within(inspector).getByRole("button", { name: "关闭" });
    expect(closeButton).not.toHaveAttribute("icon");
    expect(closeButton.querySelector("svg")).toBeInTheDocument();
    expect(closeButton).toHaveStyle({ height: "32px", width: "32px" });

    const addConnection = within(inspector).queryByRole("button", {
      name: "添加新的构建服务",
    });
    if (addConnection) fireEvent.click(addConnection);

    const primaryAction = within(inspector).getByRole("button", {
      name: "验证并保存构建服务",
    });
    expect(primaryAction).toHaveAttribute(
      "data-workspace-button-variant",
      "default",
    );
    expect(
      within(inspector)
        .getAllByRole("button")
        .filter(
          (button) =>
            button.getAttribute("data-workspace-button-variant") === "default",
        ),
    ).toEqual([primaryAction]);
  });

  it("更换构建连接时先选择草稿，确认前和验证失败后都保留原绑定", async () => {
    const nextSource: ConnectionResource = {
      id: "source-next",
      kind: "source",
      provider: "cnb",
      name: "备用 CNB 连接",
      status: "ready",
      lastCheckedAt: "2026-07-21T09:00:00Z",
      capabilities: [],
      metadata: { username: "backup" },
    };
    vi.spyOn(api, "listConnections").mockResolvedValue([
      ...deploymentConnectionFixtures(),
      nextSource,
    ]);
    vi.spyOn(api, "listServers").mockResolvedValue([deploymentServerFixture()]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-facts",
      filename: ".env.path-path-facts",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    const repositoryCheck = vi
      .spyOn(api, "checkCnbRepositoryAccess")
      .mockResolvedValue({
        provider: "cnb-repository",
        ok: false,
        summary: "备用连接暂时无法读取仓库",
        details: [],
      });
    await saveFactCompletePath();

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", { name: /版本构建：构建服务可用/ }),
    );
    const inspector = await screen.findByRole("dialog", { name: "版本构建" });
    expect(within(inspector).getByText("服务提供方 · CNB")).toBeInTheDocument();
    expect(
      within(inspector).getByRole("button", { name: "更换构建服务" }),
    ).toHaveAttribute("data-workspace-button-variant", "default");
    expect(
      within(inspector).queryByRole("button", { name: "完成" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(inspector).getByRole("button", { name: "更换构建服务" }),
    );
    const nextCandidate = within(inspector).getByRole("radio", {
      name: /备用 CNB 连接/,
    });
    fireEvent.click(nextCandidate);
    expect(nextCandidate).toHaveAttribute("aria-checked", "true");
    expect(
      within(inspector).getByRole("button", { name: "使用这个连接" }),
    ).toHaveAttribute("data-workspace-button-variant", "default");
    expect(
      (await api.listDeploymentPaths("/demo/sample"))[0]?.sourceConnectionId,
    ).toBe("source-fact");

    fireEvent.click(
      within(inspector).getByRole("button", { name: "使用这个连接" }),
    );
    await waitFor(() => expect(repositoryCheck).toHaveBeenCalled());
    expect(
      (await api.listDeploymentPaths("/demo/sample"))[0]?.sourceConnectionId,
    ).toBe("source-fact");
    expect(
      within(inspector).getByRole("radio", { name: /备用 CNB 连接/ }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("版本仓库和服务器候选也必须经唯一主按钮确认后才替换", async () => {
    const nextRegistry: ConnectionResource = {
      id: "registry-next",
      kind: "registry",
      provider: "tcr",
      name: "备用 TCR",
      status: "ready",
      lastCheckedAt: "2026-07-21T09:00:00Z",
      capabilities: [],
      metadata: {
        endpoint: "ccr.ccs.tencentyun.com",
        namespace: "backup",
      },
    };
    const nextServer: ServerResource = {
      ...deploymentServerFixture(),
      id: "server-next",
      name: "备用服务器",
      host: "203.0.113.81",
    };
    vi.spyOn(api, "listConnections").mockResolvedValue([
      ...deploymentConnectionFixtures(),
      nextRegistry,
    ]);
    vi.spyOn(api, "listServers").mockResolvedValue([
      deploymentServerFixture(),
      nextServer,
    ]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-facts",
      filename: ".env.path-path-facts",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    vi.spyOn(api, "checkSavedRegistryCredentials").mockResolvedValue({
      provider: "tcr",
      ok: true,
      summary: "版本仓库可用",
      details: [],
    });
    vi.spyOn(api, "checkServer").mockResolvedValue({
      provider: "ssh",
      ok: true,
      summary: "服务器可用",
      details: [],
    });
    await saveFactCompletePath();

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", { name: /版本存储：版本仓库可用/ }),
    );
    let inspector = await screen.findByRole("dialog", { name: "版本存储" });
    expect(
      within(inspector).getByText("服务提供方 · 腾讯云 TCR"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(inspector).getByRole("button", { name: "更换版本仓库" }),
    );
    fireEvent.click(within(inspector).getByRole("radio", { name: /备用 TCR/ }));
    expect(
      (await api.listDeploymentPaths("/demo/sample"))[0]?.registryConnectionId,
    ).toBe("registry-fact");
    const registryConfirm = within(inspector).getByRole("button", {
      name: "使用这个连接",
    });
    expect(
      within(inspector)
        .getAllByRole("button")
        .filter(
          (button) =>
            button.getAttribute("data-workspace-button-variant") === "default",
        ),
    ).toEqual([registryConfirm]);
    fireEvent.click(
      within(inspector).getByRole("button", { name: "返回当前配置" }),
    );
    expect(
      (await api.listDeploymentPaths("/demo/sample"))[0]?.registryConnectionId,
    ).toBe("registry-fact");

    fireEvent.click(
      within(inspector).getByRole("button", { name: "更换版本仓库" }),
    );
    fireEvent.click(within(inspector).getByRole("radio", { name: /备用 TCR/ }));
    fireEvent.click(
      within(inspector).getByRole("button", { name: "使用这个连接" }),
    );
    await waitFor(async () =>
      expect(
        (await api.listDeploymentPaths("/demo/sample"))[0]
          ?.registryConnectionId,
      ).toBe("registry-next"),
    );

    inspector = await screen.findByRole("dialog", { name: "部署运行" });
    fireEvent.click(
      within(inspector).getByRole("radio", { name: /备用服务器/ }),
    );
    expect((await api.listDeploymentPaths("/demo/sample"))[0]?.serverId).toBe(
      "server-fact",
    );
    const serverConfirm = within(inspector).getByRole("button", {
      name: "使用这个服务器",
    });
    expect(serverConfirm).toHaveAttribute(
      "data-workspace-button-variant",
      "default",
    );
    fireEvent.click(serverConfirm);
    await waitFor(async () =>
      expect((await api.listDeploymentPaths("/demo/sample"))[0]?.serverId).toBe(
        "server-next",
      ),
    );
  });

  it("添加新项目后自动生成一条从本地到服务器的固定线路", async () => {
    renderWorkspace();
    expect(await screen.findByRole("main")).toHaveAttribute(
      "data-workspace-shell",
      "deployment",
    );
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

  it("版本仓库查看、选择和新增三态严格互斥展示", async () => {
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

    expect(
      within(dialog).getByText("服务提供方 · 腾讯云 TCR"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("版本仓库地址"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有连接"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("连接新的版本仓库"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("已经完成的节点和当前在线服务会保留"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "更换版本仓库" }),
    );
    expect(
      within(dialog).getByText("选择配置中心已有连接"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("版本仓库地址"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("服务提供方 · 腾讯云 TCR"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("连接新的版本仓库"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("已经完成的节点和当前在线服务会保留"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "添加新的版本仓库" }),
    );
    expect(within(dialog).getByLabelText("版本仓库地址")).toBeInTheDocument();
    expect(within(dialog).getByText("连接新的版本仓库")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("服务提供方 · 腾讯云 TCR"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有连接"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("已经完成的节点和当前在线服务会保留"),
    ).not.toBeInTheDocument();
  });

  it("版本仓库修复态不混入查看、选择或新增内容", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue([
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
    await saveDeploymentPath({
      id: "path-registry-repair",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: "registry-ready",
      serverId: null,
      configProfileIds: [],
      address: "",
      routes: [],
      state: "needs_action",
      lastRunId: "run-registry-repair",
      lastSuccessfulRevision: null,
    });
    const run: DeploymentRun = {
      id: "run-registry-repair",
      projectPath: "/demo/sample",
      projectName: "sample",
      environment: "deployment",
      status: "needs_action",
      currentStage: "registry",
      buildSerial: "1003",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceTitle: "当前本地项目",
      sourceRunId: null,
      candidateTag: null,
      artifacts: [],
      actionKind: "deployment-path-retry",
      actionUrl: null,
      issueCode: "AD-REG-101",
      repository: "demo/sample",
      branch: "main",
      message: "版本仓库授权已经失效",
      completedSteps: ["build"],
      startedAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:01:00Z",
    };

    renderWorkspace(false, [run]);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /版本存储/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "版本存储" });

    expect(
      within(dialog).getByText("版本仓库授权已经失效"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "已经完成的节点和当前在线服务会保留，只处理这里的问题。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "更换版本仓库" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("版本仓库已连接"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有连接"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("连接新的版本仓库"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("版本仓库地址"),
    ).not.toBeInTheDocument();
  });

  it("服务器查看、选择、访问地址和运行配置不会同时展示", async () => {
    const server = {
      id: "server-ready",
      name: "生产服务器",
      host: "203.0.113.10",
      user: "ubuntu",
      port: 22,
      keyPath: "/Users/demo/.ssh/abcdeploy_ed25519",
      keyPathExists: true,
      hostFingerprint: "SHA256:server",
      lastCheckedAt: "2026-07-19T00:00:00Z",
    };
    vi.spyOn(api, "listServers").mockResolvedValue([server]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-server-modes",
      filename: ".env.path-path-server-modes",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    await saveDeploymentPath({
      id: "path-server-modes",
      projectPath: "/demo/sample",
      name: "上线",
      sourceConnectionId: null,
      registryConnectionId: null,
      serverId: server.id,
      configProfileIds: [],
      address: "app.example.com",
      routes: [{ service: "web", host: "app.example.com", path: "/" }],
      state: "draft",
      lastRunId: null,
      lastSuccessfulRevision: null,
    });

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", { name: /部署运行：运行服务器可用/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "部署运行" });

    expect(
      within(dialog).getByText("服务提供方 · Linux 服务器"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有服务器"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("项目访问地址")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("服务器地址"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "更换运行服务器" }),
    );
    expect(
      within(dialog).getByText("选择配置中心已有服务器"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("服务提供方 · Linux 服务器"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("项目访问地址")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("服务器地址"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "返回当前配置" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "维护访问地址" }),
    );
    expect(within(dialog).getByText("项目访问地址")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("访问地址")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("服务提供方 · Linux 服务器"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有服务器"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("服务器地址"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "返回服务器摘要" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "维护运行配置" }),
    );
    expect(
      await within(dialog).findByText(/运行配置|所有配置都已有值/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("服务提供方 · Linux 服务器"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("选择配置中心已有服务器"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("项目访问地址")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("访问地址")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("服务器地址"),
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

  it("四个节点事实全部就绪时派生显示可以上线且不篡改持久化状态", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue(
      deploymentConnectionFixtures(),
    );
    vi.spyOn(api, "listServers").mockResolvedValue([deploymentServerFixture()]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-facts",
      filename: ".env.path-path-facts",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    await saveFactCompletePath();

    renderWorkspace(false);

    expect(
      await screen.findByRole("button", { name: /^上线 可以上线$/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("可以上线").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "开始上线" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /^上线 尚未配置$/ }),
    ).not.toBeInTheDocument();
    await expect(api.listDeploymentPaths("/demo/sample")).resolves.toEqual([
      expect.objectContaining({ id: "path-facts", state: "draft" }),
    ]);
  });

  it("代码平台授权失效时保留连接事实并只提供重新授权动作", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue(
      deploymentConnectionFixtures("needs_authorization", "ready"),
    );
    vi.spyOn(api, "listServers").mockResolvedValue([deploymentServerFixture()]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-source-auth",
      filename: ".env.path-path-source-auth",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    await saveFactCompletePath("path-source-auth");

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /版本构建：授权失效，已保存连接“我的 CNB 连接”，需要重新授权/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "版本构建" });

    expect(within(dialog).getByText("已保留的连接信息")).toBeInTheDocument();
    expect(within(dialog).getByText("我的 CNB 连接")).toBeInTheDocument();
    expect(within(dialog).getByText("demo/sample")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "重新授权构建服务" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "更换构建服务" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "重新授权构建服务" }),
    );
    expect(within(dialog).getByText("连接新的构建服务")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("访问令牌")).toBeInTheDocument();
  });

  it("版本仓库连接失效时保留仓库事实并只提供重新连接动作", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue(
      deploymentConnectionFixtures("ready", "error"),
    );
    vi.spyOn(api, "listServers").mockResolvedValue([deploymentServerFixture()]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-registry-error",
      filename: ".env.path-path-registry-error",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    await saveFactCompletePath("path-registry-error");

    renderWorkspace(false);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /版本存储：连接失效，已保存连接“公司 TCR”，需要重新验证/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "版本存储" });

    expect(within(dialog).getByText("已保留的连接信息")).toBeInTheDocument();
    expect(within(dialog).getByText("公司 TCR")).toBeInTheDocument();
    expect(
      within(dialog).getByText("ccr.ccs.tencentyun.com"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "重新连接版本仓库" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "更换版本仓库" }),
    ).not.toBeInTheDocument();
  });

  it("服务器密钥缺失时节点进入修复态并从正常流程生成替代密钥", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue(
      deploymentConnectionFixtures(),
    );
    vi.spyOn(api, "listServers").mockResolvedValue([
      deploymentServerFixture(false),
    ]);
    vi.spyOn(api, "loadRuntimeConfig").mockResolvedValue({
      environment: "path-path-server-key-missing",
      filename: ".env.path-path-server-key-missing",
      sourceFiles: [],
      content: "",
      templateContent: "",
      requiredVariables: [],
      stored: true,
      authorizationRequired: false,
    });
    await saveFactCompletePath("path-server-key-missing");

    renderWorkspace(false);
    const serverNode = await screen.findByRole("button", {
      name: /部署运行：服务器密钥缺失，已保存服务器“线上服务器”，需要重新建立安全连接/,
    });
    expect(serverNode).toHaveAttribute("data-provider", "Linux 服务器");
    fireEvent.click(serverNode);
    const dialog = await screen.findByRole("dialog", { name: "部署运行" });

    expect(within(dialog).getByText("已保留的服务器信息")).toBeInTheDocument();
    expect(within(dialog).getByText("Linux 服务器")).toBeInTheDocument();
    expect(within(dialog).getByText("线上服务器")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "重新连接运行服务器" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "更换运行服务器" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "重新连接运行服务器" }),
    );
    expect(within(dialog).getByText("连接新的服务器")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("服务器地址")).toHaveValue(
      "203.0.113.80",
    );
  });
});
