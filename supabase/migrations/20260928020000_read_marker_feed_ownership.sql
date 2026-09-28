begin;
-- Read markers must belong to both the signed-in user and one of their feeds.
alter policy article_reads_insert_own on public.article_reads
  with check (auth.uid() = user_id and exists (
    select 1 from public.feeds f where f.id = article_reads.feed_id and f.user_id = auth.uid()
  ));
alter policy article_reads_update_own on public.article_reads
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (
    select 1 from public.feeds f where f.id = article_reads.feed_id and f.user_id = auth.uid()
  ));
commit;
