// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function neon(): Sql {
  throw new Error("not available in the open-source build");
}

export function neonConfigured(): boolean {
  return false;
}
