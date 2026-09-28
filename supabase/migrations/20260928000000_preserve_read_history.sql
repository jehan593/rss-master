-- Keep read state across retention, article caps, and long feed silences.
-- A compatibility no-op also protects installations with a separate old cron job.
begin;

create or replace function public.cleanup_old_read_markers()
returns void language plpgsql security definer set search_path = public as $$
begin
  return;
end;
$$;

revoke execute on function public.cleanup_old_read_markers() from public, anon, authenticated;

select cron.schedule(
  'cleanup-old-articles-daily',
  '30 3 * * *',
  $$ select cap_total_articles(2000); select cleanup_old_articles(); select cap_articles_per_feed(200); $$
);

commit;
