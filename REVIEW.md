# Project review — 2026-09-28

Reviewed the frontend, authentication/cache lifecycle, article pagination,
read/unread writes, feed discovery/import, RSS fetching and identity handling,
database schema/RLS, maintenance jobs, HTML/CSS, and existing tests. Live
cleanup definitions, constraints, and access policies were also inspected.
This is a source and database review, not a guarantee of defect-free software
or a complete browser/security penetration test.

## Findings addressed

| Finding | Change |
| --- | --- |
| Read markers expired by reading age while slow feeds still served the articles. | Expiry now requires more than 90 days of observed absence and a successful source snapshot within the last day. |
| Stored article caps cannot establish source membership. | Presence checks include every parsed source entry, beyond the 200 stored rows; failed, empty, partial and 304 responses never start or advance absence. |
| An older overlapping fetch could overwrite presence observations. | Feed-row locking and observation timestamps reject older snapshots. |
| Link drift followed by GUID drift could orphan read markers; duplicate marker aliases could restore an intentionally unread article. | The presence RPC repairs links, migrates GUIDs, and consolidates aliases in one transaction, independently of article-row retention. |
| Browser cache accumulated deleted/reinserted article rows. | Successful article refreshes replace the loaded window; merges use feed/GUID or link identity, not just transient row IDs. |
| Failed read writes looked successful; overlapping writes could complete out of order. | Writes are serialized, failures restore the last confirmed state and show a retry message, and pending later choices remain protected. |
| Browser storage errors could abort a read action before its database write. | Cache failures are caught so the server write can proceed. |
| Account changes could reuse cached content or accept old article responses. | Cache ownership checks, state resets, and account/load-generation guards protect account transitions. |
| Feed-supplied article URLs were escaped but not restricted by protocol. | Article links accept only HTTP/HTTPS. |
| Marker RLS checked marker ownership without checking feed ownership. | Insert/update policies now require the feed to belong to the signed-in user as well. |
| Refresh could report success despite failed individual feeds. | Partial refresh failures are surfaced; identity/metadata write errors are reported by the fetcher. |

## Validation

- Node regression suite covers read pagination, refresh/write races, failed
  saves, opposing writes, cache failures, account isolation, article
  reinsertion, URL protocols, full-source membership, conditional requests,
  parse/network failures, and failed presence recording.
- `tests/read-retention.sql` ran against the deployed database inside a
  rolled-back transaction. It covers article deletion/reinsertion, marker
  expiry and preservation, stale snapshots, link/GUID changes, alias conflicts,
  unavailable feeds, new markers, feed deletion, maintenance permissions,
  and rejection of markers targeting another user's feed.
- JavaScript syntax and Git whitespace checks passed. Supabase bundled and
  deployed the updated Edge Function.
- No interactive browser session or exhaustive third-party feed compatibility
  test was performed. Frontend changes use the normal static-site publication
  process; Supabase database and Edge Function deployments are separate.

## Remaining limits and follow-ups

1. **Intentional retention tradeoff:** an article returning after its marker
   expired following 90 days of absence can be unread. Keeping exact history
   forever and enforcing finite history retention are incompatible guarantees.
2. **Unrecognizable source changes:** simultaneous GUID and URL changes, reused
   identifiers, or ambiguous duplicates cannot always be matched correctly.
   Titles alone are not a reliable identity.
3. **Connectivity/concurrency:** saves require a connection and failures now
   request a retry; there is no durable offline write queue. Conflicting edits
   from separate devices still use database arrival order. Multi-page reads
   are not a single database snapshot; concurrent changes can require another
   refresh to reconcile completely.
4. **Conservative storage:** paused, empty, or unverifiable feeds retain their
   markers. Source feeds with permanently huge archives can also retain many
   markers. The policy reduces accumulation but is not a hard 500 MB ceiling.
5. **Scale and public-service hardening:** feed-list queries have the server's
   default response limit; fetches run concurrently without a fixed worker
   pool. Destination/response-size restrictions, stronger rate limiting, pinned
   frontend dependency versions, and paginated feed lists remain worthwhile
   before broad multi-user deployment.
6. **Feed ordering:** swapping feed positions uses two independent updates;
   partial failures can leave tied positions. An atomic reorder RPC would
   improve that separate workflow.

The regression tests establish the behavior for the cases above. They cannot
support a promise that this class of issue will never happen under any future
feed behavior, infrastructure failure, or code change.
