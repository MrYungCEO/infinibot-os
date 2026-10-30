/**
 * Local mock of the marketplace registry (docs/plugins/registry-api.md).
 *
 * For tests and local development only: it serves exactly the contract the
 * real registry implements, from package zips held in memory. Run it from
 * the command line with `scripts/plugins-mock-registry.ts`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { PACKAGE_MANIFEST } from "./format.js";
import type { RegistryEntry, RegistryVersion } from "./registry-client.js";
import { compareSemver } from "./semver.js";
import { openPluginZip } from "./zip-read.js";

export type MockRelease = {
  zip: Buffer;
  releasedAt?: string;
  changelog?: string;
  /** Publish a wrong checksum (to test verification). */
  sha256Override?: string;
};

export type MockPlugin = {
  releases: MockRelease[];
  firstParty?: boolean;
  verified?: boolean;
  publisherName?: string;
  category?: string;
  tags?: string[];
  pricing?: {
    model: "free" | "paid";
    priceCents?: number;
    currency?: string;
    purchaseUrl?: string | null;
    includedPlans?: string[];
  };
  /** Entitlement tokens that unlock a paid plugin's download (the real registry signs them). */
  tokens?: string[];
  /** The publisher sells and delivers it: listed with no download (paid third-party plugins). */
  external?: boolean;
  homepageUrl?: string | null;
  listing?: {
    cover?: string | null;
    icon?: string | null;
    /** Bare URLs or `{src, caption}` objects — the client accepts both. */
    screenshots?: Array<string | { src: string; caption?: string }>;
    tagline?: string;
  };
  featured?: boolean;
  affiliate?: { enabled: boolean };
  /** The listing's permission summary (detail page only, as the real registry sends it). */
  permissions?: Record<string, unknown>;
};

type Loaded = {
  id: string;
  name: string;
  description: string;
  publisher: string;
  meta: MockPlugin;
  versions: (RegistryVersion & { zip: Buffer })[];
};

export type MockRegistry = {
  url: string;
  /** Requests seen, e.g. "GET /api/marketplace/index.json". */
  requests: string[];
  close: () => Promise<void>;
};

async function loadPlugin(meta: MockPlugin): Promise<Loaded> {
  const versions: Loaded["versions"] = [];
  let head: { id: string; name: string; description: string; publisher: string } | undefined;
  for (const release of meta.releases) {
    const zip = await openPluginZip(release.zip);
    const manifest = JSON.parse((await zip.read(PACKAGE_MANIFEST)).toString("utf-8")) as {
      id: string;
      name: string;
      version: string;
      publisher: string;
      description?: string;
      minHostVersion?: string;
    };
    versions.push({
      version: manifest.version,
      releasedAt: release.releasedAt ?? "2026-10-01T00:00:00.000Z",
      sha256: release.sha256Override ?? zip.sha256,
      sizeBytes: zip.zipBytes,
      minHostVersion: manifest.minHostVersion ?? "0.0.0",
      changelog: release.changelog ?? "",
      zip: release.zip,
    });
    head = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? "",
      publisher: manifest.publisher,
    };
  }
  if (!head) throw new Error("mock plugin needs at least one release");
  versions.sort((a, b) => compareSemver(b.version, a.version));
  return { ...head, meta, versions };
}

/** The entry as it goes over the wire (optional fields only when set, like the cloud registry). */
type WireEntry = Omit<RegistryEntry, "listing" | "featured" | "pricing"> & {
  pricing: Omit<RegistryEntry["pricing"], "includedPlans"> & { includedPlans?: string[] };
  listing: {
    cover: string | null;
    icon: string | null;
    screenshots: Array<string | { src: string; caption?: string }>;
    tagline?: string;
  };
  featured?: boolean;
};

