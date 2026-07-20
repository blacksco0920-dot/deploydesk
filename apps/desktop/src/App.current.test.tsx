import { describe, expect, it } from "vitest";
import {
  deploymentRefreshDelay,
  deploymentRepositoryReady,
  shouldApplyProjectResult,
  shouldRefreshDeploymentStatus,
  shouldReuseProjectWorkspace,
} from "./App";

describe("ABCDeploy 当前产品入口", () => {
  it("只在打开项目时刷新远程状态", () => {
    expect(shouldRefreshDeploymentStatus("project")).toBe(true);
    expect(shouldRefreshDeploymentStatus("home")).toBe(false);
    expect(shouldRefreshDeploymentStatus("configuration")).toBe(false);
  });

  it("闲置时降低轮询频率，运行中保持及时", () => {
    expect(deploymentRefreshDelay(true)).toBe(8_000);
    expect(deploymentRefreshDelay(false)).toBe(60_000);
  });

  it("不把其他项目的异步结果写到当前线路", () => {
    expect(shouldApplyProjectResult("/a", "/a")).toBe(true);
    expect(shouldApplyProjectResult("/b", "/a")).toBe(false);
    expect(shouldReuseProjectWorkspace("/a", "/a", true)).toBe(true);
    expect(shouldReuseProjectWorkspace("/a", "/b", true)).toBe(false);
  });

  it("只有明确代码仓库才把构建节点视为可核对", () => {
    expect(
      deploymentRepositoryReady(
        "providers:\n  build:\n    repository: team/app",
      ),
    ).toBe(true);
    expect(
      deploymentRepositoryReady(
        "providers:\n  build:\n    repository: owner/replace-me",
      ),
    ).toBe(false);
  });
});
