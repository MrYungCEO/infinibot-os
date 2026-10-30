/**
 * Run the mock Robovoice server standalone (side-gateway verification):
 *   node --import tsx extensions/robovoice/test/mock-robovoice-cli.ts [port] [edgeToken]
 * Env: MOCK_WALLET_CREDITS=<n> (0 = wallet empty), MOCK_CALL_SCRIPT=<waitPolls>,<livePolls>,
 *      MOCK_APPROVE_AFTER_POLLS=<n> (device-code approval delay; default 1),
 *      MOCK_PUBLIC_ROSTER=owner (public /api/call/characters answers a deployment-owner
 *      roster — Magnus, RoboPanda — that is NOT the linked org's, like a real Robovoice).
 * POST /__mock/wallet {"credits":n} changes the wallet at runtime.
 */
import { startMockRobovoice } from "./mock-robovoice-server.js";

const port = Number(process.argv[2] ?? 0);
const edgeToken = process.argv[3] || undefined;
const wallet = process.env.MOCK_WALLET_CREDITS;
const script = process.env.MOCK_CALL_SCRIPT?.split(",").map(Number);
const mock = await startMockRobovoice(
  {
    edgeToken,
    ...(process.env.MOCK_APPROVE_AFTER_POLLS ? { approveAfterPolls: Number(process.env.MOCK_APPROVE_AFTER_POLLS) } : {}),
    ...(wallet !== undefined && wallet !== "" ? { walletCredits: Number(wallet) } : {}),
    ...(process.env.MOCK_PUBLIC_ROSTER === "owner"
      ? { publicCharacters: [{ id: "magnus", name: "Magnus", description: "Star Guardians leader (deployment owner)" }, { id: "robopanda", name: "RoboPanda" }] }
      : {}),
    ...(script?.length === 2 && script.every(Number.isFinite) ? { callScript: [script[0], script[1]] as [number, number] } : {}),
  },
  port,
);
console.log(`mock robovoice listening on ${mock.url}${edgeToken ? " (edge token required)" : ""}`);
setInterval(() => {
  const last = mock.requests.at(-1);
  if (last) console.log(`[mock] ${mock.requests.length} requests; last ${last.method} ${last.path}`);
}, 10_000).unref();
process.on("SIGTERM", () => void mock.close().then(() => process.exit(0)));
