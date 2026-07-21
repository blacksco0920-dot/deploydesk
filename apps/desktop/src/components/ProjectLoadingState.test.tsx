import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectLoadingState } from "../App";

describe("ProjectLoadingState", () => {
  it("识别项目时直接使用工作流骨架，不闪现旧版项目导航", () => {
    render(
      <ProjectLoadingState mode="recognizing" path="/projects/sample-store" />,
    );

    expect(
      screen.getByRole("heading", { name: "正在读取项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("部署工作流")).toBeInTheDocument();
    expect(screen.queryByText("发布中心")).not.toBeInTheDocument();
    expect(screen.queryByText("在本机运行")).not.toBeInTheDocument();
    expect(screen.queryByText("版本")).not.toBeInTheDocument();
    expect(screen.queryByText("项目设置")).not.toBeInTheDocument();
  });

  it("恢复项目时明确只恢复线路，不重新执行上线", () => {
    render(
      <ProjectLoadingState mode="restoring" path="/projects/sample-store" />,
    );

    expect(
      screen.getByRole("heading", { name: "正在恢复工作流" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不会重新执行上线/)).toBeInTheDocument();
  });
});
