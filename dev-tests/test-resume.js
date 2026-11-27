// Proves session-resume-across-runs through the real runClaude() code path.
// Hermetic: empty mcp-config (no wactl server needed), no tools, dry.
const os = require("os"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { runClaude } = require("/home/wactl/server/dist/schedules/runner.js");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-smoke-"));
const mcpPath = path.join(cwd, "mcp.json");
fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
const sid = crypto.randomUUID();
const schedule = { sessionId: sid, model: "sonnet" };
const common = { schedule, mcpConfigPath: mcpPath, allowedTools: [], cwd };

console.log("session id:", sid);
console.log("run 1 (isNew → --session-id): planting codeword...");
const r1 = runClaude({ ...common, isNew: true, prompt: "Remember this codeword for later in our conversation: PLATYPUS-7. Reply with just 'ok'." });
console.log("  ok:", r1.ok, "| session:", r1.sessionId, "| result:", JSON.stringify(r1.result), r1.error ? "| err: " + r1.error : "");

console.log("run 2 (isNew=false → --resume): recalling...");
const r2 = runClaude({ ...common, isNew: false, prompt: "What codeword did I ask you to remember earlier? Reply with ONLY the codeword." });
console.log("  ok:", r2.ok, "| session:", r2.sessionId, "| result:", JSON.stringify(r2.result), r2.error ? "| err: " + r2.error : "");

const sameSession = r1.sessionId && r1.sessionId === r2.sessionId;
const recalled = r2.ok && /PLATYPUS-7/i.test(r2.result || "");
console.log("\nsame session id across runs:", sameSession);
console.log("run 2 recalled the codeword only stored in the session:", recalled);
console.log(recalled && sameSession ? "\n✅ RESUME PROVEN — the session carried memory across two separate runner invocations" : "\n❌ resume NOT proven");
fs.rmSync(cwd, { recursive: true, force: true });
