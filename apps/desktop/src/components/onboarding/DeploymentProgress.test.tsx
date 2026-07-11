import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentRun } from "../../types";
import { DeploymentProgress } from "./DeploymentProgress";

describe("DeploymentProgress recovery", () => {
  it("lets users return to the workspace after a failed build", () => {
    const onWorkspace = vi.fn();
    render(
      <DeploymentProgress
        onRefresh={vi.fn()}
        onRetry={vi.fn()}
        onWorkspace={onWorkspace}
        run={failedRun()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回项目工作台" }));
    expect(onWorkspace).toHaveBeenCalledOnce();
  });
});

function failedRun(): DeploymentRun {
  return {
    id: "run-1",
    projectPath: "/demo/finagent",
    projectName: "finagent",
    environment: "staging",
    repository: "team/finagent",
    branch: "main",
    status: "failed",
    currentStage: "build",
    completedSteps: ["write-config"],
    buildSerial: "cnb-1",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    sourceRunId: null,
    candidateTag: null,
    artifacts: [],
    issueCode: "AD-BLD-201",
    actionKind: null,
    actionUrl: null,
    message: "验证 1 未完成",
    startedAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:01:00Z",
  };
}
