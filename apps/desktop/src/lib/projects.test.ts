import { describe, expect, it } from "vitest";
import type { DeploymentRun, RecentProject } from "../types";
import {
  deploymentNeedsActionStatus,
  deploymentVersionKey,
  deploymentVersionVerified,
  projectVerificationTask,
  primaryVersionTitle,
  recentProjectStatus,
  verifiedRunIdsFromSetting,
  verifiedVersionKeysFromSetting,
} from "./projects";

describe("project guidance", () => {
  it("only promotes user-facing names and explicit version numbers", () => {
    expect(primaryVersionTitle("修复登录问题")).toBe("修复登录问题");
    expect(primaryVersionTitle("v1.2.3")).toBe("v1.2.3");
    expect(primaryVersionTitle("initialize project for abcdeploy")).toBe("");
    expect(primaryVersionTitle("完成首次上线配置")).toBe("");
    expect(primaryVersionTitle("harden ABCDeploy staging recovery")).toBe("");
    expect(primaryVersionTitle("api custom event")).toBe("");
  });

  it("restores both current and legacy test confirmations", () => {
    expect(verifiedRunIdsFromSetting('["run-2","run-1"]')).toEqual([
      "run-2",
      "run-1",
    ]);
    expect(verifiedRunIdsFromSetting('"legacy-json-run"')).toEqual([
      "legacy-json-run",
    ]);
    expect(verifiedRunIdsFromSetting("legacy-run")).toEqual(["legacy-run"]);
    expect(verifiedRunIdsFromSetting(null)).toEqual([]);
    expect(
      verifiedVersionKeysFromSetting('["images:api","commit:legacy"]'),
    ).toEqual(["images:api", "commit:legacy"]);
  });

  it("asks for business confirmation only for the latest successful test run", () => {
    const project: RecentProject = {
      id: "demo",
      path: "/projects/demo",
      name: "demo",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-15T00:00:00Z",
      pathExists: true,
      latestStatus: "success",
      latestEnvironment: "staging",
      latestMessage: "测试地址可以访问",
      latestRunId: "current-test-run",
      activeRunCount: 0,
    };

    expect(projectVerificationTask(project, null)).toEqual({
      projectPath: project.path,
      runId: "current-test-run",
    });
    expect(projectVerificationTask(project, '["older-test-run"]')).toEqual({
      projectPath: project.path,
      runId: "current-test-run",
    });
    expect(projectVerificationTask(project, '["current-test-run"]')).toBeNull();
    expect(
      projectVerificationTask(
        { ...project, latestEnvironment: "production" },
        null,
      ),
    ).toBeNull();
    expect(
      projectVerificationTask({ ...project, latestStatus: "running" }, null),
    ).toBeNull();
  });

  it("carries a test confirmation across repeat deployments of the same version", () => {
    const older = deploymentRun({
      id: "older-attempt",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    const current = deploymentRun({
      id: "current-attempt",
      commitSha: older.commitSha,
      candidateTag: older.candidateTag,
    });
    const different = deploymentRun({
      id: "different-version",
      commitSha: "1123456789abcdef1123456789abcdef11234567",
      candidateTag: "deploydesk-1123456789abcdef1123456789abcdef11234567",
    });

    expect(
      deploymentVersionVerified(current.id, [current, older], [older.id]),
    ).toBe(true);
    expect(
      deploymentVersionVerified(different.id, [different, older], [older.id]),
    ).toBe(false);
  });

  it("requires new confirmation when one commit produces different images", () => {
    const verified = deploymentRun({
      id: "verified-build",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    });
    verified.artifacts = [artifact("api", "1"), artifact("web", "2")];
    const sameImages = {
      ...verified,
      id: "same-images",
      artifacts: [artifact("web", "2"), artifact("api", "1")],
    };
    const rebuilt = {
      ...verified,
      id: "rebuilt-images",
      artifacts: [artifact("api", "3"), artifact("web", "2")],
    };

    expect(
      deploymentVersionVerified(
        sameImages.id,
        [sameImages, verified],
        [verified.id],
      ),
    ).toBe(true);
    expect(
      deploymentVersionVerified(rebuilt.id, [rebuilt, verified], [verified.id]),
    ).toBe(false);
    expect(
      deploymentVersionVerified(
        sameImages.id,
        [sameImages],
        [],
        [deploymentVersionKey(verified)],
      ),
    ).toBe(true);
  });

  it("keeps project fallback states specific when detailed tasks are still loading", () => {
    const project: RecentProject = {
      id: "demo",
      path: "/projects/demo",
      name: "demo",
      currentStep: "workspace",
      manifestExists: true,
      serviceCount: 2,
      lastOpenedAt: "2026-07-15T00:00:00Z",
      pathExists: true,
      latestStatus: null,
      latestEnvironment: null,
      latestMessage: null,
      activeRunCount: 0,
    };

    expect(recentProjectStatus(project)).toBe("尚未开始上线");
    expect(
      recentProjectStatus({
        ...project,
        latestStatus: "needs_action",
        latestEnvironment: "production",
        latestActionKind: "route-check",
      }),
    ).toBe("正式版已部署，还差地址");
    expect(
      recentProjectStatus({
        ...project,
        latestStatus: "failed",
        latestEnvironment: "staging",
      }),
    ).toBe("测试部署没有完成");
    const verifiedStagingProject = {
      ...project,
      latestStatus: "success" as const,
      latestEnvironment: "staging" as const,
      latestRunId: "verified-staging",
    };
    expect(
      recentProjectStatus(
        verifiedStagingProject,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).toBe("测试已通过，可发布");
    expect(
      recentProjectStatus(
        verifiedStagingProject,
        undefined,
        undefined,
        { projectPath: project.path, runId: "verified-staging" },
        true,
      ),
    ).toBe("等待确认测试结果");
  });

  it("does not confuse deployment verification with business confirmation", () => {
    expect(deploymentNeedsActionStatus("staging", "verify-release")).toBe(
      "部署结果还需要核对",
    );
    expect(deploymentNeedsActionStatus("staging", "cnb-builds")).toBe(
      "还差代码平台授权",
    );
    expect(deploymentNeedsActionStatus("staging", "cloud-config")).toBe(
      "测试配置还需要准备",
    );
    expect(deploymentNeedsActionStatus("production", "artifact-mismatch")).toBe(
      "正式版本核对没有通过",
    );
    expect(deploymentNeedsActionStatus("production", "redeploy-test")).toBe(
      "项目更新，需要重新测试",
    );
  });
});

function artifact(service: string, digestMarker: string) {
  return {
    service,
    image: `registry/demo/${service}`,
    digest: `sha256:${digestMarker.repeat(64)}`,
  };
}

function deploymentRun(
  overrides: Pick<DeploymentRun, "id" | "commitSha" | "candidateTag">,
): DeploymentRun {
  return {
    ...overrides,
    projectPath: "/projects/demo",
    projectName: "demo",
    environment: "staging",
    status: "success",
    currentStage: "complete",
    buildSerial: null,
    sourceRunId: null,
    artifacts: [],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
    repository: "demo/project",
    branch: "main",
    message: "测试环境运行正常",
    completedSteps: ["healthcheck"],
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:10:00.000Z",
  };
}
