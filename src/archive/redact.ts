/**
 * Name redaction (CCB-S3-007 §2), the in-process half.
 *
 * The AUTHORITATIVE redaction is in SQL (`published_messages`, migration 013),
 * because it has to be re-evaluated on every read: that is what makes a member's
 * later `/unpublish` retroactively remove their name from messages of hers that
 * were published while their consent stood.
 *
 * This function exists for the one thing SQL cannot re-evaluate cheaply — the
 * full-text vector. A generated column cannot look at the `consent` table, so the
 * text she contributes to SEARCH has every named member replaced unconditionally,
 * consenting or not. Slightly more is hidden from search than from the page, and
 * that is the right way round: the alternative is a visitor searching a redacted
 * name, getting the card back, and learning it names them.
 *
 * Two hazards, both found by probing real Postgres before this was written:
 *  - an unescaped name containing regex metacharacters rewrites the pattern;
 *  - an EMPTY name matches at every position and shreds the whole sentence.
 */

/**
 * Escapes every regex metacharacter so a display name is matched literally.
 *
 * This is also what the DATABASE matches on: `message_mentions.display_pattern`
 * stores the output of this function, and the publication view alternates those
 * stored patterns rather than escaping in SQL.
 *
 * That split is deliberate. Escaping inside SQL means carrying a backslash
 * through three layers — the SQL literal, the replacement grammar of
 * `regexp_replace`, and the regex itself — and it was verified against real
 * Postgres NOT to survive the trip: the name `Ro[b]in.*` escaped in SQL came back
 * as `Ro\1b\1in\1\1`, an invalid backreference that made the whole pattern throw.
 * A throwing pattern is not a cosmetic bug here — it is the redaction failing
 * open. One escaper, in the language that can test it directly.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces each of `names` with `placeholder`, matching whole words only.
 *
 * Word boundaries are expressed with lookarounds over Unicode letters rather than
 * `\b`, which is ASCII-only and would split a name like `Åsa` in the middle.
 * Matching is case-sensitive on purpose: these strings are the exact text we
 * embedded, so a looser match could only ever redact more than it should.
 */
export function redactNames(
  text: string,
  names: readonly string[],
  placeholder: string,
): string {
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))]
    // Longest first, so `Ann Marie` is replaced as a whole before `Ann` can bite.
    .sort((a, b) => b.length - a.length);
  if (usable.length === 0) return text;

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${usable.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  return text.replace(pattern, placeholder);
}
