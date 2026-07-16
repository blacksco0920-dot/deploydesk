import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationCenter,
  isSensitiveConfiguration,
} from "./ConfigurationCenter";

describe("ConfigurationCenter", () => {
  beforeEach(() => localStorage.clear());

  it("只使用配置说明、配置名称和值保存可复用配置", async () => {
    render(<ConfigurationCenter onError={vi.fn()} />);

    await screen.findByText("暂时不需要添加配置");
    expect(screen.getByText(/这里不是上线前置步骤/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "添加配置" }),
    ).not.toBeInTheDocument();
    const addConfiguration = screen.getByRole("button", {
      name: "保存一项常用配置",
    });
    expect(addConfiguration).toHaveClass("border");
    fireEvent.click(addConfiguration);
    fireEvent.change(screen.getByLabelText("配置说明"), {
      target: { value: "测试环境访问凭证" },
    });
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "service_access_key" },
    });
    const secretValue = screen.getByLabelText("配置值");
    expect(secretValue).toHaveAttribute("type", "password");
    fireEvent.change(secretValue, {
      target: { value: "test-secret-key" },
    });
    const showValue = screen.getByRole("button", {
      name: "显示测试环境访问凭证配置值",
    });
    fireEvent.click(showValue);
    expect(secretValue).toHaveAttribute("type", "text");
    fireEvent.click(
      screen.getByRole("button", {
        name: "隐藏测试环境访问凭证配置值",
      }),
    );
    expect(secretValue).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await screen.findByText("测试环境访问凭证");
    expect(
      screen.getByRole("button", { name: "添加配置" }),
    ).toBeInTheDocument();
    expect(screen.getByText("SERVICE_ACCESS_KEY")).toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("test-secret-key"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "编辑 测试环境访问凭证" }),
    );
    expect(screen.getByText(/配置名称需要与项目配置文件/)).toBeInTheDocument();
    expect(screen.queryByText(/英文配置名称/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("配置值")).toHaveValue("");
    expect(
      screen.getByPlaceholderText("已安全保存，留空表示不修改"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(
      screen.getByRole("button", { name: "删除 测试环境访问凭证" }),
    );
    expect(
      screen.getByText(/不会清除已经保存到项目中的配置/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(screen.queryByText("测试环境访问凭证")).not.toBeInTheDocument(),
    );
  });

  it("把数据库连接串作为敏感值安全保存", async () => {
    render(<ConfigurationCenter onError={vi.fn()} />);

    await screen.findByText("暂时不需要添加配置");
    fireEvent.click(screen.getByRole("button", { name: "保存一项常用配置" }));
    fireEvent.change(screen.getByLabelText("配置说明"), {
      target: { value: "业务数据库" },
    });
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "database_url" },
    });
    const value = screen.getByLabelText("配置值");
    expect(value).toHaveAttribute("type", "password");
    fireEvent.change(value, {
      target: { value: "postgresql://demo:secret@db.example.com/app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await screen.findByText("业务数据库");
    expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(
      screen.queryByText("postgresql://demo:secret@db.example.com/app"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑 业务数据库" }));
    expect(screen.getByLabelText("配置值")).toHaveValue("");
    expect(
      screen.getByPlaceholderText("已安全保存，留空表示不修改"),
    ).toBeInTheDocument();
  });

  it("识别带凭据的连接地址，但不误判普通公开地址", () => {
    expect(isSensitiveConfiguration("REDIS_URL")).toBe(true);
    expect(isSensitiveConfiguration("MONGODB_URI")).toBe(true);
    expect(
      isSensitiveConfiguration(
        "SERVICE_ENDPOINT",
        "https://account:password@example.com/api",
      ),
    ).toBe(true);
    expect(
      isSensitiveConfiguration(
        "CALLBACK_URL",
        "https://example.com/callback?access_token=secret",
      ),
    ).toBe(true);
    expect(
      isSensitiveConfiguration("VITE_API_BASE_URL", "https://api.example.com"),
    ).toBe(false);
  });

  it("编辑通用名称的敏感地址时继续遮盖并保留原值", async () => {
    render(<ConfigurationCenter onError={vi.fn()} />);

    await screen.findByText("暂时不需要添加配置");
    fireEvent.click(screen.getByRole("button", { name: "保存一项常用配置" }));
    fireEvent.change(screen.getByLabelText("配置说明"), {
      target: { value: "带账号的服务地址" },
    });
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "service_endpoint" },
    });
    fireEvent.change(screen.getByLabelText("配置值"), {
      target: { value: "https://account:password@example.com/api" },
    });
    expect(screen.getByLabelText("配置值")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await screen.findByText("带账号的服务地址");
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "编辑 带账号的服务地址" }),
    );
    const replacement = screen.getByLabelText("配置值");
    expect(replacement).toHaveAttribute("type", "password");
    expect(replacement).toHaveValue("");
    expect(
      screen.getByPlaceholderText("已安全保存，留空表示不修改"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await screen.findByText("带账号的服务地址");
    expect(screen.getByText("••••••••")).toBeInTheDocument();
  });
});
