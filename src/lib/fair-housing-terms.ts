/**
 * Fair-housing screening data: phrases flagged in listing copy, and phrases masked out first so ordinary copy is not
 * refused. Pure data, no code that talks to a database. The matcher is in `description-checks.ts`.
 *
 * THIS IS A SCREENING AID, NOT LEGAL ADVICE. It catches explicit statements of preference or exclusion. It does not
 * catch everything (see "Known limits" in `description-checks.ts`) and it cannot judge context.
 *
 * ## Where the terms come from
 *
 * Every entry carries `sources`, keys into `SOURCES` below.
 *
 * - `FHA_3604C` and `CFR_100_75` are the LAW: the Fair Housing Act forbids an advertisement that "indicates any
 *   preference, limitation, or discrimination" because of race, color, religion, sex, handicap, familial status or
 *   national origin. Every flagged phrase below is a direct statement of such a preference or exclusion, a phrase
 *   whose plain meaning is "this dwelling is (not) for people of class X". That is the basis for the flag.
 * - `HUD_1995` is HUD's advertising guidance, the document the spec starts from. HUD's memo organises its examples by
 *   the same seven categories.
 *
 * ## What was NOT verified (read this before trusting the list)
 *
 * The primary documents (hud.gov, eCFR, govinfo) were NOT reachable from the build sandbox (egress policy answered
 * 403), so no phrase here was checked word-for-word against the HUD memo or the CFR text. The CATEGORY and the legal
 * basis of each entry are the statute's own; the exact PHRASES are the builder's selection of unambiguous
 * exclusion/preference statements within those categories, and the allow-list phrases are those the spec attributes to
 * HUD's guidance. `SOURCE_VERIFICATION` records this so a test and the PR can both say so. A human should compare the
 * list with the HUD memo, and extend it, before the app is shown as a compliance aid.
 *
 * Deliberately left OUT, because no source could be pointed to and the false-positive cost is high:
 * - single words of any kind (a single word is too often ordinary copy, and none could be sourced), for example
 *   "newlyweds".
 * - bare "family", "families", "kids", "children", "church", "master", "walk": all appear in ordinary copy.
 * - age terms ("seniors", "55+", "retirees"): age is not a federal class, and "housing for older persons" is a
 *   statutory exemption (42 U.S.C. § 3607(b)).
 * - "adult community": same exemption.
 * - phrases that depend on the surrounding sentence (a mosque or school "nearby", "safe neighborhood", "exclusive").
 * - shared-living sex preferences are an exemption (42 U.S.C. § 3603(b)(2)); the sex phrases below are flagged anyway
 *   because this app lists whole dwellings.
 */

export const CATEGORIES = ["race", "color", "national_origin", "religion", "sex", "familial_status", "disability"] as const;
export type Category = (typeof CATEGORIES)[number];

export type SourceKey = "FHA_3604C" | "CFR_100_75" | "HUD_1995" | "SPEC_ATTRIBUTION";

export const SOURCES: Record<SourceKey, { doc: string; cite: string }> = {
  FHA_3604C: {
    doc: "Fair Housing Act, 42 U.S.C. § 3604(c)",
    cite: "unlawful to make, print or publish any notice, statement or advertisement with respect to the sale or rental of a dwelling that indicates any preference, limitation, or discrimination based on race, color, religion, sex, handicap, familial status, or national origin",
  },
  CFR_100_75: {
    doc: "24 CFR § 100.75, Discriminatory notices, statements and advertisements",
    cite: "paragraph (c)(1): using words, phrases, photographs, illustrations, symbols or forms which convey that dwellings are available or not available to a particular group of persons because of a protected class",
  },
  HUD_1995: {
    doc: "HUD, Guidance Regarding Advertisements under Section 804(c) of the Fair Housing Act (FHEO memorandum, 1995)",
    cite: "examples of words and phrases by category; also the phrases it treats as acceptable descriptions of the property",
  },
  SPEC_ATTRIBUTION: {
    doc: "ai-dev-os specs/14-real-estate.md, 'AI feature', Fair housing",
    cite: "names this phrase as one HUD's guidance accepts; the HUD text itself was not reachable from the build sandbox",
  },
};

