/**
 * Which record ids can actually be stored.
 *
 * ## The bug this closes (#26)
 *
 * An id was checked for being a non-empty string of at most 200 characters, and
 * nothing else — while `remoteStore.push` addresses a Firestore document *by*
 * that id. Firestore's legal document names are a narrower set than "a string",
 * and the failures are uneven. Probed against the installed SDK:
 *
 * ```
 * "ok-uuid-1234" -> users/u1/fillUps/ok-uuid-1234
 * "a/b"          -> THROWS: Invalid document reference. Document references
 *                   must have an even number of segments, but
 *                   users/u1/fillUps/a/b has 5.
 * "a/b/c"        -> users/u1/fillUps/a/b/c   — a path the rules never match,
 *                   so PERMISSION_DENIED
 * "__proto__"    -> builds; the server then refuses anything matching __.*__
 * "." and ".."   -> build; the server refuses both
 * ```
 *
 * One such row is not one failed write. It is local and strictly newer than
 * anything remote, so `rowsToPush` includes it on every sync; the push is one
 * `writeBatch`, so **nothing else uploads either**; and it presents as the
 * ordinary "not uploaded yet", which is indistinguishable from being offline.
 * Deleting the offending fill-up does not help — the tombstone carries the same
 * id. So this is a rule about availability, not tidiness.
 *
 * ## Where it is applied
 *
 * At every door an id can come through from outside: `recordValidation`
 * (anything pulled from the account) and `backupFormat` (an imported JSON or
 * CSV file). Locally generated ids are `crypto.randomUUID()` and were never the
 * problem. `sync.ts` then declines to *send* a row it cannot address, so a row
 * stored before this existed cannot keep an account from syncing forever.
 *
 * ## The message is a noun phrase, on purpose
 *
 * `idProblem` returns text like `no id` or `an id containing "/"`, so a caller
 * composes it into its own sentence — "a fill-up had …", "row 4 has …",
 * "submission x: …" — rather than every caller inventing its own wording for
 * the same fault. It keeps the offending value in the text, because "one row
 * was skipped" is not something anybody can act on.
 */

/** Firestore allows 1500 bytes; this is "longer than any id this app writes". */
export const MAX_ID_LENGTH = 200;

/** `.` and `..` are refused outright, as is anything matching `__.*__`. */
const RESERVED = /^__.*__$/;

/** C0 plus DEL. Not a Firestore rule — see below. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * What is wrong with this id, or `null` if nothing is.
 *
 * Ordered so the most specific fault is the one reported.
 */
export function idProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'no id';
  if (value.length > MAX_ID_LENGTH) {
    return `an id longer than ${MAX_ID_LENGTH} characters`;
  }
  if (value.includes('/')) {
    return `an id containing "/" (${JSON.stringify(value)}), which is not a name a document can be stored under`;
  }
  if (CONTROL.test(value)) {
    // Firestore would store these quite happily. They are refused because an
    // id nobody can read or type is a corrupt file telling on itself, and
    // because a newline in an id makes every log line that mentions it
    // unreadable.
    return 'an id containing control characters';
  }
  if (value === '.' || value === '..' || RESERVED.test(value)) {
    return `an id the database reserves (${JSON.stringify(value)})`;
  }
  return null;
}

export function isStorableId(value: unknown): value is string {
  return idProblem(value) === null;
}
