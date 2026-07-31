-- Fix: re-marking an article read silently failed under RLS
--
-- markRead/markAllRead upsert into article_reads on conflict (user_id,
-- article_id). Postgres executes that as INSERT ... ON CONFLICT DO UPDATE,
-- and the UPDATE branch requires a policy permitting update — but only
-- select/insert/delete policies existed. With RLS enabled and no matching
-- policy, updates are denied by default, so any second write to an
-- already-read article was silently rejected (only logged client-side),
-- leaving the row's true read state inconsistent with what the client
-- believed it had just persisted.

create policy "article_reads_update_own" on article_reads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
