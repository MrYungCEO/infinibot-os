import { afterEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../markdown/render";
import { prepareChatAttachment } from "./attachments";
import { handleSnippetCopy, markdownToPlainText, withSnippetCopyButtons } from "./snippet-copy";
import "../components/response-actions";
import type { ResponseActions } from "../components/response-actions";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("agent response copy affordances", () => {
  it("copies each fenced and inline snippet independently", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const host = document.createElement("div");
    host.innerHTML = withSnippetCopyButtons(
      toSanitizedMarkdownHtml("Run `pnpm test`:\n\n```sh\necho ready\n```"),
    );
    host.addEventListener("click", handleSnippetCopy);
    document.body.append(host);

    const buttons = host.querySelectorAll<HTMLButtonElement>(".md-copy-button");
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("echo ready\n");
      expect(buttons[1].textContent).toBe("Copied");
    });

    buttons[0].click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("pnpm test"));
  });

  it("copies a whole response as readable plain text", () => {
    const markdown = "# Result\n\nUse **this**:\n\n```sh\npnpm test\n```";
    expect(markdownToPlainText(markdown, toSanitizedMarkdownHtml(markdown))).toBe(
      "Result\n\nUse this:\n\npnpm test",
    );
  });
});

describe("response actions", () => {
  async function mount(request: ReturnType<typeof vi.fn>, secure = false) {
    const el = document.createElement("ib-response-actions") as ResponseActions;
    el.markdown = "## Release note\n\nEverything passed.";
    el.sessionKey = secure ? "secure:main" : "agent:main:main";
    el.secure = secure;
    el.client = { request } as never;
    document.body.append(el);
    await el.updateComplete;
    (el.shadowRoot!.querySelector(".plus") as HTMLButtonElement).click();
    await el.updateComplete;
    return el;
  }

  it("saves a response through the registered report system", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workflows.list") return { workflows: [] };
      if (method === "files.list") return { items: [] };
      if (method === "kanban.projects.list") return [];
      if (method === "reports.render") return { id: "report_1" };
      throw new Error(`unexpected ${method}`);
    });
    const el = await mount(request);
    const save = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".action")).find(
      (button) => button.textContent?.includes("Save as Report"),
    )!;
    save.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "reports.render",
        expect.objectContaining({ register: true, sourceSession: "agent:main:main" }),
      ),
    );
    await vi.waitFor(async () => {
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector(".toast")?.textContent).toContain("Report saved");
    });
  });

  it("runs an existing workflow with the response as input", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workflows.list") return { workflows: [{ id: "wf_1", name: "Publish" }] };
      if (method === "files.list") return { items: [] };
      if (method === "kanban.projects.list") return [];
      if (method === "workflows.run.start") return { runId: "run_1" };
      throw new Error(`unexpected ${method}`);
    });
    const el = await mount(request);
    await vi.waitFor(async () => {
      await el.updateComplete;
      const run = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".action")).find(
        (button) => button.textContent?.includes("Run Workflow"),
      );
      expect(run?.disabled).toBe(false);
    });
    const run = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".action")).find(
      (button) => button.textContent?.includes("Run Workflow"),
    )!;
    run.click();
    await el.updateComplete;
    (el.shadowRoot!.querySelector(".primary") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workflows.run.start", {
        id: "wf_1",
        inputs: expect.objectContaining({ response: expect.stringContaining("Everything passed") }),
      }),
    );
  });

  it("disables actions that leave the secure lane", async () => {
    const el = await mount(vi.fn(), true);
    expect(el.shadowRoot!.textContent).toContain("Secure session");
    const saveButtons = Array.from(
      el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".action"),
    ).slice(0, 4);
    expect(saveButtons.every((button) => button.disabled)).toBe(true);
  });
});

describe("document upload preparation", () => {
  it("pre-uploads every supported format and preserves extraction status", async () => {
    const files = [
      ["brief.pdf", "application/pdf"],
      ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["notes.txt", "text/plain"],
      ["notes.md", "text/markdown"],
      ["data.csv", "text/csv"],
      ["photo.png", "image/png"],
      ["clip.mp4", "video/mp4"],
    ] as const;
    const request = vi.fn(async (_method: string, params: { path: string }) => ({
      path: params.path,
      ocr: { id: `ocr-${params.path}`, status: "queued" },
    }));

    for (const [name, mime] of files) {
      const attachment = await prepareChatAttachment({
        file: new File([`fixture:${name}`], name, { type: mime }),
        client: { request } as never,
        sessionKey: "agent:main:main",
      });
      expect(attachment.mimeType).toBe(mime);
      expect(attachment.ocrId).toContain(name);
      expect(attachment.extractionStatus).toBe("queued");
      expect(attachment.dataUrl).toContain(";base64,");
    }
    expect(request).toHaveBeenCalledTimes(files.length);
    expect(request.mock.calls.every(([method]) => method === "files.upload")).toBe(true);
  });
});
