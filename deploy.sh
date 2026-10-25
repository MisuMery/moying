#!/usr/bin/env bash
# 摹影一键部署：装 Docker → 生成密钥 → 拉起协议端与引擎 → 回填 OneBot token → 打印入口。
#
#   bash deploy.sh                       # 交互式（只问控制台令牌 / noVNC 密码，其余默认）
#   bash deploy.sh -y                    # 全默认，自动生成随机密钥
#   bash deploy.sh --console-token abc --vnc-password 12345678
#
# 需要你自定义的只有两样：控制台令牌、noVNC 密码。
# 模型 API 不在这里问——部署完进控制台「API 配置」页填（三套可分别配）。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DATA_DIR="$ROOT_DIR/data"

CONSOLE_PORT=3210
CONSOLE_BIND=0.0.0.0
NOVNC_PORT=6081
NOVNC_BIND=0.0.0.0
SNOWLUMA_WEBUI_HOST_PORT=5099
SNOWLUMA_WEBUI_BIND=127.0.0.1
SNOWLUMA_IMAGE="${SNOWLUMA_IMAGE:-docker.m.daocloud.io/motricseven7/snowluma:v1.14.22}"
SNOWLUMA_SCREEN=1920x1080x24
SNOWLUMA_LOG_LEVEL=info

CONSOLE_TOKEN=""
VNC_PASSWORD=""
SNOWLUMA_WEBUI_PASSWORD=""
INSTALL_DOCKER=true
ASSUME_YES=false

C_GREEN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'

step() { printf '%s==>%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s%s%s\n' "$C_YEL" "$*" "$C_OFF"; }
die()  { printf '%s错误：%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash deploy.sh [选项]

选项:
  --console-token TOKEN    控制台登录令牌（不给则随机生成）
  --vnc-password PASS      noVNC 密码（扫二维码登录 QQ 时用；不给则随机生成）
  --snowluma-webui-password PASS
                           协议端 WebUI 初始密码（可选）
  --console-port PORT      控制台端口（默认 3210）
  --novnc-port PORT        noVNC 端口（默认 6081）
  --webui-port PORT        协议端 WebUI 端口（默认 5099，只绑 127.0.0.1）
  --console-bind IP        控制台监听地址（默认 0.0.0.0；只本机访问填 127.0.0.1）
  --novnc-bind IP          noVNC 监听地址（默认 0.0.0.0）
  --snowluma-image IMAGE   SnowLuma 镜像（默认走 DaoCloud 镜像站）
  --no-install-docker      缺少 Docker 时直接失败，不自动安装
  -y, --yes                非交互式，全用默认值
  -h, --help               显示本帮助

模型 API 请在部署完成后到控制台「API 配置」页填写（chat / story / vision 三套可分开设）。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --console-token) CONSOLE_TOKEN="${2:-}"; shift 2 ;;
    --vnc-password) VNC_PASSWORD="${2:-}"; shift 2 ;;
    --snowluma-webui-password) SNOWLUMA_WEBUI_PASSWORD="${2:-}"; shift 2 ;;
    --console-port) CONSOLE_PORT="${2:-}"; shift 2 ;;
    --novnc-port) NOVNC_PORT="${2:-}"; shift 2 ;;
    --webui-port) SNOWLUMA_WEBUI_HOST_PORT="${2:-}"; shift 2 ;;
    --console-bind) CONSOLE_BIND="${2:-}"; shift 2 ;;
    --novnc-bind) NOVNC_BIND="${2:-}"; shift 2 ;;
    --snowluma-image) SNOWLUMA_IMAGE="${2:-}"; shift 2 ;;
    --no-install-docker) INSTALL_DOCKER=false; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（用 -h 看用法）" ;;
  esac
done

