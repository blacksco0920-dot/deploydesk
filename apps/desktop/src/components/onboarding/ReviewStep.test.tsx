import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePreview } from "../../types";
import { ReviewStep } from "./ReviewStep";

describe("ReviewStep deployment failures", () => {
  it("shows a stable error code and a concrete recovery path", () => {
    const onApply = vi.fn(async () => undefined);
    const onBackToConnections = vi.fn();
    render(
      <ReviewStep
        applying={false}
        issue={{
          code: "AD-SRV-202",
          title: "无法准备目标服务器",
          message: "检测到已有 Caddy，但它没有开放独立路由目录。",
          nextSteps: ["为 Caddy 挂载 /etc/caddy/sites 后重新检查"],
          technicalDetails: ["container=infra-caddy"],
          retryable: true,
        }}
        onApply={onApply}
        onBackToConnections={onBackToConnections}
        workspace={workspace()}
      />,
    );

    expect(screen.getByText("错误码 AD-SRV-202")).toBeInTheDocument();
    expect(
      screen.getByText("为 Caddy 挂载 /etc/caddy/sites 后重新检查"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("即将执行")).toHaveLength(3);
    expect(screen.getByText("保持不变")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回检查服务器" }));
    expect(onBackToConnections).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "重新检查并继续" }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});

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
      changes: [
        {
          path: "deploy.yaml",
          kind: "create",
          after: "version: 1\n",
          sensitive: false,
        },
      ],
      user_actions: [],
      warnings: [],
      generated_at: "2026-01-01T00:00:00Z",
    },
    manifestExists: false,
  };
}
