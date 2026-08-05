# a-factory

Opening a GitHub issue spins up an exe.dev VM running [opencode](https://opencode.ai), seeded
with the issue. The agent implements it, branches, commits, and pushes. If it needs something
clarified, it asks on the issue — a human reply resumes the *same* opencode session (not a
fresh one). Closing the issue tears the VM down.

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
          opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
          ssh-exe-private-key: ${{ secrets.SSH_EXE_PRIVATE_KEY }}
```

### Inputs

| Input               | Required | Description                                              |
| -------------------- | -------- | ---------------------------------------------------------- |
| `opencode-api-key`    | yes      | Model provider API key opencode uses on the VM.             |
| `ssh-exe-private-key`   | yes      | SSH private key for `ssh exe.dev` calls.                        |
| `vm-image`              | no       | Custom VM image (defaults to this repo's own, see `Dockerfile`). |
| `github-token`           | no       | Defaults to the job's `GITHUB_TOKEN`.                             |

## How it works

- **Issue opened** — creates an exe.dev VM, starts `opencode serve` on it, and prompts it with
  the issue. The agent clones the repo, branches, implements, commits, and pushes from inside
  the VM. If it finishes, this action opens the PR and destroys the VM. If it needs something
  clarified, it posts questions on the issue (with a hidden marker recording which VM/session
  asked) and leaves the VM running.
- **Issue comment** — if the issue is `awaiting-answer` and the comment isn't from the bot
  itself, the reply is sent into the *same* opencode session on the *same* VM.
- **Issue closed** — the VM for that issue is destroyed, whatever state it was in.

## Development

```
pnpm install
pnpm run verify   # typecheck + build
```

`dist/index.js` is committed (required for JS actions — consumers never run `npm install`
against this repo) and checked for staleness in CI.
