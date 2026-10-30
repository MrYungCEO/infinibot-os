/**
 * Screen analyze tool — capture a screenshot of a specific monitor and return
 * it as a native image attachment so the model can see and reason about what
 * is currently displayed there (charts, dashboards, errors, windows, etc.).
 *
 * Windows only — uses scripts/desktop-control.ps1 (System.Drawing) under the
 * hood. The image is auto-downscaled by sanitizeToolResultImages if it exceeds
 * Anthropic Messages API limits, so 4K monitors are safe.
 */

import * as os from "node:os";
import * as path from "node:path";

import { Type } from "@sinclair/typebox";

import { listDisplays, screenshotDisplay } from "../../desktop/launcher.js";
import { stringEnum } from "../schema/typebox.js";
import {
    type AnyAgentTool,
    imageResultFromFile,
    jsonResult,
    readNumberParam,
    readStringParam,
} from "./common.js";

const ScreenAnalyzeSchema = Type.Object({
    action: stringEnum(["list_displays", "capture"]),
    display: Type.Optional(
        Type.Number({
            description:
                "1-based monitor index (follows Windows Display Settings order). Defaults to 1 (primary). Use list_displays to enumerate monitors first if unsure.",
        }),
    ),
    prompt: Type.Optional(
        Type.String({
            description:
                "Optional note about what you're looking for. Purely informational — it is attached as a caption and does not change the captured pixels.",
        }),
    ),
});

export function createScreenAnalyzeTool(): AnyAgentTool {
    return {
        label: "Screen Capture",
        name: "screen_analyze",
        description: [
            "Capture a screenshot of a specific monitor on the user's desktop and receive the image as a first-class attachment so you can analyze what is on screen — charts, dashboards, documents, errors, app state, etc.",
            "Actions:",
            "  list_displays — enumerate connected monitors with their bounds (index follows Windows Display Settings order).",
            "  capture — take a PNG screenshot of a given display. Params: display (1-based index, defaults to 1), prompt (optional free-form note).",
            "Use list_displays first if you don't know which index the user's 'screen two' corresponds to. The returned image is downscaled automatically if the monitor is very high-resolution.",
            "Example usage: user says 'analyze the chart on screen two and tell me your conviction' → call capture with display=2, then reason about the image in your reply.",
            "Windows only.",
        ].join(" "),

        parameters: ScreenAnalyzeSchema,

        execute: async (_toolCallId, args) => {
            const params = args as Record<string, unknown>;
            const action = readStringParam(params, "action", { required: true });

            try {
                switch (action) {
                    case "list_displays": {
                        const displays = await listDisplays();
                        return jsonResult({ count: displays.length, displays });
                    }

                    case "capture": {
                        const display =
                            readNumberParam(params, "display", { integer: true }) ?? 1;
                        const prompt = readStringParam(params, "prompt");
                        const ts = Date.now();
                        const outPath = path.join(
                            os.tmpdir(),
                            `moltbot-screen-${display}-${ts}.png`,
                        );

                        const result = await screenshotDisplay({ display, out: outPath });
                        if (!result.ok || !result.path) {
                            return jsonResult({
                                error: result.error ?? "screenshot failed",
                                display,
                            });
                        }

                        const caption = [
                            `Screenshot of display ${result.display} (${result.width}x${result.height}).`,
                            prompt ? `User context: ${prompt}` : undefined,
                            "Analyze what you see in this image.",
                        ]
                            .filter(Boolean)
                            .join(" ");

                        return await imageResultFromFile({
                            label: "Screen Capture",
                            path: result.path,
                            extraText: caption,
                            details: {
                                display: result.display,
                                width: result.width,
                                height: result.height,
                                bounds: result.bounds,
                                path: result.path,
                            },
                        });
                    }

                    default:
                        return jsonResult({ error: `unknown action: ${action}` });
                }
            } catch (err: any) {
                return jsonResult({ error: err?.message ?? String(err), action });
            }
        },
    };
}
