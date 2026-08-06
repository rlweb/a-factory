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
# Common web-project tooling is included so agents can immediately run the
# usual install, test, and browser-validation commands. Consumer repos can
# still extend this image with project-specific tools and linters.
FROM node:22-bookworm-slim AS node

FROM ghcr.io/boldsoftware/exeuntu:latest

ARG PNPM_VERSION=10.12.4
ARG PLAYWRIGHT_VERSION=1.52.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=node /usr/local /usr/local

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git curl jq \
    && corepack enable pnpm \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && npm install --global "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# Pinned to a release tag, not `main` — these skills have had breaking
# releases (see AGENTS.md).
ARG SKILLS_REF=v1.2.0
RUN git clone --depth 1 --branch "$SKILLS_REF" https://github.com/mattpocock/skills.git /tmp/mp-skills \
    && mkdir -p /root/.agents/skills \
    && cp -r /tmp/mp-skills/skills/* /root/.agents/skills/ \
    && rm -rf /tmp/mp-skills
