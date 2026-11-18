import { describe, expect, it } from "vitest";
import { DEMO_LIVING_ROOM_PHOTO_ID } from "@/lib/demo/ids";
import { ALLOWED_PHRASES, CATEGORIES, FLAGGED_TERMS, SOURCES, SOURCE_VERIFICATION } from "@/lib/fair-housing-terms";
import { demoFixtures } from "@/lib/ai/demo";
import {
  CONFUSABLES,
  type DescriptionFacts,
  type DraftOutput,
  assertNoFairHousing,
  checkDraft,
  extractNumbers,
  findFairHousingTerms,
  toPlainText,
} from "./description-checks";
import { HttpError } from "./errors";

const facts: DescriptionFacts = {
  propertyType: "house",
  beds: 3,
  baths: 2,
  sqft: 1640,
  lotSqft: 6534,
  yearBuilt: 1938,
  priceUsd: 450_000,
  features: ["fenced_yard", "home_office"],
  city: "Austin",
  state: "TX",
  zip: "78704",
};
const PHOTO = "22222222-2222-4222-8222-222222222222";
const OTHER_PHOTO = "33333333-3333-4333-8333-333333333333";
const BODY = "A quiet house in Austin with a fenced yard and a home office. ".repeat(4);
const ctx = { facts, agentNotes: "", sentPhotoIds: [PHOTO] };
const draft = (o: Partial<DraftOutput> = {}): DraftOutput => ({
  headline: "Bungalow with a fenced yard",
  description: BODY,
  highlights: [],
  photoSuggestions: [],
  needsHumanBecause: null,
  ...o,
});

describe("fair-housing term data", () => {
  it("covers all seven categories, including color", () => {
    expect(new Set(FLAGGED_TERMS.map((t) => t.category))).toEqual(new Set(CATEGORIES));
  });
  it("gives every flagged and allowed entry at least one source, each a known source", () => {
    for (const e of [...FLAGGED_TERMS, ...ALLOWED_PHRASES]) {
      expect(e.sources.length, e.phrase).toBeGreaterThan(0);
      for (const s of e.sources) expect(SOURCES[s], `${e.phrase}: ${s}`).toBeDefined();
    }
  });
  it("keeps the confidence levels apart: HUD's text unread, the Part 109 removal read, no HUD list behind the phrases", () => {
    expect(SOURCE_VERIFICATION.checkedAgainstPrimaryText).toBe(false);
    expect(SOURCE_VERIFICATION.hud1995MemoSource).toMatch(/secondary/);
    expect(SOURCE_VERIFICATION.part109RemovalVerifiedInFederalRegister).toBe(true);
    expect(SOURCE_VERIFICATION.flaggedPhrasesAreFromAHudList).toBe(false);
    expect(SOURCES.HUD_1995.doc).toMatch(/SECONDARY SOURCE/);
  });
  it("never uses HUD's 1995 memo as a reason to FLAG anything (it says what should not ground complaints)", () => {
    for (const t of FLAGGED_TERMS) expect(t.sources, t.phrase).not.toContain("HUD_1995");
  });
  it("does not cite 42 U.S.C. 3603(b) as an advertising exemption, and records its carve-out of 3604(c)", async () => {
    const src = (await import("node:fs")).readFileSync("src/lib/fair-housing-terms.ts", "utf8");
    expect(src).not.toMatch(/exemption \(42 U\.S\.C\. § 3603\(b\)\(2\)\)/);
    expect(src).toMatch(/other than subsection \(c\)/);
  });
  it("never cites the removed 24 CFR Part 109 as an authority", () => {
    for (const s of Object.values(SOURCES)) expect(`${s.doc} ${s.cite}`).not.toMatch(/109\.20|Part 109/);
  });
  it("only master bedroom is tied to the 1995 memo; the other allow-list entries rest on the spec's attribution", () => {
    for (const a of ALLOWED_PHRASES) expect(a.sources.includes("HUD_1995"), a.phrase).toBe(a.phrase === "master bedroom");
  });
  it("does not flag bare 'master' or 'master bedroom' (HUD guidance protects it)", () => {
    expect(FLAGGED_TERMS.some((t) => /\bmaster\b/.test(t.phrase))).toBe(false);
    expect(findFairHousingTerms("Master bedroom with a mother-in-law suite and a bachelor apartment nearby")).toEqual([]);
  });
  it("has no flagged phrase that is a single common word", () => {
    for (const t of FLAGGED_TERMS) expect(t.phrase.split(/\s+/).length, t.phrase).toBeGreaterThanOrEqual(2);
  });
});

