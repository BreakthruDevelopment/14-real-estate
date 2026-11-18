import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetEnvCache } from "@/lib/env";
import { type AiImage, AiError, MAX_IMAGE_BYTES, generate } from "./index";
import { anthropicProvider, geminiProvider } from "./providers";

const schema = z.object({ summary: z.string(), highlights: z.array(z.string()) });
/** The first bytes of a real file of each type, so the magic-byte check passes; the rest is filler. */
const MAGIC: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  "image/heic": [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
  "image/heif": [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31],
};
const b64 = (bytes: number, type = "image/png") => {
  const buf = Buffer.alloc(bytes, 1);
  Buffer.from(MAGIC[type] ?? []).copy(buf, 0, 0, Math.min(bytes, (MAGIC[type] ?? []).length));
  return buf.toString("base64");
};
const img = (bytes = 12, mimeType: AiImage["mimeType"] = "image/png"): AiImage => ({ mimeType, data: b64(bytes, mimeType) });

function setEnv(extra: Record<string, string>) {
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "");
  for (const [k, v] of Object.entries({
    DATABASE_URL: "postgres://unused",
    BETTER_AUTH_SECRET: "x".repeat(32),
    LOG_LEVEL: "info",
    ...extra,
  })) vi.stubEnv(k, v);
  resetEnvCache();
}

beforeEach(() => setEnv({ AI_PROVIDER: "demo" }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEnvCache();
});

const geminiOk = new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"s","highlights":[]}' }] } }] }),
  { status: 200 },
);
const anthropicOk = () =>
  new Response(JSON.stringify({ content: [{ type: "text", text: '{"summary":"s","highlights":[]}' }] }), { status: 200 });

describe("provider request bodies", () => {
  it("gemini: inlineData parts first, then the text part, config kept", async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOk.clone());
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = [img(12, "image/jpeg"), img(9, "image/heic")];
    await geminiProvider("k", "gemini-flash-lite-latest").complete({
      system: "s",
      prompt: "read it",
      maxOutputTokens: 800,
      images: [a, b],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: a.data } },
          { inlineData: { mimeType: "image/heic", data: b.data } },
          { text: "read it" },
        ],
      },
    ]);
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  it("text-only requests are unchanged for both providers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => anthropicOk());
    vi.stubGlobal("fetch", fetchMock);
    await anthropicProvider("k", "m").complete({ system: "s", prompt: "p", maxOutputTokens: 5 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([{ role: "user", content: "p" }]);
    fetchMock.mockImplementation(async () => geminiOk.clone());
    await geminiProvider("k", "gemini-2.5-flash").complete({ system: "s", prompt: "p", maxOutputTokens: 5 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).contents).toEqual([{ role: "user", parts: [{ text: "p" }] }]);
  });

  it("anthropic: image blocks then text", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => anthropicOk());
    vi.stubGlobal("fetch", fetchMock);
    const a = img(12, "image/webp");
    await anthropicProvider("k", "m").complete({ system: "s", prompt: "read it", maxOutputTokens: 5, images: [a] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/webp", data: a.data } },
      { type: "text", text: "read it" },
    ]);
  });

  it("anthropic: HEIC and HEIF are rejected without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const t of ["image/heic", "image/heif"] as const) {
      await expect(
        anthropicProvider("k", "m").complete({ system: "s", prompt: "p", maxOutputTokens: 5, images: [img(12, t)] }),
      ).rejects.toMatchObject({ kind: "input_rejected" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generate() image caps", () => {
  const run = (images: AiImage[]) => generate({ task: "summarize-items", system: "s", prompt: "p", schema, images });

  beforeEach(() => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
  });

  async function rejected(images: AiImage[]) {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await run(images).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("input_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it("rejects more than 4 images", () => rejected(Array.from({ length: 5 }, () => img())));
  it("rejects an image over 5 MB decoded", () => rejected([img(MAX_IMAGE_BYTES + 1)]));
  it("rejects more than 10 MB in total", () => rejected([img(4_000_000), img(4_000_000), img(4_000_000)]));
  it("rejects a MIME type outside the allow-list", () =>
    rejected([{ mimeType: "image/gif" as AiImage["mimeType"], data: b64(12) }]));
  it("rejects invalid base64, a data: URI and empty data", async () => {
    await rejected([{ mimeType: "image/png", data: "not base64!!" }]);
    await rejected([{ mimeType: "image/png", data: `data:image/png;base64,${b64(12)}` }]);
    await rejected([{ mimeType: "image/png", data: "abc" }]);
    await rejected([{ mimeType: "image/png", data: "" }]);
  });

  it("rejects bytes that are not the declared type, before anything is sent (issue 18)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString("base64");
    const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
    await rejected([{ mimeType: "image/png", data: pad(svg) }]); // SVG claimed as PNG
    await rejected([{ mimeType: "image/webp", data: pad(svg) }]);
    await rejected([{ mimeType: "image/png", data: b64(40, "image/jpeg") }]); // a real JPEG claimed as PNG
    await rejected([{ mimeType: "image/jpeg", data: b64(40, "image/webp") }]);
    await rejected([{ mimeType: "image/heic", data: b64(40, "image/png") }]);
    await rejected([{ mimeType: "image/png", data: Buffer.from("%PDF-1.7 not an image at all").toString("base64") }]);
  });

  it("accepts each allowed type when the bytes agree with it", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => geminiOk.clone());
    vi.stubGlobal("fetch", fetchMock);
    for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const) {
      await expect(run([img(40, t)])).resolves.toMatchObject({ demo: false });
    }
  });

  it("accepts two 5 MB images and four small ones", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => geminiOk.clone());
    vi.stubGlobal("fetch", fetchMock);
    await expect(run([img(MAX_IMAGE_BYTES), img(MAX_IMAGE_BYTES)])).resolves.toMatchObject({ demo: false });
    await expect(run([img(), img(), img(), img()])).resolves.toMatchObject({ demo: false });
  });

  it("rejects bad images even in demo mode", async () => {
    setEnv({ AI_PROVIDER: "demo" });
    await expect(run([{ mimeType: "image/png", data: "%%%" }])).rejects.toMatchObject({ kind: "input_rejected" });
    await expect(run([{ mimeType: "image/png", data: b64(40, "image/jpeg") }])).rejects.toMatchObject({ kind: "input_rejected" });
  });
});

describe("demo mode and logging", () => {
  it("answers from the fixture regardless of images", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await generate({ task: "summarize-items", system: "s", prompt: "p", schema, images: [img()] });
    expect(r.demo).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs image count and bytes but never the data", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => geminiOk.clone()));
    const out: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    }
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const a = img(300);
    await generate({ task: "summarize-items", system: "s", prompt: "p", schema, images: [a] });
    const text = out.join("\n");
    expect(text).toContain("ai.generate");
    expect(text).toContain('"images":1');
    expect(text).toContain('"imageBytes":300');
    expect(text).not.toContain(a.data);
  });
});