# 读回上次的 .env，避免重跑时把手工改动冲掉
read_env() {
  local key="$1" default="$2" val=""
  if [[ -f "$ENV_FILE" ]]; then
    val="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1)"
  fi
  printf '%s' "${val:-$default}"
}
if [[ -f "$ENV_FILE" ]]; then
  [[ -z "$CONSOLE_TOKEN" ]] && CONSOLE_TOKEN="$(read_env MOYING_CONSOLE_TOKEN '')"
  [[ -z "$VNC_PASSWORD" ]] && VNC_PASSWORD="$(read_env VNC_PASSWD '')"
  [[ -z "$SNOWLUMA_WEBUI_PASSWORD" ]] && SNOWLUMA_WEBUI_PASSWORD="$(read_env SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD '')"
  CONSOLE_PORT="$(read_env CONSOLE_PORT "$CONSOLE_PORT")"
  NOVNC_PORT="$(read_env NOVNC_PORT "$NOVNC_PORT")"
  SNOWLUMA_WEBUI_HOST_PORT="$(read_env SNOWLUMA_WEBUI_HOST_PORT "$SNOWLUMA_WEBUI_HOST_PORT")"
  CONSOLE_BIND="$(read_env CONSOLE_BIND "$CONSOLE_BIND")"
  NOVNC_BIND="$(read_env NOVNC_BIND "$NOVNC_BIND")"
  SNOWLUMA_IMAGE="$(read_env SNOWLUMA_IMAGE "$SNOWLUMA_IMAGE")"
fi

rand_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 24 | tr -d '\n=/+' | head -c 32
  else head -c 32 /dev/urandom | base64 | tr -d '\n=/+' | head -c 32; fi
}

ask() { # ask 变量名 提示 默认值 是否机密
  local var="$1" prompt="$2" def="$3" secret="${4:-false}" val=""
  if [[ "$ASSUME_YES" == true ]]; then printf -v "$var" '%s' "$def"; return; fi
  if [[ "$secret" == true ]]; then
    read -r -s -p "    $prompt${def:+（回车用随机值）}: " val || true; printf '\n'
  else
    read -r -p "    $prompt${def:+ [默认: $def]}: " val || true
  fi
  printf -v "$var" '%s' "${val:-$def}"
}

# ---------- 1. Docker ----------
run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else die "需要 root 权限（或安装 sudo）"; fi
}

docker_ready() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

install_docker() {
  [[ "$INSTALL_DOCKER" == true ]] || die "缺少 Docker，且已指定 --no-install-docker"
  step '安装 Docker Engine 与 Compose'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update -qq
    run_root apt-get install -y docker.io || die 'Docker Engine 安装失败'
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y docker || run_root dnf install -y moby-engine || die 'Docker 安装失败'
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y docker || run_root yum install -y moby-engine || die 'Docker 安装失败'
  elif command -v zypper >/dev/null 2>&1; then
    run_root zypper --non-interactive install -y docker || die 'Docker 安装失败'
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -Sy --noconfirm docker || die 'Docker 安装失败'
  else
    die '没找到受支持的包管理器，请手动安装 Docker 与 Compose'
  fi
  run_root systemctl enable --now docker >/dev/null 2>&1 || true

  step '安装 Docker Compose v2'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get install -y docker-compose-v2 || run_root apt-get install -y docker-compose-plugin || true
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y docker-compose-plugin || run_root dnf install -y docker-compose || true
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y docker-compose-plugin || run_root yum install -y docker-compose || true
  fi
}

if docker_ready; then
  step 'Docker 已就绪'
else
  install_docker
  docker_ready || die 'Docker 仍不可用，请手动安装后重跑本脚本'
fi

# ---------- 2. 要自定义的两样 ----------
step '确认两项自定义凭据（模型 API 稍后在控制台填写）'
[[ -z "$CONSOLE_TOKEN" ]] && CONSOLE_TOKEN="$(rand_token)"
[[ -z "$VNC_PASSWORD" ]] && VNC_PASSWORD="$(rand_token | head -c 12)"
if [[ "$ASSUME_YES" != true ]]; then
  ask CONSOLE_TOKEN '控制台登录令牌' "$CONSOLE_TOKEN"
  ask VNC_PASSWORD 'noVNC 密码（登录 QQ 用）' "$VNC_PASSWORD" true
