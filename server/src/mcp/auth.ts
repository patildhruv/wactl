import { IncomingMessage } from "http";

/**
 * Validates the API key from the request headers.
 * Returns true if the key is valid, false otherwise.
 */
export function validateApiKey(req: IncomingMessage, apiKey: string): boolean {
  const provided = req.headers["x-api-key"];
  if (!provided || typeof provided !== "string") {
    return false;
  }
  // Constant-time comparison
  if (provided.length !== apiKey.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ apiKey.charCodeAt(i);
  }
  return result === 0;
}
