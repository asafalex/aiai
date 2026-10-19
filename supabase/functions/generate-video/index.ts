// Supabase Edge Function: generate-video (ModelsLab text2video_ultra / wan2.2)
// Deploy: supabase functions deploy generate-video --no-verify-jwt --project-ref mlrhoqapzmmjvtevclkf

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TEXT2VIDEO_URL = "https://modelslab.com/api/v6/video/text2video_ultra";
const DEFAULT_MODEL_ID = "wan2.2";

const SAFETY_NEGATIVE_PROMPT =
  "(child:1.5), ((((underage)))), ((((child)))), (((kid))), (((preteen))), (teen:1.5)";

const MODELSLAB_API_KEY = Deno.env.get("MODELSLAB_API_KEY") ?? "";

function videoUrlFromPayload(data: Record<string, unknown>): string | null {
  const output = data.output;
  if (Array.isArray(output) && output[0]) return String(output[0]);
  const proxy = data.proxy_links;
  if (Array.isArray(proxy) && proxy[0]) return String(proxy[0]);
  const future = data.future_links;
  if (Array.isArray(future) && future[0]) return String(future[0]);
  return null;
}

async function fetchModelsLabResult(fetchUrl: string) {
  const res = await fetch(fetchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: MODELSLAB_API_KEY }),
  });
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (!MODELSLAB_API_KEY) {
      throw new Error("Server misconfigured: MODELSLAB_API_KEY not set");
    }

    const body = await req.json();
    const fetchResult = body.fetch_result ? String(body.fetch_result).trim() : "";

    if (fetchResult) {
      const data = await fetchModelsLabResult(fetchResult);
      if (data.status === "success") {
        const videoUrl = videoUrlFromPayload(data);
        if (!videoUrl) {
          return new Response(
            JSON.stringify({ status: "error", message: "No video URL in response" }),
            { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ status: "success", video_url: videoUrl }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (data.status === "processing") {
        return new Response(
          JSON.stringify({ status: "processing", fetch_result: data.fetch_result || fetchResult }),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      throw new Error(data.message || "Video generation failed");
    }

    const prompt = (body.prompt || "").toString().trim();
    if (!prompt) {
      return new Response(JSON.stringify({ status: "error", message: "prompt is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const modelId = (body.model_id || DEFAULT_MODEL_ID).toString().trim() || DEFAULT_MODEL_ID;
    const portrait = body.portrait === true || body.portrait === "true";
    const numFrames = (body.num_frames ?? "81").toString();
    const fps = (body.fps ?? "16").toString();
    const callerNegative = body.negative_prompt ? String(body.negative_prompt).trim() : "";
    const negativePrompt = [SAFETY_NEGATIVE_PROMPT, callerNegative].filter(Boolean).join(", ");

    const payload: Record<string, unknown> = {
      key: MODELSLAB_API_KEY,
      model_id: modelId,
      prompt,
      negative_prompt: negativePrompt,
      num_frames: numFrames,
      fps,
    };
    if (portrait) payload.portrait = true;

    const res = await fetch(TEXT2VIDEO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (data.status === "success") {
      const videoUrl = videoUrlFromPayload(data);
      if (!videoUrl) throw new Error("No video URL in response");
      return new Response(JSON.stringify({ status: "success", video_url: videoUrl }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (data.status === "processing" && data.fetch_result) {
      return new Response(
        JSON.stringify({ status: "processing", fetch_result: data.fetch_result }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    throw new Error(data.message || "Video generation failed");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Video generation failed";
    return new Response(JSON.stringify({ status: "error", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
