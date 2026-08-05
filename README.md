# a-factory

Opening a GitHub issue spins up an exe.dev VM running [pi.dev](https://pi.dev) as a coding
harness via [openCode](https://opencode.ai). The agent clones the repo, implements the issue,
branches, commits, and creates a PR. If it needs something clarified, it asks on the issue —
a human reply resumes the same session. Closing the issue tears the VM down.

## Usage

Add this to a consumer repo as `.github/workflows/factory.yml`:

```yaml
name: factory

on:
  issues:
    types: [opened, closed]
  issue_comment:
    types: [created]

jobs:
  factory:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: rlweb/a-factory@v1
        with:
          ssh-exe-private-key: ${{ secrets.SSH_EXE_PRIVATE_KEY }}
          vm-env: |
            OPENCODE_API_KEY=${{ secrets.OPENCODE_API_KEY }}
          vm-cpu: 4
          vm-memory: 8G
          vm-disk: 50G
          vm-tag: prod,automation
```

### Inputs

| Input                   | Required | Description                                                      |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| `ssh-exe-private-key`   | yes      | SSH private key for `ssh exe.dev` calls.                         |
| `vm-image`              | no       | Custom VM image (defaults to this repo's own, see `Dockerfile`). |
| `vm-name-prefix`        | no       | Prefix for exe.dev VM names (default `a-factory`).               |
| `vm-cpu`                | no       | Number of CPUs for the VM (default `2`).                         |
| `vm-disk`               | no       | Disk size for the VM, e.g. `50G` (default `4G`).                 |
| `vm-env`                | no       | Extra VM environment variables, one `KEY=VALUE` per line.        |
| `vm-memory`             | no       | Memory allocation for the VM, e.g. `8G` (default `4GB`).         |
| `vm-tag`                | no       | Tags for the VM, comma-separated.                                |
| `github-token`          | no       | Defaults to the job's `GITHUB_TOKEN`.                            |

## How it works

- **Issue opened** — creates an exe.dev VM. The VM image boots pi-harness automatically as a
  systemd service. The Action waits for the harness to be ready, then POSTs the issue details
  (`owner`, `repo`, `issueNumber`). The harness fetches the issue via GitHub API, clones the
  repo, and starts a pi session:
  - If it finishes, the harness runs `VERIFY_COMMAND` (default `pnpm run verify`), pushes the
    branch, creates a PR via GitHub API, and reports done. The Action logs and destroys the VM.
  - If blocked, the harness posts clarifying questions as a comment on the issue and reports
    back. The Action adds the `awaiting-answer` label and exits, leaving the VM running.
- **Issue comment** — if the issue has the `awaiting-answer` label, the Action calls the
  harness with a wake-up signal. The harness fetches the latest human comment from the GitHub
  API and feeds it to the agent, resuming the same session.
- **Issue closed** — the VM for that issue is destroyed.

### VM image (Dockerfile)

The custom VM image extends [exeuntu](https://github.com/boldsoftware/exeuntu) with:

1. **Node 24** (NodeSource)
2. **pnpm** (global, for consumer repo verify commands)
3. **Playwright + Chromium** (browser testing)
4. **pi-harness** — an HTTP server wrapping pi's SDK with openCode as the model backend,
   installed as a systemd service that auto-starts on boot:

```
pi-harness.service
  ├─ Listens on port 4096
  ├─ GET  /             — session state snapshot
  ├─ POST /             — start a task (blocks until question or done)
  └─ POST /issue/comment — resume from a question (blocks until question or done)
```

See `Dockerfile` and `pkg/pi-harness/` for the service definition and source.

### OpenCode bridge

The harness uses pi's extensible model system to register openCode as a provider. An `OPENCODE_API_KEY`
environment variable (passed via `vm-env`) authenticates the `oc-sdk-go` provider against
`https://opencode.ai/zen/go/v1`. No CLI login needed — the key flows from the Action's secret
through the VM environment to the pi-harness service at boot.

## Development

```
pnpm install
pnpm run verify   # typecheck + test + build
```

`dist/index.js` is committed (required for JS actions — consumers never run `pnpm install`
against this repo) and checked for staleness in CI. `pkg/pi-harness/dist/index.js` is also
committed for the VM image build.
