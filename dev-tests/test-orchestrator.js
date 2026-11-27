// Orchestrator (General-topic) pseudo-schedule: store + runner behavior.
process.umask(0o022);
const fs = require("fs"), os = require("os"), path = require("path");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-orch-"));
process.env.DATA_DIR = DATA_DIR;
const S = require("/home/wactl/server/dist/schedules/store.js");
const R = require("/home/wactl/server/dist/schedules/runner.js");
const C = require("/home/wactl/server/dist/telegram/commands.js");

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ FAIL: " + name); } };
const mode = (p) => (fs.statSync(p).mode & 0o7777).toString(8);

console.log("STORE");
const o1 = S.ensureOrchestrator();
ok(o1.slug === S.ORCHESTRATOR_SLUG, "ensureOrchestrator returns reserved slug");
ok(o1.dryRun === true && o1.toJid === "", "orchestrator never sends (dryRun, no jid)");
const o2 = S.ensureOrchestrator();
ok(o2.sessionId === o1.sessionId, "idempotent — same session on second call");
ok(S.getSchedule(S.ORCHESTRATOR_SLUG).slug === S.ORCHESTRATOR_SLUG, "getSchedule resolves it");

// A real schedule + the orchestrator; listSchedules must exclude the reserved one.
S.createSchedule({ to: "12345", goal: "Real schedule for list filtering" }, { identity: "12345", jid: "12345@s.whatsapp.net" });
const listed = S.listSchedules().map((s) => s.slug);
ok(!listed.includes(S.ORCHESTRATOR_SLUG), "listSchedules EXCLUDES orchestrator");
ok(listed.length === 1, "listSchedules shows only the real schedule");

console.log("PERMS (two-writer safe)");
const odir = path.join(DATA_DIR, "schedules", S.ORCHESTRATOR_SLUG);
ok(mode(odir) === "2770", "orchestrator dir 2770");
ok(mode(path.join(odir, "schedule.json")) === "660", "schedule.json 660");
ok(mode(path.join(odir, "context.md")) === "660", "context.md 660");

console.log("RUNNER TOOLSET (interactive turn — the orchestrator's normal mode)");
const tools = R.selectTools(o1, "telegram");
ok(tools.includes("mcp__wactl__schedule_create"), "can create schedules");
ok(tools.includes("mcp__wactl__schedule_delete"), "can delete schedules");
ok(tools.includes("mcp__wactl__list_chats") && tools.includes("mcp__wactl__get_chat"), "can study chats");
ok(tools.includes("mcp__wactl__download_media"), "can view media");
ok(!tools.includes("mcp__wactl__schedule_send"), "NO schedule_send");
ok(tools.includes("mcp__wactl__send_message") && tools.includes("mcp__wactl__send_file"), "direct send present on interactive turns");
const autoTools = R.selectTools(o1, "cron");
ok(!autoTools.includes("mcp__wactl__send_message") && !autoTools.includes("mcp__wactl__schedule_create"), "autonomous fire: no send, no fleet tools");

console.log("RUNNER PROMPT");
const st = R.sessionState(o1, o1.contextHash);
const p = R.buildPrompt({ schedule: o1, event: "telegram", payload: "study Alice and set up a nudge", state: st, token: undefined });
ok(/orchestrator/i.test(p), "prompt frames it as the orchestrator");
ok(p.includes("schedule_") && /create/.test(p) && p.includes("study"), "prompt advertises create + study");
ok(/Autonomous sending only ever happens through a schedule/.test(p), "prompt scopes autonomous sending to schedules");
ok(/send only what the operator asks for/i.test(p), "prompt limits direct send to operator asks");
ok(p.includes("study Alice"), "prompt carries the operator's message");
ok(!/append your drafted message/i.test(p), "does NOT use the per-schedule dryRun script");

console.log("ROUTING");
const from = (id) => ({ id, is_bot: false });
const upd = (m) => ({ update_id: 1, message: m });
const base = { message_id: 1, chat: { id: -100, type: "supergroup" } };
let a = C.routeUpdate(upd({ ...base, text: "study my landlord", from: from(1) }));
ok(a.kind === "orchestrator_message" && a.text === "study my landlord", "General free text → orchestrator_message");
a = C.routeUpdate(upd({ ...base, photo: [{ file_id: "x", width: 1, height: 1 }], caption: "who is this", from: from(1) }));
ok(a.kind === "orchestrator_message" && a.text === "who is this", "General photo+caption → orchestrator_message");
a = C.routeUpdate(upd({ ...base, text: "/list", from: from(1) }));
ok(a.kind === "general_command" && a.command === "list", "General /list still a lifecycle command");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
