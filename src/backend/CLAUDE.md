# Backend

API-key handling rules live in the root `CLAUDE.md` and apply here.

## Gotchas

- **Wikipedia rate-limits bursts** (HTTP 429). `metadata.py` retries with backoff;
  a film that still fails is simply retried on the next scan.
- **A credential is one slotted value.** `credential()` returns a single
  string per slot (`tmdb@1`, `tmdb@2`, …); TMDB is the only provider that
  needs a key, and a second slot is a fallback to try when the first is
  rate-limited or has never heard of the title.
- **A title no source had artwork for is not asked about again for a week.**
  `_save` stamps the record with `tried` and the sources that *answered* (a
  source that could not be asked — the network down, a key TMDB refused — is
  left out, and asked next time); `_missed` skips the online loop while the
  same sources are listed and the week has not passed. A source added since
  asks again at once. Without this a home video cost a request per source on
  every scan, forever.
- **A network that cannot be reached takes the rest of the run offline.**
  `_fetch` counts transport failures in a row (not HTTP answers) and after
  `OFFLINE_AFTER_FAILURES` refuses to ask; one success starts the count over.
  A thousand-item first scan behind a firewall dropping packets took a quarter
  of an hour to fail otherwise, at a timeout per request.
- **The cached record is read for every listed source, usable or not.** A
  TMDB key blanked in the preferences must not throw away what TMDB fetched
  while it was set; only the online loop is filtered by `_usable`.
- **An install upgrading from a release with music, photos or games cleans
  its cache up on its first scan since, not before.** `MetadataService._load_index`
  drops any `album_`/`game_`-prefixed record from the metadata index on load,
  and `prune_art` removes a leftover `thumbs/` folder under the cache. Both
  are one-shot sweeps: once a machine has scanned since upgrading, there is
  nothing left to drop, so don't mistake either for dead code.
