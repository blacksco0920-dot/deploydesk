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

SUDO=()
if [[ "$(id -u)" != "0" ]] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO=(sudo -n)
fi

require_admin() {
  if [[ "$(id -u)" != "0" && ${#SUDO[@]} -eq 0 ]]; then
    fail_setup \
      "AD-SRV-104" \
      "服务器初始化需要管理员权限" \
      "请为当前登录用户开启免密 sudo 后重试；ABCDeploy 不会保存管理员密码"
  fi
}

install_docker() {
  require_admin
  if [[ ! -r /etc/os-release ]]; then
    fail_setup \
      "AD-SRV-105" \
      "无法识别这台服务器的操作系统" \
      "首版自动初始化支持 Ubuntu 和 Debian；请确认服务器系统后重试"
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  local distribution="${ID:-}"
  local codename="${VERSION_CODENAME:-}"
  if [[ "$distribution" != "ubuntu" && "$distribution" != "debian" ]]; then
    fail_setup \
      "AD-SRV-105" \
      "当前服务器系统暂不支持自动安装 Docker" \
      "首版自动初始化支持 Ubuntu 和 Debian；请更换系统或预先安装 Docker"
  fi
  if [[ -z "$codename" ]]; then
    fail_setup \
      "AD-SRV-105" \
      "无法读取服务器系统版本" \
      "请确认 /etc/os-release 包含 VERSION_CODENAME 后重试"
  fi

  printf 'ABCDEPLOY_DOCKER_SETUP=installing\n'
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -y || fail_setup \
    "AD-SRV-106" \
    "服务器软件源暂时不可用" \
    "检查服务器网络后重试，系统会从安装 Docker 这一步继续"
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl || fail_setup \
    "AD-SRV-106" \
    "服务器无法安装 Docker 所需的基础组件" \
    "检查服务器软件源后重试，已完成的连接配置会保留"

  local keyring="/etc/apt/keyrings/docker.asc"
  local repository="/etc/apt/sources.list.d/docker.list"
  local temporary_key
  temporary_key="$(mktemp)"
  curl --connect-timeout 15 --max-time 60 --retry 2 -fsSL \
    "https://download.docker.com/linux/$distribution/gpg" \
    -o "$temporary_key" || fail_setup \
      "AD-SRV-106" \
      "服务器暂时无法连接 Docker 软件源" \
      "检查服务器外网访问后重试，系统会自动继续初始化"
  "${SUDO[@]}" install -d -m 0755 /etc/apt/keyrings
  "${SUDO[@]}" install -m 0644 "$temporary_key" "$keyring"
  rm -f "$temporary_key"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$keyring" "$distribution" "$codename" |
    "${SUDO[@]}" tee "$repository" >/dev/null
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -y || fail_setup \
    "AD-SRV-106" \
    "Docker 软件源暂时不可用" \
    "检查服务器网络后重试，系统会从安装 Docker 这一步继续"
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || fail_setup \
      "AD-SRV-106" \
      "Docker 安装没有完成" \
      "检查服务器软件源后重试，系统会自动继续初始化"

  if command -v systemctl >/dev/null 2>&1; then
    "${SUDO[@]}" systemctl enable --now docker || fail_setup \
      "AD-SRV-102" \
      "Docker 已安装但没有成功启动" \
      "检查服务器 Docker 服务状态后重试"
  else
    "${SUDO[@]}" service docker start || fail_setup \
      "AD-SRV-102" \
      "Docker 已安装但没有成功启动" \
      "检查服务器 Docker 服务状态后重试"
  fi

  if [[ "$(id -u)" != "0" ]]; then
    "${SUDO[@]}" usermod -aG docker "$(id -un)" || true
  fi
  printf 'ABCDEPLOY_DOCKER_SETUP=installed\n'
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker
else
  printf 'ABCDEPLOY_DOCKER_SETUP=reused\n'
fi

DOCKER=(docker)
if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
  if [[ ${#SUDO[@]} -gt 0 ]] && "${SUDO[@]}" docker info >/dev/null 2>&1; then
    # The docker group added above only applies to the next login. Use sudo for
    # this first initialization so the user's one click can still finish.
    DOCKER=("${SUDO[@]}" docker)
  else
    fail_setup \
      "AD-SRV-102" \
      "Docker 已安装但当前无法使用" \
      "检查服务器 Docker 服务状态后重试"
  fi
fi

"${DOCKER[@]}" compose version >/dev/null 2>&1 || fail_setup \
  "AD-SRV-103" \
  "服务器缺少 Docker Compose 插件" \
  "请允许 ABCDeploy 完成 Docker 初始化后重试"

install -d -m 700 "$CADDY_DIR" "$CADDY_DIR/sites" "$CADDY_DIR/data" "$CADDY_DIR/config"

PORT_OWNERS="$({
  "${DOCKER[@]}" ps --format '{{.Names}} {{.Ports}}' |
    awk '$0 ~ /0\.0\.0\.0:80->/ || $0 ~ /0\.0\.0\.0:443->/ || $0 ~ /\[::\]:80->/ || $0 ~ /\[::\]:443->/ { print $1 }'
} | sort -u)"

CADDY_MODE="managed"
CADDY_CONTAINER="deploydesk-caddy"
CADDY_SITE_DIR="$CADDY_DIR/sites"

host_web_ports_in_use() {
  command -v ss >/dev/null 2>&1 &&
    ss -H -ltn '( sport = :80 or sport = :443 )' 2>/dev/null | grep -q .
}

default_host_caddy_config() {
  [[ -r /etc/caddy/Caddyfile ]] || return 1
  local normalized expected
  normalized="$(sed \
    -e 's/#.*$//' \
    -e '/^[[:space:]]*$/d' \
    -e 's/^[[:space:]]*//' \
    -e 's/[[:space:]]*$//' \
    /etc/caddy/Caddyfile)"
  expected=$':80 {\nroot * /usr/share/caddy\nfile_server\n}'
  [[ "$normalized" == "$expected" ]]
}

# Some cloud images enable the distribution's untouched Caddy welcome page.
# It owns port 80 but contains no user route. Disable only that exact default;
# any customized host service remains untouched and produces a clear conflict.
if [[ -z "$PORT_OWNERS" ]] && host_web_ports_in_use; then
  if command -v systemctl >/dev/null 2>&1 &&
    systemctl is-active --quiet caddy &&
    command -v caddy >/dev/null 2>&1 &&
    default_host_caddy_config; then
    require_admin
    "${SUDO[@]}" systemctl disable --now caddy || fail_setup \
      "AD-SRV-201" \
      "服务器自带的默认 Caddy 没有成功让出访问端口" \
      "检查服务器 Caddy 服务状态后重试；ABCDeploy 没有改写它的配置"
    printf 'ABCDEPLOY_HOST_CADDY=disabled-default\n'
  else
    fail_setup \
      "AD-SRV-201" \
      "服务器的 80/443 端口已由现有网站服务使用" \
      "ABCDeploy 不会停止或覆盖已有网站服务；请换一台空服务器或先处理端口占用" \
      2
  fi
fi

if [[ -z "$PORT_OWNERS" ]] && host_web_ports_in_use; then
  fail_setup \
    "AD-SRV-201" \
    "服务器的 80/443 端口仍被其他服务占用" \
    "检查服务器端口占用后重试；ABCDeploy 没有停止未知服务" \
    2
fi

if [[ -n "$PORT_OWNERS" ]]; then
  if [[ "$(printf '%s\n' "$PORT_OWNERS" | wc -l | tr -d ' ')" != "1" ]]; then
    fail_setup \
      "AD-SRV-201" \
      "服务器的 80/443 端口由多个容器占用" \
      "保留一个统一反向代理后再重试；ABCDeploy 不会自动停止现有容器" \
      2
  fi

  CADDY_CONTAINER="$PORT_OWNERS"
  if ! "${DOCKER[@]}" exec "$CADDY_CONTAINER" caddy version >/dev/null 2>&1; then
    fail_setup \
      "AD-SRV-201" \
      "80/443 已被非 Caddy 服务占用：$CADDY_CONTAINER" \
      "确认现有反向代理用途，释放端口或改为兼容的统一 Caddy 后重试" \
      2
  fi

  CADDY_SITE_DIR="$("${DOCKER[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/sites"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER")"
  if [[ -z "$CADDY_SITE_DIR" || ! -d "$CADDY_SITE_DIR" || ! -w "$CADDY_SITE_DIR" ]]; then
    fail_setup \
      "AD-SRV-202" \
      "检测到已有 Caddy，但它没有开放可写的独立路由目录" \
      "为 Caddy 挂载 /etc/caddy/sites 并导入 sites/*.caddy，随后重新检查" \
      2
  fi
  if ! "${DOCKER[@]}" exec "$CADDY_CONTAINER" sh -c \
    "grep -Fq 'import sites/*.caddy' /etc/caddy/Caddyfile || grep -Fq 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile"; then
    fail_setup \
      "AD-SRV-202" \
      "已有 Caddy 尚未导入 ABCDeploy 独立路由目录" \
      "在主 Caddyfile 中加入 import sites/*.caddy，验证并重载后再试" \
      2
  fi
  if ! "${DOCKER[@]}" exec "$CADDY_CONTAINER" caddy validate \
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
http://127.0.0.1 {
	respond /_deploydesk/health 200
}

import /etc/caddy/sites/*.caddy
CADDYFILE
  fi
  # Migrate the health address generated by earlier ABCDeploy builds. Caddy
  # matches hostnames, so localhost and 127.0.0.1 are not interchangeable.
  if grep -Fqx 'http://localhost {' "$CADDY_DIR/Caddyfile"; then
    sed -i.bak 's|^http://localhost {$|http://127.0.0.1 {|' "$CADDY_DIR/Caddyfile"
    rm -f "$CADDY_DIR/Caddyfile.bak"
  fi

  if [[ ! -f "$CADDY_DIR/sites/_placeholder.caddy" ]]; then
    printf '# ABCDeploy 会把项目路由写入此目录。\n' >"$CADDY_DIR/sites/_placeholder.caddy"
  fi

  CADDY_DIGEST="sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
  CADDY_IMAGE=""
  PULL_LOG="$CADDY_DIR/image-pull.log"
  for candidate in \
    "mirror.ccs.tencentyun.com/library/caddy@$CADDY_DIGEST" \
    "m.daocloud.io/docker.io/library/caddy@$CADDY_DIGEST" \
    "caddy@$CADDY_DIGEST"; do
    if "${DOCKER[@]}" image inspect "$candidate" >/dev/null 2>&1; then
      CADDY_IMAGE="$candidate"
      break
    fi
    if command -v timeout >/dev/null 2>&1; then
      if timeout 150 "${DOCKER[@]}" pull "$candidate" >"$PULL_LOG" 2>&1; then
        CADDY_IMAGE="$candidate"
        break
      fi
    elif "${DOCKER[@]}" pull "$candidate" >"$PULL_LOG" 2>&1; then
      CADDY_IMAGE="$candidate"
      break
    fi
  done
  if [[ -z "$CADDY_IMAGE" ]]; then
    tail -20 "$PULL_LOG" >&2 2>/dev/null || true
    fail_setup \
      "AD-SRV-212" \
      "服务器暂时无法下载统一访问组件" \
      "检查服务器外网连接后重试；系统会自动切换国内镜像来源"
  fi
  rm -f "$PULL_LOG"
  printf 'CADDY_IMAGE=%s\n' "$CADDY_IMAGE" >"$CADDY_DIR/.env"
  chmod 600 "$CADDY_DIR/.env"

  cat >"$CADDY_DIR/docker-compose.yml" <<'COMPOSE'
name: deploydesk-edge

services:
  caddy:
    image: ${CADDY_IMAGE}
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
      retries: 15

networks:
  edge:
    name: deploydesk-edge
COMPOSE

  cd "$CADDY_DIR"
  "${DOCKER[@]}" compose config --quiet || fail_setup \
    "AD-SRV-203" \
    "ABCDeploy Caddy 的 Compose 配置无效" \
    "展开技术详情排查 Compose 配置后重试"
  COMPOSE_LOG="$CADDY_DIR/compose-start.log"
  if ! "${DOCKER[@]}" compose up -d --wait --wait-timeout 180 >"$COMPOSE_LOG" 2>&1; then
    tail -60 "$COMPOSE_LOG" >&2 2>/dev/null || true
    if grep -Fq 'address already in use' "$COMPOSE_LOG"; then
      fail_setup \
        "AD-SRV-201" \
        "服务器的 80/443 端口被其他服务占用" \
        "ABCDeploy 没有停止未知服务；处理端口占用后重试"
    fi
    fail_setup \
      "AD-SRV-203" \
      "统一访问服务没有成功启动" \
      "再次点击后系统会继续检查；仍失败时展开技术详情查看容器原因"
  fi
  rm -f "$COMPOSE_LOG"
  "${DOCKER[@]}" exec deploydesk-caddy caddy validate \
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
