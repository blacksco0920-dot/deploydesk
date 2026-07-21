const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const projects = [
  {
    id: "demo-shop",
    name: "示例商城",
    icon: "商",
    path: "/Users/you/Projects/demo-shop",
    services: 3,
    status: "online",
    scenario: "ready",
    address: "https://shop.example.com",
    updated: "今天 20:18",
    version: "187d3b21",
    nodeState: null,
  },
];

let currentProjectId = null;
let lineSequence = 0;
const runStepMs = window.__PROTOTYPE_TEST__ ? 5 : 900;
const lineStoragePrefix = "abcdeploy.prototype.lines.v1";
const lineSelectionStoragePrefix = "abcdeploy.prototype.selected-line.v1";
const linePositionStoragePrefix = "abcdeploy.prototype.node-positions.v1";
const NODE_WIDTH = 200;
const NODE_HEIGHT = 118;

const defaultDeploymentLines = [
  {
    id: "online",
    name: "上线",
    target: "119.91.112.80",
    connection: "腾讯云新服务器",
    detail: "119.91.112.80 · ubuntu",
    fact: "3 个服务 · 3 个地址",
    healthy: true,
  },
  {
    id: "test",
    name: "测试服务器",
    target: "42.193.229.35",
    connection: "测试服务器",
    detail: "42.193.229.35 · ubuntu",
    fact: "3 个服务 · 1 个地址",
    healthy: false,
  },
];

const providerCatalog = {
  source: {
    title: "代码来源",
    description: "确定这条线路要读取哪份代码",
    provider: "本地项目",
    providerMark: "本地",
    connection: "示例商城",
    detail: "/Users/you/Projects/demo-shop",
    fact: "已识别 3 个服务",
    candidates: [
      ["示例商城", "本地项目", "/Users/you/Projects/demo-shop"],
      ["客户管理工具", "本地项目", "/Users/you/Projects/customer-crm"],
    ],
  },
  build: {
    title: "版本构建",
    description: "把当前代码生成可以运行的版本",
    provider: "CNB",
    providerMark: "CNB",
    connection: "我的 CNB 账号",
    detail: "blacksc00920 · 最近验证：刚刚",
    fact: "main · 自动构建",
    candidates: [
      ["我的 CNB 账号", "CNB", "blacksc00920 · 连接正常"],
      ["团队构建账号", "CNB", "abcdeploy-team · 连接正常"],
    ],
  },
  artifact: {
    title: "版本存储",
    description: "安全保存每次上线产生的不可变版本",
    provider: "腾讯云 TCR",
    providerMark: "TCR",
    connection: "公司 TCR",
    detail: "ccr.ccs.tencentyun.com/finagent",
    fact: "8 个不可变版本",
    candidates: [
      ["公司 TCR", "腾讯云 TCR", "finagent · 连接正常"],
      ["个人镜像仓库", "腾讯云 TCR", "personal · 连接正常"],
    ],
  },
  deploy: {
    title: "部署运行",
    description: "把指定版本运行起来并提供访问地址",
    provider: "Linux 服务器",
    providerMark: "SSH",
    connection: "腾讯云新服务器",
    detail: "119.91.112.80 · ubuntu",
    fact: "3 个服务 · 3 个地址",
    candidates: [
      ["腾讯云新服务器", "Linux 服务器", "119.91.112.80 · 连接正常"],
      ["测试服务器", "Linux 服务器", "42.193.229.35 · 连接正常"],
    ],
  },
};

const nodePositions = {
  source: [80, 280],
  build: [324, 280],
  artifact: [568, 280],
  deploy: [812, 280],
};

function makeNode(id, type) {
  const meta = providerCatalog[type];
  return {
    id,
    type,
    x: nodePositions[id][0],
    y: nodePositions[id][1],
    provider: meta.provider,
    connection: meta.connection,
    detail: meta.detail,
    fact: meta.fact,
    config: "ready",
    run: "idle",
  };
}

const nodes = {
  source: makeNode("source", "source"),
  build: makeNode("build", "build"),
  artifact: makeNode("artifact", "artifact"),
  deploy: makeNode("deploy", "deploy"),
};

const edges = [
  ["source", "build"],
  ["build", "artifact"],
  ["artifact", "deploy"],
];

const state = {
  selectedNode: "build",
  selectedLine: "online",
  inspectorMode: "view",
  canvasTool: "select",
  scenario: "ready",
  zoom: 0.86,
  panX: 16,
  panY: 36,
  timers: [],
  selectedCandidate: null,
  managingLine: null,
};

const studioBody = $("#studioBody");
const canvasViewport = $("#canvasViewport");
const canvasWorld = $("#canvasWorld");
const nodeLayer = $("#nodeLayer");
const edgeLayer = $("#edgeLayer");
const inspectorContent = $("#inspectorContent");
const inspectorFooter = $("#inspectorFooter");
const inspectorTitle = $("#inspectorTitle");
const inspectorIcon = $("#inspectorIcon");
const runButton = $("#runButton");
const runButtonText = $("#runButtonText");
const scenarioSelect = $("#scenarioSelect");
const toast = $("#toast");
const homeView = $("#homeView");
const workflowView = $("#workflowView");
const projectGrid = $("#projectGrid");
const projectSearch = $("#projectSearch");
const addProjectDialog = $("#addProjectDialog");
const runConfirmDialog = $("#runConfirmDialog");
const successDialog = $("#successDialog");
const lineList = $("#lineList");
const renameLineDialog = $("#renameLineDialog");
const deleteLineDialog = $("#deleteLineDialog");

function currentProject() {
  return projects.find((project) => project.id === currentProjectId) || null;
}

function lineStorageKey(projectId) {
  return `${lineStoragePrefix}:${projectId}`;
}

