// formatRunnerOutcome: a failing runner must surface, never render as "(done)".
// Regression test for the silent-failure bug that hid a multi-day outage —
// the Azure gateway dropped the pinned model, claude exited 1 with the reason
// on stderr, and the bot posted "(done)" with nothing in the journal.
const H = require("/home/wactl/server/dist/telegram/handlers.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
const out = (o) => H.formatRunnerOutcome(o);

console.log("SUCCESS PATH (unchanged behaviour)");
const good = out({ code: 0, stdout: '{"ok":true,"sessionId":"s","tokens":3,"reply":"Sent ✅"}', stderr: "" });
ok("returns the agent reply", good.text === "Sent ✅");
ok("no failure recorded", good.failure === null);
const legacy = out({ code: 0, stdout: '{"ok":true,"result":"older shape"}', stderr: "" });
ok("falls back to .result", legacy.text === "older shape" && legacy.failure === null);
const noisy = out({ code: 0, stdout: 'warning: something\n{"ok":true,"reply":"last line wins"}', stderr: "" });
ok("parses the LAST stdout line", noisy.text === "last line wins");
const quiet = out({ code: 0, stdout: '{"ok":true,"skipped":true}', stderr: "" });
ok("ok-but-nothing-to-say still '(done)'", quiet.text === "(done)" && quiet.failure === null);
const warned = out({ code: 0, stdout: '{"ok":true,"reply":"fine"}', stderr: "npm notice: new version" });
ok("stderr chatter on a clean exit is ignored", warned.text === "fine" && warned.failure === null);

console.log("THE REGRESSION: non-zero exit must NOT be '(done)'");
const dead = out({ code: 1, stdout: "", stderr: "claude exited 1: DeploymentNotFound" });
ok("surfaces instead of '(done)'", dead.text !== "(done)");
ok("names the exit code", dead.text.includes("exit 1"));
ok("carries the stderr reason", dead.text.includes("DeploymentNotFound"));
ok("records a failure for the journal", typeof dead.failure === "string" && dead.failure.includes("DeploymentNotFound"));

console.log("OTHER FAILURE SHAPES");
const silent = out({ code: 1, stdout: "", stderr: "" });
ok("exit 1 with both streams empty still surfaces", silent.text.includes("exit 1") && silent.failure !== null);
const killed = out({ code: null, stdout: "", stderr: "Killed" });
ok("signal kill (code null) surfaces", killed.text.includes("signal") && killed.failure !== null);
const garbage = out({ code: 0, stdout: "not json at all", stderr: "" });
ok("exit 0 + unparseable stdout is a failure", garbage.text.includes("unreadable output") && garbage.failure !== null);
ok("unparseable stdout echoed as the reason", garbage.text.includes("not json at all"));

console.log("TELEGRAM SAFETY");
const huge = out({ code: 1, stdout: "", stderr: "E".repeat(5000) });
ok("long stderr truncated for the message", huge.text.length < 600);
ok("full stderr kept for the journal", huge.failure.length > 4000);
const multi = out({ code: 1, stdout: "", stderr: "line one\nline two\nfinal cause here" });
ok("uses the last stderr line", multi.text.includes("final cause here") && !multi.text.includes("line one"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
