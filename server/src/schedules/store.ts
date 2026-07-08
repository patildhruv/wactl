/**
 * Storage + send-enforcement for scheduled messages. See
 * docs/scheduled-messages-spec.md §4, §9, §13.
 *
 * Design rules baked in here:
 *  - Every schedule.json / send-state.json write is atomic (temp + rename) so the
 *    in-process MCP tools and the out-of-process runner never corrupt each other
 *    (spec §9).
 *  - Send authorization is a PURE function (`checkSendAllowed`) so it is trivially
 *    testable and can't be talked out of its decision by the LLM (spec §13.1).
 *  - The recipient is ALWAYS the schedule's pinned toJid — never taken from a
 *    caller argument.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Schedule, SendState, ScheduleWatch, CreateScheduleInput } from "./types";

const DEFAULT_MODEL = process.env.SCHEDULE_DEFAULT_MODEL || "sonnet[1m]";
// >=1M-context allowlist (spec §17). Concrete ids are pinned via env at deploy
// time; default keeps a single safe entry.
const MODEL_ALLOWLIST = (process.env.SCHEDULE_MODEL_ALLOWLIST || DEFAULT_MODEL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_MAX_MSGS = intEnv("SCHEDULE_DEFAULT_MAX_MSGS", 1);
const DEFAULT_PER_DAY = intEnv("SCHEDULE_DEFAULT_PER_DAY", 3);

function intEnv(name: string, dflt: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : dflt;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function utcDay(sec: number = nowSec()): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

// --- Paths -----------------------------------------------------------------

function dataDir(): string {
  return process.env.DATA_DIR || "./data";
}
function schedulesRoot(): string {
  return path.join(dataDir(), "schedules");
}
function scheduleDir(slug: string): string {
  return path.join(schedulesRoot(), slug);
}
function schedulePath(slug: string): string {
  return path.join(scheduleDir(slug), "schedule.json");
}
function sendStatePath(slug: string): string {
  return path.join(scheduleDir(slug), "send-state.json");
}
function contextPath(slug: string): string {
  return path.join(scheduleDir(slug), "context.md");
}
function logPath(slug: string): string {
  return path.join(scheduleDir(slug), "log.md");
}

// --- Atomic IO -------------------------------------------------------------

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${uuidv4().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o660 });
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file: string, obj: unknown): void {
  writeAtomic(file, JSON.stringify(obj, null, 2));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

// --- Helpers ---------------------------------------------------------------

export function validateModel(model: string): void {
  if (!MODEL_ALLOWLIST.includes(model)) {
    throw new Error(
      `model '${model}' is not allowed — must be a >=1M-context model, one of: ${MODEL_ALLOWLIST.join(
        ", "
      )}`
    );
  }
}

function slugify(goal: string): string {
  const base =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "schedule";
  // Dedupe against existing dirs.
  let slug = base;
  let n = 2;
  while (fs.existsSync(scheduleDir(slug))) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

function sha256File(file: string): string {
  return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function seedContextMd(schedule: Schedule): string {
  return `# ${schedule.slug}

## Person
<who they are, relationship, contact context — send target: ${schedule.toIdentity}>

## Objective
${schedule.goal}

## Approach & psychology
<tone, cadence, what works / what to avoid with this person>

## History
<append-only-ish gist of what has happened>

## Pending
<what we're currently waiting on>

## Standing instructions
<hard rules: never do X, always Y, escalate if Z>
`;
}

// --- CRUD ------------------------------------------------------------------

export interface ResolvedRecipient {
  identity: string;
  jid: string;
}

/**
 * Create a schedule folder: schedule.json (atomic), seeded context.md, an empty
 * send-state, and a reserved session uuid. Does NOT create a Telegram topic —
 * wactl-telegram reconciles that (spec §5/§6). `recipient` is pre-resolved by
 * the caller (the tool handler owns the bridge).
 */
