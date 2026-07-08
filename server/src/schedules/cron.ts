/**
 * Minimal 5-field cron matcher (no dependencies). Supports wildcard, step
 * (asterisk-slash-N), ranges (a-b), and lists (a,b,c), and combinations.
 * Fields: minute hour day-of-month month day-of-week. day-of-week is 0-6 with
 * 0=Sunday; 7 is accepted as Sunday too.
 *
 * Implements the standard cron day rule: when BOTH day-of-month and day-of-week
 * are restricted (neither is wildcard), a match on EITHER fires; otherwise both
 * must match. Times are evaluated in the local timezone the process runs in
 * (system cron's timezone).
 */

import { Schedule } from "./types";

function matchField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.split("/");
    if (slash.length === 2) {
      range = slash[0];
      step = parseInt(slash[1], 10);
      if (!Number.isFinite(step) || step <= 0) continue;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      // step-only over the whole range is handled by the caller's bounds; use a
      // wide window and let the modulo check below decide.
      lo = 0;
      hi = 59;
      if (slash.length === 2) {
        // */n matches when value % n === 0 within any field's own domain.
        if (value % step === 0) return true;
        continue;
      }
      return true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((x) => parseInt(x, 10));
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    for (let v = lo; v <= hi; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

export function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dowRaw] = parts;
  const dow = dowRaw.replace(/\b7\b/g, "0"); // 7 => Sunday

  const minOk = matchField(min, d.getMinutes());
  const hourOk = matchField(hour, d.getHours());
  const monOk = matchField(mon, d.getMonth() + 1);
  if (!(minOk && hourOk && monOk)) return false;

  const domRestricted = dom.trim() !== "*";
  const dowRestricted = dow.trim() !== "*";
  const domOk = matchField(dom, d.getDate());
  const dowOk = matchField(dow, d.getDay());

  if (domRestricted && dowRestricted) return domOk || dowOk; // standard cron OR
  return domOk && dowOk;
}

/** Whether a schedule should fire right now (cron cadence OR a manual trigger). */
export function isDue(schedule: Schedule, now: Date, triggerPresent: boolean): boolean {
  if (!schedule.enabled) return false;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (schedule.snoozeUntil && nowSec < schedule.snoozeUntil) return false;
  if (triggerPresent) return true;
  if (!schedule.cron) return false; // watch-only schedules never fire on the tick
  return cronMatches(schedule.cron, now);
}
