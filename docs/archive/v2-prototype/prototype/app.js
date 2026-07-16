const STORAGE_KEY = "deploydesk-v2-prototype";

const defaultState = {
  view: "home",
  cnbConnected: false,
  serverConnected: false,
  serverHost: "203.0.113.24",
  stagingDomain: "preview.demo.example.cn",
  productionDomain: "app.demo.example.cn",
  migrateData: false,
  deployIndex: 0,
};

let state = loadState();
let transitionTimer;

const app = document.querySelector("#app");
const scenarioButton = document.querySelector("#scenario-button");
const scenarioMenu = document.querySelector("#scenario-menu");

function loadState() {
  try {
    return {
      ...defaultState,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY)),
    };
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }
}

function setState(patch, shouldRender = true) {
  state = { ...state, ...patch };
  saveState();
  if (shouldRender) render();
}

function go(view, patch = {}) {
  window.clearTimeout(transitionTimer);
  setState({ ...patch, view });
}

function brand(dark = false) {
  return `
    <button class="brand-lockup text-button" type="button" data-go="home" aria-label="返回项目首页">
      <span class="brand-mark">${icon("layers-3")}</span>
      <span class="brand-copy">
        <strong>ABCDeploy</strong>
        <span>${dark ? "部署工作台" : "让上线更清楚"}</span>
      </span>
    </button>
  `;
}

function sidebar(active = "projects") {
  const projectMode = active === "project";
  const navigation = projectMode
    ? `
        <button class="workspace-back" type="button" data-go="home">${icon("arrow-left")}所有项目</button>
        <div class="project-context"><span>当前项目</span><strong>内容发布助手</strong></div>
        <nav class="sidebar-nav" aria-label="项目导航">
          <span class="sidebar-label">项目管理</span>
          <button class="nav-button active" type="button">${icon("layout-dashboard")}<span>项目</span></button>
          <button class="nav-button" type="button">${icon("rocket")}<span>部署</span></button>
          <button class="nav-button" type="button">${icon("boxes")}<span>环境</span></button>
          <button class="nav-button" type="button">${icon("plug-zap")}<span>资源</span></button>
          <button class="nav-button" type="button">${icon("settings")}<span>设置</span></button>
        </nav>
      `
    : `
        <nav class="sidebar-nav" aria-label="主导航">
          <span class="sidebar-label">工作区</span>
          <button class="nav-button ${active === "projects" ? "active" : ""}" type="button" data-go="home">
            ${icon("layout-dashboard")}<span>项目</span>
          </button>
          <button class="nav-button ${active === "activity" ? "active" : ""}" type="button">
            ${icon("activity")}<span>部署动态</span>
          </button>
          <button class="nav-button ${active === "resources" ? "active" : ""}" type="button">
            ${icon("plug-zap")}<span>资源</span>
          </button>
        </nav>
      `;

  return `
    <aside class="sidebar">
      ${brand(true)}
      ${navigation}
      <div class="sidebar-account">
        <span class="avatar">D</span>
        <div><strong>本机工作区</strong><span>2 个项目</span></div>
        ${icon("chevron-right")}
      </div>
    </aside>
  `;
}

