import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";

describe("ABCDeploy beginner flow", () => {
  beforeEach(() => localStorage.clear());

  it("recognizes a project, connects reusable resources and recommends a release plan", async () => {
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "部署第一个项目" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看示例" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "项目结构已经识别完成" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("api", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("admin", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("miniapp", { selector: "strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /结果正确，继续/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接构建服务和目标服务器" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    fireEvent.change(screen.getByLabelText("访问令牌"), {
      target: { value: "demo-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /验证并连接/ }));
    await waitFor(() => expect(screen.getByText("已连接账号 示例用户")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("例如 123.123.123.123"), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /验证连接/ }));
    await waitFor(() =>
      expect(screen.getByText("确认服务器身份")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /确认并连接/ }));
    await waitFor(() => expect(screen.getByText("服务器连接正常")).toBeInTheDocument());

    const continueButton = screen.getByRole("button", { name: /使用这些连接/ });
    await waitFor(() => expect(continueButton).toBeEnabled());
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "推荐方案已经准备好" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("同一版本晋级生产")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /使用推荐方案/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "只补充系统无法知道的信息" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /查看部署计划/ }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "确认首次部署会做什么" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "开始部署测试" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "正在部署测试环境" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "测试环境已经可以使用" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /进入项目工作台/ }));
    await waitFor(() =>
      expect(screen.getByText("测试环境运行正常")).toBeInTheDocument(),
    );
  });
});
