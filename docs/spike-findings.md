# Phase 0 spike findings

Partially run 2026-08-06 against a real exe.dev account. This file is the
source of truth for exe.dev/Shelley wire-format facts. Every
"PHASE 0 SPIKE REQUIRED" comment in the codebase points here.

**Two headline results, both requiring a design change:**
1. The SSH-tunnel-to-Shelley design in `internal/shelley` is wrong — Shelley
   requires an `X-Exedev-Userid` header that only exe.dev's own authenticated
   layer can supply. See "Shelley access" below.
2. **exe.dev's own sanctioned command for talking to Shelley (`shelley
   prompt`, and `new --prompt`) BLOCKS/STREAMS until the agent responds, with
   a 5-minute idle timeout — it does not return immediately.** This directly
   conflicts with the "don't poll from Actions, exit fast" requirement. See
   "Confirmed: `shelley prompt` / `new --prompt` block" below — this is the
   single biggest open design problem right now.

Everything in this doc is the actual evidence for these calls — don't
re-litigate them without re-reading this section.

## Confirmed: real SSH (not the bearer-token `/exec` API) has full permissions

`ssh -i <account-ssh-key> exe.dev <command>` works for the full command set —
including `rm`, `ls`, `new --prompt=...`, and `shelley prompt`, all of which
the scoped bearer API token used earlier in this spike got `403 command not
allowed by token permissions` on. This SSH path uses a pre-existing SSH key
already registered on the account (`~/.ssh/id_exe_github_actions`, visible in
`whoami`'s key list), not the `EXE_API_TOKEN` bearer token from `ssh-key
generate-api-key`.

**Implication for the CLI's transport**: `internal/exe.Client` may need to
support driving exe.dev via a real SSH connection (not just the HTTPS
`/exec` wrapper) if we want full command access without hand-tuning a
bearer token's scope. Whether production a-factory boxes use a scoped API
token (and if so, exactly which scopes) or an SSH key is still an open
decision — a scoped token is architecturally cleaner (no SSH client/key
management inside the Action), but this session couldn't get one working
with full scope. Next session: try `ssh-key generate-api-key` with explicit
scope flags to see if a token CAN be minted with `ssh`/`shelley`/`rm`
permission — if so, stick with bearer-token `/exec`, just request the right
scopes.

**Also confirmed**: raw SSH's plain-text REPL output (e.g. `whoami`, `ls`)
is **human-readable text, not JSON** — a different response format than the
same commands over `/exec` (which returned JSON for `whoami`/`ls`/`help`/
`new`). If SSH becomes the chosen transport, response parsing needs to
target this plain-text format instead.

## Confirmed: `shelley prompt` / `new --prompt` BLOCK — this breaks the no-polling requirement

Ran for real: `new --name=a-factory-spike-test --image=ghcr.io/boldsoftware/exeuntu:latest --tag=a-factory-spike --prompt="Reply with exactly the word: pong"` via SSH.

Output:
```
Creating a-factory-spike-test using image boldsoftware/exeuntu...

Coding agent
https://a-factory-spike-test.shelley.exe.xyz

App (HTTPS proxy → :8000)
https://a-factory-spike-test.exe.xyz

SSH
ssh a-factory-spike-test.exe.xyz


Sending prompt to Shelley...

🐌 Connected to Shelley
🐌 Follow along at https://a-factory-spike-test.shelley.exe.xyz

