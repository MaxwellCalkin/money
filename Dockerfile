# Node 24 is an active LTS line. Build and runtime inputs are independently
# pinned: the full image compiles the product, while the shell-less distroless
# image is the only base that reaches production.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run typecheck && npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="money" \
      org.opencontainers.image.description="Agent payment network services" \
      org.opencontainers.image.source="https://github.com/MaxwellCalkin/money" \
      org.opencontainers.image.revision="$SOURCE_COMMIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 package.json package-lock.json ./
COPY --chown=65532:65532 db ./db
COPY --chown=65532:65532 docs ./docs
COPY --chown=65532:65532 README.md ./
COPY --chown=65532:65532 SECURITY.md ./
USER 65532
STOPSIGNAL SIGTERM
ENTRYPOINT ["/nodejs/bin/node", "--enable-source-maps"]
CMD ["dist/server/postgres-api.js"]
