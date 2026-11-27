// Reproduce the live bug: with umask 022 (the root server's umask), verify the
// store now produces group-writable dirs (02770) and files (0660) so the second
// writer (wactl group) can bind topics, setContext, and appendLog.
process.umask(0o022);
const fs = require("fs");
const os = require("os");
const path = require("path");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-perms-"));
process.env.DATA_DIR = DATA_DIR;
const store = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log(`  ✓ ${name} = ${want}`); }
  else { fail++; console.log(`  ✗ ${name}: got ${got}, want ${want}`); }
}
const mode = (p) => (fs.statSync(p).mode & 0o7777).toString(8);

const s = store.createSchedule(
  { to: "12345", goal: "Test perms schedule for two writers" },
  { identity: "12345", jid: "12345@s.whatsapp.net" }
);
const dir = path.join(DATA_DIR, "schedules", s.slug);
console.log("SCHEDULE DIR + SUBDIRS (want 2770)");
eq("schedule dir", mode(dir), "2770");
eq("sessions dir", mode(path.join(dir, "sessions")), "2770");
eq("sessions/archive dir", mode(path.join(dir, "sessions", "archive")), "2770");
console.log("FILES (want 660)");
eq("schedule.json", mode(path.join(dir, "schedule.json")), "660");
eq("context.md", mode(path.join(dir, "context.md")), "660");
eq("send-state.json", mode(path.join(dir, "send-state.json")), "660");

console.log("SECOND-WRITER OPERATIONS (were the EACCES failures)");
// The bug: telegram (wactl) writing telegramTopicId back into schedule.json.
store.updateSchedule(s.slug, { telegramTopicId: 42 });
eq("updateSchedule persisted topicId", store.getSchedule(s.slug).telegramTopicId, 42);
eq("schedule.json still 660 after rewrite", mode(path.join(dir, "schedule.json")), "660");
// setContext (in-place rewrite) + appendLog (create+append).
store.setContext(s.slug, "new memory");
eq("context.md still 660 after setContext", mode(path.join(dir, "context.md")), "660");
store.appendLog(s.slug, "sent msg 1");
eq("log.md 660 on create", mode(path.join(dir, "log.md")), "660");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