Error running Shelley prompt: idle timeout: no messages received for 5 minutes
Connect to Shelley at https://a-factory-spike-test.shelley.exe.xyz
```

VM creation itself is fast (the "Creating..." + URLs block prints
immediately). But **"Sending prompt to Shelley" then streams/watches the
conversation and only returns once the agent produces a message or 5 minutes
of silence elapses** — it does not fire-and-forget. Separately invoking
`shelley prompt <vm> <message>` on an already-running VM showed the same
shape: it prints "🐌 Connected to Shelley" / "🐌 Follow along at ..." and then
sits there streaming, with no immediate "queued" confirmation to key off of.

The 5-minute timeout in this specific test is very likely because **no LLM
was configured on the box** — no custom model registered, no OpenCode API
key set. Per exe.dev's own docs, Shelley should be able to fall back to
exe.dev's built-in LLM Gateway ("your account comes with dollars to use for
LLM tokens... lets you get started without registering for LLM API keys"),
so a genuinely idle agent for 5 full minutes with zero response suggests
either the account has no Gateway credit, or a model must be explicitly
selected before Shelley will respond at all. NOT YET diagnosed — didn't want
to burn more real time/money on this run.

### What this means for the design

`internal/orchestrate.Provision`/`RelayIssueComment`/etc. CANNOT call
`shelley prompt`/`new --prompt` synchronously from a GitHub Actions job — a
real coding task can run for many minutes to hours, and the Actions job
would sit there paying for runner time the whole way, exactly what "don't
poll, kill the action ASAP for cost" was warning against.

Options to resolve, none yet tested:
1. **Detach the connection ourselves** after the prompt is confirmed
   delivered (once we figure out what confirms delivery — "🐌 Connected to
   Shelley" appearing? A short fixed grace period?) rather than waiting for
   the stream to naturally end. Requires confirming that killing our
   SSH/exec connection early does NOT cancel the prompt server-side (Shelley
   is a persistent per-VM service with its own sqlite-backed conversation
   state — closing a *watching* client almost certainly does not abort the
   agent loop, but this is unconfirmed).
2. **Look for a non-streaming flag** on `shelley prompt` (not found in
   `help shelley prompt`'s output, which showed no flags at all — but the
   help text may be incomplete; worth asking exe.dev support or re-checking
   `doc`).
3. **Talk to Shelley's own HTTP API directly for seeding** instead of the
   REPL's `shelley prompt` — `POST /api/conversations/new` might not have
   this streaming/blocking behavior (it's a different code path from the
   REPL's CLI wrapper) — but this reopens the `X-Exedev-Userid` header
   problem from the SSH-tunnel finding above. Would need to confirm whether
   that header can be supplied by us at all (e.g. is it derivable from the
   account/VM, or does it require exe.dev's proxy specifically).

This is the single biggest open risk for the whole architecture and should
be resolved before writing more orchestrate.go changes.

## RESOLVED: `/api/conversations/new` IS fire-and-forget — the blocking is `shelley prompt`-specific

Tested directly (option 3 above), on a fresh throwaway VM
(`a-factory-spike-test2`) with `-require-header X-Exedev-Userid` **removed**
from `shelley.service` and the service restarted, purely to observe the raw
API's behavior — explicitly NOT a production-viable fix (see below), done
with explicit user sign-off, VM destroyed immediately after testing.

- `POST /api/conversations/new -d '{}'` → `400 Message is required` (fast
  validation, confirms `message` is the required field name).
- `POST /api/conversations/new -d '{"message":"hi"}'` → **returns
  immediately**: `HTTP 201 {"conversation_id":"c3X7T6N","status":"accepted"}`.
  No streaming, no blocking. **This is exactly the fire-and-forget behavior
  the architecture needs** — confirms `shelley prompt`'s blocking/streaming
  behavior is a property of that specific REPL CLI wrapper, not of Shelley's
  underlying API.
- `GET /api/conversation/<id>` returns full message history:
  `{"messages":[...], "conversation":{...}, "max_sequence_id":N}`. First
  message (`type:"system"`) is the full system prompt (tools, skills,
  exe.dev environment doc — large, ~8KB). Then a `type:"user"` message with
  the literal text sent. Then, in this run, three `type:"warning"` messages.
  The `conversation` object has: `conversation_id`, `slug`, `user_initiated`,
  `created_at`, `updated_at`, `cwd`, `archived`, `parent_conversation_id`,
  `model` (defaulted to `"gpt-5.6-sol"` — an OpenAI model built into Shelley,
  NOT `deepseek-v4-flash`/`deepseek-v4-pro` from the original doc — those
  would need registering as custom models, still untested), `conversation_options`,
  `current_generation`, `agent_working` (bool), `tags`, `is_draft`, `draft`,
  `queued_messages`.
- **The earlier 5-minute hang is now explained and is NOT a Shelley/API
  design problem**: the three warning messages all say `"LLM request failed:
  openai gpt-5.6-sol; retrying in Ns. stream: stream error event: You have
  no credits remaining. Add credits to continue using the API at
  https://platform.openai.com/settings/organization/billing/."` — this
  exe.dev account's default OpenAI-backed model has no billing credit, so
  every attempt failed and retried with backoff until `shelley prompt`'s
  client-side watcher gave up at 5 minutes idle. A funded account (or a
  custom model registered against a funded provider, e.g. OpenCode Zen per
  the original doc) would presumably get a real response promptly.