function home() {
  return `
    <div class="app-frame home-shell">
      ${sidebar("projects")}
      <section class="workspace">
        <header class="topbar">
          <h1>项目</h1>
          <div class="topbar-actions">
            <button class="icon-button" type="button" title="设置" aria-label="设置">${icon("settings")}</button>
          </div>
        </header>
        <main class="content-scroll">
          <div class="home-content">
            <div class="page-heading">
              <div>
                <h2>继续你的项目</h2>
                <p>上次的连接和部署状态已经为你保留。</p>
              </div>
              <button class="primary-button" type="button" data-go="choose">
                ${icon("plus")}添加项目
              </button>
            </div>
            <div class="section-title">
              <h3>最近项目</h3><span>最后更新于今天 11:42</span>
            </div>
            <div class="project-list">
              <button class="project-card" type="button" data-go="workbench">
                <span class="project-icon">${icon("package")}</span>
                <span class="project-copy">
                  <strong>客户门户</strong>
                  <span class="project-meta">
                    <span class="status-inline">${icon("circle-check")}测试环境正常</span>
                    <span>生产环境待发布</span>
                  </span>
                </span>
                ${icon("chevron-right")}
              </button>
              <button class="project-card" type="button" data-go="workbench">
                <span class="project-icon">${icon("panels-top-left")}</span>
                <span class="project-copy">
                  <strong>内容助手</strong>
                  <span class="project-meta">
                    <span class="status-inline">${icon("circle-check")}生产环境正常</span>
                    <span>2 小时前部署</span>
                  </span>
                </span>
                ${icon("chevron-right")}
              </button>
            </div>
            <div class="section-title">
              <h3>已连接资源</h3><span>新项目可以直接复用</span>
            </div>
            <div class="resource-strip">
              <div class="resource-item">${icon("git-branch")}<div><strong>CNB</strong><span>Blacksco · 授权正常</span></div></div>
              <div class="resource-item">${icon("server")}<div><strong>个人云服务器</strong><span>连接正常 · Ubuntu 24.04</span></div></div>
              <div class="resource-item">${icon("container")}<div><strong>腾讯云镜像仓库</strong><span>finagent · 可用</span></div></div>
            </div>
          </div>
        </main>
      </section>
    </div>
  `;
}

const onboardingMeta = {
  choose: ["添加项目", "选择代码所在的位置", 1],
  scanning: ["识别项目", "正在读取项目结构", 1],
  detected: ["识别项目", "确认系统识别的结果", 1],
  cnb: ["连接服务", "授权源码托管与自动构建", 2],
  server: ["连接服务", "连接运行应用的服务器", 2],
  plan: ["推荐方案", "确认测试与生产安排", 3],
  info: ["补充信息", "只填写系统无法推断的内容", 4],
  review: ["准备部署", "确认将要发生的修改", 5],
};

function onboardingShell(
  content,
  { view = state.view, wide = false, footer = "" } = {},
) {
  const [title, subtitle, step] = onboardingMeta[view] || onboardingMeta.choose;
  const segments = Array.from({ length: 5 }, (_, index) => {
    const segment = index + 1;
    const status = segment < step ? "done" : segment === step ? "active" : "";
    return `<span class="progress-segment ${status}"></span>`;
  }).join("");

  return `
    <div class="app-frame onboarding-shell">
      <header class="onboarding-header">
        ${brand()}
        <div class="step-summary">
          <strong>${title}</strong><span>${subtitle}</span>
          <div class="progress-line" aria-label="第 ${step} 步，共 5 步">${segments}</div>
        </div>
        <button class="text-button header-exit" type="button" data-go="home">保存并退出</button>
      </header>
      <main class="onboarding-main">
        <div class="onboarding-content ${wide ? "wide" : ""}">${content}</div>
      </main>
      <footer class="onboarding-footer">${footer}</footer>
    </div>
  `;
}

function footer({
  back,
  primary,
  action,
  disabled = false,
  note = "进度会自动保存",
}) {
  return `
    <span class="footer-note">${icon("shield-check")} ${note}</span>
    <div class="footer-actions">
      ${back ? `<button class="secondary-button" type="button" data-go="${back}">${icon("arrow-left")}返回</button>` : ""}
      <button class="primary-button" type="button" data-action="${action}" ${disabled ? "disabled" : ""}>
        ${primary}${icon("arrow-right")}
      </button>
    </div>
  `;
}

