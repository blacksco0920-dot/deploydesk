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
const runStepMs = window.__PROTOTYPE_TEST__ ? 5 : 900;

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
  build: [350, 280],
  artifact: [620, 280],
  deploy: [890, 280],
  deployBranch: [890, 500],
};

function makeNode(id, type, hidden = false) {
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
    hidden,
  };
}

const nodes = {
  source: makeNode("source", "source"),
  build: makeNode("build", "build"),
  artifact: makeNode("artifact", "artifact"),
  deploy: makeNode("deploy", "deploy"),
  deployBranch: makeNode("deployBranch", "deploy", true),
};

const edges = [
  ["source", "build"],
  ["build", "artifact"],
  ["artifact", "deploy"],
  ["artifact", "deployBranch"],
];

const state = {
  selectedNode: "build",
  inspectorMode: "view",
  scenario: "ready",
  zoom: 0.86,
  panX: 16,
  panY: 36,
  timers: [],
  selectedCandidate: null,
};

const studioBody = $("#studioBody");
const canvasViewport = $("#canvasViewport");
const canvasWorld = $("#canvasWorld");
const nodeLayer = $("#nodeLayer");
const edgeLayer = $("#edgeLayer");
const inspectorContent = $("#inspectorContent");
const inspectorFooter = $("#inspectorFooter");
const inspectorTitle = $("#inspectorTitle");
const inspectorType = $("#inspectorType");
const inspectorIcon = $("#inspectorIcon");
const nodeLibrary = $("#nodeLibrary");
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

function currentProject() {
  return projects.find((project) => project.id === currentProjectId) || null;
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
    project.status = visibleNodes().every((node) => node.config === "ready") ? "ready" : "setup";
  }
}

function openWorkflow(projectId) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  const resumingLiveRun = currentProjectId === projectId && project.status === "running" && state.timers.length > 0;
  currentProjectId = projectId;
  homeView.hidden = true;
  workflowView.hidden = false;
  $("#workflowProjectName").textContent = project.name;
  if (!resumingLiveRun) {
    if (project.nodeState) {
      clearTimers();
      restoreNodes(project.nodeState);
      syncCurrentProjectToSource();
      const firstBroken = visibleNodes().find((node) => node.config !== "ready");
      selectNode(firstBroken?.id || "build");
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
  window.requestAnimationFrame(fitCanvas);
}

function visibleNodes() {
  return Object.values(nodes).filter((node) => !node.hidden);
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
  return { source: "</>", build: "⚙", artifact: "◇", deploy: "▤" }[type];
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
            <span class="node-status ${node.config}">${status}</span>
          </div>
          <p class="node-description">${meta.description}</p>
          <div class="node-fact"><b>${escapeHtml(node.connection)}</b><span class="run-${node.run}">${runLabel(node.run)}</span></div>
        </article>`;
    })
    .join("");

  $$(".workflow-node", nodeLayer).forEach((element) => {
    let drag = null;
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const node = nodes[element.dataset.nodeId];
      drag = { startX: node.x, startY: node.y, x: event.clientX, y: event.clientY, moved: false };
      element.setPointerCapture(event.pointerId);
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
    element.addEventListener("pointerup", () => {
      if (!drag?.moved) selectNode(element.dataset.nodeId);
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
  const paths = edges
    .filter(([sourceId, targetId]) => !nodes[sourceId].hidden && !nodes[targetId].hidden)
    .map(([sourceId, targetId]) => {
      const source = nodes[sourceId];
      const target = nodes[targetId];
      const x1 = source.x + 220;
      const y1 = source.y + 71;
      const x2 = target.x;
      const y2 = target.y + 71;
      const curve = Math.max(70, Math.abs(x2 - x1) * 0.48);
      let edgeState = "";
      if (source.run === "success" && target.run === "success") edgeState = "success";
      if (target.run === "running") edgeState = "running";
      return `<path class="edge-path ${edgeState}" d="M${x1} ${y1} C${x1 + curve} ${y1},${x2 - curve} ${y2},${x2} ${y2}"></path>`;
    })
    .join("");
  edgeLayer.innerHTML = markup + paths;
}

function applyCanvasTransform() {
  canvasWorld.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitCanvas() {
  const width = canvasViewport.clientWidth || 760;
  const requiredWidth = nodes.deployBranch.hidden ? 1190 : 1190;
  state.zoom = Math.min(1, Math.max(0.58, (width - 50) / requiredWidth));
  state.panX = 18;
  state.panY = nodes.deployBranch.hidden ? 34 : -10;
  applyCanvasTransform();
}

function selectNode(id, mode) {
  if (!nodes[id] || nodes[id].hidden) return;
  state.selectedNode = id;
  const node = nodes[id];
  state.inspectorMode = mode || (node.config === "expired" ? "repair" : node.config === "missing" ? "select" : "view");
  state.selectedCandidate = node.connection;
  studioBody.classList.remove("inspector-closed");
  nodeLibrary.hidden = true;
  renderNodes();
  renderInspector();
}

function renderInspector() {
  const node = nodes[state.selectedNode];
  const meta = providerCatalog[node.type];
  inspectorTitle.textContent = meta.title;
  inspectorType.textContent = meta.title;
  inspectorIcon.textContent = nodeGlyph(node.type);

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
    <div class="notice info" style="margin-top:12px"><strong>连接可以复用</strong>这个节点保存的是连接引用；凭据由配置中心和系统密钥库统一维护。</div>`;
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
    if (id === "deployBranch") node.hidden = true;
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
  }
  renderNodes();
  updateRunButton();
  fitCanvas();
  persistCurrentWorkflow();
}