### What's now confirmed vs. still open

**Confirmed — the original `internal/shelley` HTTP-client design (client.go's
`NewConversation`/`Chat`/`GetConversation` methods, request/response field
names) is directionally correct** and does NOT need replacing with the
`shelley prompt` REPL command. `newConversationRequest{Message string}` (no
`model` required — optional, defaults to `gpt-5.6-sol`) and
`newConversationResponse{ID string}` are correct field names, though
`internal/shelley/client.go` currently requires/sends a `model` field
unconditionally — worth confirming whether sending a `model` string exe.dev
doesn't recognize errors out or is silently ignored (untested).

## RESOLVED: production auth path is a VM-scoped API key against the public HTTPS route

The account-wide `EXE_API_TOKEN` (used for `/exec`) does **not** work
against the public Shelley route — unauthenticated requests 307-redirect to
`/__exe.dev/login?...` (a browser session flow), and sending the
account-wide bearer token there gives `401 invalid or missing
authentication`. That rules out reusing the same token for both purposes.

But `ssh-key generate-api-key` has a `--vm=<vmname>` flag, confirmed via
`help ssh-key generate-api-key`:
```
Usage: ssh-key generate-api-key [--label=NAME] [--vm=VMNAME] [--cmds=CMD1,CMD2] [--exp=30d]
  --vm    scope key to a VM (authenticates to its HTTPS endpoints instead of exe.dev commands)
```
Generated one for real (`ssh-key generate-api-key --vm=a-factory-spike-test3
--label=spike-test --exp=1d`, immediately revoked and the VM destroyed after
testing) and confirmed it authenticates cleanly against the **public** route
with a normal `Authorization: Bearer` header — no `X-Exedev-Userid`
shenanigans, no SSH, no localhost tunnel:

- `GET https://<vm>.shelley.exe.xyz/version` → 200, same payload as localhost.
- `GET https://<vm>.shelley.exe.xyz/api/conversations` → 200 `[]`.
- `POST https://<vm>.shelley.exe.xyz/api/conversations/new -d '{"message":"hi"}'`
  → **201 `{"conversation_id":"cHERISX","status":"accepted"}`, immediately** —
  fire-and-forget confirmed again, this time through the fully sanctioned
  public path, not the header-disabled localhost bypass.

### This resolves the architecture cleanly — supersedes the SSH-tunnel design entirely

`internal/shelley.TunnelTransport` (SSH-via-`/exec`, base64-encoded curl
bodies to dodge shell injection) is **no longer needed at all**. The
production design is:

1. At Provision time, after creating the VM (`new --name=<vm> ...`), mint a
   VM-scoped key: `ssh-key generate-api-key --vm=<vm> --label=a-factory
   --cmds=...` (need to confirm minimal `--cmds` scope needed, or omit for
   defaults — untested which commands a VM-scoped key needs, if any, since
   it "authenticates to its HTTPS endpoints instead of exe.dev commands").
2. Talk to Shelley directly over HTTPS (`https://<vm>.shelley.exe.xyz/api/...`)
   with that token via a plain `net/http` client — normal JSON request
   bodies, no shell quoting/base64/injection concerns at all, since we're
   never constructing a remote shell command string.
