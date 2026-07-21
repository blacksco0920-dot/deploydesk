import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../../apps/desktop/node_modules/jsdom/lib/api.js";

const htmlPath = fileURLToPath(new URL("./workflow-node-config.html", import.meta.url));
const scriptPath = fileURLToPath(new URL("./workflow-node-config.js", import.meta.url));
const html = readFileSync(htmlPath, "utf8");
const script = readFileSync(scriptPath, "utf8");
const inlineHtml = html
  .replace('<script src="./workflow-node-config.js"></script>', "")
  .replace("</body>", () => `<script>window.__PROTOTYPE_TEST__ = true;</script><script>${script}</script></body>`);

function loadPrototype(storage = {}) {
  return new JSDOM(inlineHtml, {
    url: "https://prototype.test/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.entries(storage).forEach(([key, value]) => window.localStorage.setItem(key, value));
    },
  });
}

function openProject(document, id = "demo-shop") {
  document.querySelector(`[data-project-id="${id}"]`).click();
}

function pointerEvent(window, type, x, y, pointerId = 1) {
  const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function dragElement(window, element, from, to) {
  element.dispatchEvent(pointerEvent(window, "pointerdown", from[0], from[1]));
  element.dispatchEvent(pointerEvent(window, "pointermove", to[0], to[1]));
  element.dispatchEvent(pointerEvent(window, "pointerup", to[0], to[1]));
}

function storageSnapshot(window) {
  return Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => {
    const key = window.localStorage.key(index);
    return [key, window.localStorage.getItem(key)];
  }));
}

test("默认进入项目首页，首页和工作流导航不会共存", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector("#homeView").hidden, false);
    assert.equal(document.querySelector("#workflowView").hidden, true);
    assert.ok(document.querySelector("#projectSearch"));
    assert.ok(document.querySelector("#addProjectButton"));
    assert.match(document.querySelector("#projectGrid").textContent, /示例商城/);
    assert.doesNotMatch(document.querySelector(".home-sidebar").textContent, /个人空间|运行记录|本机环境可用/);
    assert.equal(document.querySelectorAll('[data-home-page]').length, 2);

    openProject(document);
    assert.equal(document.querySelector("#homeView").hidden, true);
    assert.equal(document.querySelector("#workflowView").hidden, false);
    assert.equal(document.querySelectorAll(".resource-panel").length, 1);
    assert.match(document.querySelector(".resource-panel").textContent, /部署线路/);
    assert.match(document.querySelector(".resource-panel").textContent, /节点类型/);
    assert.doesNotMatch(document.querySelector(".resource-panel").textContent, /配置中心/);
    assert.equal(document.querySelector(".config-center-link"), null);
    assert.equal(document.querySelector("#scenarioSelect").hidden, true);
    assert.equal(document.querySelector("#scenarioSelect").dataset.prototypeOnly, "true");
    assert.equal(document.querySelector("#historyButton").getAttribute("aria-label"), "运行记录");
    assert.equal(document.querySelector("#historyButton").getAttribute("title"), "运行记录");
    assert.ok(document.querySelector("#historyButton svg"));
    assert.equal(document.querySelector("#historyButton").textContent.trim(), "");

    document.querySelector("#backToProjects").click();
    assert.equal(document.querySelector("#homeView").hidden, false);
    assert.equal(document.querySelector("#workflowView").hidden, true);
  } finally {
    dom.window.close();
  }
});

test("默认模板展示四类稳定节点，Provider 不是节点名称", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    openProject(document);
    const nodes = [...document.querySelectorAll(".workflow-node")];
    assert.equal(nodes.length, 4);
    assert.deepEqual(
      nodes.map((node) => node.querySelector(".node-heading strong").textContent),
      ["代码来源", "版本构建", "版本存储", "部署运行"],
    );
    assert.match(nodes[1].textContent, /CNB/);
    assert.match(nodes[2].textContent, /腾讯云 TCR/);
    assert.equal(document.querySelector("#addNodeButton"), null);
    assert.equal(document.querySelector("#nodeLibrary"), null);
    assert.equal(document.querySelector('[data-node-id="deployBranch"]'), null);
    document.querySelector('[data-focus-node="source"]').click();
    assert.match(document.querySelector("#inspectorContent").textContent, /项目的路径、服务识别结果和本机状态/);
    assert.match(document.querySelector("#inspectorContent").textContent, /已识别 3 个服务/);
  } finally {
    dom.window.close();
  }
});

