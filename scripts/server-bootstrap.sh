#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYDESK_ROOT:-$HOME/.deploydesk}"
CADDY_DIR="$ROOT_DIR/caddy"

fail_setup() {
  local code="$1"
  local message="$2"
  local next_step="$3"
  local exit_code="${4:-1}"
  printf 'ABCDEPLOY_ERROR_CODE=%s\n' "$code" >&2
  printf 'ABCDEPLOY_ERROR_MESSAGE=%s\n' "$message" >&2
  printf 'ABCDEPLOY_ERROR_NEXT_STEP=%s\n' "$next_step" >&2
  exit "$exit_code"
}

command -v docker >/dev/null 2>&1 || fail_setup \
  "AD-SRV-101" \
  "服务器尚未安装 Docker Engine" \
  "安装 Docker Engine 与 Compose 插件后，点击重新检查并继续"

docker info >/dev/null 2>&1 || fail_setup \
  "AD-SRV-102" \
  "当前登录用户无法使用 Docker" \
  "启动 Docker，并确认当前用户拥有 Docker 权限后重试"

docker compose version >/dev/null 2>&1 || fail_setup \
  "AD-SRV-103" \
  "服务器缺少 Docker Compose 插件" \
  "安装 docker-compose-plugin 后，点击重新检查并继续"

install -d -m 700 "$CADDY_DIR" "$CADDY_DIR/sites" "$CADDY_DIR/data" "$CADDY_DIR/config"

PORT_OWNERS="$({
  docker ps --format '{{.Names}} {{.Ports}}' |
    awk '$0 ~ /0\.0\.0\.0:80->/ || $0 ~ /0\.0\.0\.0:443->/ || $0 ~ /\[::\]:80->/ || $0 ~ /\[::\]:443->/ { print $1 }'
} | sort -u)"

CADDY_MODE="managed"
CADDY_CONTAINER="deploydesk-caddy"
CADDY_SITE_DIR="$CADDY_DIR/sites"

if [[ -n "$PORT_OWNERS" ]]; then
  if [[ "$(printf '%s\n' "$PORT_OWNERS" | wc -l | tr -d ' ')" != "1" ]]; then
    fail_setup \
      "AD-SRV-201" \
      "服务器的 80/443 端口由多个容器占用" \
      "保留一个统一反向代理后再重试；ABCDeploy 不会自动停止现有容器" \
      2
  fi

  CADDY_CONTAINER="$PORT_OWNERS"
  if ! docker exec "$CADDY_CONTAINER" caddy version >/dev/null 2>&1; then
    fail_setup \
      "AD-SRV-201" \
      "80/443 已被非 Caddy 服务占用：$CADDY_CONTAINER" \
      "确认现有反向代理用途，释放端口或改为兼容的统一 Caddy 后重试" \
      2
  fi

  CADDY_SITE_DIR="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/sites"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER")"
  if [[ -z "$CADDY_SITE_DIR" || ! -d "$CADDY_SITE_DIR" || ! -w "$CADDY_SITE_DIR" ]]; then
    fail_setup \
      "AD-SRV-202" \
      "检测到已有 Caddy，但它没有开放可写的独立路由目录" \
      "为 Caddy 挂载 /etc/caddy/sites 并导入 sites/*.caddy，随后重新检查" \
      2
  fi
  if ! docker exec "$CADDY_CONTAINER" sh -c \
    "grep -Fq 'import sites/*.caddy' /etc/caddy/Caddyfile || grep -Fq 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile"; then
    fail_setup \
      "AD-SRV-202" \
      "已有 Caddy 尚未导入 ABCDeploy 独立路由目录" \
      "在主 Caddyfile 中加入 import sites/*.caddy，验证并重载后再试" \
      2
  fi
  if ! docker exec "$CADDY_CONTAINER" caddy validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile; then
    fail_setup \
      "AD-SRV-204" \
      "现有 Caddy 配置校验未通过" \
      "先修复现有 Caddyfile，再点击重新检查并继续"
  fi
  CADDY_MODE="reused"
else
  if [[ ! -f "$CADDY_DIR/Caddyfile" ]]; then
    cat >"$CADDY_DIR/Caddyfile" <<'CADDYFILE'
http://localhost {
	respond /_deploydesk/health 200
}

import /etc/caddy/sites/*.caddy
CADDYFILE
  fi

  if [[ ! -f "$CADDY_DIR/sites/_placeholder.caddy" ]]; then
    printf '# ABCDeploy 会把项目路由写入此目录。\n' >"$CADDY_DIR/sites/_placeholder.caddy"
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
  docker compose config --quiet || fail_setup \
    "AD-SRV-203" \
    "ABCDeploy Caddy 的 Compose 配置无效" \
    "展开技术详情排查 Compose 配置后重试"
  docker compose up -d --wait --wait-timeout 120 || fail_setup \
    "AD-SRV-203" \
    "ABCDeploy Caddy 启动失败" \
    "检查服务器网络与 Docker 日志后重试"
  docker exec deploydesk-caddy caddy validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile || fail_setup \
    "AD-SRV-204" \
    "ABCDeploy Caddy 配置校验未通过" \
    "展开技术详情修复 Caddy 配置后重试"
fi

printf '%s\n' "$CADDY_CONTAINER" >"$CADDY_DIR/container-name"
printf '%s\n' "$CADDY_SITE_DIR" >"$CADDY_DIR/site-directory"
chmod 600 "$CADDY_DIR/container-name" "$CADDY_DIR/site-directory"

printf 'ABCDEPLOY_CADDY_MODE=%s\n' "$CADDY_MODE"
printf 'ABCDEPLOY_CADDY_CONTAINER=%s\n' "$CADDY_CONTAINER"
printf 'ABCDeploy Caddy 已就绪：%s\n' "$CADDY_CONTAINER"