function entryOf(p: Loaded, base: string): WireEntry {
  const latest = p.versions[0]!;
  const pricing = p.meta.pricing ?? { model: "free" as const };
  return {
    id: p.id,
    name: p.name,
    version: latest.version,
    publisher: {
      id: p.publisher,
      name: p.meta.publisherName ?? p.publisher,
      verified: p.meta.verified ?? Boolean(p.meta.firstParty),
    },
    firstParty: p.meta.firstParty ?? false,
    description: p.description,
    category: p.meta.category ?? "apps",
    tags: p.meta.tags ?? [],
    pricing: {
      model: pricing.model,
      priceCents: pricing.priceCents ?? 0,
      currency: pricing.currency ?? "USD",
      purchaseUrl: pricing.purchaseUrl ?? null,
      ...(pricing.includedPlans?.length ? { includedPlans: pricing.includedPlans } : {}),
    },
    downloadUrl: p.meta.external
      ? null
      : `${base}/api/marketplace/plugins/${p.id}/download?version=latest`,
    sha256: p.meta.external ? "" : latest.sha256,
    sizeBytes: p.meta.external ? 0 : latest.sizeBytes,
    distribution: p.meta.external ? "external" : "hosted",
    minHostVersion: latest.minHostVersion,
    homepageUrl: p.meta.homepageUrl ?? null,
    listing: {
      cover: p.meta.listing?.cover ?? null,
      icon: p.meta.listing?.icon ?? null,
      screenshots: p.meta.listing?.screenshots ?? [],
      ...(p.meta.listing?.tagline ? { tagline: p.meta.listing.tagline } : {}),
    },
    ...(p.meta.affiliate ? { affiliate: p.meta.affiliate } : {}),
    ...(p.meta.featured ? { featured: true } : {}),
  };
}

export async function startMockRegistry(
  plugins: MockPlugin[],
  opts: { port?: number; host?: string } = {},
): Promise<MockRegistry> {
  const loaded = new Map<string, Loaded>();
  for (const meta of plugins) {
    const p = await loadPlugin(meta);
    loaded.set(p.id, p);
  }
  const requests: string[] = [];
  let base = "";

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
    res.end(data);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base || "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

    if (url.pathname === "/api/marketplace/index.json") {
      return json(res, 200, {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        plugins: [...loaded.values()].map((p) => entryOf(p, base)),
      });
    }

    const file = /^\/files\/([a-z0-9-]+)\/([^/]+)\.zip$/.exec(url.pathname);
    if (file) {
      const p = loaded.get(file[1]!);
      const v = p?.versions.find((x) => x.version === decodeURIComponent(file[2]!));
      if (!p || !v) return json(res, 404, { error: "not_found" });
      res.writeHead(200, { "content-type": "application/zip", "content-length": v.zip.length });
      return void res.end(v.zip);
    }

    const m = /^\/api\/marketplace\/plugins\/([^/]+)(\/download)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "not_found" });
    const p = loaded.get(decodeURIComponent(m[1]!));
    if (!p) return json(res, 404, { error: "not_found" });

    if (!m[2]) {
      return json(res, 200, {
        ...entryOf(p, base),
        ...(p.meta.permissions ? { permissions: p.meta.permissions } : {}),
        versions: p.versions.map(({ zip: _zip, ...v }) => v),
      });
    }

    const wanted = url.searchParams.get("version") ?? "latest";
    const version =
      wanted === "latest" ? p.versions[0] : p.versions.find((v) => v.version === wanted);
    if (!version) return json(res, 404, { error: "not_found" });
    if (p.meta.external) {
      return json(res, 404, {
        error: "external_distribution",
        purchaseUrl: p.meta.pricing?.purchaseUrl ?? null,
      });
    }
    if ((p.meta.pricing?.model ?? "free") === "paid") {
      const token = url.searchParams.get("token") ?? "";
      if (!token || !(p.meta.tokens ?? []).includes(token)) {
        return json(res, 402, {
          error: "payment_required",
          purchaseUrl: p.meta.pricing?.purchaseUrl ?? null,
        });
      }
    }
    // The contract allows a redirect or the bytes; redirect, as the real one does.
    res.writeHead(302, {
      location: `${base}/files/${p.id}/${encodeURIComponent(version.version)}.zip`,
    });
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  return {
    url: base,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
