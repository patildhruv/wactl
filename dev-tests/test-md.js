const H = require("/home/wactl/server/dist/telegram/handlers.js");
const md = H.mdToTelegramHtml;
let pass=0, fail=0;
const eq=(name,got,want)=>{ if(got===want){pass++;console.log("  ✓ "+name);} else {fail++;console.log("  ✗ "+name+"\n     got:  "+JSON.stringify(got)+"\n     want: "+JSON.stringify(want));} };

eq("bold", md("hi **there** you"), "hi <b>there</b> you");
eq("inline code", md("run `npm test` now"), "run <code>npm test</code> now");
eq("underscore bold", md("a __b__ c"), "a <b>b</b> c");
eq("italic", md("a *b* c"), "a <i>b</i> c");
eq("html escaped in prose", md("2 < 3 & 5 > 1"), "2 &lt; 3 &amp; 5 &gt; 1");
eq("code body escaped, not tag-mangled", md("`a < b`"), "<code>a &lt; b</code>");
eq("header → bold", md("# Title"), "<b>Title</b>");
eq("bullets", md("- one\n- two"), "• one\n• two");
eq("link", md("see [docs](https://x.io/a)"), 'see <a href="https://x.io/a">docs</a>');
eq("fenced block", md("```js\nconst x=1;\n```"), "<pre>const x=1;</pre>");
eq("asterisk math not italicized", md("3 * 4 = 12"), "3 * 4 = 12");
eq("no double-escape of code with amp", md("`a && b`"), "<code>a &amp;&amp; b</code>");

// The REAL agent message that showed raw markers in Telegram:
const real = "Yep, working. 👍\n\nThe bridge is up and I can see your schedules. One is currently set up:\n\n- **`send-alex-one-short-casual-follow-up-each-morni`** — daily 10:00 nudge to Alex (919999900000) about the remaining payment, in your voice, no amounts. Still in **dryRun** (won't actually send yet), and hasn't run once so far.";
const got = md(real);
console.log("\n=== real message rendered ===\n"+got+"\n");
const okReal = got.includes("<b><code>send-alex-one-short-casual-follow-up-each-morni</code></b>") && got.includes("<b>dryRun</b>") && got.startsWith("• ") === false && got.includes("• <b>");
eq("real: nested bold+code, dryRun bold, bullet", okReal, true);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