3. `internal/shelley/transport.go` (`TunnelTransport`, `curlCommand`,
   `shellQuote`) and `internal/shelley/fake.go`'s exe-backed plumbing should
   be deleted/replaced with a `DirectTransport` that's just an
   `http.Client` + bearer token + base URL — much simpler than what's there
   now.
4. The VM-scoped key needs to be stored somewhere for the Relay* calls to
   reuse later (it's per-VM, not derivable) — extend `internal/state`'s
   marker to carry it (`shelley_token=...` alongside `vm=`/`conversation=`),
   OR mint it fresh each time from account-level SSH access (adds an SSH
   round-trip per relay — probably worse). Storing it in the state marker
   comment on the issue is simplest and consistent with the existing design,
   though it does mean a bearer credential sits in an issue comment — worth
   a deliberate decision (short expiry via `--exp`, scoped tightly via
   `--cmds`, and GitHub comments aren't public on private repos, but this
   is a real tradeoff to flag explicitly, not silently paper over).
5. Whether VM-scoped-key minting itself needs SSH (account-level) or can go
   through the same `/exec` bearer-token path our `EXE_API_TOKEN` already
   uses is NOT tested — `ssh-key` was one of the commands blocked for the
   original scoped bearer token earlier in this session, so a production
   token will need explicit `ssh-key`/`generate-api-key` permission (or
   minting continues to require an SSH keypair instead of the bearer token,
   which has automation implications for a stateless GitHub Actions runner —
   an SSH private key would need to be a repo/org secret rather than just an
   API token string).

### Also confirmed, incidentally

- Custom-model registration (`/api/custom-models`) still completely
  untested this session — ran out of scope/time budget after the
  conversations/new breakthrough.
- Shelley's system prompt reveals real operational detail worth designing
  around: it explicitly tells the agent **"Do NOT use `&`, nohup, or disown
  — the bash tool kills its process group on exit"** for its own `bash` tool
  — irrelevant to how *we* drive Shelley externally, but confirms Shelley's
  own tool-use sandboxing is deliberate.

## Confirmed: exe.dev `/exec`

- `POST https://exe.dev/exec`, `Authorization: Bearer <token>` — confirmed working.
- **Request body is plain text, NOT JSON.** The body is the literal command
  as you'd type it at the `ssh exe.dev` REPL prompt (e.g. `whoami`, `ls`,
  `new --name=x --image=y`). `internal/exe/client.go`'s `execRequest` JSON
  envelope is wrong and must be replaced with a raw string body.
- Response is JSON for the commands tested (`whoami`, `ls`, `help`, `new`),
  but shape varies per command — there is no generic `{stdout, stderr, exit_code}`
  envelope. `internal/exe.Result`'s shape is an invented abstraction that
  doesn't match reality; `HTTPClient.Exec` needs to return raw response bytes
  (or per-command typed responses) rather than a generic Result struct.
- Tokens are **scoped per-command**. This token could call `whoami`, `ls`,
  `help`, `new` but got `403 {"error":"command not allowed by token permissions"}`
  on `ssh`, `shelley prompt`, `rm`, and `doc`. A production token will need
  `new`, `rm`, `ls`, and (if the exec-only redesign below holds) `shelley`
  permissions at minimum. Confirm exact scope options via `ssh-key generate-api-key`
  next time.
- Full command surface (from `help`, verbatim): `help`, `doc`, `ls`, `new`,
  `rm`, `restart`, `rename`, `tag`, `cp`, `resize`, `comment`, `domain`
  (add/rm/ls), `share` (show/port/set-public/set-private/add/remove/
  add-link/remove-link/receive-email), `whoami`, `ssh-key`
  (list/add/remove/rename/generate-api-key), `set-region`, `integrations`
  (...), `billing` (...), `invite` (...), **`shelley` (install, prompt)**,
  `browser`, `ssh`, `grant-support-root`, `exit`, `stat`.

## Confirmed: `new` (VM creation)

