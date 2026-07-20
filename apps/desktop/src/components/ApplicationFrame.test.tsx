import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApplicationFrame } from "./ApplicationFrame";

describe("ApplicationFrame", () => {
  it("首页只保留项目和配置中心两个一级入口", () => {
    const onShowProjects = vi.fn();
    const onShowConfiguration = vi.fn();

    render(
      <ApplicationFrame
        activeView="projects"
        onShowConfiguration={onShowConfiguration}
        onShowProjects={onShowProjects}
      >
        <div>项目列表内容</div>
      </ApplicationFrame>,
    );

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toHaveTextContent("所有项目");
    expect(navigation).toHaveTextContent("配置中心");
    expect(navigation).not.toHaveTextContent("运行记录");
    expect(screen.getByRole("button", { name: "所有项目" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("项目列表内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "所有项目" }));
    fireEvent.click(screen.getByRole("button", { name: "配置中心" }));
    expect(onShowProjects).toHaveBeenCalledTimes(1);
    expect(onShowConfiguration).toHaveBeenCalledTimes(1);
  });

  it("进入项目后让工作流独占页面，不叠加应用侧栏", () => {
    render(
      <ApplicationFrame
        activeView="project"
        onShowConfiguration={vi.fn()}
        onShowProjects={vi.fn()}
      >
        <main>项目工作流</main>
      </ApplicationFrame>,
    );

    expect(screen.getByText("项目工作流")).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "主导航" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "所有项目" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "配置中心" }),
    ).not.toBeInTheDocument();
  });
});
