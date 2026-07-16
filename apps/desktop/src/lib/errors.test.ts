import { describe, expect, it } from "vitest";
import { issueFromProvider, issueFromUnknown } from "./errors";

describe("user-facing deployment errors", () => {
  it("translates provider checks while keeping their technical evidence", () => {
    const issue = issueFromProvider({
      provider: "caddy",
      ok: false,
      summary: "已有 Caddy 尚未开放路由目录",
      details: ["container=infra-caddy"],
      code: "AD-SRV-202",
      nextSteps: ["挂载 /etc/caddy/sites 后重试"],
      retryable: true,
    });

    expect(issue.code).toBe("AD-SRV-202");
    expect(issue.title).toBe("服务器访问服务需要调整");
    expect(issue.message).not.toContain("Caddy");
    expect(issue.nextSteps).toEqual([
      "让系统为现有访问服务准备独立项目路由，然后重新检查",
    ]);
    expect(issue.nextSteps[0]).not.toContain("/etc/caddy");
    expect(issue.technicalDetails).toEqual([
      "已有 Caddy 尚未开放路由目录",
      "container=infra-caddy",
    ]);
  });

  it("keeps server identity and version storage jargon out of provider summaries", () => {
    const identity = issueFromProvider({
      provider: "ssh",
      ok: false,
      summary: "SSH 私钥文件不存在",
      details: ["/Users/demo/.ssh/id_ed25519"],
      code: "AD-SSH-101",
      nextSteps: ["重新选择 SSH 私钥"],
      retryable: true,
    });
    expect(identity.title).toBe("服务器安全身份不可用");
    expect(identity.message).not.toContain("SSH");
    expect(identity.technicalDetails[0]).toContain("SSH 私钥");

    const registry = issueFromProvider({
      provider: "tcr",
      ok: false,
      summary: "镜像仓库配置不完整",
      details: ["registry=missing"],
      code: "AD-REG-101",
      nextSteps: ["补全仓库地址和命名空间"],
      retryable: true,
    });
    expect(registry.title).toBe("项目版本保存位置还没有配置完整");
    expect(registry.message).not.toContain("镜像仓库");
    expect(registry.nextSteps[0]).toContain("项目版本保存位置");
  });

  it("recognizes coded failures returned by deployment scripts", () => {
    const issue = issueFromUnknown("AD-SRV-206：新路由与现有配置冲突");
    expect(issue.code).toBe("AD-SRV-206");
    expect(issue.message).toBe(
      "服务器上已有访问规则使用相同地址，当前版本尚未切换。",
    );
    expect(issue.technicalDetails).toEqual(["新路由与现有配置冲突"]);
  });

  it("turns release verification failures into one concrete next step", () => {
    const issue = issueFromUnknown("AD-REL-201: 尚未读取到测试环境的镜像摘要");
    expect(issue.code).toBe("AD-REL-201");
    expect(issue.nextSteps).toEqual([
      "重新验证目标服务器连接；返回部署页面后系统会自动核对版本",
    ]);
    expect(issue.message).not.toContain("镜像摘要");
    expect(issue.technicalDetails[0]).toContain("镜像摘要");

    const address = issueFromUnknown(
      "AD-NET-201: 正式地址的 DNS 或 HTTPS 尚未就绪",
    );
    expect(address.title).toBe("访问地址还没有准备好");
    expect(address.nextSteps[0]).toContain("回到客户端后系统会自动检查");
    expect(address.nextSteps[0]).toContain("无需重新构建");
  });

  it("turns a missing Caddy route into a route-only recovery step", () => {
    const issue = issueFromUnknown(
      "AD-SRV-209：统一 Caddy 尚未加载 example.com",
    );
    expect(issue.title).toBe("正式地址没有加载成功");
    expect(issue.nextSteps).toEqual([
      "点击“重新应用地址”；系统只修复访问入口，不会重新生成项目版本",
    ]);
  });

  it("turns a missing CNB organization into a novice-friendly recovery step", () => {
    const issue = issueFromUnknown(
      "AD-CNB-104：CNB 中找不到所选组织或仓库，请重新选择组织",
    );
    expect(issue.code).toBe("AD-CNB-104");
    expect(issue.message).not.toContain("Resource not found");
    expect(issue.nextSteps[0]).toContain("创建组织");
  });

  it("explains how to recover from an existing inaccessible repository", () => {
    const issue = issueFromUnknown(
      "AD-CNB-106：CNB 已存在同名资源，但当前账号无法正常读取",
    );
    expect(issue.nextSteps[0]).toContain("同名仓库权限");
  });

  it("turns uncommitted project files into a clear deployment choice", () => {
    const issue = issueFromUnknown(
      "AD-GIT-101：发现尚未提交的项目文件：src/app.ts。为避免部署旧代码，已暂停同步",
    );
    expect(issue.title).toBe("项目改动还没有提交");
    expect(issue.message).not.toContain("src/app.ts");
    expect(issue.technicalDetails[0]).toContain("src/app.ts");
    expect(issue.nextSteps[0]).toContain("部署已提交版本");
  });

  it("separates clipboard and browser failures", () => {
    const clipboard = issueFromUnknown("AD-SYS-101：无法写入系统剪贴板");
    const browser = issueFromUnknown(
      "AD-SYS-102：配置已经复制但浏览器没有打开",
    );

    expect(clipboard.title).toBe("配置没有复制成功");
    expect(browser.title).toBe("系统浏览器没有打开");
    expect(browser.nextSteps[0]).toContain("手动打开");
  });

  it("explains a diverged CNB branch without recommending force push", () => {
    const issue = issueFromUnknown(
      "AD-GIT-102：CNB 部署分支已有更新，当前代码不能安全覆盖",
    );

    expect(issue.title).toBe("部署分支需要先同步");
    expect(issue.message).not.toContain("CNB");
    expect(issue.technicalDetails[0]).toContain("CNB");
    expect(issue.nextSteps[0]).toContain("安全同步");
    expect(issue.nextSteps[0]).toContain("不要强制覆盖");
  });

  it("explains when a selected folder is only part of a larger code project", () => {
    const issue = issueFromUnknown(
      "AD-GIT-103：当前目录属于另一个代码项目，请选择最外层的项目目录",
    );

    expect(issue.title).toBe("请选择完整的项目文件夹");
    expect(issue.nextSteps[0]).toContain("最外层文件夹");
    expect(issue.nextSteps[0]).not.toContain("Git");
  });

  it("names the missing CNB permission without exposing its code", () => {
    const issue = issueFromUnknown(
      "AD-CNB-103：CNB 授权缺少“构建记录读取”权限（repo-cnb-history:r）",
    );

    expect(issue.title).toBe("CNB 权限还差一步");
    expect(issue.message).not.toContain("repo-cnb-history:r");
    expect(issue.technicalDetails[0]).toContain("repo-cnb-history:r");
    expect(issue.nextSteps[0]).toContain("读取构建记录");
    expect(issue.nextSteps[0]).not.toContain("repo-cnb-history:r");
  });

  it("keeps multiline provider responses behind technical details", () => {
    const issue = issueFromUnknown(
      'AD-CNB-103：CNB 授权缺少“触发构建”权限（repo-cnb-trigger:rw）\n原始信息：\n{"errcode":10023,"errmsg":"Missing required scopes: repo-cnb-trigger:rw"}',
    );

    expect(issue.title).toBe("CNB 权限还差一步");
    expect(issue.message).toBe(
      "代码平台授权还不完整，已经完成的部署步骤仍然保留。",
    );
    expect(issue.message).not.toContain("errcode");
    expect(issue.nextSteps[0]).toContain("触发自动构建");
    expect(issue.nextSteps[0]).not.toContain("repo-cnb-trigger:rw");
    expect(issue.technicalDetails[0]).toContain("errcode");
    expect(issue.technicalDetails[0]).toContain("repo-cnb-trigger:rw");
  });

  it("turns an unhealthy container into a concrete recovery step", () => {
    const issue = issueFromUnknown(
      "AD-CTR-201：服务容器 finagent-staging-h5-1 启动后未通过健康检查",
    );

    expect(issue.title).toBe("服务没有正常启动");
    expect(issue.message).not.toContain("finagent-staging-h5-1");
    expect(issue.technicalDetails[0]).toContain("finagent-staging-h5-1");
    expect(issue.nextSteps[0]).toContain("服务启动日志");
  });

  it("keeps missing runtime configuration wording valid for every environment", () => {
    const issue = issueFromUnknown("AD-CFG-201：正式环境缺少 DATABASE_URL");

    expect(issue.title).toBe("运行配置还缺内容");
    expect(issue.title).not.toContain("测试环境");
    expect(issue.nextSteps[0]).toContain("当前环境");
  });

  it("gives build, database and server-route failures one concrete action", () => {
    const build = issueFromUnknown("AD-BLD-201：构建失败");
    expect(build.title).toBe("项目版本没有生成成功");
    expect(build.nextSteps[0]).toContain("构建原因");

    const lockfile = issueFromUnknown("AD-PKG-201：项目缺少依赖锁定文件");
    expect(lockfile.title).toBe("项目依赖版本还没有锁定");
    expect(lockfile.nextSteps[0]).toContain("自动补齐");

    const database = issueFromUnknown("AD-DB-201：数据库认证失败");
    expect(database.title).toBe("数据库账号或密码不正确");
    expect(database.nextSteps[0]).toContain("重新保存配置");

    const route = issueFromUnknown("AD-SRV-206：地址由旧版本使用");
    expect(route.title).toBe("访问地址正在被旧版本使用");
    expect(route.nextSteps[0]).toContain("自动恢复");
  });

  it("separates version login validation from server version download errors", () => {
    const rejected = issueFromUnknown(
      "AD-REG-102：镜像仓库没有接受这组登录信息",
    );
    expect(rejected.title).toBe("登录信息没有通过验证");
    expect(rejected.message).toBe("项目版本保存位置没有接受这组登录信息。");
    expect(rejected.nextSteps[0]).toContain("登录用户名和访问密码");
    expect(rejected.message).not.toContain("镜像仓库");
    expect(rejected.technicalDetails[0]).toContain("镜像仓库");

    const unavailable = issueFromUnknown(
      "AD-REG-103：本机暂时无法验证镜像仓库",
    );
    expect(unavailable.title).toBe("这次没有完成登录验证");
    expect(unavailable.nextSteps[0]).toContain("Docker Desktop");
  });

  it("turns local container failures into one novice-facing action", () => {
    const missingEnv = issueFromUnknown(
      "AD-LOC-104：项目还没有 .env",
      "本地预览没有启动",
    );
    expect(missingEnv.title).toBe("本机配置还没有保存");
    expect(missingEnv.message).not.toContain(".env");
    expect(missingEnv.technicalDetails[0]).toContain(".env");
    expect(missingEnv.nextSteps).toEqual(["补齐必要配置并点击“保存本机配置”"]);

    const missingRuntime = issueFromUnknown(
      "AD-CTR-101：api 还没有可靠的容器构建方式，需要 Dockerfile",
    );
    expect(missingRuntime.title).toBe("项目运行方式还需开发处理");
    expect(missingRuntime.message).not.toMatch(/容器|Dockerfile/);
    expect(missingRuntime.technicalDetails[0]).toMatch(/容器|Dockerfile/);
    expect(missingRuntime.nextSteps[0]).toContain("交给开发工具");

    const build = issueFromUnknown("AD-LOC-112：项目代码没有通过容器构建");
    expect(build.title).toBe("项目没有成功生成本机运行版本");
    expect(build.message).not.toContain("容器");
    expect(build.technicalDetails[0]).toContain("容器构建");
    expect(build.nextSteps[0]).toContain("复制给开发工具");

    const port = issueFromUnknown(
      "启动用户网站未完成：AD-LOC-116：本机端口 3000 已被其他程序占用",
    );
    expect(port.title).toBe("本机端口已被占用");
    expect(port.message).toBe("本机端口 3000 已被其他程序占用");
    expect(port.nextSteps[0]).toContain("关闭占用提示端口的其他程序");

    const timeout = issueFromUnknown(
      "AD-LOC-117：Docker 下载或构建长时间没有进展，已自动停止",
    );
    expect(timeout.title).toBe("运行组件下载长时间没有进展");
    expect(timeout.message).not.toContain("Docker");
    expect(timeout.technicalDetails[0]).toContain("Docker");
    expect(timeout.nextSteps[0]).toContain("无需修改项目代码");

    const cancelled = issueFromUnknown("AD-LOC-118：本次启动已停止");
    expect(cancelled.title).toBe("本次启动已停止");
    expect(cancelled.nextSteps[0]).toContain("重新启动");

    const managedPort = issueFromUnknown(
      "AD-LOC-120：项目 finagent 正在使用本项目需要的 3000 端口",
    );
    expect(managedPort.title).toBe("另一个项目占用了本机端口");
    expect(managedPort.nextSteps[0]).toContain("自动继续");
  });

  it("explains the one-time server password bootstrap without exposing SSH jargon", () => {
    const issue = issueFromUnknown("AD-SSH-105：服务器还不认识这台电脑");
    expect(issue.title).toBe("服务器尚未接受安全身份");
    expect(issue.nextSteps[0]).toContain("登录用户和密码");
  });

  it("turns local infrastructure failures into a clear recovery action", () => {
    const issue = issueFromUnknown("AD-INF-103：无法为本机数据库找到可用端口");

    expect(issue.title).toBe("本机端口已被占用");
    expect(issue.nextSteps[0]).toContain("重新点击自动准备");
  });

  it("keeps version-storage verification failures inside the credential step", () => {
    const issue = issueFromUnknown("AD-IMG-202：连接镜像仓库超时");

    expect(issue.title).toBe("暂时无法验证项目版本保存位置");
    expect(issue.message).not.toContain("镜像仓库");
    expect(issue.technicalDetails[0]).toContain("镜像仓库");
    expect(issue.nextSteps[0]).toContain("Docker Desktop");
    expect(issue.nextSteps[0]).toContain("重新验证项目版本保存位置");
  });
});
