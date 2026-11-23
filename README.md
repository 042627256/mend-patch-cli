# mend

One command-line tool that applies the edits AI models write — in four formats — to a tree of
text files: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. `SPEC.md` is the whole specification.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a file path, or absent / `-` to read standard input.
- `--format` forces one of `unified`, `search-replace`, `v4a`, `json`; `auto` (default) detects it.
- `--check` validates the patch and prints what would change without writing.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` all edits applied (or nothing to write with `--check`), `1` at least one edit
failed (nothing is written), `2` usage/parse/no-patch/format error.

## Practice checks

```
node check.ts <path-to-practice.json>
node check.ts <path-to-practice.json> u-offset s-basic
```

Score: **1000/1000** (100 of 100 public practice checks pass).

## Requirements

- Node 22 and its standard library only. Nothing is installed before the program runs.
- Deterministic: the same check gives the same exit code, stdout and files every run.
- `runner.ts` is kept as the kit has it: when `MAKEFUN_ENV_URL` is set, `main.ts` hands the
  trial over to it.

## License

MIT (see `LICENSE`).
