import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../../apps/desktop/node_modules/jsdom/lib/api.js";

const prototypePath = fileURLToPath(new URL("./index.html", import.meta.url));
const appPath = fileURLToPath(new URL("./app.js", import.meta.url));
const storageKey = "abcdeploy-product-prototype-v6";
const indexHtml = readFileSync(prototypePath, "utf8");
const appSource = readFileSync(appPath, "utf8");
const inlineHtml = indexHtml
  .replace('<script defer src="./app.js"></script>', "")
  .replace("</body>", `<script>${appSource}</script></body>`);

async function loadPrototype(snapshot = null, url = "https://prototype.test/") {
  const dom = new JSDOM(inlineHtml, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (snapshot) window.sessionStorage.setItem(storageKey, snapshot);
    },
  });
  await tick(dom);
  return dom;
}

function tick(dom) {
  return new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

function clickAction(dom, action) {
  const target = dom.window.document.querySelector(`[data-action="${action}"]`);
  assert.ok(target, `找不到操作：${action}`);
  target.click();
}

function clickScenario(dom, scenario) {
  const target = dom.window.document.querySelector(`[data-scenario="${scenario}"]`);
  assert.ok(target, `找不到场景：${scenario}`);
  target.click();
}

function selectFailureVariant(dom, value) {
  const target = dom.window.document.querySelector("[data-failure-variant]");
  assert.ok(target, "找不到故障恢复类型选择器");
  target.value = value;
  target.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function clickPage(dom, page) {
  const target = dom.window.document.querySelector(`[data-page="${page}"]`);
  assert.ok(target, `找不到页面：${page}`);
  target.click();
}

function fillField(dom, field, value) {
  const input = dom.window.document.querySelector(`[data-field="${field}"]`);
  assert.ok(input, `找不到字段：${field}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function contentText(dom) {
  return dom.window.document.querySelector(".content-scroll").textContent;
}

function sheetText(dom) {
  return dom.window.document.querySelector(".drawer")?.textContent ?? "";
}

function visibleText(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll("details").forEach((details) => details.remove());
  return clone.textContent;
}

function snapshot(dom) {
  return dom.window.sessionStorage.getItem(storageKey);
}

function bindRecommendedConfig(dom, action) {
  clickAction(dom, action);
  assert.match(sheetText(dom), /持续绑定/);
  clickAction(dom, "bind-config-profile");
}

function completeOpenSetup(dom, host = "203.0.113.10") {
  if (dom.window.document.querySelector('[data-field="publishToken"]')) {
    fillField(dom, "publishToken", "cold-token-value");
    clickAction(dom, "save-setup-question");
  }
  fillField(dom, "registryEndpoint", "ccr.ccs.tencentyun.com/acme");
  fillField(dom, "versionAccount", "registry-user");
  fillField(dom, "versionPassword", "registry-password-value");
  clickAction(dom, "save-setup-question");
  fillField(dom, "testHost", host);
  fillField(dom, "testUser", "ubuntu");
  fillField(dom, "serverPassword", "server-password-value");
  clickAction(dom, "save-setup-question");
  assert.match(sheetText(dom), new RegExp(`${host.replaceAll(".", "\\.")}.*主机指纹`, "s"));
  clickAction(dom, "confirm-server-fingerprint");
  clickAction(dom, "save-setup-question");
  assert.equal(dom.window.document.querySelector('[data-server-capability="clean"]')?.getAttribute("aria-pressed"), "true");
  assert.ok(dom.window.document.querySelector('[data-action="confirm-server-change"]'));
  clickAction(dom, "confirm-server-change");
  clickAction(dom, "save-setup-question");
  bindRecommendedConfig(dom, "use-config-center");
  fillField(dom, "adminPassword", "admin-password-value");
  clickAction(dom, "save-setup-question");
}

function completeColdSetup(dom, host = "203.0.113.10") {
  clickAction(dom, "start-first-test");
  completeOpenSetup(dom, host);
}

function parsedSnapshot(dom) {
  return JSON.parse(snapshot(dom));
}

function expectedArtifactRefs(digestHex, endpoint = "ccr.ccs.tencentyun.com/team", registryConnectionId = "registry-team", revision = 1, services = ["api", "ocr", "web"]) {
  return services.map((serviceId) => ({
    serviceId,
    digest: fixtureServiceDigest(digestHex, serviceId),
    repository: `${endpoint}/shop-${serviceId}`,
    registryConnectionId,
    registryConnectionRevision: `${registryConnectionId}@${revision}`,
  }));
}

function fixtureServiceDigest(digestHex, serviceId) {
  const suffix = [...String(serviceId)].reduce((total, character) => (total + character.charCodeAt(0)) % 256, 0)
    .toString(16)
    .padStart(2, "0");
  return `sha256:${digestHex.slice(0, 62)}${suffix}`;
}

function advanceExistingConnections(dom, host) {
  clickScenario(dom, "existing");
  clickAction(dom, "adopt-existing-deployment");
  fillField(dom, "connectionToken", "code-token");
  clickAction(dom, "confirm-adopt-existing");
  fillField(dom, "connectionRegistryEndpoint", "registry.example.cn/team");
  fillField(dom, "connectionRegistryAccount", "registry-user");
  fillField(dom, "connectionToken", "registry-secret");
  clickAction(dom, "confirm-adopt-existing");
  clickAction(dom, "connect-existing-server");
  fillField(dom, "connectionHost", host);
  fillField(dom, "connectionUser", "ubuntu");
  fillField(dom, "connectionServerSecret", "server-secret");
  clickAction(dom, "save-resource-connection");
  clickAction(dom, "confirm-resource-server-identity");
  dom.window.document.querySelector('[data-server-capability="compatible"]').click();
  clickAction(dom, "save-resource-server");
}

function qualifyCurrent(dom, scenario = "available") {
  clickScenario(dom, scenario);
  clickAction(dom, "open-test-site");
  clickAction(dom, "confirm-test-passed");
}

function openFirstProduction(dom) {
  qualifyCurrent(dom, "available");
  clickAction(dom, "go-versions");
  clickAction(dom, "publish-current");
}

function finishFirstProductionSetup(dom, domain = "app.acme.cn") {
  clickAction(dom, "save-production-question");
  bindRecommendedConfig(dom, "use-production-config");
  if (dom.window.document.querySelector('[data-field="productionAdminPassword"]')) {
    fillField(dom, "productionAdminPassword", "production-admin-secret");
  }
  clickAction(dom, "save-production-question");
  fillField(dom, "productionDomain", domain);
  clickAction(dom, "save-production-question");
  clickAction(dom, "save-production-question");
}

function completeFirstProductionSetup(dom, domain = "app.acme.cn") {
  openFirstProduction(dom);
  finishFirstProductionSetup(dom, domain);
}

test("P01 十个验证场景都保留四个稳定项目入口", async () => {
  const dom = await loadPrototype();
  try {
    const scenarios = ["first", "needs", "reused", "choice", "existing", "deploying", "available", "update", "failure", "server"];
    for (const scenario of scenarios) {
      clickScenario(dom, scenario);
      assert.deepEqual(
        [...dom.window.document.querySelectorAll(".project-nav button")].map((button) => button.textContent.trim()),
        ["发布中心", "在本机运行", "版本", "项目设置"],
      );
      assert.equal(dom.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "发布中心");
    }
  } finally {
    dom.window.close();
  }
});

test("P02 新项目首屏只承诺可打开测试版且只有一个主动作", async () => {
  const dom = await loadPrototype();
  try {
    const text = contentText(dom);
    assert.match(text, /先生成一个可以打开的测试版/);
    assert.doesNotMatch(text, /正式服务器|正式域名|CNB|TCR|Caddy|SSH|镜像摘要/);
    const primary = dom.window.document.querySelectorAll(".content-scroll .primary-button");
    assert.equal(primary.length, 1);
    assert.equal(primary[0].dataset.action, "start-first-test");
  } finally {
    dom.window.close();
  }
});

test("P03 冷启动四项逐项校验，空值不能伪装完成", async () => {
  const dom = await loadPrototype();
  try {
    clickAction(dom, "start-first-test");
    assert.match(sheetText(dom), /第 1 项，共 4 项/);
    clickAction(dom, "save-setup-question");
    assert.equal(dom.window.document.querySelector("#drawer-title").textContent, "允许自动接收代码更新");
    assert.match(sheetText(dom), /请填写代码平台授权/);

    fillField(dom, "publishToken", "token-value");
    clickAction(dom, "save-setup-question");
    assert.equal(dom.window.document.querySelector("#drawer-title").textContent, "选择生成版本的保存位置");
    fillField(dom, "registryEndpoint", "ccr.ccs.tencentyun.com/acme");
    fillField(dom, "versionAccount", "user");
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /请填写版本保存密码/);
    fillField(dom, "versionPassword", "password");
    clickAction(dom, "save-setup-question");

    fillField(dom, "testHost", "203.0.113.10");
    fillField(dom, "testUser", "ubuntu");
    fillField(dom, "serverPassword", "server-password");
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /主机指纹.*首次连接/s);
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /请先确认主机指纹属于你的服务器/);
    clickAction(dom, "confirm-server-fingerprint");
    clickAction(dom, "save-setup-question");
    assert.equal(dom.window.document.querySelector('[data-server-capability="clean"]')?.getAttribute("aria-pressed"), "true");
    assert.ok(dom.window.document.querySelector('[data-action="confirm-server-change"]'));
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /初始化统一访问服务.*先确认允许准备/s);
    clickAction(dom, "confirm-server-change");
    clickAction(dom, "save-setup-question");
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /请选择或新建第三方服务访问密钥.*请填写管理员初始密码/s);
    bindRecommendedConfig(dom, "use-config-center");
    fillField(dom, "adminPassword", "admin-password");
    clickAction(dom, "save-setup-question");
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
    assert.match(contentText(dom), /正在生成测试版/);
  } finally {
    dom.window.close();
  }
});

test("P04 按事实处理：部分复用一题、全部复用零题、多候选只选一次", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "needs");
    assert.match(contentText(dom), /还需要你确认 1 件事/);
    clickAction(dom, "continue-setup");
    assert.match(sheetText(dom), /第 1 项，共 1 项/);
    assert.doesNotMatch(sheetText(dom), /代码平台授权|版本保存账号|服务器地址/);

    clickScenario(dom, "reused");
    assert.match(contentText(dom), /所需信息已经自动复用.*任务 #31/s);
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);

    clickScenario(dom, "choice");
    assert.match(contentText(dom), /还需要你确认 1 件事/);
    clickAction(dom, "continue-setup");
    assert.doesNotMatch(sheetText(dom), /服务器地址|登录密码/);
    clickAction(dom, "select-alternative-runtime");
    assert.equal(dom.window.document.querySelector('[data-action="select-alternative-runtime"]').getAttribute("aria-pressed"), "true");
    clickAction(dom, "close-sheet");
    clickAction(dom, "continue-setup");
    assert.equal(dom.window.document.querySelector('[data-action="select-alternative-runtime"]').getAttribute("aria-pressed"), "true");
    clickAction(dom, "save-setup-question");
    assert.match(contentText(dom), /正在生成测试版/);
  } finally {
    dom.window.close();
  }
});

test("P05 配置中心在当前任务内完成选择、新建和持续绑定", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "needs");
    clickAction(dom, "continue-setup");
    bindRecommendedConfig(dom, "use-config-center");
    assert.match(sheetText(dom), /已绑定.*来源：配置中心“测试环境通用密钥”/s);
    clickAction(dom, "use-config-center");
    fillField(dom, "newConfigLabel", "商城测试密钥");
    fillField(dom, "newConfigKey", "PROVIDER_API_KEY");
    fillField(dom, "newConfigValue", "new-secret-value");
    clickAction(dom, "create-config-profile");
    assert.match(sheetText(dom), /来源：配置中心“商城测试密钥”/);
  } finally {
    dom.window.close();
  }
});

test("P06 任务和非敏感进度可恢复，秘密不会写入 Web 存储", async () => {
  const first = await loadPrototype();
  let saved;
  try {
    clickAction(first, "start-first-test");
    fillField(first, "publishToken", "must-not-enter-storage");
    clickAction(first, "save-setup-question");
    fillField(first, "versionAccount", "persisted-user");
    saved = snapshot(first);
    assert.ok(saved);
    assert.doesNotMatch(saved, /must-not-enter-storage/);
    assert.match(saved, /persisted-user/);
  } finally {
    first.window.close();
  }

  const resumed = await loadPrototype(saved);
  try {
    assert.match(contentText(resumed), /还需要你确认 3 件事/);
    clickAction(resumed, "continue-setup");
    assert.equal(resumed.window.document.querySelector("#drawer-title").textContent, "选择生成版本的保存位置");
    assert.equal(resumed.window.document.querySelector('[data-field="versionAccount"]').value, "persisted-user");
  } finally {
    resumed.window.close();
  }
});

test("P07 首次版本不会凭空出现历史，验证证据只授予当前版本", async () => {
  const dom = await loadPrototype();
  try {
    clickPage(dom, "versions");
    assert.match(contentText(dom), /还没有生成版本/);
    assert.doesNotMatch(contentText(dom), /7 月 17 日/);

    clickPage(dom, "release");
    completeColdSetup(dom);
    clickAction(dom, "finish-deployment");
    clickAction(dom, "open-test-site");
    clickAction(dom, "confirm-test-passed");
    clickPage(dom, "versions");
    assert.match(contentText(dom), /测试配置修订 3 通过/);
    assert.match(contentText(dom), /测试通过/);
    assert.equal(dom.window.document.querySelectorAll(".version-row").length, 1);
    assert.ok(dom.window.document.querySelector('[data-action="publish-current"]'));
  } finally {
    dom.window.close();
  }
});

test("P08 测试有问题和结果未知的执行都不能冒充当前可发布版本", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "available");
    clickAction(dom, "open-test-site");
    clickAction(dom, "mark-test-issue");
    clickPage(dom, "versions");
    assert.match(contentText(dom), /测试有问题/);
    assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);

    clickScenario(dom, "failure");
    clickPage(dom, "versions");
    assert.match(contentText(dom), /当前授权无法读取生成结果.*继续任务 #24/s);
    assert.match(contentText(dom), /当前测试版.*上一个可用版本仍在线/s);
    assert.equal([...dom.window.document.querySelectorAll(".version-row")].some((row) => row.textContent.includes("7 月 18 日 19:13 版本")), false);
    assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);
  } finally {
    dom.window.close();
  }
});

test("P09 第一次正式准备保存自定义域名，关闭后从原题继续", async () => {
  const dom = await loadPrototype();
  try {
    openFirstProduction(dom);
    clickAction(dom, "save-production-question");
    bindRecommendedConfig(dom, "use-production-config");
    fillField(dom, "productionAdminPassword", "production-admin-secret");
    clickAction(dom, "save-production-question");
    fillField(dom, "productionDomain", "portal.acme.cn");
    clickAction(dom, "close-sheet");
    assert.match(contentText(dom), /正式发布任务 #42 还没有结束/);
    assert.match(contentText(dom), /正在准备正式发布，已经确认的内容会保留/);
    assert.match(dom.window.document.body.textContent, /正式发布准备未完成/);
    assert.doesNotMatch(contentText(dom), /服务已部署，正在完成地址/);
    clickAction(dom, "go-release-center");
    assert.match(contentText(dom), /正式发布还需要确认 2 件事/);
    clickAction(dom, "resume-production-setup");
    assert.equal(dom.window.document.querySelector("#drawer-title").textContent, "设置正式访问地址");
    assert.equal(dom.window.document.querySelector('[data-field="productionDomain"]').value, "portal.acme.cn");
    clickAction(dom, "save-production-question");
    assert.match(sheetText(dom), /portal\.acme\.cn/);
    assert.doesNotMatch(sheetText(dom), /shop\.example\.com/);
    clickAction(dom, "save-production-question");
    assert.match(contentText(dom), /正式发布任务 #42/);
  } finally {
    dom.window.close();
  }
});

test("P10 无效正式域名被阻断，合法域名贯穿任务与地址状态", async () => {
  const dom = await loadPrototype();
  try {
    openFirstProduction(dom);
    clickAction(dom, "save-production-question");
    bindRecommendedConfig(dom, "use-production-config");
    fillField(dom, "productionAdminPassword", "production-admin-secret");
    clickAction(dom, "save-production-question");
    fillField(dom, "productionDomain", "https://bad.example.com/path");
    clickAction(dom, "save-production-question");
    assert.match(sheetText(dom), /只填写有效域名/);
    fillField(dom, "productionDomain", "app.acme.cn");
    clickAction(dom, "save-production-question");
    clickAction(dom, "save-production-question");
    clickAction(dom, "finish-production");
    assert.match(contentText(dom), /app\.acme\.cn.*等待检查/s);
  } finally {
    dom.window.close();
  }
});

test("P11 正式任务和地址待完成阶段互斥，不允许创建第二个正式任务", async () => {
  const dom = await loadPrototype();
  try {
    completeFirstProductionSetup(dom);
    clickPage(dom, "versions");
    assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);
    assert.equal(dom.window.document.querySelector('[data-action="publish-history"]'), null);
    assert.ok(dom.window.document.querySelector('[data-action="go-release-center"]'));
    clickAction(dom, "go-release-center");
    clickAction(dom, "finish-production");
    clickPage(dom, "versions");
    assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);
    assert.ok(dom.window.document.querySelector('[data-action="go-release-center"]'));
  } finally {
    dom.window.close();
  }
});

test("P12 地址检查经历待确认、断网、部分生效和完成，不重复部署", async () => {
  const dom = await loadPrototype();
  try {
    completeFirstProductionSetup(dom, "app.acme.cn");
    clickAction(dom, "finish-production");
    assert.match(contentText(dom), /正式版已经部署，还差访问地址.*不重新生成或重新部署/s);
    clickAction(dom, "simulate-address-offline");
    assert.match(contentText(dom), /地址检查被网络中断.*正式服务仍在运行/s);
    clickAction(dom, "finish-address-check");
    assert.match(contentText(dom), /2\/3 项已经生效.*等待 HTTPS/s);
    assert.doesNotMatch(contentText(dom), /正式版已经更新/);
    clickAction(dom, "finish-address-check");
    assert.match(contentText(dom), /正式版已经更新.*app\.acme\.cn/s);
  } finally {
    dom.window.close();
  }
});

test("P13 任一测试通过版本可发布，历史版本恢复使用独立任务", async () => {
  const dom = await loadPrototype();
  try {
    qualifyCurrent(dom, "update");
    clickPage(dom, "versions");
    assert.ok(dom.window.document.querySelector('[data-action="publish-current"]'));
    assert.ok(dom.window.document.querySelector('[data-action="rollback-history"]'));
    clickAction(dom, "publish-current");
    clickAction(dom, "create-production-task");
    clickAction(dom, "finish-production");
    clickPage(dom, "versions");
    assert.ok(dom.window.document.querySelector('[data-action="rollback-history"]'));
    clickAction(dom, "rollback-history");
    assert.match(dom.window.document.querySelector("#drawer-title").textContent, /恢复正式版/);
    assert.match(sheetText(dom), /目标版本.*7 月 17 日.*当前正式版.*7 月 18 日/s);
    clickAction(dom, "create-production-task");
    assert.match(contentText(dom), /正式恢复任务 #43.*正在恢复正式版/s);
    assert.ok(dom.window.document.querySelector('[aria-label="正式版恢复进度"]'));
    clickAction(dom, "finish-production");
    assert.match(contentText(dom), /正式恢复完成.*正式版已经恢复/s);
  } finally {
    dom.window.close();
  }
});

test("P14 失效授权原地替换并续跑同一任务的新一次执行", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "failure");
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /任务 #24.*执行 #2.*被阻断.*读取生成结果/s);
    clickAction(dom, "close-sheet");
    clickAction(dom, "open-recovery-task");
    clickAction(dom, "save-recovery");
    assert.match(sheetText(dom), /请填写新的授权信息/);
    fillField(dom, "replacementToken", "replacement-token-value");
    clickAction(dom, "save-recovery");
    assert.match(contentText(dom), /继续任务 #24.*任务 #24 的项目和目标已经保留/s);
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /任务 #24.*执行 #3.*进行中.*读取生成结果/s);
  } finally {
    dom.window.close();
  }
});

test("P15 账户级连接可更换授权，不要求移除项目", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "failure");
    clickAction(dom, "show-connections");
    assert.match(sheetText(dom), /连接与运行资源.*版本保存位置.*测试运行位置/s);
    clickAction(dom, "replace-code-connection");
    assert.doesNotMatch(sheetText(dom), /移除项目|重新添加项目/);
    clickAction(dom, "save-code-connection");
    assert.match(sheetText(dom), /请填写新的授权信息/);
    fillField(dom, "connectionToken", "valid-replacement-token");
    clickAction(dom, "save-code-connection");
    assert.match(contentText(dom), /继续任务 #24.*任务 #24 的项目和目标已经保留/s);
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /任务 #24.*执行 #3.*进行中.*读取生成结果/s);
  } finally {
    dom.window.close();
  }
});

test("P16 已有部署可安全接入或重新设置，选择前不创建部署任务", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "existing");
    clickPage(dom, "versions");
    assert.match(contentText(dom), /还没有生成版本/);
    assert.doesNotMatch(contentText(dom), /7 月 15 日 18:20 版本|7 月 17 日 10:42 版本/);
    clickPage(dom, "release");
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /目前没有进行中的任务/);
    clickAction(dom, "close-sheet");
    clickAction(dom, "adopt-existing-deployment");
    assert.match(sheetText(dom), /只读取在线版本、地址和连接缺口.*确认前不会修改服务器或创建部署任务/s);
    clickAction(dom, "confirm-adopt-existing");
    assert.match(sheetText(dom), /请填写新的授权信息/);
    fillField(dom, "connectionToken", "existing-code-token");
    clickAction(dom, "confirm-adopt-existing");
    assert.match(sheetText(dom), /补充版本保存连接/);
    assert.equal(parsedSnapshot(dom).registryConnection, null);
    assert.equal(parsedSnapshot(dom).serverConnectionStatus, "missing");
    assert.deepEqual(parsedSnapshot(dom).tasksById, {});
    fillField(dom, "connectionRegistryEndpoint", "ccr.ccs.tencentyun.com/acme");
    fillField(dom, "connectionRegistryAccount", "registry-user");
    fillField(dom, "connectionToken", "registry-secret");
    clickAction(dom, "confirm-adopt-existing");
    assert.match(sheetText(dom), /验证运行服务器/);
    assert.equal(parsedSnapshot(dom).registryConnection.endpoint, "ccr.ccs.tencentyun.com/acme");
    assert.equal(parsedSnapshot(dom).environmentBindings.staging.serverConnectionId, null);
    clickAction(dom, "connect-existing-server");
    fillField(dom, "connectionServerSecret", "server-secret");
    clickAction(dom, "save-resource-connection");
    assert.match(sheetText(dom), /确认服务器身份/);
    clickAction(dom, "confirm-resource-server-identity");
    assert.match(sheetText(dom), /确认运行位置能力/);
    clickAction(dom, "save-resource-server");
    assert.match(sheetText(dom), /确认接入事实/);
    clickAction(dom, "confirm-adopt-existing");
    assert.match(contentText(dom), /没有重新部署、停止或替换任何在线服务/);
    assert.equal(parsedSnapshot(dom).activeTaskId, null);
    const importedState = parsedSnapshot(dom);
    const importedTasks = Object.values(importedState.tasksById);
    assert.equal(importedTasks.length, 2);
    assert.equal(importedTasks.every((task) => task.kind === "import" && task.status === "completed"), true);
    assert.equal(importedTasks.some((task) => ["test", "production", "config"].includes(task.kind)), false);
    assert.equal(Object.values(importedState.attemptsByTaskId).flat().every((attempt) => attempt.status === "succeeded"), true);
    assert.deepEqual(Object.keys(importedState.versionsById).sort(), ["ver-shop-20260715-1820", "ver-shop-20260717-1042"]);
    assert.equal(parsedSnapshot(dom).registryConnection.endpoint, "ccr.ccs.tencentyun.com/acme");
    const adoptedServerId = parsedSnapshot(dom).environmentBindings.staging.serverConnectionId;
    assert.equal(parsedSnapshot(dom).serverConnections[adoptedServerId].verified, true);
    assert.deepEqual(parsedSnapshot(dom).environmentBindings.staging.configProfileIds.sort(), [
      "config-imported-project-shop-demo-staging-admin-password",
      "config-imported-project-shop-demo-staging-provider-api-key",
    ]);
    clickPage(dom, "versions");
    assert.match(contentText(dom), /7 月 17 日 10:42 版本/);
    assert.doesNotMatch(contentText(dom), /7 月 18 日 19:13 版本/);

    clickPage(dom, "release");
    clickAction(dom, "reset-existing-deployment");
    assert.match(sheetText(dom), /线上测试版、正式版、服务器文件和版本仓库都不会被停止或删除/);
    clickAction(dom, "confirm-reset-existing");
    assert.match(contentText(dom), /已经开始重新设置.*线上服务没有被停止或删除/s);
    assert.match(contentText(dom), /先生成一个可以打开的测试版/);
    assert.equal(parsedSnapshot(dom).scenario, "first");
    assert.deepEqual(parsedSnapshot(dom).tasksById, {});
    assert.equal(parsedSnapshot(dom).codeConnectionStatus, "ready");
    assert.equal(parsedSnapshot(dom).registryConnectionStatus, "ready");
    assert.equal(parsedSnapshot(dom).serverConnectionStatus, "ready");
    assert.equal(parsedSnapshot(dom).registryConnection.endpoint, "ccr.ccs.tencentyun.com/acme");
    assert.equal(parsedSnapshot(dom).environmentBindings.staging.serverConnectionId, adoptedServerId);
    assert.deepEqual(parsedSnapshot(dom).environmentBindings.staging.configProfileIds, []);
    assert.equal(parsedSnapshot(dom).environmentBindings.staging.address, null);
    assert.deepEqual(parsedSnapshot(dom).versionsById, {});
  } finally {
    dom.window.close();
  }
});

test("P17 本机运行独立展示项目服务、运行依赖和必要配置", async () => {
  const dom = await loadPrototype();
  try {
    clickPage(dom, "local");
    const text = contentText(dom);
    assert.match(text, /不参与远程发布门禁.*项目服务.*运行依赖.*本地数据库.*缓存服务.*必要配置.*PROVIDER_API_KEY/s);
    assert.doesNotMatch(visibleText(dom.window.document.querySelector(".content-scroll")), /CNB|TCR|Caddy|SSH|镜像摘要/);
    const apiToggle = dom.window.document.querySelector('[data-local-service="api"]');
    apiToggle.click();
    assert.match(contentText(dom), /项目服务.*2\/3 正在运行.*后端服务当前未运行/s);
    clickAction(dom, "local-start-all");
    assert.match(contentText(dom), /项目服务.*3\/3 正在运行/s);
  } finally {
    dom.window.close();
  }
});

test("P18 抽屉换题、校验失败和关闭都有明确焦点，窄屏触控尺寸已定义", async () => {
  const dom = await loadPrototype();
  try {
    clickAction(dom, "start-first-test");
    await tick(dom);
    assert.equal(dom.window.document.activeElement.getAttribute("aria-label"), "关闭");
    clickAction(dom, "save-setup-question");
    await tick(dom);
    assert.equal(dom.window.document.activeElement.dataset.field, "publishToken");
    fillField(dom, "publishToken", "token");
    clickAction(dom, "save-setup-question");
    await tick(dom);
    assert.equal(dom.window.document.activeElement.getAttribute("aria-label"), "关闭");
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(dom);
    assert.equal(dom.window.document.activeElement.dataset.action, "continue-setup");

    const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*min-height: 44px/);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.drawer-footer\s*\{[\s\S]*?flex-wrap:\s*wrap/);
    assert.match(css, /@media \(forced-colors: active\)/);
  } finally {
    dom.window.close();
  }
});

test("P19 运行中与已完成任务在重载后仍能恢复，不会重复创建", async () => {
  const first = await loadPrototype();
  let runningSnapshot;
  try {
    completeColdSetup(first);
    runningSnapshot = snapshot(first);
    assert.match(contentText(first), /正在生成测试版/);
  } finally {
    first.window.close();
  }

  const resumed = await loadPrototype(runningSnapshot);
  let completedSnapshot;
  try {
    assert.match(contentText(resumed), /正在生成测试版/);
    clickAction(resumed, "show-tasks");
    assert.match(sheetText(resumed), /任务 #31.*执行 #1.*进行中.*启动项目服务/s);
    clickAction(resumed, "close-sheet");
    clickAction(resumed, "finish-deployment");
    completedSnapshot = snapshot(resumed);
  } finally {
    resumed.window.close();
  }

  const completed = await loadPrototype(completedSnapshot);
  try {
    assert.match(contentText(completed), /测试版可以打开了/);
    clickAction(completed, "show-tasks");
    assert.match(sheetText(completed), /目前没有进行中的任务.*任务 #31 · 已完成/s);
  } finally {
    completed.window.close();
  }
});

test("P20 服务器先确认运行前提，只允许初始化、兼容复用或阻断", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "server");
    clickAction(dom, "continue-setup");

    dom.window.document.querySelector('[data-server-capability="missing-runtime"]').click();
    assert.equal(dom.window.document.querySelector('[data-server-capability="missing-runtime"]')?.getAttribute("aria-pressed"), "true");
    assert.match(sheetText(dom), /服务器运行组件还未准备/);
    assert.ok(dom.window.document.querySelector('[data-action="recheck-server-capability"]'));
    assert.ok(dom.window.document.querySelector('[data-action="replace-server-details"]'));
    clickAction(dom, "save-setup-question");
    assert.ok(dom.window.document.querySelector(".field-error"));

    dom.window.document.querySelector('[data-server-capability="clean"]').click();
    assert.ok(dom.window.document.querySelector('[data-action="confirm-server-change"]'));
    clickAction(dom, "save-setup-question");
    assert.ok(dom.window.document.querySelector(".field-error"));
    clickAction(dom, "confirm-server-change");
    assert.equal(parsedSnapshot(dom).serverChangeConfirmed, true);

    assert.equal(dom.window.document.querySelector('[data-server-capability="adaptable"]'), null);
    assert.equal(dom.window.document.querySelector('[data-action="preview-server-adaptation"]'), null);

    dom.window.document.querySelector('[data-server-capability="conflict"]').click();
    assert.equal(dom.window.document.querySelector('[data-server-capability="conflict"]')?.getAttribute("aria-pressed"), "true");
    assert.match(sheetText(dom), /无法安全复用.*不会修改服务器/s);
    assert.ok(dom.window.document.querySelector('[data-action="replace-server-details"]'));
    clickAction(dom, "save-setup-question");
    assert.ok(dom.window.document.querySelector(".field-error"));

    dom.window.document.querySelector('[data-server-capability="compatible"]').click();
    assert.equal(dom.window.document.querySelector('[data-server-capability="compatible"]')?.getAttribute("aria-pressed"), "true");
    assert.equal(dom.window.document.querySelector('[data-action="confirm-server-change"]'), null);
    clickAction(dom, "save-setup-question");
    assert.match(contentText(dom), /正在生成测试版/);
  } finally {
    dom.window.close();
  }
});

test("P21 正式准备任务尚未执行且可以放弃，不会永久占用发布入口", async () => {
  const dom = await loadPrototype();
  try {
    openFirstProduction(dom);
    clickAction(dom, "close-sheet");
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /任务 #42.*正式发布.*尚未开始远程执行.*等待处理/s);
    clickAction(dom, "close-sheet");
    clickAction(dom, "go-release-center");
    assert.match(contentText(dom), /还没有对正式环境产生远程变更.*放弃这次任务/s);
    clickAction(dom, "cancel-production-preparation");
    assert.doesNotMatch(contentText(dom), /任务 #42 还没有结束/);
    assert.ok(dom.window.document.querySelector('[data-action="publish-current"]'));
    clickAction(dom, "show-tasks");
    assert.match(sheetText(dom), /任务 #42 · 已放弃.*没有开始远程执行/s);
  } finally {
    dom.window.close();
  }
});

test("P22 普通状态更新保留滚动与焦点，窄屏仍可访问应用级入口", async () => {
  const dom = await loadPrototype();
  try {
    clickPage(dom, "local");
    const scroller = dom.window.document.querySelector(".content-scroll");
    scroller.scrollTop = 320;
    const firstDependency = dom.window.document.querySelector('[data-local-dependency="database"]');
    firstDependency.focus();
    firstDependency.click();
    await tick(dom);
    assert.equal(dom.window.document.querySelector(".content-scroll").scrollTop, 320);
    assert.equal(dom.window.document.activeElement.dataset.localDependency, "database");

    const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
    assert.equal(dom.window.document.querySelector(".workspace-nav")?.getAttribute("aria-label"), "工作区导航");
    assert.equal(dom.window.document.querySelectorAll(".workspace-nav .nav-button").length, 4);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*sidebar \.workspace-nav[\s\S]*display: flex[\s\S]*flex-direction: row/);
    assert.match(css, /sidebar \.workspace-nav \.nav-button \{[\s\S]*width: auto/);
  } finally {
    dom.window.close();
  }
});

test("P23 地址可修改并保留部署结果，解析记录来自所选运行位置", async () => {
  const dom = await loadPrototype();
  try {
    completeFirstProductionSetup(dom, "old.acme.cn");
    clickAction(dom, "finish-production");
    assert.match(contentText(dom), /完整域名 old\.acme\.cn.*指向 203\.0\.113\.10/s);
    clickAction(dom, "edit-production-address");
    fillField(dom, "addressDraftDomain", "new.acme.cn");
    clickAction(dom, "save-production-address");
    assert.match(contentText(dom), /正式版已经部署，还差访问地址.*完整域名 new\.acme\.cn/s);
    assert.doesNotMatch(contentText(dom), /正在发布给正式用户/);
    assert.ok(dom.window.document.querySelector('[data-action="copy-dns-record"]'));
  } finally {
    dom.window.close();
  }
});

test("P24 任务保存不可变目标，只有真正执行时才新增带输入快照的 Attempt", async () => {
  const dom = await loadPrototype();
  try {
    qualifyCurrent(dom, "update");
    clickPage(dom, "versions");
    clickAction(dom, "publish-current");

    const prepared = parsedSnapshot(dom);
    assert.equal(prepared.activeTaskId, 42);
    assert.equal(prepared.tasksById[42].status, "waiting-input");
    assert.deepEqual(prepared.tasksById[42].goalSnapshot, {
      targetVersionId: "ver-shop-20260718-1913",
      expectedResult: "production-release",
      environment: "production",
      intent: "publish",
    });
    assert.deepEqual(prepared.attemptsByTaskId[42], []);

    clickAction(dom, "create-production-task");
    const running = parsedSnapshot(dom);
    assert.equal(running.tasksById[42].status, "running");
    assert.equal(running.attemptsByTaskId[42].length, 1);
    assert.deepEqual(running.tasksById[42].goalSnapshot, prepared.tasksById[42].goalSnapshot);
    assert.deepEqual(running.attemptsByTaskId[42][0].inputSnapshot, {
      targetVersionId: "ver-shop-20260718-1913",
      artifactRefs: expectedArtifactRefs("7f3a91c2".repeat(8)),
      sourceCommit: null,
      codeConnectionRevision: null,
      sourceBindingId: null,
      repositoryScope: null,
      registryConnectionRevision: "registry-team@1",
      registryConnectionId: "registry-team",
      serverConnectionId: "server-production-main",
      serverConnectionRevision: "server-production-main@1",
      configProfileIds: ["config-production-provider", "config-production-admin"],
      configProfileRevisions: { "config-production-provider": 1, "config-production-admin": 1 },
      configRevision: "config-production-admin@1+config-production-provider@1",
      activeAddress: "https://shop.example.com",
      desiredAddress: null,
      address: "https://shop.example.com",
      projectServiceIds: ["api", "ocr", "web"],
      serviceRevision: "service-2",
      deploymentRevision: "deploy-v4",
    });

    clickAction(dom, "finish-production");
    clickPage(dom, "versions");
    clickAction(dom, "rollback-history");
    const rollbackPrepared = parsedSnapshot(dom);
    assert.equal(rollbackPrepared.activeTaskId, 43);
    assert.equal(rollbackPrepared.tasksById[42].status, "completed");
    assert.equal(rollbackPrepared.tasksById[42].goalSnapshot.intent, "publish");
    assert.deepEqual(rollbackPrepared.attemptsByTaskId[43], []);
    assert.deepEqual(rollbackPrepared.tasksById[43].goalSnapshot, {
      targetVersionId: "ver-shop-20260717-1042",
      expectedResult: "production-release",
      environment: "production",
      intent: "rollback",
    });

    clickAction(dom, "create-production-task");
    const rollbackRunning = parsedSnapshot(dom);
    assert.equal(rollbackRunning.attemptsByTaskId[43].length, 1);
    assert.equal(rollbackRunning.attemptsByTaskId[43][0].inputSnapshot.targetVersionId, "ver-shop-20260717-1042");
    assert.deepEqual(rollbackRunning.attemptsByTaskId[43][0].inputSnapshot.artifactRefs, expectedArtifactRefs("5bc177e8".repeat(8)));
    assert.equal(rollbackRunning.tasksById[42].goalSnapshot.targetVersionId, "ver-shop-20260718-1913");
  } finally {
    dom.window.close();
  }
});

test("P25 已完成正式发布后单独维护地址，不会伪造新的部署任务或执行", async () => {
  const dom = await loadPrototype();
  try {
    qualifyCurrent(dom, "update");
    clickPage(dom, "versions");
    clickAction(dom, "publish-current");
    clickAction(dom, "create-production-task");
    clickAction(dom, "finish-production");

    const beforeAddressEdit = parsedSnapshot(dom);
    assert.equal(beforeAddressEdit.tasksById[42].status, "completed");
    assert.equal(beforeAddressEdit.attemptsByTaskId[42].length, 1);
    assert.equal(beforeAddressEdit.activeTaskId, null);

    clickPage(dom, "settings");
    clickAction(dom, "edit-address");
    fillField(dom, "addressDraftDomain", "new.acme.cn");
    clickAction(dom, "save-production-address");
    const addressPending = parsedSnapshot(dom);
    assert.deepEqual(Object.keys(addressPending.tasksById), Object.keys(beforeAddressEdit.tasksById));
    assert.equal(addressPending.attemptsByTaskId[42].length, 1);
    assert.equal(addressPending.activeTaskId, null);
    assert.equal(addressPending.productionServiceDeployed, true);
    assert.equal(addressPending.productionComplete, false);

    clickPage(dom, "release");
    assert.match(contentText(dom), /正式服务仍在线，还差确认新地址.*new\.acme\.cn/s);
    assert.doesNotMatch(contentText(dom), /正在发布给正式用户|任务 #43/);
    clickAction(dom, "finish-address-check");
    clickAction(dom, "finish-address-check");

    const completed = parsedSnapshot(dom);
    assert.deepEqual(Object.keys(completed.tasksById), Object.keys(beforeAddressEdit.tasksById));
    assert.equal(completed.activeTaskId, null);
    assert.equal(completed.productionAddressReady, true);
    assert.equal(completed.environmentBindings.production.address, "https://new.acme.cn");
  } finally {
    dom.window.close();
  }
});

test("P26 冷启动只在真实连接、必填配置和服务器能力就绪后冻结执行输入", async () => {
  const dom = await loadPrototype();
  try {
    completeColdSetup(dom, "203.0.113.44");
    const running = parsedSnapshot(dom);
    assert.equal(running.registryConnectionStatus, "ready");
    assert.deepEqual(running.registryConnection, {
      id: "registry-primary",
      endpoint: "ccr.ccs.tencentyun.com/acme",
      pushEndpoint: "ccr.ccs.tencentyun.com/acme",
      pullEndpoint: "ccr.ccs.tencentyun.com/acme",
      accountLabel: "registry-user",
      verifiedAt: "刚刚",
      revision: 1,
      readable: true,
    });
    const serverId = running.environmentBindings.staging.serverConnectionId;
    assert.equal(running.serverConnections[serverId].host, "203.0.113.44");
    assert.equal(running.serverConnections[serverId].verified, true);
    assert.equal(running.serverConnections[serverId].capability, "clean");
    assert.deepEqual(running.environmentBindings.staging.configProfileIds.sort(), ["config-shop-staging-admin-password", "config-staging-provider"]);
    const input = running.attemptsByTaskId[31][0].inputSnapshot;
    assert.equal(input.sourceCommit.length, 40);
    assert.equal(input.codeConnectionRevision, "code-cnb-account@1");
    assert.equal(input.sourceBindingId, "source-project-shop-demo");
    assert.equal(input.repositoryScope, "demo/shop");
    assert.equal(input.registryConnectionRevision, "registry-primary@1");
    assert.equal(input.serverConnectionRevision, `${serverId}@1`);
    assert.equal(input.configRevision, null);
    assert.deepEqual(input.configProfileRevisions, { "config-shop-staging-admin-password": 1, "config-staging-provider": 1 });

    clickAction(dom, "finish-deployment");
    const finished = parsedSnapshot(dom);
    const evidence = finished.versionValidations["ver-shop-20260718-1913"];
    const version = finished.versionsById["ver-shop-20260718-1913"];
    assert.equal(evidence.address, finished.environmentBindings.staging.address);
    assert.equal(evidence.configRevision, "config-shop-staging-admin-password@1+config-staging-provider@1");
    assert.equal("sourceTaskId" in evidence, false);
    assert.equal("artifactRefs" in evidence, false);
    assert.equal(version.sourceTaskId, 31);
    assert.equal(version.sourceAttemptId, "attempt-31-1");
    assert.deepEqual(version.artifactRefs, finished.attemptsByTaskId[31][0].outputSnapshot.artifactRefs);
    assert.equal(finished.attemptsByTaskId[31][0].status, "succeeded");
    assert.equal(finished.attemptsByTaskId[31][0].stage, "completed");
    assert.deepEqual(finished.attemptsByTaskId[31][0].outputSnapshot.environmentSnapshot, {
      configRevision: "config-shop-staging-admin-password@1+config-staging-provider@1",
      serviceRevision: "service-2",
      deploymentRevision: "deploy-v4",
      serverConnectionId: serverId,
      serverConnectionRevision: `${serverId}@1`,
      address: finished.environmentBindings.staging.address,
      healthCheck: "passed",
    });
  } finally {
    dom.window.close();
  }
});

test("P27 正式环境新增服务器必须经过凭据、身份和能力检查后才能绑定", async () => {
  const dom = await loadPrototype();
  try {
    openFirstProduction(dom);
    clickAction(dom, "show-alternative-server");
    assert.match(sheetText(dom), /还没有其他已验证的运行位置/);
    clickAction(dom, "add-production-server");
    fillField(dom, "connectionHost", "198.51.100.77");
    fillField(dom, "connectionUser", "ubuntu");
    fillField(dom, "connectionServerSecret", "server-secret");
    clickAction(dom, "save-resource-connection");
    assert.match(sheetText(dom), /确认服务器身份/);
    assert.equal(parsedSnapshot(dom).serverConnections[parsedSnapshot(dom).connectionDraftServerId].verified, false);
    clickAction(dom, "confirm-resource-server-identity");
    assert.match(sheetText(dom), /确认运行位置能力/);
    clickAction(dom, "save-resource-server");
    assert.match(sheetText(dom), /请先确认允许系统初始化统一访问服务/);
    clickAction(dom, "confirm-server-change");
    clickAction(dom, "save-resource-server");
    assert.equal(dom.window.document.querySelector("#drawer-title").textContent, "选择正式版运行的位置");
    const ready = parsedSnapshot(dom);
    const serverId = ready.productionServerConnectionId;
    assert.equal(ready.serverConnections[serverId].verified, true);
    assert.equal(ready.serverConnections[serverId].capability, "clean");
    assert.equal(ready.environmentBindings.production.serverConnectionId, null);
    clickAction(dom, "save-production-question");
    assert.equal(parsedSnapshot(dom).environmentBindings.production.serverConnectionId, serverId);
  } finally {
    dom.window.close();
  }
});

test("P28 版本保存连接维护真实端点和修订，不能只靠全局 ready 状态", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    clickAction(dom, "show-connections");
    assert.match(sheetText(dom), /ccr\.ccs\.tencentyun\.com\/team.*推送和读取已验证/s);
    clickAction(dom, "edit-registry-connection");
    assert.equal(dom.window.document.querySelector('[data-field="connectionRegistryEndpoint"]').value, "ccr.ccs.tencentyun.com/team");
    fillField(dom, "connectionRegistryEndpoint", "registry.example.cn/acme");
    fillField(dom, "connectionRegistryAccount", "acme-registry");
    fillField(dom, "connectionToken", "registry-secret");
    clickAction(dom, "save-resource-connection");
    const saved = parsedSnapshot(dom);
    assert.equal(saved.registryConnectionStatus, "ready");
    assert.equal(saved.registryConnection.endpoint, "registry.example.cn/acme");
    assert.equal(saved.registryConnection.pushEndpoint, "registry.example.cn/acme");
    assert.equal(saved.registryConnection.pullEndpoint, "registry.example.cn/acme");
    assert.equal(saved.registryConnection.revision, 1);
  } finally {
    dom.window.close();
  }
});

test("P29 配置完整性按必填 Key 判断，任意配置名不能冒充启动条件", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "needs");
    clickAction(dom, "continue-setup");
    clickAction(dom, "use-config-center");
    fillField(dom, "newConfigLabel", "无关配置");
    fillField(dom, "newConfigKey", "FOO");
    fillField(dom, "newConfigValue", "bar");
    clickAction(dom, "create-config-profile");
    fillField(dom, "adminPassword", "admin-secret");
    clickAction(dom, "save-setup-question");
    assert.match(sheetText(dom), /请选择或新建第三方服务访问密钥/);
    assert.equal(parsedSnapshot(dom).attemptsByTaskId[31].length, 0);

    clickAction(dom, "use-config-center");
    clickAction(dom, "bind-config-profile");
    clickAction(dom, "save-setup-question");
    const running = parsedSnapshot(dom);
    assert.equal(running.attemptsByTaskId[31].length, 1);
    assert.equal(running.attemptsByTaskId[31][0].inputSnapshot.configRevision, null);
    const unrelatedProfile = running.configProfiles.find((profile) => profile.key === "FOO");
    assert.ok(unrelatedProfile);
    assert.deepEqual(running.attemptsByTaskId[31][0].inputSnapshot.configProfileRevisions, {
      [unrelatedProfile.id]: 1,
      "config-shop-staging-admin-password": 1,
      "config-staging-provider": 1,
    });
    clickAction(dom, "finish-deployment");
    const completed = parsedSnapshot(dom);
    assert.deepEqual(completed.environmentBindings.staging.appliedConfigRevisions, {
      [unrelatedProfile.id]: 1,
      "config-shop-staging-admin-password": 1,
      "config-staging-provider": 1,
    });
  } finally {
    dom.window.close();
  }
});

test("P30 修改正式地址时旧地址持续在线，完成检查后才提升新地址", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    clickPage(dom, "settings");
    clickAction(dom, "edit-address");
    fillField(dom, "addressDraftDomain", "new.acme.cn");
    clickAction(dom, "save-production-address");
    const pending = parsedSnapshot(dom);
    assert.equal(pending.productionActiveDomain, "shop.example.com");
    assert.equal(pending.environmentBindings.production.address, "https://shop.example.com");
    assert.equal(pending.environmentBindings.production.desiredAddress, "https://new.acme.cn");
    assert.match(contentText(dom), /旧地址 https:\/\/shop\.example\.com 继续在线/);

    clickAction(dom, "finish-address-check");
    clickAction(dom, "finish-address-check");
    const promoted = parsedSnapshot(dom);
    assert.equal(promoted.productionActiveDomain, "new.acme.cn");
    assert.equal(promoted.environmentBindings.production.address, "https://new.acme.cn");
    assert.equal(promoted.environmentBindings.production.desiredAddress, null);
  } finally {
    dom.window.close();
  }
});

test("P31 服务器或配置事实失效后不能靠历史 ready 状态跳过正式准备", async () => {
  const dom = await loadPrototype();
  try {
    qualifyCurrent(dom, "update");
    clickAction(dom, "show-config-center");
    const productionProfile = [...dom.window.document.querySelectorAll('[data-action="edit-config-profile"]')]
      .find((button) => button.dataset.profileId === "config-production-provider");
    assert.ok(productionProfile);
    productionProfile.click();
    assert.equal(dom.window.document.querySelector('[data-field="editConfigKey"]').readOnly, true);
    clickAction(dom, "unbind-config-profile");
    clickAction(dom, "close-sheet");

    clickPage(dom, "versions");
    clickAction(dom, "publish-current");
    assert.equal(dom.window.document.querySelector("#drawer-title").textContent, "选择正式版运行的位置");
    assert.equal(parsedSnapshot(dom).environmentBindings.production.configProfileIds.includes("config-production-provider"), false);

    const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
    const tabletBlock = css.match(/@media \(max-width: 920px\) \{[\s\S]*?(?=@media \(max-width: 700px\))/)?.[0] ?? "";
    assert.doesNotMatch(tabletBlock, /workspace-nav[\s\S]*display:\s*none/);
  } finally {
    dom.window.close();
  }
});

test("P32 取消修改正式地址不会污染发布复核或执行输入", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    const before = parsedSnapshot(dom);
    assert.equal(before.formValues.productionDomain, "shop.example.com");
    assert.equal(before.environmentBindings.production.address, "https://shop.example.com");

    clickPage(dom, "settings");
    clickAction(dom, "edit-address");
    fillField(dom, "addressDraftDomain", "cancelled.example.com");
    clickAction(dom, "close-sheet");

    const canceled = parsedSnapshot(dom);
    assert.equal(canceled.formValues.productionDomain, "shop.example.com");
    assert.equal(canceled.formValues.addressDraftDomain, "");
    assert.equal(canceled.environmentBindings.production.address, "https://shop.example.com");
    assert.equal(canceled.environmentBindings.production.desiredAddress ?? null, null);

    clickPage(dom, "release");
    clickAction(dom, "open-test-site");
    clickAction(dom, "confirm-test-passed");
    clickPage(dom, "versions");
    clickAction(dom, "publish-current");
    assert.match(sheetText(dom), /正式地址\s*https:\/\/shop\.example\.com/);
    assert.doesNotMatch(sheetText(dom), /cancelled\.example\.com/);
    clickAction(dom, "create-production-task");

    const running = parsedSnapshot(dom);
    const attempt = running.attemptsByTaskId[running.activeTaskId].at(-1);
    assert.equal(attempt.inputSnapshot.address, "https://shop.example.com");
  } finally {
    dom.window.close();
  }
});

test("P33 已有部署只从匹配的不可变发现快照接入", async () => {
  const rejectedDom = await loadPrototype();
  try {
    advanceExistingConnections(rejectedDom, "192.0.2.99");
    const rejected = parsedSnapshot(rejectedDom);
    assert.equal(rejected.existingManaged, false);
    assert.equal(rejected.existingDiscoverySnapshotId, null);
    assert.match(sheetText(rejectedDom), /没有在这台服务器发现对应部署|与本机发现的已有部署不一致/);
    assert.equal(rejected.versionValidations["ver-shop-20260717-1042"], undefined);
    assert.equal(rejected.environmentBindings.production.configProfileIds.length, 0);
    assert.equal(rejectedDom.window.document.querySelector('[data-action="confirm-adopt-existing"]'), null);
  } finally {
    rejectedDom.window.close();
  }

  const acceptedDom = await loadPrototype();
  try {
    advanceExistingConnections(acceptedDom, "203.0.113.10");
    assert.match(sheetText(acceptedDom), /远程事实快照/);
    clickAction(acceptedDom, "confirm-adopt-existing");
    const imported = parsedSnapshot(acceptedDom);
    const discoveryId = imported.existingDiscoverySnapshotId;
    const discovery = imported.discoverySnapshotsById[discoveryId];
    assert.ok(discovery?.observedAt);
    assert.equal(discovery.serverHost, "203.0.113.10");
    assert.equal(imported.existingManaged, true);
    assert.equal(imported.versionsById["ver-shop-20260717-1042"].sourceDiscoverySnapshotId, discoveryId);
    assert.equal(imported.versionsById["ver-shop-20260715-1820"].sourceDiscoverySnapshotId, discoveryId);
    assert.equal("sourceDiscoverySnapshotId" in imported.versionValidations["ver-shop-20260717-1042"], false);
    assert.equal("artifactRefs" in imported.versionValidations["ver-shop-20260717-1042"], false);
    for (const environment of ["staging", "production"]) {
      const taskId = `import-${discoveryId}-${environment}`;
      assert.equal(imported.attemptsByTaskId[taskId][0].externalRunId, null);
      assert.equal(imported.attemptsByTaskId[taskId][0].outputSnapshot.environmentSnapshot.healthCheck, "passed");
    }
    for (const id of imported.environmentBindings.production.configProfileIds) {
      const profile = imported.configProfiles.find((item) => item.id === id);
      assert.equal(profile.sourceDiscoverySnapshotId, discoveryId);
      assert.equal(profile.valueReady, true);
    }
  } finally {
    acceptedDom.window.close();
  }
});

test("P34 更新代码平台授权会递增连接修订并冻结到新的 Attempt", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "failure");
    const before = parsedSnapshot(dom);
    const oldConnection = before.codeConnection;
    const oldAttempts = before.attemptsByTaskId[24];
    assert.equal(oldConnection.status, "invalid");
    assert.equal(oldAttempts.at(-1).inputSnapshot.codeConnectionRevision, `${oldConnection.id}@${oldConnection.revision}`);

    clickAction(dom, "open-recovery-task");
    fillField(dom, "replacementToken", "replacement-token");
    clickAction(dom, "save-recovery");
    const recovered = parsedSnapshot(dom);
    assert.equal(recovered.codeConnection.id, oldConnection.id);
    assert.equal(recovered.codeConnection.revision, oldConnection.revision + 1);
    assert.equal(recovered.codeConnection.status, "ready");
    const attempts = recovered.attemptsByTaskId[24];
    assert.equal(attempts.length, oldAttempts.length + 1);
    assert.equal(attempts.at(-2).inputSnapshot.codeConnectionRevision, `${oldConnection.id}@${oldConnection.revision}`);
    assert.equal(attempts.at(-1).inputSnapshot.codeConnectionRevision, `${oldConnection.id}@${oldConnection.revision + 1}`);
  } finally {
    dom.window.close();
  }
});

test("P35 更换默认版本仓库后历史版本仍固定到原 ArtifactRef", async () => {
  const dom = await loadPrototype();
  try {
    qualifyCurrent(dom, "update");
    const qualified = parsedSnapshot(dom);
    const versionId = "ver-shop-20260718-1913";
    const originalRefs = structuredClone(qualified.versionsById[versionId].artifactRefs);
    const oldRegistryId = originalRefs[0].registryConnectionId;

    clickAction(dom, "show-connections");
    clickAction(dom, "edit-registry-connection");
    fillField(dom, "connectionRegistryEndpoint", "new-registry.example.cn/team");
    fillField(dom, "connectionRegistryAccount", "new-user");
    fillField(dom, "connectionToken", "new-registry-secret");
    clickAction(dom, "save-resource-connection");

    const changed = parsedSnapshot(dom);
    assert.notEqual(changed.activeRegistryConnectionId, oldRegistryId);
    assert.deepEqual(changed.versionsById[versionId].artifactRefs, originalRefs);
    assert.equal(changed.registryConnectionsById[oldRegistryId].readable, true);

    clickPage(dom, "versions");
    clickAction(dom, "publish-current");
    clickAction(dom, "create-production-task");
    const running = parsedSnapshot(dom);
    const attempt = running.attemptsByTaskId[running.activeTaskId].at(-1);
    assert.deepEqual(attempt.inputSnapshot.artifactRefs, originalRefs);
    assert.equal(attempt.inputSnapshot.registryConnectionRevision, originalRefs[0].registryConnectionRevision);
  } finally {
    dom.window.close();
  }
});

test("P36 单独维护地址完成后回到日常发布中心且不冒充正式发布", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    const taskIds = Object.keys(parsedSnapshot(dom).tasksById);
    clickPage(dom, "settings");
    clickAction(dom, "edit-address");
    fillField(dom, "addressDraftDomain", "new.acme.cn");
    clickAction(dom, "save-production-address");
    clickAction(dom, "finish-address-check");
    clickAction(dom, "finish-address-check");

    const completed = parsedSnapshot(dom);
    assert.deepEqual(Object.keys(completed.tasksById), taskIds);
    assert.equal(completed.activeTaskId, null);
    assert.equal(completed.lastCompletion.kind, "address");
    assert.equal(completed.productionComplete, false);
    assert.doesNotMatch(contentText(dom), /正式发布完成|正式版已经更新/);
    assert.match(contentText(dom), /正式地址已经更新.*new\.acme\.cn.*没有创建发布任务/s);
    assert.match(contentText(dom), /日常更新/);
  } finally {
    dom.window.close();
  }
});

test("P37 DNS 记录根据服务器地址生成 A、AAAA 或 CNAME", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const seed = parsedSnapshot(seedDom);
  seedDom.window.close();

  for (const [host, type, value] of [
    ["203.0.113.10", "A", "203.0.113.10"],
    ["2001:db8::10", "AAAA", "2001:db8::10"],
    ["edge.example.net", "CNAME", "edge.example.net"],
  ]) {
    const fixture = structuredClone(seed);
    const serverId = fixture.environmentBindings.production.serverConnectionId;
    fixture.serverConnections[serverId].host = host;
    const dom = await loadPrototype(JSON.stringify(fixture));
    try {
      let copied = null;
      Object.defineProperty(dom.window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => { copied = text; } },
      });
      clickPage(dom, "settings");
      clickAction(dom, "edit-address");
      fillField(dom, "addressDraftDomain", "app.example.com");
      clickAction(dom, "save-production-address");
      assert.match(contentText(dom), new RegExp(`类型 ${type}`));
      clickAction(dom, "copy-dns-record");
      await tick(dom);
      assert.equal(copied, `app.example.com ${type} ${value}`);
    } finally {
      dom.window.close();
    }
  }
});

test("P38 账户连接可共享，但仓库、版本、产物和自动化规则必须按项目隔离", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    clickPage(dom, "versions");
    clickAction(dom, "show-projects");
    const beforeAdd = parsedSnapshot(dom);
    clickAction(dom, "add-project");
    const afterAdd = parsedSnapshot(dom);
    assert.equal(afterAdd.projects.length, 2);
    assert.equal(afterAdd.currentProjectId, "project-customer-portal");
    assert.deepEqual(afterAdd.tasksById, {});
    assert.equal(afterAdd.currentProductionVersionId, null);
    assert.equal(afterAdd.codeConnection.id, beforeAdd.codeConnection.id);
    assert.equal(afterAdd.registryConnection.id, beforeAdd.registryConnection.id);
    assert.equal(afterAdd.sourceBinding, null);
    assert.equal(afterAdd.setupNeeds.includes("permission"), false);
    assert.match(contentText(dom), /识别到 2 个项目服务/);
    clickPage(dom, "local");
    assert.match(contentText(dom), /2\/2 正在运行/);
    assert.doesNotMatch(contentText(dom), /OCR 服务/);
    clickPage(dom, "release");

    clickAction(dom, "start-first-test");
    const afterRepositoryCheck = parsedSnapshot(dom);
    assert.deepEqual(afterRepositoryCheck.sourceBinding, {
      id: "source-project-customer-portal",
      projectId: "project-customer-portal",
      codeConnectionId: "code-cnb-account",
      repositoryScope: "demo/customer-portal",
      verified: true,
      verificationStatus: "passed",
      revision: 1,
      verifiedConnectionRevision: "code-cnb-account@1",
      verifiedAt: "刚刚",
      evidenceId: "source-proof-project-customer-portal-1",
      verifiedFrom: "local-remote-and-provider-read",
    });
    assert.equal(afterRepositoryCheck.codeConnection.revision, beforeAdd.codeConnection.revision);
    assert.equal(dom.window.document.querySelector('[data-field="publishToken"]'), null);
    assert.match(sheetText(dom), /选择测试版运行的位置/);
    clickAction(dom, "select-recommended-runtime");
    clickAction(dom, "save-setup-question");
    bindRecommendedConfig(dom, "use-config-center");
    fillField(dom, "adminPassword", "customer-admin-secret");
    clickAction(dom, "save-setup-question");
    const customerRunning = parsedSnapshot(dom);
    const customerTask = customerRunning.tasksById[31];
    assert.equal(customerTask.projectId, "project-customer-portal");
    assert.match(customerTask.goalSnapshot.sourceCommit, /^[0-9a-f]{40}$/);
    assert.equal(customerRunning.attemptsByTaskId[31][0].inputSnapshot.sourceBindingId, "source-project-customer-portal");
    assert.equal(customerRunning.attemptsByTaskId[31][0].inputSnapshot.repositoryScope, "demo/customer-portal");
    clickAction(dom, "finish-deployment");
    const customerCompleted = parsedSnapshot(dom);
    const customerVersionId = "ver-customer-portal-20260718-1913";
    assert.ok(customerCompleted.versionsById[customerVersionId]);
    assert.deepEqual(customerCompleted.versionsById[customerVersionId].artifactRefs, expectedArtifactRefs(
      "7f3a91c2".repeat(8),
      "ccr.ccs.tencentyun.com/team",
      "registry-team",
      1,
      ["api", "web"],
    ).map((ref) => ({ ...ref, repository: ref.repository.replace("/shop-", "/customer-portal-") })));
    assert.equal(customerCompleted.automationRule.providerRef.externalRuleId, "rule-customer-portal-main-staging");
    assert.equal(customerCompleted.automationRule.providerRef.repositoryScope, "demo/customer-portal");
    assert.equal(customerCompleted.environmentBindings.staging.address, "https://customer-portal-test.example.net");

    clickAction(dom, "show-projects");
    dom.window.document.querySelector('[data-action="open-project"][data-project-id="project-shop-demo"]').click();
    const restoredProject = parsedSnapshot(dom);
    assert.deepEqual(restoredProject.tasksById, beforeAdd.tasksById);
    assert.deepEqual(restoredProject.attemptsByTaskId, beforeAdd.attemptsByTaskId);
    assert.equal(restoredProject.currentProductionVersionId, beforeAdd.currentProductionVersionId);
    assert.equal(restoredProject.sourceBinding.repositoryScope, "demo/shop");
    assert.equal(dom.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "发布中心");

    clickPage(dom, "settings");
    const saved = snapshot(dom);
    const ordinaryReload = await loadPrototype(saved);
    try {
      assert.equal(ordinaryReload.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "发布中心");
    } finally {
      ordinaryReload.window.close();
    }

    const deepLink = await loadPrototype(saved, "https://prototype.test/?project=project-shop-demo&page=settings");
    try {
      assert.equal(deepLink.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "项目设置");
      clickAction(deepLink, "open-project");
      assert.equal(deepLink.window.location.search, "");
      assert.equal(deepLink.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "发布中心");
    } finally {
      deepLink.window.close();
    }

    const otherProjectDeepLink = await loadPrototype(saved, "https://prototype.test/?project=project-customer-portal&page=versions");
    try {
      clickPage(otherProjectDeepLink, "settings");
      clickPage(otherProjectDeepLink, "versions");
      const customerRestored = parsedSnapshot(otherProjectDeepLink);
      assert.match(otherProjectDeepLink.window.document.querySelector(".project-title").textContent, /客户门户/);
      assert.equal(customerRestored.tasksById[31].projectId, "project-customer-portal");
      assert.ok(customerRestored.versionsById[customerVersionId]);
      assert.equal(customerRestored.versionsById["ver-shop-20260718-1913"], undefined);
    } finally {
      otherProjectDeepLink.window.close();
    }

    const invalidDeepLink = await loadPrototype(saved, "https://prototype.test/?project=another-project&page=tasks");
    try {
      assert.equal(invalidDeepLink.window.document.querySelector('.project-nav [aria-current="page"]').textContent.trim(), "发布中心");
    } finally {
      invalidDeepLink.window.close();
    }
  } finally {
    dom.window.close();
  }
});

test("P39 测试任务创建时冻结完整提交，后续 HEAD 变化不会改写目标", async () => {
  const dom = await loadPrototype();
  try {
    clickAction(dom, "start-first-test");
    assert.deepEqual(parsedSnapshot(dom)?.tasksById ?? {}, {});
    fillField(dom, "publishToken", "source-binding-token");
    clickAction(dom, "save-setup-question");
    const prepared = parsedSnapshot(dom);
    const frozenCommit = prepared.tasksById[31].goalSnapshot.sourceCommit;
    assert.match(frozenCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(prepared.attemptsByTaskId[31], []);

    prepared.sourceRevision.commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const resumed = await loadPrototype(JSON.stringify(prepared));
    try {
      clickAction(resumed, "continue-setup");
      completeOpenSetup(resumed);
      const running = parsedSnapshot(resumed);
      assert.equal(running.tasksById[31].goalSnapshot.sourceCommit, frozenCommit);
      assert.equal(running.attemptsByTaskId[31][0].inputSnapshot.sourceCommit, frozenCommit);
      assert.notEqual(running.attemptsByTaskId[31][0].inputSnapshot.sourceCommit, running.sourceRevision.commit);
    } finally {
      resumed.window.close();
    }

    const invalid = structuredClone(prepared);
    invalid.activeTaskId = null;
    invalid.tasksById = {};
    invalid.attemptsByTaskId = {};
    invalid.scenario = "first";
    invalid.sourceRevision.commit = "3951fbb";
    const invalidSource = await loadPrototype(JSON.stringify(invalid));
    try {
      clickAction(invalidSource, "start-first-test");
      const rejected = parsedSnapshot(invalidSource);
      assert.equal(rejected.activeTaskId, null);
      assert.deepEqual(rejected.tasksById, {});
      assert.deepEqual(rejected.attemptsByTaskId, {});
    } finally {
      invalidSource.window.close();
    }
  } finally {
    dom.window.close();
  }
});

test("P40 自动更新规则区分期望与实际，暂停、恢复和修复都不创建部署任务", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    const before = parsedSnapshot(dom);
    clickPage(dom, "settings");
    clickAction(dom, "manage-automation");
    assert.match(sheetText(dom), /main 分支.*生成不可变版本并更新测试环境.*不发布正式版/s);

    clickAction(dom, "pause-automation-rule");
    const paused = parsedSnapshot(dom);
    assert.equal(paused.automationRule.desiredState.status, "paused");
    assert.equal(paused.automationRule.observedState.status, "paused");
    assert.equal(paused.automationRule.syncState.status, "synced");
    assert.deepEqual(paused.tasksById, before.tasksById);
    assert.deepEqual(paused.attemptsByTaskId, before.attemptsByTaskId);

    clickAction(dom, "resume-automation-rule");
    const resumed = parsedSnapshot(dom);
    assert.equal(resumed.automationRule.id, before.automationRule.id);
    assert.equal(resumed.automationRule.desiredState.status, "enabled");
    assert.equal(resumed.automationRule.observedState.status, "enabled");
    clickAction(dom, "simulate-automation-failure");
    const failed = parsedSnapshot(dom);
    assert.equal(failed.automationRule.desiredState.status, "enabled");
    assert.equal(failed.automationRule.observedState.status, "paused");
    assert.equal(failed.automationRule.syncState.status, "failed");
    assert.equal(dom.window.document.querySelectorAll('[data-action="repair-automation-rule"]').length, 1);
    assert.equal(dom.window.document.querySelector('[data-action="pause-automation-rule"]'), null);
    assert.equal(dom.window.document.querySelector('[data-action="resume-automation-rule"]'), null);

    clickAction(dom, "repair-automation-rule");
    const repaired = parsedSnapshot(dom);
    assert.equal(repaired.automationRule.id, before.automationRule.id);
    assert.equal(repaired.automationRule.syncState.status, "synced");
    assert.equal(repaired.automationRule.observedState.status, "enabled");
    assert.deepEqual(repaired.tasksById, before.tasksById);
    assert.deepEqual(repaired.versionsById, before.versionsById);
    assert.equal(repaired.currentProductionVersionId, before.currentProductionVersionId);
  } finally {
    dom.window.close();
  }
});

test("P41 配置仅保存不改变环境，显式确认和成功后才推进正式环境修订", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    const before = parsedSnapshot(dom);
    clickPage(dom, "settings");
    clickAction(dom, "show-config-center");
    dom.window.document.querySelector('[data-action="edit-config-profile"][data-profile-id="config-production-provider"]').click();
    fillField(dom, "editConfigValue", "new-library-secret");
    clickAction(dom, "save-config-profile-edit");
    const savedOnly = parsedSnapshot(dom);
    assert.equal(savedOnly.configProfiles.find((item) => item.id === "config-production-provider").revision, 2);
    assert.equal(savedOnly.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 1);
    assert.deepEqual(savedOnly.tasksById, before.tasksById);
    assert.doesNotMatch(snapshot(dom), /new-library-secret/);

    dom.window.document.querySelector('[data-action="edit-config-profile"][data-profile-id="config-production-provider"]').click();
    fillField(dom, "editConfigValue", "apply-this-secret");
    clickAction(dom, "save-and-apply-config");
    const awaitingConfirmation = parsedSnapshot(dom);
    assert.equal(Object.keys(awaitingConfirmation.tasksById).length, Object.keys(before.tasksById).length);
    assert.equal(awaitingConfirmation.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 1);
    assert.match(sheetText(dom), /正式环境.*修订 1 → 3.*版本不变.*当前正式版继续在线/s);

    clickAction(dom, "confirm-config-application");
    const running = parsedSnapshot(dom);
    assert.equal(running.tasksById[running.activeTaskId].kind, "config");
    assert.equal(running.tasksById[running.activeTaskId].environment, "production");
    assert.equal(running.tasksById[running.activeTaskId].goalSnapshot.profileRevision, 3);
    assert.equal(running.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 1);
    assert.equal(running.currentProductionVersionId, before.currentProductionVersionId);
    clickAction(dom, "close-sheet");
    clickAction(dom, "show-tasks");
    clickAction(dom, "resume-active-task");
    assert.match(sheetText(dom), /正在更新正式环境.*任务 #42/s);
    clickAction(dom, "finish-config-application");

    const completed = parsedSnapshot(dom);
    assert.equal(completed.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 3);
    assert.equal(completed.environmentBindings.staging.appliedConfigRevisions?.["config-staging-provider"] ?? 1, 1);
    assert.equal(completed.tasksById[42].status, "completed");
    assert.equal(completed.configProfiles.find((item) => item.id === "config-production-provider").revision, 3);
    assert.deepEqual(completed.versionsById, before.versionsById);
    assert.equal(completed.currentProductionVersionId, before.currentProductionVersionId);
    assert.doesNotMatch(snapshot(dom), /apply-this-secret/);
    clickPage(dom, "settings");
    clickAction(dom, "show-config-center");
    dom.window.document.querySelector('[data-action="edit-config-profile"][data-profile-id="config-production-provider"]').click();
    fillField(dom, "editConfigValue", "newer-after-completion");
    clickAction(dom, "save-config-profile-edit");

    const completedTaskCount = Object.keys(completed.tasksById).length;
    dom.window.document.querySelector('[data-action="edit-config-profile"][data-profile-id="config-production-provider"]').click();
    clickAction(dom, "save-and-apply-config");
    const nextApply = parsedSnapshot(dom);
    assert.equal(Object.keys(nextApply.tasksById).length, completedTaskCount);
    assert.equal(nextApply.activeTaskId, null);
    assert.match(sheetText(dom), /正式环境.*修订 3 → 4/s);
    assert.doesNotMatch(snapshot(dom), /newer-after-completion/);
  } finally {
    dom.window.close();
  }
});

test("P42 解除配置引用只影响指定项目环境", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  const profile = fixture.configProfiles.find((item) => item.id === "config-production-provider");
  profile.bindings = ["这是旧模型中的错误缓存，恢复时必须移除"];
  fixture.environmentBindings.staging.configProfileIds = fixture.environmentBindings.staging.configProfileIds
    .filter((id) => id !== "config-staging-provider")
    .concat("config-production-provider");
  fixture.environmentBindings.staging.appliedConfigRevisions = { "config-production-provider": 1, "config-staging-admin": 1 };
  fixture.environmentBindings.production.appliedConfigRevisions = { "config-production-provider": 1, "config-production-admin": 1 };
  fixture.projects.push({
    id: "project-customer-portal",
    name: "客户门户",
    path: "/Users/demo/Documents/customer-portal",
    services: 2,
    serviceIds: ["api", "web"],
    repositoryScope: "demo/customer-portal",
  });
  fixture.projectWorkspacesById["project-customer-portal"] = {
    environmentBindings: {
      staging: { serverConnectionId: null, configProfileIds: ["config-production-provider"], appliedConfigRevisions: { "config-production-provider": 1 }, address: null, desiredAddress: null },
      production: { serverConnectionId: null, configProfileIds: ["config-production-provider"], appliedConfigRevisions: { "config-production-provider": 1 }, address: null, desiredAddress: null },
    },
  };

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickPage(dom, "settings");
    clickAction(dom, "show-config-center");
    assert.match(sheetText(dom), /示例商城 \/ 测试环境.*示例商城 \/ 正式环境.*客户门户 \/ 测试环境.*客户门户 \/ 正式环境/s);
    assert.match(sheetText(dom), /2 个项目 · 4 个环境/);
    dom.window.document.querySelector('[data-action="edit-config-profile"][data-profile-id="config-production-provider"]').click();
    dom.window.document.querySelector('[data-action="select-config-edit-environment"][data-project-id="project-customer-portal"][data-config-environment="staging"]').click();
    assert.match(sheetText(dom), /解除客户门户 \/ 测试环境引用/);
    clickAction(dom, "unbind-config-profile");
    const unbound = parsedSnapshot(dom);
    assert.equal(unbound.environmentBindings.staging.configProfileIds.includes("config-production-provider"), true);
    assert.equal(unbound.environmentBindings.production.configProfileIds.includes("config-production-provider"), true);
    assert.equal(unbound.projectWorkspacesById["project-customer-portal"].environmentBindings.staging.configProfileIds.includes("config-production-provider"), false);
    assert.equal(unbound.projectWorkspacesById["project-customer-portal"].environmentBindings.production.configProfileIds.includes("config-production-provider"), true);
    assert.equal("bindings" in unbound.configProfiles.find((item) => item.id === "config-production-provider"), false);
    assert.equal(unbound.configProfiles.some((item) => item.id === "config-production-provider"), true);
    assert.equal(unbound.currentProductionVersionId, fixture.currentProductionVersionId);
    assert.match(sheetText(dom), /2 个项目 · 3 个环境/);
  } finally {
    dom.window.close();
  }
});

test("P43 正式启动失败重试同一任务和产物，旧正式版在成功前保持在线", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "failure");
    selectFailureVariant(dom, "production-start");
    const before = parsedSnapshot(dom);
    assert.doesNotMatch(contentText(dom), /任务 #24/);
    assert.match(contentText(dom), /任务 #42 启动检查未通过/);
    assert.equal(dom.window.document.querySelectorAll('[data-action="retry-production-start"]').length, 1);
    clickAction(dom, "retry-production-start");
    const retrying = parsedSnapshot(dom);
    assert.equal(retrying.activeTaskId, before.activeTaskId);
    assert.deepEqual(retrying.tasksById[42].goalSnapshot, before.tasksById[42].goalSnapshot);
    assert.equal(retrying.attemptsByTaskId[42].length, before.attemptsByTaskId[42].length + 1);
    assert.equal(retrying.currentProductionVersionId, before.currentProductionVersionId);
    assert.deepEqual(retrying.attemptsByTaskId[42].at(-1).inputSnapshot.artifactRefs, before.versionsById["ver-shop-20260718-1913"].artifactRefs);
    clickAction(dom, "finish-production");
    assert.equal(parsedSnapshot(dom).currentProductionVersionId, "ver-shop-20260718-1913");
  } finally {
    dom.window.close();
  }
});

test("P44 配置缺失和服务器断连都回到准确停点，只给原正式任务增加 Attempt", async () => {
  const configDom = await loadPrototype();
  try {
    clickScenario(configDom, "failure");
    selectFailureVariant(configDom, "config-missing");
    const before = parsedSnapshot(configDom);
    assert.doesNotMatch(contentText(configDom), /任务 #24/);
    assert.match(contentText(configDom), /任务 #42 等待补齐正式配置/);
    assert.equal(before.attemptsByTaskId[42][0].inputSnapshot.configProfileIds.includes("config-production-provider"), false);
    assert.equal(before.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 1);
    clickAction(configDom, "repair-task-config");
    assert.match(sheetText(configDom), /正式环境配置.*持续绑定/s);
    const recommended = configDom.window.document.querySelector(".choice-card .status-badge.green")?.closest(".choice-card");
    assert.match(recommended?.textContent ?? "", /正式环境通用密钥.*推荐/s);
    configDom.window.document.querySelector('[data-action="bind-config-profile"][data-profile-id="config-production-provider"]').click();
    const repaired = parsedSnapshot(configDom);
    assert.equal(repaired.activeTaskId, 42);
    assert.equal(repaired.attemptsByTaskId[42].length, 2);
    assert.equal(repaired.recoveryIssue, null);
    assert.equal(repaired.currentProductionVersionId, before.currentProductionVersionId);
    assert.equal(repaired.attemptsByTaskId[42].at(-1).inputSnapshot.configProfileIds.length, 2);
    assert.equal(repaired.attemptsByTaskId[42].at(-1).inputSnapshot.configProfileRevisions["config-production-provider"], 2);
    assert.equal(repaired.environmentBindings.production.appliedConfigRevisions["config-production-provider"], 1);
    clickAction(configDom, "finish-production");
    assert.equal(parsedSnapshot(configDom).environmentBindings.production.appliedConfigRevisions["config-production-provider"], 2);
  } finally {
    configDom.window.close();
  }

  const serverDom = await loadPrototype();
  try {
    clickScenario(serverDom, "failure");
    selectFailureVariant(serverDom, "server-unreachable");
    const before = parsedSnapshot(serverDom);
    assert.doesNotMatch(contentText(serverDom), /任务 #24/);
    assert.match(contentText(serverDom), /任务 #42 等待重新验证运行位置/);
    assert.equal(before.attemptsByTaskId[42][0].inputSnapshot.serverConnectionRevision, null);
    clickAction(serverDom, "repair-task-server");
    fillField(serverDom, "connectionToken", "new-server-secret");
    clickAction(serverDom, "save-resource-connection");
    assert.match(sheetText(serverDom), /确认运行位置能力/);
    clickAction(serverDom, "save-resource-server");
    const repaired = parsedSnapshot(serverDom);
    assert.equal(repaired.activeTaskId, 42);
    assert.equal(repaired.attemptsByTaskId[42].length, 2);
    assert.equal(repaired.recoveryIssue, null);
    assert.equal(repaired.currentProductionVersionId, before.currentProductionVersionId);
    assert.equal(repaired.attemptsByTaskId[42].at(-1).inputSnapshot.serverConnectionRevision, "server-production-main@2");
  } finally {
    serverDom.window.close();
  }
});

test("P45 地址冲突必须先确认影响，接管成功后才提升新地址和正式版本", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "failure");
    selectFailureVariant(dom, "route-conflict");
    const before = parsedSnapshot(dom);
    assert.doesNotMatch(contentText(dom), /任务 #24/);
    assert.match(contentText(dom), /7 月 18 日 19:13 版本.*测试通过.*任务 #42 暂停在地址切换，原路由未变/s);
    clickAction(dom, "review-route-conflict");
    assert.match(sheetText(dom), /new-shop\.example\.com.*ABCDeploy 项目：旧版商城.*legacy-web:8080.*确认前保持在线.*备份原路由/s);
    clickAction(dom, "confirm-route-takeover");
    const retrying = parsedSnapshot(dom);
    assert.equal(retrying.activeTaskId, 42);
    assert.equal(retrying.attemptsByTaskId[42].length, 2);
    assert.equal(retrying.currentProductionVersionId, before.currentProductionVersionId);
    assert.equal(retrying.productionActiveDomain, "shop.example.com");
    assert.equal(retrying.environmentBindings.production.desiredAddress, "https://new-shop.example.com");
    clickAction(dom, "finish-production");
    const completed = parsedSnapshot(dom);
    assert.equal(completed.currentProductionVersionId, "ver-shop-20260718-1913");
    assert.equal(completed.productionActiveDomain, "new-shop.example.com");
    assert.equal(completed.environmentBindings.production.address, "https://new-shop.example.com");
    assert.equal(completed.environmentBindings.production.desiredAddress, null);
  } finally {
    dom.window.close();
  }
});

test("P46 Version、Task、Attempt 和验证证据任一不一致都不能获得发布资格", async () => {
  const seedDom = await loadPrototype();
  qualifyCurrent(seedDom, "update");
  const baseline = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = "ver-shop-20260718-1913";
  const mutations = [
    (fixture) => { fixture.versionValidations[versionId].versionId = "ver-other"; },
    (fixture) => { fixture.versionsById[versionId].artifactRefs[0].digest = "sha256:tampered"; },
    (fixture) => { fixture.tasksById[fixture.versionsById[versionId].sourceTaskId].resultVersionId = "ver-other"; },
    (fixture) => { fixture.attemptsByTaskId[fixture.versionsById[versionId].sourceTaskId][0].outputSnapshot.versionId = "ver-other"; },
  ];
  for (const mutate of mutations) {
    const fixture = structuredClone(baseline);
    mutate(fixture);
    const dom = await loadPrototype(JSON.stringify(fixture));
    try {
      clickPage(dom, "versions");
      assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);
      assert.match(contentText(dom), /验证证据不完整/);
    } finally {
      dom.window.close();
    }
  }
});

test("P47 正式完成只提升 Task 冻结的目标，不读取后来变化的页面选择", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "failure");
  selectFailureVariant(seedDom, "production-start");
  clickAction(seedDom, "retry-production-start");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.productionVersionId = "ver-shop-20260717-1042";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickAction(dom, "finish-production");
    const completed = parsedSnapshot(dom);
    assert.equal(completed.tasksById[42].goalSnapshot.targetVersionId, "ver-shop-20260718-1913");
    assert.equal(completed.productionVersionId, "ver-shop-20260717-1042");
    assert.equal(completed.currentProductionVersionId, "ver-shop-20260718-1913");
  } finally {
    dom.window.close();
  }
});

test("P48 旧快照中 verified 但 adaptable 的服务器必须重新处理", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.scenario = "first";
  fixture.setupNeeds = [];
  const serverId = fixture.environmentBindings.staging.serverConnectionId;
  fixture.serverConnections[serverId].verified = true;
  fixture.serverConnections[serverId].capability = "adaptable";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickAction(dom, "start-first-test");
    assert.match(sheetText(dom), /选择测试版运行的位置/);
    assert.equal(dom.window.document.querySelector('[data-server-capability="adaptable"]'), null);
    assert.equal(parsedSnapshot(dom).attemptsByTaskId[31].length, 0);
  } finally {
    dom.window.close();
  }
});

test("P49 错误项目仓库绑定不会进入 Attempt，恢复时以本项目代码来源重新核对", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.scenario = "first";
  fixture.sourceBinding.repositoryScope = "demo/customer-portal";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickPage(dom, "settings");
    clickPage(dom, "release");
    const restored = parsedSnapshot(dom);
    assert.equal(restored.sourceBinding.repositoryScope, "demo/customer-portal");
    assert.equal(restored.sourceBinding.verified, false);
    assert.equal(restored.sourceBinding.evidenceId, null);
    assert.equal(restored.tasksById[31], undefined);
    clickAction(dom, "start-first-test");
    const running = parsedSnapshot(dom);
    assert.equal(running.sourceBinding.repositoryScope, "demo/shop");
    assert.equal(running.sourceBinding.projectId, "project-shop-demo");
    assert.equal(running.attemptsByTaskId[31][0].inputSnapshot.repositoryScope, "demo/shop");
    assert.notEqual(running.attemptsByTaskId[31][0].inputSnapshot.repositoryScope, "demo/customer-portal");
  } finally {
    dom.window.close();
  }
});

test("P50 来源不明的现有路由只允许阻断，不提供一次确认式抢占", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "failure");
  selectFailureVariant(seedDom, "route-conflict");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.recoveryIssue.ownerType = "unknown";
  fixture.recoveryIssue.ownerProjectId = null;
  fixture.recoveryIssue.owner = "来源不明的服务器进程";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickAction(dom, "review-route-conflict");
    assert.match(sheetText(dom), /归属无法证明.*不会修改这条路由.*来源不明.*一律阻断/s);
    assert.equal(dom.window.document.querySelector('[data-action="confirm-route-takeover"]'), null);
  } finally {
    dom.window.close();
  }
});

test("P51 执行中配置绑定变化时不能用旧 Attempt 静默推进环境", async () => {
  const seedDom = await loadPrototype();
  completeColdSetup(seedDom);
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.environmentBindings.staging.configProfileIds = fixture.environmentBindings.staging.configProfileIds
    .filter((id) => id !== "config-staging-provider");

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickAction(dom, "finish-deployment");
    const blocked = parsedSnapshot(dom);
    assert.equal(blocked.tasksById[31].status, "running");
    assert.deepEqual(blocked.versionsById, {});
    assert.equal(blocked.environmentBindings.staging.appliedConfigRevisions["config-staging-provider"], undefined);
  } finally {
    dom.window.close();
  }
});

test("P52 旧快照恢复后移除 VersionValidation 与 ConfigProfile 的重复来源字段", async () => {
  const seedDom = await loadPrototype();
  qualifyCurrent(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = "ver-shop-20260718-1913";
  fixture.versionValidations[versionId].artifactRefs = structuredClone(fixture.versionsById[versionId].artifactRefs);
  fixture.versionValidations[versionId].sourceTaskId = fixture.versionsById[versionId].sourceTaskId;
  fixture.versionValidations[versionId].sourceAttemptId = fixture.versionsById[versionId].sourceAttemptId;
  fixture.configProfiles[0].bindings = ["过时缓存"];

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickPage(dom, "versions");
    const restored = parsedSnapshot(dom);
    assert.equal("artifactRefs" in restored.versionValidations[versionId], false);
    assert.equal("sourceTaskId" in restored.versionValidations[versionId], false);
    assert.equal("sourceAttemptId" in restored.versionValidations[versionId], false);
    assert.equal("bindings" in restored.configProfiles[0], false);
    assert.ok(dom.window.document.querySelector('[data-action="publish-current"]'));
  } finally {
    dom.window.close();
  }
});

test("P53 Version 产物必须完整且仅覆盖当前项目的全部服务", async () => {
  const seedDom = await loadPrototype();
  qualifyCurrent(seedDom, "update");
  const baseline = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = "ver-shop-20260718-1913";
  const sourceTaskId = baseline.versionsById[versionId].sourceTaskId;
  const mutations = [
    (fixture) => {
      fixture.versionsById[versionId].artifactRefs = fixture.versionsById[versionId].artifactRefs
        .filter((artifact) => artifact.serviceId !== "ocr");
      fixture.attemptsByTaskId[sourceTaskId][0].outputSnapshot.artifactRefs = fixture.attemptsByTaskId[sourceTaskId][0].outputSnapshot.artifactRefs
        .filter((artifact) => artifact.serviceId !== "ocr");
    },
    (fixture) => {
      const workerRef = {
        serviceId: "worker",
        repository: "ccr.ccs.tencentyun.com/team/shop-worker",
        digest: "sha256:7f3a…91c2-worker",
        registryConnectionId: "registry-team",
        registryConnectionRevision: "registry-team@1",
      };
      fixture.versionsById[versionId].artifactRefs.push(structuredClone(workerRef));
      fixture.attemptsByTaskId[sourceTaskId][0].outputSnapshot.artifactRefs.push(structuredClone(workerRef));
    },
  ];

  for (const mutate of mutations) {
    const fixture = structuredClone(baseline);
    mutate(fixture);
    const dom = await loadPrototype(JSON.stringify(fixture));
    try {
      clickPage(dom, "versions");
      const restored = parsedSnapshot(dom);
      assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null);
      assert.equal(restored.versionsById[versionId], undefined);
      assert.ok(restored.unresolvedLegacyVersionIds.includes(versionId));
    } finally {
      dom.window.close();
    }
  }
});

test("P54 Validation 六项事实必须逐项匹配成功 Attempt 的环境快照", async () => {
  const seedDom = await loadPrototype();
  qualifyCurrent(seedDom, "update");
  const baseline = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = "ver-shop-20260718-1913";
  const mutations = {
    configRevision: "config-other@9",
    serviceRevision: "service-other",
    deploymentRevision: "deploy-other",
    serverConnectionId: "server-other",
    address: "https://other-test.example.net",
    healthCheck: "failed",
  };

  for (const [field, value] of Object.entries(mutations)) {
    const fixture = structuredClone(baseline);
    fixture.versionValidations[versionId][field] = value;
    const dom = await loadPrototype(JSON.stringify(fixture));
    try {
      clickPage(dom, "versions");
      assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null, `${field} 不一致时仍出现发布按钮`);
      assert.match(contentText(dom), /验证证据不完整/);
    } finally {
      dom.window.close();
    }
  }
});

test("P55 同时伪造 Validation 和 Attempt 输出也不能绕过冻结执行输入", async () => {
  const seedDom = await loadPrototype();
  qualifyCurrent(seedDom, "update");
  const baseline = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = "ver-shop-20260718-1913";
  const sourceTaskId = baseline.versionsById[versionId].sourceTaskId;
  const mutations = {
    configRevision: "config-other@9",
    serviceRevision: "service-other",
    deploymentRevision: "deploy-other",
    serverConnectionId: "server-other",
  };

  for (const [field, value] of Object.entries(mutations)) {
    const fixture = structuredClone(baseline);
    fixture.versionValidations[versionId][field] = value;
    fixture.attemptsByTaskId[sourceTaskId][0].outputSnapshot.environmentSnapshot[field] = value;
    const dom = await loadPrototype(JSON.stringify(fixture));
    try {
      clickPage(dom, "versions");
      assert.equal(dom.window.document.querySelector('[data-action="publish-current"]'), null, `${field} 双向伪造后仍出现发布按钮`);
      assert.match(contentText(dom), /验证证据不完整/);
    } finally {
      dom.window.close();
    }
  }
});

test("P56 正式任务每次开始或恢复前都会重新校验目标版本资格", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "failure");
  selectFailureVariant(seedDom, "production-start");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  const versionId = fixture.tasksById[42].goalSnapshot.targetVersionId;
  fixture.versionValidations[versionId].serviceRevision = "service-tampered";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    const before = parsedSnapshot(dom);
    assert.throws(
      () => dom.window.startNextAttemptPatch(before.tasksById[42], {}, before),
      /已不再满足测试验证条件/,
    );
    clickAction(dom, "retry-production-start");
    const blocked = parsedSnapshot(dom);
    assert.equal(blocked.attemptsByTaskId[42].length, before.attemptsByTaskId[42].length);
    assert.equal(blocked.tasksById[42].status, before.tasksById[42].status);
    assert.equal(blocked.productionTask, null);
  } finally {
    dom.window.close();
  }
});

test("P57 账号可用但仓库读取失败时不创建任务，也不立即要求重输 Token", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.scenario = "first";
  fixture.sourceBinding = null;
  fixture.sourceProbeOutcome = "denied";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickAction(dom, "start-first-test");
    let blocked = parsedSnapshot(dom);
    assert.equal(blocked.sourceBinding.verified, false);
    assert.equal(blocked.sourceBinding.verificationStatus, "denied");
    assert.equal(blocked.tasksById[31], undefined);
    assert.equal(blocked.attemptsByTaskId[31], undefined);
    assert.match(sheetText(dom), /当前账号还不能读取这个项目.*没有创建任务.*只读取本机 Git remote 和代码平台仓库/s);
    assert.equal(dom.window.document.querySelector('[data-field="publishToken"]'), null);
    assert.equal(dom.window.document.querySelector('[data-field="connectionToken"]'), null);

    clickAction(dom, "recheck-source-binding");
    blocked = parsedSnapshot(dom);
    assert.equal(blocked.tasksById[31], undefined);
    assert.equal(blocked.sourceBinding.verified, false);
    clickAction(dom, "change-source-account");
    assert.ok(dom.window.document.querySelector('[data-field="connectionToken"]'));
    fillField(dom, "connectionToken", "replacement-account-token");
    clickAction(dom, "save-code-connection");
    const resumed = parsedSnapshot(dom);
    assert.equal(resumed.sourceBinding.verified, true);
    assert.equal(resumed.tasksById[31].kind, "test");
    assert.equal(resumed.attemptsByTaskId[31].length, 1);
  } finally {
    dom.window.close();
  }
});

test("P58 旧 SourceBinding 没有验证证据时恢复后必须降级，明确核对后才能执行", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.scenario = "first";
  delete fixture.sourceBinding.evidenceId;
  delete fixture.sourceBinding.verifiedAt;
  delete fixture.sourceBinding.verifiedConnectionRevision;

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickPage(dom, "settings");
    clickPage(dom, "release");
    const restored = parsedSnapshot(dom);
    assert.equal(restored.sourceBinding.verified, false);
    assert.equal(restored.sourceBinding.evidenceId, null);
    assert.equal(restored.tasksById[31], undefined);
    clickAction(dom, "start-first-test");
    const running = parsedSnapshot(dom);
    assert.equal(running.sourceBinding.verified, true);
    assert.equal(running.sourceBinding.verifiedConnectionRevision, "code-cnb-account@1");
    assert.match(running.sourceBinding.evidenceId, /^source-proof-project-shop-demo-1$/);
    assert.equal(running.attemptsByTaskId[31][0].inputSnapshot.sourceBindingId, "source-project-shop-demo");
  } finally {
    dom.window.close();
  }
});

test("P59 账号修订可共享，但其他项目绑定不会在切换时自动升级", async () => {
  const dom = await loadPrototype();
  try {
    clickScenario(dom, "update");
    clickAction(dom, "show-projects");
    clickAction(dom, "add-project");
    clickAction(dom, "start-first-test");
    let customer = parsedSnapshot(dom);
    assert.equal(customer.sourceBinding.revision, 1);
    assert.equal(customer.sourceBinding.verifiedConnectionRevision, "code-cnb-account@1");
    clickAction(dom, "close-sheet");
    clickAction(dom, "show-projects");
    dom.window.document.querySelector('[data-action="open-project"][data-project-id="project-shop-demo"]').click();
    clickAction(dom, "show-connections");
    clickAction(dom, "replace-code-connection");
    fillField(dom, "connectionToken", "rotated-account-token");
    clickAction(dom, "save-code-connection");
    assert.equal(parsedSnapshot(dom).codeConnection.revision, 2);

    clickAction(dom, "show-projects");
    dom.window.document.querySelector('[data-action="open-project"][data-project-id="project-customer-portal"]').click();
    customer = parsedSnapshot(dom);
    assert.equal(customer.codeConnection.revision, 2);
    assert.equal(customer.sourceBinding.revision, 1);
    assert.equal(customer.sourceBinding.verified, false);
    assert.equal(customer.sourceBinding.evidenceId, null);
    assert.equal(customer.attemptsByTaskId[31].length, 0);

    clickAction(dom, "continue-setup");
    customer = parsedSnapshot(dom);
    assert.equal(customer.codeConnection.revision, 2);
    assert.equal(customer.sourceBinding.revision, 2);
    assert.equal(customer.sourceBinding.verifiedConnectionRevision, "code-cnb-account@2");
    assert.equal(customer.sourceBinding.verified, true);
    assert.equal(dom.window.document.querySelector('[data-field="publishToken"]'), null);
    assert.match(sheetText(dom), /选择测试版运行的位置/);
  } finally {
    dom.window.close();
  }
});

test("P60 自动更新写操作遇到仓库读取失败时保持规则与部署事实不变", async () => {
  const seedDom = await loadPrototype();
  clickScenario(seedDom, "update");
  const fixture = parsedSnapshot(seedDom);
  seedDom.window.close();
  fixture.sourceBinding = null;
  fixture.sourceProbeOutcome = "denied";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    clickPage(dom, "settings");
    clickAction(dom, "manage-automation");
    const before = parsedSnapshot(dom);
    clickAction(dom, "pause-automation-rule");
    const blocked = parsedSnapshot(dom);

    assert.deepEqual(blocked.automationRule, before.automationRule);
    assert.deepEqual(blocked.tasksById, before.tasksById);
    assert.deepEqual(blocked.attemptsByTaskId, before.attemptsByTaskId);
    assert.equal(blocked.sourceBinding.verified, false);
    assert.equal(blocked.sourceBinding.verificationStatus, "denied");
    assert.match(sheetText(dom), /当前账号还不能读取这个项目.*系统没有创建任务/s);
    assert.equal(dom.window.document.querySelector('[data-field="connectionToken"]'), null);

    clickAction(dom, "change-source-account");
    assert.ok(dom.window.document.querySelector('[data-field="connectionToken"]'));
    fillField(dom, "connectionToken", "replacement-account-token");
    clickAction(dom, "save-code-connection");
    const resumed = parsedSnapshot(dom);
    assert.equal(resumed.automationRule.desiredState.status, "paused");
    assert.equal(resumed.automationRule.observedState.status, "paused");
    assert.equal(resumed.automationRule.syncState.status, "synced");
    assert.deepEqual(resumed.tasksById, before.tasksById);
    assert.deepEqual(resumed.attemptsByTaskId, before.attemptsByTaskId);
  } finally {
    dom.window.close();
  }
});

test("P61 接入已有部署会复用账号核对当前仓库，不重复索要代码平台 Token", async () => {
  const existingSeed = await loadPrototype();
  clickScenario(existingSeed, "existing");
  const fixture = parsedSnapshot(existingSeed);
  existingSeed.window.close();

  const connectedSeed = await loadPrototype();
  clickScenario(connectedSeed, "update");
  const connected = parsedSnapshot(connectedSeed);
  connectedSeed.window.close();
  fixture.codeConnectionStatus = connected.codeConnectionStatus;
  fixture.codeConnection = structuredClone(connected.codeConnection);
  fixture.codeConnectionsById = structuredClone(connected.codeConnectionsById);
  fixture.sourceBinding = null;
  fixture.sourceProbeOutcome = "passed";

  const dom = await loadPrototype(JSON.stringify(fixture));
  try {
    const before = parsedSnapshot(dom);
    clickAction(dom, "adopt-existing-deployment");
    const checked = parsedSnapshot(dom);

    assert.equal(checked.codeConnection.revision, before.codeConnection.revision);
    assert.equal(checked.sourceBinding.verified, true);
    assert.equal(checked.sourceBinding.verifiedConnectionRevision, "code-cnb-account@1");
    assert.match(checked.sourceBinding.evidenceId, /^source-proof-project-shop-demo-1$/);
    assert.deepEqual(checked.tasksById, before.tasksById);
    assert.deepEqual(checked.attemptsByTaskId, before.attemptsByTaskId);
    assert.match(sheetText(dom), /账号和仓库均可用/);
    assert.doesNotMatch(sheetText(dom), /代码平台授权/);
    assert.equal(dom.window.document.querySelector('label[for="existing-code-token"]'), null);
  } finally {
    dom.window.close();
  }
});
