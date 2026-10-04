-- Admin generation history with like totals + sort (applied via Supabase SQL)

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
