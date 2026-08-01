# Factory monorepo

Autonomous issue-to-merge software factory built entirely on GitHub primitives:
**issues** are the work queue (issue forms file the work, labels drive state, comments
carry questions and answers), and **Actions** is the runtime (a reusable workflow
routes issue events to agent jobs — no servers, no webhooks, no external
infrastructure). Open an issue, label it `ready`, and the factory plans, implements,
validates, opens a PR, and merges it if the risk gate passes.

## How it works

```mermaid
flowchart TD
    A[Issue opened] -->|issues: opened| T[factory triage]
    T -->|clear enough| R[label: ready]
    T -->|too vague| H[label: needs-human]
    E[Issue labeled epic] --> EP[factory epic<br/>decompose into child tickets]
    EP --> R
    R -->|issues: labeled ready| B[factory implement<br/>plan → code → validate]
    B -->|needs input| Q[label: awaiting-answer<br/>asks question on issue]
    Q -->|human replies| RS[factory resume<br/>trust check on commenter]
    RS -->|trusted or approved| B
    B -->|validation passes| PR[opens pull request]
    PR --> RV[factory review<br/>agent risk verdict + deterministic gate]
    RV -->|low risk, no protected paths,<br/>under file limit| M[auto-merge]
    RV -->|anything else| HR[human review required]
```

The agent proposes; the deterministic gate in `src/lib/gate.ts` disposes — risk level,
protected paths, and file-count limits are code, not model judgment.

## Quick start (consuming repo)

1. Copy `consumer-template/.github/` into your repo (workflow stub + issue forms).
2. Add the `OPENCODE_API_KEY` secret (everything else runs on the workflow's own
   `GITHUB_TOKEN`).
3. In the stub, set the `uses:` ref to the update cadence you want (`@v1` tracks the
   major; `@v1.4.2` freezes).
4. Set any repo-level override variables (see the config table below); org variables
   cover the rest.
5. Add branch protection requiring the `validate` check + one review for
   non-auto-merged PRs.
6. Open an issue using the **Ticket** form, label it `ready` — the factory plans,
   implements, validates, opens a PR, and auto-merges it if the risk gate passes.

What stays per-repo, and why: `validate.yml` (runs the *consuming* repo's own
validation — the factory can't know your build; it's the required status check), the
issue forms (committed so they render in the issue chooser — re-copy from
`consumer-template/` on the rare form update, or add a scheduled sync workflow once
you're past ~10 repos), and the optional `factory-comment.yml` (`/oc` interface).

```yaml
# .github/workflows/factory.yml — the entire per-repo footprint
jobs:
  factory:
    uses: rlweb/a-factory/.github/workflows/factory.reusable.yml@v1
    secrets:
      OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
    with:
      event_name: ${{ github.event_name }}
      # ...event context, see consumer-template/.github/workflows/factory.yml
```

## What's here

```
action.yml                   composite action: builds the package and runs the CLI
src/                         orchestrators, lib, CLI bin, index (tests colocated as *.test.ts)
agents/                      vendored agent prompts (mattpocock/skills, MIT)
.github/workflows/
  factory.reusable.yml       the central reusable workflow consumers call
consumer-template/           what each consuming repo commits
  .github/workflows/         thin stub + validate + comment
  .github/ISSUE_TEMPLATE/    the forms
```

## The distribution model

Logic ships as a **composite GitHub Action** (`uses: rlweb/a-factory@main` — built from
this repo on the runner, nothing published to npm); CI ships as a **reusable workflow**
called by a thin per-repo stub pinned to a version ref; issue forms are **committed per
repo** from the template; config lives in **GitHub Actions variables** (org baseline,
repo overrides). One git ref versions the lot.

| Piece | Lives in | Distributed as | Versioned by |
| --- | --- | --- | --- |
| Orchestrator logic | `action.yml` + `src/` | composite action (`uses: rlweb/a-factory@main`) | git ref |
| CI workflows | `.github/workflows/factory.reusable.yml` | reusable workflow (`uses:`) | git ref (`@v1`, `@v1.4.2`) |
| Issue forms | `consumer-template/` | committed per repo | copied at onboarding |
| Config | Actions variables | org/repo vars | GitHub UI (not versioned) |

Workflows can't live in an action — GitHub only runs workflow YAML from the repo's own
`.github/`. Hence the action/workflow split; when a job runs `uses: rlweb/a-factory@<ref>`,
GitHub downloads this repo's tree at that ref and the action builds the package
in place.

## Agents per issue type

Each phase runs a purpose-built OpenCode agent. `builder` (implement), `bugfixer`
(diagnosing-bugs, for `bug`-labelled issues), and the `tdd` subagent the builder
delegates to use prompts vendored verbatim from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see `agents/LICENSE`),
behind a shared harness preamble that adapts them to unattended CI (no human to ask,
no self-committing, dangling skill references skipped). `reviewer` and `decomposer`
use factory-written prompts distilled from those skills' ideas (the two-axis review +
smell baseline; one-shot shippable decomposition). `planner`, `triager`, `reviewer`,
and `decomposer` are read-only by permission (`edit: deny`), not just by prompt.

