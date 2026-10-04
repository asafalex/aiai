// Supabase Edge Function: generate-video (ModelsLab wan2.2)
// Deploy: supabase functions deploy generate-video --no-verify-jwt --project-ref mlrhoqapzmmjvtevclkf

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VIDEO_URL = "https://modelslab.com/api/v6/video/text2video_ultra";
const POLL_DELAY_MS = 3000;
const MAX_POLL_ATTEMPTS = 55; // ~165s

const SAFETY_NEGATIVE_PROMPT =
  "(child:1.5), ((((underage)))), ((((child)))), (((kid))), (((preteen))), (teen:1.5)";

const QUALITY_NEGATIVE_PROMPT =
  "blurry, low quality, distorted, extra limbs, missing limbs, broken fingers, deformed, glitch, artifacts, " +
  "unrealistic, low resolution, bad anatomy, duplicate, cropped, watermark, text, logo, jpeg artifacts, noisy, " +
  "oversaturated, underexposed, overexposed, flicker, unstable motion, motion blur, stretched, mutated, " +
  "out of frame, bad proportions";

const PROMPT_PREFIX = "zero clothing";

const MODELSLAB_API_KEY = Deno.env.get("MODELSLAB_API_KEY") ?? "";

function withPromptPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().startsWith(PROMPT_PREFIX)) return trimmed;
  return `${PROMPT_PREFIX}, ${trimmed}`;
}

function pickVideoUrl(data: Record<string, unknown>): string | null {
  if (!data) return null;
  const links = data.links as string[] | undefined;
  const proxy = data.proxy_links as string[] | undefined;
  const meta = data.meta as { output?: string[] } | undefined;
  if (links?.[0]) return links[0];
  if (proxy?.[0]) return proxy[0];
  if (meta?.output?.[0]) return meta.output[0];
  const output = data.output as string[] | undefined;
  if (output?.[0]) return output[0];
  return null;
}

async function pollResult(fetchUrl: string) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
    const res = await fetch(fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: MODELSLAB_API_KEY }),
    });
    const data = await res.json();
    const status = (data.status || "").toString().toLowerCase();
    if (status === "success") return data;
    if (status !== "processing" && status !== "queued") {
      throw new Error(data.message || data.error || "Video generation failed");
    }
  }
  throw new Error("Video generation timed out. Try again in a moment.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const prompt = withPromptPrefix((body.prompt || "").toString());
    if (!prompt) {
      return new Response(JSON.stringify({ status: "error", message: "prompt is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!MODELSLAB_API_KEY) {
      throw new Error("Server misconfigured: MODELSLAB_API_KEY not set");
    }

    const modelId = (body.model_id || "wan2.2").toString();
    const portrait = body.portrait !== undefined ? Boolean(body.portrait) : true;
    const callerNegative = body.negative_prompt ? String(body.negative_prompt).trim() : "";
    const negativePrompt = [SAFETY_NEGATIVE_PROMPT, QUALITY_NEGATIVE_PROMPT, callerNegative]
      .filter(Boolean)
      .join(", ");
    const numFrames = String(body.num_frames ?? "81");
    const fps = String(body.fps ?? "16");
    const resolution = Number(body.resolution) || 480;

    const payload = {
      key: MODELSLAB_API_KEY,
      model_id: modelId,
      prompt,
      negative_prompt: negativePrompt,
      portrait,
      output_type: "mp4",
      num_frames: numFrames,
      fps,
      resolution,
      num_inference_steps: 8,
      guidance_scale: 1,
    };

    const res = await fetch(VIDEO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = await res.json();
    const initialStatus = (data.status || "").toString().toLowerCase();
    let videoUrl = pickVideoUrl(data);

    if (initialStatus !== "success" || !videoUrl) {
      const fetchUrl = data.fetch_result || data.fetchResult;
      if (fetchUrl) {
        data = await pollResult(String(fetchUrl));
        videoUrl = pickVideoUrl(data);
      } else if (initialStatus !== "success") {
        throw new Error(data.message || data.error || "Video API error");
      }
    }

    if (!videoUrl) {
      throw new Error("No video URL in API response");
    }

    return new Response(
      JSON.stringify({
        status: "success",
        video_url: videoUrl,
        links: data.links,
        proxy_links: data.proxy_links,
        meta: data.meta,
        eta: data.eta,
        taskId: data.taskId ?? data.id,
        upstream: data,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Video generation error";
    return new Response(JSON.stringify({ status: "error", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
