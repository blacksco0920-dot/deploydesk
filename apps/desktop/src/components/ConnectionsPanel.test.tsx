import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "./ConnectionsPanel";

describe("ConnectionsPanel", () => {
  it("requires SSH verification and explicit confirmation before Caddy bootstrap", async () => {
    const onError = vi.fn();
    const { container } = render(
      <ConnectionsPanel
        onError={onError}
        onRepositorySelected={vi.fn(async () => undefined)}
      />,
    );
    const forms = container.querySelectorAll<HTMLElement>(".server-form");
    expect(forms).toHaveLength(2);
    const staging = within(forms[0]);

    fireEvent.change(staging.getByLabelText("地址"), {
      target: { value: "staging.example.com" },
    });
    fireEvent.change(staging.getByLabelText("SSH 私钥"), {
      target: { value: "/tmp/deploydesk-test-key" },
    });
    fireEvent.click(staging.getByRole("button", { name: "验证 SSH" }));

    await waitFor(() =>
      expect(staging.getByText("服务器连接正常")).toBeInTheDocument(),
    );
    const bootstrap = staging.getByRole("button", { name: "初始化 Caddy" });
    expect(bootstrap).toBeDisabled();

    fireEvent.click(
      staging.getByRole("checkbox", {
        name: "允许创建 ~/.deploydesk 和独立 Caddy 容器",
      }),
    );
    expect(bootstrap).toBeEnabled();
    fireEvent.click(bootstrap);

    await waitFor(() =>
      expect(staging.getByText(/DeployDesk Caddy 已就绪/)).toBeInTheDocument(),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("button", { name: "初始化 Caddy" }),
    ).toHaveLength(1);
  });

  it("creates a private CNB repository and selects it for the deployment plan", async () => {
    const onError = vi.fn();
    const onRepositorySelected = vi.fn(async () => undefined);
    render(
      <ConnectionsPanel
        onError={onError}
        onRepositorySelected={onRepositorySelected}
      />,
    );

    fireEvent.change(screen.getByLabelText("CNB 访问令牌"), {
      target: { value: "test-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并连接" }));

    await screen.findByText("创建 CNB 项目仓库");
    fireEvent.change(screen.getByLabelText("所属组织或用户名"), {
      target: { value: "team" },
    });
    fireEvent.change(screen.getByLabelText("仓库名称"), {
      target: { value: "project" },
    });
    expect(
      screen.getByRole("checkbox", { name: "创建为私有仓库" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "创建并选用" }));

    await waitFor(() =>
      expect(onRepositorySelected).toHaveBeenCalledWith("team/project"),
    );
    expect(
      screen.getByText(/已创建 team\/project（私有），并写入当前部署计划/),
    ).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });
});