else
  info "控制台令牌：$CONSOLE_TOKEN"
  info "noVNC 密码：$VNC_PASSWORD"
fi
[[ -z "$CONSOLE_TOKEN" ]] && die '控制台令牌不能为空'
# 令牌会写进 JSON 与 sed 表达式：只收字母数字、-_ 和 .，别的字符会破坏写入
if [[ ! "$CONSOLE_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "控制台令牌只能用字母、数字、点、横线、下划线（当前值含特殊字符）"
fi
if [[ -n "$VNC_PASSWORD" && ! "$VNC_PASSWORD" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "noVNC 密码只能用字母、数字、点、横线、下划线"
fi

# ---------- 3. 写 .env ----------
step '写入 .env'
umask 077
cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 生成（权限 600，内含凭据，不要提交到版本库）
CONSOLE_PORT=$CONSOLE_PORT
CONSOLE_BIND=$CONSOLE_BIND
NOVNC_PORT=$NOVNC_PORT
NOVNC_BIND=$NOVNC_BIND
SNOWLUMA_WEBUI_HOST_PORT=$SNOWLUMA_WEBUI_HOST_PORT
SNOWLUMA_WEBUI_BIND=$SNOWLUMA_WEBUI_BIND
SNOWLUMA_IMAGE=$SNOWLUMA_IMAGE
SNOWLUMA_SCREEN=$SNOWLUMA_SCREEN
SNOWLUMA_LOG_LEVEL=$SNOWLUMA_LOG_LEVEL
SNOWLUMA_UID=$(id -u)
SNOWLUMA_GID=$(id -g)
VNC_PASSWD=$VNC_PASSWORD
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=$SNOWLUMA_WEBUI_PASSWORD
MOYING_CONSOLE_TOKEN=$CONSOLE_TOKEN
EOF
chmod 600 "$ENV_FILE"
info "已写入 $ENV_FILE"

# ---------- 4. 准备数据与配置 ----------
step '准备 data/ 配置'
mkdir -p "$DATA_DIR/stickers"
for f in character cast user world relationship; do
  if [[ ! -f "$DATA_DIR/$f.json" && -f "$ROOT_DIR/templates/$f.template.json" ]]; then
    cp "$ROOT_DIR/templates/$f.template.json" "$DATA_DIR/$f.json"
    info "已从模板生成 $f.json"
  fi
done
if [[ ! -f "$DATA_DIR/config.json" ]]; then
  cp "$ROOT_DIR/templates/config.example.json" "$DATA_DIR/config.json"
  info '已从模板生成 config.json'
fi
# 控制台端口与令牌写进 config.json（引擎从这里读）
write_console_cred() {
  python3 - "$DATA_DIR/config.json" "$CONSOLE_PORT" "$CONSOLE_TOKEN" <<'PY'
import json, sys
p, port, token = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(p, encoding='utf-8'))
d.setdefault('console', {})['port'] = port
d.setdefault('console', {})['token'] = token
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}
# python3 不在时退回 sed，但**必须**确认写进去了：
# 令牌为空而控制台又绑 0.0.0.0，等于把控制台敞开在公网。
write_console_cred 2>/dev/null || {
  sed -i "s|\"port\": 3210|\"port\": $CONSOLE_PORT|" "$DATA_DIR/config.json" 2>/dev/null || true
  sed -i "s|\"token\": \"\"|\"token\": \"$CONSOLE_TOKEN\"|" "$DATA_DIR/config.json" 2>/dev/null || true
}
if ! grep -q "$CONSOLE_TOKEN" "$DATA_DIR/config.json"; then
  die "控制台令牌没能写进 $DATA_DIR/config.json（需要 python3 或可用的 sed）。\
       手工把 \"console\": { \"port\": $CONSOLE_PORT, \"token\": \"$CONSOLE_TOKEN\" } 写进去再重跑。"
fi
info 'config.json: 控制台端口与令牌已写入'

# 容器里的引擎以非 root（node，uid/gid 1000）运行。绑定挂载 ./data 的归属在
# 宿主侧：root 跑出来的 data/ 默认 root 所有，容器内写不进去——备份、账本、
# 表情包导入会全部失败。所以这里显式把 data/ 让给 1000:1000（2026-10-25）。
run_root chown -R 1000:1000 "$DATA_DIR" 2>/dev/null \
  || info "未能 chown data/（非 root 且无 sudo）：请确认 $DATA_DIR 对 uid 1000 可写，否则引擎无法保存数据"

# ---------- 5. 拉起服务 ----------
step '构建并启动服务（首次会拉镜像，可能要几分钟）'
cd "$ROOT_DIR"
docker compose --env-file "$ENV_FILE" up -d --build

# ---------- 6. 回填 OneBot token ----------
step '等待协议端生成 OneBot token'
ONEBOT_CFG="$ROOT_DIR/snowluma-data/config/onebot.json"
for _ in $(seq 1 60); do
  [[ -f "$ONEBOT_CFG" ]] && grep -q '"accessToken"' "$ONEBOT_CFG" && break
  sleep 3
done
if [[ -f "$ONEBOT_CFG" ]]; then
  TOKEN="$(grep -o '"accessToken"[[:space:]]*:[[:space:]]*"[^"]*"' "$ONEBOT_CFG" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  if [[ -n "$TOKEN" ]]; then
    python3 - "$DATA_DIR/config.json" "$TOKEN" <<'PY' 2>/dev/null || true
import json, sys
p, token = sys.argv[1], sys.argv[2]
d = json.load(open(p, encoding='utf-8'))
d.setdefault('onebot', {})['accessToken'] = token
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('    OneBot token 已回填到 config.json')
PY
    docker restart moying >/dev/null 2>&1 || true
  fi
else
  warn '  暂时没读到协议端的 onebot.json（它可能还在初始化）。等它起来后重跑本脚本即可自动回填。'
fi

# ---------- 7. 健康检查 ----------
step '等待控制台就绪'
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${CONSOLE_PORT}/api/ping" >/dev/null 2>&1 \
     || curl -fsS "http://127.0.0.1:${CONSOLE_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

# ---------- 8. 收尾 ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-<服务器IP>}"
cat <<EOF

${C_GREEN}部署完成。${C_OFF}

  控制台   http://${IP}:${CONSOLE_PORT}
           令牌：${CONSOLE_TOKEN}
  QQ 登录  http://${IP}:${NOVNC_PORT}/vnc.html
           noVNC 密码：${VNC_PASSWORD}
  协议端   http://127.0.0.1:${SNOWLUMA_WEBUI_HOST_PORT}（仅本机，需要时走 SSH 隧道）

${C_DIM}接下来三步：${C_OFF}
  1. 打开 noVNC 地址，用手机 QQ 扫码登录机器人账号
  2. 打开控制台 →「API 配置」页，填 chat / story / vision 三套模型的 baseUrl、apiKey、model，点「测试连接」
  3. 到「角色卡 / 其他角色 / 用户与关系 / 世界」填设定（templates/ 下有标准格式模板）

需要放行的端口：${CONSOLE_PORT}（控制台）、${NOVNC_PORT}（noVNC）。
协议端的 5099、3000、3001 不要对外。

常用命令：
  docker compose logs -f moying      # 看引擎日志
  docker compose --env-file .env up -d --build   # 更新后重新构建
  bash deploy.sh                     # 重跑（保留已有配置与凭据）
EOF