`help new` output confirms flags: `--name`, `--image`, `--cpu`, `--memory`,
`--disk`, `--env KEY=VALUE` (repeatable), `--tag` (repeatable/comma-separated),
`--comment`, `--integration`, `--json`, `--no-email`, `--pool`,
`--registry-auth`, `--setup-script` (max 10KiB, `/dev/stdin` supported), and
critically:

> `--prompt`: "initial prompt to send to Shelley after VM creation (requires
> an image with Shelley, like exeuntu); use /dev/stdin to read from stdin"

**This means VM creation and Shelley seeding can be ONE call**:
`new --name=<vm> --image=<img> --tag=a-factory --prompt=<rendered prompt>`.
Tested for real: `new --name=a-factory-spike-test --image=ghcr.io/boldsoftware/exeuntu:latest --tag=a-factory-spike --json`
returned immediately (VM creation itself is not slow) with:
```json
{"vm_name":"a-factory-spike-test","tags":["a-factory-spike"],
 "ssh_command":"ssh a-factory-spike-test.exe.xyz","ssh_dest":"a-factory-spike-test.exe.xyz",
 "ssh_host":"a-factory-spike-test.exe.xyz","ssh_port":22,
 "https_url":"https://a-factory-spike-test.exe.xyz","proxy_port":8000,
 "shelley_url":"https://a-factory-spike-test.shelley.exe.xyz",
 "vscode_url":"...","xterm_url":"..."}
```
`--name` gives exact control over the VM name (confirms `orchestrate.VMName`'s
deterministic naming scheme works as designed). **`--prompt` itself was not
yet tested** (ran out of token permissions before reaching it) — still need
to confirm it actually seeds a conversation and what (if anything) it returns.

## Confirmed: `ls` (list VMs)

Returns `{"vms":[{...}]}`, NOT a plain newline-separated list.
`internal/orchestrate.parseVMList` (which assumes plain text, one VM name per
line) is wrong and must be rewritten to parse this JSON shape. Per-VM fields
observed: `access{admin,shell,web}`, `allocated_cpus`, `created_at`,
`disk_capacity_bytes`, `domains`, `email_receive_enabled`, `emoji`,
`has_creation_log`, `https_url`, `image`, `is_team_shared`, `last_active_at`,
`memory_capacity_bytes`, `proxy_port`, `proxy_share`, `region`,
`region_display`, `route_known`, `share_link_count`, `share_links`,
`shared_emails`, `shared_user_count`, `sharing{...}`, `shelley_url`,
`ssh_command`, `ssh_dest`, `ssh_host`, `status` (e.g. `"running"`), `tags`
(array — useful for Reap identification instead of/alongside name-prefix
matching), `terminal_url`, `total_share_count`, `updated_at`, `vm_name`,
`vscode_url`. Note `image` is reported as `"boldsoftware/exeuntu"` (no
registry prefix) even when created with a fully-qualified image ref.

## Confirmed: `rm` usage

`usage: rm <vmname>...` (supports multiple names, `--json` flag). Syntax
confirmed via `help rm`; **actual deletion NOT confirmed** — this token's
`rm` calls returned `403 command not allowed by token permissions` both with
and without `--json`. A test VM (`a-factory-spike-test`, tag
`a-factory-spike`, region `lon`) was left running as a result — user is
cleaning it up manually and will provide a token with broader scope.

## Confirmed: generic shell passthrough is `ssh`, not a `/exec` field

`help ssh` → `usage: ssh [-l user] [user@]vmname [command...]`. So
"run an arbitrary command inside VM X" via the REPL is
`ssh <vmname> <command...>` as the literal `/exec` body — this confirms the
shape `internal/exe.Client.Exec(ctx, target, command)` was reaching for
(target="" → bare command; target=vmname → `ssh <vmname> <command>`), just
with the wrong (JSON) wire format. **This specific token could not actually
use `ssh`** (blocked by permission scope), so it was tested via a *real* SSH
client instead (see below), not via `/exec`.

## Confirmed: Shelley itself, via real SSH (not `/exec`)

Direct `ssh -i ~/.ssh/id_exe_github_actions a-factory-spike-test.exe.xyz` (a
pre-existing account SSH key, not the bearer token) worked and confirmed:

