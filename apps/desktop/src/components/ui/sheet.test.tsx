import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

function ExampleSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button">打开任务</button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>处理部署任务</SheetTitle>
          <SheetDescription>补全当前任务后从原位置继续。</SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <button type="button">完成并关闭</button>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

describe("Sheet", () => {
  it("opens with an accessible title and closes from an explicit action", async () => {
    render(<ExampleSheet />);

    fireEvent.click(screen.getByRole("button", { name: "打开任务" }));
    expect(
      await screen.findByRole("dialog", { name: "处理部署任务" }),
    ).toBeInTheDocument();
    expect(screen.getByText("补全当前任务后从原位置继续。")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "完成并关闭" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "处理部署任务" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes with Escape", async () => {
    render(<ExampleSheet />);

    fireEvent.click(screen.getByRole("button", { name: "打开任务" }));
    const sheet = await screen.findByRole("dialog", {
      name: "处理部署任务",
    });
    fireEvent.keyDown(sheet, { key: "Escape", code: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "处理部署任务" }),
      ).not.toBeInTheDocument(),
    );
  });
});
