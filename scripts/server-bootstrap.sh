#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYDESK_ROOT:-$HOME/.deploydesk}"
CADDY_DIR="$ROOT_DIR/caddy"

command -v docker >/dev/null 2>&1 || {
  echo "未找到 Docker，请先在服务器安装 Docker Engine。" >&2
  exit 1
}
docker info >/dev/null
docker compose version >/dev/null

PORT_OWNERS="$(
  docker ps --format '{{.Names}} {{.Ports}}' |
    awk '$1 != "deploydesk-caddy" && ($0 ~ /0\.0\.0\.0:80->/ || $0 ~ /0\.0\.0\.0:443->/ || $0 ~ /\[::\]:80->/ || $0 ~ /\[::\]:443->/)'
)"
if [[ -n "$PORT_OWNERS" ]]; then
  echo "检测到其他容器正在占用 80/443，未修改现有反向代理：" >&2
  printf '%s\n' "$PORT_OWNERS" >&2
  exit 2
fi

install -d -m 700 "$CADDY_DIR/sites" "$CADDY_DIR/data" "$CADDY_DIR/config"

if [[ ! -f "$CADDY_DIR/Caddyfile" ]]; then
  cat >"$CADDY_DIR/Caddyfile" <<'CADDYFILE'
http://localhost {
	respond /_deploydesk/health 200
}

import /etc/caddy/sites/*.caddy
CADDYFILE
fi

if [[ ! -f "$CADDY_DIR/sites/_placeholder.caddy" ]]; then
  printf '# DeployDesk 会把项目路由写入此目录。\n' >"$CADDY_DIR/sites/_placeholder.caddy"
fi

cat >"$CADDY_DIR/docker-compose.yml" <<'COMPOSE'
name: deploydesk-edge

services:
  caddy:
    image: caddy:2.10-alpine
    container_name: deploydesk-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./sites:/etc/caddy/sites:ro
      - ./data:/data
      - ./config:/config
    networks:
      - edge
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1/_deploydesk/health"]
      interval: 10s
      timeout: 5s
      retries: 12

networks:
  edge:
    name: deploydesk-edge
COMPOSE

cd "$CADDY_DIR"
docker compose config --quiet
docker compose up -d --wait --wait-timeout 120
docker exec deploydesk-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "DeployDesk Caddy 已就绪：$CADDY_DIR"
