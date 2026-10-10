# Commit-event fixtures

`stemdeck-first10.json` is a fixture of the first 10 commits of
https://github.com/stemdeckapp/stemdeck (first-parent history, oldest first).
It is the canonical commit-event format for the app.
The app's default URL shows `stemdeck-full.json` (lazy-loaded); select this file with `?fixture=stemdeck-first10`.

## Schema

The file is a JSON array. Each element is one commit:

| Field     | Type   | Description |
|-----------|--------|-------------|
| `hash`    | string | Full 40-char commit SHA. |
| `author`  | string | Author name (`%an`). |
| `email`   | string | Author email (`%ae`); may be empty. The fixtures in this repository have it blanked (the app never uses it; `tests/featured.test.ts` checks). |
| `date`    | string | Author date, ISO 8601 strict with offset (`%aI`). |
| `message` | string | Commit subject line (`%s`). |
| `files`   | array  | Changed files (see below). |

Each entry of `files`:

| Field      | Type    | Description |
|------------|---------|-------------|
| `path`     | string  | Path after the change. |
| `status`   | string  | `A` added, `M` modified, `D` deleted, `R` renamed. |
| `added`    | integer | Lines added (`0` for binary files). |
| `removed`  | integer | Lines removed (`0` for binary files). |
| `old_path` | string  | Only present when `status` is `R`: path before the rename. |

Notes:
- Files come from `git show --first-parent -M --name-status` and
  `--numstat`, so merge commits are diffed against their first parent.
- Renames are detected by git (`-M`); `C` (copy) is not emitted here.

## Producing this format from any repository

The app ingests the same events from a `git log` text file (see `docs/INGESTION.md`):

```
git log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s' > phloem.log
```

(`--raw`, not `--name-status`: git prints only one of `--name-status` / `--numstat` when both are given.) Drop the file on the page; a log made
from the stemdeck clone yields exactly the commits of `stemdeck-full.json` (checked in `tests/e2e/ingest_check.py`).
