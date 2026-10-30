import { describe, expect, it } from "vitest";

import {
  buildContinuationPrompt,
  COMPLETION_CONTRACT_PROMPT,
  parseResultBlock,
  RESULT_CLOSE,
  RESULT_OPEN,
} from "./contract.js";

const block = (json: string) => `Work done.\n\n${RESULT_OPEN}\n${json}\n${RESULT_CLOSE}`;

describe("parseResultBlock", () => {
  it("parses the canonical marker block", () => {
    const r = parseResultBlock(
      block(
        JSON.stringify({
          status: "done",
          summary: "Added the button.",
          commits: ["abc1234"],
          files_changed: ["ui/src/x.ts"],
          claims: [{ claim: "build passes", evidence_type: "command", evidence_ref: "pnpm build" }],
          checks_run: [{ command: "pnpm build", exit_code: 0, output_tail: "ok" }],
          screenshots: ["/tmp/a.png"],
          open_issues: [],
        }),
      ),
    );
    expect(r?.status).toBe("done");
    expect(r?.commits).toEqual(["abc1234"]);
    expect(r?.claims[0]).toEqual({
      claim: "build passes",
      evidence_type: "command",
      evidence_ref: "pnpm build",
    });
    expect(r?.checks_run[0].exit_code).toBe(0);
    expect(r?.screenshots).toEqual(["/tmp/a.png"]);
  });

  it("takes the LAST block when several are present", () => {
    const text = `${block('{"status":"blocked","summary":"first"}')}\nmore work\n${block('{"status":"done","summary":"second"}')}`;
    expect(parseResultBlock(text)?.summary).toBe("second");
  });

  it("tolerates a fenced json body, trailing commas and a missing close marker", () => {
    expect(
      parseResultBlock(`${RESULT_OPEN}\n\`\`\`json\n{"status":"done","summary":"x",}\n\`\`\``)
        ?.summary,
    ).toBe("x");
    expect(
      parseResultBlock(
        `${RESULT_OPEN} {"status":"needs_input","summary":"need key","open_issues":["API key"]}`,
      )?.status,
    ).toBe("needs_input");
  });

  it("falls back to a fenced json object with status + summary (markers dropped)", () => {
    const text =
      'Done!\n```json\n{"status":"done","summary":"fixed it","claims":["tests pass"]}\n```';
    const r = parseResultBlock(text);
    expect(r?.status).toBe("done");
    // bare-string claims are kept but have no evidence ref
    expect(r?.claims[0]).toMatchObject({ claim: "tests pass", evidence_ref: "" });
  });

  it("accepts a RESULT: heading", () => {
    expect(
      parseResultBlock('All good.\n\nRESULT:\n{"status":"completed","summary":"ok"}')?.status,
    ).toBe("done");
  });

  it("returns null for text without a result and for invalid status", () => {
    expect(parseResultBlock("I'll wait for the notification.")).toBeNull();
    expect(parseResultBlock(block('{"status":"maybe","summary":"x"}'))).toBeNull();
    expect(parseResultBlock("")).toBeNull();
  });

  it("the injected prompt requires waiting for background work and visual_verify", () => {
    expect(COMPLETION_CONTRACT_PROMPT).toMatch(/Never end your turn while background work/);
    expect(COMPLETION_CONTRACT_PROMPT).toMatch(/visual_verify/);
    expect(COMPLETION_CONTRACT_PROMPT).toContain(RESULT_OPEN);
    expect(buildContinuationPrompt(["no RESULT block"])).toMatch(
      /^Continue: you exited before finishing/,
    );
  });
});
