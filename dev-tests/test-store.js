const os = require("os");
const fs = require("fs");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-sched-"));
process.env.DATA_DIR = tmp;
process.env.SCHEDULE_DEFAULT_MAX_MSGS = "1";
process.env.SCHEDULE_DEFAULT_PER_DAY = "3";

const S = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗ FAIL:", msg); } }
function throws(fn, needle, msg) {
  try { fn(); fail++; console.log("  ✗ FAIL (no throw):", msg); }
  catch (e) { const good = !needle || String(e.message).includes(needle); if (good) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗ FAIL (wrong err):", msg, "->", e.message); } }
}

console.log("CREATE");
const sched = S.createSchedule(
  { to: "919999900000", goal: "Nudge landlord for rent receipt", cron: "0 9 * * 1" },
  { identity: "919999900000", jid: "919999900000@s.whatsapp.net" }
);
ok(sched.slug === "nudge-landlord-for-rent-receipt", "slug from goal: " + sched.slug);
ok(sched.dryRun === true, "created dryRun=true (safe default)");
ok(sched.enabled === true, "created enabled=true");
ok(/^[0-9a-f-]{36}$/.test(sched.sessionId), "sessionId is a uuid");
ok(sched.toJid === "919999900000@s.whatsapp.net", "recipient pinned to toJid");
ok(sched.contextHash.startsWith("sha256:"), "contextHash computed");
ok(fs.existsSync(path.join(tmp, "schedules", sched.slug, "context.md")), "context.md seeded");
ok(fs.existsSync(path.join(tmp, "schedules", sched.slug, "send-state.json")), "send-state.json created");

console.log("CONTEXT AUTHORING");
const authored = S.createSchedule(
  { to: "42", goal: "authored ctx", context: "# custom\n\nfull memory here" },
  { identity: "42", jid: "42@s.whatsapp.net" }
);
ok(S.getContext(authored.slug) === "# custom\n\nfull memory here", "create with context uses provided markdown (not template)");
const beforeHash = S.getSchedule(authored.slug).contextHash;
const setRes = S.setContext(authored.slug, "# custom\n\nEDITED memory");
ok(S.getContext(authored.slug).includes("EDITED"), "setContext overwrites context.md");
ok(S.getSchedule(authored.slug).contextHash === beforeHash, "setContext leaves stored contextHash STALE (forces next-run re-read, §7.1)");
ok(setRes.hash !== beforeHash, "setContext returns the new (different) hash");
S.deleteSchedule(authored.slug);

console.log("LIST/GET");
ok(S.listSchedules().length === 1, "listSchedules -> 1");
ok(S.getSchedule(sched.slug).goal === sched.goal, "getSchedule round-trips");
throws(() => S.getSchedule("nope"), "no such schedule", "getSchedule unknown throws");

console.log("SLUG DEDUPE");
const sched2 = S.createSchedule({ to: "1", goal: "Nudge landlord for rent receipt" }, { identity: "1", jid: "1@s.whatsapp.net" });
ok(sched2.slug === "nudge-landlord-for-rent-receipt-2", "dup goal -> -2 slug: " + sched2.slug);
S.deleteSchedule(sched2.slug);

console.log("SEND ENFORCEMENT");
function state() { return JSON.parse(fs.readFileSync(path.join(tmp, "schedules", sched.slug, "send-state.json"), "utf-8")); }
// dryRun blocks even with a token
const tokDry = S.beginRun(sched.slug);
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), tokDry).ok === false, "dryRun schedule: send denied");
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), tokDry).reason.includes("dryRun"), "  reason mentions dryRun");

// arm it
S.updateSchedule(sched.slug, { dryRun: false });
ok(S.getSchedule(sched.slug).dryRun === false, "dryRun flipped off");

// no active run (fresh state) -> denied. Re-begin to get a run.
const tok = S.beginRun(sched.slug);
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), "wrong-token").ok === false, "wrong token denied");
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), "wrong-token").reason.includes("invalid run token"), "  reason: invalid run token");
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), tok).ok === true, "valid token + armed -> allowed");

// authorizeSend returns pinned recipient, increments, enforces maxMsgs=1
const auth = S.authorizeSend(sched.slug, tok);
ok(auth.toJid === sched.toJid, "authorizeSend returns pinned toJid (never caller-chosen)");
throws(() => S.authorizeSend(sched.slug, tok), "per-run cap", "second send in run -> per-run cap (maxMsgs=1)");

// per-day ceiling: raise maxMsgs, new run, exhaust perDayMax(3). Already sent 1 today.
S.updateSchedule(sched.slug, { maxMsgs: 10 });
const tok2 = S.beginRun(sched.slug);
S.authorizeSend(sched.slug, tok2); // 2nd today
S.authorizeSend(sched.slug, tok2); // 3rd today
throws(() => S.authorizeSend(sched.slug, tok2), "per-day ceiling", "4th send today -> per-day ceiling (perDayMax=3)");

// token expiry
const tokExp = S.beginRun(sched.slug, -1); // already expired
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), tokExp).reason.includes("expired"), "expired token denied");

// disabled blocks
S.updateSchedule(sched.slug, { enabled: false });
const tokDis = S.beginRun(sched.slug);
ok(S.checkSendAllowed(S.getSchedule(sched.slug), state(), tokDis).reason.includes("disabled"), "disabled schedule denied");

console.log("MODEL ALLOWLIST");
S.validateModel("claude-opus-4-8");
ok(true, "default allowlisted model validates");
throws(() => S.validateModel("opus"), "not allowed", "non-1M model rejected");

console.log("DELETE");
const del = S.deleteSchedule(sched.slug);
ok(del.archivedTo.includes(".trash"), "delete moves to .trash (auditable)");
ok(S.listSchedules().length === 0, "listSchedules -> 0 after delete");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