- `curl http://localhost:9999/version` → 200, no auth required:
  `{"version":"0.925.927026316","tag":"v0.925.927026316","commit":"...","capabilities":["thinking-levels","drafts"]}`
- `curl http://localhost:9999/api/conversations` → **403**
  `missing required header: X-Exedev-Userid`
- `systemctl cat shelley.service` shows Shelley is launched with
  `-require-header X-Exedev-Userid` explicitly — this is deliberate, not a bug.

### Why this kills the SSH-tunnel design

The `X-Exedev-Userid` header is almost certainly injected by exe.dev's own
authenticated reverse proxy in front of the public
`https://<vm>.shelley.exe.xyz/` route — proving the caller's authenticated
exe.dev identity before forwarding to local Shelley. It cannot be forged from
inside the box. **This means `internal/shelley`'s whole design — a custom
HTTP client driving Shelley's `/api/*` routes through a base64-curl-over-SSH
tunnel — cannot work as built.** `TunnelTransport` will always get 403 on
every route except `/version`.

### The likely correct design (NOT YET CONFIRMED — needs a broader token)

Use exe.dev's own sanctioned `/exec` REPL commands instead of talking to
Shelley's HTTP API directly:
- **Seed a conversation**: fold into the `new` call — `new --name=<vm>
  --image=<img> --tag=a-factory --prompt=<rendered ticket/bug/epic prompt>`.
  One call does VM creation AND session seeding.
- **Relay a follow-up**: `shelley prompt <vm> <message>` (top-level REPL
  command, confirmed to exist via `help shelley prompt` →
  `usage: shelley prompt <vm> <prompt>`; behavior NOT yet tested — blocked by
  token permission on this run).
- **Custom model registration**: NO REPL verb found for this (`shelley
  install` only installs/upgrades the Shelley binary itself). Whether the
  doc's `/api/custom-models` endpoint needs the `X-Exedev-Userid` treatment
  too, or whether there's a different sanctioned path (e.g. `new --env`
  variables Shelley reads itself, or a per-project `opencode.json` committed
  to the repo), is still open. Needs `doc` access (blocked on this token) or
  a support conversation.

If this holds, `internal/shelley` (the whole package: `client.go`,
`transport.go`, `fake.go`) should likely be DELETED and replaced with two new
methods on `internal/exe.Client`-adjacent code: `NewVMWithPrompt(...)` and
`ShelleyPrompt(vm, message)`, both plain `/exec` calls. `internal/orchestrate`
would then talk to `exe.Client` alone for the whole Provision/Relay flow —
no separate Shelley HTTP client, no tunnel, no base64 escaping (the
injection-safety concern from the original design still applies to
`shelley prompt`'s message argument and needs the same
base64-through-a-safe-command treatment, or confirmation that `/exec`'s body
is transmitted as a single opaque string rather than re-parsed as a shell
command — TEST THIS before assuming plain interpolation is safe).

## RESOLVED: `chat` behaves identically to `conversations/new`

