/**
 * Server checks on a listing description: the fair-housing screen (also run on every human save, see
 * `assertNoFairHousing`) and the checks on an AI draft (numbers, features, photo ids). Pure: no database, no
 * `server-only`, so the editor and the tests can use it.
 *
 * Threat model of the fair-housing screen, stated plainly: the person typing is a listing agent who may reach for
 * exclusionary wording without meaning to (or paste text with odd characters from a word processor or another site),
 * and a model that may echo wording from the notes. It is NOT built to stop someone deliberately smuggling a phrase
 * past a filter; no word list can, and this one does not claim to.
 *
 * What it does: whole-word matching after folding case, accents, zero-width characters, full-width and
 * mathematical letters (NFKC) and the look-alike letters in `CONFUSABLES` (Cyrillic, Greek, Armenian and small-capital
 * Latin letters for each Latin letter). A phrase never spans a sentence boundary (`. ? ! ;` followed by a space or the
 * end, or a blank line), so "HOA fees? No. Families will love it" is not "no families".
 *
 * What it does not: `CONFUSABLES` is a hand-picked list of the common look-alikes, not the full Unicode confusables
 * set, so an unlisted look-alike gets through; nor run-together words ("nokids"), spaced-out letters, digit-for-letter
 * leetspeak ("n0 kids"), or a preference expressed in a sentence the list has no phrase for. It can't tell "adults
 * only" the pool rule from "adults only" the tenant rule, so it can refuse legitimate copy; the refusal names the
 * phrase so the agent can rephrase.
 */
import { BadRequestError } from "@/lib/errors";
import { FEATURE_LABELS, type Feature } from "@/lib/listing-schema";
import {
  ALLOWED_PHRASES,
  type AllowedPhrase,
  type Category,
  FLAGGED_TERMS,
  type FlaggedTerm,
} from "@/lib/fair-housing-terms";

// --------------------------------------------------------------------------------------------------------------
// Text normalisation and fair-housing matching
// --------------------------------------------------------------------------------------------------------------

/**
 * Look-alike letters folded to the Latin letter they imitate, applied to lowercase text after NFKC. Every key is applied
 * (a test walks them all). Hand-picked, not the full Unicode confusables set. Written as code points on purpose.
 */
export const CONFUSABLES: Record<string, string> = Object.fromEntries(
  Object.entries({
    // Cyrillic
    "0430": "a", "0432": "b", "0441": "c", "0501": "d", "0435": "e", "04bb": "h", "043d": "h", "0456": "i", "0458": "j",
    "043a": "k", "04cf": "l", "043c": "m", "043e": "o", "0440": "p", "051b": "q", "0455": "s", "0442": "t", "0443": "y",
    "0445": "x", "051d": "w", "0475": "v",
    // Greek
    "03b1": "a", "03b2": "b", "03b3": "y", "03b5": "e", "03b7": "n", "03b9": "i", "03ba": "k", "03bd": "v", "03bf": "o",
    "03c1": "p", "03c4": "t", "03c5": "u", "03c7": "x", "03c9": "w",
    // Armenian
    "0585": "o", "057d": "u",
    // Latin: dotless i, script a and g, and the small capitals
    "0131": "i", "0251": "a", "0261": "g", "1d00": "a", "0299": "b", "1d04": "c", "1d05": "d", "1d07": "e", "0262": "g",
    "029c": "h", "026a": "i", "1d0a": "j", "1d0b": "k", "029f": "l", "1d0d": "m", "0274": "n", "1d0f": "o", "1d18": "p",
    "0280": "r", "a731": "s", "1d1b": "t", "1d1c": "u", "1d20": "v", "1d21": "w", "028f": "y", "1d22": "z",
  }).map(([cp, latin]) => [String.fromCodePoint(parseInt(cp, 16)), latin]),
);

const SENTENCE_BARRIER = "\u0001";

/**
 * Lowercase words only: no accents, no apostrophes, look-alike letters folded, every other non-letter/digit is a word
 * break. With `barriers`, a sentence end (`. ? ! ;` followed by whitespace or the end, or a blank line) leaves a barrier
 * word that no phrase contains, so a phrase can't span two sentences.
 */
