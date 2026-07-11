import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigFile, WorkspacePreview } from "../../types";
import { RequirementsStep } from "./RequirementsStep";

const { loadRuntimeConfig, storeRuntimeConfig } = vi.hoisted(() => ({
  loadRuntimeConfig: vi.fn(
    async (
      _path: string,
      environment: RuntimeConfigFile["environment"],
    ): Promise<RuntimeConfigFile> => {
      const content =
        environment === "staging"
          ? "# 保留项目注释\nUNKNOWN_SETTING=staging-value\n"
          : "# 生产配置\nUNKNOWN_SETTING=production-value\n";
      return {
        environment,
        filename: `.env.${environment}`,
        sourceFiles: ["apps/api/.env.example"],
        content,
        templateContent: content,
        stored: false,
      };
    },
  ),
  storeRuntimeConfig: vi.fn(
    async (_path: string, environment: RuntimeConfigFile["environment"]) => ({
      environment,
      filename: `.env.${environment}`,
      stored: true,
    }),
  ),
}));

vi.mock("../../api", () => ({ loadRuntimeConfig, storeRuntimeConfig }));

describe("RequirementsStep runtime configuration", () => {
  it("edits and stores the complete file without dropping unknown settings", async () => {
    const onReadinessChange = vi.fn();
    render(
      <RequirementsStep
        onError={vi.fn()}
        onReadinessChange={onReadinessChange}
        onUpdate={vi.fn(async () => true)}
        saving={false}
        workspace={workspace()}
      />,
    );

    expect(screen.getByText("这个文件有什么用")).toBeInTheDocument();
    expect(screen.getByText("什么时候需要修改")).toBeInTheDocument();

    const stagingEditor = await screen.findByRole("textbox", {
      name: "测试环境运行配置文件",
    });
    expect(stagingEditor).toHaveValue(
      "# 保留项目注释\nUNKNOWN_SETTING=staging-value\n",
    );

    const completeFile = [
      "# 保留项目注释",
      "UNKNOWN_SETTING=staging-value",
      "UNRECOGNIZED_DETAIL=a=b#c",
      "",
    ].join("\n");
    fireEvent.change(stagingEditor, { target: { value: completeFile } });
    fireEvent.click(screen.getByRole("button", { name: "保存测试配置" }));

    await waitFor(() =>
      expect(storeRuntimeConfig).toHaveBeenCalledWith(
        "/demo/sample",
        "staging",
        completeFile,
      ),
    );
    expect(screen.getByText("已保存到系统密钥库")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "生产环境" }));
    expect(
      screen.getByRole("textbox", { name: "生产环境运行配置文件" }),
    ).toHaveValue("# 生产配置\nUNKNOWN_SETTING=production-value\n");
    fireEvent.click(screen.getByRole("button", { name: "保存生产配置" }));
    await waitFor(() =>
      expect(onReadinessChange).toHaveBeenLastCalledWith(true),
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
      environment_files: ["apps/api/.env.example"],
      environment_variables: [
        {
          name: "UNKNOWN_SETTING",
          secret: false,
          source: "apps/api/.env.example",
        },
      ],
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