function chooseProject() {
  const content = `
    <div class="eyebrow">第 1 步</div>
    <h1>你的项目代码在哪里？</h1>
    <p class="lead">ABCDeploy 会先只读检查项目，不会修改文件。识别完成后，你再决定是否继续。</p>
    <div class="option-list">
      <button class="option-card" type="button" data-action="select-local">
        <span class="option-icon">${icon("folder-open")}</span>
        <span class="option-copy"><strong>选择本机项目</strong><span>从这台电脑上的代码目录开始</span></span>
        ${icon("chevron-right")}
      </button>
      <button class="option-card" type="button" data-action="select-git">
        <span class="option-icon">${icon("git-fork")}</span>
        <span class="option-copy"><strong>从 Git 地址导入</strong><span>适合代码还没有下载到这台电脑</span></span>
        ${icon("chevron-right")}
      </button>
    </div>
    <div class="file-selection">${icon("clock-3")}最近使用：Documents / MyProjects</div>
  `;
  return onboardingShell(content, {
    footer: `<span class="footer-note">${icon("lock-keyhole")}识别阶段不会运行项目代码</span><div></div>`,
  });
}

function scanning() {
  const content = `
    <div class="scan-panel">
      <span class="scan-spinner">${icon("refresh-cw")}</span>
      <h2>正在识别“内容发布助手”</h2>
      <p>只读取项目结构，通常不到一分钟。</p>
      <div class="scan-list">
        <div class="scan-row">${icon("circle-check")}<span>找到项目根目录</span><span>已完成</span></div>
        <div class="scan-row">${icon("circle-check")}<span>识别前端与后端</span><span>已完成</span></div>
        <div class="scan-row">${icon("circle-check")}<span>检查 Git 仓库</span><span>已完成</span></div>
        <div class="scan-row pending">${icon("loader-circle")}<span>生成部署建议</span><span>进行中</span></div>
      </div>
    </div>
  `;
  transitionTimer = window.setTimeout(() => go("detected"), 1400);
  return onboardingShell(content, {
    footer: `<span class="footer-note">${icon("shield-check")}不会修改或上传任何文件</span><div></div>`,
  });
}

function detected() {
  const content = `
    <div class="eyebrow">识别完成</div>
    <h1>我们已经理解这个项目</h1>
    <p class="lead">下面是将用于生成部署方案的结果。你只需要确认它们是否符合预期。</p>
    <div class="result-list">
      <div class="result-item">${icon("panels-top-left")}<div><strong>Vue 3 前端</strong><span>使用 pnpm 构建静态页面</span></div></div>
      <div class="result-item">${icon("braces")}<div><strong>Node.js API</strong><span>运行一个后端服务</span></div></div>
      <div class="result-item">${icon("database")}<div><strong>PostgreSQL</strong><span>项目需要关系型数据库</span></div></div>
      <div class="result-item">${icon("git-branch")}<div><strong>main 分支</strong><span>尚未配置测试环境</span></div></div>
    </div>
    <div class="notice">${icon("info")}<span>发现一个前端和一个 API。ABCDeploy 会分别提供访问地址，但仍把它们作为同一个项目管理。</span></div>
    <button class="text-button" type="button">有一项不对</button>
  `;
  return onboardingShell(content, {
    wide: true,
    footer: footer({
      back: "choose",
      primary: "结果正确，继续",
      action: "confirm-detected",
    }),
  });
}