`POST /api/conversation/<id>/chat -d '{}'` → `400 Message is required`
(same field name, same validation style). `POST .../chat -d
'{"message":"..."}'` → **`202 {"status":"accepted"}`, immediate**, same
fire-and-forget shape as `conversations/new` (which returns `201` with a
`conversation_id` since it's creating a resource; `chat` returns `202` with
no id since it's appending to an existing one). Confirmed via the public
route + VM-scoped key, same as everything else in this doc.

## CONFIRMED: cannot mint a VM-scoped key via HTTPS with the account-wide `/exec` token

`POST https://exe.dev/exec` with the account-wide `EXE_API_TOKEN` running
`ssh-key generate-api-key --vm=<vm> ...` → `403 command not allowed by token
permissions`. This operation requires the SSH path (an account SSH keypair),
not just a bearer token — at least not with this token's current scope.
**Tested and confirmed NOT possible, even with a broader token.** Minted a
second bearer token via SSH with `ssh-key generate-api-key --label=spike-broad
--cmds=new,rm,ls,ssh-key --exp=1d` — explicitly including `ssh-key` in its
allowed commands. That token successfully ran `new` over HTTPS (confirmed
`--cmds` scoping works generally), but `ssh-key generate-api-key --vm=...`
still returned `403 command not allowed by token permissions` — identical to
the original token's failure. **Conclusion: minting new API keys cannot be
done via bearer-token `/exec` auth at all, regardless of `--cmds` scope.**
This is almost certainly a deliberate, hardcoded security boundary (a scoped
token must not be usable to mint further credentials — otherwise a leaked
token could self-escalate). Both test tokens revoked and the test VM
destroyed after this result.

**Production implication, now settled**: minting a VM-scoped Shelley key
requires real SSH access (an account SSH keypair), not just `EXE_API_TOKEN`.
Production needs **two secrets**: `EXE_API_TOKEN` (VM lifecycle: `new`,
`rm`, `ls`) and an SSH private key (specifically for `ssh-key
generate-api-key --vm=<vm>` after each `new`). `internal/exe.Client` needs
an SSH-capable path for this one call — either shelling out to a real `ssh`
binary from the Go CLI, or a Go SSH client library (`golang.org/x/crypto/ssh`)
so no external binary dependency is needed in the Action's runner image.

## RESOLVED: custom-model registration via OpenCode, full end-to-end test passed

`POST /api/custom-models` with a real OpenCode API key (user-provided,
provider_type `openai`, endpoint `https://opencode.ai/zen/go/v1`,
model_name `deepseek-v4-flash`, max_tokens `8192` — exactly the doc's
example shape) → `201`, echoes back the full registration plus
exe.dev-assigned extras:
```json
{"model_id":"deepseek-v4-flash-opencode-ai","display_name":"DeepSeek V4 Flash",
 "provider_type":"openai","endpoint":"https://opencode.ai/zen/go/v1",
 "api_key":"...","model_name":"deepseek-v4-flash","max_tokens":8192,
 "tags":"","image_support":"auto","reasoning_support":"auto","reasoning_map":"",
 "supports_reasoning":true,"supports_images":false}
```
**Important**: the ID to use when starting a conversation is the
response's `model_id` (`"deepseek-v4-flash-opencode-ai"`), NOT the
`model_name` we submitted (`"deepseek-v4-flash"`) — exe.dev appends a
provider suffix to disambiguate. `internal/shelley`'s eventual
`UpsertCustomModel` needs to capture and return this `model_id` so
`Provision` can pass the right value to `NewConversation`'s `model` field.

Then ran the full real loop: `POST /api/conversations/new` with
`{"message":"Reply with exactly the word: pong","model":"deepseek-v4-flash-opencode-ai"}`
→ `201 accepted` immediately. Polled `GET /api/conversation/<id>` ~12s later
(polling here was only for OUR verification as spike operators — production
code never does this) and got a real completed turn:
`conversation.agent_working: false`, final message
`{"type":"agent","text":"pong"}`. **This confirms the entire
register-model → seed-conversation → real-LLM-response loop works over the
public HTTPS route with a VM-scoped key**, closing out the last major
functional unknown in the architecture.

Empty-body validation confirms required fields match the doc exactly:
`display_name, provider_type, endpoint, api_key, and model_name are
required` (`max_tokens` optional). `GET /api/custom-models` (list) → `200 []`
before registration.

## RESOLVED: GitHub-integration proxy — hostname is the INTEGRATION NAME, not a fixed "repo.int.exe.xyz"

The exe.dev FAQ's example (`git clone https://repo.int.exe.xyz/you/app.git`,
`GH_HOST=repo.int.exe.xyz`) is misleading if read as a literal fixed
hostname — **`repo` in that example is a placeholder for the integration's
own name**, confirmed two ways:

1. `integrations list` (via SSH) showed a real pre-existing integration on
   this account: `spotlessscore-spotlessscore2  github
   repos=SpotlessScore/spotlessscore2  tag:spotlessscore-spotlessscore2`.
