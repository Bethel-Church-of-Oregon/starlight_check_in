/**
 * Pickup security codes.
 *
 * Four characters from an alphabet with the look-alikes removed (no 0/O, 1/I/L,
 * 2/Z, 5/S, 8/B) so a volunteer reading a label out loud at pickup and a parent
 * reading it off their tag never disagree.
 */
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY'

export function randomSecurityCode(length = 4): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

/**
 * A code that is not already in use for this session date. Collisions are
 * astronomically unlikely to matter at church scale but a duplicate code at
 * pickup is exactly the kind of thing that ruins a Sunday, so we check.
 */
export function uniqueSecurityCode(taken: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomSecurityCode()
    if (!taken.has(code)) return code
  }
  // 25^4 = 390k combinations; if we somehow got here, go to five characters.
  return randomSecurityCode(5)
}
