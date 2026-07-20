import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flowgramState = vi.hoisted(() => ({
  fitView: vi.fn(),
  flush: vi.fn(),
  nodeRenderData: null as unknown,
  providerProps: null as unknown,
  resize: vi.fn(),
  scroll: vi.fn(),
  snapOptions: null as unknown,
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
  WorkflowNodeRenderer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  useNodeRender: () => ({
    data: flowgramState.nodeRenderData,
    id: (flowgramState.nodeRenderData as { id?: string } | null)?.id,
    selected: false,
  }),
  useClientContext: () => ({
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
    zoom: 1,
    zoomin: flowgramState.zoomin,
    zoomout: flowgramState.zoomout,
  }),
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
      setLineClassName: (
        context: unknown,
        line: { from?: { id: string } },
      ) => string | undefined;
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
      { x: 154, y: 220 },
      { x: 474, y: 220 },
      { x: 794, y: 220 },
      { x: 1114, y: 220 },
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
          size: { width: 248, height: 172 },
        },
      },
    ]);
    expect(props.canAddLine()).toBe(false);
    expect(props.canDeleteLine()).toBe(false);
    expect(props.canDeleteNode()).toBe(false);
    expect(props.plugins()).toEqual([{ name: "free-snap" }]);
    expect(props.setLineClassName(undefined, { from: { id: "build" } })).toBe(
      "deployment-edge-from-build",
    );
    expect(flowgramState.snapOptions).toMatchObject({
      alignColor: "#5b5cf0",
      edgeColor: "#5b5cf0",
    });

    expect(
      screen.getByRole("button", {
        name: "代码来源：已就绪，示例商城",
      }),
    ).toBeInTheDocument();
    const canvas = screen.getByLabelText("部署工作流画布");
    expect(canvas).toHaveAttribute("data-edge-local", "complete");
    expect(canvas).toHaveAttribute("data-edge-build", "pending");
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

    expect(screen.getByText("当前连接：我的 CNB 账号")).toBeInTheDocument();
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

    await waitFor(() => {
      expect(flowgramState.fitView).toHaveBeenCalledTimes(1);
      expect(flowgramState.fitView).toHaveBeenNthCalledWith(1, false);
      expect(flowgramState.resize).toHaveBeenCalledWith(
        { height: 640, width: 984 },
        false,
      );
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
        name: "代码来源：正在读取，读取当前代码",
      }),
    ).toBeInTheDocument();
  });
});