function lineSelectionStorageKey(projectId) {
  return `${lineSelectionStoragePrefix}:${projectId}`;
}

function linePositionStorageKey(projectId, lineId) {
  return `${linePositionStoragePrefix}:${projectId}:${lineId}`;
}

function readStoredJson(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 原型仍可在禁用本地存储的浏览器环境中使用，只是不跨刷新保留。
  }
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 与 writeStoredJson 保持同样的降级策略。
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 删除失败不阻断当前页面里的线路管理。
  }
}

function normalizeLine(line, index) {
  if (!line || typeof line !== "object") return null;
  const id = typeof line.id === "string" && /^[a-zA-Z0-9_-]+$/.test(line.id) ? line.id : `restored-${index + 1}`;
  return {
    id,
    name: typeof line.name === "string" && line.name.trim() ? line.name.trim().slice(0, 24) : `部署线路 ${index + 1}`,
    target: typeof line.target === "string" && line.target ? line.target : "尚未绑定服务器",
    connection: typeof line.connection === "string" && line.connection ? line.connection : "尚未选择服务器",
    detail: typeof line.detail === "string" ? line.detail : "",
    fact: typeof line.fact === "string" ? line.fact : "等待设置访问地址",
    healthy: Boolean(line.healthy),
  };
}

function defaultLinesForProject(project) {
  const count = project.id === "demo-shop" ? 2 : 1;
  return defaultDeploymentLines.slice(0, count).map((line) => ({ ...line }));
}

function ensureProjectLines(project) {
  if (Array.isArray(project.lines)) return project.lines;
  const stored = readStoredJson(lineStorageKey(project.id));
  const seen = new Set();
  const restored = Array.isArray(stored)
    ? stored
      .map(normalizeLine)
      .filter((line) => line && !seen.has(line.id) && seen.add(line.id))
    : [];
  project.lines = Array.isArray(stored) ? restored : defaultLinesForProject(project);
  return project.lines;
}

function saveProjectLines(project = currentProject()) {
  if (!project) return;
  writeStoredJson(lineStorageKey(project.id), ensureProjectLines(project));
}

function currentLine() {
  const project = currentProject();
  return project ? ensureProjectLines(project).find((line) => line.id === state.selectedLine) || null : null;
}

function serializeNodePositions() {
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { x: node.x, y: node.y }]));
}

function saveCurrentLinePositions() {
  const project = currentProject();
  const line = currentLine();
  if (!project || !line) return;
  writeStoredJson(linePositionStorageKey(project.id, line.id), serializeNodePositions());
}

function restoreCurrentLinePositions() {
  const project = currentProject();
  const line = currentLine();
  for (const [id, node] of Object.entries(nodes)) {
    node.x = nodePositions[id][0];
    node.y = nodePositions[id][1];
  }
  if (!project || !line) return;
  const saved = readStoredJson(linePositionStorageKey(project.id, line.id));
  if (!saved || typeof saved !== "object") return;
  Object.entries(saved).forEach(([id, position]) => {
    if (!nodes[id] || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
    nodes[id].x = Math.max(20, position.x);
    nodes[id].y = Math.max(90, position.y);
  });
}

function applyCurrentLineDetails() {
  const line = currentLine();
  studioBody.classList.toggle("no-lines", !line);
  if (!line) {
    $("#canvasLineName").textContent = "暂无线路";
    return;
  }
  nodes.deploy.connection = line.connection;
  nodes.deploy.detail = line.detail;
  nodes.deploy.fact = line.fact;
  $("#canvasLineName").textContent = line.name;
}

function renderLineList() {
  const project = currentProject();
  if (!project) {
    lineList.innerHTML = "";
    return;
  }
  const lines = ensureProjectLines(project);
  lineList.innerHTML = lines.length ? lines.map((line) => `
    <div class="line-row ${line.id === state.selectedLine ? "active" : ""}" data-line-row="${escapeHtml(line.id)}">
      <button class="line-select" type="button" data-line="${escapeHtml(line.id)}" aria-label="打开线路：${escapeHtml(line.name)}" aria-current="${line.id === state.selectedLine ? "true" : "false"}">
        <span class="line-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2"/><circle cx="18" cy="17" r="2"/><path d="M8 7h3a4 4 0 0 1 4 4v2a4 4 0 0 0 3 4"/></svg></span>
        <span class="line-copy"><strong>${escapeHtml(line.name)}</strong><small>${escapeHtml(line.target)}</small></span>
        <i class="line-health ${line.healthy ? "healthy" : ""}" aria-hidden="true"></i>
      </button>
      <span class="line-actions">
        <button class="line-more" type="button" data-line-more="${escapeHtml(line.id)}" aria-label="管理线路：${escapeHtml(line.name)}" aria-expanded="false" title="更多操作">•••</button>
        <span class="line-menu" role="menu">
          <button type="button" role="menuitem" data-line-action="rename" data-line-id="${escapeHtml(line.id)}">重命名</button>
          <button class="danger" type="button" role="menuitem" data-line-action="delete" data-line-id="${escapeHtml(line.id)}">删除线路</button>
        </span>
      </span>
    </div>`).join("") : `
    <div class="line-list-empty">
      <strong>暂无线路</strong>
      <small>创建后自动生成固定四节点</small>
      <button type="button" data-create-line>创建线路</button>
    </div>`;

  $$('[data-line]', lineList).forEach((button) => button.addEventListener("click", () => switchLine(button.dataset.line)));
  $$('[data-line-more]', lineList).forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const row = button.closest(".line-row");
    const opening = !row.classList.contains("menu-open");
    $$(".line-row.menu-open", lineList).forEach((item) => {
      item.classList.remove("menu-open");
      $("[data-line-more]", item)?.setAttribute("aria-expanded", "false");
    });
    row.classList.toggle("menu-open", opening);
    button.setAttribute("aria-expanded", String(opening));
  }));
  $$('[data-line-action="rename"]', lineList).forEach((button) => button.addEventListener("click", () => openRenameLine(button.dataset.lineId)));
  $$('[data-line-action="delete"]', lineList).forEach((button) => button.addEventListener("click", () => openDeleteLine(button.dataset.lineId)));
  $$('[data-create-line]', lineList).forEach((button) => button.addEventListener("click", createDeploymentLine));
}

