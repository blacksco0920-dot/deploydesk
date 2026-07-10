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
    const { container } = render(<ConnectionsPanel onError={onError} />);
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
      expect(
        staging.getByText(/DeployDesk Caddy 已就绪/),
      ).toBeInTheDocument(),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("button", { name: "初始化 Caddy" }),
    ).toHaveLength(1);
  });
});
