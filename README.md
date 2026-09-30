# AI Studio — AI Image Generator

A web app for generating AI images from text prompts, with a public gallery (likes, waitlist, advertiser inquiries) and an admin dashboard. Static frontend, Postgres backend via Supabase, image generation proxied through a Supabase Edge Function.

**Live site:** https://api-kappa-dusky-81.vercel.app/index.html
**Admin panel:** https://api-kappa-dusky-81.vercel.app/admin.html

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML + CSS + vanilla JavaScript (no framework, no build step) |
| Frontend hosting | [Vercel](https://vercel.com) (static file hosting) |
| Database | PostgreSQL via [Supabase](https://supabase.com) |
| Auth (admin only) | Supabase Auth (email/password) |
| Server-side logic | Supabase Edge Function — TypeScript running on Deno |
| Image generation | [ModelsLab](https://modelslab.com) API (`z-image-turbo` model) |
| Client library | `@supabase/supabase-js` v2, loaded from CDN |

Nothing here needs `npm install` or a build step — every HTML file is self-contained (markup, styles, and script all in one file) and can be opened/served as-is.

## Repository layout

```
index.html                              Public site: generator, gallery, waitlist, advertiser form
admin.html                              Admin dashboard (login-gated)
terms.html                              Terms of Use (static)
privacy.html                            Privacy Policy (static)
assets/gallery/                         Seed gallery images bundled with the site
supabase/schema.sql                     Full DB schema: tables, RLS policies, SQL functions, seed data
supabase/functions/generate-image/      Edge Function: the only place that talks to ModelsLab
  index.ts
.vercelignore                           Excludes non-site files (this repo's supabase/ folder, design refs) from Vercel deploys
```

## Architecture

```
Browser (index.html JS)
   │
   ├─▶ Supabase Postgres (direct, via anon/publishable key + RLS)
   │      - read gallery (get_gallery_images RPC)
   │      - insert/delete likes
   │      - insert waitlist_signups / advertiser_requests
   │
   └─▶ Supabase Edge Function: generate-image (Deno/TypeScript)
          │
          ├─▶ reads app_settings (admin-configured positive/negative prompt)
          ├─▶ calls ModelsLab text2img API (API key hidden server-side)
          ├─▶ polls ModelsLab until the image is ready
          └─▶ writes a row to `generations` (service role, bypasses RLS)

admin.html JS
   │
   ├─▶ Supabase Auth (sign in)
   └─▶ Supabase Postgres (admin-only reads/writes, gated by is_admin() RLS policy)
```

The browser never talks to ModelsLab directly and never sees the ModelsLab API key — that key only exists as a Supabase Edge Function secret.

## Database (`supabase/schema.sql`)

| Table | Purpose | Public access |
|---|---|---|
| `gallery_images` | Curated gallery shown on the site | Read (active rows only); write = admin only |
| `likes` | One row per (image, anonymous visitor) like | Read/insert/delete (visitor_id is a random client-generated UUID, not auth-backed) |
| `waitlist_signups` | Emails from the "Coming Soon" modal | Insert only; read = admin only |
| `advertiser_requests` | Submissions from the "Advertise with us" form | Insert only; read/update = admin only |
| `generations` | Log of every image generation attempt (prompt, negative prompt, result, timing) | No public access at all — written only by the Edge Function via the service-role key; read = admin only |
| `admin_users` | Marks which `auth.users` rows are admins | Admin-only read; **no self-service insert** — bootstrapped once manually via SQL |
| `app_settings` | Singleton row holding the admin-configured positive/negative prompt additions | Admin-only read/write |

Key mechanisms:
- **`is_admin()`** — a `security definer` SQL function checking membership in `admin_users`, used throughout the RLS policies.
- **`get_gallery_images()`** — public RPC that joins `gallery_images` with live like counts, pre-sorted by popularity. Powers both the homepage feed and the full gallery page.
- **Like quota trigger** — a `BEFORE INSERT` trigger on `likes` enforces a 3-per-day limit per `visitor_id`, server-side (can't be bypassed by clearing localStorage). A `UNIQUE(gallery_image_id, visitor_id)` constraint enforces one like per image.

Row Level Security (RLS) is enabled on every table; nothing is writable by anonymous clients except the specific insert-only paths listed above.

## Edge Function (`supabase/functions/generate-image/index.ts`)

The only server-side compute in the project. Runtime: Deno, deployed as a Supabase Edge Function.

1. Accepts `{ prompt, visitor_id, negative_prompt? }` from the client.
2. Loads `app_settings` (admin's positive/negative prompt additions).
3. Builds the final prompt: `admin_positive_prompt + " " + user_prompt`.
4. Builds the final negative prompt by concatenating (in order, always all present):
   - A hardcoded safety clause (anti-minor terms — this is ModelsLab's own default guardrail for this model, made explicit and non-overridable here)
   - A hardcoded quality clause (anti-blur/anti-deformity terms)
   - The admin's negative prompt (from `app_settings`)
   - Any caller-supplied `negative_prompt`
5. Calls ModelsLab's `text2img` endpoint. If the response is `processing`, polls `fetch_result` every 3s (up to ~84s) until it resolves.
6. Logs the attempt (success or failure, full prompt, duration) to `generations` using the service-role key.
7. Returns `{ status, image_url }` to the client.

**Secrets required** (set via Supabase Dashboard → Edge Functions → Manage secrets): `MODELSLAB_API_KEY`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the Supabase runtime.

## Frontend logic (`index.html`)

All in one `<script>` block, roughly in this order:
- **Age gate** — session-scoped 18+ confirmation, stored in `sessionStorage`.
- **Router** — hash-based (`#/` vs `#/gallery`), toggles two `<div>` views, no page reload.
- **Gallery/likes** — loads via `get_gallery_images()`, tracks the visitor's own likes and remaining daily quota, renders the homepage feed (top 5 most-liked + latest additions filled in to total 8) and the full gallery grid.
- **Modals** — "Coming Soon" waitlist form and "Advertise with us" form, both insert directly into their respective tables.
- **Generation flow** — builds the prompt, calls the Edge Function, animates a progress bar (client-side estimate, since the Edge Function blocks until done rather than streaming progress), and shows the result with rotating random suggestion prompts (auto-generates on click).

## Admin dashboard (`admin.html`)

- **Auth**: `supabase.auth.signInWithPassword`, then checks `is_admin()` via RPC before showing anything.
- **Tabs**: Gallery (CRUD), Waitlist (+ CSV export), Advertiser Requests (status workflow), Stats (aggregate counts), Generation History (last 100, with negative prompts and an "Add to Gallery" shortcut), Settings (the admin positive/negative prompt fields consumed by the Edge Function).

## Infrastructure / where things run

| What | Where | How to change it |
|---|---|---|
| Static site (`*.html`, `assets/`) | Vercel | `vercel deploy --prod` from this directory |
| Database schema, RLS, functions | Supabase Postgres | Paste `supabase/schema.sql` into Supabase SQL Editor (idempotent, safe to re-run) |
| Image generation logic | Supabase Edge Functions | Paste `supabase/functions/generate-image/index.ts` into Dashboard → Edge Functions → `generate-image`, redeploy |
| Admin login | Supabase Auth | Dashboard → Authentication → Users |

## One-time setup (new environment)

1. Create a Supabase project, note its URL and publishable (anon) key.
2. Run `supabase/schema.sql` in the SQL Editor.
3. Deploy the `generate-image` Edge Function; set the `MODELSLAB_API_KEY` secret.
4. Create an admin login (Dashboard → Authentication → Users), then run:
   ```sql
   insert into admin_users (user_id, email) values ('<user-uuid>', '<email>');
   ```
5. Update `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants at the top of `index.html` and `admin.html` if pointing at a different project.
6. Deploy the static files to Vercel (or any static host).

## Known limitations

- Image generation has no content moderation beyond ModelsLab's model-level defaults and the hardcoded anti-minor negative-prompt terms baked into the Edge Function. There is no prompt blocklist and ModelsLab's own `safety_checker` flag is not enabled.
- Anonymous visitor identity (`visitor_id`) is a client-generated UUID with no server-side verification — sufficient for like-quota UX, not a security boundary.
- Age verification is a single self-attestation click, not a real verification mechanism.
