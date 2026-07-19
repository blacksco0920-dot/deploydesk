import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "../types";
import {
  legacySetupStepBlocker,
  recoveryTaskCopy,
  setupTaskCopy,
} from "./release-task-copy";

describe("release task copy", () => {
  it("names the exact missing resource during first setup", () => {
    expect(setupTaskCopy("source-connection").action).toBe("连接代码平台");
    expect(setupTaskCopy("registry-connection")).toMatchObject({
      title: "连接版本保存位置",
      action: "连接版本存储",
    });
    expect(setupTaskCopy("test-config").action).toBe("补全测试配置");
    expect(setupTaskCopy("automation").action).toBe("开启自动部署");
    expect(legacySetupStepBlocker("registry")).toBe("registry-connection");
    expect(legacySetupStepBlocker("test-environment")).toBe("test-server");
    expect(legacySetupStepBlocker("complete")).toBeNull();
  });

  it("maps provider failures to one specific recovery action", () => {
    expect(recoveryTaskCopy(run({ issueCode: "AD-CNB-103" })).action).toBe(
      "更新代码平台授权",
    );
    expect(recoveryTaskCopy(run({ issueCode: "AD-REG-101" })).action).toBe(
      "更新版本存储授权",
    );
    expect(recoveryTaskCopy(run({ issueCode: "AD-SSH-101" })).action).toBe(
      "更换服务器连接",
    );
    expect(
      recoveryTaskCopy(
        run({ environment: "production", issueCode: "AD-CFG-201" }),
      ).action,
    ).toBe("补全正式配置");
    expect(recoveryTaskCopy(run({ issueCode: "AD-NET-201" })).action).toBe(
      "检查并继续",
    );
    expect(
      recoveryTaskCopy(
        run({
          environment: "production",
          currentStage: "verify-release",
          actionKind: "verify-existing-deployment",
          issueCode: "AD-REL-201",
        }),
      ),
    ).toMatchObject({
      title: "已有部署等待核对",
      action: "连接服务器并核对",
    });
    expect(
      recoveryTaskCopy(
        run({
          actionKind: "route-takeover",
          environment: "production",
          issueCode: "AD-SRV-206",
        }),
      ),
    ).toMatchObject({
      title: "正式地址等待确认",
      action: "确认地址接管",
    });
  });

  it("keeps an honest fallback for unknown failures", () => {
    expect(
      recoveryTaskCopy(run({ issueCode: "AD-UNKNOWN-999" })),
    ).toMatchObject({
      title: "测试部署还需要处理",
      action: "继续处理",
    });
    expect(recoveryTaskCopy(undefined, "production")).toMatchObject({
      title: "正式发布还需要处理",
      action: "继续完成发布",
    });
  });
});

function run(overrides: Partial<DeploymentRun> = {}): DeploymentRun {
  return {
    id: "task-1",
    projectPath: "/demo/project",
    projectName: "project",
    environment: "staging",
    status: "needs_action",
    currentStage: "trigger-build",
    buildSerial: null,
    commitSha: null,
    sourceRunId: null,
    candidateTag: null,
    artifacts: [],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: "demo/project",
    branch: "main",
    message: "任务暂停",
    completedSteps: [],
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    ...overrides,
  };
}
