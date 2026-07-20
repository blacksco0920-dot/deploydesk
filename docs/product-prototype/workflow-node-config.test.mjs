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

function loadPrototype() {
  return new JSDOM(inlineHtml, {
    url: "https://prototype.test/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
}

function openProject(document, id = "demo-shop") {
  document.querySelector(`[data-project-id="${id}"]`).click();
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
    document.querySelector('[data-focus-node="source"]').click();
    assert.match(document.querySelector("#inspectorContent").textContent, /项目的路径、服务识别结果和本机状态/);
    assert.match(document.querySelector("#inspectorContent").textContent, /已识别 3 个服务/);
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

test("部署运行节点可以复用为第二服务器分支", () => {
  const dom = loadPrototype();
  try {
    const document = dom.window.document;
    openProject(document);
    document.querySelector("#addNodeButton").click();
    document.querySelector('[data-library-node="deploy"]').click();
    assert.equal(document.querySelectorAll(".workflow-node").length, 5);
    assert.match(document.querySelector("#inspectorContent").textContent, /选择连接/);
    assert.match(document.querySelector('[data-node-id="deployBranch"]').textContent, /待连接/);
  } finally {
    dom.window.close();
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
