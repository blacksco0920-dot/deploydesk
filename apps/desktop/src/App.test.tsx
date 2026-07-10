import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("DeployDesk desktop flow", () => {
  it("opens the read-only Ecat example and exposes the guided workflow", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "选择一个项目目录" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("云端部署就绪")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /查看 Ecat 识别示例/ }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "ecat-energy" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText("api", { selector: ".service-name strong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin", { selector: ".service-name strong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("miniapp", { selector: ".service-name strong" }),
    ).toBeInTheDocument();

    const main = screen.getByRole("main");
    main.scrollTop = 320;
    fireEvent.click(screen.getByRole("button", { name: "部署计划" }));
    await waitFor(() => expect(main.scrollTop).toBe(0));
    expect(
      screen.getByRole("heading", { name: "确认后再写入项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("连接 CNB")).toBeInTheDocument();
    expect(screen.getByText("制作不可变镜像")).toBeInTheDocument();
  });
});
