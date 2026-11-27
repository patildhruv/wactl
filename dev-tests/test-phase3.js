const os = require("os"), fs = require("fs"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-p3-"));
process.env.DATA_DIR = tmp;
// Isolate a fake claude config dir so we can plant a "live transcript".
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-cfg-"));
process.env.CLAUDE_CONFIG_DIR = cfg;

const S = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } }

console.log("PROJECT DIR DERIVATION");
ok(S.claudeProjectDir("/tmp/wactl-smoke-OndcNc") === path.join(cfg, "projects", "-tmp-wactl-smoke-OndcNc"),
   "cwd → projects/<non-alnum→dashes>: " + S.claudeProjectDir("/tmp/wactl-smoke-OndcNc"));

console.log("ROTATION (archive + mint)");
const sched = S.createSchedule({ to: "1", goal: "compaction test" }, { identity: "1", jid: "1@s.whatsapp.net" });
// simulate a started session
S.updateSchedule(sched.slug, { sessionStarted: true });
const oldSid = S.getSchedule(sched.slug).sessionId;

// plant a live transcript where the store expects it (project dir = the schedule's own folder cwd)
const scheduleDir = path.join(tmp, "schedules", sched.slug);
const projDir = S.claudeProjectDir(scheduleDir);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, oldSid + ".jsonl"), '{"fake":"transcript"}\n');

const rot = S.rotateSession(sched.slug);
ok(rot.oldSessionId === oldSid, "rotate reports old session id");
ok(rot.newSessionId !== oldSid, "rotate mints a NEW session id");
ok(rot.archivedTo && fs.existsSync(rot.archivedTo), "live transcript archived to disk");
ok(rot.archivedTo.includes(path.join("sessions", "archive")), "archived under sessions/archive/");
ok(fs.readFileSync(rot.archivedTo, "utf-8").includes("fake"), "archive preserves transcript content");

const after = S.getSchedule(sched.slug);
ok(after.sessionId === rot.newSessionId, "schedule.json now points at new session");
ok(after.sessionStarted === false, "sessionStarted reset to false (next run reads context.md)");

console.log("ROTATION with NO live transcript (fresh session)");
const s2 = S.createSchedule({ to: "2", goal: "never ran" }, { identity: "2", jid: "2@s.whatsapp.net" });
const rot2 = S.rotateSession(s2.slug);
ok(rot2.archivedTo === null, "no transcript → archivedTo null (no crash)");
ok(S.getSchedule(s2.slug).sessionId === rot2.newSessionId, "still mints a new session id");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(cfg, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