function cnbConnection() {
  const connected = state.cnbConnected;
  const content = `
    <div class="eyebrow">连接 1 / 2</div>
    <h1>${connected ? "CNB 已连接" : "连接 CNB，自动构建每个版本"}</h1>
    <p class="lead">授权后，ABCDeploy 可以为这个项目准备仓库和构建流程。你会在浏览器中登录并确认权限。</p>
    <div class="connection-panel ${connected ? "connected" : ""}">
      <div class="connection-heading">
        <div class="connection-identity">
          ${connected ? '<span class="avatar">B</span>' : icon("git-branch")}
          <div><strong>${connected ? "Blacksco" : "CNB 账号"}</strong><span>${connected ? "授权有效 · 可随时撤销" : "尚未连接"}</span></div>
        </div>
        ${connected ? `<span class="status-inline">${icon("circle-check")}连接正常</span>` : `<button class="primary-button" type="button" data-action="connect-cnb">${icon("external-link")}登录 CNB 并授权</button>`}
      </div>
      <div class="permission-list">
        <div class="permission-item">${icon("check")}读取仓库信息</div>
        <div class="permission-item">${icon("check")}配置自动构建</div>
        <div class="permission-item">${icon("check")}查看部署状态</div>
      </div>
    </div>
    ${connected ? `<div class="notice success">${icon("shield-check")}<span>权限检查通过。访问凭据已保存在这台电脑的系统密钥库中，不会写入项目文件。</span></div>` : `<div class="notice">${icon("shield-check")}<span>ABCDeploy 不会读取你的 CNB 密码。授权页面由 CNB 提供，完成后会自动返回这里。</span></div><button class="text-button" type="button" data-action="show-token-fallback">无法使用网页登录？</button>`}
  `;
  return onboardingShell(content, {
    footer: footer({
      back: "detected",
      primary: "继续连接服务器",
      action: "continue-server",
      disabled: !connected,
    }),
  });
}

function serverConnection() {
  const connected = state.serverConnected;
  const content = `
    <div class="eyebrow">连接 2 / 2</div>
    <h1>${connected ? "服务器连接成功" : "连接运行应用的服务器"}</h1>
    <p class="lead">输入服务器 IP 或域名即可。ABCDeploy 会先自动寻找这台电脑上已有的安全连接。</p>
    <div class="connection-panel ${connected ? "connected" : ""}">
      <div class="field-group">
        <label for="server-host">服务器 IP 或域名</label>
        <input class="text-input" id="server-host" value="${state.serverHost}" autocomplete="off" />
        <p class="field-hint">可以在云服务器控制台的实例详情中找到公网 IP。</p>
      </div>
      <div class="server-discovery">
        <div>${icon(connected ? "shield-check" : "key-round")}<span><strong>${connected ? "ABCDeploy 安全连接" : "未找到可用的 SSH Key"}</strong><span>${connected ? "专用密钥已生成并验证，后续无需密码" : "可以自动创建，不需要手工寻找私钥文件"}</span></span></div>
        ${connected ? `<span class="status-inline">${icon("circle-check")}已验证</span>` : `<button class="primary-button" type="button" data-action="create-server-key">${icon("key-round")}创建安全连接</button>`}
      </div>
    </div>
    ${connected ? `<div class="notice success">${icon("circle-check")}<span>连接成功：Ubuntu 24.04 · Docker 可安装 · 80/443 端口可用。</span></div>` : `<div class="notice">${icon("info")}<span>如果服务器只允许密码登录，密码仅用于首次安装公钥，成功后立即清除。</span></div>`}
    <details class="advanced"><summary>其他连接方式</summary><p class="field-hint">可手工选择私钥，文件选择器会直接打开系统常用的 SSH 目录。</p></details>
  `;
  return onboardingShell(content, {
    footer: footer({
      back: "cnb",
      primary: "生成推荐方案",
      action: "continue-plan",
      disabled: !connected,
    }),
  });
}

