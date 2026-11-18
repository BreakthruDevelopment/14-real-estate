import { DEMO_LIVING_ROOM_PHOTO_ID } from "@/lib/demo/ids";
import type { DemoToolScript } from "./types";

/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // The seeded listing "Craftsman bungalow near Zilker" (3 bed, 2 bath, 1,640 sqft, 1938, fenced yard, home office).
  // Built only from those facts (no street, no neighborhood). Against any other listing the server's number and feature checks flag what differs.
  "listing-description": {
    headline: "Recorded demo: 1938 Craftsman with a fenced yard",
    description:
      "Built in 1938, this Craftsman bungalow offers 3 bedrooms and 2 bathrooms across 1,640 square feet. Its 1938 construction gives the house a traditional Craftsman character.\n\nA dedicated home office gives you a place to work without giving up a bedroom. Outside, the fenced yard gives the property a private outdoor space.\n\nThe home is in Austin, Texas. Schedule a showing to see the home in person.",
    highlights: [
      { text: "3 bedrooms", factKey: "beds" },
      { text: "Built in 1938", factKey: "year" },
      { text: "Fenced yard", factKey: "feature" },
    ],
    photoSuggestions: [{ feature: "Built-in shelving", photoId: DEMO_LIVING_ROOM_PHOTO_ID }],
    needsHumanBecause: null,
  },
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
};

/**
 * Scripted tool loops for tasks that use `generate({ tools })`, keyed by task name. A script is a function
 * of the caller's `demoContext`; the loop runs the real handlers for each step, then `final` builds the
 * answer from their results. Keep `args` valid for the real tool schemas.
 */
export const demoToolScripts: Record<string, (ctx: unknown) => DemoToolScript> = {
  // Example for the README: an assistant that looks items up, then answers.
  "items-assistant": (ctx) => {
    const query = typeof (ctx as { query?: unknown } | undefined)?.query === "string" ? (ctx as { query: string }).query : "setup";
    return {
      steps: [{ call: { name: "search_items", args: { query } } }],
      final: (results) => {
        const found = results[0]?.ok && Array.isArray(results[0].data) ? results[0].data.length : 0;
        return { reply: `Demo assistant (recorded): I found ${found} matching item${found === 1 ? "" : "s"}.`, matches: found };
      },
    };
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