export function createSchedule(
  input: CreateScheduleInput,
  recipient: ResolvedRecipient
): Schedule {
  const model = input.model || DEFAULT_MODEL;
  validateModel(model);

  fs.mkdirSync(schedulesRoot(), { recursive: true, mode: 0o2770 });
  const slug = slugify(input.goal);
  const dir = scheduleDir(slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o2770 });
  fs.mkdirSync(path.join(dir, "sessions", "archive"), { recursive: true, mode: 0o2770 });

  const ts = nowSec();
  const schedule: Schedule = {
    slug,
    sessionId: uuidv4(),
    model,
    toIdentity: recipient.identity,
    toJid: recipient.jid,
    toResolvedAt: ts,
    cron: input.cron ?? null,
    goal: input.goal,
    enabled: true,
    dryRun: input.dryRun ?? true, // default TRUE — never sends until flipped
    maxMsgs: input.maxMsgs ?? DEFAULT_MAX_MSGS,
    perDayMax: input.perDayMax ?? DEFAULT_PER_DAY,
    checkMessages: input.checkMessages ?? true,
    watch: null,
    snoozeUntil: null,
    telegramTopicId: null,
    contextHash: "",
    sessionStarted: false,
    lastRun: null,
    createdAt: ts,
  };

  const initialContext = input.context?.trim() ? input.context : seedContextMd(schedule);
  fs.writeFileSync(contextPath(slug), initialContext, { mode: 0o660 });
  schedule.contextHash = sha256File(contextPath(slug));

  writeJsonAtomic(schedulePath(slug), schedule);
  writeJsonAtomic(sendStatePath(slug), {
    day: utcDay(ts),
    sentToday: 0,
    activeRun: null,
  } as SendState);

  return schedule;
}

export function listSchedules(): Schedule[] {
  const root = schedulesRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((slug) => fs.existsSync(schedulePath(slug)))
    .map((slug) => readJson<Schedule>(schedulePath(slug)));
}

export function getSchedule(slug: string): Schedule {
  const p = schedulePath(slug);
  if (!fs.existsSync(p)) throw new Error(`no such schedule: ${slug}`);
  return readJson<Schedule>(p);
}