function switchLine(lineId, { savePrevious = true } = {}) {
  const project = currentProject();
  if (!project || !ensureProjectLines(project).some((line) => line.id === lineId)) return;
  if (savePrevious && state.selectedLine !== lineId) saveCurrentLinePositions();
  state.selectedLine = lineId;
  if (!state.selectedNode || !nodes[state.selectedNode]) state.selectedNode = "build";
  studioBody.classList.remove("no-lines");
  writeStoredValue(lineSelectionStorageKey(project.id), lineId);
  restoreCurrentLinePositions();
  applyCurrentLineDetails();
  renderLineList();
  renderNodes();
  renderInspector();
  updateRunButton();
  window.requestAnimationFrame(fitCanvas);
}

function openRenameLine(lineId = state.selectedLine) {
  const project = currentProject();
  const line = project && ensureProjectLines(project).find((item) => item.id === lineId);
  if (!line) return;
  state.managingLine = lineId;
  $("#renameLineInput").value = line.name;
  openDialog(renameLineDialog);
  window.setTimeout(() => $("#renameLineInput").select(), 0);
}

function openDeleteLine(lineId) {
  const project = currentProject();
  if (!project) return;
  const lines = ensureProjectLines(project);
  const line = lines.find((item) => item.id === lineId);
  if (!line) return;
  state.managingLine = lineId;
  $("#deleteLineName").textContent = line.name;
  openDialog(deleteLineDialog);
}

function createDeploymentLine() {
  const project = currentProject();
  if (!project) return;
  const lines = ensureProjectLines(project);
  const template = currentLine() || defaultDeploymentLines[0];
  let id;
  do {
    lineSequence += 1;
    id = `line-${Date.now()}-${lineSequence}`;
  } while (lines.some((line) => line.id === id));
  const line = {
    ...template,
    id,
    name: `新部署线路 ${lines.length + 1}`,
    healthy: false,
  };
  lines.push(line);
  saveProjectLines(project);
  switchLine(id);
  openRenameLine(id);
  showToast("新线路已生成固定四节点，可直接选择连接并调整布局");
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function projectPresentation(project) {
  if (project.status === "online") return { label: "已经上线", action: "打开工作流", tone: "online" };
  if (project.status === "running") return { label: "正在上线", action: "查看进度", tone: "running" };
  if (project.status === "ready") return { label: "准备完成，可以上线", action: "开始上线", tone: "ready" };
  if (project.status === "failed") return { label: "上次上线未完成", action: "继续处理", tone: "failed" };
  return { label: "还差几项准备", action: "继续设置", tone: "setup" };
}

function renderHomeProjects(query = projectSearch?.value.trim() || "") {
  const normalized = query.toLowerCase();
  const visible = projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(normalized));
  projectGrid.innerHTML = visible.length
    ? visible.map((project) => {
      const presentation = projectPresentation(project);
      const location = project.address || project.path;
      return `
        <article class="project-card" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="button" aria-label="打开${escapeHtml(project.name)}">
          <div class="project-card-top">
            <div class="project-card-name"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(location)}</span></div>
            <span class="project-card-icon">${escapeHtml(project.icon)}</span>
          </div>
          <div class="project-card-status ${presentation.tone}"><i></i><strong>${presentation.label}</strong></div>
          <div class="project-card-meta"><span>${project.services} 个服务 · ${escapeHtml(project.updated)}</span><b>${presentation.action} ›</b></div>
        </article>`;
    }).join("")
    : '<div class="project-empty">没有找到项目。可以换个关键词，或添加电脑里的项目。</div>';

  $$('[data-project-id]', projectGrid).forEach((card) => {
    card.addEventListener("click", () => openWorkflow(card.dataset.projectId));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openWorkflow(card.dataset.projectId);
      }
    });
  });
}

function showHomePage(page = "projects") {
  $$('[data-home-page]').forEach((button) => button.classList.toggle("active", button.dataset.homePage === page));
  $("#projectsPage").hidden = page !== "projects";
  $("#connectionsPage").hidden = page !== "connections";
  if (page === "projects") renderHomeProjects();
}

function showHome(page = "projects") {
  saveCurrentLinePositions();
  persistCurrentWorkflow();
  workflowView.hidden = true;
  homeView.hidden = false;
  showHomePage(page);
}

function serializeNodes() {
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { ...node }]));
}

function restoreNodes(snapshot) {
  resetNodes();
  if (!snapshot) return;
  Object.entries(snapshot).forEach(([id, saved]) => {
    if (nodes[id]) Object.assign(nodes[id], saved);
  });
}

function syncCurrentProjectToSource() {
  const project = currentProject();
  if (!project) return;
  nodes.source.provider = "本地项目";
  nodes.source.connection = project.name;
  nodes.source.detail = project.path;
  nodes.source.fact = `已识别 ${project.services} 个服务`;
}

function persistCurrentWorkflow() {
  const project = currentProject();
  if (!project) return;
  project.nodeState = serializeNodes();
  if (project.status !== "online" && project.status !== "running" && project.status !== "failed") {
    project.status = currentLine() && visibleNodes().every((node) => node.config === "ready") ? "ready" : "setup";
  }
}

