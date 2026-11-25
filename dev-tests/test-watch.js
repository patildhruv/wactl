const os = require("os"), fs = require("fs"), path = require("path"), Module = require("module");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-w-"));
process.env.DATA_DIR = tmp;
const S = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } }

const now = Math.floor(Date.now() / 1000);
const sched = S.createSchedule({ to: "919999900000", goal: "watch test" }, { identity: "919999900000", jid: "919999900000@s.whatsapp.net" });

console.log("WATCH MATCHING");
ok(S.watchMatches(sched, "919999900000@s.whatsapp.net") === false, "no watch set → no match");
S.updateSchedule(sched.slug, { watch: { watchTarget: { identity: "919999900000", jid: "919999900000@s.whatsapp.net" }, criteria: "paid", since: now } });
const s = S.getSchedule(sched.slug);
ok(S.watchMatches(s, "919999900000@s.whatsapp.net") === true, "exact JID match");
ok(S.watchMatches(s, "919999900000@lid") === true, "bare user-part match (LID drift tolerance)");
ok(S.watchMatches(s, "911111111111@s.whatsapp.net") === false, "different number → no match");

console.log("ACTIVE WATCHES (enabled + not snoozed)");
ok(S.activeWatches().length === 1, "one active watch");
S.updateSchedule(sched.slug, { snoozeUntil: now + 3600 });
ok(S.activeWatches().length === 0, "snoozed → not active");
S.updateSchedule(sched.slug, { snoozeUntil: null, enabled: false });
ok(S.activeWatches().length === 0, "disabled → not active");
S.updateSchedule(sched.slug, { enabled: true });
ok(S.activeWatches().length === 1, "re-enabled → active again");

console.log("ADVANCE SINCE (monotonic)");
S.advanceWatchSince(sched.slug, now + 100);
ok(S.getSchedule(sched.slug).watch.since === now + 100, "advances forward");
S.advanceWatchSince(sched.slug, now + 50);
ok(S.getSchedule(sched.slug).watch.since === now + 100, "never moves backward");

console.log("FETCH WATCH INBOUND (mock bridge)");
// Load client.js so it's cached, THEN patch its export to avoid a real bridge.
const clientPath = require.resolve("/home/wactl/server/dist/bridge/client.js");
require(clientPath);
let fakeMessages = [];
require.cache[clientPath].exports.BridgeClient = class {
  constructor() {}
  async searchMessages(opts) { return fakeMessages.filter(m => m.timestamp >= opts.since); }
};
// require runner AFTER patching so it binds the fake
const R = require("/home/wactl/server/dist/schedules/runner.js");

const cur = S.getSchedule(sched.slug); // since = now+100
fakeMessages = [];
(async () => {
  let r = await R.fetchWatchInbound(cur, 4000);
  ok(r === null, "no messages after cursor → null (skip claude)");

  fakeMessages = [{ timestamp: now + 50, isFromMe: false, from: "x", body: "old" }];
  r = await R.fetchWatchInbound(cur, 4000);
  ok(r === null, "only messages at/before cursor → null");

  fakeMessages = [
    { timestamp: now + 200, isFromMe: false, from: "919999900000", senderName: "Landlord", body: "got it, paid" },
    { timestamp: now + 210, isFromMe: true, from: "me", body: "thanks" },
  ];
  r = await R.fetchWatchInbound(cur, 4000);
  ok(r && r.payload.includes("paid"), "new inbound → payload built");
  ok(r && !r.payload.includes("thanks"), "outbound (isFromMe) excluded from payload");
  ok(r && r.newestTs === now + 200, "newestTs = newest INBOUND ts");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
