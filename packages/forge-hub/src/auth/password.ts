import bcrypt from 'bcryptjs';

export async function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Salt + digest of a fixed bcrypt hash of a random, discarded value, so no
 * password ever matches it. Not a credential.
 */
const DUMMY_HASH_BODY = 'LB7D26912LsgCkHFJ.IMtecdK4o9QEJ1bxTTS6lrOO.XHQPq51Uma';

/**
 * A precomputed bcrypt hash at the given cost, for equalizing login timing
 * (security finding 6). bcrypt's work factor comes from the hash's cost field,
 * so a compare against this costs the same as against a real user's hash made
 * at the same cost, without hashing anything at boot.
 */
export function dummyPasswordHash(cost: number): string {
  return `$2b$${String(cost).padStart(2, '0')}$${DUMMY_HASH_BODY}`;
}
