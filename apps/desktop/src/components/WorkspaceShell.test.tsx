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

  it("shows the immutable candidate before production promotion", () => {
    const onPromote = vi.fn();
    render(
      renderShellElement([successfulRun("candidate-1")], vi.fn(), onPromote),
    );

    fireEvent.click(screen.getByRole("button", { name: "发布生产" }));
    expect(
      screen.getByRole("heading", { name: "发布到正式环境？" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/deploydesk-0123456789/)).toBeInTheDocument();
    expect(onPromote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认发布正式" }));
    expect(onPromote).toHaveBeenCalledWith(successfulRun("candidate-1"));
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
  onPromote = vi.fn(),
) {
  return (
    <WorkspaceShell
      onDeploy={vi.fn()}
      onForget={vi.fn()}
      onPromote={onPromote}
      onRefresh={vi.fn()}
      onRollback={onRollback}
      path="/demo/sample"
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
    candidateTag: "deploydesk-0123456789abcdef0123456789abcdef01234567",
    artifacts: [
      {
        service: "api",
        image: "registry.example.com/sample/api",
        digest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ],
    actionKind: null,
    actionUrl: null,
    issueCode: null,
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
      environment_files: [],
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