test("高保真工作区默认展示完整画布，并收敛节点与线路操作", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    openProject(document);

    assert.equal(document.querySelector("#studioBody").classList.contains("inspector-closed"), true);
    assert.equal(document.querySelector(".resource-tabs"), null);
    assert.equal(document.querySelector(".inspector-meta"), null);
    assert.equal(document.querySelector(".node-description"), null);
    assert.ok(document.querySelector(".node-icon svg"));

    const activeLine = document.querySelector(".line-row.active");
    const more = activeLine.querySelector("[data-line-more]");
    assert.ok(more);
    assert.equal(more.getAttribute("aria-expanded"), "false");
    more.click();
    assert.equal(activeLine.classList.contains("menu-open"), true);
    assert.equal(more.getAttribute("aria-expanded"), "true");
    assert.match(activeLine.querySelector(".line-menu").textContent, /重命名/);
    assert.match(activeLine.querySelector(".line-menu").textContent, /删除线路/);
  } finally {
    dom.window.close();
  }
});

test("Inspector 的查看、选择和新增模式互斥", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    openProject(document);
    assert.match(document.querySelector("#inspectorContent").textContent, /当前使用/);
    assert.equal(document.querySelector("#inspectorContent input"), null);

    document.querySelector('[data-action="change"]').click();
    assert.match(document.querySelector("#inspectorContent").textContent, /选择连接/);
    assert.equal(document.querySelector("#inspectorContent input"), null);

    document.querySelector('[data-action="add"]').click();
    assert.match(document.querySelector("#inspectorContent").textContent, /连接新的CNB/);
    assert.ok(document.querySelector("#connectionSecret"));
    assert.ok(document.querySelector("#saveReusable:checked"));
    assert.doesNotMatch(document.querySelector("#inspectorContent").textContent, /当前使用/);
  } finally {
    dom.window.close();
  }
});

test("授权失效只进入连接修复，不清除其他节点", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    openProject(document);
    const select = document.querySelector("#scenarioSelect");
    select.value = "expired";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(document.querySelectorAll(".workflow-node").length, 4);
    assert.match(document.querySelector("#inspectorContent").textContent, /授权已经失效/);
    assert.match(document.querySelector("#inspectorFooter").textContent, /重新授权/);
    assert.match(document.querySelector("#inspectorContent").textContent, /当前版本继续运行/);
  } finally {
    dom.window.close();
  }
});

test("选择和抓手工具分别移动节点与画布，并保留缩放和适应入口", () => {
  const dom = loadPrototype();
  try {
    const { document } = dom.window;
    openProject(document);
    const viewport = document.querySelector("#canvasViewport");
    const source = document.querySelector('[data-node-id="source"]');

    assert.equal(document.querySelector("#selectTool").getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("#handTool").getAttribute("aria-pressed"), "false");
    assert.ok(document.querySelector("#zoomOut"));
    assert.ok(document.querySelector("#zoomValue"));
    assert.ok(document.querySelector("#zoomIn"));
    assert.ok(document.querySelector("#fitCanvas"));

    document.querySelector("#handTool").click();
    const nodeLeftBeforePan = source.style.left;
    const transformBeforePan = document.querySelector("#canvasWorld").style.transform;
    dragElement(dom.window, source, [120, 160], [170, 200]);
    assert.equal(source.style.left, nodeLeftBeforePan);
    assert.notEqual(document.querySelector("#canvasWorld").style.transform, transformBeforePan);
    assert.equal(viewport.dataset.tool, "hand");

    document.querySelector("#selectTool").click();
    dragElement(dom.window, source, [120, 160], [220, 200]);
    assert.ok(Number.parseFloat(source.style.left) > Number.parseFloat(nodeLeftBeforePan));
    assert.equal(viewport.dataset.tool, "select");
    assert.ok([...Array(dom.window.localStorage.length)].some((_, index) =>
      dom.window.localStorage.key(index).includes("node-positions.v1:demo-shop:online")));
  } finally {
    dom.window.close();
  }
});

