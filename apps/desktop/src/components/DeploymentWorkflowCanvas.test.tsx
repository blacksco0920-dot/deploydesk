import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flowgramState = vi.hoisted(() => ({
  cursorState: "SELECT",
  fitView: vi.fn(),
  forceLineUpdate: vi.fn(),
  flush: vi.fn(),
  linePath: "",
  lineType: "BEZIER",
  nodeRenderData: null as unknown,
  providerProps: null as unknown,
  resize: vi.fn(),
  scroll: vi.fn(),
  setCursorState: vi.fn(),
  snapOptions: null as unknown,
  switchLineType: vi.fn(),
  zoomin: vi.fn(),
  zoomout: vi.fn(),
}));

const resizeObserverState = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
  observer: null as ResizeObserver | null,
}));

class ControllableResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverState.callback = callback;
    resizeObserverState.observer = this;
  }

  disconnect() {}

  observe() {}

  unobserve() {}
}

vi.stubGlobal("ResizeObserver", ControllableResizeObserver);

// FlowGram's real renderer requires a browser layout engine. This focused
// contract test captures the editor model passed to the open-source component
// while leaving geometry behavior to FlowGram itself.
vi.mock("@flowgram.ai/free-layout-editor", () => ({
  EditorCursorState: {
    GRAB: "GRAB",
    SELECT: "SELECT",
  },
  EditorRenderer: ({ className }: { className?: string }) => {
    const props = flowgramState.providerProps as {
      materials?: {
        renderDefaultNode: (input: { node: unknown }) => ReactNode;
      };
    } | null;
    return (
      <div aria-label="FlowGram 工作流画布" className={className}>
        {props?.materials?.renderDefaultNode({ node: { id: "local" } })}
      </div>
    );
  },
  FreeLayoutEditorProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    flowgramState.providerProps = props;
    return <div>{children}</div>;
  },
  WorkflowNodeRenderer: ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => (
    <div data-testid="flowgram-node" style={style}>
      {children}
    </div>
  ),
  WorkflowLineRenderData: class WorkflowLineRenderData {},
  useNodeRender: () => ({
    data: flowgramState.nodeRenderData,
    id: (flowgramState.nodeRenderData as { id?: string } | null)?.id,
    selected: false,
  }),
  useClientContext: () => ({
    document: {
      linesManager: {
        contributionFactories: [{ type: "BEZIER" }],
        forceUpdate: flowgramState.forceLineUpdate,
        getAllLines: () =>
          [0, 1, 2].map(() => ({
            getData: () => ({
              get path() {
                return flowgramState.linePath;
              },
              position: {
                from: { location: "right", x: 100, y: 100 },
                to: { location: "left", x: 200, y: 100 },
              },
            }),
          })),
        get lineType() {
          return flowgramState.lineType;
        },
        switchLineType: flowgramState.switchLineType,
      },
    },
    playground: {
      config: {
        config: { width: 984 },
        getClientBounds: () => ({ center: { x: 590, y: 400 } }),
        scroll: flowgramState.scroll,
        scrollData: { scrollX: 42, scrollY: 18 },
      },
      node: {
        getBoundingClientRect: () => ({ left: 196, width: 984 }),
      },
      pipelineNode: { style: { left: "56px" } },
      resize: flowgramState.resize,
      flush: flowgramState.flush,
    },
    tools: { fitView: flowgramState.fitView },
  }),
  usePlaygroundTools: () => ({
    cursorState: flowgramState.cursorState,
    setCursorState: flowgramState.setCursorState,
    zoom: 1,
    zoomin: flowgramState.zoomin,
    zoomout: flowgramState.zoomout,
  }),
  WorkflowContentChangeType: {
    MOVE_NODE: "MOVE_NODE",
  },
}));

vi.mock("@flowgram.ai/free-snap-plugin", () => ({
  createFreeSnapPlugin: (options: unknown) => {
    flowgramState.snapOptions = options;
    return { name: "free-snap" };
  },
}));