export const SOURCE_VERIFICATION = {
  checkedAgainstPrimaryText: false,
  reason: "hud.gov, ecfr.gov and govinfo.gov were blocked by the build sandbox's egress policy",
} as const;

export type FlaggedTerm = { phrase: string; category: Category; sources: readonly SourceKey[] };

const LAW = ["FHA_3604C", "CFR_100_75"] as const satisfies readonly SourceKey[];
const LAW_AND_HUD = ["FHA_3604C", "CFR_100_75", "HUD_1995"] as const satisfies readonly SourceKey[];

function terms(category: Category, sources: readonly SourceKey[], phrases: string[]): FlaggedTerm[] {
  return phrases.map((phrase) => ({ phrase, category, sources }));
}

/**
 * Flagged phrases. Matched on whole words after normalisation (case, punctuation, accents), so "No Kids!" and "no-kids"
 * match, and "no children's play area" does not (the apostrophe is removed, giving the word "childrens").
 */
export const FLAGGED_TERMS: readonly FlaggedTerm[] = [
  ...terms("race", LAW, ["whites only", "white only", "blacks only", "no blacks", "no minorities"]),
  ...terms("color", LAW, ["no colored people", "coloreds only"]),
  ...terms("national_origin", LAW, ["no foreigners", "no immigrants", "americans only", "no hispanics", "no mexicans", "no asians", "no arabs"]),
  ...terms("religion", LAW, ["christians only", "christian only", "catholics only", "jews only", "jewish only", "muslims only", "no jews", "no muslims", "no catholics"]),
  ...terms("sex", LAW, ["men only", "male only", "males only", "women only", "female only", "females only", "no men", "no women", "no females"]),
  ...terms("familial_status", LAW_AND_HUD, [
    "no children",
    "no kids",
    "no infants",
    "no babies",
    "no families",
    "adults only",
    "adult only",
    "singles only",
    "couples only",
    "young families",
    "young family",
    "young couple",
    "young couples",
    "growing family",
    "growing families",
    "empty nesters",
  ]),
  ...terms("disability", LAW, ["no wheelchairs", "no handicapped", "no disabled", "able bodied only", "no mentally ill", "no service animals", "no assistance animals"]),
];

export type AllowedPhrase = { phrase: string; sources: readonly SourceKey[] };

/**
 * Phrases masked out BEFORE the flagged terms are matched, so a flagged term that happens to sit inside an ordinary
 * phrase does not refuse ordinary copy. The spec names these six as accepted by HUD's guidance. The attribution is the
 * spec's; the HUD text was not checked (see `SOURCE_VERIFICATION`). "walk-in closet" contains no protected-class
 * word; it is here because the issue names it as a phrase that must be accepted.
 *
 * With today's flagged list none of these phrases overlaps a flagged term, so the mask changes no result yet. It is
 * kept (and tested with an injected overlapping list) so that growing the flagged list later cannot silently start
 * refusing "family room".
 */
export const ALLOWED_PHRASES: readonly AllowedPhrase[] = [
  { phrase: "family room", sources: ["SPEC_ATTRIBUTION", "HUD_1995"] },
  { phrase: "walk-in closet", sources: ["SPEC_ATTRIBUTION"] },
  { phrase: "master bedroom", sources: ["SPEC_ATTRIBUTION", "HUD_1995"] },
  { phrase: "great view", sources: ["SPEC_ATTRIBUTION", "HUD_1995"] },
  { phrase: "walking distance", sources: ["SPEC_ATTRIBUTION", "HUD_1995"] },
  { phrase: "jogging trails", sources: ["SPEC_ATTRIBUTION", "HUD_1995"] },
];