describe("fair-housing screen: flagged", () => {
  it.each(FLAGGED_TERMS.map((t) => [t.phrase, t.category] as const))("flags %s (%s) in a sentence, shouted, and punctuated", (phrase, category) => {
    for (const text of [`Lovely house. ${phrase}. Call today`, phrase.toUpperCase() + "!!!", phrase.replace(/ /g, "-"), `(${phrase})`]) {
      expect(findFairHousingTerms(text), text).toContainEqual({ phrase, category });
    }
  });

  it("is not fooled by accents, zero-width characters, full-width letters or look-alike Cyrillic", () => {
    for (const evasive of ["nó kids", "no​ kids", "no k​ids", "ｎｏ ｋｉｄｓ", "no kіds", "no  kids"]) {
      expect(findFairHousingTerms(evasive).map((h) => h.phrase), JSON.stringify(evasive)).toContain("no kids");
    }
  });

  it("applies EVERY configured look-alike mapping, to every flagged phrase containing that letter", () => {
    expect(Object.keys(CONFUSABLES).length).toBeGreaterThan(50);
    let swaps = 0;
    for (const [fake, latin] of Object.entries(CONFUSABLES)) {
      for (const t of FLAGGED_TERMS) {
        const at = t.phrase.indexOf(latin);
        if (at < 0) continue;
        const swapped = t.phrase.slice(0, at) + fake + t.phrase.slice(at + 1);
        swaps++;
        expect(findFairHousingTerms(`Nice home. ${swapped}`).map((h) => h.phrase), `U+${fake.codePointAt(0)!.toString(16)} in ${t.phrase}`).toContain(t.phrase);
      }
    }
    expect(swaps).toBeGreaterThan(500);
  });

  it("catches the look-alikes the review named, including the Cyrillic Supplement one", () => {
    for (const evasive of ["no ki\u0501s", "no \u043aids", "\u043cen only", "whi\u0442es only", "no \u043dandicapped", "able \u0432odied only", "\u051domen only"]) {
      expect(findFairHousingTerms(evasive).length, evasive).toBe(1);
    }
  });

  it("names the spec's example", () => {
    const hits = findFairHousingTerms("Perfect for young families near St. Mary's church");
    expect(hits).toEqual([{ phrase: "young families", category: "familial_status" }]);
  });
});