export function toWords(input: string, opts: { barriers?: boolean } = {}): string[] {
  let folded = input
    .normalize("NFKC")
    // Every line ending is a plain "\n" first (CRLF from a Windows clipboard, CR, NEL, VT, FF, U+2028); U+2029 is a paragraph break.
    .replace(/\u2029/g, "\n\n")
    .replace(/\r\n?|[\u0085\u2028\u000b\u000c]/g, "\n")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  folded = Array.from(folded, (c) => CONFUSABLES[c] ?? c).join("").replace(/['\u2019\u2018`\u00b4]/g, "");
  if (opts.barriers) folded = folded.replace(/[.?!;]+(?=\s|$)|\n[ \t]*\n\s*/g, ` ${SENTENCE_BARRIER} `);
  return folded.split(/[^\p{L}\p{N}\u0001]+/u).filter(Boolean);
}

export type FairHousingHit = { phrase: string; category: Category };

type Lists = { flagged: readonly FlaggedTerm[]; allowed: readonly AllowedPhrase[] };
const DEFAULT_LISTS: Lists = { flagged: FLAGGED_TERMS, allowed: ALLOWED_PHRASES };
const MASK = "\u0000";

/** Replace each occurrence of `phrase` (as consecutive words) in `words` with one mask word, which matches nothing. */
function maskPhrase(words: string[], phrase: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    if (phrase.length > 0 && phrase.every((w, k) => words[i + k] === w)) {
      out.push(MASK);
      i += phrase.length;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Flagged phrases found in `text`, at most one hit per phrase. Allowed phrases are masked out first. Whole words only:
 * "family room" and "walk-in closet" are never flagged, and neither is "kids" inside "no kidsville" (a different word).
 */
export function findFairHousingTerms(text: string, lists: Lists = DEFAULT_LISTS): FairHousingHit[] {
  let words = toWords(text, { barriers: true });
  for (const a of lists.allowed) words = maskPhrase(words, toWords(a.phrase));
  const hits: FairHousingHit[] = [];
  for (const t of lists.flagged) {
    const phrase = toWords(t.phrase);
    if (phrase.length === 0) continue;
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((w, k) => words[i + k] === w)) {
        hits.push({ phrase: t.phrase, category: t.category });
        break;
      }
    }
  }
  return hits;
}

const CATEGORY_LABEL: Record<Category, string> = {
  race: "race",
  color: "color",
  national_origin: "national origin",
  religion: "religion",
  sex: "sex",
  familial_status: "familial status",
  disability: "disability",
};

/**
 * Refuse (400) when any of the given public-facing fields holds a flagged phrase. Names the field, the phrase and the
 * category; never echoes the rest of the text. Used by every save path in `listings.ts`.
 */
export function assertNoFairHousing(fields: Record<string, string | undefined>, lists: Lists = DEFAULT_LISTS): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const hits = findFairHousingTerms(value, lists);
    if (hits.length > 0) {
      const named = hits.map((h) => `"${h.phrase}" (${CATEGORY_LABEL[h.category]})`).join(", ");
      throw new BadRequestError(
        `The ${field} contains wording that may break fair-housing advertising rules: ${named}. Remove or rephrase it and save again. This check is a screening aid, not legal advice.`,
      );
    }
  }
}

// --------------------------------------------------------------------------------------------------------------
// Plain text
// --------------------------------------------------------------------------------------------------------------

/** Markup is stripped: output is rendered as plain text only. */
export function toPlainText(input: string): string {
  return input
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --------------------------------------------------------------------------------------------------------------
// Numbers
// --------------------------------------------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** "one" is ordinary English ("one of", "no one"): it counts as a number only before a unit word. */
const ONE_UNITS = new Set(["bedroom", "bedrooms", "bed", "bath", "baths", "bathroom", "bathrooms", "story", "storey", "car", "acre", "fireplace", "level", "floor", "garage", "room", "stall"]);

export type NumberToken = { raw: string; value: number };

const DIGITS = /(?<![A-Za-z0-9.])\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:(k|m)\b|\s(million|thousand)\b)?/gi;

/** Every number in `text`: digits ("1,850", "$425k", "2.5") and number words ("three"). */
export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(DIGITS)) {
    let value = Number((m[1] + (m[2] ?? "")).replace(/,/g, ""));
    const suffix = (m[3] ?? m[4] ?? "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") value *= 1_000;
    if (suffix === "m" || suffix === "million") value *= 1_000_000;
    out.push({ raw: m[0].trim().slice(0, 40), value: Math.round(value * 1e6) / 1e6 });
  }
  const words = toWords(text);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in WORD_NUMBERS) out.push({ raw: w, value: WORD_NUMBERS[w] });
    else if (w === "one" && ONE_UNITS.has(words[i + 1] ?? "")) out.push({ raw: "one", value: 1 });
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------------
// The draft check
// --------------------------------------------------------------------------------------------------------------

export type DescriptionFacts = {
  propertyType: string;
  beds: number;
  baths: number;
  sqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  priceUsd: number;
  features: readonly Feature[];
  city: string;
  state: string;
  zip: string;
};

export type FactKey = "beds" | "baths" | "sqft" | "lot" | "year" | "price" | "type" | "feature" | "notes";

export type DraftOutput = {
  headline: string;
  description: string;
  highlights: { text: string; factKey: FactKey }[];
  photoSuggestions: { feature: string; photoId: string }[];
  needsHumanBecause: string | null;
};

export type DraftFlag =
  | { code: "unverified_number"; field: "headline" | "description" | "highlight"; detail: string }
  | { code: "fact_key_mismatch"; field: "highlight"; detail: string }
  | { code: "fair_housing"; field: "headline" | "description" | "highlight" | "photoSuggestion"; detail: string; category: Category };

export type DraftDropped = {
  highlights: { text: string; reason: "feature_not_selected" }[];
  photoSuggestions: { feature: string; reason: "photo_not_sent" | "duplicate" }[];
};

