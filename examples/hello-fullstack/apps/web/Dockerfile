FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @deploydesk-example/web build

FROM busybox:1.36 AS runtime

COPY --from=build /app/apps/web/dist /www
EXPOSE 80
CMD ["httpd", "-f", "-p", "80", "-h", "/www"]