describe("fair-housing screen: accepted (the false-positive class)", () => {
  it.each(ALLOWED_PHRASES.map((a) => a.phrase))("accepts the allow-listed phrase %s", (phrase) => {
    expect(findFairHousingTerms(`Bright home with a ${phrase} and more.`)).toEqual([]);
  });

  it("accepts family room and walk-in closet in running copy, in several spellings", () => {
    for (const text of [
      "The family room opens to the yard.",
      "Family Room, kitchen and a walk-in closet.",
      "A walk in closet and a FAMILY-ROOM.",
      "Spacious family room with a walk-in closet in the primary suite.",
    ]) expect(findFairHousingTerms(text), text).toEqual([]);
  });

  it("does not flag words that merely contain or neighbour a flagged word", () => {
    for (const text of [
      "No children's play area on site is needed; the yard is fenced.",
      "Kids bedroom, no kidsville signs",
      "Adults enjoy the patio; the singles section of the bookshelf stays.",
      "Close to the church-street bakery",
      "A mens room and a womens room in the commercial unit",
      "Whites and creams throughout; only the garage is unpainted",
    ]) expect(findFairHousingTerms(text), text).toEqual([]);
  });

  it("never joins words across a sentence end: 'HOA fees? No. Families will love the cul-de-sac.'", () => {
    expect(findFairHousingTerms("HOA fees? No. Families will love the cul-de-sac.")).toEqual([]);
    for (const end of [".", "?", "!", ";", "...", ".\n\n", "!\n\n", ";  "]) {
      expect(findFairHousingTerms(`There is a pool, no${end} Kids will love it. Adults${end} only a few steps away`), JSON.stringify(end)).toEqual([]);
      expect(findFairHousingTerms(`Quiet street. No${end} Families will love the cul-de-sac.`), JSON.stringify(end)).toEqual([]);
    }
  });

  it("still flags a phrase inside one sentence, across commas, line wraps and punctuation that is not a sentence end", () => {
    for (const text of ["Sorry, no kids.", "No kids!", "Rule: no\nkids allowed", "no,  kids", "NO-KIDS", "no.kids", "Quiet. Adults only; call me."]) {
      expect(findFairHousingTerms(text).length, text).toBeGreaterThan(0);
    }
  });

  it("treats every line-ending form alike: a blank line is a barrier, a single line break is not", () => {
    for (const blank of ["\n\n", "\r\n\r\n", "\r\r", "\u2028\u2028", "\u2029", "\n \t\n", "\u0085\u0085"]) {
      expect(findFairHousingTerms(`Pets: no${blank}Children welcome`), JSON.stringify(blank)).toEqual([]);
      expect(findFairHousingTerms(`Pets: no${blank}Kids welcome. Growing${blank}family of four`), JSON.stringify(blank)).toEqual([]);
    }
    for (const wrap of ["\n", "\r\n", "\r", "\u2028"]) {
      expect(findFairHousingTerms(`Plenty of room for a growing${wrap}family of four`).length, JSON.stringify(wrap)).toBe(1);
      expect(findFairHousingTerms(`Sorry, no${wrap}kids`).length, JSON.stringify(wrap)).toBe(1);
    }
  });

  it("does not refuse paint and trim copy that says 'white only'", () => {
    expect(findFairHousingTerms("White only cabinets and trim; black only hardware")).toEqual([]);
    expect(findFairHousingTerms("whites only").map((h) => h.phrase)).toEqual(["whites only"]);
  });

  it("masks an allowed phrase even when a flagged term sits inside it, but only that phrase (injected lists)", () => {
    const lists = {
      flagged: [{ phrase: "family", category: "familial_status", sources: ["FHA_3604C"] }],
      allowed: [{ phrase: "family room", sources: ["SPEC_ATTRIBUTION"] }],
    } as const;
    expect(findFairHousingTerms("A big family room", lists)).toEqual([]);
    expect(findFairHousingTerms("Ideal for a family", lists)).toHaveLength(1);
    expect(findFairHousingTerms("A family room, ideal for a family", lists)).toHaveLength(1);
    // The mask is a word break, so it can't join its neighbours into a flagged phrase.
    expect(findFairHousingTerms("a no family room kids", { ...lists, flagged: [{ phrase: "family kids", category: "familial_status", sources: ["FHA_3604C"] }] })).toEqual([]);
  });
});

describe("assertNoFairHousing", () => {
  it("refuses with a 400 that names the phrase and category and the field, and nothing else of the text", () => {
    try {
      assertNoFairHousing({ title: "Fine title", description: "Secret address 99 Elm. No kids allowed." });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const err = e as HttpError;
      expect(err.status).toBe(400);
      expect(err.message).toContain('"no kids"');
      expect(err.message).toContain("familial status");
      expect(err.message).toContain("description");
      expect(err.message).toContain("screening aid, not legal advice");
      expect(err.message).not.toContain("99 Elm");
    }
  });
  it("checks every field and passes clean or missing ones", () => {
    expect(() => assertNoFairHousing({ title: undefined, description: "A family room and a walk-in closet." })).not.toThrow();
    expect(() => assertNoFairHousing({ title: "Adults only building", description: "fine" })).toThrow(/title/);
  });
});

