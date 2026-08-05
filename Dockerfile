# Custom exe.dev VM image: exeuntu base + Node + pi-harness systemd service.
# pi is already pre-installed in exeuntu; pi-harness wraps it as an HTTP server
# that auto-starts on boot via systemd. No SSH commands needed to bootstrap.
# See https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile for the base image.
FROM ghcr.io/boldsoftware/exeuntu:latest

# Node 24 (apt's nodejs is far behind; use NodeSource).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# pnpm (global, for verify commands in consumer repos).
RUN npm install -g pnpm

# Playwright + Chrome. Kept separate from the headless-shell Chrome already
# in the base image (chromedp/CDP use) to avoid a version mismatch with
# Playwright's own pins.
RUN npm install -g playwright && \
    playwright install --with-deps chromium

# --- pi-harness ---
COPY pkg/pi-harness/dist/ /home/exedev/pi-harness/dist/
COPY pkg/pi-harness/package.json /home/exedev/pi-harness/
WORKDIR /home/exedev/pi-harness
RUN npm install --omit=dev --ignore-engines && \
    chown -R exedev:exedev /home/exedev/pi-harness

COPY pkg/pi-harness/pi-harness.service /etc/systemd/system/pi-harness.service
RUN chmod 644 /etc/systemd/system/pi-harness.service && \
    systemctl enable pi-harness.service
