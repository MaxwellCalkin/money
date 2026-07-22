# Node 24 is an active LTS line. The multi-platform digest pins the exact
# official image used for both compilation and runtime.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run typecheck && npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="money" \
      org.opencontainers.image.description="Agent payment network services" \
      org.opencontainers.image.source="https://github.com/MaxwellCalkin/money" \
      org.opencontainers.image.revision="$SOURCE_COMMIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node docs ./docs
COPY --chown=node:node README.md ./
COPY --chown=node:node SECURITY.md ./
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--enable-source-maps"]
CMD ["dist/server/postgres-api.js"]
