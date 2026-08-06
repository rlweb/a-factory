# a-factory

Open a GitHub issue. A dedicated cloud machine spins up, a coding agent
([Shelley](https://exe.dev/docs/shelley), running on [exe.dev](https://exe.dev))
implements it, and opens a PR. Reply on the issue or PR and the same agent
picks it back up. Close the issue and the machine goes away.

```
issue opened → box created → agent seeded → ... → PR opened → issue closed → box destroyed
```

## Quickstart

1. **Connect the repo on exe.dev.** In the exe.dev dashboard, set up a
   GitHub integration for the repo you want to automate (Integrations →
   GitHub → connect). This is what lets a box `git clone`/`gh` the repo with
   no PAT ever touching the machine.
2. **Add secrets** to the repo (or org): see [Secrets](#secrets) below.
3. **Drop in the workflow.** Copy
   [`consumer-template/.github/workflows/factory.yml`](consumer-template/.github/workflows/factory.yml)
   into your repo — it's the only file you need. Optionally copy the issue
   forms from
   [`consumer-template/.github/ISSUE_TEMPLATE/`](consumer-template/.github/ISSUE_TEMPLATE/)
   too, so `type:ticket`/`type:bug`/`type:epic` labels get applied
   automatically.
4. **Define two commands in your own repo's `AGENTS.md` or Makefile** — see
   [Gates](#gates) below. Without these, a-factory has nothing to enforce
   before opening a PR or serving a preview.
5. Open an issue with a `type:ticket`, `type:bug`, or `type:epic` label.

### VM options

The action exposes exe.dev `new` options through `with:` inputs. Omitted values
use exe.dev defaults.

| Input | Maps to | Example |
|---|---|---|
| `vm-image` | `--image` | `ghcr.io/rlweb/a-factory:latest` |
| `vm-cpu` | `--cpu` | `4` |
| `vm-memory` | `--memory` | `16GB` |
| `vm-disk` | `--disk` | `50GB` |
| `vm-tags` | additional `--tag` values | `preview,staging` |
| `vm-env` | repeated `--env` values | `FOO=bar,BAZ=qux` |
| `vm-pool` | `--pool` | `team-pool` |
| `vm-integrations` | repeated `--integration` values | `monitoring` |
| `vm-registry-auth` | `--registry-auth` | `${{ secrets.REGISTRY_AUTH }}` |
| `vm-setup-script` | `--setup-script` | `#!/bin/sh\necho ready` |

`vm-prefix` controls deterministic names (`<prefix>-issue-<number>`), and is
not passed as an exe.dev option. The factory always adds its `a-factory` tag,
uses the deterministic `--name`, requests `--json`, sets `--no-email`, and
sets comment to `Created by a-factory via GitHub Actions.`. It does not expose
`--prompt`: Shelley is seeded through its fire-and-forget API after VM setup.
`--prompt` would also block the Actions job.

Example:

```yaml
- uses: rlweb/a-factory@v1
  with:
    exe-api-token: ${{ secrets.EXE_API_TOKEN }}
    exe-ssh-private-key: ${{ secrets.EXE_SSH_PRIVATE_KEY }}
    vm-cpu: '4'
    vm-memory: 16GB
    vm-disk: 50GB
    vm-tags: preview
    vm-env: 'NODE_ENV=development,FEATURE_X=true'
```

## Secrets

| Secret | What it's for |
|---|---|
| `EXE_API_TOKEN` | exe.dev bearer token for VM lifecycle (create/destroy/list). Mint via `ssh exe.dev ssh-key generate-api-key --cmds=new,rm,ls`. |
| `EXE_SSH_PRIVATE_KEY` | An exe.dev account SSH private key. Required for minting each box its own scoped Shelley key and attaching GitHub repo access — exe.dev refuses both over *any* bearer token, regardless of scope (see [`docs/spike-findings.md`](docs/spike-findings.md)). |
| `OPENCODE_API_KEY` | Authenticates the custom models a-factory registers on each box (proxies through [OpenCode's](https://opencode.ai) LLM gateway). |
| `GITHUB_TOKEN` | Provided automatically by Actions — used for the workflow's own comments/labels, distinct from the in-box agent's own `git`/`gh` access. |

All account and VM SSH connections validate exe.dev's documented host-key
fingerprint (`SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`); host-key
verification cannot be disabled by action inputs. See exe.dev's
[host-key FAQ](https://exe.dev/docs/faq/host-key).

## Issue types

| Label | Mode | Model | What happens |
|---|---|---|---|
| `type:ticket` | Build | cheap | Implements the change test-first, opens a PR. |
| `type:bug` | Diagnose + build | cheap | Reproduces the bug before fixing it, opens a PR with a regression test. |
| `type:epic` | Plan | strong | No production code — researches, asks clarifying questions, decomposes into sub-tickets. |

Comments on the issue or its PR aren't a type — they resume the same
running session.

## Gates

Every ticket/bug run enforces two gates, defined by **your** repo, not
a-factory:

- **Verify** — one command that runs everything that must be green
  (typecheck, lint, test, build). Must pass, in full, immediately before any
  PR opens.
- **Preview** — one command that serves the built app on a port bound to
  `0.0.0.0`. exe.dev exposes it over HTTPS for the life of the box; the
  agent posts the URL on the PR so anyone can QA without a checkout. The
  port stays public for as long as the box lives — don't put real secrets
  or write access behind it.

a-factory requires these two commands to exist (and fails loudly on the
issue if they don't); it never decides what "passing" means for your repo.

## How it works

- **GitHub** is the interface and the record — issues, comments, PRs.
- **exe.dev** is the compute — one VM per open issue.
- **Shelley** is the agent running inside each VM.

The Go CLI in `cmd/a-factory` (bundled into the `rlweb/a-factory@v1`
composite action) reads the triggering event, routes it, and either
provisions a box, relays a comment/review into a running session, or tears
a box down — then exits immediately. It never polls or waits on the agent's
own work; Shelley's API is confirmed fire-and-forget, and the agent itself
runs `gh pr create` as one of its own actions once it's done.

For the full architecture, credential model, and confirmed exe.dev/Shelley
wire formats, see [`AGENTS.md`](AGENTS.md) and
[`docs/spike-findings.md`](docs/spike-findings.md).

## Development

```
go build ./...
make verify     # typecheck + lint + test — the gate this repo holds itself to
```

`make verify` never touches the network. The one path that hits real
exe.dev is `make smoke` (`cmd/smoke`), gated behind `FACTORY_SMOKE=1` plus
real credentials — run it manually, never in CI.

## VM image

The published default image is `ghcr.io/rlweb/a-factory:latest`. It extends
exeuntu with Node.js 22, pnpm, the Playwright CLI, and Chromium with its system
dependencies, alongside the factory's required tools and skills. The GHCR
package must be public so exe.dev can pull it when creating a VM.

Pull requests build the image without publishing it. Pushes to `main` publish
`latest`; version tags publish matching image tags.