function recommendedPlan() {
  const content = `
    <div class="eyebrow">已为当前项目生成</div>
    <h1>推荐这样安排测试和生产</h1>
    <p class="lead">这是多数小型 Web 项目更稳妥的做法。现在采用，后续仍可调整。</p>
    <div class="plan-layout">
      <section class="plan-card">
        <span class="plan-badge">推荐方案</span>
        <h2>先自动测试，再确认发布生产</h2>
        <p>每次 main 更新只构建一次。测试通过后，生产发布使用同一个已验证版本。</p>
        <div class="environment-flow">
          <div class="environment-step"><span class="environment-number">1</span><strong>本地开发</strong><span>在你的电脑上快速调试</span></div>
          <div class="environment-step"><span class="environment-number">2</span><strong>测试环境</strong><span>main 更新后自动部署</span></div>
          <div class="environment-step"><span class="environment-number">3</span><strong>生产环境</strong><span>确认后发布同一版本</span></div>
        </div>
      </section>
      <aside class="plan-aside">
        <h3>系统会自动处理</h3>
        <ul class="check-list">
          <li>${icon("check")}<span>生成容器构建与 CNB 流程</span></li>
          <li>${icon("check")}<span>用 Caddy 配置域名和 HTTPS</span></li>
          <li>${icon("check")}<span>隔离测试与生产的数据和配置</span></li>
          <li>${icon("check")}<span>健康检查失败时保留旧版本</span></li>
          <li>${icon("check")}<span>记录每次发布对应的代码版本</span></li>
        </ul>
      </aside>
    </div>
    <button class="text-button" type="button">为什么这样安排？</button>
    <button class="text-button" type="button">调整方案</button>
  `;
  return onboardingShell(content, {
    wide: true,
    footer: footer({
      back: "server",
      primary: "使用推荐方案",
      action: "continue-info",
    }),
  });
}

function requiredInfo() {
  const content = `
    <div class="eyebrow">还差 2 项</div>
    <h1>补充项目的访问地址</h1>
    <p class="lead">其余配置已使用推荐值。正式域名和数据迁移可以稍后再处理。</p>
    <section class="form-section">
      <h2>访问地址</h2>
      <p>域名用于从浏览器访问测试和生产环境。</p>
      <div class="field-grid">
        <div class="field-group">
          <label for="staging-domain">测试域名</label>
          <input class="text-input" id="staging-domain" value="${state.stagingDomain}" />
          <p class="field-hint">DNS 未生效也可以先继续，系统会自动等待。</p>
        </div>
        <div class="field-group">
          <label for="production-domain">正式域名</label>
          <input class="text-input" id="production-domain" value="${state.productionDomain}" />
          <p class="field-hint">只保存，不会在首次流程中发布生产。</p>
        </div>
      </div>
    </section>
    <section class="form-section">
      <h2>已有数据</h2>
      <p>新项目通常不需要迁移；已有线上数据库时再开启。</p>
      <div class="toggle-row">
        <span class="toggle-copy"><strong>迁移已有数据库</strong><span>开启后会在部署前单独检查备份与目标数据库</span></span>
        <button class="toggle ${state.migrateData ? "on" : ""}" type="button" data-action="toggle-migration" role="switch" aria-checked="${state.migrateData}" aria-label="迁移已有数据库"></button>
      </div>
    </section>
    <details class="advanced"><summary>高级环境变量</summary><p class="field-hint">只有项目无法自动识别的第三方服务凭据才需要在这里补充。</p></details>
  `;
  return onboardingShell(content, {
    footer: footer({
      back: "plan",
      primary: "检查部署内容",
      action: "continue-review",
    }),
  });
}

