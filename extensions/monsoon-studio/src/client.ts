import { STUDIO_TOOL_SCHEMAS } from "./tool-schemas.js";
import type { MonsoonStudioConfig } from "./config.js";

export interface StudioToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const STUDIO_TOOLS = STUDIO_TOOL_SCHEMAS;
const TOOL_NAMES = new Set(STUDIO_TOOLS.map((tool) => tool.name));

export interface StudioHealth {
  ok: boolean;
  url: string;
  service?: string;
  tools?: number;
  uptimeSec?: number;
  error?: string;
}

type FetchLike = typeof fetch;

/** Thin HTTP client for the studio server. Every studio_* tool maps to POST /api/tools/<name>. */
export class StudioClient {
  constructor(
    private readonly config: () => MonsoonStudioConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get url(): string {
    return this.config().studioUrl;
  }

  async health(): Promise<StudioHealth> {
    const url = this.url;
    try {
      const res = await this.fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
      const body = (await res.json()) as Omit<StudioHealth, "url">;
      return { ...body, ok: body.ok === true, url };
    } catch (error) {
      return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown studio tool: ${name}`);
    const { studioUrl, timeoutMs } = this.config();
    let res: Response;
    try {
      res = await this.fetchImpl(`${studioUrl}/api/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Monsoon studio server is not reachable at ${studioUrl} (${reason}). Start it with: systemctl --user start monsoon-studio`);
    }
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new Error(`${name} failed: ${message}`);
    }
    return body;
  }
}
