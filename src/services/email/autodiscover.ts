/**
 * Best-effort email provider autodiscovery — used by the "Add Account"
 * wizard to prefill SMTP/IMAP hostnames before the user has to type
 * them. Two probes, fastest-wins:
 *
 *   1. Thunderbird/Mozilla autoconfig XML
 *      https://autoconfig.thunderbird.net/v1.1/<domain>
 *   2. RFC 6186 DNS SRV records (`_imaps._tcp` + `_submission._tcp`).
 *
 * Results are cached in-memory for 24h keyed by `<domain>` (the local
 * part is irrelevant to discovery and we don't want to log addresses
 * we don't have to). The cache is intentionally per-process — these
 * results don't justify another SQLite table.
 *
 * NEVER throws; on total failure returns `{ ok: false }` so the UI can
 * fall through to a manual config form.
 */
import { resolveSrv } from "node:dns/promises";

interface DiscoverySuggestion {
  outbound?: {
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
  };
  inbound?: {
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
  };
  /** Where the data came from — useful for surfacing in the UI. */
  source: "thunderbird-autoconfig" | "dns-srv" | "mixed" | "none";
}

const CACHE = new Map<string, { at: number; value: DiscoverySuggestion }>();
const TTL_MS = 24 * 60 * 60 * 1000;

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  return (
    address
      .slice(at + 1)
      .trim()
      .toLowerCase() || null
  );
}

async function fetchAutoconfigXml(domain: string): Promise<DiscoverySuggestion | null> {
  const url = `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/xml" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return parseAutoconfigXml(xml);
  } catch {
    return null;
  }
}

function parseAutoconfigXml(xml: string): DiscoverySuggestion | null {
  // Very small extraction — full XML parse is overkill, the autoconfig
  // format is stable enough that targeted regexes work. We grab the
  // first <incomingServer type="imap"> and <outgoingServer type="smtp">
  // (which is what every reasonable consumer does anyway).
  const incoming = matchServer(xml, /<incomingServer\s+type="imap">([\s\S]*?)<\/incomingServer>/i);
  const outgoing = matchServer(xml, /<outgoingServer\s+type="smtp">([\s\S]*?)<\/outgoingServer>/i);
  if (!incoming && !outgoing) return null;
  return {
    inbound: incoming
      ? {
          imapHost: incoming.host,
          imapPort: incoming.port ?? 993,
          imapSecure: incoming.socketType === "SSL" || incoming.port === 993,
        }
      : undefined,
    outbound: outgoing
      ? {
          smtpHost: outgoing.host,
          smtpPort: outgoing.port ?? 587,
          smtpSecure: outgoing.socketType === "SSL" || outgoing.port === 465,
        }
      : undefined,
    source: "thunderbird-autoconfig",
  };
}

function matchServer(
  xml: string,
  pattern: RegExp,
): { host: string; port?: number; socketType?: string } | null {
  const block = xml.match(pattern)?.[1];
  if (!block) return null;
  const host = block.match(/<hostname>([^<]+)<\/hostname>/i)?.[1]?.trim();
  if (!host) return null;
  const portRaw = block.match(/<port>(\d+)<\/port>/i)?.[1];
  const socketType = block.match(/<socketType>([^<]+)<\/socketType>/i)?.[1]?.trim();
  return {
    host,
    port: portRaw ? Number.parseInt(portRaw, 10) : undefined,
    socketType,
  };
}

async function probeSrv(domain: string): Promise<DiscoverySuggestion | null> {
  const out: DiscoverySuggestion = { source: "dns-srv" };
  try {
    const imaps = await resolveSrv(`_imaps._tcp.${domain}`).catch(() => []);
    if (imaps.length > 0) {
      const best = imaps.sort((a, b) => a.priority - b.priority)[0]!;
      out.inbound = {
        imapHost: best.name.replace(/\.$/, ""),
        imapPort: best.port,
        imapSecure: best.port === 993,
      };
    }
  } catch {
    /* no inbound SRV */
  }
  try {
    const submission = await resolveSrv(`_submission._tcp.${domain}`).catch(() => []);
    if (submission.length > 0) {
      const best = submission.sort((a, b) => a.priority - b.priority)[0]!;
      out.outbound = {
        smtpHost: best.name.replace(/\.$/, ""),
        smtpPort: best.port,
        smtpSecure: best.port === 465,
      };
    }
  } catch {
    /* no outbound SRV */
  }
  if (!out.inbound && !out.outbound) return null;
  return out;
}

export async function discoverEmailProvider(
  address: string,
): Promise<{ ok: true; suggestion: DiscoverySuggestion } | { ok: false; error: string }> {
  const domain = domainOf(address);
  if (!domain) return { ok: false, error: "no domain in address" };
  const cached = CACHE.get(domain);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ok: true, suggestion: cached.value };
  }
  const [xmlResult, srvResult] = await Promise.all([fetchAutoconfigXml(domain), probeSrv(domain)]);

  const merged: DiscoverySuggestion = {
    outbound: xmlResult?.outbound ?? srvResult?.outbound,
    inbound: xmlResult?.inbound ?? srvResult?.inbound,
    source:
      xmlResult && srvResult
        ? "mixed"
        : xmlResult
          ? "thunderbird-autoconfig"
          : srvResult
            ? "dns-srv"
            : "none",
  };
  if (!merged.inbound && !merged.outbound) {
    return { ok: false, error: `no autoconfig record found for ${domain}` };
  }
  CACHE.set(domain, { at: Date.now(), value: merged });
  return { ok: true, suggestion: merged };
}