describe("toPlainText", () => {
  it("strips markup and keeps paragraphs", () => {
    expect(toPlainText("<b>Hi</b> **there**\r\n\r\n\r\n\r\n# Head\n[link](http://x.test) `code`<script>alert(1)</script>")).toBe("Hi there\n\nHead\nlink codealert(1)");
  });
});

describe("extractNumbers", () => {
  it("reads digits, separators, decimals, suffixes and number words", () => {
    const v = (s: string) => extractNumbers(s).map((n) => n.value);
    expect(v("1,850 sqft")).toEqual([1850]);
    expect(v("$425k or $0.5 million or $1.2M")).toEqual([425000, 500000, 1200000]);
    expect(v("2.5 baths and 1938")).toEqual([2.5, 1938]);
    expect(v("three bedrooms, twenty minutes")).toEqual([3, 20]);
  });
  it("treats 'one' as a number only before a unit, and ignores letters glued to digits", () => {
    expect(extractNumbers("One of a kind, no one will mind").length).toBe(0);
    expect(extractNumbers("one bedroom suite").map((n) => n.value)).toEqual([1]);
    expect(extractNumbers("Model B2").length).toBe(0);
  });
});

describe("checkDraft: numbers", () => {
  it("accepts numbers equal to a fact in any format", () => {
    const d = checkDraft(draft({ headline: "Three bed, 2 bath", description: `${BODY} 1,640 sq ft, built in 1938, listed at $450,000 ($450k), ZIP 78704, lot 0.15 acre.` }), ctx);
    expect(d.flags).toEqual([]);
  });
  it("flags a number that matches no fact", () => {
    const d = checkDraft(draft({ description: `${BODY} Enjoy 4 bedrooms and a 2-car garage.` }), ctx);
    // "2" is the bath count, so only the 4 is unverified.
    expect(d.flags).toEqual([{ code: "unverified_number", field: "description", detail: "4" }]);
  });
  it("flags in the headline and in highlights too, once per field and token", () => {
    const d = checkDraft(draft({ headline: "Nine bedroom estate", highlights: [{ text: "5 baths", factKey: "baths" }, { text: "5 baths", factKey: "baths" }] }), ctx);
    expect(d.flags.filter((f) => f.code === "unverified_number").map((f) => `${f.field}:${f.detail}`)).toEqual(["headline:nine", "highlight:5"]);
  });
  it("accepts a number the agent wrote in the notes", () => {
    const d = checkDraft(draft({ description: `${BODY} New roof in 2021.` }), { ...ctx, agentNotes: "New roof installed 2021" });
    expect(d.flags).toEqual([]);
  });
  it("flags a valid number attached to the wrong fact", () => {
    const d = checkDraft(draft({ highlights: [{ text: "1938 bedrooms", factKey: "beds" }, { text: "3 bedrooms", factKey: "beds" }] }), ctx);
    expect(d.flags.map((f) => f.code)).toEqual(["fact_key_mismatch"]);
  });
});

describe("checkDraft: features", () => {
  it("keeps a feature highlight that names a selected feature (label or key words) and drops the rest", () => {
    const d = checkDraft(
      draft({
        highlights: [
          { text: "Fenced yard", factKey: "feature" },
          { text: "A quiet home office", factKey: "feature" },
          { text: "Sparkling pool", factKey: "feature" },
          { text: "Mentions a yard but no match", factKey: "feature" },
        ],
      }),
      ctx,
    );
    expect(d.highlights.map((h) => h.text)).toEqual(["Fenced yard", "A quiet home office"]);
    expect(d.dropped.highlights.map((h) => h.text)).toEqual(["Sparkling pool", "Mentions a yard but no match"]);
    expect(d.dropped.highlights.every((h) => h.reason === "feature_not_selected")).toBe(true);
  });
  it("does not match a selected feature inside a longer word", () => {
    const d = checkDraft(draft({ highlights: [{ text: "Home officer on duty", factKey: "feature" }] }), ctx);
    expect(d.highlights).toEqual([]);
  });
});