function openWorkflow(projectId) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  const resumingLiveRun = currentProjectId === projectId && project.status === "running" && state.timers.length > 0;
  currentProjectId = projectId;
  const lines = ensureProjectLines(project);
  const storedLine = readStoredValue(lineSelectionStorageKey(project.id));
  state.selectedLine = lines.some((line) => line.id === storedLine) ? storedLine : lines[0]?.id || null;
  homeView.hidden = true;
  workflowView.hidden = false;
  $("#workflowProjectName").textContent = project.name;
  if (!state.selectedLine) {
    clearTimers();
    state.selectedNode = null;
    removeStoredValue(lineSelectionStorageKey(project.id));
    studioBody.classList.add("no-lines", "inspector-closed");
    applyCurrentLineDetails();
    renderLineList();
    renderNodes();
    renderInspector();
    updateRunButton();
    return;
  }
  if (!resumingLiveRun) {
    if (project.nodeState) {
      clearTimers();
      restoreNodes(project.nodeState);
      syncCurrentProjectToSource();
      const firstBroken = visibleNodes().find((node) => node.config !== "ready");
      selectNode(firstBroken?.id || "build");
      if (!firstBroken && project.status !== "running") studioBody.classList.add("inspector-closed");
      renderNodes();
      updateRunButton();
    } else {
      scenarioSelect.value = project.scenario || (project.status === "online" ? "ready" : "setup");
      applyScenario(scenarioSelect.value);
    }
  } else {
    renderNodes();
    renderInspector();
    updateRunButton();
  }
  scenarioSelect.value = project.status === "running" ? "running" : project.scenario || (project.status === "online" ? "ready" : "setup");
  restoreCurrentLinePositions();
  applyCurrentLineDetails();
  renderLineList();
  renderNodes();
  renderInspector();
  updateRunButton();
  window.requestAnimationFrame(fitCanvas);
}

function visibleNodes() {
  return currentLine() ? Object.values(nodes) : [];
}

function statusLabel(node) {
  if (node.config === "missing") return "待连接";
  if (node.config === "expired") return "授权失效";
  return "连接正常";
}

function runLabel(run) {
  return {
    idle: "尚未运行",
    pending: "等待执行",
    running: "正在执行",
    success: "执行成功",
    error: "执行失败",
  }[run];
}

function nodeGlyph(type) {
  return {
    source: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9 5 12l3 3M16 9l3 3-3 3M14 5l-4 14" /></svg>',
    build: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="4" /></svg>',
    artifact: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="m4 12 8 4 8-4M4 17l8 4 8-4" /></svg>',
    deploy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01" /></svg>',
  }[type];
}

function renderNodes() {
  nodeLayer.innerHTML = visibleNodes()
    .map((node) => {
      const meta = providerCatalog[node.type];
      const status = statusLabel(node);
      return `
        <article
          class="workflow-node ${state.selectedNode === node.id ? "selected" : ""} ${node.config} ${node.run === "running" ? "running" : ""}"
          data-node-id="${node.id}"
          role="button"
          tabindex="0"
          aria-label="${meta.title}，${node.provider}，${status}，${runLabel(node.run)}"
          style="left:${node.x}px;top:${node.y}px"
        >
          ${node.id === "source" ? "" : '<i class="node-port input"></i>'}
          <i class="node-port output"></i>
          <div class="node-heading">
            <span class="node-icon">${nodeGlyph(node.type)}</span>
            <span><strong>${meta.title}</strong><small>${escapeHtml(node.provider)}</small></span>
            <span class="node-status ${node.config}" aria-label="${status}" title="${status}"><span class="visually-hidden">${status}</span></span>
          </div>
          <div class="node-fact"><span>连接</span><b>${escapeHtml(node.connection)}</b><em class="run-${node.run}">${node.run === "idle" ? "" : runLabel(node.run)}</em></div>
        </article>`;
    })
    .join("");

  $$(".workflow-node", nodeLayer).forEach((element) => {
    let drag = null;
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.canvasTool !== "select") return;
      const node = nodes[element.dataset.nodeId];
      drag = { startX: node.x, startY: node.y, x: event.clientX, y: event.clientY, moved: false };
      element.setPointerCapture?.(event.pointerId);
      element.classList.add("dragging");
      event.stopPropagation();
    });
    element.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = (event.clientX - drag.x) / state.zoom;
      const dy = (event.clientY - drag.y) / state.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const node = nodes[element.dataset.nodeId];
      node.x = Math.max(20, drag.startX + dx);
      node.y = Math.max(90, drag.startY + dy);
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      renderEdges();
    });
    element.addEventListener("pointerup", (event) => {
      if (drag?.moved) {
        saveCurrentLinePositions();
        persistCurrentWorkflow();
      } else if (drag) {
        selectNode(element.dataset.nodeId);
      }
      element.classList.remove("dragging");
      if (typeof element.releasePointerCapture === "function" && element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      drag = null;
    });
    element.addEventListener("pointercancel", () => {
      if (drag?.moved) {
        saveCurrentLinePositions();
        persistCurrentWorkflow();
      }
      element.classList.remove("dragging");
      drag = null;
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(element.dataset.nodeId);
      }
    });
  });

  renderEdges();
}

function renderEdges() {
  const markup = edgeLayer.querySelector("defs")?.outerHTML || "";
  const paths = currentLine() ? edges
    .map(([sourceId, targetId]) => {
      const source = nodes[sourceId];
      const target = nodes[targetId];
      const x1 = source.x + NODE_WIDTH;
      const y1 = source.y + NODE_HEIGHT / 2;
      const x2 = target.x;
      const y2 = target.y + NODE_HEIGHT / 2;
      const curve = Math.max(70, Math.abs(x2 - x1) * 0.48);
      let edgeState = "";
      if (source.run === "success" && target.run === "success") edgeState = "success";
      if (target.run === "running") edgeState = "running";
      return `<path class="edge-path ${edgeState}" d="M${x1} ${y1} C${x1 + curve} ${y1},${x2 - curve} ${y2},${x2} ${y2}"></path>`;
    })
    .join("") : "";
  edgeLayer.innerHTML = markup + paths;
}