export type CheckedDraft = DraftOutput & { flags: DraftFlag[]; dropped: DraftDropped };

const NUMERIC_KEYS = ["beds", "baths", "sqft", "lot", "year", "price"] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

const ACRE = 43_560;

function factValues(f: DescriptionFacts): Record<NumericKey, number[]> {
  return {
    beds: [f.beds],
    baths: [f.baths],
    sqft: f.sqft === null ? [] : [f.sqft],
    lot: f.lotSqft === null ? [] : [f.lotSqft, Math.round((f.lotSqft / ACRE) * 100) / 100],
    year: f.yearBuilt === null ? [] : [f.yearBuilt],
    price: [f.priceUsd],
  };
}

const norm = (s: string) => toWords(s).join(" ");
const featureNames = (k: Feature) => [norm(FEATURE_LABELS[k]), norm(k.replace(/_/g, " "))];

/**
 * Check an AI draft against the listing it was written for. Never trusts the model: flags numbers that match no fact
 * and no agent note, drops feature highlights that name an unselected feature, drops photo suggestions whose id wasn't
 * among the photos sent, and runs the fair-housing screen over every visible string. Output text is made plain.
 */
export function checkDraft(
  draft: DraftOutput,
  ctx: { facts: DescriptionFacts; agentNotes: string; sentPhotoIds: readonly string[] },
): CheckedDraft {
  const flags: DraftFlag[] = [];
  const dropped: DraftDropped = { highlights: [], photoSuggestions: [] };

  const headline = toPlainText(draft.headline);
  const description = toPlainText(draft.description);
  const values = factValues(ctx.facts);
  const zip = Number(ctx.facts.zip);
  const allowed = new Set<number>([...NUMERIC_KEYS.flatMap((k) => values[k]), ...(Number.isFinite(zip) ? [zip] : [])]);
  for (const n of extractNumbers(ctx.agentNotes)) allowed.add(n.value);
  const ok = (v: number) => allowed.has(v);

  const seen = new Set<string>();
  const checkNumbers = (field: "headline" | "description" | "highlight", s: string) => {
    for (const n of extractNumbers(s)) {
      const key = `${field}:${n.raw}`;
      if (!ok(n.value) && !seen.has(key)) {
        seen.add(key);
        flags.push({ code: "unverified_number", field, detail: n.raw });
      }
    }
  };
  checkNumbers("headline", headline);
  checkNumbers("description", description);

  const selected = ctx.facts.features;
  const highlights: CheckedDraft["highlights"] = [];
  for (const h of draft.highlights) {
    const text = toPlainText(h.text);
    if (h.factKey === "feature") {
      const t = ` ${norm(text)} `;
      const names = selected.flatMap(featureNames);
      if (!names.some((name) => name && t.includes(` ${name} `))) {
        dropped.highlights.push({ text: text.slice(0, 80), reason: "feature_not_selected" });
        continue;
      }
    }
    checkNumbers("highlight", text);
    if ((NUMERIC_KEYS as readonly string[]).includes(h.factKey)) {
      const own = values[h.factKey as NumericKey];
      for (const n of extractNumbers(text)) {
        if (ok(n.value) && !own.includes(n.value)) flags.push({ code: "fact_key_mismatch", field: "highlight", detail: `${n.raw} is not the ${h.factKey}`.slice(0, 80) });
      }
    }
    highlights.push({ text, factKey: h.factKey });
  }

  const sent = new Set(ctx.sentPhotoIds);
  const photoSuggestions: CheckedDraft["photoSuggestions"] = [];
  const dupes = new Set<string>();
  for (const p of draft.photoSuggestions) {
    const feature = toPlainText(p.feature);
    if (!sent.has(p.photoId)) {
      dropped.photoSuggestions.push({ feature: feature.slice(0, 60), reason: "photo_not_sent" });
      continue;
    }
    const key = `${norm(feature)}|${p.photoId}`;
    if (dupes.has(key)) {
      dropped.photoSuggestions.push({ feature: feature.slice(0, 60), reason: "duplicate" });
      continue;
    }
    dupes.add(key);
    photoSuggestions.push({ feature, photoId: p.photoId });
  }

  const screen = (field: "headline" | "description" | "highlight" | "photoSuggestion", s: string) => {
    for (const hit of findFairHousingTerms(s)) flags.push({ code: "fair_housing", field, detail: hit.phrase, category: hit.category });
  };
  screen("headline", headline);
  screen("description", description);
  for (const h of highlights) screen("highlight", h.text);
  for (const p of photoSuggestions) screen("photoSuggestion", p.feature);

  return { headline, description, highlights, photoSuggestions, needsHumanBecause: draft.needsHumanBecause, flags, dropped };
}

/** True when a checked draft has anything the agent must fix before saving it (the editor highlights these). */
export const hasBlockingFlag = (d: Pick<CheckedDraft, "flags">) => d.flags.some((f) => f.code === "fair_housing");
