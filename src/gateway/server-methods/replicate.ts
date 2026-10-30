import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

// Popular video generation models on Replicate
const POPULAR_VIDEO_MODELS = [
    { owner: "bytedance", model: "omni-human" },
    { owner: "stability-ai", model: "stable-video-diffusion" },
    { owner: "lucataco", model: "animate-diff" },
    { owner: "cjwbw", model: "sadtalker" },
    { owner: "fofr", model: "latent-consistency-model" },
    { owner: "anotherjesse", model: "zeroscope-v2-xl" },
    { owner: "cjwbw", model: "videocrafter" },
    { owner: "stability-ai", model: "sdxl" },
    { owner: "black-forest-labs", model: "flux-schnell" },
];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateProgressFromLogs(logs: string): number {
    const match = logs.match(/(\d+)%/);
    if (match) return parseInt(match[1], 10);
    if (logs.includes("Loading")) return 10;
    if (logs.includes("Processing")) return 30;
    if (logs.includes("Generating")) return 50;
    if (logs.includes("Rendering")) return 70;
    if (logs.includes("Saving") || logs.includes("Encoding")) return 90;
    return 50;
}

export const replicateHandlers: GatewayRequestHandlers = {
    /**
     * Fetch popular video generation models from Replicate.
     * Params: { apiKey: string }
     */
    "replicate.models.list": async ({ params, respond }) => {
        const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
        if (!apiKey) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "apiKey is required"));
            return;
        }

        const models: Array<{
            id: string;
            name: string;
            description: string;
            owner: string;
            version: string;
            inputSchema: Record<string, unknown>;
            coverImage?: string;
        }> = [];

        for (const { owner, model } of POPULAR_VIDEO_MODELS) {
            try {
                const response = await fetch(`${REPLICATE_API_BASE}/models/${owner}/${model}`, {
                    headers: {
                        Authorization: `Token ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                });

                if (response.ok) {
                    const data = await response.json();
                    models.push({
                        id: `${owner}/${model}`,
                        name: data.name || model,
                        description: data.description || "",
                        owner: data.owner?.name || owner,
                        version: data.latest_version?.id || "",
                        inputSchema:
                            data.latest_version?.openapi_schema?.components?.schemas?.Input || {},
                        coverImage: data.cover_image_url,
                    });
                }
            } catch (e) {
                // Skip models that fail to load
                console.warn(`[replicate] Failed to fetch model ${owner}/${model}:`, e);
            }
        }

        respond(true, { models });
    },

    /**
     * Search Replicate models by query.
     * Params: { apiKey: string, query: string }
     */
    "replicate.models.search": async ({ params, respond }) => {
        const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
        const query = typeof params.query === "string" ? params.query : "";
        if (!apiKey) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "apiKey is required"));
            return;
        }
        if (!query) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query is required"));
            return;
        }

        try {
            const response = await fetch(
                `${REPLICATE_API_BASE}/models?query=${encodeURIComponent(query)}`,
                {
                    headers: {
                        Authorization: `Token ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                },
            );

            if (!response.ok) {
                respond(
                    false,
                    undefined,
                    errorShape(ErrorCodes.UNAVAILABLE, `Search failed: ${response.status}`),
                );
                return;
            }

            const data = await response.json();
            const models =
                data.results?.map((m: Record<string, unknown>) => ({
                    id: `${m.owner}/${m.name}`,
                    name: m.name,
                    description: (m.description as string) || "",
                    owner: m.owner,
                    version: (m as any).latest_version?.id || "",
                    inputSchema: {},
                    coverImage: (m as any).cover_image_url,
                })) || [];

            respond(true, { models });
        } catch (e) {
            respond(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, `Model search failed: ${e}`),
            );
        }
    },

    /**
     * Create a Replicate prediction and poll until complete.
     * Params: { apiKey: string, version: string, input: Record<string, unknown> }
     */
    "replicate.predictions.create": async ({ params, respond }) => {
        const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
        const version = typeof params.version === "string" ? params.version : "";
        const input =
            params.input && typeof params.input === "object"
                ? (params.input as Record<string, unknown>)
                : {};

        if (!apiKey) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "apiKey is required"));
            return;
        }
        if (!version) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "version is required"));
            return;
        }

        try {
            // Create prediction
            const createResponse = await fetch(`${REPLICATE_API_BASE}/predictions`, {
                method: "POST",
                headers: {
                    Authorization: `Token ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ version, input }),
            });

            if (!createResponse.ok) {
                const error = await createResponse.json().catch(() => ({}));
                respond(
                    false,
                    undefined,
                    errorShape(
                        ErrorCodes.UNAVAILABLE,
                        (error as any).detail || `Failed to create prediction: ${createResponse.status}`,
                    ),
                );
                return;
            }

            const prediction = await createResponse.json();
            const predictionId = prediction.id;

            // Poll for completion
            while (true) {
                await sleep(2000);

                const pollResponse = await fetch(
                    `${REPLICATE_API_BASE}/predictions/${predictionId}`,
                    {
                        headers: { Authorization: `Token ${apiKey}` },
                    },
                );

                if (!pollResponse.ok) {
                    respond(
                        false,
                        undefined,
                        errorShape(
                            ErrorCodes.UNAVAILABLE,
                            `Failed to poll prediction: ${pollResponse.status}`,
                        ),
                    );
                    return;
                }

                const result = await pollResponse.json();

                if (result.status === "succeeded") {
                    respond(true, { output: result.output, status: "succeeded" });
                    return;
                }

                if (result.status === "failed") {
                    respond(
                        false,
                        undefined,
                        errorShape(ErrorCodes.UNAVAILABLE, result.error || "Prediction failed"),
                    );
                    return;
                }

                if (result.status === "canceled") {
                    respond(
                        false,
                        undefined,
                        errorShape(ErrorCodes.UNAVAILABLE, "Prediction was canceled"),
                    );
                    return;
                }

                // Continue polling...
                if (result.logs) {
                    estimateProgressFromLogs(result.logs);
                }
            }
        } catch (e) {
            respond(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, `Prediction failed: ${e}`),
            );
        }
    },
};