describe("checkDraft: photos", () => {
  it("drops a suggestion whose photo id was not sent, and duplicates", () => {
    const d = checkDraft(
      draft({
        photoSuggestions: [
          { feature: "Kitchen island", photoId: PHOTO },
          { feature: "kitchen  island", photoId: PHOTO },
          { feature: "Bay window", photoId: OTHER_PHOTO },
        ],
      }),
      ctx,
    );
    expect(d.photoSuggestions).toEqual([{ feature: "Kitchen island", photoId: PHOTO }]);
    expect(d.dropped.photoSuggestions).toEqual([
      { feature: "kitchen  island", reason: "duplicate" },
      { feature: "Bay window", reason: "photo_not_sent" },
    ]);
  });
  it("never lets a photo-only feature into the description text", () => {
    const d = checkDraft(draft({ photoSuggestions: [{ feature: "Kitchen island", photoId: PHOTO }] }), ctx);
    expect(d.description.toLowerCase()).not.toContain("island");
  });
});

describe("checkDraft: fair housing and plain text", () => {
  it("flags flagged wording in the headline, description, highlights and photo suggestions", () => {
    const d = checkDraft(
      draft({
        headline: "Adults only retreat",
        description: `${BODY} Ideal for young families.`,
        highlights: [{ text: "No kids", factKey: "notes" }],
        photoSuggestions: [{ feature: "No wheelchairs ramp", photoId: PHOTO }],
      }),
      ctx,
    );
    expect(d.flags.filter((f) => f.code === "fair_housing").map((f) => `${f.field}:${f.detail}`)).toEqual([
      "headline:adults only",
      "description:young families",
      "highlight:no kids",
      "photoSuggestion:no wheelchairs",
    ]);
  });
  it("does not flag family room or walk-in closet in a draft", () => {
    const d = checkDraft(draft({ description: `${BODY} A family room and a walk-in closet.`, highlights: [{ text: "Family room", factKey: "notes" }] }), ctx);
    expect(d.flags).toEqual([]);
  });
  it("strips markup from every returned string", () => {
    const d = checkDraft(draft({ headline: "<i>Bungalow</i>", description: `<p>${BODY}</p>`, highlights: [{ text: "**Fenced yard**", factKey: "feature" }] }), ctx);
    expect(d.headline).toBe("Bungalow");
    expect(d.description).not.toMatch(/[<>]/);
    expect(d.highlights[0].text).toBe("Fenced yard");
  });
});

describe("the demo fixture", () => {
  const fixture = demoFixtures["listing-description"] as DraftOutput;
  it("passes every check for the seeded bungalow when the demo photo was sent", () => {
    const d = checkDraft(fixture, { facts, agentNotes: "", sentPhotoIds: [DEMO_LIVING_ROOM_PHOTO_ID] });
    expect(d.flags).toEqual([]);
    expect(d.dropped).toEqual({ highlights: [], photoSuggestions: [] });
    expect(d.photoSuggestions).toEqual([{ feature: "Built-in shelving", photoId: DEMO_LIVING_ROOM_PHOTO_ID }]);
  });
  it("is flagged honestly against a different listing", () => {
    const d = checkDraft(fixture, { facts: { ...facts, beds: 4, yearBuilt: 1999, features: [] }, agentNotes: "", sentPhotoIds: [PHOTO] });
    expect(d.flags.map((f) => f.code)).toContain("unverified_number");
    expect(d.dropped.highlights.map((h) => h.text)).toEqual(["Fenced yard"]);
    expect(d.dropped.photoSuggestions).toHaveLength(1);
  });
});