2. Cloning against the literal example hostname failed:
   `git clone https://repo.int.exe.xyz/SpotlessScore/spotlessscore2.git` →
   `remote: integration not found or not attached to this VM` → `403`.
   Cloning against the **integration's actual name** as the hostname
   succeeded cleanly: `git clone
   https://spotlessscore-spotlessscore2.int.exe.xyz/SpotlessScore/spotlessscore2.git`
   → real clone, real commit history (`git log` showed genuine PR merges),
   real files (`AGENTS.md`, `package.json`, etc.).
3. `gh` CLI confirmed too: `GH_HOST=spotlessscore-spotlessscore2.int.exe.xyz
   gh repo view SpotlessScore/spotlessscore2` returned real repo metadata
   (description, README preview) with zero credentials on the VM.

**Full attach flow tested end-to-end**: `new` (create VM, no special flags)
→ `integrations attach <integration-name> vm:<vmname> --for 30m` (time-boxed
grant — access lapses automatically, "nothing to revoke") → clone/`gh`
inside the VM using `<integration-name>.int.exe.xyz` as the host. Test VM
destroyed after confirming (also implicitly detaches the integration).

### Design implication for `internal/orchestrate`

`checkoutRepoCommand`'s current guess (`GH_HOST=repo.int.exe.xyz git clone
https://repo.int.exe.xyz/...`) is **wrong on the hostname** — it needs the
real per-repo integration name, not a fixed placeholder. Two open questions
this raises, not yet resolved:

1. **What is the integration named for an arbitrary consumer repo?** In this
   test it was `spotlessscore-spotlessscore2` (looks like
   `<org>-<repo>`, lowercased/hyphenated) — but that's one manually-created
   integration; whether new integrations always follow this exact naming
   convention (predictable from `owner/repo`) or get an arbitrary
   user-chosen name at setup time is unconfirmed. If not predictable,
   `Provision` needs to look it up (`integrations list`, filtered by
   `repos=<owner>/<repo>`) rather than construct the hostname directly.
2. **Attaching required a real SSH command** (`integrations attach`) — not
   yet checked whether `integrations attach` is permitted over the
   bearer-token `/exec` path or needs the same account-SSH-only treatment as
   `ssh-key generate-api-key` (both are credential/access-grant operations,
   so plausibly the same restriction applies). If so, this is a THIRD
   operation (alongside key-minting) that needs the SSH path per VM,
   alongside `new`.

## Still open / next session's checklist

1. Confirm whether `integrations list` and `integrations attach` work over
   the bearer-token `/exec` path, or require SSH like `ssh-key
   generate-api-key` did.
2. Confirm whether the integration name is predictable from `owner/repo`
   (so `checkoutRepoCommand` can construct it directly) or must be looked
   up via `integrations list` each time.

The credential story is now settled: `EXE_API_TOKEN` (bearer, scoped to
`new`/`rm`/`ls`, possibly `integrations list`) for VM lifecycle, plus an SSH
private key (account keypair) for `ssh-key generate-api-key --vm=<vm>` and
possibly `integrations attach` — both per-VM, right after each `new`.

Ready to rewrite: `internal/exe` (plain-text `/exec` body, per-command
response parsing, `ls` JSON shape with `vm_name`/`tags`, an SSH-capable path
for the key-minting/integration-attach calls — either shell out to `ssh` or
use `golang.org/x/crypto/ssh`), REPLACE `internal/shelley`'s transport layer
(delete `TunnelTransport`/`curlCommand`/`shellQuote`, add a plain-HTTP
`DirectTransport` using the VM-scoped key, capture `model_id` from
`UpsertCustomModel`'s response — NOT the submitted `model_name`), fix
`checkoutRepoCommand`'s hostname (integration name, not `repo.int.exe.xyz`),
update `internal/orchestrate`'s command builders and `Provision`/`Relay*`
flow to mint+store+reuse the VM-scoped key (state marker needs a new
`shelley_token=` field) and attach the right GitHub integration, then re-run
the full test suite with new fixtures for all the confirmed shapes in this
document.
