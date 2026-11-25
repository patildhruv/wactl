// Live end-to-end: prove /compact preserves memory THROUGH context.md across a
// session rotation. No wactl MCP needed (dryRun + checkMessages:false → no tools
// beyond Read/Edit). Costs a few small claude turns.
const os = require("os"), fs = require("fs"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-cl-"));
process.env.DATA_DIR = tmp;
process.env.MCP_API_KEY = "unused";
// use default ~/.claude config so real transcripts land where the store looks
const S = require("/home/wactl/server/dist/schedules/store.js");
const R = require("/home/wactl/server/dist/schedules/runner.js");

function ctx(slug) { return S.getContext(slug); }

const sched = S.createSchedule(
  { to: "1", goal: "remember facts the user tells me", checkMessages: false, dryRun: true },
  { identity: "1", jid: "1@s.whatsapp.net" }
);
const slug = sched.slug;
console.log("schedule:", slug, "| session:", sched.sessionId);

// RUN 1 (telegram event = trusted operator input): tell it a durable fact.
console.log("\n[run 1] telegram: planting a durable fact into the session...");
const payloadFile = path.join(tmp, "p1.txt");
fs.writeFileSync(payloadFile, "Important: the landlord's name is Mr. Fernsby and he prefers messages after 6pm. Acknowledge and remember this.");
const r1 = R.runOnce(tmp, slug, "telegram", fs.readFileSync(payloadFile, "utf-8"));
console.log("  run1 ok, tokens:", r1.inputTokens);
const sidBefore = S.getSchedule(slug).sessionId;

// COMPACT: final turn should fold the fact into context.md, then rotate session.
console.log("\n[compact] running final memory-flush turn + rotating session...");
const c = R.compact(tmp, slug, "compact");
console.log("  compactionRan:", c.compactionRan, "| new session:", c.newSessionId, "| archived:", !!c.archivedTo);
const sidAfter = S.getSchedule(slug).sessionId;

const contextAfter = ctx(slug);
const inContext = /Fernsby/i.test(contextAfter);
console.log("  context.md now mentions the fact (Fernsby):", inContext);

// RUN 2 on the NEW empty session: it can only know the fact via context.md.
console.log("\n[run 2] fresh session — asking it to recall the fact (memory must come from context.md)...");
fs.writeFileSync(payloadFile, "What is the landlord's name and when does he prefer messages? Answer from your memory.");
const r2 = R.runOnce(tmp, slug, "telegram", fs.readFileSync(payloadFile, "utf-8"));
// the answer goes to log.md (dryRun) or is the result text
const recalled = /Fernsby/i.test(r2.result || "") || /Fernsby/i.test(S.getLogTail(slug));

console.log("\n--- RESULTS ---");
console.log("session id changed on compact:", sidBefore !== sidAfter, `(${sidBefore.slice(0,8)} → ${sidAfter.slice(0,8)})`);
console.log("fact folded into context.md:", inContext);
console.log("fresh session recalled the fact (via context.md only):", recalled);
const win = sidBefore !== sidAfter && inContext && recalled;
console.log(win ? "\n✅ COMPACTION PROVEN — memory survived a session rotation through context.md" : "\n❌ not proven");
console.log("\ncontext.md excerpt:\n" + contextAfter.split("\n").filter(l => /Fernsby|Pending|History|Standing/i.test(l)).join("\n"));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(win ? 0 : 1);