function review() {
  const content = `
    <div class="eyebrow">准备就绪</div>
    <h1>部署到测试环境</h1>
    <p class="lead">请确认下面的结果。首次部署不会修改生产环境，也不会删除服务器上的现有服务。</p>
    <div class="review-layout">
      <div>
        <section class="review-section">
          <h2>${icon("git-branch")}CNB</h2>
          <div class="review-row"><span>代码仓库</span><strong>创建内容发布助手仓库</strong></div>
          <div class="review-row"><span>自动构建</span><strong>main 更新后构建并部署测试环境</strong></div>
          <div class="review-row"><span>生产发布</span><strong>测试通过后由你确认</strong></div>
        </section>
        <section class="review-section">
          <h2>${icon("server")}个人云服务器</h2>
          <div class="review-row"><span>基础组件</span><strong>安装 Docker，复用已有 Caddy</strong></div>
          <div class="review-row"><span>项目目录</span><strong>创建独立目录和数据卷</strong></div>
          <div class="review-row"><span>现有服务</span><strong>不会停止或删除</strong></div>
        </section>
        <section class="review-section">
          <h2>${icon("globe-2")}访问与数据</h2>
          <div class="review-row"><span>测试地址</span><strong>${state.stagingDomain}</strong></div>
          <div class="review-row"><span>HTTPS</span><strong>域名生效后自动签发</strong></div>
          <div class="review-row"><span>数据库</span><strong>新建测试数据库，与生产隔离</strong></div>
        </section>
      </div>
      <aside class="impact-panel">
        <h2>本次影响</h2>
        <div class="impact-stat"><span>新增资源</span><strong>5 项</strong></div>
        <div class="impact-stat"><span>修改现有服务</span><strong>0 项</strong></div>
        <div class="impact-stat"><span>删除内容</span><strong>0 项</strong></div>
        <div class="notice success">${icon("shield-check")}<span>健康检查失败时不会替换当前正常版本。</span></div>
      </aside>
    </div>
  `;
  return onboardingShell(content, {
    wide: true,
    footer: footer({
      back: "info",
      primary: "部署到测试环境",
      action: "start-deploy",
      note: "部署期间可以关闭应用",
    }),
  });
}

const deploySteps = [
  ["准备服务器", "检查 Docker、目录和可用端口"],
  ["构建应用镜像", "CNB 正在生成可重复部署的版本"],
  ["启动测试环境", "创建独立容器、数据库和存储"],
  ["配置域名和 HTTPS", "Caddy 正在验证域名并申请证书"],
  ["运行健康检查", "确认前端、API 和数据库可以正常工作"],
];

function deploying() {
  const rows = deploySteps
    .map(([title, description], index) => {
      const isDone = index < state.deployIndex;
      const isActive = index === state.deployIndex;
      const statusClass = isDone ? "done" : isActive ? "active" : "";
      const rowIcon = isDone ? "check" : isActive ? "loader-circle" : "circle";
      const status = isDone ? "已完成" : isActive ? "进行中" : "等待";
      return `<div class="timeline-row ${statusClass}"><span class="timeline-icon">${icon(rowIcon)}</span><span class="timeline-copy"><strong>${title}</strong><span>${description}</span></span><span class="timeline-status">${status}</span></div>`;
    })
    .join("");

  if (state.deployIndex < deploySteps.length) {
    transitionTimer = window.setTimeout(() => {
      if (state.deployIndex + 1 >= deploySteps.length) {
        go("success", { deployIndex: deploySteps.length });
      } else {
        setState({ deployIndex: state.deployIndex + 1 });
      }
    }, 1500);
  }

  return `
    <div class="app-frame deployment-shell">
      <header class="deployment-header">${brand()}<button class="text-button" type="button" data-go="home">关闭窗口</button></header>
      <main class="deployment-content">
        <div class="deployment-heading">
          <span class="large-status running">${icon("loader-circle")}</span>
          <h1>正在部署测试环境</h1>
          <p>关闭 ABCDeploy 不会中断任务，下次打开会回到这里。</p>
        </div>
        <div class="timeline">${rows}</div>
        <div class="deployment-actions">
          <button class="text-button" type="button">${icon("terminal")}技术详情</button>
        </div>
      </main>
    </div>
  `;
}

function success() {
  return `
    <div class="app-frame deployment-shell">
      <header class="deployment-header">${brand()}<button class="text-button" type="button" data-go="home">返回项目首页</button></header>
      <main class="deployment-content">
        <div class="deployment-heading">
          <span class="large-status success">${icon("circle-check")}</span>
          <h1>测试环境已经可以访问</h1>
          <p>内容发布助手 · main · 版本 8f3c21a</p>
        </div>
        <div class="success-url">
          <div><span>测试地址</span><strong>https://${state.stagingDomain}</strong></div>
          <button class="primary-button" type="button">${icon("external-link")}打开测试环境</button>
        </div>
        <div class="timeline">
          ${deploySteps.map(([title, description]) => `<div class="timeline-row done"><span class="timeline-icon">${icon("check")}</span><span class="timeline-copy"><strong>${title}</strong><span>${description}</span></span><span class="timeline-status">已完成</span></div>`).join("")}
        </div>
        <div class="notice">${icon("info")}<span>以后 main 分支更新会自动部署到测试环境。生产环境仍需你确认，不会自动发布。</span></div>
        <div class="deployment-actions">
          <button class="secondary-button" type="button" data-go="home">返回项目首页</button>
          <button class="primary-button" type="button" data-go="workbench">进入项目工作台${icon("arrow-right")}</button>
        </div>
      </main>
    </div>
  `;
}

