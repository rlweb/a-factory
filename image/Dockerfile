# a-factory VM image: exeuntu base (ships Shelley on port 9999, started
# automatically — no boot service needed) + the mattpocock/skills library the
# ticket/bug/epic prompts invoke (/tdd, /diagnosing-bugs, /code-review,
# /wayfinder, /domain-modeling, /to-tickets).
#
# There is deliberately no per-box boot script: custom-model registration and
# the repo checkout are ordinary Shelley/exe.dev API calls, so orchestrate.Provision
# (internal/orchestrate) issues them directly — a bearer-token HTTPS client for
# VM lifecycle (new/rm/ls) and Shelley's own HTTPS API (once a VM-scoped key is
# minted), plus an SSH admin client for the handful of operations exe.dev
# restricts to account-authenticated sessions (minting that key, attaching the
# GitHub integration, cloning the repo). See docs/spike-findings.md and
# AGENTS.md. All of this is well-tested Go code, not an opaque shell script
# racing Shelley's own startup.
#
# Consumer repos with a specific toolchain (Node, Go, Python, ...) should
# extend this image with their own build tools/linters — this base only
# guarantees the skills library and the tools a-factory's own orchestration
# needs on the box (git, curl, jq).
FROM ghcr.io/boldsoftware/exeuntu:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl jq \
    && rm -rf /var/lib/apt/lists/*

# Pinned to a release tag, not `main` — these skills have had breaking
# releases (see AGENTS.md).
ARG SKILLS_REF=v1.2.0
RUN git clone --depth 1 --branch "$SKILLS_REF" https://github.com/mattpocock/skills.git /tmp/mp-skills \
    && mkdir -p /root/.agents/skills \
    && cp -r /tmp/mp-skills/skills/* /root/.agents/skills/ \
    && rm -rf /tmp/mp-skills
