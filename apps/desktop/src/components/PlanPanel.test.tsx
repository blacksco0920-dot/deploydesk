import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openProject } from "../api";
import { PlanPanel } from "./PlanPanel";

describe("PlanPanel", () => {
  it("requires an explicit file-change confirmation before applying", async () => {
    const workspace = await openProject("/fixture/ecat-energy");
    const onApply = vi.fn(async () => undefined);
    render(
      <PlanPanel
        applyResult={null}
        applying={false}
        onApply={onApply}
        workspace={workspace}
      />,
    );

    const apply = screen.getByRole("button", { name: "应用部署配置" });
    expect(apply).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /我已查看文件变化，允许写入项目/,
      }),
    );
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  });
});
