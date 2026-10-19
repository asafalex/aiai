-- DMCA takedown notices (public submit; admin read)
create table if not exists dmca_notices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  copyrighted_work text not null,
  infringing_urls text not null,
  additional_info text,
  signature text not null,
  status text not null default 'new' check (status in ('new','reviewing','resolved','rejected')),
  created_at timestamptz not null default now()
);

alter table dmca_notices enable row level security;

drop policy if exists "public submit dmca notice" on dmca_notices;
create policy "public submit dmca notice" on dmca_notices
  for insert to anon, authenticated
  with check (true);

drop policy if exists "admin read dmca notices" on dmca_notices;
create policy "admin read dmca notices" on dmca_notices
  for select to authenticated
  using (is_admin());

drop policy if exists "admin update dmca notices" on dmca_notices;
create policy "admin update dmca notices" on dmca_notices
  for update to authenticated
  using (is_admin())
  with check (is_admin());
