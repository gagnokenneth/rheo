/**
 * Password hashing happens here, in the browser, because WebCrypto PBKDF2 is
 * native and fast. Apps Script offers only computeHmacSha256Signature, where a
 * 210k-iteration loop would take tens of seconds per login.
 *
 * The salt is derived from the username rather than random: the browser needs it
 * before it can hash, and fetching a random per-user salt would reveal which
 * usernames exist. Unique per user but predictable — the iteration count is what
 * carries the weight.
 *
 * The server never sees the password, and applies its own peppered digest to
 * what it receives, so a leaked spreadsheet yields nothing directly usable.
 */
const ITERATIONS = 210_000
// Predates the rename to Rheo. Part of every user's salt, so changing it locks
// out every existing account.
const SITE = 'finance-tracker:'

export const MIN_PASSWORD_LENGTH = 10

/**
 * Must match normalizeUsername in apps-script/Code.gs. The PBKDF2 salt is
 * derived from this, so any divergence between client and server silently
 * breaks login rather than failing loudly.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

/**
 * Must match isValidUsername in apps-script/Code.gs. ASCII only: the session
 * token is base64-encoded, and a non-Latin-1 username would either throw in
 * btoa or decode to mojibake.
 */
export const USERNAME_RULE = '3-32 characters: letters, numbers, dot, dash or underscore.'

export function isValidUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalizeUsername(username))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function deriveCredential(username: string, password: string): Promise<string> {
  const enc = new TextEncoder()
  const salt = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(SITE + normalizeUsername(username))),
  )
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return toHex(new Uint8Array(bits))
}