test("每条线路独立保存节点位置，切换和刷新后恢复并自动适应", () => {
  const firstDom = loadPrototype();
  let snapshot;
  let onlineLeft;
  let testLeft;
  try {
    const { document } = firstDom.window;
    openProject(document);
    dragElement(firstDom.window, document.querySelector('[data-node-id="source"]'), [100, 120], [220, 120]);
    onlineLeft = document.querySelector('[data-node-id="source"]').style.left;
    assert.notEqual(onlineLeft, "80px");

    document.querySelector('[data-line="test"]').click();
    assert.equal(document.querySelector('[data-node-id="source"]').style.left, "80px");
    dragElement(firstDom.window, document.querySelector('[data-node-id="source"]'), [100, 120], [150, 120]);
    testLeft = document.querySelector('[data-node-id="source"]').style.left;
    assert.notEqual(testLeft, "80px");

    document.querySelector('[data-line="online"]').click();
    assert.equal(document.querySelector('[data-node-id="source"]').style.left, onlineLeft);
    document.querySelector('[data-line="test"]').click();
    assert.equal(document.querySelector('[data-node-id="source"]').style.left, testLeft);
    snapshot = storageSnapshot(firstDom.window);
  } finally {
    firstDom.window.close();
  }

  const refreshedDom = loadPrototype(snapshot);
  try {
    const { document } = refreshedDom.window;
    openProject(document);
    assert.equal(document.querySelector(".line-row.active").dataset.lineRow, "test");
    assert.equal(document.querySelector('[data-node-id="source"]').style.left, testLeft);
    assert.match(document.querySelector("#canvasWorld").style.transform, /translate\(.+\) scale\(.+\)/);
    document.querySelector('[data-line="online"]').click();
    assert.equal(document.querySelector('[data-node-id="source"]').style.left, onlineLeft);
  } finally {
    refreshedDom.window.close();
  }
});

test("线路可以新增、重命名和二次确认删除，最后一条删除后进入可恢复空状态", () => {
  const dom = loadPrototype();
  try {
    const { document } = dom.window;
    openProject(document);
    assert.equal(document.querySelectorAll(".line-row").length, 2);

    document.querySelector("#addLineButton").click();
    assert.equal(document.querySelectorAll(".line-row").length, 3);
    assert.ok(document.querySelector("#renameLineDialog").hasAttribute("open"));
    document.querySelector("#renameLineInput").value = "预发布线路";
    document.querySelector("#confirmRenameLine").click();
    assert.match(document.querySelector(".line-row.active").textContent, /预发布线路/);
    assert.equal(document.querySelector("#canvasLineName").textContent, "预发布线路");

    document.querySelector('.line-row.active [data-line-action="delete"]').click();
    assert.ok(document.querySelector("#deleteLineDialog").hasAttribute("open"));
    assert.match(document.querySelector("#deleteLineDialog").textContent, /不会删除项目代码/);
    assert.match(document.querySelector("#deleteLineDialog").textContent, /配置中心里可复用的连接/);
    document.querySelector("#confirmDeleteLine").click();
    assert.equal(document.querySelectorAll(".line-row").length, 2);

    document.querySelector('[data-line-row="test"] [data-line-action="delete"]').click();
    document.querySelector("#confirmDeleteLine").click();
    assert.equal(document.querySelectorAll(".line-row").length, 1);
    document.querySelector('[data-line-action="delete"]').click();
    assert.ok(document.querySelector("#deleteLineDialog").hasAttribute("open"));
    document.querySelector("#confirmDeleteLine").click();
    assert.equal(document.querySelectorAll(".line-row").length, 0);
    assert.equal(document.querySelector("#studioBody").classList.contains("no-lines"), true);
    assert.equal(document.querySelectorAll(".workflow-node").length, 0);
    assert.equal(document.querySelector("#canvasEmptyState").textContent.includes("还没有部署线路"), true);
    assert.equal(document.querySelector("#runButton").disabled, true);
    assert.equal(document.querySelector("#runButtonText").textContent, "创建线路后上线");

    document.querySelector("#createFirstLineButton").click();
    assert.equal(document.querySelectorAll(".line-row").length, 1);
    assert.equal(document.querySelectorAll(".workflow-node").length, 4);
    assert.equal(document.querySelector("#studioBody").classList.contains("no-lines"), false);
    assert.ok(document.querySelector("#renameLineDialog").hasAttribute("open"));
  } finally {
    dom.window.close();
  }
});

