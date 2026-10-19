drop policy if exists "admin delete generations" on generations;
create policy "admin delete generations" on generations
  for delete using (is_admin());
