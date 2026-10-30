import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

const DEFAULT_SOCKET_NAME = "infinibot";

/**
 * Derive a stable tmux socket name from the active state directory.
 *
 * The historical default remains `infinibot`, so existing durable sessions
 * under ~/.infinibot stay visible after upgrading. Custom state directories
 * get isolated sockets and cannot see or kill another installation's panes.
 */
export function resolveTmuxSocketName(
  stateDir: string = resolveStateDir(),
  homedir: () => string = os.homedir,
): string {
  const resolvedStateDir = path.resolve(stateDir);
  const defaultStateDir = path.resolve(homedir(), ".infinibot");
  if (resolvedStateDir === defaultStateDir) return DEFAULT_SOCKET_NAME;

  const suffix = createHash("sha256").update(resolvedStateDir).digest("hex").slice(0, 12);
  return `${DEFAULT_SOCKET_NAME}-${suffix}`;
}