import {
  DeploymentWorkflowCanvas,
  type DeploymentWorkflowNodeModel,
} from "./DeploymentWorkflowCanvas";

const nodes: DeploymentWorkflowNodeModel[] = [
  {
    description: "确定上线代码",
    id: "local",
    provider: "本地项目",
    statusLabel: "已就绪",
    summary: "示例商城",
    title: "代码来源",
    tone: "ready",
  },
  {
    connectionName: "我的 CNB 账号",
    description: "生成可运行版本",
    id: "build",
    provider: "CNB",
    statusLabel: "已就绪",
    summary: "连接正常",
    title: "版本构建",
    tone: "ready",
  },
  {
    description: "保存不可变版本",
    id: "registry",
    provider: "TCR",
    statusLabel: "待配置",
    summary: "选择版本仓库",
    title: "版本存储",
    tone: "waiting",
  },
  {
    description: "运行并提供地址",
    id: "server",
    statusLabel: "待配置",
    summary: "连接服务器",
    title: "部署运行",
    tone: "waiting",
  },
];

describe("DeploymentWorkflowCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flowgramState.cursorState = "SELECT";
    flowgramState.linePath = "";
    flowgramState.lineType = "BEZIER";
    flowgramState.switchLineType.mockImplementation(
      (requestedLineType?: string) => {
        const nextLineType =
          requestedLineType ??
          (flowgramState.lineType === "BEZIER" ? "LINE_CHART" : "BEZIER");
        flowgramState.lineType = nextLineType;
        // Mirror FlowGram's public manager contract: switching line type calls
        // WorkflowLineRenderData.update() for every line before repainting.
        flowgramState.linePath = "M 0 0 L 20 0";
        return nextLineType;
      },
    );
    resizeObserverState.callback = null;
    resizeObserverState.observer = null;
  });

  it("把四个固定节点和三条顺序连接交给 FlowGram", () => {
    flowgramState.nodeRenderData = { id: "local" };
    render(
      <DeploymentWorkflowCanvas
        activeNode="build"
        fitViewRevision="inspector-open"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );

    const props = flowgramState.providerProps as {
      canAddLine: () => boolean;
      canDeleteLine: () => boolean;
      canDeleteNode: () => boolean;
      initialData: {
        edges: Array<{ sourceNodeID: string; targetNodeID: string }>;
        nodes: Array<{
          data: { id: string };
          id: string;
          meta: { position: { x: number; y: number } };
        }>;
      };
      nodeEngine: { enable: boolean };
      playground: { autoResize: boolean };
      materials: {
        renderDefaultNode: (props: { node: unknown }) => ReactNode;
      };
      nodeRegistries: Array<{
        meta: { size: { height: number; width: number } };
        type: string;
      }>;
      plugins: () => unknown[];
    };

    expect(screen.getByLabelText("FlowGram 工作流画布")).toBeInTheDocument();
    expect(props.initialData.nodes.map((node) => node.id)).toEqual([
      "local",
      "build",
      "registry",
      "server",
    ]);
    expect(props.initialData.nodes.map((node) => node.data.id)).toEqual([
      "local",
      "build",
      "registry",
      "server",
    ]);
    expect(props.initialData.nodes.map((node) => node.meta.position)).toEqual([
      { x: 130, y: 220 },
      { x: 374, y: 220 },
      { x: 618, y: 220 },
      { x: 862, y: 220 },
    ]);
    expect(props.initialData.edges).toEqual([
      { sourceNodeID: "local", targetNodeID: "build" },
      { sourceNodeID: "build", targetNodeID: "registry" },
      { sourceNodeID: "registry", targetNodeID: "server" },
    ]);
    expect(props.nodeEngine.enable).toBe(false);
    expect(props.playground.autoResize).toBe(false);
    expect(props.nodeRegistries).toEqual([
      {
        type: "deployment-node",
        meta: {
          defaultExpanded: true,
          size: { width: 200, height: 118 },
        },
      },
    ]);
    expect(props.canAddLine()).toBe(false);
    expect(props.canDeleteLine()).toBe(false);
    expect(props.canDeleteNode()).toBe(false);
    expect(props.plugins()).toEqual([{ name: "free-snap" }]);
    expect(flowgramState.snapOptions).toMatchObject({
      alignColor: "var(--primary)",
      edgeColor: "var(--primary)",
    });

    expect(
      screen.getByRole("button", {
        name: "代码来源，本地项目，示例商城，已就绪",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("flowgram-node")).toHaveStyle({
      height: "118px",
      width: "200px",
    });
    const canvas = screen.getByLabelText("部署工作流画布");
    expect(canvas).toHaveAttribute("data-edge-local", "complete");
    expect(canvas).toHaveAttribute("data-edge-build", "pending");
    const edgeStyles = canvas.querySelector("style")?.textContent;
    expect(edgeStyles).toContain(
      ".deployment-workflow-canvas .gedit-flow-activity-edge svg path",
    );
    expect(edgeStyles).toContain(
      '[data-edge-local="complete"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-child(1)',
    );
    expect(edgeStyles).toContain(
      '[data-edge-build="current"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-child(2)',
    );
  });

  it("节点卡显示当前复用的连接名称且不暴露凭据", () => {
    flowgramState.nodeRenderData = { id: "build" };
    render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );

    expect(screen.getByText("我的 CNB 账号")).toBeInTheDocument();
    expect(screen.getByText("CNB")).toBeInTheDocument();
    const visibleStatus = screen.getByLabelText("已就绪");
    expect(visibleStatus).toBeInTheDocument();
    expect(visibleStatus).toHaveTextContent("可用");
    expect(visibleStatus).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByText("生成可运行版本")).not.toBeInTheDocument();
    expect(screen.queryByText("连接正常")).not.toBeInTheDocument();
    expect(screen.queryByText(/token|password/i)).not.toBeInTheDocument();
  });

  it("复用画布工具，并按实际画布区域适配 FlowGram 视口", async () => {
    flowgramState.nodeRenderData = { id: "local" };
    render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );

    const host = screen.getByLabelText("FlowGram 工作流画布").parentElement;
    expect(host).not.toBeNull();
    vi.spyOn(host!, "getBoundingClientRect").mockReturnValue({
      bottom: 728,
      height: 640,
      left: 196,
      right: 1180,
      top: 88,
      width: 984,
      x: 196,
      y: 88,
      toJSON: () => ({}),
    });
    expect(screen.getByLabelText("FlowGram 工作流画布")).toHaveClass(
      "relative",
      "h-full",
      "w-full",
    );
    expect(screen.getByRole("button", { name: "选择节点" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "抓手模式" }));
    fireEvent.click(screen.getByRole("button", { name: "选择节点" }));
    expect(flowgramState.setCursorState).toHaveBeenNthCalledWith(1, "GRAB");
    expect(flowgramState.setCursorState).toHaveBeenNthCalledWith(2, "SELECT");

    await waitFor(() => {
      expect(flowgramState.fitView).toHaveBeenCalledTimes(1);
      expect(flowgramState.fitView).toHaveBeenNthCalledWith(1, false);
      expect(flowgramState.resize).toHaveBeenCalledWith(
        { height: 640, width: 984 },
        false,
      );
      expect(flowgramState.switchLineType).toHaveBeenNthCalledWith(1);
      expect(flowgramState.switchLineType).toHaveBeenNthCalledWith(2, "BEZIER");
      expect(flowgramState.linePath).not.toBe("");
      expect(flowgramState.forceLineUpdate).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "缩小画布" }));
    fireEvent.click(screen.getByRole("button", { name: "放大画布" }));
    fireEvent.click(screen.getByRole("button", { name: "适应画布" }));
    expect(flowgramState.zoomout).toHaveBeenCalledWith(true);
    expect(flowgramState.zoomin).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(flowgramState.fitView).toHaveBeenCalledTimes(2);
      expect(flowgramState.fitView).toHaveBeenNthCalledWith(2, true);
      expect(flowgramState.scroll).not.toHaveBeenCalled();
      expect(flowgramState.flush).toHaveBeenCalled();
    });
  });

  it("恢复初始节点位置，并在拖动完成后回传最新四节点位置", async () => {
    flowgramState.nodeRenderData = { id: "local" };
    const onNodePositionsChange = vi.fn();
    const initialNodePositions = {
      local: { x: 80, y: 100 },
      build: { x: 410, y: 120 },
      registry: { x: 740, y: 140 },
      server: { x: 1070, y: 160 },
    };
    render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        initialNodePositions={initialNodePositions}
        nodes={nodes}
        onNodePositionsChange={onNodePositionsChange}
        onSelectNode={vi.fn()}
      />,
    );

    const props = flowgramState.providerProps as {
      initialData: {
        nodes: Array<{
          id: string;
          meta: { position: { x: number; y: number } };
        }>;
      };
      onContentChange: (
        context: { document: { toJSON: () => unknown } },
        event: {
          entity: { id: string };
          toJSON: () => unknown;
          type: string;
        },
      ) => void;
      onLoad: (context: { document: { toJSON: () => unknown } }) => void;
    };
    expect(
      Object.fromEntries(
        props.initialData.nodes.map((node) => [node.id, node.meta.position]),
      ),
    ).toEqual(initialNodePositions);

    let currentPositions = initialNodePositions;
    const context = {
      document: {
        toJSON: () => ({
          edges: [],
          nodes: nodes.map((node) => ({
            id: node.id,
            meta: { position: currentPositions[node.id] },
            type: "deployment-node",
          })),
        }),
      },
    };

    // FlowGram can emit position events while it hydrates the initial graph.
    // They must not be mistaken for a user drag.
    props.onContentChange(context, {
      entity: { id: "local" },
      toJSON: () => currentPositions.local,
      type: "MOVE_NODE",
    });
    expect(onNodePositionsChange).not.toHaveBeenCalled();
    props.onLoad(context);

    currentPositions = {
      ...initialNodePositions,
      local: { x: 120, y: 180 },
    };
    props.onContentChange(context, {
      entity: { id: "local" },
      toJSON: () => currentPositions.local,
      type: "MOVE_NODE",
    });
    currentPositions = {
      ...currentPositions,
      local: { x: 155, y: 205 },
      build: { x: 455, y: 205 },
    };
    props.onContentChange(context, {
      entity: { id: "build" },
      toJSON: () => currentPositions.build,
      type: "MOVE_NODE",
    });

    expect(onNodePositionsChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onNodePositionsChange).toHaveBeenCalledTimes(1);
    });
    expect(onNodePositionsChange).toHaveBeenCalledWith(currentPositions);
  });

  it("以移动事件坐标覆盖尚未同步的整图快照", async () => {
    const onNodePositionsChange = vi.fn();
    const initialNodePositions = {
      local: { x: 80, y: 100 },
      build: { x: 410, y: 120 },
      registry: { x: 740, y: 140 },
      server: { x: 1070, y: 160 },
    };
    render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        initialNodePositions={initialNodePositions}
        nodes={nodes}
        onNodePositionsChange={onNodePositionsChange}
        onSelectNode={vi.fn()}
      />,
    );

    const props = flowgramState.providerProps as {
      onContentChange: (
        context: { document: { toJSON: () => unknown } },
        event: {
          entity: { id: string };
          toJSON: () => unknown;
          type: string;
        },
      ) => void;
      onLoad: (context: { document: { toJSON: () => unknown } }) => void;
    };
    const staleContext = {
      document: {
        toJSON: () => ({
          edges: [],
          nodes: nodes.map((node) => ({
            id: node.id,
            meta: { position: initialNodePositions[node.id] },
            type: "deployment-node",
          })),
        }),
      },
    };
    props.onLoad(staleContext);

    props.onContentChange(staleContext, {
      entity: { id: "local" },
      toJSON: () => ({ x: 260, y: 330 }),
      type: "MOVE_NODE",
    });

    await waitFor(() => {
      expect(onNodePositionsChange).toHaveBeenCalledTimes(1);
    });
    expect(onNodePositionsChange).toHaveBeenCalledWith({
      ...initialNodePositions,
      local: { x: 260, y: 330 },
    });
  });

  it("Inspector 切换和 host resize 保留用户视口", async () => {
    flowgramState.nodeRenderData = { id: "local" };
    const { rerender } = render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );

    const host = screen.getByLabelText("FlowGram 工作流画布").parentElement;
    expect(host).not.toBeNull();
    const getHostBounds = vi
      .spyOn(host!, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 728,
        height: 640,
        left: 196,
        right: 1180,
        top: 88,
        width: 984,
        x: 196,
        y: 88,
        toJSON: () => ({}),
      });

    await waitFor(() => {
      expect(flowgramState.fitView).toHaveBeenCalledTimes(1);
    });

    rerender(
      <DeploymentWorkflowCanvas
        activeNode="build"
        fitViewRevision="inspector-open"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );
    getHostBounds.mockReturnValue({
      bottom: 728,
      height: 640,
      left: 196,
      right: 900,
      top: 88,
      width: 704,
      x: 196,
      y: 88,
      toJSON: () => ({}),
    });
    resizeObserverState.callback?.([], resizeObserverState.observer!);

    await waitFor(() => {
      expect(flowgramState.resize).toHaveBeenCalledWith(
        { height: 640, width: 704 },
        false,
      );
    });
    expect(flowgramState.fitView).toHaveBeenCalledTimes(1);
    const resizeCountAfterOpen = flowgramState.resize.mock.calls.length;

    rerender(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );
    getHostBounds.mockReturnValue({
      bottom: 728,
      height: 640,
      left: 196,
      right: 1180,
      top: 88,
      width: 984,
      x: 196,
      y: 88,
      toJSON: () => ({}),
    });
    resizeObserverState.callback?.([], resizeObserverState.observer!);

    await waitFor(() => {
      expect(flowgramState.resize).toHaveBeenCalledTimes(
        resizeCountAfterOpen + 1,
      );
      expect(flowgramState.resize).toHaveBeenCalledWith(
        { height: 640, width: 984 },
        false,
      );
    });
    expect(flowgramState.fitView).toHaveBeenCalledTimes(1);
    expect(flowgramState.scroll).not.toHaveBeenCalled();
  });

  it("节点状态变化时通过上下文刷新而不重建 FlowGram 配置", () => {
    flowgramState.nodeRenderData = { id: "local" };
    const { rerender } = render(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={nodes}
        onSelectNode={vi.fn()}
      />,
    );
    const initialData = (
      flowgramState.providerProps as { initialData: unknown }
    ).initialData;

    const updatedNodes = nodes.map((node) =>
      node.id === "local"
        ? {
            ...node,
            statusLabel: "正在读取",
            summary: "读取当前代码",
            tone: "working" as const,
          }
        : node,
    );
    rerender(
      <DeploymentWorkflowCanvas
        activeNode={null}
        fitViewRevision="canvas-only"
        nodes={updatedNodes}
        onSelectNode={vi.fn()}
      />,
    );

    expect(
      (flowgramState.providerProps as { initialData: unknown }).initialData,
    ).toBe(initialData);
    expect(
      screen.getByRole("button", {
        name: "代码来源，本地项目，读取当前代码，正在读取",
      }),
    ).toBeInTheDocument();
  });
});
