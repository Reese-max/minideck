FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DENO_NO_UPDATE_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install the published Dashi skill at a pinned version. The package installer
# creates the skill tree; the project lockfile supplies its runtime dependencies.
RUN npm install --global dashi-ppt-skill@0.4.11 \
    && dashi-ppt-skill --dir /opt/skills \
    && cd /opt/skills/dashi-ppt/project \
    && npm ci --include=dev --ignore-scripts

WORKDIR /app
COPY runner/ /app/runner/
COPY container_src/ /app/container_src/

# Keep Chromium and the Dashi process outside the root user. Debian's
# Chromium sandbox is usable in this mode and no --no-sandbox escape hatch is
# needed in the render path.
RUN useradd --create-home --shell /usr/sbin/nologin dashi \
    && chown -R dashi:dashi /app
USER dashi

EXPOSE 8080
CMD ["node", "/app/container_src/server.mjs"]
