/**
 * CLI: node due.js <DATA_DIR>
 * Prints one "<event> <slug>" line per schedule that needs work this minute:
 *   - "compact <slug>" / "reset <slug>" for a pending rotation sentinel (first)
 *   - "cron <slug>" for a schedule due on its cadence or a .trigger
 * Rotation takes precedence over a same-minute run. Called by schedule-tick.sh.
 */

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: due.js <DATA_DIR>");
  process.exit(2);
}
process.env.DATA_DIR = dataDir;

// Imported after DATA_DIR is set (store reads it lazily, but be explicit).
import { listSchedules, hasTrigger, pendingRotation } from "./store";
import { isDue } from "./cron";

const now = new Date();
for (const s of listSchedules()) {
  try {
    const rot = pendingRotation(s.slug);
    if (rot) {
      console.log(`${rot} ${s.slug}`);
      continue; // rotate this minute; skip a run so the fresh session starts next tick
    }
    if (isDue(s, now, hasTrigger(s.slug))) console.log(`cron ${s.slug}`);
  } catch {
    // skip malformed schedule; the tick will pick it up next minute if fixed
  }
}
