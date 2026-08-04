# Custom exe.dev VM image: exeuntu base + what this action's agent needs to run.
# See https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile for the base image.
FROM ghcr.io/boldsoftware/exeuntu:latest

# Node 24 (apt's nodejs is far behind; use NodeSource).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# pnpm via corepack (ships with Node).
RUN corepack enable && corepack prepare pnpm@latest --activate

# opencode CLI — the SDK's remote client talks to `opencode serve` started on this VM.
RUN curl -fsSL https://opencode.ai/install | bash

# Playwright + Chrome. Managed separately from the headless-shell Chrome already in the
# base image (chromedp/CDP use) to avoid a version mismatch with Playwright's own pins.
RUN npm install -g playwright && \
    playwright install --with-deps chromium
