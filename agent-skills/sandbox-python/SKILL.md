---
name: sandbox-python
description: Run Python or bash in the isolated E2B sandbox. Use for calculation, file transforms, and generating artifacts.
---

# Sandbox execution

Load this skill when the user wants code run, files transformed, or artifacts produced.

## Tool

`sandbox_run_code`

- `language`: `python` or `bash`
- `code`: the program to run
- `files`: optional `{ path, url }` inputs written under `/home/user/work`
- Write anything the user should download to `/home/user/artifacts`

## Rules

1. Prefer Python for data and image work; bash for shell steps.
2. Do not read secrets from the environment. None are provided.
3. Generated files only count as artifacts if they land in `/home/user/artifacts`.
4. Non-zero exit is a failed program, not a missing sandbox — inspect stdout/stderr.