function dnsError() {
  return `
    <div class="app-frame deployment-shell">
      <header class="deployment-header">${brand()}<button class="text-button" type="button" data-go="home">保存并退出</button></header>
      <main class="deployment-content">
        <div class="deployment-heading">
          <span class="large-status warning">${icon("triangle-alert")}</span>
          <h1>等待域名指向这台服务器</h1>
          <p>应用已经运行，数据没有丢失。完成 DNS 设置后会自动继续。</p>
        </div>
        <div class="error-guide">
          <div class="error-step"><span class="error-step-number">1</span><div><strong>系统已经完成</strong><p>应用、数据库和 Caddy 配置均已准备好，当前无需重新部署。</p></div></div>
          <div class="error-step"><span class="error-step-number">2</span><div><strong>请在 DNS 控制台修改一条记录</strong><p>把测试域名的 A 记录指向下面的服务器 IP。</p><div class="copy-value"><span>203.0.113.24</span><button type="button" data-action="copy-ip" title="复制 IP" aria-label="复制 IP">${icon("copy")}</button></div></div></div>
          <div class="error-step"><span class="error-step-number">3</span><div><strong>ABCDeploy 会自动复查</strong><p>每 30 秒检查一次。解析生效后将继续配置 HTTPS 和健康检查。</p></div></div>
        </div>
        <div class="deployment-actions">
          <button class="secondary-button" type="button" data-go="home">稍后处理</button>
          <button class="primary-button" type="button" data-action="retry-dns">${icon("refresh-cw")}立即复查</button>
        </div>
        <button class="text-button" type="button">${icon("circle-help")}在哪里修改 DNS？</button>
      </main>
    </div>
  `;
}

function workbench() {
  return `
    <div class="app-frame home-shell">
      ${sidebar("project")}
      <section class="workspace">
        <header class="topbar">
          <h1>内容发布助手</h1>
          <div class="topbar-actions"><button class="secondary-button" type="button">${icon("rocket")}部署新版本</button><button class="icon-button" type="button" title="项目设置" aria-label="项目设置">${icon("settings")}</button></div>
        </header>
        <main class="content-scroll">
          <div class="home-content">
            <div class="page-heading">
              <div><h2>项目运行正常</h2><p>测试环境已是最新版本，生产环境尚未首次发布。</p></div>
              <button class="primary-button" type="button">${icon("external-link")}打开测试环境</button>
            </div>
            <div class="workbench-grid">
              <div>
                <section class="environment-band">
                  <div class="environment-band-header"><h3>测试环境</h3><span>${icon("circle-check")}运行正常</span></div>
                  <div class="environment-address">https://${state.stagingDomain}</div>
                  <div class="environment-details"><div><span>当前版本</span><strong>8f3c21a</strong></div><div><span>部署时间</span><strong>今天 11:42</strong></div><div><span>自动部署</span><strong>main 更新后</strong></div></div>
                </section>
                <section class="environment-band">
                  <div class="environment-band-header"><h3>生产环境</h3><span class="pending">${icon("clock-3")}等待首次发布</span></div>
                  <div class="environment-address">https://${state.productionDomain}</div>
                  <div class="environment-details"><div><span>待发布版本</span><strong>8f3c21a</strong></div><div><span>发布方式</span><strong>手工确认</strong></div><div><span>数据</span><strong>与测试隔离</strong></div></div>
                </section>
              </div>
              <aside class="activity-panel">
                <h3>最近动态</h3>
                <div class="activity-item"><span class="activity-dot"></span><div><strong>测试环境部署成功</strong><span>版本 8f3c21a · 今天 11:42</span></div></div>
                <div class="activity-item"><span class="activity-dot"></span><div><strong>健康检查通过</strong><span>前端、API 和数据库均正常</span></div></div>
                <div class="activity-item"><span class="activity-dot"></span><div><strong>CNB 自动构建完成</strong><span>耗时 2 分 18 秒</span></div></div>
              </aside>
            </div>
          </div>
        </main>
      </section>
    </div>
  `;
}

