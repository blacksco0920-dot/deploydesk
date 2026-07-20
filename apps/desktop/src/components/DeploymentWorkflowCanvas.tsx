import "@douyinfe/semi-ui/react19-adapter";
import "@douyinfe/semi-ui/lib/es/_base/base.css";
import "@flowgram.ai/free-layout-editor/index.css";
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
  WorkflowNodeRenderer,
  type FreeLayoutProps,
  type WorkflowNodeProps,
  useClientContext,
  useNodeRender,
  usePlaygroundTools,
} from "@flowgram.ai/free-layout-editor";
import { createFreeSnapPlugin } from "@flowgram.ai/free-snap-plugin";
import SemiButton from "@douyinfe/semi-ui/lib/es/button/Button";
import SemiTooltip from "@douyinfe/semi-ui/lib/es/tooltip";
import {
  Braces,
  Check,
  CircleAlert,
  CloudCog,
  Focus,
  LoaderCircle,
  PackageOpen,
  Server,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";

export type DeploymentWorkflowNodeId =
  "local" | "build" | "registry" | "server";
export type DeploymentWorkflowTone = "ready" | "waiting" | "working" | "error";

export interface DeploymentWorkflowNodeModel {
  connectionName?: string;
  description: string;
  id: DeploymentWorkflowNodeId;
  provider?: string;
  statusLabel: string;
  summary: string;
  title: string;
  tone: DeploymentWorkflowTone;
}

type DeploymentWorkflowEdgeTone = "complete" | "current" | "pending";

interface DeploymentWorkflowCanvasProps {
  activeNode: DeploymentWorkflowNodeId | null;
  // Kept for the workspace call-site contract. Inspector revisions must not
  // reset the viewport; only the explicit canvas control requests another fit.
  fitViewRevision: string;
  nodes: DeploymentWorkflowNodeModel[];
  onSelectNode: (node: DeploymentWorkflowNodeId) => void;
}

const DEPLOYMENT_NODE_SIZE = { width: 248, height: 172 } as const;
const DEPLOYMENT_GRAPH_LEFT = DEPLOYMENT_NODE_SIZE.width / 2 + 30;
const DEPLOYMENT_GRAPH_TOP = 220;

const nodeIcons = {
  local: Braces,
  build: CloudCog,
  registry: PackageOpen,
  server: Server,
} as const;

const edgeSources: DeploymentWorkflowNodeId[] = ["local", "build", "registry"];

function workflowEdgeTones(
  nodes: DeploymentWorkflowNodeModel[],
): Record<string, DeploymentWorkflowEdgeTone> {
  return Object.fromEntries(
    edgeSources.map((source, index) => {
      const target = nodes[index + 1];
      const tone: DeploymentWorkflowEdgeTone =
        target?.tone === "ready"
          ? "complete"
          : target?.tone === "working" || target?.tone === "error"
            ? "current"
            : "pending";
      return [source, tone];
    }),
  );
}

const DeploymentCanvasContext = createContext<{
  activeNode: DeploymentWorkflowNodeId | null;
  nodesById: Partial<
    Record<DeploymentWorkflowNodeId, DeploymentWorkflowNodeModel>
  >;
  onSelectNode: (node: DeploymentWorkflowNodeId) => void;
} | null>(null);

export function DeploymentWorkflowCanvas({
  activeNode,
  nodes,
  onSelectNode,
}: DeploymentWorkflowCanvasProps) {
  // Parent state changes while a node Inspector is open. Keep the FlowGram
  // editor configuration independent from that selection state so clicking a
  // node does not recreate the whole canvas and reset its viewport.
  const nodeStructureSignature = nodes.map((node) => node.id).join("|");
  const editorProps = useMemo<FreeLayoutProps>(() => {
    const initialData = {
      nodes: nodes.map((node, index) => ({
        id: node.id,
        type: "deployment-node",
        meta: {
          position: {
            x: DEPLOYMENT_GRAPH_LEFT + index * 320,
            y: DEPLOYMENT_GRAPH_TOP,
          },
        },
        // Keep FlowGram's own node payload structural and stable. Live
        // deployment state is projected from React context below, so status
        // polling never needs to remount the editor or reset its viewport.
        data: { id: node.id },
      })),
      edges: nodes.slice(0, -1).map((node, index) => ({
        sourceNodeID: node.id,
        targetNodeID: nodes[index + 1].id,
      })),
    };
    return {
      background: true,
      initialData,
      // ABCDeploy owns the visible canvas grid cell and resizes FlowGram from
      // that exact element below. Leaving FlowGram's second ResizeObserver on
      // lets it recenter once more after fitView, which shifts the first node
      // behind the resource panel in WKWebView.
      playground: { autoResize: false },
      // These four display-only deployment nodes do not have FlowGram form
      // schemas. Keep the node engine off so `initialData.data` is stored in
      // extInfo and exposed by `useNodeRender().data`; enabling it without a
      // formMeta creates an empty form and hides the node payload at runtime.
      nodeEngine: { enable: false },
      nodeRegistries: [
        {
          type: "deployment-node",
          meta: {
            defaultExpanded: true,
            size: DEPLOYMENT_NODE_SIZE,
          },
        },
      ],
      getNodeDefaultRegistry: (type) => ({
        type,
        meta: {
          defaultExpanded: true,
        },
      }),
      materials: {
        renderDefaultNode: (props) => (
          <DeploymentNodeRenderer node={props.node} />
        ),
      },
      history: { enable: true, enableChangeNode: true },
      plugins: () => [
        createFreeSnapPlugin({
          alignColor: "#5b5cf0",
          alignLineWidth: 1,
          edgeColor: "#5b5cf0",
          edgeLineWidth: 1,
        }),
      ],
      canAddLine: () => false,
      canDeleteLine: () => false,
      canDeleteNode: () => false,
      twoWayConnection: false,
      // Give each fixed edge a stable semantic class. The host below owns the
      // live progress state, so polling a task recolors/animates the same
      // FlowGram lines without recreating the editor or resetting its viewport.
      setLineClassName: (_context, line) =>
        line.from ? `deployment-edge-from-${line.from.id}` : undefined,
    };
    // `nodeStructureSignature` deliberately replaces the referentially
    // unstable nodes array. These four node IDs define the graph structure;
    // live titles and statuses are supplied through `nodesById`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeStructureSignature]);

  const nodesById = useMemo(
    () =>
      Object.fromEntries(nodes.map((node) => [node.id, node])) as Partial<
        Record<DeploymentWorkflowNodeId, DeploymentWorkflowNodeModel>
      >,
    [nodes],
  );

  const canvasContext = useMemo(
    () => ({ activeNode, nodesById, onSelectNode }),
    [activeNode, nodesById, onSelectNode],
  );
  const edgeTones = useMemo(() => workflowEdgeTones(nodes), [nodes]);
  const edgeStateClasses = edgeSources
    .map((source) => `deployment-edge-${source}-${edgeTones[source]}`)
    .join(" ");
  const canvasHostRef = useRef<HTMLDivElement>(null);

  return (
    <DeploymentCanvasContext.Provider value={canvasContext}>
      <FreeLayoutEditorProvider {...editorProps}>
        <div
          aria-label="部署工作流画布"
          className={`deployment-workflow-canvas relative h-full min-h-0 overflow-hidden bg-[#f7f7fb] dark:bg-[#18181c] ${edgeStateClasses}`}
          data-edge-build={edgeTones.build}
          data-edge-local={edgeTones.local}
          data-edge-registry={edgeTones.registry}
          ref={canvasHostRef}
          role="region"
        >
          <style>{`
            @keyframes abcdeploy-edge-flow { to { stroke-dashoffset: -20; } }
            ${edgeSources
              .map(
                (source) => `
                  .deployment-edge-${source}-complete :is(.deployment-edge-from-${source}, .deployment-edge-from-${source} *) { stroke: #10b981 !important; }
                  .deployment-edge-${source}-current :is(.deployment-edge-from-${source}, .deployment-edge-from-${source} *) { stroke: #5b5cf0 !important; stroke-dasharray: 6 4; animation: abcdeploy-edge-flow .8s linear infinite; }
                  .deployment-edge-${source}-pending :is(.deployment-edge-from-${source}, .deployment-edge-from-${source} *) { stroke: #c7c9d1 !important; opacity: .72; }
                `,
              )
              .join("\n")}
          `}</style>
          <EditorRenderer className="relative h-full w-full" />
          <DeploymentCanvasTools hostRef={canvasHostRef} />
        </div>
      </FreeLayoutEditorProvider>
    </DeploymentCanvasContext.Provider>
  );
}

function DeploymentNodeRenderer({ node }: WorkflowNodeProps) {
  const canvas = useContext(DeploymentCanvasContext);
  // The entity ID is the stable contract FlowGram always preserves. Reading
  // business state from `useNodeRender().data` made the UI depend on whether a
  // specific FlowGram release serialized a form or extInfo. Resolve the live
  // model by entity ID instead, while still reusing FlowGram's selection hook.
  const { id: renderedNodeId, selected } = useNodeRender();
  const nodeId = renderedNodeId as DeploymentWorkflowNodeId;
  const data = canvas?.nodesById[nodeId];
  if (!data || !canvas) return null;
  const Icon = nodeIcons[data.id];
  const active = selected || canvas.activeNode === data.id;
  return (
    <WorkflowNodeRenderer
      node={node}
      portPrimaryColor="#5b5cf0"
      portSecondaryColor="#a4a6b3"
      style={{
        width: 248,
        minHeight: 142,
        height: "auto",
        background: "var(--surface)",
        border: `1px solid ${active ? "#5b5cf0" : data.tone === "error" ? "#e2a43a" : "var(--border)"}`,
        borderRadius: 12,
        boxShadow: active
          ? "0 0 0 2px rgba(91,92,240,.14), 0 8px 24px rgba(31,35,48,.08)"
          : "0 4px 14px rgba(31,35,48,.06)",
        overflow: "hidden",
      }}
    >
      <button
        aria-label={`${data.title}：${data.statusLabel}，${data.summary}`}
        className="block w-full cursor-pointer bg-transparent p-4 text-left outline-none"
        onClick={() => canvas.onSelectNode(data.id)}
        type="button"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#eef0ff] text-[#5b5cf0] dark:bg-[#292a4b]">
            <Icon className="size-4" />
          </span>
          <NodeStatus tone={data.tone}>{data.statusLabel}</NodeStatus>
        </span>
        <strong className="mt-4 block text-sm font-semibold">
          {data.title}
        </strong>
        <span className="mt-1 block text-[11px] leading-5 text-[var(--muted-foreground)]">
          {data.description}
        </span>
        <span className="mt-3 block truncate text-xs font-medium">
          {data.summary}
        </span>
        {data.provider ? (
          <span className="mt-1 block truncate text-[10px] text-[var(--subtle-foreground)]">
            {data.provider}
          </span>
        ) : null}
        {data.connectionName ? (
          <span className="mt-1 block truncate text-[10px] text-[var(--subtle-foreground)]">
            当前连接：{data.connectionName}
          </span>
        ) : null}
      </button>
    </WorkflowNodeRenderer>
  );
}

function NodeStatus({
  children,
  tone,
}: {
  children: string;
  tone: DeploymentWorkflowTone;
}) {
  const ready = tone === "ready";
  const working = tone === "working";
  const error = tone === "error";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${ready ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" : working ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300" : error ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}
    >
      {ready ? <Check className="size-3" /> : null}
      {working ? <LoaderCircle className="size-3 animate-spin" /> : null}
      {error ? <CircleAlert className="size-3" /> : null}
      {children}
    </span>
  );
}

function DeploymentCanvasTools({
  hostRef,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  const client = useClientContext();
  const clientRef = useRef(client);
  clientRef.current = client;
  const tools = usePlaygroundTools({ minZoom: 0.4, maxZoom: 1.6 });
  const viewportSyncRevision = useRef(0);

  const resizeCanvasToHost = useCallback(() => {
    const host = hostRef.current;
    if (!host) return false;
    const hostBounds = host.getBoundingClientRect();
    if (hostBounds.height < 1 || hostBounds.width < 1) return false;

    const currentClient = clientRef.current;
    currentClient.playground.resize(
      { height: hostBounds.height, width: hostBounds.width },
      false,
    );
    currentClient.playground.flush();
    return true;
  }, [hostRef]);

  const fitCanvasToHost = useCallback(
    async (easing: boolean) => {
      if (!resizeCanvasToHost()) return false;
      const revision = ++viewportSyncRevision.current;

      const currentClient = clientRef.current;
      await currentClient.tools.fitView(easing);
      if (revision !== viewportSyncRevision.current) return false;

      // Ask FlowGram to refresh every registered layer after its public resize
      // and fit operations. This avoids reaching into FlowGram's internal DOM
      // while keeping the WKWebView representation in step with its model.
      currentClient.playground.flush();
      return true;
    },
    [resizeCanvasToHost],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let firstFrame = 0;
    let secondFrame = 0;
    let initialized = false;
    let initializing = false;
    let resizeAfterInitialization = false;
    let disposed = false;
    const syncViewport = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          if (initialized) {
            resizeCanvasToHost();
            return;
          }
          if (initializing) {
            resizeAfterInitialization = true;
            return;
          }
          initializing = true;
          void fitCanvasToHost(false).then((didFit) => {
            if (disposed) return;
            initialized = didFit;
            initializing = false;
            if (!resizeAfterInitialization) return;
            resizeAfterInitialization = false;
            if (initialized) {
              resizeCanvasToHost();
            } else {
              syncViewport();
            }
          });
        });
      });
    };
    const observer = new ResizeObserver(syncViewport);
    observer.observe(host);
    syncViewport();
    return () => {
      disposed = true;
      observer.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [fitCanvasToHost, hostRef, resizeCanvasToHost]);

  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-black/5 bg-white/95 p-1.5 shadow-lg backdrop-blur dark:border-white/10 dark:bg-[#242429]/95">
      <SemiTooltip content="缩小">
        <SemiButton
          aria-label="缩小画布"
          icon={<ZoomOut className="size-4" />}
          onClick={() => tools.zoomout(true)}
          theme="borderless"
          type="tertiary"
        />
      </SemiTooltip>
      <span className="min-w-12 text-center text-xs text-[var(--muted-foreground)]">
        {Math.round(tools.zoom * 100)}%
      </span>
      <SemiTooltip content="放大">
        <SemiButton
          aria-label="放大画布"
          icon={<ZoomIn className="size-4" />}
          onClick={() => tools.zoomin(true)}
          theme="borderless"
          type="tertiary"
        />
      </SemiTooltip>
      <span className="mx-1 h-5 w-px bg-[var(--border)]" />
      <SemiTooltip content="适应画布">
        <SemiButton
          aria-label="适应画布"
          icon={<Focus className="size-4" />}
          onClick={() => void fitCanvasToHost(true)}
          theme="borderless"
          type="tertiary"
        />
      </SemiTooltip>
    </div>
  );
}
