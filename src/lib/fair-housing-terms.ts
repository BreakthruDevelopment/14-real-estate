/**
 * Fair-housing screening data: phrases flagged in listing copy, and phrases masked out first so ordinary copy is not
 * refused. Pure data, no code that talks to a database. The matcher is in `description-checks.ts`.
 *
 * THIS IS A SCREENING AID, NOT LEGAL ADVICE. It catches explicit statements of preference or exclusion. It does not
 * catch everything (see "Known limits" in `description-checks.ts`) and it cannot judge context.
 *
 * ## What this list is, and is not
 *
 * It is a screening aid derived from the statute's seven protected classes and HUD's guidance. It is NOT a
 * reproduction of a HUD list, because HUD no longer publishes one. HUD's famous "words to avoid" list was in 24 CFR
 * Part 109 (Advertising Guidelines, section 109.20), and Part 109 was REMOVED effective 1996-05-01 (61 FR 14378, 1 April
 * 1996: "Part 109 is removed"; HUD said it would give the material through handbook guidance or other materials rather
 * than keep it in the CFR). Published "fair housing words" sheets that cite 24 CFR 109.20 as live authority are wrong,
 * and nothing here cites it. No implementation can claim to match a current HUD list: none exists.
 *
 * ## Where the terms come from
 *
 * Every entry carries `sources`, keys into `SOURCES` below.
 *
 * - `FHA_3604C` and `CFR_100_75` are the live LAW: the Fair Housing Act forbids an advertisement that "indicates any
 *   preference, limitation, or discrimination" because of race, color, religion, sex, handicap, familial status or
 *   national origin. Each flagged phrase below is a statement whose usual meaning is "this dwelling is (not) for
 *   people of class X". That is the basis for the flag.
 *   THE EXACT PHRASES ARE THE BUILDER'S SELECTION within those categories. They are not quotations from any HUD
 *   document, and they are not all unambiguous: "adults only" can describe a pool, "no men" a sentence about a
 *   room. They are chosen to be the plural or people forms ("whites only", not "white only", which names a paint
 *   colour in "white only on the trim"). A refusal can therefore be a false positive; it names the phrase so the agent
 *   can rephrase. HUD_1995 is deliberately NOT a source for any flagged phrase: the memo, as reported, says what should
 *   not ground complaints, and supports nothing about a phrase being flaggable. It sources only the allow-list.
 * - `HUD_1995` is the 9 January 1995 memorandum of Roberta Achtenberg (Assistant Secretary for Fair Housing and Equal
 *   Opportunity) on section 804(c) advertising. Per a published fair-housing publisher's guide (a SECONDARY source;
 *   HUD's own text was not read by either author), it says facially neutral terms including "master bedroom", "rare
 *   find" and "desirable neighborhood" should not be the basis of complaints, and that "mother-in-law suite" and
 *   "bachelor apartment" do not violate the Act. That is why bare "master" is not flagged: flagging it would be a
 *   false positive against named HUD guidance.
 *
 * ## Confidence, by claim (see `SOURCE_VERIFICATION`)
 *
 * - Removal of 24 CFR Part 109 (61 FR 14378): read by the coordinator in the Federal Register document itself. I (the
 *   builder) could not reach it from the sandbox, so for me this is reported, not read.
 * - HUD's 1995 memo: quoted from a secondary source only. NOT checked against HUD's text.
 * - The allow-list phrases other than "master bedroom": the spec attributes them to HUD's guidance; not verified.
 * - The flagged phrases: not from a HUD list at all (see above).
 * A human should compare the list with HUD's own text, and extend it, before the app is shown as a compliance aid.
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
    doc: "HUD, Guidance Regarding Advertisements under Section 804(c) of the Fair Housing Act (Achtenberg memorandum, 9 January 1995). QUOTED FROM A SECONDARY SOURCE, not from HUD's text",
    cite: "facially neutral terms such as \"master bedroom\", \"rare find\" and \"desirable neighborhood\" should not be the basis of complaints; \"mother-in-law suite\" and \"bachelor apartment\" do not violate the Act",
  },
  SPEC_ATTRIBUTION: {
    doc: "ai-dev-os specs/14-real-estate.md, 'AI feature', Fair housing",
    cite: "names this phrase as one HUD's guidance accepts; the HUD text itself was not reachable from the build sandbox",
  },
};

export const SOURCE_VERIFICATION = {
  /** HUD's own 1995 memo text: not read by anyone on this project. The memo is quoted from a secondary source. */
  checkedAgainstPrimaryText: false,
  hud1995MemoSource: "secondary (a published fair-housing publisher's guide)",
  /** 61 FR 14378 (1 April 1996) removed 24 CFR Part 109, HUD's word list. Read directly in the Federal Register document by the coordinator. */
  part109RemovalVerifiedInFederalRegister: true,
  /** No current HUD-published list of forbidden words exists, so the flagged phrases are the builder's selection. */
  flaggedPhrasesAreFromAHudList: false,
  reason: "hud.gov, ecfr.gov and govinfo.gov were blocked from the build sandbox; HUD's own memo text was not read by anyone here",
} as const;

