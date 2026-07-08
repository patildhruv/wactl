/**
 * CLI: node due.js <DATA_DIR>
 * Prints the slug of every schedule that should fire right now (cron cadence or
 * a pending .trigger), one per line. Called by scripts/schedule-tick.sh.
 */

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: due.js <DATA_DIR>");
  process.exit(2);
}
process.env.DATA_DIR = dataDir;

// Imported after DATA_DIR is set (store reads it lazily, but be explicit).
import { listSchedules, hasTrigger } from "./store";
import { isDue } from "./cron";

const now = new Date();
for (const s of listSchedules()) {
  try {
    if (isDue(s, now, hasTrigger(s.slug))) console.log(s.slug);
  } catch {
    // skip malformed schedule; the tick will pick it up next minute if fixed
  }
}