const views = {
  home,
  choose: chooseProject,
  scanning,
  detected,
  cnb: cnbConnection,
  server: serverConnection,
  plan: recommendedPlan,
  info: requiredInfo,
  review,
  deploying,
  success,
  "dns-error": dnsError,
  workbench,
};

function render() {
  const view = views[state.view] || home;
  app.innerHTML = view();
  refreshIcons();
}

document.addEventListener("click", async (event) => {
  const goTarget = event.target.closest("[data-go]");
  if (goTarget) {
    go(goTarget.dataset.go);
    return;
  }

  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;

  const action = actionTarget.dataset.action;
  if (action === "select-local" || action === "select-git") go("scanning");
  if (action === "confirm-detected") go("cnb");
  if (action === "connect-cnb") {
    actionTarget.disabled = true;
    actionTarget.innerHTML = `${icon("loader-circle")}正在等待浏览器授权`;
    refreshIcons();
    transitionTimer = window.setTimeout(
      () => setState({ cnbConnected: true }),
      900,
    );
  }
  if (action === "show-token-fallback") {
    window.open(
      "https://cnb.cool/profile/token",
      "_blank",
      "noopener,noreferrer",
    );
  }
  if (action === "continue-server") go("server");
  if (action === "create-server-key") {
    const hostInput = document.querySelector("#server-host");
    setState({ serverHost: hostInput?.value || state.serverHost }, false);
    actionTarget.disabled = true;
    actionTarget.innerHTML = `${icon("loader-circle")}正在创建`;
    refreshIcons();
    transitionTimer = window.setTimeout(
      () => setState({ serverConnected: true }),
      1000,
    );
  }
  if (action === "continue-plan") {
    const hostInput = document.querySelector("#server-host");
    go("plan", { serverHost: hostInput?.value || state.serverHost });
  }
  if (action === "continue-info") go("info");
  if (action === "toggle-migration")
    setState({ migrateData: !state.migrateData });
  if (action === "continue-review") {
    const stagingDomain = document
      .querySelector("#staging-domain")
      ?.value.trim();
    const productionDomain = document
      .querySelector("#production-domain")
      ?.value.trim();
    go("review", {
      stagingDomain: stagingDomain || state.stagingDomain,
      productionDomain: productionDomain || state.productionDomain,
    });
  }
  if (action === "start-deploy") go("deploying", { deployIndex: 0 });
  if (action === "retry-dns") go("deploying", { deployIndex: 3 });
  if (action === "copy-ip") {
    await navigator.clipboard?.writeText("203.0.113.24");
    actionTarget.innerHTML = icon("check");
    refreshIcons();
  }
});

scenarioButton.addEventListener("click", () => {
  scenarioMenu.hidden = !scenarioMenu.hidden;
});

scenarioMenu.addEventListener("click", (event) => {
  const target = event.target.closest("[data-scenario]");
  if (!target) return;
  scenarioMenu.hidden = true;
  if (target.dataset.scenario === "reset") {
    state = { ...defaultState, view: "choose" };
    saveState();
    render();
    return;
  }
  go(target.dataset.scenario);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") scenarioMenu.hidden = true;
});

render();
