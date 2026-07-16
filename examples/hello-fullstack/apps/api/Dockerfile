FROM node:22-bookworm-slim AS build

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com

WORKDIR /app
RUN corepack enable \
    && for attempt in 1 2 3; do \
         corepack prepare pnpm@10.28.1 --activate && break; \
         test "$attempt" = 3 && exit 1; \
         sleep $((attempt * 2)); \
       done \
    && pnpm --version
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    for attempt in 1 2 3; do \
      pnpm install --frozen-lockfile && break; \
      test "$attempt" = 3 && exit 1; \
      sleep $((attempt * 2)); \
    done
COPY . .
RUN pnpm --filter @abcdeploy-example/api build \
    && pnpm --filter @abcdeploy-example/api deploy --legacy --prod /opt/api

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /opt/api ./
COPY --from=build /app/apps/api/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