function applyCanvasTransform() {
  canvasWorld.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setCanvasTool(tool) {
  if (tool !== "select" && tool !== "hand") return;
  state.canvasTool = tool;
  canvasViewport.dataset.tool = tool;
  [["selectTool", "select"], ["handTool", "hand"]].forEach(([id, value]) => {
    const active = value === tool;
    $(`#${id}`).classList.toggle("active", active);
    $(`#${id}`).setAttribute("aria-pressed", String(active));
  });
}

function fitCanvas() {
  const width = canvasViewport.clientWidth || 760;
  const height = canvasViewport.clientHeight || 600;
  const visible = visibleNodes();
  if (!visible.length) return;
  const minX = Math.min(...visible.map((node) => node.x));
  const minY = Math.min(...visible.map((node) => node.y));
  const maxX = Math.max(...visible.map((node) => node.x + NODE_WIDTH));
  const maxY = Math.max(...visible.map((node) => node.y + NODE_HEIGHT));
  const contentWidth = Math.max(NODE_WIDTH, maxX - minX);
  const contentHeight = Math.max(NODE_HEIGHT, maxY - minY);
  const horizontalPadding = 64;
  const topInset = 56;
  const bottomInset = 72;
  const availableWidth = Math.max(120, width - horizontalPadding * 2);
  const availableHeight = Math.max(120, height - topInset - bottomInset);
  state.zoom = Math.min(1, Math.max(0.5, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)));
  state.panX = (width - contentWidth * state.zoom) / 2 - minX * state.zoom;
  state.panY = topInset + (availableHeight - contentHeight * state.zoom) / 2 - minY * state.zoom;
  applyCanvasTransform();
}

function selectNode(id, mode) {
  if (!currentLine() || !nodes[id]) return;
  state.selectedNode = id;
  const node = nodes[id];
  state.inspectorMode = mode || (node.config === "expired" ? "repair" : node.config === "missing" ? "select" : "view");
  state.selectedCandidate = node.connection;
  studioBody.classList.remove("inspector-closed");
  renderNodes();
  renderInspector();
}

function renderInspector() {
  const node = nodes[state.selectedNode];
  if (!currentLine() || !node) {
    inspectorTitle.textContent = "节点配置";
    inspectorIcon.innerHTML = "";
    inspectorContent.innerHTML = "";
    inspectorFooter.innerHTML = "";
    return;
  }
  const meta = providerCatalog[node.type];
  inspectorTitle.textContent = meta.title;
  inspectorIcon.innerHTML = nodeGlyph(node.type);

  if (state.inspectorMode === "view") renderInspectorView(node, meta);
  if (state.inspectorMode === "select") renderInspectorSelect(node, meta);
  if (state.inspectorMode === "edit") renderInspectorEdit(node, meta);
  if (state.inspectorMode === "repair") renderInspectorRepair(node, meta);
}

function renderInspectorView(node, meta) {
  const sourceNode = node.type === "source";
  inspectorContent.innerHTML = `
    <div class="mode-heading"><h3>当前使用</h3><p>${sourceNode ? "这里展示当前项目的路径、服务识别结果和本机状态。" : "节点只引用一个已验证连接，账号和密码不会显示在画布上。"}</p></div>
    <section class="provider-summary">
      <div class="provider-summary-top">
        <span class="provider-logo">${meta.providerMark}</span>
        <div><strong>${escapeHtml(node.connection)}</strong><small>${escapeHtml(node.provider)}</small></div>
        <span class="connection-ok">${sourceNode ? "已识别" : "连接正常"}</span>
      </div>
      <div class="summary-facts">
        <div><span>服务提供方</span><b>${escapeHtml(node.provider)}</b></div>
        <div><span>连接信息</span><b>${escapeHtml(node.detail)}</b></div>
        <div><span>${sourceNode ? "项目状态" : "最近验证"}</span><b>${sourceNode ? escapeHtml(node.fact) : "刚刚"}</b></div>
      </div>
      <div class="inline-actions">
        <button type="button" data-action="change">更换连接</button>
        <button type="button" data-action="verify">重新验证</button>
      </div>
    </section>
    <p class="credential-note">凭据由配置中心统一维护，画布仅保存连接引用。</p>`;
  inspectorFooter.innerHTML = "";
  bindInspectorActions();
}

function renderInspectorSelect(node, meta) {
  inspectorContent.innerHTML = `
    <div class="mode-heading"><h3>选择连接</h3><p>当前连接在你确认新选择前继续生效。</p></div>
    <div class="connection-list">
      ${meta.candidates.map(([name, provider, detail]) => `
        <button class="connection-card ${state.selectedCandidate === name ? "selected" : ""}" type="button" data-candidate="${escapeHtml(name)}">
          <span class="provider-logo">${meta.providerMark}</span>
          <div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(provider)} · ${escapeHtml(detail)}</small></div>
          <span>${state.selectedCandidate === name ? "✓" : ""}</span>
        </button>`).join("")}
    </div>
    <button class="add-connection" type="button" data-action="add">＋ 连接新的${meta.provider}</button>
    <p class="field-help" style="margin-top:9px">需要删除、批量替换或查看影响项目时，前往配置中心管理。</p>`;
  inspectorFooter.innerHTML = `<button class="secondary-button" type="button" data-action="cancel">返回当前配置</button><button class="primary-button" type="button" data-action="use">使用这个连接</button>`;
  bindInspectorActions();
}

