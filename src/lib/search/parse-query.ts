/**
 * Deterministic plain-language query parser (no model). It pulls structured filters out of a search box string and
 * returns what is left as `residual` text for semantic and keyword search. Explicit form filters win over parsed
 * ones (`mergeFilters`). The query text is never logged or stored by this module.
 *
 * Recognised: price ("under 450k", "over $300,000", "$300,000-$500,000", "300k to 500k"), beds and baths
 * ("3 bed", "3 bedrooms", "2+ ba", "2 bath"), type (house, condo, townhouse, land, multi-family), ZIP
 * ("near 78704", "in 78704"), and "within N mi" (radius clamped to 1-50). Beds and baths are minimums: "3 bed" and
 * "3+ bed" both mean at least 3.
 */
import { PROPERTY_TYPES } from "@/lib/listing-schema";

type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PRICE_MIN_USD = 1_000;
export const PRICE_MAX_USD = 100_000_000;
export const RADIUS_MIN_MILES = 1;
export const RADIUS_MAX_MILES = 50;

export type SearchFilters = {
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  propertyType?: PropertyType;
  zip?: string;
  radiusMiles?: number;
};

export type ParsedQuery = { filters: SearchFilters; residual: string };

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const MONEY = String.raw`\$?\s?(?:${NUM})\s?(?:k|m)?\b`;

function money(raw: string): number | null {
  const m = /^\$?\s?([\d,]+(?:\.\d+)?)\s?(k|m)?$/i.exec(raw.trim());
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  const unit = m[2]?.toLowerCase();
  if (unit === "k") n *= 1_000;
  if (unit === "m") n *= 1_000_000;
  n = Math.round(n);
  return Number.isFinite(n) && n >= PRICE_MIN_USD && n <= PRICE_MAX_USD ? n : null;
}

const TYPE_WORDS: [RegExp, PropertyType][] = [
  [/\bmulti[\s-]?family\b/i, "multi_family"],
  [/\btownhouses?\b|\btownhomes?\b/i, "townhouse"],
  [/\bcondos?\b|\bcondominiums?\b/i, "condo"],
  [/\bhouses?\b|\bhomes?\b/i, "house"],
  [/\bland\b|\blots?\b(?!\s+of\b)/i, "land"], // "lots of light" and "a lot of space" are not land; "building lots" is
];

export function parseQuery(input: string): ParsedQuery {
  let rest = ` ${input} `;
  const filters: SearchFilters = {};
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean) => {
    const m = re.exec(rest);
    if (!m || !fn(m)) return;
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  };

  // Price range first so "$300,000-$500,000" isn't read as two bounds.
  take(new RegExp(String.raw`(?<![\w$])(${MONEY})\s?(?:-|–|—|to)\s?(${MONEY})(?!\w)`, "i"), (m) => {
    const a = money(m[1]);
    const b = money(m[2]);
    if (a === null || b === null) return false;
    filters.minPrice = Math.min(a, b);
    filters.maxPrice = Math.max(a, b);
    return true;
  });
  if (filters.maxPrice === undefined) {
    take(new RegExp(String.raw`\b(?:under|below|less than|up to|max(?:imum)?|at most)\s?(${MONEY})(?!\w)`, "i"), (m) => {
      const n = money(m[1]);
      if (n === null) return false;
      filters.maxPrice = n;
      return true;
    });
    take(new RegExp(String.raw`\b(?:over|above|more than|at least|min(?:imum)?)\s?(${MONEY})(?!\w)`, "i"), (m) => {
      const n = money(m[1]);
      if (n === null) return false;
      filters.minPrice = n;
      return true;
    });
  }

  take(/\b(\d{1,2})\s?\+?\s?(?:bed(?:room)?s?|br|bd)\b/i, (m) => {
    filters.minBeds = Number(m[1]);
    return true;
  });
  take(/\b(\d{1,2}(?:\.5)?)\s?\+?\s?(?:bath(?:room)?s?|ba)\b/i, (m) => {
    filters.minBaths = Number(m[1]);
    return true;
  });

  take(/\b(?:within|inside)\s+(\d{1,3})\s?(?:mi|miles?)\b/i, (m) => {
    filters.radiusMiles = Math.min(RADIUS_MAX_MILES, Math.max(RADIUS_MIN_MILES, Number(m[1])));
    return true;
  });
  take(/\b(?:near|in|around|by|at)\s+(\d{5})\b/i, (m) => {
    filters.zip = m[1];
    return true;
  });

  for (const [re, type] of TYPE_WORDS) {
    const m = re.exec(rest);
    if (!m) continue;
    filters.propertyType = type;
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    break;
  }

  return { filters, residual: rest.replace(/\s+/g, " ").trim() };
}

/** Explicit form values win; the parsed value fills only what the form left undefined. */
export function mergeFilters(parsed: SearchFilters, form: SearchFilters): SearchFilters {
  const out: SearchFilters = { ...parsed };
  for (const key of Object.keys(form) as (keyof SearchFilters)[]) {
    if (form[key] !== undefined) (out as Record<string, unknown>)[key] = form[key];
  }
  return out;
}

/** The residual text is worth embedding only with at least three letters. */
export function hasSearchableText(residual: string): boolean {
  return (residual.match(/\p{L}/gu)?.length ?? 0) >= 3;
}
