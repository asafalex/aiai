// Supabase Edge Function: generate-image
// Deploy with: supabase functions deploy generate-image --no-verify-jwt
// Requires secret: supabase secrets set MODELSLAB_API_KEY=your_key_here

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL_ID = "z-image-turbo";
const TEXT2IMG_URL = "https://modelslab.com/api/v6/images/text2img";
const POLL_DELAY_MS = 3000;
const MAX_POLL_ATTEMPTS = 28; // ~84s of polling on top of the initial request

// These terms are ModelsLab's own default safety guardrail for this model (confirmed via
// their API response metadata) and must always be included, regardless of what a caller
// sends — never let a client-supplied negative_prompt drop or replace them.
const SAFETY_NEGATIVE_PROMPT =
  "(child:1.5), ((((underage)))), ((((child)))), (((kid))), (((preteen))), (teen:1.5)";

const QUALITY_NEGATIVE_PROMPT =
  "blurry, deformed, disfigured, bad anatomy, extra limbs, extra fingers, " +
  "mutated hands, poorly drawn face, low quality, low resolution, watermark, " +
  "text, logo, signature, cropped, out of frame, duplicate, ugly";

const MODELSLAB_API_KEY = Deno.env.get("MODELSLAB_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function pollResult(fetchUrl: string) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
    const res = await fetch(fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: MODELSLAB_API_KEY }),
    });
    const data = await res.json();
    if (data.status === "success") return data;
    if (data.status !== "processing") {
      throw new Error(data.message || "אירעה שגיאה ביצירת התמונה");
    }
  }
  throw new Error("תם הזמן הקצוב ליצירת התמונה");
}

async function logGeneration(row: {
  visitor_id: string | null;
  prompt: string;
  negative_prompt: string | null;
  image_url: string | null;
  status: "success" | "error" | "timeout";
  error_message: string | null;
  duration_ms: number;
}) {
  const { error } = await supabase.from("generations").insert(row);
  if (error) {
    console.error("generations insert failed:", error.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const startedAt = Date.now();
  let prompt = "";
  let fullPrompt = "";
  let negativePrompt = "";
  let visitorId: string | null = null;

  try {
    const body = await req.json();
    prompt = (body.prompt || "").toString().trim();
    visitorId = body.visitor_id ? String(body.visitor_id) : null;
    const callerNegativePrompt = body.negative_prompt ? String(body.negative_prompt).trim() : "";

    if (!prompt) {
      return new Response(JSON.stringify({ status: "error", message: "prompt is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!MODELSLAB_API_KEY) {
      throw new Error("Server misconfigured: MODELSLAB_API_KEY not set");
    }

    const { data: settings } = await supabase
      .from("app_settings")
      .select("positive_prompt, negative_prompt")
      .eq("id", 1)
      .maybeSingle();

    const adminPositivePrompt = settings?.positive_prompt?.trim() || "";
    const adminNegativePrompt = settings?.negative_prompt?.trim() || "";

    fullPrompt = adminPositivePrompt ? `${adminPositivePrompt} ${prompt}` : prompt;
    negativePrompt = [
      SAFETY_NEGATIVE_PROMPT,
      QUALITY_NEGATIVE_PROMPT,
      adminNegativePrompt,
      callerNegativePrompt,
    ]
      .filter(Boolean)
      .join(", ");

    const res = await fetch(TEXT2IMG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: MODELSLAB_API_KEY,
        model_id: MODEL_ID,
        prompt: fullPrompt,
        negative_prompt: negativePrompt,
        width: "1024",
        height: "1024",
        samples: "1",
      }),
    });

    const data = await res.json();
    let finalData = data;

    if (data.status === "processing") {
      finalData = await pollResult(data.fetch_result);
    } else if (data.status !== "success") {
      throw new Error(data.message || "אירעה שגיאה ביצירת התמונה");
    }

    const imageUrl =
      (finalData.output && finalData.output[0]) ||
      (finalData.proxy_links && finalData.proxy_links[0]);

    if (!imageUrl) throw new Error("לא התקבלה תמונה מהשרת");

    try {
      const { data: existing } = await supabase
        .from("gallery_images")
        .select("id")
        .eq("image_url", imageUrl)
        .maybeSingle();
      if (!existing) {
        await supabase.from("gallery_images").insert({
          image_url: imageUrl,
          description: prompt.slice(0, 500),
          base_likes: 0,
        });
      }
    } catch (_e) {
      // gallery insert failure shouldn't break the user-facing response
    }

    await logGeneration({
      visitor_id: visitorId,
      prompt: fullPrompt,
      negative_prompt: negativePrompt || null,
      image_url: imageUrl,
      status: "success",
      error_message: null,
      duration_ms: Date.now() - startedAt,
    });

    return new Response(JSON.stringify({ status: "success", image_url: imageUrl }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "אירעה שגיאה ביצירת התמונה";
    const isTimeout = message.includes("תם הזמן");

    await logGeneration({
      visitor_id: visitorId,
      prompt: fullPrompt || prompt || "(empty)",
      negative_prompt: negativePrompt || null,
      image_url: null,
      status: isTimeout ? "timeout" : "error",
      error_message: message,
      duration_ms: Date.now() - startedAt,
    });

    return new Response(JSON.stringify({ status: "error", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
