# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-package repo for an autonomous issue-to-merge software factory, distributed to many repos as three pieces: orchestrator logic (`src/`, run via the composite action in `action.yml` — `uses: rlweb/a-factory@main` builds it on the runner; nothing is published to npm), CI (`.github/workflows/factory.reusable.yml`, a reusable workflow consumers call via a pinned `uses:` ref), and per-repo files (`consumer-template/`, copied at onboarding). Config is GitHub Actions variables (`vars.FACTORY_*`), not files. Auth is the workflow's own `GITHUB_TOKEN` only — cross-workflow triggering relies on `repository_dispatch` (the exception to the no-cascade rule), and the build job posts the `validate` commit status itself because token-created PRs don't fire `pull_request` workflows. All docs live in `README.md` (distribution/versioning model, config variable reference, release steps).

## Commands

```bash
pnpm install
pnpm run validate   # biome check + typecheck + test (the release gate)
pnpm run build      # tsc → dist/ (ESM + .d.ts)
```

Individually: `pnpm test` (vitest run), `pnpm lint` (biome check), `pnpm typecheck`, `pnpm format` (biome format --write).

Single test file:

```bash
pnpm vitest run src/lib/gate.test.ts
```

## Architecture

`src/`:

- **`bin/factory.ts`** — CLI. `factory <triage|implement|review|epic|resume>` dynamically imports the matching orchestrator and calls its `run()`. All input arrives via env vars set by the workflow (`ISSUE_NUMBER`, `PR_NUMBER`, `GITHUB_TOKEN`, `OPENCODE_API_KEY`, `FACTORY_*`).
- **Orchestrators** (`triage.ts`, `implement.ts`, `review.ts`, `epic.ts`, `resume.ts`) — each exports `run()`; these read env and do I/O.
- **`lib/`** — the pure, testable core. Key separation: orchestrators do I/O, lib functions are pure and injected with config.
  - `config.ts` — the ONLY module that reads `process.env` for config. Empty-string env is treated as unset (GitHub expands missing `vars.*` to `""`; `Number("")===0` would silently zero limits — this is why `numEnv`/`strEnv`/`listEnv` exist and are tested).
  - `gate.ts` — deterministic auto-merge gate. The agent proposes a `Risk` verdict; `gate()` disposes (risk level, protected paths via minimatch, file-count limit, validation result).
  - `trust.ts` — `decideResume()`: bot comments ignored, trusted associations resume, untrusted humans hold until maintainer approval.
  - `opencode.ts` — `withOpencode()` boots an in-process OpenCode server and always closes it; `promptJSON()` prompts for bare JSON and parses/retries (the SDK has no server-side structured output). The model comes from the consumer repo's `opencode.json` (strict JSON, no `FACTORY_MODEL` variable); the baked default in `config.ts` only fills its absence. No per-prompt model is sent, so repo agent-level models also win.
  - `agents.ts` — per-issue-type agent roster. builder/tdd/bugfixer prompts are vendored verbatim in `agents/*.md` from mattpocock/skills (MIT — excluded from biome; keep verbatim) behind `HARNESS_PREAMBLE`, which adapts interactive skills to unattended CI (no human to ask, no self-committing, skip dangling references) — extend the preamble rather than editing vendored files. reviewer/decomposer prompts are factory-written distillations. Layering rule: agent prompt = role + process, call-site prompt = task data + dynamic bits only. `mergeAgents()` drops any baked agent the repo's `opencode.json` defines; `implementAgentFor()` picks `bugfixer` vs `builder` by label. Read-only phases (planner/triager/reviewer/decomposer) are enforced with `permission: { edit: "deny" }`.
  - `schemas.ts`, `github.ts`, `validate.ts` — JSON schemas for agent output, GitHub API helpers, validation runner.
- **`index.ts`** — public API surface: pure logic re-exported as primary; orchestrator `run()`s exported but deliberately secondary (they touch env/I/O).

The reusable workflow routes GitHub events (issue opened → triage, labeled/dispatch → implement or epic, comment → resume, PR → review) to CLI subcommands. The implement→review handoff happens in a single run and dispatch uses `repository_dispatch` — both are consequences of the `GITHUB_TOKEN` no-cascade rule; preserve them when editing workflows.

## Conventions

- ESM only (`"type": "module"`); internal imports use `.js` extensions.
- Node >= 20. Strict TS, built with `tsconfig.build.json`.
- New tunables follow the pattern: baked default in `config.ts`, overridable via a `FACTORY_*` Actions variable, threaded through the `env:` block of `factory.reusable.yml`, documented in the README config table.
- Lint/format is biome (`biome.json`); `agents/*.md` are vendored verbatim and excluded from it.
- Releases: `pnpm run validate`, tag `vX.Y.Z`, force-move the `vX` major tag — no npm publish (see README "Versioning & release").
