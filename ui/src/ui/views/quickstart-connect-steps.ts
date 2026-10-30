/**
 * Setup › Quick Start: the "Connect your browser" and "Connect your AI apps"
 * steps (same components as onboarding). Skip collapses a step to a one-line
 * row that can be reopened, so Quick Start never dead-ends.
 */
import { html, type TemplateResult } from "lit";
import "../components/browser-connect-setup.js";
import "../components/mcp-clients-setup.js";
import type { GatewayBrowserClient } from "../gateway";
import { isCloudBuild } from "../cloud/cloud-env";

const SKIP_KEY = "ib.quickstart.connect.skipped";

function skipped(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function setSkipped(id: string, on: boolean, onUpdate: () => void): void {
  const s = skipped();
  if (on) s.add(id);
  else s.delete(id);
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify([...s]));
  } catch {
    /* private mode */
  }
  onUpdate();
}

function step(
  id: string,
  n: number,
  title: string,
  sub: string,
  body: TemplateResult,
  onUpdate: () => void,
): TemplateResult {
  const isSkipped = skipped().has(id);
  return html`<section class="qs-connect__step" data-testid=${`qs-${id}`}>
    <header class="qs-connect__head">
      <span class="qs-connect__n">${n}</span>
      <div>
        <h2>${title}</h2>
        <p>${sub}</p>
      </div>
      ${isSkipped
        ? html`<button type="button" class="qs-connect__reopen" @click=${() => setSkipped(id, false, onUpdate)}>
            Skipped · Set up now
          </button>`
        : ""}
    </header>
    ${isSkipped ? "" : body}
  </section>`;
}

export function renderQuickstartConnectSteps(
  client: GatewayBrowserClient | null | undefined,
  onUpdate: () => void,
): TemplateResult {
  const cloud = isCloudBuild();
  const context = cloud ? "cloud" : "settings";
  return html`
    <style>
      .qs-connect {
        display: grid;
        gap: 22px;
        margin-top: 28px;
      }
      .qs-connect__step {
        border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
        border-radius: 18px;
        padding: 20px;
        background: rgba(10, 10, 12, 0.45);
        min-width: 0;
      }
      .qs-connect__head {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        margin-bottom: 14px;
      }
      .qs-connect__head > div {
        flex: 1;
        min-width: 0;
      }
      .qs-connect__head h2 {
        margin: 0 0 4px;
        font-size: 18px;
      }
      .qs-connect__head p {
        margin: 0;
        color: var(--c-text-2, #a8a8a8);
        font-size: 13.5px;
        line-height: 1.5;
      }
      .qs-connect__n {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        flex: none;
        background: color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
        color: var(--g-primary, #d4af37);
        font-weight: 700;
      }
      .qs-connect__reopen {
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: transparent;
        color: inherit;
        border-radius: 10px;
        min-height: 40px;
        padding: 0 12px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }
      @media (max-width: 720px) {
        .qs-connect__step {
          padding: 14px;
        }
        .qs-connect__head {
          flex-wrap: wrap;
        }
      }
    </style>
    <div class="qs-connect" data-testid="qs-connect">
      ${step(
        "browser",
        1,
        "Connect your browser",
        cloud
          ? "Your cloud assistant has its own browser. Connect your own Chrome through a computer you use."
          : "Let InfiniBot work in your own Chrome, with your logins. About a minute.",
        html`<ib-browser-connect-setup
          .client=${client ?? null}
          context=${context}
          @browser-skip=${() => setSkipped("browser", true, onUpdate)}
        ></ib-browser-connect-setup>`,
        onUpdate,
      )}
      ${step(
        "aiapps",
        2,
        "Connect your AI apps (MCP)",
        "Add InfiniBot to Claude Code, Claude Desktop, Cursor, Codex or VS Code in one click.",
        html`<ib-mcp-clients-setup
          .client=${client ?? null}
          context=${context}
          @mcp-skip=${() => setSkipped("aiapps", true, onUpdate)}
        ></ib-mcp-clients-setup>`,
        onUpdate,
      )}
    </div>
  `;
}