### Configure via your repo's `opencode.json`

The model is **not** an Actions variable — it comes from the consuming repo's
`opencode.json`, which OpenCode loads natively. **Setting a default model there is
highly recommended**; without one the factory falls back to a baked default
(`mini-v2.5`), which may not match your provider setup:

```json
{
  "model": "mini-v2.5"
}
```

The same file can override any factory agent — define an agent with the same name
(`builder`, `bugfixer`, `reviewer`, `decomposer`, `planner`, `triager`, `tdd`) and the
factory's baked definition is dropped entirely in favour of yours. That's a wholesale
replacement (prompt, model, permissions), so restate whatever you want to keep. For
example, a cheaper model for triage and a house-style builder:

```json
{
  "model": "mini-v2.5",
  "agent": {
    "triager": {
      "model": "anthropic/claude-haiku-4-5",
      "prompt": "You triage GitHub issues for an automated implementation factory. Be conservative.",
      "permission": { "edit": "deny", "bash": "deny" }
    },
    "builder": {
      "prompt": "Implement the ticket end to end. Follow CONTRIBUTING.md. Prefer small diffs."
    }
  }
}
```

Keep the file **strict JSON** (the name says `.json`, and the factory parses it
strictly) — if it can't be parsed, the factory logs a notice and behaves as if it were
absent, which would put the baked defaults back in charge.

## Config is variables, not files

Every tunable is a `vars.*` Actions variable (**Settings ▸ Secrets and variables ▸
Actions ▸ Variables**) resolved by GitHub as repo > org > baked default. Set the shared
baseline once as org variables; override per repo only where needed. Unset reads as
empty-string and falls back to the default — the parsing in `src/lib/config.ts` handles
that explicitly (and is unit-tested in `src/lib/config.test.ts`, because `Number("")===0`
would otherwise silently zero a limit).

| Variable | Type | Default | Meaning |
| --- | --- | --- | --- |
| `FACTORY_VALIDATION_ATTEMPTS` | number | `3` | Self-fix loops before human handoff |
| `FACTORY_QUESTION_ROUNDS` | number | `0` | Eager-question round cap (`0` = uncapped) |
| `FACTORY_GATE_MAX_FILES` | number | `20` | Files-changed ceiling for auto-merge |
| `FACTORY_PROTECTED_PATHS` | comma-separated | `.github/**,infra/**,**/migrations/**,**/*.tf,src/auth/**,package.json,pnpm-lock.yaml,package-lock.json` | Globs that force human review |
| `FACTORY_TRUSTED_ASSOCIATIONS` | comma-separated | `OWNER,MEMBER,COLLABORATOR` | author_association levels that resume immediately |
| `FACTORY_SERVER_TIMEOUT_MS` | number | `15000` | OpenCode server boot timeout |

Encoding notes:

- Comma-separated variables split on `,` and trim; blank segments drop (`a,,b,` →
  `["a","b"]`). Globs use `minimatch` with `dot: true`, so `.github/**` matches
  dotfile paths.
- You cannot set a list variable to *empty* — `""` reads as unset and restores the
  default, so an accidental blank can't silently disable a safety default. If you truly
  need an empty list, set a sentinel the code won't match (and open an issue — that's a
  config smell).

The only secret is `OPENCODE_API_KEY`; everything else runs on the workflow's own
`GITHUB_TOKEN`.

## Develop

```bash
pnpm install
pnpm run validate      # biome check + typecheck + test
pnpm run build         # emit dist/ (ESM + .d.ts)
```

## Future updates

Planned, not yet built:

- **MCP auth support** — let consumer repos declare MCP servers (via `opencode.json`'s
  `mcp` block) with credentials passed through as workflow secrets, so factory agents
  can reach tools like issue trackers, docs, or internal APIs during a run.
- **Configurable validate command** — the validation loop currently hardcodes
  `pnpm validate`; make the command per-repo configurable (likely a
  `FACTORY_VALIDATE_COMMAND` variable) so non-pnpm and non-Node repos can consume the
  factory.
- **Factory-specific skills** — a way for a consumer repo to add its own skill/prompt
  files (e.g. `.factory/skills/*.md`) that get appended to the relevant agents'
  context, so house rules ride alongside the vendored skills without redefining whole
  agents in `opencode.json`.
