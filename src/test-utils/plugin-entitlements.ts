/**
 * Tests: grant KinglyVault plugin entitlements on a throwaway key, so tests
 * that turn on a paid first-party plugin (flypic, omniclinic, …) can load it.
 * Writes into the current INFINIBOT_STATE_DIR; call the returned cleanup.
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import {
  __setEntitlementPublicKeyForTests,
  entitlementFilePath,
  writeEntitlementFile,
} from "../plugins/entitlements/store.js";

export function grantTestPluginEntitlements(pluginIds: string[] | "*"): () => void {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  __setEntitlementPublicKeyForTests(publicKey.export({ type: "spki", format: "pem" }).toString());
  const now = Math.floor(Date.now() / 1000);
  const ids = pluginIds === "*" ? ["*"] : pluginIds;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: "kinglyvault",
    aud: "infinibot-plugins",
    sub: "user_test",
    iat: now,
    exp: now + 86400,
    ent: ids.map((p) => ({ p, src: p === "*" ? "plan:ceo" : "purchase", until: null })),
  })}`;
  const s = createSign("RSA-SHA256");
  s.update(head);
  writeEntitlementFile({
    version: 1,
    token: `${head}.${s.sign(privateKey).toString("base64url")}`,
  });
  return () => {
    fs.rmSync(entitlementFilePath(), { force: true });
    __setEntitlementPublicKeyForTests(null);
  };
}
