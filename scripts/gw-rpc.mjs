import { callGateway } from "../dist/gateway/call.js";
const method = process.argv[2]; const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
try { console.log(JSON.stringify(await callGateway({ method, params, timeoutMs: 10000 }), null, 2)); }
catch (e) { console.error("ERR:", e.message); process.exit(1); }
