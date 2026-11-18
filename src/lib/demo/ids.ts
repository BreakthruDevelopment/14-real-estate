/**
 * Fixed ids for the seeded demo listing ("Craftsman bungalow near Zilker") and its living-room photo. The AI demo
 * fixture (`src/lib/ai/demo.ts`) names the photo, so a seed that uses these exact ids makes the fixture's photo
 * suggestion pass the server's photo check. Created in 14.5; the demo seed (14.10) inserts rows with exactly these ids.
 * Valid version-4 UUIDs, so `z.string().uuid()` accepts them.
 */
export const DEMO_BUNGALOW_LISTING_ID = "14000000-0000-4000-8000-0000000000b1";
export const DEMO_LIVING_ROOM_PHOTO_ID = "14000000-0000-4000-8000-0000000000c1";
