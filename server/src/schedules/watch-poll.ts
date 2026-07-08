/**
 * CLI: node watch-poll.js <DATA_DIR> <BRIDGE_PORT>
 * The watch backstop (spec §11): the bridge "message" callback is lossy
 * (fire-and-forget, dropped on restart, never fired for HistorySync), so this
 * poll is the SOURCE OF TRUTH. For each active watch it checks the bridge for
 * inbound newer than the watch cursor and, when there is any, prints
 * "watch <slug>" for the tick to fire the runner. The runner re-checks and
 * advances the cursor, so a message surfaced here and by the callback runs once.
 */

const dataDir = process.argv[2];
const bridgePort = parseInt(process.argv[3] || "4000", 10);
if (!dataDir) {
  console.error("usage: watch-poll.js <DATA_DIR> <BRIDGE_PORT>");
  process.exit(2);
}
process.env.DATA_DIR = dataDir;

import { activeWatches } from "./store";
import { fetchWatchInbound } from "./runner";

(async () => {
  for (const s of activeWatches()) {
    try {
      const found = await fetchWatchInbound(s, bridgePort);
      if (found) console.log(`watch ${s.slug}`);
    } catch {
      // bridge unreachable / transient — try again next tick
    }
  }
})();