export function getContext(slug: string): string {
  const p = contextPath(slug);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

/**
 * Overwrite context.md out-of-band (from Claude.ai or Telegram /setcontext).
 * Deliberately does NOT update schedule.json.contextHash — leaving a mismatch so
 * the next resumed run re-reads the updated memory (spec §7.1). Returns the new
 * hash for reference.
 */
export function setContext(slug: string, content: string): { hash: string } {
  getSchedule(slug); // existence check
  fs.writeFileSync(contextPath(slug), content, { mode: 0o660 });
  return { hash: sha256File(contextPath(slug)) };
}

export function getLogTail(slug: string, maxChars = 4000): string {
  const p = logPath(slug);
  if (!fs.existsSync(p)) return "";
  const s = fs.readFileSync(p, "utf-8");
  return s.length > maxChars ? s.slice(-maxChars) : s;
}

// Fields a caller may patch. Runtime-only / derived fields are excluded.
const PATCHABLE: (keyof Schedule)[] = [
  "cron",
  "goal",
  "enabled",
  "dryRun",
  "maxMsgs",
  "perDayMax",
  "checkMessages",
  "watch",
  "snoozeUntil",
  "telegramTopicId",
  "model",
  "sessionId",
  "sessionStarted",
  "contextHash",
  "lastRun",
];

export function updateSchedule(slug: string, patch: Partial<Schedule>): Schedule {
  const schedule = getSchedule(slug);
  if (patch.model !== undefined) validateModel(patch.model);
  for (const key of PATCHABLE) {
    if (key in patch && patch[key] !== undefined) {
      (schedule as unknown as Record<string, unknown>)[key] = patch[key];
    }
  }
  writeJsonAtomic(schedulePath(slug), schedule);
  return schedule;
}

/** Move the schedule folder to a trash area (auditable, not a hard delete). */
export function deleteSchedule(slug: string): { archivedTo: string } {
  const dir = scheduleDir(slug);
  if (!fs.existsSync(dir)) throw new Error(`no such schedule: ${slug}`);
  const trash = path.join(schedulesRoot(), ".trash");
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${slug}-${nowSec()}`);
  fs.renameSync(dir, dest);
  return { archivedTo: dest };
}

/** Drop a .trigger file the cron tick will pick up (spec §5). */
export function requestRunNow(slug: string): void {
  if (!fs.existsSync(scheduleDir(slug))) throw new Error(`no such schedule: ${slug}`);
  fs.writeFileSync(path.join(scheduleDir(slug), ".trigger"), String(nowSec()));
}

/** True if a .trigger file is present (manual run requested). */
export function hasTrigger(slug: string): boolean {
  return fs.existsSync(path.join(scheduleDir(slug), ".trigger"));
}

/** Consume (delete) a schedule's .trigger file if present. Called by the runner. */
export function clearTrigger(slug: string): void {
  const p = path.join(scheduleDir(slug), ".trigger");
  if (fs.existsSync(p)) fs.rmSync(p);
}

/** Directory a run should cwd into — the schedule's own folder (session binding + confinement). */
export function scheduleCwd(slug: string): string {
  return scheduleDir(slug);
}

/** Absolute paths the runner/agent operate on. */
export function contextFile(slug: string): string {
  return contextPath(slug);
}
export function logFile(slug: string): string {
  return logPath(slug);
}

/** Hash of context.md as it currently is on disk (vs the stored `contextHash`). */
export function currentContextHash(slug: string): string {
  const p = contextPath(slug);
  return fs.existsSync(p) ? sha256File(p) : "";
}

// --- Send enforcement (spec §13.1) -----------------------------------------

function readSendState(slug: string): SendState {
  const p = sendStatePath(slug);
  if (!fs.existsSync(p)) return { day: utcDay(), sentToday: 0, activeRun: null };
  return readJson<SendState>(p);
}

/**
 * Mint a per-run send token. Called by the runner at run start (Phase 2). Rolls
 * the per-day counter if the UTC day changed. Returns the token to thread into
 * the run's send authorization.
 */
export function beginRun(slug: string, ttlSec = 900): string {
  getSchedule(slug); // existence check
  const state = readSendState(slug);
  const today = utcDay();
  if (state.day !== today) {
    state.day = today;
    state.sentToday = 0;
  }
  const token = uuidv4();
  state.activeRun = { token, expiresAt: nowSec() + ttlSec, sent: 0 };
  writeJsonAtomic(sendStatePath(slug), state);
  return token;
}

export interface SendDecision {
  ok: boolean;
  reason?: string;
}

/**
 * PURE authorization check — no IO, no bridge. The single source of truth for
 * whether a send is permitted. Keeps the decision out of the LLM's reach.
 */
export function checkSendAllowed(
  schedule: Schedule,
  state: SendState,
  token: string,
  atSec: number = nowSec()
): SendDecision {
  if (!schedule.enabled) return { ok: false, reason: "schedule is disabled" };
  if (schedule.dryRun) return { ok: false, reason: "schedule is in dryRun — sending disabled" };
  if (schedule.snoozeUntil && atSec < schedule.snoozeUntil)
    return { ok: false, reason: "schedule is snoozed" };
  if (!state.activeRun) return { ok: false, reason: "no active run" };
  if (state.activeRun.token !== token) return { ok: false, reason: "invalid run token" };
  if (atSec >= state.activeRun.expiresAt) return { ok: false, reason: "run token expired" };
  if (state.activeRun.sent >= schedule.maxMsgs)
    return { ok: false, reason: `per-run cap reached (maxMsgs=${schedule.maxMsgs})` };
  const sentToday = state.day === utcDay(atSec) ? state.sentToday : 0;
  if (sentToday >= schedule.perDayMax)
    return { ok: false, reason: `per-day ceiling reached (perDayMax=${schedule.perDayMax})` };
  return { ok: true };
}

/**
 * Authorize + account a send. Returns the PINNED recipient JID the caller must
 * send to (never a caller-supplied recipient). Throws if not allowed. On
 * success, increments both counters atomically before the send is attempted so
 * a crash cannot under-count (we prefer over-counting to over-sending).
 */
export function authorizeSend(slug: string, token: string): { toJid: string } {
  const schedule = getSchedule(slug);
  const state = readSendState(slug);
  const decision = checkSendAllowed(schedule, state, token);
  if (!decision.ok) throw new Error(`send denied: ${decision.reason}`);

  const today = utcDay();
  if (state.day !== today) {
    state.day = today;
    state.sentToday = 0;
  }
  state.sentToday += 1;
  state.activeRun!.sent += 1;
  writeJsonAtomic(sendStatePath(slug), state);

  return { toJid: schedule.toJid };
}

/** Record a sent messageId into the schedule's log.md (append-only, spec §13.4). */
export function appendLog(slug: string, line: string): void {
  const stamp = new Date().toISOString();
  fs.appendFileSync(logPath(slug), `- ${stamp} ${line}\n`, { mode: 0o660 });
}
