-- ============================================================
-- AI Image Studio — database schema
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- gallery_images ----------
create table if not exists gallery_images (
  id uuid primary key default gen_random_uuid(),
  image_url text not null,
  description text not null,
  base_likes integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- likes ----------
create table if not exists likes (
  id uuid primary key default gen_random_uuid(),
  gallery_image_id uuid not null references gallery_images(id) on delete cascade,
  visitor_id uuid not null,
  created_at timestamptz not null default now(),
  unique (gallery_image_id, visitor_id)
);

-- ---------- waitlist_signups ----------
create table if not exists waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists waitlist_signups_email_lower_idx
  on waitlist_signups (lower(email));

-- ---------- advertiser_requests ----------
create table if not exists advertiser_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text not null,
  phone text,
  message text,
  status text not null default 'new' check (status in ('new','contacted','approved','rejected')),
  created_at timestamptz not null default now()
);

-- ---------- generations (history + usage stats source) ----------
create table if not exists generations (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid,
  prompt text not null,
  image_url text,
  status text not null check (status in ('success','error','timeout')),
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
alter table generations add column if not exists negative_prompt text;

-- ---------- admin_users ----------
create table if not exists admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- ---------- app_settings (admin-configurable prompt prefix/suffix, singleton row) ----------
create table if not exists app_settings (
  id integer primary key default 1,
  positive_prompt text not null default '',
  negative_prompt text not null default '',
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- ---------- helper: is_admin() ----------
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;

-- ---------- like quota trigger (max 3 likes/day per visitor, across the whole site) ----------
create or replace function enforce_like_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  today_count integer;
begin
  select count(*) into today_count
  from likes
  where visitor_id = new.visitor_id
    and created_at >= date_trunc('day', now());

  if today_count >= 3 then
    raise exception 'LIKE_QUOTA_EXCEEDED' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_like_quota on likes;
create trigger trg_enforce_like_quota
before insert on likes
for each row execute function enforce_like_quota();

-- ---------- public RPC: gallery + live like counts, sorted by popularity ----------
create or replace function get_gallery_images()
returns table (
  id uuid,
  image_url text,
  description text,
  total_likes bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    g.id,
    g.image_url,
    g.description,
    g.base_likes + count(l.id) as total_likes,
    g.created_at
  from gallery_images g
  left join likes l on l.gallery_image_id = g.id
  where g.is_active = true
  group by g.id
  order by total_likes desc, g.created_at desc;
$$;

grant execute on function get_gallery_images() to anon, authenticated;

-- ---------- admin RPC: generation history with like totals + sort ----------
create or replace function get_admin_generation_history(
  p_search text default '',
  p_sort text default 'recent',
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  visitor_id uuid,
  prompt text,
  negative_prompt text,
  image_url text,
  status text,
  error_message text,
  duration_ms integer,
  created_at timestamptz,
  total_likes bigint,
  gallery_id uuid,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'admin only';
  end if;

  return query
  with filtered as (
    select g.*
    from generations g
    where coalesce(trim(p_search), '') = ''
      or (
        select coalesce(bool_and(g.prompt ilike '%' || w || '%'), true)
        from unnest(regexp_split_to_array(trim(p_search), '\s+')) as w
        where w <> ''
      )
  ),
  enriched as (
    select
      f.id,
      f.visitor_id,
      f.prompt,
      f.negative_prompt,
      f.image_url,
      f.status,
      f.error_message,
      f.duration_ms,
      f.created_at,
      (coalesce(gi.base_likes, 0)::bigint + coalesce(lk.c, 0)) as total_likes,
      gi.id as gallery_id
    from filtered f
    left join gallery_images gi on gi.image_url = f.image_url
    left join lateral (
      select count(*)::bigint as c from likes l where l.gallery_image_id = gi.id
    ) lk on true
  )
  select
    e.id,
    e.visitor_id,
    e.prompt,
    e.negative_prompt,
    e.image_url,
    e.status,
    e.error_message,
    e.duration_ms,
    e.created_at,
    e.total_likes,
    e.gallery_id,
    count(*) over() as total_count
  from enriched e
  order by
    case when lower(coalesce(p_sort, 'recent')) = 'likes' then e.total_likes end desc nulls last,
    e.created_at desc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function get_admin_generation_history(text, text, int, int) to authenticated;
grant execute on function is_admin() to anon, authenticated;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table gallery_images enable row level security;
alter table likes enable row level security;
alter table waitlist_signups enable row level security;
alter table advertiser_requests enable row level security;
alter table generations enable row level security;
alter table admin_users enable row level security;
alter table app_settings enable row level security;

-- gallery_images: public reads active rows; admins do everything
drop policy if exists "public read active gallery" on gallery_images;
create policy "public read active gallery" on gallery_images
  for select using (is_active = true or is_admin());

drop policy if exists "admin manage gallery" on gallery_images;
create policy "admin manage gallery" on gallery_images
  for all using (is_admin()) with check (is_admin());

-- likes: public can insert/select/delete their own (visitor_id is a random client id, not sensitive PII)
drop policy if exists "public select likes" on likes;
create policy "public select likes" on likes
  for select using (true);

drop policy if exists "public insert likes" on likes;
create policy "public insert likes" on likes
  for insert with check (true);

drop policy if exists "public delete likes" on likes;
create policy "public delete likes" on likes
  for delete using (true);

-- waitlist_signups: public insert only; admin reads
drop policy if exists "public join waitlist" on waitlist_signups;
create policy "public join waitlist" on waitlist_signups
  for insert with check (true);

drop policy if exists "admin read waitlist" on waitlist_signups;
create policy "admin read waitlist" on waitlist_signups
  for select using (is_admin());

-- advertiser_requests: public insert only; admin reads/updates
drop policy if exists "public submit advertiser request" on advertiser_requests;
create policy "public submit advertiser request" on advertiser_requests
  for insert with check (true);

drop policy if exists "admin manage advertiser requests" on advertiser_requests;
create policy "admin manage advertiser requests" on advertiser_requests
  for select using (is_admin());

drop policy if exists "admin update advertiser requests" on advertiser_requests;
create policy "admin update advertiser requests" on advertiser_requests
  for update using (is_admin()) with check (is_admin());

-- generations: no public access at all; only the Edge Function (service role, bypasses RLS) writes; admins read/delete
drop policy if exists "admin read generations" on generations;
create policy "admin read generations" on generations
  for select using (is_admin());

drop policy if exists "admin delete generations" on generations;
create policy "admin delete generations" on generations
  for delete using (is_admin());

-- admin_users: admins can see the admin list
drop policy if exists "admin read admin_users" on admin_users;
create policy "admin read admin_users" on admin_users
  for select using (is_admin());

-- app_settings: admin-only read/write (the Edge Function reads it via service role, bypassing RLS)
drop policy if exists "admin read app_settings" on app_settings;
create policy "admin read app_settings" on app_settings
  for select using (is_admin());

drop policy if exists "admin update app_settings" on app_settings;
create policy "admin update app_settings" on app_settings
  for update using (is_admin()) with check (is_admin());

-- ============================================================
-- Seed data — the 5 sample gallery images already used on the site
-- (safe to re-run: skips rows that already exist by description match)
-- ============================================================
insert into gallery_images (image_url, description, base_likes)
select * from (values
  ('assets/gallery/beach.jpg', 'שיער מתולתל ושמלה כחולה על חוף הים בשקיעה', 1420),
  ('assets/gallery/paris-cafe.jpg', 'אישה אלגנטית בחולצת פשתן זית בבית קפה פריזאי', 1185),
  ('assets/gallery/garden.jpg', 'אישה בשמלת פשתן לבנה בגינה פורחת', 950),
  ('assets/gallery/tel-aviv-street.jpg', 'חיוך קורן וז''קט ג''ינס ברחובות נווה צדק תל אביב', 840),
  ('assets/gallery/studio.jpg', 'סוודר טרקוטה חמים בסטודיו לאמנות וגלריה', 720)
) as seed(image_url, description, base_likes)
where not exists (
  select 1 from gallery_images g where g.description = seed.description
);

-- Backfill gallery from successful generations (safe to re-run)
insert into gallery_images (image_url, description, base_likes)
select distinct on (g.image_url)
  g.image_url,
  left(g.prompt, 500),
  0
from generations g
where g.status = 'success'
  and g.image_url is not null
  and not exists (
    select 1 from gallery_images gi where gi.image_url = g.image_url
  )
order by g.image_url, g.created_at desc;

-- Optional: seed random display likes on ~70% of gallery rows (3–1450). Safe to re-run; only rows with base_likes = 0.
-- update gallery_images
-- set base_likes = 3 + floor(random() * 1448)::int
-- where base_likes = 0 and random() < 0.7;

-- ============================================================
-- LAST STEP (do this after creating your login):
-- Dashboard → Authentication → Users → find your user → copy the UUID, then:
--
--   insert into admin_users (user_id, email)
--   values ('PASTE-YOUR-USER-UUID-HERE', 'your@email.com');
--
-- This is what unlocks admin.html for that account.
-- ============================================================
