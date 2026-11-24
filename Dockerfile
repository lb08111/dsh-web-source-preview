ARG NODE_VERSION=24.22.3
FROM node:${NODE_VERSION}-bookworm-slim AS target-host

ARG DSH_VERSION=0.2.2-rc.3
ARG PNPM_VERSION=11.24.0
ENV DSH_HOST_SDK_DIR=/opt/dsh/runtime/node_modules/@deepseek-ai
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /opt/dsh/runtime
RUN npm init --yes \
    && npm install --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
ARG DSH_VERSION=0.2.2-rc.3
ARG PNPM_VERSION=11.24.0
ENV DSH_HOST_SDK_DIR=/opt/dsh/runtime/node_modules/@deepseek-ai
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /opt/dsh/runtime
RUN npm init --yes \
    && npm install --ignore-scripts --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"
WORKDIR /opt/dsh/source
COPY . .
ARG BUILDARCH
RUN --mount=type=cache,id=dsh-web-pnpm-${BUILDARCH},target=/root/.local/share/pnpm/store,sharing=locked \
    node -e 'console.log(JSON.stringify({ node: process.version, uv: process.versions.uv, arch: process.arch, channelFdPresent: Object.hasOwn(process.env, "NODE_CHANNEL_FD"), channelSerializationPresent: Object.hasOwn(process.env, "NODE_CHANNEL_SERIALIZATION_MODE") }))' \
    && command -v pnpm \
    && readlink -f "$(command -v pnpm)" \
    && pnpm --version \
    && node -e 'const fs = require("node:fs"); for (const entry of fs.readdirSync("packages", { withFileTypes: true })) if (entry.isDirectory()) fs.rmSync(`packages/${entry.name}/lib`, { recursive: true, force: true })' \
    && { install_status=0; \
         pnpm run deps:install >/tmp/dsh-deps-install.log 2>&1 || install_status=$?; \
         cat /tmp/dsh-deps-install.log; \
         rm /tmp/dsh-deps-install.log; \
         if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi; } \
    && pnpm build \
    && node deploy/docker/collect-artifacts.mjs /opt/dsh/source /opt/dsh/artifacts

FROM target-host AS target-package
WORKDIR /opt/dsh/source
COPY . .
ARG TARGETARCH
RUN --mount=type=cache,id=dsh-web-pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store,sharing=locked \
    node -e 'const fs = require("node:fs"); for (const entry of fs.readdirSync("packages", { withFileTypes: true })) if (entry.isDirectory()) fs.rmSync(`packages/${entry.name}/lib`, { recursive: true, force: true })' \
    && { install_status=0; \
    pnpm run deps:install --prod >/tmp/dsh-deps-install.log 2>&1 || install_status=$?; \
    cat /tmp/dsh-deps-install.log; \
    rm /tmp/dsh-deps-install.log; \
    exit "$install_status"; }
COPY --from=build /opt/dsh/artifacts/packages/ ./packages/
RUN --mount=type=cache,id=dsh-web-pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store,sharing=locked \
    node scripts/host-sdk-link.mjs --check \
    && pnpm --ignore-scripts --filter @linxin666/dsh-web-all deploy --prod --legacy /opt/dsh/plugins \
    && node deploy/docker/prepare-runtime.mjs /opt/dsh/plugins /opt/dsh/runtime

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client bash \
    && rm -rf /var/lib/apt/lists/*
COPY --from=target-host /opt/dsh/runtime /opt/dsh/runtime
COPY --from=target-package /opt/dsh/plugins /opt/dsh/plugins
COPY deploy/docker/bootstrap.mjs deploy/docker/access-policy.mjs deploy/docker/auth-cookie.mjs deploy/docker/serve.mjs deploy/docker/healthcheck.mjs /opt/dsh/container/
ENV NODE_ENV=production \
    HOME=/data/home \
    DSH_HOME=/data \
    DSH_HOST_SDK_DIR=/opt/dsh/runtime/node_modules/@deepseek-ai \
    DSH_TELEMETRY_MODE=DISABLED \
    DSH_TELEMETRY_DISABLED=1 \
    PUBLIC_URL=http://127.0.0.1:3080
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=15s --start-period=120s --retries=6 \
    CMD node /opt/dsh/container/healthcheck.mjs
ENTRYPOINT ["node", "/opt/dsh/container/serve.mjs"]
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="DSH Web AI test management" \
      org.opencontainers.image.source="https://github.com/zhu1090093659/dsh-web" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
