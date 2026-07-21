import "@flowgram.ai/free-layout-editor/index.css";
import {
  EditorCursorState,
  EditorRenderer,
  FreeLayoutEditorProvider,
  WorkflowContentChangeType,
  WorkflowLineRenderData,
  WorkflowNodeRenderer,
  type FreeLayoutProps,
  type FreeLayoutPluginContext,
  type WorkflowJSON,
  type WorkflowNodeProps,
  useClientContext,
  useNodeRender,
  usePlaygroundTools,
} from "@flowgram.ai/free-layout-editor";
import { createFreeSnapPlugin } from "@flowgram.ai/free-snap-plugin";
import SemiButton from "@douyinfe/semi-ui/lib/es/button";
import SemiTooltip from "@douyinfe/semi-ui/lib/es/tooltip";
import {
  Braces,
  Check,
  CircleAlert,
  CloudCog,
  Focus,
  Hand,
  LoaderCircle,
  MousePointer2,
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

export interface DeploymentWorkflowNodePosition {
  x: number;
  y: number;
}

export type DeploymentWorkflowNodePositions = Record<
  DeploymentWorkflowNodeId,
  DeploymentWorkflowNodePosition
>;

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
  initialNodePositions?: Partial<DeploymentWorkflowNodePositions>;
  nodes: DeploymentWorkflowNodeModel[];
  onNodePositionsChange?: (positions: DeploymentWorkflowNodePositions) => void;
  onSelectNode: (node: DeploymentWorkflowNodeId) => void;
}

const DEPLOYMENT_NODE_SIZE = { width: 200, height: 118 } as const;
const DEPLOYMENT_GRAPH_LEFT = DEPLOYMENT_NODE_SIZE.width / 2 + 30;
const DEPLOYMENT_GRAPH_TOP = 220;
const DEPLOYMENT_GRAPH_STEP = DEPLOYMENT_NODE_SIZE.width + 44;
const NODE_POSITION_CHANGE_DEBOUNCE_MS = 180;

const deploymentNodeIds: DeploymentWorkflowNodeId[] = [
  "local",
  "build",
  "registry",
  "server",
];

const nodeIcons = {
  local: Braces,
  build: CloudCog,
  registry: PackageOpen,
  server: Server,
} as const;

const nodeFactLabels: Record<DeploymentWorkflowNodeId, string> = {
  local: "项目",
  build: "连接",
  registry: "连接",
  server: "服务器",
};

const edgeSources: DeploymentWorkflowNodeId[] = ["local", "build", "registry"];

function defaultNodePositions(
  nodes: DeploymentWorkflowNodeModel[],
  initialNodePositions?: Partial<DeploymentWorkflowNodePositions>,
): DeploymentWorkflowNodePositions {
  return Object.fromEntries(
    nodes.map((node, index) => [
      node.id,
      initialNodePositions?.[node.id] ?? {
        x: DEPLOYMENT_GRAPH_LEFT + index * DEPLOYMENT_GRAPH_STEP,
        y: DEPLOYMENT_GRAPH_TOP,
      },
    ]),
  ) as DeploymentWorkflowNodePositions;
}

function workflowNodePositions(
  workflow: WorkflowJSON,
): DeploymentWorkflowNodePositions | null {
  const positions = new Map(
    workflow.nodes.map((node) => [node.id, node.meta?.position]),
  );
  const result = {} as DeploymentWorkflowNodePositions;
  for (const id of deploymentNodeIds) {
    const position = positions.get(id);
    if (
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      return null;
    }
    result[id] = { x: position.x, y: position.y };
  }
  return result;
}

function movedNodePosition(event: {
  entity: { id: string };
  toJSON: () => unknown;
}): {
  id: DeploymentWorkflowNodeId;
  position: DeploymentWorkflowNodePosition;
} | null {
  if (
    !deploymentNodeIds.includes(event.entity.id as DeploymentWorkflowNodeId)
  ) {
    return null;
  }

  const serialized = event.toJSON();
  if (!serialized || typeof serialized !== "object") return null;
  const candidate = serialized as Record<string, unknown>;
  const rawPosition =
    candidate.position && typeof candidate.position === "object"
      ? (candidate.position as Record<string, unknown>)
      : candidate;
  if (
    typeof rawPosition.x !== "number" ||
    !Number.isFinite(rawPosition.x) ||
    typeof rawPosition.y !== "number" ||
    !Number.isFinite(rawPosition.y)
  ) {
    return null;
  }

  return {
    id: event.entity.id as DeploymentWorkflowNodeId,
    position: { x: rawPosition.x, y: rawPosition.y },
  };
}

function sameNodePositions(
  left: DeploymentWorkflowNodePositions,
  right: DeploymentWorkflowNodePositions,
) {
  return deploymentNodeIds.every(
    (id) => left[id].x === right[id].x && left[id].y === right[id].y,
  );
}

