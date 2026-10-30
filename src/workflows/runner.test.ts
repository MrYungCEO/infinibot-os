import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WorkflowStore } from "./store.js";
import {
    WorkflowRunStore,
    preflightWorkflow,
    validateInputs,
} from "./runner.js";
import type { WorkflowInputDef, WorkflowRequirement } from "./types.js";

describe("validateInputs", () => {
    test("required field missing → error", () => {
        const defs: WorkflowInputDef[] = [{ name: "topic", type: "string", required: true }];
        const r = validateInputs(defs, {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors[0]).toContain("required");
    });

    test("default applied when value is empty", () => {
        const defs: WorkflowInputDef[] = [
            { name: "topic", type: "string", default: "default-topic" },
        ];
        const r = validateInputs(defs, { topic: "" });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.values.topic).toBe("default-topic");
    });

    test("number coercion + bounds", () => {
        const defs: WorkflowInputDef[] = [{ name: "count", type: "number", min: 1, max: 5 }];
        expect(validateInputs(defs, { count: "3" }).ok).toBe(true);
        const tooLow = validateInputs(defs, { count: 0 });
        expect(tooLow.ok).toBe(false);
        if (!tooLow.ok) expect(tooLow.errors[0]).toContain(">= 1");
        const tooHigh = validateInputs(defs, { count: 99 });
        expect(tooHigh.ok).toBe(false);
        if (!tooHigh.ok) expect(tooHigh.errors[0]).toContain("<= 5");
    });

    test("select rejects values outside options", () => {
        const defs: WorkflowInputDef[] = [
            {
                name: "color",
                type: "select",
                options: [{ value: "red" }, { value: "blue" }],
            },
        ];
        expect(validateInputs(defs, { color: "red" }).ok).toBe(true);
        const r = validateInputs(defs, { color: "purple" });
        expect(r.ok).toBe(false);
    });

    test("multiSelect — array of allowed values", () => {
        const defs: WorkflowInputDef[] = [
            {
                name: "tags",
                type: "multiSelect",
                options: [{ value: "a" }, { value: "b" }, { value: "c" }],
            },
        ];
        expect(validateInputs(defs, { tags: ["a", "b"] }).ok).toBe(true);
        expect(validateInputs(defs, { tags: ["a", "x"] }).ok).toBe(false);
    });

    test("email + url pattern checks", () => {
        const defs: WorkflowInputDef[] = [
            { name: "to", type: "email", required: true },
            { name: "site", type: "url", required: true },
        ];
        expect(
            validateInputs(defs, { to: "x@y.com", site: "https://example.com" }).ok,
        ).toBe(true);
        expect(validateInputs(defs, { to: "not-an-email", site: "https://x.com" }).ok).toBe(
            false,
        );
        expect(
            validateInputs(defs, { to: "x@y.com", site: "not-a-url" }).ok,
        ).toBe(false);
    });

    test("boolean coercion from common string forms", () => {
        const defs: WorkflowInputDef[] = [{ name: "enabled", type: "boolean" }];
        for (const t of ["true", "True", "yes", "1", true]) {
            const r = validateInputs(defs, { enabled: t as unknown });
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.values.enabled).toBe(true);
        }
        for (const f of ["false", "no", "0", false]) {
            const r = validateInputs(defs, { enabled: f as unknown });
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.values.enabled).toBe(false);
        }
    });

    test("regex pattern enforced", () => {
        const defs: WorkflowInputDef[] = [
            { name: "slug", type: "string", required: true, pattern: "^[a-z0-9-]+$" },
        ];
        expect(validateInputs(defs, { slug: "hello-world" }).ok).toBe(true);
        expect(validateInputs(defs, { slug: "Hello World" }).ok).toBe(false);
    });
});

