import { z } from "zod";

/**
 * Every setting the app reads, validated in one place.
 * Read lazily so `next build` works without production secrets.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("30 Apps Template"),
  // The public URL, e.g. https://app7.breakthruventures.ai. Sign-in callbacks,
  // cookies and CORS all derive from it, so a domain change never touches code.
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // "demo" serves recorded answers, so demos never break on a quota.
  AI_PROVIDER: z.enum(["gemini", "anthropic", "demo"]).default("demo"),
  AI_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Fall back to demo answers when the live provider fails (quota, outage).
  AI_FALLBACK_TO_DEMO: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Embedding model for embed(). Confirm the name on the day (see README, "Embeddings").
  AI_EMBED_MODEL: z.string().optional(),
  // Provider call timeout. 20 s keeps AI calls inside Lambda's 29 s limit (route maxDuration is 25 s).
  AI_TIMEOUT_MS: z.coerce.number().int().positive().max(22000).default(20000),
  // Caps shown on /admin and enforced where the work happens (photos in 14.4, AI in 14.5, embeddings in 14.6).
  PHOTO_STORE_CAP_MB: z.coerce.number().int().positive().default(600),
  AI_DAILY_CAP: z.coerce.number().int().positive().default(200),
  EMBED_DOC_DAILY_CAP: z.coerce.number().int().positive().default(500),
  EMBED_QUERY_DAILY_CAP: z.coerce.number().int().positive().default(1000),
  // Provisioned storage of the shared Postgres server, for the /admin "70% of the server" warning (Azure B1ms: 32 GB).
  DB_SERVER_STORAGE_GB: z.coerce.number().positive().default(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    // Cloud consoles and CI often set unused variables to "". Treat those as unset
    // so defaults apply instead of failing validation.
    const present = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
    );
    const parsed = schema.safeParse(present);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