test("空线路状态跨刷新保留，并可从侧栏重新创建固定四节点线路", () => {
  const firstDom = loadPrototype();
  let snapshot;
  try {
    const { document } = firstDom.window;
    openProject(document);
    for (const row of [...document.querySelectorAll(".line-row")]) {
      const id = row.dataset.lineRow;
      document.querySelector(`[data-line-row="${id}"] [data-line-action="delete"]`).click();
      document.querySelector("#confirmDeleteLine").click();
    }
    assert.equal(document.querySelectorAll(".line-row").length, 0);
    snapshot = storageSnapshot(firstDom.window);
  } finally {
    firstDom.window.close();
  }

  const refreshedDom = loadPrototype(snapshot);
  try {
    const { document } = refreshedDom.window;
    openProject(document);
    assert.equal(document.querySelectorAll(".line-row").length, 0);
    assert.equal(document.querySelectorAll(".workflow-node").length, 0);
    document.querySelector("[data-create-line]").click();
    assert.equal(document.querySelectorAll(".workflow-node").length, 4);
    assert.deepEqual(
      [...document.querySelectorAll(".workflow-node")].map((node) => node.querySelector(".node-heading strong").textContent),
      ["代码来源", "版本构建", "版本存储", "部署运行"],
    );
  } finally {
    refreshedDom.window.close();
  }
});

test("添加项目、复用连接、上线成功并返回首页形成闭环", async () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    document.querySelector("#addProjectButton").click();
    assert.ok(document.querySelector("#addProjectDialog").hasAttribute("open"));
    assert.equal(document.querySelector("#addAndOpenProject").disabled, true);

    document.querySelector("#chooseProjectFolder").click();
    assert.equal(document.querySelector("#selectedProject").hidden, false);
    assert.equal(document.querySelector("#addAndOpenProject").disabled, false);
    document.querySelector("#addAndOpenProject").click();

    assert.equal(document.querySelector("#homeView").hidden, true);
    assert.equal(document.querySelector("#workflowProjectName").textContent, "客户管理工具");
    assert.match(document.querySelector('[data-node-id="source"]').textContent, /客户管理工具/);
    assert.match(document.querySelector('[data-node-id="build"]').textContent, /待连接/);

    for (const expectedNext of ["版本存储", "部署运行"]) {
      document.querySelector('[data-action="use"]').click();
      assert.equal(document.querySelector("#inspectorTitle").textContent, expectedNext);
    }
    document.querySelector('[data-action="use"]').click();
    assert.equal(document.querySelector("#runButtonText").textContent, "开始上线");
    assert.equal([...document.querySelectorAll(".workflow-node")].every((node) => node.classList.contains("ready")), true);

    document.querySelector("#runButton").click();
    assert.ok(document.querySelector("#runConfirmDialog").hasAttribute("open"));
    document.querySelector("#confirmRun").click();
    assert.equal(document.querySelector("#runButton").disabled, true);
    assert.equal(document.querySelector("#runButtonText").textContent, "正在上线");

    await new Promise((resolve) => dom.window.setTimeout(resolve, 45));
    assert.ok(document.querySelector("#successDialog").hasAttribute("open"));
    assert.match(document.querySelector("#successAddress").textContent, /customer-crm\.example\.com/);
    document.querySelector("#successBackHome").click();

    assert.equal(document.querySelector("#homeView").hidden, false);
    const card = document.querySelector('[data-project-id="customer-crm"]');
    assert.match(card.textContent, /已经上线/);
    assert.match(card.textContent, /customer-crm\.example\.com/);

    card.click();
    assert.equal(document.querySelector("#runButtonText").textContent, "更新上线");
  } finally {
    dom.window.close();
  }
});
