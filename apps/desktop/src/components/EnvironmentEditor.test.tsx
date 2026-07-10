import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { openProject } from "../api";
import { EnvironmentEditor } from "./EnvironmentEditor";

describe("EnvironmentEditor", () => {
  it("keeps branches independent and writes the selected production policy", async () => {
    const workspace = await openProject("/fixture/ecat-energy");
    const onSave = vi.fn(async (_manifestYaml: string) => undefined);
    render(
      <EnvironmentEditor
        onSave={onSave}
        saving={false}
        workspace={workspace}
      />,
    );

    fireEvent.change(screen.getByLabelText("触发分支"), {
      target: { value: "integration" },
    });
    fireEvent.change(screen.getByLabelText("稳定分支"), {
      target: { value: "release" },
    });
    const secretReferences = screen.getAllByLabelText("CNB 密钥文件");
    fireEvent.change(secretReferences[0], {
      target: {
        value:
          "https://cnb.cool/example/secrets/-/blob/main/env.staging.yml",
      },
    });
    fireEvent.change(secretReferences[1], {
      target: {
        value:
          "https://cnb.cool/example/secrets/-/blob/main/env.production.yml",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "自动发布" }));
    fireEvent.click(screen.getByRole("button", { name: "更新部署计划" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const savedManifest = onSave.mock.calls[0]?.[0];
    expect(savedManifest).toBeTypeOf("string");
    const manifest = parse(savedManifest!);
    expect(manifest.source.integration_branch).toBe("integration");
    expect(manifest.source.stable_branch).toBe("release");
    expect(manifest.environments.staging.branch).toBe("integration");
    expect(manifest.environments.production.branch).toBe("release");
    expect(manifest.environments.staging.secrets_ref).toContain(
      "env.staging.yml",
    );
    expect(manifest.environments.production.secrets_ref).toContain(
      "env.production.yml",
    );
    expect(manifest.release.production_mode).toBe("automatic");
    expect(manifest.environments.production.approval_required).toBe(false);
  });
});
