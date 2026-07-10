import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentRun, WorkspacePreview } from "../types";
import { WorkspaceShell } from "./WorkspaceShell";

describe("WorkspaceShell rollback guard", () => {
  it("requires two healthy releases and an explicit confirmation", () => {
    const onRollback = vi.fn();
    const { rerender } = renderShell([successfulRun("run-1")], onRollback);

    expect(
      screen.queryByRole("button", { name: "回滚" }),
    ).not.toBeInTheDocument();

    rerender(
      renderShellElement(
        [successfulRun("run-1"), successfulRun("run-2")],
        onRollback,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "回滚" }));

    expect(
      screen.getByRole("heading", { name: "回滚测试环境？" }),
    ).toBeInTheDocument();
    expect(onRollback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认回滚测试" }));
    expect(onRollback).toHaveBeenCalledWith("staging");
  });
});

function renderShell(
  runs: DeploymentRun[],
  onRollback: (environment: DeploymentRun["environment"]) => void,
) {
  return render(renderShellElement(runs, onRollback));
}

function renderShellElement(
  runs: DeploymentRun[],
  onRollback: (environment: DeploymentRun["environment"]) => void,
) {
  return (
    <WorkspaceShell
      onDeploy={vi.fn()}
      onForget={vi.fn()}
      onHome={vi.fn()}
      onPromote={vi.fn()}
      onRefresh={vi.fn()}
      onRollback={onRollback}
      path="/demo/sample"
      preflight={null}
      runs={runs}
      workspace={workspace()}
    />
  );
}

function successfulRun(id: string): DeploymentRun {
  return {
    id,
    projectPath: "/demo/sample",
    projectName: "sample",
    environment: "staging",
    status: "success",
    currentStage: "complete",
    buildSerial: id,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    sourceRunId: null,
    actionKind: null,
    actionUrl: null,
    repository: "demo/sample",
    branch: "main",
    message: "测试环境运行正常",
    completedSteps: ["healthcheck"],
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function workspace(): WorkspacePreview {
  return {
    inspection: {
      project_root: "/demo/sample",
      project_name: "sample",
      package_manager: "pnpm",
      monorepo: false,
      frameworks: [],
      services: [],
      prisma_schemas: [],
      dockerfiles: [],
      environment_variables: [],
      diagnostics: [],
    },
    manifestYaml: "version: 1\n",
    validation: { valid: true, issues: [] },
    plan: {
      id: "plan",
      project: "sample",
      environments: [],
      steps: [],
      changes: [],
      user_actions: [],
      warnings: [],
      generated_at: "2026-01-01T00:00:00Z",
    },
    manifestExists: true,
  };
}
