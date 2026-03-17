import { IncomingMessage } from "http";
import crypto from "crypto";

/**
 * Validates the API key from the request headers.
 * Returns true if the key is valid, false otherwise.
 */
export function validateApiKey(req: IncomingMessage, apiKey: string): boolean {
  // Reject if the server has no API key configured
  if (!apiKey) {
    return false;
  }

  // Accept API key via X-API-Key header or Authorization: Bearer <key>
  let provided: string | string[] | undefined = req.headers["x-api-key"];
  if (!provided || typeof provided !== "string") {
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      provided = authHeader.slice(7);
    }
  }
  if (!provided || typeof provided !== "string") {
    return false;
  }

  // Use Node's built-in constant-time comparison to prevent timing attacks.
  // timingSafeEqual requires equal-length buffers, so we hash both values
  // to normalize length while keeping the comparison constant-time.
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(apiKey).digest();
  return crypto.timingSafeEqual(a, b);
}
