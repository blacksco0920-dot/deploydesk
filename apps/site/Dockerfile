FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/package.json
RUN pnpm install --frozen-lockfile --filter @abcdeploy/site...
COPY apps/site apps/site
RUN pnpm --filter @abcdeploy/site build

FROM caddy:2-alpine
COPY apps/site/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/site/dist /srv
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q --spider http://127.0.0.1/ || exit 1
