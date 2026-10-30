import { describe, expect, it } from "vitest";
import { parseWorkflowUpload, WorkflowImportError } from "./import.js";

const b = (s: string) => Buffer.from(s);

describe("parseWorkflowUpload", () => {
  it("parses InfiniBot JSON", () => {
    const r = parseWorkflowUpload(
      "w.json",
      b(JSON.stringify({ name: "Daily Digest", body: "1. do it", tags: ["a"] })),
    );
    expect(r.format).toBe("infinibot-json");
    expect(r.params.name).toBe("Daily Digest");
    expect(r.params.tags).toEqual(["a"]);
  });
  it("parses markdown workflow", () => {
    const r = parseWorkflowUpload(
      "w.md",
      b("---\nname: MD Flow\ndescription: d\n---\n# Steps\n1. go\n"),
    );
    expect(r.format).toBe("markdown");
    expect(r.params.body).toContain("1. go");
  });
  it("converts n8n in execution order and drops secrets", () => {
    const n8n = {
      name: "Lead flow",
      nodes: [
        {
          name: "Send Mail",
          type: "n8n-nodes-base.gmail",
          parameters: { subject: "Hi", apiKey: "SECRET123" },
        },
        { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "lead" } },
      ],
      connections: { Webhook: { main: [[{ node: "Send Mail" }]] } },
    };
    const r = parseWorkflowUpload("lead.json", b(JSON.stringify(n8n)));
    expect(r.format).toBe("n8n");
    expect(r.params.body.indexOf("Webhook")).toBeLessThan(r.params.body.indexOf("Send Mail"));
    expect(r.params.body).not.toContain("SECRET123");
    expect(r.params.tags).toContain("n8n");
  });
  it.each([
    ["truncated json", '{"name": "x", ', /valid JSON/],
    ["random json", '{"foo": 1}', /name/],
    ["no body", '{"name":"x"}', /body/],
    ["plain text", "hello", /recognise/],
    ["empty", "", /empty/],
    ["no steps", "---\nname: x\n---\n", /no steps/],
  ])("rejects %s plainly", (_n, text, re) => {
    expect(() => parseWorkflowUpload("w", b(text))).toThrow(WorkflowImportError);
    expect(() => parseWorkflowUpload("w", b(text))).toThrow(re);
  });
  it("rejects zips, binary, oversize", () => {
    expect(() => parseWorkflowUpload("w.zip", Buffer.from([0x50, 0x4b, 3, 4]))).toThrow(/zip/);
    expect(() => parseWorkflowUpload("w", Buffer.from([65, 0, 66]))).toThrow(/isn't text/);
    expect(() => parseWorkflowUpload("w", Buffer.alloc(3 * 1024 * 1024, 65))).toThrow(/limit/);
  });
});
