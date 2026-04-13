/**
 * parse-helpers.ts — shared utilities for adapter implementations.
 *
 * Phase 1: minimal price/number parsers. Phase 2+ will extend with:
 *   - currency detection
 *   - delivery-time parsers ("3-5 days", "в течение недели")
 *   - availability mapping from supplier strings
 */

/**
 * Parse a price string like "1 234,56 руб." or "$12.50" into a JS number.
 * Returns NaN if nothing parseable is found.
 */
export function parsePrice(raw: string | null | undefined): number {
  if (raw == null) return NaN;
  // Remove currency letters/signs, keep digits and separators
  const cleaned = raw.toString().replace(/[^\d,.\-]/g, '').trim();
  if (cleaned === '') return NaN;

  // Prefer the LAST separator as decimal — handles "1,234.56" and "1.234,56"
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let normalized: string;
  if (lastComma > lastDot) {
    // European: "1.234,56" → "1234.56"
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // Anglo: "1,234.56" → "1234.56"
    normalized = cleaned.replace(/,/g, '');
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse an integer like "14 шт." or "qty: 3" → 14, 3.
 * Returns undefined if nothing parseable found (cleaner for optional fields).
 */
export function parseQuantity(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  const m = /\d+/.exec(raw.toString());
  if (!m) return undefined;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Collapse whitespace in strings: multiple spaces → one, trim edges.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
