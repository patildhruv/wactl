// orphanedTopicIds: which deleted-schedule topics are safe to close.
// Closing a topic is visible to the operator, so the guards matter more than
// the happy path — especially "never close General (topic 1)" and "never close
// an id a live schedule still holds".
const fs = require("fs");
const os = require("os");
const path = require("path");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-orphan-"));
process.env.DATA_DIR = DATA_DIR;
const H = require("/home/wactl/server/dist/telegram/handlers.js");
const store = require("/home/wactl/server/dist/schedules/store.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("THE BUG: MCP-deleted schedules leave open topics");
const trashed = [
  { slug: "old-alex", telegramTopicId: 16 },
  { slug: "dad", telegramTopicId: 41 },
  { slug: "sam", telegramTopicId: 77 },
];
ok("all three reaped when nothing is live", eq(H.orphanedTopicIds([], trashed), [16, 41, 77]));
ok("reaped alongside unrelated live topics", eq(H.orphanedTopicIds([100, 162], trashed), [16, 41, 77]));

console.log("GUARD: never close a topic a live schedule still holds");
ok("live id excluded", eq(H.orphanedTopicIds([41], trashed), [16, 77]));
ok("slug deleted then recreated on a new topic — old record must not close the new one",
  eq(H.orphanedTopicIds([41, 200], [{ slug: "dad", telegramTopicId: 41 }]), []));

console.log("GUARD: never touch General (topic 1) or the orchestrator");
ok("topic 1 excluded", eq(H.orphanedTopicIds([], [{ slug: "whatever", telegramTopicId: 1 }]), []));
ok("orchestrator excluded even on a high id",
  eq(H.orphanedTopicIds([], [{ slug: store.ORCHESTRATOR_SLUG, telegramTopicId: 999 }]), []));
ok("id 0 / negative excluded",
  eq(H.orphanedTopicIds([], [{ slug: "a", telegramTopicId: 0 }, { slug: "b", telegramTopicId: -5 }]), []));

console.log("HYGIENE");
ok("null/undefined live ids don't crash or over-match",
  eq(H.orphanedTopicIds([null, undefined, 16], trashed), [41, 77]));
ok("duplicate topic ids collapse",
  eq(H.orphanedTopicIds([], [{ slug: "a", telegramTopicId: 5 }, { slug: "b", telegramTopicId: 5 }]), [5]));
ok("non-numeric id skipped",
  eq(H.orphanedTopicIds([], [{ slug: "a", telegramTopicId: "77" }, { slug: "b", telegramTopicId: NaN }]), []));
ok("empty trash yields nothing", eq(H.orphanedTopicIds([100], []), []));

console.log("STORE: trash scan + idempotency marker");
const s = store.createSchedule(
  { to: "12345", goal: "Orphan topic sweep test schedule" },
  { identity: "12345", jid: "12345@s.whatsapp.net" }
);
store.updateSchedule(s.slug, { telegramTopicId: 4242 });
const { archivedTo } = store.deleteSchedule(s.slug);
let found = store.listTrashedTopics();
ok("deleted schedule shows up with its topic id",
  found.length === 1 && found[0].telegramTopicId === 4242 && found[0].dir === archivedTo);
ok("live list no longer contains it", !store.listSchedules().some((x) => x.slug === s.slug));
ok("archived schedule.json still readable (audit intact)",
  fs.existsSync(path.join(archivedTo, "schedule.json")));

store.markTopicClosed(archivedTo);
ok("marked entry disappears from the sweep", store.listTrashedTopics().length === 0);
ok("marker written, archive NOT rewritten",
  fs.existsSync(path.join(archivedTo, ".topic-closed")) &&
  JSON.parse(fs.readFileSync(path.join(archivedTo, "schedule.json"), "utf-8")).telegramTopicId === 4242);
ok("marker is group-writable (two-writer convention)",
  (fs.statSync(path.join(archivedTo, ".topic-closed")).mode & 0o777).toString(8) === "660");
ok("second sweep is a no-op (idempotent)", store.listTrashedTopics().length === 0);

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