function refreshWorkflowLineGeometry(context: FreeLayoutPluginContext) {
  const linesManager = context.document.linesManager;
  const lines = linesManager.getAllLines();

  // `WorkflowLineRenderData` can be created before the free-lines plugin has
  // registered its render contributions. In that state FlowGram records the
  // correct endpoints/version but cannot create a path. Wait until both the
  // fixed three-edge graph and at least one contribution are available; the
  // initializer below retries on the next animation frame when they are not.
  if (
    lines.length !== edgeSources.length ||
    linesManager.contributionFactories.length === 0
  ) {
    return false;
  }

  const renderData = lines.map((line) => line.getData(WorkflowLineRenderData));
  const endpointsReady = renderData.every(({ position }) => {
    const { from, to } = position;
    return (
      Number.isFinite(from.x) &&
      Number.isFinite(from.y) &&
      Number.isFinite(to.x) &&
      Number.isFinite(to.y) &&
      (from.x !== to.x || from.y !== to.y)
    );
  });
  if (!endpointsReady) return false;

  if (renderData.every(({ path }) => path.length > 0)) return true;
  const originalLineType = linesManager.lineType;

  // FlowGram 1.0.12 can mount linked ports under React 19 before its line
  // render data receives the first geometry update. Switching render type is
  // the public manager operation that recalculates every WorkflowLineRenderData
  // entry. Restore the original type synchronously, before either scheduled
  // entity repaint, so users never see a different line shape flash on screen.
  const temporaryLineType = linesManager.switchLineType();
  if (temporaryLineType !== originalLineType) {
    linesManager.switchLineType(originalLineType);
  }

  const geometryReady = renderData.every(({ path }) => path.length > 0);
  if (geometryReady) {
    // The lines layer memoizes portals by render version. Clear that cache
    // after repairing geometry so the now-populated path is committed to DOM.
    linesManager.forceUpdate();
  }
  return geometryReady;
}

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
  initialNodePositions,
  nodes,
  onNodePositionsChange,
  onSelectNode,
}: DeploymentWorkflowCanvasProps) {
  // Parent state changes while a node Inspector is open. Keep the FlowGram
  // editor configuration independent from that selection state so clicking a
  // node does not recreate the whole canvas and reset its viewport.
  const nodeStructureSignature = nodes.map((node) => node.id).join("|");
  const initialPositionsRef = useRef(
    defaultNodePositions(nodes, initialNodePositions),
  );
  const onNodePositionsChangeRef = useRef(onNodePositionsChange);
  onNodePositionsChangeRef.current = onNodePositionsChange;
  const positionPersistenceReadyRef = useRef(false);
  const lastReportedPositionsRef = useRef(initialPositionsRef.current);
  const pendingPositionsRef = useRef<DeploymentWorkflowNodePositions | null>(
    null,
  );
  const positionChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const preparePositionPersistence = useCallback(
    (context: FreeLayoutPluginContext) => {
      lastReportedPositionsRef.current =
        workflowNodePositions(context.document.toJSON()) ??
        initialPositionsRef.current;
      positionPersistenceReadyRef.current = true;
    },
    [],
  );

  const handleNodePositionChange = useCallback(
    (
      context: FreeLayoutPluginContext,
      event: { entity: { id: string }; toJSON: () => unknown },
    ) => {
      if (!positionPersistenceReadyRef.current) return;
      const positions = workflowNodePositions(context.document.toJSON());
      if (!positions) return;

      // FlowGram fires MOVE_NODE from PositionData. At that exact moment the
      // event already owns the latest coordinates, while serializing the whole
      // document can still return the previous position for the moved node.
      // Merge the authoritative event payload into the complete four-node
      // snapshot before debouncing; otherwise a real drag can look unchanged
      // and never reach persistent storage.
      const moved = movedNodePosition(event);
      if (!moved) return;
      positions[moved.id] = moved.position;

      if (positionChangeTimerRef.current !== null) {
        clearTimeout(positionChangeTimerRef.current);
      }
      pendingPositionsRef.current = positions;
      positionChangeTimerRef.current = setTimeout(() => {
        positionChangeTimerRef.current = null;
        const pendingPositions = pendingPositionsRef.current;
        pendingPositionsRef.current = null;
        if (
          !pendingPositions ||
          sameNodePositions(pendingPositions, lastReportedPositionsRef.current)
        ) {
          return;
        }
        lastReportedPositionsRef.current = pendingPositions;
        onNodePositionsChangeRef.current?.(pendingPositions);
      }, NODE_POSITION_CHANGE_DEBOUNCE_MS);
    },
    [],
  );

  useEffect(
    () => () => {
      if (positionChangeTimerRef.current !== null) {
        clearTimeout(positionChangeTimerRef.current);
      }
    },
    [],
  );

  const editorProps = useMemo<FreeLayoutProps>(() => {
    const initialData = {
      nodes: nodes.map((node) => ({
        id: node.id,
        type: "deployment-node",
        meta: {
          position: initialPositionsRef.current[node.id],
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
      onContentChange: (context, event) => {
        if (event.type === WorkflowContentChangeType.MOVE_NODE) {
          handleNodePositionChange(context, event);
        }
      },
      onLoad: preparePositionPersistence,
      plugins: () => [
        createFreeSnapPlugin({
          alignColor: "var(--primary)",
          alignLineWidth: 1,
          edgeColor: "var(--primary)",
          edgeLineWidth: 1,
        }),
      ],
      canAddLine: () => false,
      canDeleteLine: () => false,
      canDeleteNode: () => false,
      twoWayConnection: false,
    };
    // `nodeStructureSignature` deliberately replaces the referentially
    // unstable nodes array. These four node IDs define the graph structure;
    // live titles and statuses are supplied through `nodesById`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handleNodePositionChange,
    nodeStructureSignature,
    preparePositionPersistence,
  ]);

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
  const canvasHostRef = useRef<HTMLDivElement>(null);

  return (
    <DeploymentCanvasContext.Provider value={canvasContext}>
      <FreeLayoutEditorProvider {...editorProps}>
        <div
          aria-label="部署工作流画布"
          className="deployment-workflow-canvas relative h-full min-h-0 overflow-hidden bg-[var(--canvas-background)]"
          data-edge-build={edgeTones.build}
          data-edge-local={edgeTones.local}
          data-edge-registry={edgeTones.registry}
          ref={canvasHostRef}
          role="region"
        >
          <style>{`
            @keyframes abcdeploy-edge-flow { to { stroke-dashoffset: -20; } }

            /*
             * FlowGram may resolve a line before its source entity is mounted,
             * so a class derived from the source entity is not a reliable styling
             * contract. Every edge gets a visible neutral baseline here. The
             * graph is a fixed, ordered four-node chain, therefore live state
             * can safely address its three rendered edges by order.
             */
            .deployment-workflow-canvas .gedit-flow-activity-edge svg path {
              stroke: var(--muted-strong) !important;
              stroke-width: 2px !important;
              opacity: 1 !important;
            }
            ${edgeSources
              .map(
                (source, index) => `
                  .deployment-workflow-canvas[data-edge-${source}="complete"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-child(${index + 1}) svg path,
                  .deployment-workflow-canvas[data-edge-${source}="complete"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-of-type(${index + 1}) svg path { stroke: var(--success) !important; }
                  .deployment-workflow-canvas[data-edge-${source}="current"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-child(${index + 1}) svg path,
                  .deployment-workflow-canvas[data-edge-${source}="current"] .gedit-flow-lines-layer > .gedit-flow-activity-edge:nth-of-type(${index + 1}) svg path { stroke: var(--primary) !important; stroke-dasharray: 6 4; animation: abcdeploy-edge-flow .8s linear infinite; }
                `,
              )
              .join("\n")}
          `}</style>
          <EditorRenderer className="relative h-full w-full" />
          <DeploymentLineGeometryInitializer />
          <DeploymentCanvasTools hostRef={canvasHostRef} />
        </div>
      </FreeLayoutEditorProvider>
    </DeploymentCanvasContext.Provider>
  );
}

function DeploymentLineGeometryInitializer() {
  const client = useClientContext();

  useEffect(() => {
    let animationFrame = 0;
    let disposed = false;

    const initialize = () => {
      if (disposed) return;
      if (refreshWorkflowLineGeometry(client)) {
        client.playground.flush();
        return;
      }
      animationFrame = window.requestAnimationFrame(initialize);
    };

    animationFrame = window.requestAnimationFrame(initialize);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [client]);

  return null;
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
  const provider = data.provider?.trim() || "未选择服务";
  const connection = data.connectionName?.trim() || data.summary;
  return (
    <WorkflowNodeRenderer
      node={node}
      portPrimaryColor="var(--primary)"
      portSecondaryColor="var(--muted-strong)"
      style={{
        width: DEPLOYMENT_NODE_SIZE.width,
        minHeight: DEPLOYMENT_NODE_SIZE.height,
        height: DEPLOYMENT_NODE_SIZE.height,
        background: "var(--surface)",
        border: `${active ? 2 : 1}px solid ${active ? "var(--primary)" : data.tone === "error" ? "var(--destructive)" : "var(--border)"}`,
        borderRadius: 9,
        boxShadow: active
          ? "0 0 0 3px rgba(91,92,240,.11), 0 4px 12px rgba(31,35,48,.06)"
          : "0 2px 8px rgba(31,35,48,.06)",
        overflow: "hidden",
      }}
    >
      <button
        aria-label={`${data.title}，${provider}，${connection}，${data.statusLabel}`}
        title={`${data.title} · ${provider} · ${connection} · ${data.statusLabel}`}
        className="block h-full w-full cursor-pointer bg-transparent p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-inset"
        onClick={() => canvas.onSelectNode(data.id)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[var(--accent-soft)] text-[var(--primary)]">
            <Icon className="size-4" />
          </span>
          <strong className="min-w-0 flex-1 truncate text-base font-semibold leading-5">
            {data.title}
          </strong>
          <NodeStatus label={data.statusLabel} tone={data.tone} />
        </span>
        <span
          className="ml-9 mt-0.5 block truncate text-xs leading-[18px] text-[var(--muted-foreground)]"
          title={provider}
        >
          {provider}
        </span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2 border-t border-[var(--border)] pt-1.5 leading-5">
          <span className="shrink-0 text-xs text-[var(--subtle-foreground)]">
            {nodeFactLabels[data.id]}
          </span>
          <strong
            className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]"
            title={connection}
          >
            {connection}
          </strong>
        </span>
      </button>
    </WorkflowNodeRenderer>
  );
}

function NodeStatus({
  label,
  tone,
}: {
  label: string;
  tone: DeploymentWorkflowTone;
}) {
  const ready = tone === "ready";
  const working = tone === "working";
  const error = tone === "error";
  const compactLabel = ready
    ? "可用"
    : working
      ? "进行中"
      : error
        ? "需处理"
        : "待配置";
  return (
    <SemiTooltip content={label}>
      <span
        aria-label={label}
        className={`inline-flex h-[22px] max-w-[64px] shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium leading-4 ${ready ? "bg-[var(--success-soft)] text-[var(--success)]" : working ? "bg-[var(--accent-soft)] text-[var(--primary)]" : error ? "bg-[var(--destructive-soft)] text-[var(--destructive)]" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}
        tabIndex={-1}
      >
        {ready ? <Check className="size-3.5 shrink-0" /> : null}
        {working ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        ) : null}
        {error ? <CircleAlert className="size-3.5 shrink-0" /> : null}
        {!ready && !working && !error ? (
          <span className="size-1.5 shrink-0 rounded-full bg-current" />
        ) : null}
        <span className="truncate">{compactLabel}</span>
      </span>
    </SemiTooltip>
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

      refreshWorkflowLineGeometry(currentClient);

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
    <div className="absolute bottom-4 left-1/2 z-20 flex h-[42px] -translate-x-1/2 items-center gap-0.5 rounded-[10px] border border-black/5 bg-white/95 p-1 shadow-[0_8px_24px_rgba(25,28,42,.12)] backdrop-blur dark:border-white/10 dark:bg-[#242429]/95">
      <SemiTooltip content="选择节点">
        <SemiButton
          aria-label="选择节点"
          aria-pressed={tools.cursorState === EditorCursorState.SELECT}
          icon={<MousePointer2 className="size-4" />}
          onClick={() => tools.setCursorState(EditorCursorState.SELECT)}
          size="small"
          style={{
            ...(tools.cursorState === EditorCursorState.SELECT
              ? {
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--primary)",
                }
              : {}),
            borderRadius: 8,
            height: 32,
            minWidth: 32,
            width: 32,
          }}
          theme={
            tools.cursorState === EditorCursorState.SELECT
              ? "light"
              : "borderless"
          }
          type="tertiary"
        />
      </SemiTooltip>
      <SemiTooltip content="抓手模式">
        <SemiButton
          aria-label="抓手模式"
          aria-pressed={tools.cursorState === EditorCursorState.GRAB}
          icon={<Hand className="size-4" />}
          onClick={() => tools.setCursorState(EditorCursorState.GRAB)}
          size="small"
          style={{
            ...(tools.cursorState === EditorCursorState.GRAB
              ? {
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--primary)",
                }
              : {}),
            borderRadius: 8,
            height: 32,
            minWidth: 32,
            width: 32,
          }}
          theme={
            tools.cursorState === EditorCursorState.GRAB
              ? "light"
              : "borderless"
          }
          type="tertiary"
        />
      </SemiTooltip>
      <span className="mx-1 h-5 w-px bg-[var(--border)]" />
      <SemiTooltip content="缩小">
        <SemiButton
          aria-label="缩小画布"
          icon={<ZoomOut className="size-4" />}
          onClick={() => tools.zoomout(true)}
          size="small"
          style={{ borderRadius: 8, height: 32, minWidth: 32, width: 32 }}
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
          size="small"
          style={{ borderRadius: 8, height: 32, minWidth: 32, width: 32 }}
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
          size="small"
          style={{ borderRadius: 8, height: 32, minWidth: 32, width: 32 }}
          theme="borderless"
          type="tertiary"
        />
      </SemiTooltip>
    </div>
  );
}
