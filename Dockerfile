# InfiniBot gateway image (self-hosted). No Kingly Vault account is needed.
#
#   docker build -t infinibot:local .
#   docker run -p 18789:18789 -e INFINIBOT_GATEWAY_PASSWORD=change-me \
#     -v infinibot-state:/home/node/.infinibot infinibot:local
#
# Then open http://localhost:18789 and log in with the password. The first
# browser is asked to pair (container traffic isn't loopback); approve it with
#   docker exec <container> node dist/index.js devices list / devices approve <id>
# Model provider keys (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...) can be passed
# as env vars or added later in the dashboard / `infinibot onboard`.
# Override the base (e.g. a local mirror/tag) with --build-arg NODE_IMAGE=...
ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE}

RUN corepack enable

WORKDIR /app

ARG INFINIBOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$INFINIBOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $INFINIBOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# The whole workspace (ui/, packages/*, extensions/*, apps/*) is needed for a
# frozen-lockfile install, so copy the tree first. .dockerignore keeps
# node_modules, dist and media out of the context.
COPY . .

# BuildKit cache for the pnpm store makes rebuilds skip re-downloading. The
# hoisted node_modules (pnpm-workspace.yaml) are real copies, so the image
# never points into the cache.
RUN --mount=type=cache,id=infinibot-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN INFINIBOT_A2UI_SKIP_MISSING=1 pnpm build:all

ENV NODE_ENV=production
# No browser in a container: don't try to auto-open the Control UI.
ENV INFINIBOT_NO_OPEN=1
# Some subsystems still write repo-relative runtime data under ./state; let the
# unprivileged user own that and the app root (node_modules stays read-only).
RUN mkdir -p /home/node/.infinibot /app/state && \
    chown node:node /app /home/node/.infinibot && chown -R node:node /app/state

# Security hardening: run as the image's non-root 'node' user (uid 1000).
USER node
ENV HOME=/home/node

EXPOSE 18789

# Binds all interfaces inside the container, so a gateway password is required
# (INFINIBOT_GATEWAY_PASSWORD); the gateway refuses to start without one.
# --allow-unconfigured lets a fresh volume boot without running onboarding.
CMD ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789", "--auth", "password", "--allow-unconfigured"]