function editFields(type) {
  if (type === "source") return `
    <label><span>本地项目</span><input id="connectionDetail" value="/Users/chanjack/Documents/FinAgent" /></label>
    <p class="field-help">正式客户端使用系统文件夹选择器，不要求用户输入路径。</p>`;
  if (type === "build") return `
    <label><span>连接名称</span><input id="connectionName" value="我的 CNB 账号" /></label>
    <label><span>CNB Token</span><input id="connectionSecret" type="password" placeholder="粘贴访问令牌" /></label>
    <div class="permission-list"><div>读取当前项目仓库</div><div>触发并查看构建</div><div>维护项目构建配置</div></div>`;
  if (type === "artifact") return `
    <label><span>连接名称</span><input id="connectionName" value="公司 TCR" /></label>
    <label><span>版本仓库地址</span><input id="connectionDetail" value="ccr.ccs.tencentyun.com" /></label>
    <label><span>登录用户名</span><input value="100012447939" /></label>
    <label><span>访问密码</span><input id="connectionSecret" type="password" placeholder="输入仓库访问密码" /></label>`;
  return `
    <label><span>连接名称</span><input id="connectionName" value="腾讯云新服务器" /></label>
    <label><span>服务器地址</span><input id="connectionDetail" value="119.91.112.80" /></label>
    <div style="display:grid;grid-template-columns:1fr 90px;gap:8px"><label><span>登录用户</span><input value="ubuntu" /></label><label><span>端口</span><input value="22" /></label></div>
    <label><span>服务器登录密码</span><input id="connectionSecret" type="password" placeholder="只用于第一次建立连接" /></label>
    <p class="field-help">连接成功后客户端自动生成并安装专用 SSH 密钥，密码不会保存，以后无需重复输入。</p>`;
}

function renderInspectorEdit(node, meta) {
  inspectorContent.innerHTML = `
    <div class="mode-heading"><h3>连接新的${meta.provider}</h3><p>这里只展示当前连接需要的信息，验证完成前不会替换已有配置。</p></div>
    <div class="form-stack">
      <label><span>服务提供方</span><select><option>${meta.provider}</option></select></label>
      ${editFields(node.type)}
      <label class="reuse-check"><input id="saveReusable" type="checkbox" checked /><span><strong>保存到配置中心</strong><small>其他项目以后可以直接选择这个连接</small></span></label>
    </div>`;
  inspectorFooter.innerHTML = `<button class="secondary-button" type="button" data-action="back-select">返回选择</button><button class="primary-button" type="button" data-action="save">验证并使用</button>`;
  bindInspectorActions();
}

function renderInspectorRepair(node, meta) {
  inspectorContent.innerHTML = `
    <div class="mode-heading"><h3>连接需要处理</h3><p>问题只影响这个节点；其他节点、配置和线上服务都不会被清除。</p></div>
    <div class="notice danger"><strong>${escapeHtml(node.connection)} 的授权已经失效</strong>${meta.provider} 拒绝了最近一次验证。重新授权或改用其他连接后，可以从这里继续。</div>
    <div class="summary-facts" style="margin-top:14px">
      <div><span>服务提供方</span><b>${escapeHtml(node.provider)}</b></div>
      <div><span>仍然保留</span><b>线路配置和运行记录</b></div>
      <div><span>线上状态</span><b>当前版本继续运行</b></div>
    </div>
    <details class="technical-details"><summary>查看技术详情</summary><pre>连接验证返回：authorization scope invalid\n错误编号：AD-CONNECTION-103</pre></details>`;
  inspectorFooter.innerHTML = `<button class="secondary-button" type="button" data-action="change">改用其他连接</button><button class="primary-button" type="button" data-action="reauthorize">重新授权</button>`;
  bindInspectorActions();
}

function bindInspectorActions() {
  $$("[data-candidate]", inspectorContent).forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCandidate = button.dataset.candidate;
      renderInspector();
    });
  });
  $$("[data-action]", $("#inspector")).forEach((button) => {
    button.addEventListener("click", () => handleInspectorAction(button.dataset.action));
  });
}

function handleInspectorAction(action) {
  const node = nodes[state.selectedNode];
  const meta = providerCatalog[node.type];
  let completedNode = false;
  if (action === "change") {
    state.selectedCandidate = node.connection;
    state.inspectorMode = "select";
  }
  if (action === "verify") showToast(`${node.connection} 连接正常，刚刚完成验证`);
  if (action === "cancel") state.inspectorMode = node.config === "expired" ? "repair" : "view";
  if (action === "add" || action === "reauthorize") state.inspectorMode = "edit";
  if (action === "back-select") state.inspectorMode = "select";
  if (action === "use") {
    const candidate = meta.candidates.find(([name]) => name === state.selectedCandidate);
    if (candidate) {
      node.connection = candidate[0];
      node.provider = candidate[1];
      node.detail = candidate[2].replace(" · 连接正常", "");
      node.config = "ready";
      state.inspectorMode = "view";
      completedNode = true;
    }
  }
  if (action === "save") {
    const secret = $("#connectionSecret")?.value.trim();
    if (node.type !== "source" && !secret) {
      showToast("请先填写用于验证的授权信息");
      $("#connectionSecret")?.focus();
      return;
    }
    const name = $("#connectionName")?.value.trim();
    const detail = $("#connectionDetail")?.value.trim();
    if (name) node.connection = name;
    if (detail) node.detail = detail;
    node.config = "ready";
    state.inspectorMode = "view";
    completedNode = true;
  }
  renderNodes();
  updateRunButton();
  persistCurrentWorkflow();
  if (completedNode) {
    const next = visibleNodes().find((item) => item.config !== "ready");
    if (next) {
      selectNode(next.id);
      showToast(`“${meta.title}”已就绪，下一步完成“${providerCatalog[next.type].title}”`);
      return;
    }
    renderInspector();
    showToast("四个节点都已就绪，现在可以开始上线");
    return;
  }
  renderInspector();
}

