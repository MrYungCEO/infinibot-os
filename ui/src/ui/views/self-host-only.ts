/**
 * Full-page "self-hosted only" state for surfaces that need host execution
 * (Workspace dev servers / live preview) and therefore don't run on
 * InfiniBot Cloud until the tenant exec sandbox exists.
 */
import { html, type TemplateResult } from "lit";

export function renderSelfHostOnly(opts: {
  title: string;
  lead: string;
  points: readonly string[];
  docsHref?: string;
}): TemplateResult {
  return html`
    <style>
      .sho {
        display: grid;
        place-items: center;
        min-height: 60vh;
        padding: 32px 16px;
        box-sizing: border-box;
      }
      .sho__card {
        width: min(560px, 100%);
        box-sizing: border-box;
        padding: 28px;
        border-radius: var(--radius-xl, 6px);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
        background: var(--card, #0f0f0f);
        color: var(--card-foreground, #e4e4e7);
      }
      .sho__chip {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.02em;
        color: var(--accent, #d4af37);
        border: 1px solid color-mix(in srgb, var(--accent, #d4af37) 45%, transparent);
      }
      .sho__card h2 {
        margin: 14px 0 8px;
        font-size: 22px;
      }
      .sho__card p,
      .sho__card li {
        color: var(--muted-foreground, #a1a1aa);
        line-height: 1.55;
      }
      .sho__card ul {
        margin: 12px 0 0;
        padding-left: 18px;
      }
      .sho__card a {
        color: var(--accent, #d4af37);
      }
    </style>
    <section class="sho" data-testid="self-host-only">
      <div class="sho__card" role="status">
        <span class="sho__chip">Self-hosted only</span>
        <h2>${opts.title}</h2>
        <p>${opts.lead}</p>
        <ul>
          ${opts.points.map((p) => html`<li>${p}</li>`)}
        </ul>
        ${opts.docsHref
          ? html`<p><a href=${opts.docsHref} target="_blank" rel="noopener">Run InfiniBot yourself</a></p>`
          : ""}
      </div>
    </section>
  `;
}