describe("preflightWorkflow — env requirements", () => {
    test("missing required env var → error issue, ok=false", async () => {
        delete process.env.WORKFLOW_TEST_REQUIRED;
        const wf = {
            id: "t",
            name: "T",
            createdAt: "",
            updatedAt: "",
            body: "do thing",
            inputs: [],
            requires: [
                { kind: "env" as const, name: "WORKFLOW_TEST_REQUIRED" },
            ] satisfies WorkflowRequirement[],
        };
        const r = await preflightWorkflow(wf);
        expect(r.ok).toBe(false);
        const errs = r.issues.filter((i) => i.severity === "error");
        expect(errs.length).toBe(1);
        expect(errs[0].detail).toContain("WORKFLOW_TEST_REQUIRED");
        expect(r.interpolatedBody).toBeUndefined();
    });

    test("present env var → ok", async () => {
        process.env.WORKFLOW_TEST_PRESENT = "yep";
        try {
            const wf = {
                id: "t",
                name: "T",
                createdAt: "",
                updatedAt: "",
                body: "do thing",
                requires: [
                    { kind: "env" as const, name: "WORKFLOW_TEST_PRESENT" },
                ] satisfies WorkflowRequirement[],
            };
            const r = await preflightWorkflow(wf);
            expect(r.ok).toBe(true);
            expect(r.issues).toHaveLength(0);
        } finally {
            delete process.env.WORKFLOW_TEST_PRESENT;
        }
    });

    test("optional env var missing → warning, still ok", async () => {
        delete process.env.WORKFLOW_TEST_OPTIONAL;
        const wf = {
            id: "t",
            name: "T",
            createdAt: "",
            updatedAt: "",
            body: "do thing",
            requires: [
                {
                    kind: "env" as const,
                    name: "WORKFLOW_TEST_OPTIONAL",
                    optional: true,
                },
            ] satisfies WorkflowRequirement[],
        };
        const r = await preflightWorkflow(wf);
        expect(r.ok).toBe(true);
        const warns = r.issues.filter((i) => i.severity === "warning");
        expect(warns.length).toBe(1);
    });
});

describe("preflightWorkflow — input + interpolation", () => {
    test("validated inputs interpolate into body and emit <inputs> JSON block", async () => {
        const wf = {
            id: "t",
            name: "T",
            createdAt: "",
            updatedAt: "",
            inputs: [
                { name: "topic", type: "string" as const, required: true },
                { name: "count", type: "number" as const, default: 3 },
            ] satisfies WorkflowInputDef[],
            body: "Research {{topic}} in {{count}} bullet points.",
        };
        const r = await preflightWorkflow(wf, { inputs: { topic: "federation" } });
        expect(r.ok).toBe(true);
        expect(r.resolvedInputs).toEqual({ topic: "federation", count: 3 });
        expect(r.interpolatedBody).toContain("<inputs>");
        expect(r.interpolatedBody).toContain('"topic": "federation"');
        expect(r.interpolatedBody).toContain("Research federation in 3 bullet points.");
    });

    test("unknown placeholder is left as {{name}} (not silently emptied)", async () => {
        const wf = {
            id: "t",
            name: "T",
            createdAt: "",
            updatedAt: "",
            inputs: [],
            body: "Run with {{unspecified}}.",
        };
        const r = await preflightWorkflow(wf);
        expect(r.ok).toBe(true);
        expect(r.interpolatedBody).toContain("{{unspecified}}");
    });
});

describe("frontmatter round-trip", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-wf-test-"));
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test("create + get roundtrips inputs[] and requires[]", () => {
        const store = new WorkflowStore(tmp);
        const created = store.create({
            name: "Send weekly digest",
            description: "Pulls stats and emails them out",
            tags: ["ops", "weekly"],
            body: "Send digest to {{to}}.",
            inputs: [
                {
                    name: "to",
                    type: "email",
                    required: true,
                    description: "Recipient",
                },
                {
                    name: "include_charts",
                    type: "boolean",
                    default: true,
                },
            ],
            requires: [
                { kind: "env", name: "SENDGRID_API_KEY" },
                { kind: "tool", name: "stats.fetch", optional: true },
            ],
            agent: "main",
            timeoutSeconds: 300,
        });
        const round = store.get(created.id);
        expect(round).not.toBeNull();
        expect(round?.inputs?.length).toBe(2);
        expect(round?.inputs?.[0].name).toBe("to");
        expect(round?.inputs?.[1].default).toBe(true);
        expect(round?.requires?.length).toBe(2);
        expect(round?.requires?.[0].kind).toBe("env");
        expect(round?.agent).toBe("main");
        expect(round?.timeoutSeconds).toBe(300);
    });
});

describe("WorkflowRunStore", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-wf-runs-"));
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test("insert + list + get + update flow", () => {
        const store = new WorkflowRunStore(tmp);
        store.insert({
            id: "r1",
            workflowId: "wf",
            workflowName: "WF",
            status: "pending",
            inputs: {},
            agent: "main",
            startedAt: new Date(2026, 0, 1).toISOString(),
        });
        store.insert({
            id: "r2",
            workflowId: "wf2",
            workflowName: "WF2",
            status: "running",
            inputs: {},
            agent: "main",
            startedAt: new Date(2026, 0, 2).toISOString(),
        });
        const list = store.list();
        expect(list).toHaveLength(2);
        // Newest first
        expect(list[0].id).toBe("r2");
        const filtered = store.list({ workflowId: "wf" });
        expect(filtered.map((r) => r.id)).toEqual(["r1"]);
        const updated = store.update("r1", { status: "completed", result: "ok" });
        expect(updated?.status).toBe("completed");
        expect(updated?.result).toBe("ok");
        expect(store.get("r1")?.status).toBe("completed");
    });
});