function resetNodes() {
  for (const [id, node] of Object.entries(nodes)) {
    const meta = providerCatalog[node.type];
    node.x = nodePositions[id][0];
    node.y = nodePositions[id][1];
    node.provider = meta.provider;
    node.connection = meta.connection;
    node.detail = meta.detail;
    node.fact = meta.fact;
    node.config = "ready";
    node.run = "idle";
  }
}

function applyScenario(name) {
  clearTimers();
  resetNodes();
  syncCurrentProjectToSource();
  state.scenario = name;
  if (name === "setup") {
    nodes.build.config = "missing";
    nodes.artifact.config = "missing";
    nodes.deploy.config = "missing";
    selectNode("build", "select");
  } else if (name === "expired") {
    nodes.build.config = "expired";
    selectNode("build", "repair");
  } else if (name === "running") {
    nodes.source.run = "success";
    nodes.build.run = "running";
    nodes.artifact.run = "pending";
    nodes.deploy.run = "pending";
    selectNode("build", "view");
  } else {
    selectNode("build", "view");
    studioBody.classList.add("inspector-closed");
  }
  restoreCurrentLinePositions();
  applyCurrentLineDetails();
  renderLineList();
  renderNodes();
  updateRunButton();
  fitCanvas();
  persistCurrentWorkflow();
}

function updateRunButton() {
  if (!currentLine()) {
    runButton.disabled = true;
    runButtonText.textContent = "创建线路后上线";
    return;
  }
  const broken = visibleNodes().find((node) => node.config !== "ready");
  const project = currentProject();
  const running = project?.status === "running" || visibleNodes().some((node) => node.run === "running" || node.run === "pending");
  runButton.disabled = running;
  runButtonText.textContent = running ? "正在上线" : broken ? "继续准备" : project?.status === "online" ? "更新上线" : "开始上线";
}

function startRun() {
  if (!currentLine()) {
    showToast("先创建一条部署线路");
    return;
  }
  const broken = visibleNodes().find((node) => node.config !== "ready");
  if (broken) {
    selectNode(broken.id);
    showToast(`先完成“${providerCatalog[broken.type].title}”连接`);
    return;
  }
  const project = currentProject();
  if (!project) return;
  $("#confirmProjectName").textContent = project.name;
  $("#runConfirmDialog small").textContent = project.status === "online" ? "更新上线确认" : "首次上线确认";
  openDialog(runConfirmDialog);
}

function beginRun() {
  const project = currentProject();
  if (!project) return;
  closeDialog(runConfirmDialog);
  clearTimers();
  visibleNodes().forEach((node) => (node.run = "pending"));
  project.status = "running";
  project.scenario = "running";
  project.updated = "正在执行";
  scenarioSelect.value = "running";
  project.nodeState = serializeNodes();
  renderHomeProjects();
  const sequence = visibleNodes();
  sequence.forEach((node, index) => {
    state.timers.push(window.setTimeout(() => {
      if (index > 0) sequence[index - 1].run = "success";
      node.run = "running";
      state.selectedNode = node.id;
      project.nodeState = serializeNodes();
      renderNodes();
      renderInspector();
      updateRunButton();
    }, index * runStepMs));
  });
  state.timers.push(window.setTimeout(() => {
    sequence.at(-1).run = "success";
    project.status = "online";
    project.scenario = "ready";
    project.updated = "刚刚上线";
    project.version = "7f2a91c4";
    project.address ||= `https://${project.id}.example.com`;
    project.nodeState = serializeNodes();
    scenarioSelect.value = "ready";
    state.timers = [];
    renderNodes();
    renderInspector();
    updateRunButton();
    renderHomeProjects();
    $("#successSummary").textContent = `${project.services} 个服务已经在服务器运行，访问地址检查通过。`;
    $("#successAddress").textContent = project.address;
    $("#successAddress").href = project.address;
    openDialog(successDialog);
    showToast(`上线完成：${project.services} 个服务已经在服务器运行`);
  }, sequence.length * runStepMs));
  updateRunButton();
}

function clearTimers() {
  state.timers.forEach((timer) => window.clearTimeout(timer));
  state.timers = [];
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

scenarioSelect.addEventListener("change", () => {
  const project = currentProject();
  if (project) {
    project.scenario = scenarioSelect.value;
    if (scenarioSelect.value === "setup") project.status = "setup";
    if (scenarioSelect.value === "running") project.status = "running";
    if (scenarioSelect.value === "expired") project.status = "failed";
    if (scenarioSelect.value === "ready" && project.status !== "online") project.status = "ready";
  }
  applyScenario(scenarioSelect.value);
});
runButton.addEventListener("click", startRun);
$("#confirmRun").addEventListener("click", beginRun);
$("#cancelRun").addEventListener("click", () => closeDialog(runConfirmDialog));
$("#closeRunConfirm").addEventListener("click", () => closeDialog(runConfirmDialog));
$("#backToProjects").addEventListener("click", () => showHome("projects"));
$("#closeInspector").addEventListener("click", () => studioBody.classList.add("inspector-closed"));
$("#historyButton").addEventListener("click", () => openDialog($("#historyDialog")));
$("#closeHistory").addEventListener("click", () => closeDialog($("#historyDialog")));
$("#addLineButton").addEventListener("click", createDeploymentLine);
$("#createFirstLineButton").addEventListener("click", createDeploymentLine);
$("#renameCurrentLineButton").addEventListener("click", () => openRenameLine());

[$("#closeRenameLine"), $("#cancelRenameLine")].forEach((button) => button.addEventListener("click", () => closeDialog(renameLineDialog)));
$("#confirmRenameLine").addEventListener("click", () => {
  const project = currentProject();
  const line = project && ensureProjectLines(project).find((item) => item.id === state.managingLine);
  if (!line) return;
  const name = $("#renameLineInput").value.trim();
  if (!name) {
    showToast("线路名称不能为空");
    $("#renameLineInput").focus();
    return;
  }
  line.name = name.slice(0, 24);
  saveProjectLines(project);
  renderLineList();
  applyCurrentLineDetails();
  closeDialog(renameLineDialog);
  state.managingLine = null;
  showToast("线路名称已保存");
});
$("#renameLineInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#confirmRenameLine").click();
  }
});

