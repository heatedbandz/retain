import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = process.env.RETAIN_MODEL || "claude-opus-5-5";
const DAILY_LIMIT = Number(process.env.RETAIN_DAILY_AI_LIMIT || 80);
const MAX_TOTAL_CHARS = 200_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const anthropic = new Anthropic();

const SYSTEM = `You are the AI inside Retain, a study app for students aged 13 and up. The student's request, and the app's instructions for this feature, are in the user turn.
Help the student understand and learn their schoolwork. Be accurate, encouraging and age-appropriate.
Stay focused on learning. If a request isn't about school or learning, help briefly and steer back.
Never write a whole essay, assignment or take-home test for them to hand in; help them plan, outline and improve their own work instead.
If a student says something that suggests they're in danger or being hurt, respond with care and encourage them to talk to a trusted adult; in the US they can call or text 988.`;

type Tier = "quick" | "default" | "complex";
const TIERS: Record<Tier, { effort: "low" | "medium" | "high"; maxTokens: number }> = {
  quick: { effort: "low", maxTokens: 2000 },
  default: { effort: "medium", maxTokens: 16000 },
  complex: { effort: "high", maxTokens: 32000 }
};

function fail(code: string, status: number, message: string) {
  return Response.json({ code, message }, { status });
}

type InTurn = { role: "user" | "assistant"; content: string };
type InImage = { media_type: string; data: string };

function validate(body: unknown): { messages: InTurn[]; images: InImage[]; tier: Tier; json: boolean } | string {
  if (!body || typeof body !== "object") return "Body must be an object";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 80) return "messages must be a list of 1 to 80 turns";
  let total = 0;
  const messages: InTurn[] = [];
  for (const m of b.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) return "Each turn needs a role and text";
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > MAX_TOTAL_CHARS) return "too_large";
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return "Turns must start and end with the student";
  const images: InImage[] = [];
  if (b.images !== undefined) {
    if (!Array.isArray(b.images) || b.images.length > 3) return "At most 3 images";
    for (const im of b.images) {
      if (!im || !IMAGE_TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > 6_000_000) return "image_rejected";
      images.push({ media_type: im.media_type, data: im.data });
    }
  }
  const tier: Tier = b.tier === "quick" || b.tier === "complex" ? b.tier : "default";
  return { messages, images, tier, json: b.json === true };
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return fail("session_expired", 401, "Sign in again.");

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData } = await supabase.auth.getUser(auth.slice(7));
  if (!userData.user) return fail("session_expired", 401, "Sign in again.");

  let body: unknown;
  try { body = await req.json(); } catch { return fail("invalid_request", 400, "Body must be JSON"); }
  const input = validate(body);
  if (typeof input === "string") {
    if (input === "too_large") return fail("prompt_too_large", 413, "Too much text in one request");
    if (input === "image_rejected") return fail("image_rejected", 400, "Unsupported or oversized image");
    return fail("invalid_request", 400, input);
  }

  // Counts this request against the student's daily limit (see supabase/schema.sql).
  const { data: used, error: usageError } = await supabase.rpc("bump_ai_usage");
  if (usageError) return fail("upstream_error", 500, "Couldn't check usage");
  if (typeof used === "number" && used > DAILY_LIMIT) return fail("rate_limited", 429, "Daily limit reached");

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = input.messages.map((m, i) => {
    const isLast = i === input.messages.length - 1;
    if (!isLast || !input.images.length) return { role: m.role, content: m.content };
    return {
      role: "user",
      content: [
        ...input.images.map(im => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: im.media_type as "image/jpeg", data: im.data }
        })),
        { type: "text" as const, text: m.content }
      ]
    };
  });

  const tier = TIERS[input.tier];
  const system = input.json
    ? SYSTEM + "\nThis reply will be parsed by the app. Reply with only the JSON value requested: no prose, no code fences."
    : SYSTEM;

  // Opus 5.5 always thinks; effort controls how much. Server-side fallback reroutes a refused request
  // to another model instead of failing it outright.
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: tier.maxTokens,
    output_config: { effort: tier.effort },
    system,
    messages,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default"
  });

  const encoder = new TextEncoder();
  const body$ = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: object) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ d: event.delta.text });
        }
        const final = await stream.finalMessage();
        send({ stop: final.stop_reason });
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError) { controller.close(); return; }
        console.error("ai stream failed", e);
        send({ error: e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError ? "busy" : "upstream_error" });
      }
      controller.close();
    },
    cancel() { stream.abort(); }
  });

  return new Response(body$, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