export type FlaggedTerm = { phrase: string; category: Category; sources: readonly SourceKey[] };

const LAW = ["FHA_3604C", "CFR_100_75"] as const satisfies readonly SourceKey[];

function terms(category: Category, sources: readonly SourceKey[], phrases: string[]): FlaggedTerm[] {
  return phrases.map((phrase) => ({ phrase, category, sources }));
}

/**
 * Flagged phrases. Matched on whole words after normalisation (case, punctuation, accents, look-alike letters), so "No Kids!" and
 * "no-kids" match, "no children's play area" does not (the apostrophe is removed, giving the word "childrens"), and a
 * phrase never spans a sentence end ("HOA fees? No. Families will love it").
 */
export const FLAGGED_TERMS: readonly FlaggedTerm[] = [
  ...terms("race", LAW, ["whites only", "blacks only", "no blacks", "no minorities"]),
  ...terms("color", LAW, ["no colored people", "coloreds only"]),
  ...terms("national_origin", LAW, ["no foreigners", "no immigrants", "americans only", "no hispanics", "no mexicans", "no asians", "no arabs"]),
  ...terms("religion", LAW, ["christians only", "christian only", "catholics only", "jews only", "jewish only", "muslims only", "no jews", "no muslims", "no catholics"]),
  ...terms("sex", LAW, ["men only", "male only", "males only", "women only", "female only", "females only", "no men", "no women", "no females"]),
  ...terms("familial_status", LAW, [
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
 * phrase does not refuse ordinary copy. The spec names these six as accepted by HUD's guidance. Only "master bedroom" is
 * named in the 1995 memo as reported by the secondary source; the rest are the spec's attribution. HUD's text was not
 * checked (see `SOURCE_VERIFICATION`). "walk-in closet" contains no protected-class
 * word; it is here because the issue names it as a phrase that must be accepted.
 *
 * With today's flagged list none of these phrases overlaps a flagged term, so the mask changes no result yet. It is
 * kept (and tested with an injected overlapping list) so that growing the flagged list later cannot silently start
 * refusing "family room".
 */
export const ALLOWED_PHRASES: readonly AllowedPhrase[] = [
  { phrase: "family room", sources: ["SPEC_ATTRIBUTION"] },
  { phrase: "walk-in closet", sources: ["SPEC_ATTRIBUTION"] },
  { phrase: "master bedroom", sources: ["HUD_1995", "SPEC_ATTRIBUTION"] },
  { phrase: "great view", sources: ["SPEC_ATTRIBUTION"] },
  { phrase: "walking distance", sources: ["SPEC_ATTRIBUTION"] },
  { phrase: "jogging trails", sources: ["SPEC_ATTRIBUTION"] },
];
