import { describe, expect, it } from "vitest";
import { issueFromProvider, issueFromUnknown } from "./errors";

describe("user-facing deployment errors", () => {
  it("keeps provider error codes and recovery steps", () => {
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
    expect(issue.nextSteps).toEqual(["挂载 /etc/caddy/sites 后重试"]);
    expect(issue.technicalDetails).toEqual(["container=infra-caddy"]);
  });

  it("recognizes coded failures returned by deployment scripts", () => {
    const issue = issueFromUnknown("AD-SRV-206：新路由与现有配置冲突");
    expect(issue.code).toBe("AD-SRV-206");
    expect(issue.message).toBe("新路由与现有配置冲突");
  });

  it("turns release verification failures into one concrete next step", () => {
    const issue = issueFromUnknown("AD-REL-201: 尚未读取到测试环境的镜像摘要");
    expect(issue.code).toBe("AD-REL-201");
    expect(issue.nextSteps).toEqual([
      "重新验证目标服务器连接，然后刷新部署状态",
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
});