function updateRunButton() {
  const broken = visibleNodes().find((node) => node.config !== "ready");
  const project = currentProject();
  const running = project?.status === "running" || visibleNodes().some((node) => node.run === "running" || node.run === "pending");
  runButton.disabled = running;
  runButtonText.textContent = running ? "正在上线" : broken ? "继续准备" : project?.status === "online" ? "更新上线" : "开始上线";
}

function startRun() {
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

function addDeploymentBranch() {
  const branch = nodes.deployBranch;
  if (!branch.hidden) {
    selectNode("deployBranch");
    showToast("这条线路已经有第二个部署运行节点");
    return;
  }
  branch.hidden = false;
  branch.connection = "尚未选择服务器";
  branch.detail = "";
  branch.config = "missing";
  branch.fact = "等待设置访问地址";
  nodeLibrary.hidden = true;
  selectNode("deployBranch", "select");
  fitCanvas();
  persistCurrentWorkflow();
  showToast("已添加部署运行节点，可以选择另一台服务器");
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
$("#addNodeButton").addEventListener("click", () => {
  nodeLibrary.hidden = !nodeLibrary.hidden;
  if (!nodeLibrary.hidden) $("#nodeSearch").focus();
});
$("#connectionsTab").addEventListener("click", () => showHome("connections"));
$("#addLineButton").addEventListener("click", () => showToast("新线路会自动生成四类基础节点，只需选择目标服务器"));

$$('[data-focus-node]').forEach((button) => button.addEventListener("click", () => selectNode(button.dataset.focusNode)));
$$('[data-library-node]').forEach((button) => button.addEventListener("click", () => {
  const type = button.dataset.libraryNode;
  if (type === "deploy") addDeploymentBranch();
  else {
    selectNode(type);
    showToast(`当前线路已经包含“${providerCatalog[type].title}”节点`);
  }
}));

$("#nodeSearch").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  $$('[data-library-node]').forEach((button) => {
    button.hidden = query && !button.textContent.toLowerCase().includes(query);
  });
});

$$('[data-line]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-line]').forEach((row) => row.classList.toggle("active", row === button));
  const test = button.dataset.line === "test";
  $("#canvasLineName").textContent = test ? "测试服务器" : "上线";
  nodes.deploy.connection = test ? "测试服务器" : "腾讯云新服务器";
  nodes.deploy.detail = test ? "42.193.229.35 · ubuntu" : "119.91.112.80 · ubuntu";
  nodes.deploy.fact = test ? "3 个服务 · 1 个地址" : "3 个服务 · 3 个地址";
  renderNodes();
  if (state.selectedNode === "deploy") renderInspector();
  persistCurrentWorkflow();
}));

$("#zoomIn").addEventListener("click", () => { state.zoom = Math.min(1.4, state.zoom + 0.1); applyCanvasTransform(); });
$("#zoomOut").addEventListener("click", () => { state.zoom = Math.max(0.5, state.zoom - 0.1); applyCanvasTransform(); });
$("#fitCanvas").addEventListener("click", fitCanvas);
$("#zoomValue").addEventListener("click", fitCanvas);

let pan = null;
canvasViewport.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".workflow-node")) return;
  pan = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  canvasViewport.setPointerCapture(event.pointerId);
  canvasViewport.classList.add("panning");
  nodeLibrary.hidden = true;
});
canvasViewport.addEventListener("pointermove", (event) => {
  if (!pan) return;
  state.panX = pan.panX + event.clientX - pan.x;
  state.panY = pan.panY + event.clientY - pan.y;
  applyCanvasTransform();
});
canvasViewport.addEventListener("pointerup", () => { pan = null; canvasViewport.classList.remove("panning"); });
canvasViewport.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  state.zoom = Math.min(1.4, Math.max(0.5, state.zoom + (event.deltaY < 0 ? 0.06 : -0.06)));
  applyCanvasTransform();
}, { passive: false });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!nodeLibrary.hidden) nodeLibrary.hidden = true;
    else studioBody.classList.add("inspector-closed");
  }
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
showHome("projects");
