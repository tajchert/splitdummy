import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PhotoViewer } from "./EntryAttachments";

describe("PhotoViewer under StrictMode", () => {
  afterEach(() => cleanup());

  it("ignores a stale close event while open, and closes on a genuine close", () => {
    const onClose = vi.fn();
    const { container } = render(
      <StrictMode>
        <PhotoViewer urls={["/a.webp", "/b.webp"]} index={0} onIndex={() => {}} onClose={onClose} />
      </StrictMode>,
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(true);
    onClose.mockClear();

    // Stale event queued by the first (StrictMode) cleanup's d.close() while the dialog is open again.
    dialog.dispatchEvent(new Event("close"));
    expect(onClose).not.toHaveBeenCalled();

    // Genuine close: the dialog is no longer open.
    if (typeof dialog.close === "function") dialog.close();
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
