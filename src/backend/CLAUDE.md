# Backend

API-key handling rules live in the root `CLAUDE.md` and apply here.

## Gotchas

- **Wikipedia rate-limits bursts** (HTTP 429). `metadata.py` retries with backoff;
  a film that still fails is simply retried on the next scan.
- **Credentials are still a slot mechanism for one source.** TMDB is the only
  provider left that needs a key, so `credential()` returns a single string
  rather than the tab-separated multi-field value the removed IGDB source
  needed. `CREDENTIAL_NEEDED` and `normalise_entry`'s `@`-slot spelling stayed
  because TMDB itself can still take a second fallback key (`tmdb@2`), not
  because another multi-field source is expected.
- **An install that still has music, photos or games in its cache cleans
  itself up on the next scan, not before.** `MetadataService._load_index`
  drops any `album_`/`game_`-prefixed record from the metadata index on load,
  and `prune_art` removes a leftover `thumbs/` folder under the cache the
  first time it runs post-upgrade. Both are one-shot: once a machine has
  scanned since the sections were removed, there is nothing left to sweep.
