# Backend

API-key handling rules live in the root `CLAUDE.md` and apply here.

## Gotchas

- **Wikipedia rate-limits bursts** (HTTP 429). `metadata.py` retries with backoff;
  a film that still fails is simply retried on the next scan.
- **A credential is one slotted value.** `credential()` returns a single
  string per slot (`tmdb@1`, `tmdb@2`, …); TMDB is the only provider that
  needs a key, and a second slot is a fallback to try when the first is
  rate-limited or has never heard of the title.
- **An install upgrading from a release with music, photos or games cleans
  its cache up on its first scan since, not before.** `MetadataService._load_index`
  drops any `album_`/`game_`-prefixed record from the metadata index on load,
  and `prune_art` removes a leftover `thumbs/` folder under the cache. Both
  are one-shot sweeps: once a machine has scanned since upgrading, there is
  nothing left to drop, so don't mistake either for dead code.
