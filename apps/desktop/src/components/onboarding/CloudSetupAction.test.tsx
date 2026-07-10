import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePreview } from "../../types";
import { CloudSetupAction } from "./CloudSetupAction";

const writeText = vi.fn(async () => undefined);
const { ensureCnbRepository, prepareCnbSecretBundle } = vi.hoisted(() => ({
  ensureCnbRepository: vi.fn(async () => ({
    repository: "demo/sample",
    created: true,
  })),
  prepareCnbSecretBundle: vi.fn(
    async (_path: string, environment: "staging" | "production") => ({
      environment,
      filename: `env.${environment}.yml`,
      fileUrl: `https://cnb.cool/demo/sample-secrets/-/blob/main/env.${environment}.yml`,
      content: "PRIVATE_DEPLOY_KEY: test-only-sensitive-value",
      missingVariables: [],
      deployKeyFingerprint: "SHA256:test-deploy-key",
    }),
  ),
}));

vi.mock("../../api", () => ({
  ensureCnbRepository,
  getCnbAccount: vi.fn(async () => ({
    connected: true,
    displayName: "Demo",
    username: "demo",
  })),
  prepareCnbSecretBundle,
}));

describe("CloudSetupAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("guides the one-time audited CNB setup without rendering secret content", async () => {
    const onComplete = vi.fn(async () => undefined);
    render(
      <CloudSetupAction
        completing={false}
        onBackToRequirements={vi.fn()}
        onComplete={onComplete}
        onError={vi.fn()}
        path="/demo/sample"
        server={{
          name: "server",
          host: "203.0.113.10",
          user: "ubuntu",
          port: 22,
          keyPath: "/demo/id_ed25519",
          hostFingerprint: "SHA256:server",
        }}
        workspace={workspace()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByDisplayValue("demo/sample-deploy-secrets"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "自动准备" }));
    await waitFor(() => expect(screen.getByText("已准备")).toBeInTheDocument());

    const copyButtons = screen.getAllByRole("button", { name: "复制安全配置" });
    fireEvent.click(copyButtons[0]);
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("PRIVATE_DEPLOY_KEY: test-only-sensitive-value"),
    ).not.toBeInTheDocument();

    const confirmations = screen.getAllByRole("checkbox");
    fireEvent.click(confirmations[0]);
    fireEvent.click(confirmations[1]);
    fireEvent.click(screen.getByRole("button", { name: "完成并继续部署" }));

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        "demo/sample",
        "demo/sample-deploy-secrets",
      ),
    );
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
