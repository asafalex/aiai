// Telegram bot webhook — receives prompts, returns generated images.
// Deploy: supabase functions deploy telegram-bot --no-verify-jwt --project-ref mlrhoqapzmmjvtevclkf
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_ANON_KEY
// (SUPABASE_URL is auto-injected)

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const PROMPT_SUFFIX = ", solo woman alone, photorealistic, natural lighting, high detail";
const busyChats = new Set<number>();

type TgUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string };
  };
};

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Telegram ${method} failed:`, text);
  }
}

async function generateImage(prompt: string, visitorId: string): Promise<{ image_url?: string; message?: string }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      prompt: `${prompt}${PROMPT_SUFFIX}`,
      visitor_id: visitorId,
    }),
  });
  return res.json();
}

async function handleMessage(chatId: number, text: string, fromId?: number) {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed === "/start") {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "שלום! שלח/י תיאור באנגלית (prompt) ואני אחזיר תמונה שנוצרה ב-AI.\n\n" +
        "Hello! Send an English prompt describing the image you want (~20–90 seconds).",
    });
    return;
  }

  if (trimmed.startsWith("/")) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "פקודה לא מוכרת. שלח/י prompt כהודעה רגילה.\nUnknown command — send a plain text prompt.",
    });
    return;
  }

  if (busyChats.has(chatId)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "עדיין יוצרת תמונה… נסה/י שוב בעוד רגע.\nStill generating — please wait.",
    });
    return;
  }

  busyChats.add(chatId);
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "upload_photo" });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "יוצרת תמונה… זה יכול לקחת עד דקה.\nCreating your image…",
    });

    const visitorId = `telegram:${fromId ?? chatId}`;
    const data = await generateImage(trimmed, visitorId);

    if (data.image_url) {
      await tg("sendPhoto", {
        chat_id: chatId,
        photo: data.image_url,
        caption: "הנה התמונה שלך ✨",
      });
    } else {
      await tg("sendMessage", {
        chat_id: chatId,
        text: data.message || "לא הצלחתי ליצור תמונה. נסה/י שוב.\nCould not create the image.",
      });
    }
  } catch (e) {
    console.error(e);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "שגיאה זמנית בשרת. נסה/י שוב בעוד כמה שניות.\nTemporary server error.",
    });
  } finally {
    busyChats.delete(chatId);
  }
}

async function handleUpdate(update: TgUpdate) {
  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return;
  await handleMessage(msg.chat.id, msg.text, msg.from?.id);
}

function authorize(req: Request): boolean {
  if (!WEBHOOK_SECRET) return true;
  return req.headers.get("X-Telegram-Bot-Api-Secret-Token") === WEBHOOK_SECRET;
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return new Response("telegram-bot ok", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response("Server misconfigured", { status: 500 });
  }
  if (!authorize(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const work = handleUpdate(update);
  const edge = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (edge?.waitUntil) {
    edge.waitUntil(work);
    return new Response("OK");
  }
  await work;
  return new Response("OK");
});