[$("#closeDeleteLine"), $("#cancelDeleteLine")].forEach((button) => button.addEventListener("click", () => closeDialog(deleteLineDialog)));
$("#confirmDeleteLine").addEventListener("click", () => {
  const project = currentProject();
  if (!project) return;
  const lineId = state.managingLine;
  const lines = ensureProjectLines(project);
  if (!lineId || !lines.some((line) => line.id === lineId)) return;
  project.lines = lines.filter((line) => line.id !== lineId);
  removeStoredValue(linePositionStorageKey(project.id, lineId));
  saveProjectLines(project);
  closeDialog(deleteLineDialog);
  state.managingLine = null;
  if (state.selectedLine === lineId && project.lines.length) {
    switchLine(project.lines[0].id, { savePrevious: false });
  } else if (state.selectedLine === lineId) {
    state.selectedLine = null;
    state.selectedNode = null;
    removeStoredValue(lineSelectionStorageKey(project.id));
    studioBody.classList.add("no-lines", "inspector-closed");
    applyCurrentLineDetails();
    renderLineList();
    renderNodes();
    renderInspector();
    updateRunButton();
  } else {
    renderLineList();
  }
  showToast("线路已删除；项目代码和复用连接不受影响");
});

$$('[data-focus-node]').forEach((button) => button.addEventListener("click", () => selectNode(button.dataset.focusNode)));

$("#zoomIn").addEventListener("click", () => { state.zoom = Math.min(1.4, state.zoom + 0.1); applyCanvasTransform(); });
$("#zoomOut").addEventListener("click", () => { state.zoom = Math.max(0.2, state.zoom - 0.1); applyCanvasTransform(); });
$("#fitCanvas").addEventListener("click", fitCanvas);
$("#zoomValue").addEventListener("click", fitCanvas);
$("#selectTool").addEventListener("click", () => setCanvasTool("select"));
$("#handTool").addEventListener("click", () => setCanvasTool("hand"));

let pan = null;
canvasViewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || state.canvasTool !== "hand") return;
  pan = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  canvasViewport.setPointerCapture?.(event.pointerId);
  canvasViewport.classList.add("panning");
});
canvasViewport.addEventListener("pointermove", (event) => {
  if (!pan) return;
  state.panX = pan.panX + event.clientX - pan.x;
  state.panY = pan.panY + event.clientY - pan.y;
  applyCanvasTransform();
});
function finishCanvasPan(event) {
  pan = null;
  canvasViewport.classList.remove("panning");
  if (typeof canvasViewport.releasePointerCapture === "function" && canvasViewport.hasPointerCapture?.(event.pointerId)) {
    canvasViewport.releasePointerCapture(event.pointerId);
  }
}
canvasViewport.addEventListener("pointerup", finishCanvasPan);
canvasViewport.addEventListener("pointercancel", finishCanvasPan);
canvasViewport.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  state.zoom = Math.min(1.4, Math.max(0.2, state.zoom + (event.deltaY < 0 ? 0.06 : -0.06)));
  applyCanvasTransform();
}, { passive: false });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    studioBody.classList.add("inspector-closed");
  }
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".line-actions")) return;
  $$(".line-row.menu-open", lineList).forEach((row) => {
    row.classList.remove("menu-open");
    $("[data-line-more]", row)?.setAttribute("aria-expanded", "false");
  });
});

window.addEventListener("resize", fitCanvas);

function resetAddProjectDialog() {
  $("#selectedProject").hidden = true;
  $("#addAndOpenProject").disabled = true;
}

function openAddProject() {
  resetAddProjectDialog();
  openDialog(addProjectDialog);
}

$("#addProjectButton").addEventListener("click", openAddProject);
[$("#closeAddProject"), $("#cancelAddProject")].forEach((button) => button.addEventListener("click", () => closeDialog(addProjectDialog)));
$("#chooseProjectFolder").addEventListener("click", () => {
  $("#selectedProject").hidden = false;
  $("#addAndOpenProject").disabled = false;
  showToast("项目识别完成：发现 2 个服务，已生成默认上线线路");
});
$("#addAndOpenProject").addEventListener("click", () => {
  let project = projects.find((item) => item.id === "customer-crm");
  if (!project) {
    project = {
      id: "customer-crm",
      name: "客户管理工具",
      icon: "客",
      path: "/Users/you/Projects/customer-crm",
      services: 2,
      status: "setup",
      scenario: "setup",
      address: "",
      updated: "刚刚添加",
      version: "尚未生成",
      nodeState: null,
    };
    projects.push(project);
  }
  closeDialog(addProjectDialog);
  renderHomeProjects();
  openWorkflow(project.id);
});

$$('[data-home-page]').forEach((button) => button.addEventListener("click", () => showHomePage(button.dataset.homePage)));
projectSearch.addEventListener("input", () => renderHomeProjects(projectSearch.value));
$("#stayInWorkflow").addEventListener("click", () => closeDialog(successDialog));
$("#successBackHome").addEventListener("click", () => {
  closeDialog(successDialog);
  showHome("projects");
});

renderHomeProjects();
setCanvasTool("select");
showHome("projects");
