// selectTools/buildPrompt: the interactive/autonomous permission split.
// Interactive (event=telegram) gets direct send + self-management; autonomous
// (cron/watch/runnow) gets only the gated schedule_send when live. The
// orchestrator gets fleet tools + direct send interactively, BASE only on an
// autonomous fire. Pure — no fs, no claude spawn.
const fs = require("fs");
const os = require("os");
const path = require("path");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-toolsel-"));
process.env.DATA_DIR = DATA_DIR;
const { selectTools, buildPrompt } = require("/home/wactl/server/dist/schedules/runner.js");
const { ORCHESTRATOR_SLUG } = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const mk = (over = {}) => ({
  slug: "test-sched", sessionId: "00000000-0000-0000-0000-000000000000",
  model: "claude-sonnet-5", toIdentity: "12345",
  toJid: "12345@s.whatsapp.net", toResolvedAt: 0, cron: "0 9 * * *",
  goal: "Test goal", enabled: true, dryRun: true, maxMsgs: 1, perDayMax: 5,
  checkMessages: true, watch: null, snoozeUntil: null, telegramTopicId: null,
  contextHash: "", sessionStarted: false, lastRun: null, createdAt: 0, ...over,
});
const orch = mk({ slug: ORCHESTRATOR_SLUG, cron: null });
const has = (tools, t) => tools.includes(`mcp__wactl__${t}`);

console.log("AUTONOMOUS (cron/watch/runnow) — no direct send, no management");
for (const event of ["cron", "watch", "runnow"]) {
  const dry = selectTools(mk(), event);
  ok(`${event}: dry has no send of any kind`,
    !has(dry, "schedule_send") && !has(dry, "send_message") && !has(dry, "send_file"));
  ok(`${event}: dry has no management`, !has(dry, "schedule_update") && !has(dry, "schedule_create"));
  const live = selectTools(mk({ dryRun: false }), event);
  ok(`${event}: live has ONLY the gated schedule_send`,
    has(live, "schedule_send") && !has(live, "send_message") && !has(live, "send_file"));
}

console.log("INTERACTIVE (telegram) — direct send + self-management, no fleet tools");
const idry = selectTools(mk(), "telegram");
ok("dry: direct send granted", has(idry, "send_message") && has(idry, "send_file"));
ok("dry: schedule_send still withheld (dryRun)", !has(idry, "schedule_send"));
ok("dry: self-management granted",
  ["schedule_get", "schedule_update", "schedule_set_context", "schedule_run_now", "schedule_compact", "schedule_reset"]
    .every((t) => has(idry, t)));
ok("dry: fleet tools withheld",
  !has(idry, "schedule_create") && !has(idry, "schedule_delete") && !has(idry, "schedule_list"));
const ilive = selectTools(mk({ dryRun: false }), "telegram");
ok("live: gated schedule_send AND direct send coexist", has(ilive, "schedule_send") && has(ilive, "send_message"));

console.log("ORCHESTRATOR");
const oint = selectTools(orch, "telegram");
ok("interactive: fleet tools + direct send", has(oint, "schedule_create") && has(oint, "schedule_delete") && has(oint, "send_message"));
const oauto = selectTools(orch, "cron");
ok("autonomous fire: BASE only — no send, no fleet tools",
  !has(oauto, "send_message") && !has(oauto, "schedule_send") && !has(oauto, "schedule_create"));

console.log("BASE PRESENT EVERYWHERE");
for (const t of [selectTools(mk(), "cron"), idry, oint, oauto]) {
  ok("Read/Bash/get_chat present", t.includes("Read") && t.includes("Bash") && has(t, "get_chat"));
}

console.log("PROMPTS");
const resumed = { isNew: false, forceReread: false };
const tgTurn = buildPrompt({ schedule: mk({ sessionStarted: true }), event: "telegram", payload: "add a watch", state: resumed });
ok("telegram turn carries the capability note", /Interactive turn/.test(tgTurn) && /send_message/.test(tgTurn));
ok("telegram turn mentions self-management (schedule topic)", /self-management/.test(tgTurn));
ok("telegram turn carries the operator message", /add a watch/.test(tgTurn));
const orchTurn = buildPrompt({ schedule: { ...orch, sessionStarted: true }, event: "telegram", payload: "hi", state: resumed });
ok("orchestrator turn: note without self-management clause", /Interactive turn/.test(orchTurn) && !/self-management/.test(orchTurn));
const cronTurn = buildPrompt({ schedule: mk({ sessionStarted: true }), event: "cron", state: resumed });
ok("cron turn has NO capability note", !/Interactive turn/.test(cronTurn));
const watchTurn = buildPrompt({ schedule: mk({ sessionStarted: true, watch: { watchTarget: { identity: "12345", jid: "12345@s.whatsapp.net" }, criteria: "replies", since: 0 } }), event: "watch", payload: "yo", state: resumed });
ok("watch turn keeps untrusted markers, no capability note", /UNTRUSTED_WHATSAPP_DATA/.test(watchTurn) && !/Interactive turn/.test(watchTurn));
const fresh = buildPrompt({ schedule: mk(), event: "telegram", payload: "hello", state: { isNew: true, forceReread: false } });
ok("new-session preamble describes both send paths", /schedule_send/.test(fresh) && /send_message/.test(fresh) && /interactive turns/i.test(fresh));
const orchFresh = buildPrompt({ schedule: orch, event: "telegram", payload: "hello", state: { isNew: true, forceReread: false } });
ok("orchestrator preamble: 'never sends' identity removed", !/never send/i.test(orchFresh) && /send_message/.test(orchFresh));

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
