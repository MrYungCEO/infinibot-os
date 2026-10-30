import net from "node:net";

/**
 * Hosts a workspace dev server may end up listening on. Probing only
 * 127.0.0.1 is not enough: many dev servers (Metro/Expo, webpack-dev-server,
 * Vite with --host) bind the wildcard address, and a port held on a specific
 * interface (e.g. `tailscale serve` on 100.x.y.z:8081) only conflicts with a
 * wildcard bind, never with a loopback bind.
 */
export const DEFAULT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

/** Error codes that mean "this port cannot be used". */
const BUSY_CODES = new Set(["EADDRINUSE", "EACCES"]);

/**
 * Bind-test a single host:port. Resolves `true` when the bind succeeded,
 * `false` when the port is busy on that host, and `null` when the host is not
 * applicable here (e.g. IPv6 disabled) and should be ignored.
 */
export function probeBind(port: number, host: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(BUSY_CODES.has(err.code ?? "") ? false : null);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * A port is free only if EVERY applicable host probe succeeds. Probes run
 * sequentially so they don't collide with each other (a wildcard bind would
 * otherwise conflict with our own concurrent loopback probe).
 */
export async function isPortFree(
  port: number,
  hosts: readonly string[] = DEFAULT_PROBE_HOSTS,
): Promise<boolean> {
  for (const host of hosts) {
    const result = await probeBind(port, host);
    if (result === false) return false;
  }
  return true;
}

export type FindFreePortOptions = {
  /** Ports that must not be returned (other runtimes, previously failed ports). */
  exclude?: Iterable<number>;
  hosts?: readonly string[];
  /** How many consecutive ports to try (bounded walk). */
  maxTries?: number;
  isFree?: (port: number) => Promise<boolean>;
};

/**
 * Pick a free port starting at `preferred` (the framework default) and
 * walking upward. The preferred port is never assumed free.
 */
export async function findFreePort(
  preferred: number,
  opts: FindFreePortOptions = {},
): Promise<number> {
  const exclude = new Set(opts.exclude ?? []);
  const maxTries = opts.maxTries ?? 200;
  const isFree = opts.isFree ?? ((port: number) => isPortFree(port, opts.hosts));
  const start = Math.max(1024, Math.floor(preferred) || 3000);
  for (let port = start; port < start + maxTries && port <= 65535; port++) {
    if (exclude.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `No free port found for workspace preview in ${start}-${Math.min(65535, start + maxTries - 1)}`,
  );
}

const PORT_CONFLICT_PATTERNS: RegExp[] = [
  /Port\s+(\d+)\s+is being used by another process/i, // Expo / Metro
  /Port\s+(\d+)\s+is (?:already )?in use/i, // Vite, Next, Nuxt, Astro
  /Something is already running on port\s+(\d+)/i, // create-react-app
  /EADDRINUSE[^\n]*?:(\d+)\b/i, // Node listen errors: "EADDRINUSE: address already in use :::3000"
  /address already in use[^\n]*?:(\d+)\b/i,
  /\bEADDRINUSE\b/i,
  /address already in use/i,
];

/**
 * Detect a "port is taken" failure in dev-server output. Returns the port the
 * message names when it names one, `0` for a generic conflict, or `null`.
 */
export function detectPortConflict(text: string): number | null {
  for (const pattern of PORT_CONFLICT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1] ? Number(match[1]) : 0;
  }
  return null;
}
