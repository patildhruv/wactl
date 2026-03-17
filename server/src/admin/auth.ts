import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map<string, Session>();

// Rate limiting
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (record.count >= MAX_ATTEMPTS) {
    return false;
  }

  record.count++;
  return true;
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSession(): string {
  const id = uuidv4();
  const now = Date.now();
  sessions.set(id, {
    id,
    createdAt: now,
    expiresAt: now + SESSION_DURATION_MS,
  });
  return id;
}

export function validateSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}
