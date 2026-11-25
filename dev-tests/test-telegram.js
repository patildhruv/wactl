const C = require("/home/wactl/server/dist/telegram/commands.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } }

const GROUP = -1001234;
const cfg = { groupId: GROUP, allowedUserIds: [111, 222] };
const from = (id, is_bot = false) => ({ id, is_bot });
const msg = (o) => ({ message_id: 1, chat: { id: GROUP, type: "supergroup" }, ...o });

console.log("AUTHZ (fail-closed)");
ok(C.isAuthorized(msg({ from: from(111) }), cfg) === true, "allowlisted user in group → allowed");
ok(C.isAuthorized(msg({ from: from(999) }), cfg) === false, "non-allowlisted user → denied");
ok(C.isAuthorized(msg({ from: from(111), chat: { id: -1, type: "supergroup" } }), cfg) === false, "wrong group → denied");
ok(C.isAuthorized(msg({ from: from(111, true) }), cfg) === false, "bot sender → denied");
ok(C.isAuthorized(msg({}), cfg) === false, "no from → denied");
ok(C.isAuthorized(msg({ from: from(111) }), { groupId: GROUP, allowedUserIds: [] }) === false, "EMPTY allowlist → deny all");

console.log("PARSE USER IDS");
ok(JSON.stringify(C.parseUserIds("111, 222 ,333")) === JSON.stringify([111,222,333]), "csv → numbers");
ok(JSON.stringify(C.parseUserIds("")) === "[]", "empty → []");
ok(JSON.stringify(C.parseUserIds("111,junk,222")) === JSON.stringify([111,222]), "drops junk");
ok(JSON.stringify(C.parseUserIds(undefined)) === "[]", "undefined → []");

console.log("PARSE COMMAND");
ok(C.parseCommand("/pause") && C.parseCommand("/pause").command === "pause", "/pause");
ok(C.parseCommand("/dryrun off").args === "off", "/dryrun off → args 'off'");
ok(C.parseCommand("/pause@wactlbot").command === "pause", "strips @botname");
ok(C.parseCommand("/SetContext Hi").command === "setcontext", "lowercased command, args preserved case");
ok(C.parseCommand("/setcontext Hi").args === "Hi", "  args keep original case");
ok(C.parseCommand("hello") === null, "non-command → null");
ok(C.parseCommand("") === null, "empty → null");
ok(C.parseCommand("  /list  ").command === "list", "trims surrounding space");

console.log("ROUTE UPDATE");
const upd = (m) => ({ update_id: 1, message: m });
// General topic (no thread id): only lifecycle commands
let a = C.routeUpdate(upd(msg({ text: "/new landlord", from: from(111) })));
ok(a.kind === "general_command" && a.command === "new" && a.args === "landlord", "General /new → general_command");
a = C.routeUpdate(upd(msg({ text: "hi there", from: from(111) })));
ok(a.kind === "orchestrator_message" && a.text === "hi there", "General non-command → orchestrator_message");
a = C.routeUpdate(upd(msg({ text: "/pause", from: from(111) })));
ok(a.kind === "orchestrator_message" && a.text === "/pause", "General non-lifecycle cmd → orchestrator_message");
a = C.routeUpdate(upd(msg({ from: from(111) })));
ok(a.kind === "ignore", "General empty message → ignore");
// Topic message (thread id present)
a = C.routeUpdate(upd(msg({ text: "/pause", is_topic_message: true, message_thread_id: 42, from: from(111) })));
ok(a.kind === "topic_command" && a.command === "pause" && a.threadId === 42, "topic /pause → topic_command w/ threadId");
a = C.routeUpdate(upd(msg({ text: "did they reply?", is_topic_message: true, message_thread_id: 42, from: from(111) })));
ok(a.kind === "topic_message" && a.text === "did they reply?" && a.threadId === 42, "topic free text → topic_message");
a = C.routeUpdate(upd(msg({ is_topic_message: true, message_thread_id: 1, text: "/list", from: from(111) })));
ok(a.kind === "general_command", "reserved thread id 1 treated as General");
a = C.routeUpdate({ update_id: 1 });
ok(a.kind === "ignore", "no message → ignore");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
