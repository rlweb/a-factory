# a-factory

Issue-driven autonomous SDLC: opening a GitHub issue provisions an exe.dev VM
running Shelley (exe.dev's coding agent), which implements the issue and opens
a PR; closing the issue tears the VM down.

## What lives where

- `consumer-template/.github/workflows/factory.yml` — the ONE file a consumer
  repo commits. Everything else below is maintained here and versioned as
  `rlweb/a-factory@v1`.
- `action.yml` + `cmd/a-factory` — the composite action and the Go CLI it
  bundles. Reads `GITHUB_EVENT_NAME`/`GITHUB_EVENT_PATH`, routes the event,
  drives exe.dev + Shelley.
- `image/Dockerfile` — the VM image (extends exe.dev's `exeuntu` base, adds
  Node.js, pnpm, Playwright/Chromium, and the mattpocock/skills library). No boot script: registering custom models,
  checking out the repo, and seeding the Shelley session are ordinary API
  calls `internal/orchestrate.Provision` makes directly (a bearer-token HTTPS
  client for VM lifecycle, Shelley's own HTTPS API once a key is minted, and
  an SSH admin client for the few operations exe.dev restricts to real
  account sessions) — well-tested Go code rather than an opaque shell script.
- `docs/spike-findings.md` — confirmed exe.dev/Shelley wire-format facts,
  gathered by hand against a real account. Cited by `internal/exe` and
  `internal/shelley` doc comments; treat as the source of truth over any
  assumption baked into code comments elsewhere.

## This repo's own verify command (Gate 1, dogfooded)

```
make verify   # go build + go vet (typecheck), golangci-lint run (lint), go test ./... -race -cover (test)
```

`make verify` must pass before any PR from this repo. `go test ./...` never
touches the network — every I/O boundary (exe.dev's `/exec`, Shelley's HTTP
API, GitHub's API) is called through an interface substituted with
`httptest.NewServer` or a hand-written fake in tests. The only path that hits
real exe.dev is `make smoke` (`cmd/smoke`, gated behind `FACTORY_SMOKE=1` +
real credentials) — never run as part of `verify`, never on `push`/`pull_request`.

## The convention this repo requires of CONSUMER repos

Every repo that adopts `rlweb/a-factory@v1` must define, in its own
`AGENTS.md` or Makefile:

- **Gate 1 — `verify`**: one command that runs everything that must be green
  (typecheck, lint, test, build) and exits non-zero on failure. The agent
  prompts require this to pass, in full, immediately before `gh pr create`.
- **Gate 2 — `preview`**: one command that serves the built app on a known
  port, bound to `0.0.0.0` (not `localhost` — exe.dev can't route to a
  loopback-only bind). exe.dev exposes that port over HTTPS for the life of
  the box; the agent posts the URL as a PR comment for QA. The port is public
  for as long as the box lives — never put real secrets or write access
  behind it.

`a-factory` does not typecheck, lint, test, or build consumer code itself, and
it does not decide what "passing" means for a consumer repo. It only requires
these two commands to exist (failing loudly on the issue if they don't) and
instructs the agent to run them. Optional `factory audit-gate`/
`factory audit-preview` subcommands re-run the consumer's own commands
after the agent claims success, as an advisory check — not a CI replacement.

## Two exe.dev credentials, not one

Confirmed against a real account (`docs/spike-findings.md`) — exe.dev
refuses a handful of operations over ANY bearer token regardless of
`--cmds` scope, so a-factory needs two distinct secrets:

- **`EXE_API_TOKEN`** (bearer, `ssh-key generate-api-key --cmds=new,rm,ls`)
  — VM lifecycle only: `new`/`rm`/`ls` over `POST https://exe.dev/exec`.
  Safe to scope narrowly.
- **`EXE_SSH_PRIVATE_KEY`** (a real account SSH keypair) — required for
  `ssh-key generate-api-key --vm=...` (minting a VM-scoped Shelley key) and
  `integrations list`/`attach` (GitHub repo access). Both return `403
  command not allowed by token permissions` over the bearer path no matter
  how the token is scoped — this isn't a scoping bug to work around, it's a
  deliberate boundary (a token must not be usable to mint further
  credentials). Also used, connected directly to a VM's own `<vm>.exe.xyz`
  hostname rather than the exe.dev control host, for the post-boot readiness
  check and the repo clone.

`internal/exe.Client` is the bearer surface; `internal/exe.AdminClient` is
the SSH one. `internal/orchestrate.Orchestrator` holds both.

## Shelley access

Over Shelley's **public HTTPS route** (`https://<vm>.shelley.exe.xyz`) using
a VM-scoped bearer token minted via `ssh-key generate-api-key --vm=<vm>`
right after the box comes up. This is deliberate, not a fallback: Shelley's
local API on `localhost:9999` requires an `X-Exedev-Userid` header that only
exe.dev's own authenticated proxy can supply, so a raw SSH tunnel to
localhost can't reach it (confirmed — every route except `/version` returns
`403 missing required header`). `internal/shelley.DirectTransport` is a
plain `net/http` client; no shell quoting or injection concerns, since
nothing is being embedded into a remote shell command.

Confirmed fire-and-forget: `POST /api/conversations/new` and
`POST /api/conversation/<id>/chat` both return immediately (201/202
accepted) — the agent's actual work happens asynchronously inside Shelley,
never blocking the caller.

## GitHub access inside the VM

Via an exe.dev GitHub integration, configured once per repo through the
exe.dev dashboard OAuth flow, then attached to each box at Provision time
(`integrations attach <name> vm:<vm>`). The clone/`gh` hostname is the
**fixed** `github.int.exe.xyz` proxy (see
https://exe.dev/docs/integrations-github) — one host for every integration
on the account, disambiguated by the `owner/repo` path, not a
per-integration subdomain (an earlier version of this doc claimed the
opposite based on spike testing; exe.dev's proxy behavior has since
changed, or the spike's finding was wrong from the start — either way,
the fixed hostname is what's confirmed working now).
`internal/orchestrate.Provision` still looks the integration up via
`integrations list` (filtered by `repos=<owner>/<repo>`) to attach it to
the box, but no longer uses its name for the clone URL.
`GH_HOST=github.int.exe.xyz` is also exported into every VM's environment
at creation time so the agent's own `gh` usage picks up the proxy
automatically.

## No polling from GitHub Actions

Every Actions job fires a request and exits immediately — it never waits for
or polls the agent. This falls out naturally from Shelley's API being
fire-and-forget (see above): there's nothing to background or detach,
`NewConversation`/`Chat` just return fast. "Agent turn finished" is
self-detected by the agent itself (Shelley runs `gh pr create` as one of its
own tool calls, per the seeded prompt's instructions); Actions only
re-enters on external events (issue/PR comments, `issues closed`, the
reaper cron).
