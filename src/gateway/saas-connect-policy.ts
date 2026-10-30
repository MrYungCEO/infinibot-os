/**
 * SaaS mode: who may hold an operator WebSocket without a Clerk session.
 *
 * Browser/operator connections must authenticate via Clerk — loopback trust,
 * device pairing, invite tokens, Tailscale and a shared token/password arriving
 * through a proxy must not grant tenant access on their own. Two exemptions:
 * backend nodes (role "node"), and the gateway's own loopback clients (MCP
 * stdio server, callGateway from workflows and sub-agents, ACP), which present
 * the machine's shared token from loopback with no forwarded headers. The fleet
 * edge always adds X-Forwarded-For, so nothing from the internet is local-direct.
 */
export function saasConnectAllowedWithoutClerk(params: {
  role: string;
  authMethod: string | undefined;
  authOk: boolean;
  isLocalDirect: boolean;
}): boolean {
  if (!params.authOk) return false;
  if (params.authMethod === "clerk") return true;
  if (params.role === "node") return true;
  return (
    params.isLocalDirect && (params.authMethod === "token" || params.authMethod === "password")
  );
}
