const os = require("os"), fs = require("fs"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-h-"));
process.env.DATA_DIR = tmp;
const S = require("/home/wactl/server/dist/schedules/store.js");
const H = require("/home/wactl/server/dist/telegram/handlers.js");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } }

const sched = S.createSchedule({ to: "919999900000", goal: "nudge landlord", cron: "0 9 * * 1" }, { identity: "919999900000", jid: "919999900000@s.whatsapp.net" });
S.updateSchedule(sched.slug, { telegramTopicId: 42 });
const get = () => S.getSchedule(sched.slug);
const cmd = (c, a = "") => H.handleTopicCommand(get(), c, a);

console.log("DURATION PARSE");
ok(H.parseDuration("2h") === 7200, "2h → 7200s");
ok(H.parseDuration("30m") === 1800, "30m → 1800s");
ok(H.parseDuration("1d") === 86400, "1d → 86400s");
ok(H.parseDuration("45") === 2700, "bare 45 → 45m");
ok(H.parseDuration("nope") === null, "junk → null");

console.log("TOPIC LOOKUP");
ok(H.scheduleForTopic(42) && H.scheduleForTopic(42).slug === sched.slug, "scheduleForTopic(42) finds it");
ok(H.scheduleForTopic(999) === null, "unknown topic → null");

console.log("STORE COMMANDS (instant, mutate real store)");
ok(cmd("pause").kind === "reply" && get().enabled === false, "/pause disables");
ok(cmd("resume") && get().enabled === true, "/resume enables");
cmd("dryrun", "off"); ok(get().dryRun === false, "/dryrun off → dryRun false");
cmd("dryrun", "on"); ok(get().dryRun === true, "/dryrun on → dryRun true");
ok(cmd("dryrun", "").text.includes("usage"), "/dryrun (no arg) → usage");
cmd("maxmsgs", "5"); ok(get().maxMsgs === 5, "/maxmsgs 5");
const snoozeRes = cmd("snooze", "2h"); ok(get().snoozeUntil > Math.floor(Date.now()/1000) + 7000, "/snooze 2h sets future snoozeUntil");
cmd("when", "0 8 * * *"); ok(get().cron === "0 8 * * *", "/when sets cron");
ok(cmd("when", "").text.includes("0 8 * * *"), "/when (no arg) shows cron");
cmd("goal", "new goal text"); ok(get().goal === "new goal text", "/goal sets goal");
ok(cmd("model", "nope").text.includes("not allowed"), "/model invalid → rejected");
cmd("model", "claude-opus-4-8"); ok(get().model === "claude-opus-4-8", "/model valid → set");
cmd("setcontext", "# fresh\nmemory"); ok(S.getContext(sched.slug).includes("fresh"), "/setcontext writes context.md");
ok(cmd("context").text.includes("fresh"), "/context dumps it");
cmd("watch", "invoice paid"); ok(get().watch && get().watch.criteria === "invoice paid", "/watch arms watch");
ok(get().watch.watchTarget.jid === sched.toJid, "  watchTarget defaults to send target");
cmd("unwatch"); ok(get().watch === null, "/unwatch clears");
cmd("compact"); ok(S.pendingRotation(sched.slug) === "compact", "/compact drops sentinel");
S.clearRotation(sched.slug);
cmd("reset"); ok(S.pendingRotation(sched.slug) === "reset", "/reset drops sentinel");
S.clearRotation(sched.slug);
ok(cmd("status").text.includes(sched.slug), "/status includes slug");
ok(cmd("bogus").text.includes("unknown"), "unknown command handled");

console.log("RUNNER COMMANDS (return RunRequest, not executed here)");
const rn = cmd("runnow");
ok(rn.kind === "run" && rn.event === "runnow", "/runnow → RunRequest(runnow)");
const tm = H.handleTopicMessage(get(), "did they reply yet?");
ok(tm.kind === "run" && tm.event === "telegram" && tm.payload === "did they reply yet?", "free text → RunRequest(telegram) w/ payload");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
