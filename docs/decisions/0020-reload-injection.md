# 0020. Reload-snippet injection on bytes, replacing earlier injected tags

Status: Accepted (M1)

## Context

`inject.ts` must add exactly one `<script src="/__artifact/reload.js" data-version="<n>" defer></script>` before the last `</body>`, or at the end if there is none. `src/` must stay byte-identical. Agents may republish html they fetched from a served page, which already contains a tag.

## Decision

- The tag is matched against `</body\s*>`, case-insensitively, and inserted before the last match.
- Before insertion, any tag in exactly the injected form (any `data-version`) is removed, repeatedly, until none remain. The result therefore always has exactly one. Hand-written variants are left alone.
- Only `www/` copies of `.html` files are injected; `src/` and non-html files are stored as published. Injection works on bytes mapped one-to-one to chars, so UTF-8, windows-1252 or any other ASCII-compatible encoding passes through unchanged, and invalid UTF-8 is never "repaired".

## Consequences

Property tests (`test/core/inject.test.ts`) check that there is exactly one tag, that it sits in the right place, and that every original byte is preserved. UTF-16 html would not be injected correctly; that is accepted.
