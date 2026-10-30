/**
 * Content page insights + connections graph.
 *
 * Deterministic, rule-based insights (no LLM calls). They look at the page's
 * four child databases + the cached stats and produce ranked, actionable
 * findings. The graph builds a node/edge structure mapping the page to
 * connected campaigns / products / funnels / leads.
 */

import { getDatabasesStore } from "../databases/store.js";
import type { DatabaseProperty, DatabaseRow, PropertyValue } from "../databases/types.js";
import { getContentPagesStore } from "./pages-store.js";
import { getInstagramPageStats, type InstagramPageStats } from "./pages-instagram-stats.js";
import type { ConnectionEdge, ConnectionNode, ConnectionsGraph, PageInsight } from "./types.js";

function findPropId(properties: DatabaseProperty[], name: string): string | null {
  return properties.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

function readStatus(row: DatabaseRow, statusPropId: string | null): string | null {
  if (!statusPropId) return null;
  const v: PropertyValue | undefined = row.values[statusPropId];
  if (!v) return null;
  if (v.type === "status" || v.type === "select") return v.optionId ?? null;
  return null;
}

function readNumber(row: DatabaseRow, propId: string | null): number | null {
  if (!propId) return null;
  const v = row.values[propId];
  if (!v) return null;
  if (v.type === "number") return v.value ?? null;
  return null;
}

function readDate(row: DatabaseRow, propId: string | null): number | null {
  if (!propId) return null;
  const v = row.values[propId];
  if (!v) return null;
  if (v.type === "date" && v.iso) {
    const ms = Date.parse(v.iso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getInsights(stateDir: string, pageId: string): PageInsight[] {
  const pages = getContentPagesStore(stateDir);
  const page = pages.get(pageId);
  if (!page) return [];
  const databases = getDatabasesStore(stateDir);
  const out: PageInsight[] = [];

  // ─── PRODUCTION: stale drafts in Scripts ─────────────────────
  if (page.databaseIds.scripts) {
    const props = databases.listProperties(page.databaseIds.scripts);
    const statusId = findPropId(props, "Status");
    const rows = databases.listRows(page.databaseIds.scripts);
    const now = Date.now();
    const staleDrafts = rows.filter(
      (r) => readStatus(r, statusId) === "draft" && now - r.updatedAt > 14 * DAY_MS,
    );
    if (staleDrafts.length > 0) {
      out.push({
        id: "scripts-stale-drafts",
        category: "production",
        severity: staleDrafts.length >= 7 ? "warning" : "info",
        title: `${staleDrafts.length} script${staleDrafts.length === 1 ? "" : "s"} sitting in draft >14 days`,
        detail:
          "Old drafts decay — schedule a focused writing block to push them to ready or shelve them so the backlog tells the truth.",
        impact: Math.min(40 + staleDrafts.length * 4, 90),
        action: { label: "Open Scripts", intent: "view:scripts" },
        metric: { label: "Stale drafts", value: String(staleDrafts.length) },
      });
    }
    const ready = rows.filter((r) => readStatus(r, statusId) === "ready").length;
    if (ready === 0 && rows.length > 0) {
      out.push({
        id: "scripts-empty-ready",
        category: "production",
        severity: "warning",
        title: "No scripts in 'ready' state",
        detail:
          "Nothing is queued to film — promote your strongest draft so the production loop keeps moving.",
        impact: 70,
        action: { label: "Review drafts", intent: "view:scripts" },
      });
    } else if (ready >= 5) {
      out.push({
        id: "scripts-deep-queue",
        category: "production",
        severity: "win",
        title: `${ready} scripts ready to film`,
        detail: "Healthy queue. Block a half-day to shoot two or three back-to-back.",
        impact: 35,
        metric: { label: "Ready", value: String(ready) },
      });
    }
  }

  // ─── IDEATION: ideas → script conversion rate ────────────────
  if (page.databaseIds.ideas) {
    const props = databases.listProperties(page.databaseIds.ideas);
    const promotedAtId = findPropId(props, "Converted At");
    const rows = databases.listRows(page.databaseIds.ideas);
    const total = rows.length;
    if (total >= 5) {
      const promoted = rows.filter((r) => readNumber(r, promotedAtId) !== null).length;
      const rate = (promoted / total) * 100;
      if (rate < 15) {
        out.push({
          id: "ideas-low-conversion",
          category: "ideation",
          severity: "warning",
          title: `Idea→script conversion at ${rate.toFixed(0)}%`,
          detail:
            "Most ideas never become scripts. Re-prompt the agent for sharper hooks, or shelve dead ideas to stop diluting the queue.",
          impact: 65,
          action: { label: "Open Ideas", intent: "view:ideas" },
          metric: { label: "Conversion", value: `${rate.toFixed(0)}%` },
        });
      } else if (rate > 45) {
        out.push({
          id: "ideas-strong-conversion",
          category: "ideation",
          severity: "win",
          title: `Idea→script conversion at ${rate.toFixed(0)}%`,
          detail: "Ideation is dialed in — keep collecting raw notes at this pace.",
          impact: 30,
          metric: { label: "Conversion", value: `${rate.toFixed(0)}%` },
        });
      }
    } else if (total < 3) {
      out.push({
        id: "ideas-thin-pipeline",
        category: "ideation",
        severity: "info",
        title: "Ideas backlog is thin",
        detail:
          "Capture five fresh ideas this week — even bad ones surface patterns once you have volume.",
        impact: 50,
        action: { label: "Add idea", intent: "view:ideas" },
      });
    }
  }

  // ─── PERFORMANCE: engagement trend on Content ────────────────
  if (page.databaseIds.content) {
    const props = databases.listProperties(page.databaseIds.content);
    const publishedAtId = findPropId(props, "Published At");
    const engagementId = findPropId(props, "Engagement");
    const reachId = findPropId(props, "Reach");
    const rows = databases.listRows(page.databaseIds.content);
    const now = Date.now();
    const recent: number[] = [];
    const older: number[] = [];
    let recentReach = 0;
    let totalReach = 0;
    for (const r of rows) {
      const published = readDate(r, publishedAtId);
      const eng = readNumber(r, engagementId);
      const reach = readNumber(r, reachId);
      if (published === null) continue;
      const ageMs = now - published;
      if (eng !== null) {
        if (ageMs < 30 * DAY_MS) recent.push(eng);
        else if (ageMs < 60 * DAY_MS) older.push(eng);
      }
      if (reach !== null) {
        totalReach += reach;
        if (ageMs < 30 * DAY_MS) recentReach += reach;
      }
    }
    if (recent.length >= 3 && older.length >= 3) {
      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const recentAvg = avg(recent);
      const olderAvg = avg(older);
      if (olderAvg > 0) {
        const delta = ((recentAvg - olderAvg) / olderAvg) * 100;
        if (delta > 20) {
          out.push({
            id: "engagement-up",
            category: "performance",
            severity: "win",
            title: `Engagement up ${delta.toFixed(0)}% over 30 days`,
            detail:
              "Whatever you changed is working — double the publish cadence in the same lane.",
            impact: 90,
            action: { label: "See top posts", intent: "view:analytics" },
            metric: { label: "Δ engagement", value: `+${delta.toFixed(0)}%` },
          });
        } else if (delta < -20) {
          out.push({
            id: "engagement-down",
            category: "performance",
            severity: "critical",
            title: `Engagement down ${Math.abs(delta).toFixed(0)}% over 30 days`,
            detail:
              "Audit the last 10 posts for format/topic drift. Revert to the patterns that worked 30–60 days ago.",
            impact: 95,
            action: { label: "Open analytics", intent: "view:analytics" },
            metric: { label: "Δ engagement", value: `${delta.toFixed(0)}%` },
          });
        }
      }
    }
    if (totalReach > 0) {
      out.push({
        id: "reach-summary",
        category: "performance",
        severity: "info",
        title: `${recentReach.toLocaleString()} reach in last 30 days`,
        detail: `Cumulative reach across this page is ${totalReach.toLocaleString()}.`,
        impact: 25,
        metric: { label: "30d reach", value: recentReach.toLocaleString() },
      });
    }
  }

  // ─── CADENCE: posts/week against goal ────────────────────────
  const monthlyTarget = page.goals?.monthlyPostsTarget ?? 0;
  if (monthlyTarget > 0) {
    const ratio = page.stats.monthlyPosts / monthlyTarget;
    if (ratio < 0.5) {
      out.push({
        id: "cadence-behind",
        category: "cadence",
        severity: "warning",
        title: `Posting cadence at ${(ratio * 100).toFixed(0)}% of goal`,
        detail: `Goal is ${monthlyTarget} posts/month, posted ${page.stats.monthlyPosts}. Schedule a batch session to catch up.`,
        impact: 80,
        action: { label: "Open Content", intent: "view:content" },
        metric: { label: "Cadence", value: `${(ratio * 100).toFixed(0)}%` },
      });
    } else if (ratio >= 1) {
      out.push({
        id: "cadence-on-pace",
        category: "cadence",
        severity: "win",
        title: "Posting cadence on or above target",
        detail: "Don't drop the rhythm — this is the part that compounds.",
        impact: 35,
        metric: { label: "Cadence", value: `${(ratio * 100).toFixed(0)}%` },
      });
    }
  } else if (page.stats.totalPosts === 0) {
    out.push({
      id: "cadence-no-posts",
      category: "cadence",
      severity: "info",
      title: "No published content yet",
      detail:
        "Set a monthly posting goal and ship the first piece — even a draft you weren't sure about.",
      impact: 60,
      action: { label: "Set a goal", intent: "view:overview" },
    });
  }

  // ─── ATTRIBUTION: leads + linked campaigns ──────────────────
  if (page.stats.leadsAttributed > 0) {
    out.push({
      id: "attribution-leads",
      category: "attribution",
      severity: "win",
      title: `${page.stats.leadsAttributed} leads attributed to this page in 30d`,
      detail:
        "Trace the top-performing posts back to the campaigns they fed and lean into that mix.",
      impact: 70,
      action: { label: "Open Connections", intent: "view:connections" },
      metric: { label: "Leads", value: String(page.stats.leadsAttributed) },
    });
  }
  if (page.links.campaignIds.length === 0 && page.links.funnelIds.length === 0) {
    out.push({
      id: "attribution-unlinked",
      category: "attribution",
      severity: "info",
      title: "Page isn't linked to any campaign or funnel",
      detail:
        "Without a link, you can't measure what this page contributes downstream. Hook it into at least one campaign or funnel.",
      impact: 55,
      action: { label: "Manage connections", intent: "view:connections" },
    });
  }

  return out.sort((a, b) => b.impact - a.impact);
}

// ═══════════════════════════════════════════════════════════════════
// ASYNC INSIGHTS — wraps getInsights + live IG data
// ═══════════════════════════════════════════════════════════════════

export async function getInsightsAsync(
  stateDir: string,
  pageId: string,
): Promise<{ insights: PageInsight[]; igStats: InstagramPageStats | null }> {
  const pages = getContentPagesStore(stateDir);
  const page = pages.get(pageId);
  if (!page) return { insights: [], igStats: null };

  const insights = getInsights(stateDir, pageId);

  if (page.integrations?.instagramGraph?.connected !== true) {
    return { insights, igStats: null };
  }

  let igStats: InstagramPageStats | null = null;
  try {
    igStats = await getInstagramPageStats(page);
  } catch (e) {
    insights.push({
      id: "ig-fetch-error",
      category: "performance",
      severity: "warning",
      title: "Instagram data sync failed",
      detail: (e as Error).message,
      impact: 50,
    });
    return { insights: insights.sort((a, b) => b.impact - a.impact), igStats: null };
  }

  if (igStats?.error) {
    insights.push({
      id: "ig-sync-error",
      category: "performance",
      severity: "warning",
      title: "Instagram sync issue",
      detail: `${igStats.error.code}: ${igStats.error.message}`,
      impact: 50,
    });
  } else if (igStats) {
    if (igStats.reach30d > 0) {
      insights.push({
        id: "ig-reach-30d",
        category: "performance",
        severity: "info",
        title: `${igStats.reach30d.toLocaleString()} reach in the last 30 days (Instagram)`,
        detail: "Fetched live from the Instagram Graph API.",
        impact: 60,
        metric: { label: "30d reach", value: igStats.reach30d.toLocaleString() },
      });
    }
    if (igStats.topMedia.length > 0) {
      const top = igStats.topMedia[0];
      insights.push({
        id: "ig-top-post",
        category: "performance",
        severity: "win",
        title: `Top post reached ${top.reach.toLocaleString()} people`,
        detail: `${top.likes.toLocaleString()} likes · ${top.comments.toLocaleString()} comments · ${top.saves.toLocaleString()} saves`,
        impact: 70,
        metric: { label: "Reach", value: top.reach.toLocaleString() },
      });
    }
    if (igStats.followers > 0 && page.stats.lastPublishedAt) {
      const daysSincePost = Math.floor((Date.now() - page.stats.lastPublishedAt) / DAY_MS);
      if (daysSincePost > 14) {
        insights.push({
          id: "ig-posting-gap",
          category: "cadence",
          severity: "warning",
          title: `Posting gap — last published ${daysSincePost} days ago`,
          detail:
            "Instagram's algorithm deprioritises accounts that go quiet. Aim for at least one post per week.",
          impact: 75,
          metric: { label: "Days since post", value: String(daysSincePost) },
        });
      }
    }
  }

  return { insights: insights.sort((a, b) => b.impact - a.impact), igStats };
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTIONS GRAPH
// ═══════════════════════════════════════════════════════════════════

export function getConnectionsGraph(stateDir: string, pageId: string): ConnectionsGraph {
  const pages = getContentPagesStore(stateDir);
  const page = pages.get(pageId);
  if (!page) return { nodes: [], edges: [] };

  const nodes: ConnectionNode[] = [];
  const edges: ConnectionEdge[] = [];

  const pageNodeId = `page:${page.id}`;
  nodes.push({
    id: pageNodeId,
    kind: "page",
    label: page.name,
    sub: page.handle ?? page.surface,
    weight: Math.max(1, page.stats.totalPosts),
  });

  if (page.businessId) {
    const id = `business:${page.businessId}`;
    nodes.push({ id, kind: "business", label: "Business", sub: page.businessId, weight: 1 });
    edges.push({ from: id, to: pageNodeId, strength: 0.6, label: "owns" });
  }

  for (const campaignId of page.links.campaignIds) {
    const id = `campaign:${campaignId}`;
    nodes.push({ id, kind: "campaign", label: "Campaign", sub: campaignId, weight: 2 });
    edges.push({ from: pageNodeId, to: id, strength: 0.7, label: "feeds" });
  }
  for (const productId of page.links.productIds) {
    const id = `product:${productId}`;
    nodes.push({ id, kind: "product", label: "Product", sub: productId, weight: 1.5 });
    edges.push({ from: pageNodeId, to: id, strength: 0.5, label: "promotes" });
  }
  for (const funnelId of page.links.funnelIds) {
    const id = `funnel:${funnelId}`;
    nodes.push({ id, kind: "funnel", label: "Funnel", sub: funnelId, weight: 2 });
    edges.push({ from: pageNodeId, to: id, strength: 0.8, label: "drives" });
  }

  if (page.stats.leadsAttributed > 0) {
    const id = `lead:${page.id}-aggregate`;
    nodes.push({
      id,
      kind: "lead",
      label: "Leads attributed",
      sub: `${page.stats.leadsAttributed} in 30d`,
      weight: Math.min(5, Math.log2(page.stats.leadsAttributed + 1) + 1),
    });
    edges.push({
      from: pageNodeId,
      to: id,
      strength: 0.9,
      label: `${page.stats.leadsAttributed} leads`,
    });
  }

  return { nodes, edges };
}

// Re-export the page store helper so the gateway handler module has a
// single import surface for everything content-pages related.
export { getContentPagesStore } from "./pages-store.js";
export type { DatabasesStore } from "../databases/store.js";
