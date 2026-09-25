#!/usr/bin/env bash
# Deploys the CRM test stack to a server that already serves other sites,
# mounted at https://<host>/crm behind that server's nginx.
#
#   ops/deploy-crm.sh check  root@72.62.244.186      # read-only: what the server has
#   CRM_PASSWORD='…' ops/deploy-crm.sh deploy root@72.62.244.186
#
# Optional: SSH_KEY=~/.ssh/deploy_key to pick the key; SITE_FILE=/etc/nginx/…
# when the site's server block doesn't name the host (a catch-all `server_name _`).
#
# What `deploy` does on the server, as root:
#   - a system user `mcncrm` owns everything under /opt/mcnasia-crm
#     (embedded Postgres refuses to run as root)
#   - Node 22 unpacked into /opt/mcnasia-crm/node — the system Node, and
#     whatever else runs on the box, is left alone
#   - `development` from GitHub checked out into /opt/mcnasia-crm/app
#   - two systemd services: the API with its Postgres (127.0.0.1:18080) and
#     the console (127.0.0.1:13000), both local-only
#   - accounts from CRM_USERS set up with CRM_PASSWORD; every other account
#     in the workspace disabled (the demo password is public)
#   - one `include` line added to the site's nginx server block, pointing at
#     /etc/nginx/snippets/mcnasia-crm.conf. The original config is backed up
#     to /root/nginx-backups/, `nginx -t` must pass, and a failing test puts
#     the backup straight back. Nothing else on the site changes.
#
# The password travels over SSH's stdin, never on a command line.
set -euo pipefail

MODE=${1:-}; TARGET=${2:-}
[[ $MODE == check || $MODE == deploy ]] && [[ -n $TARGET ]] || {
  echo "usage: $0 check|deploy user@host" >&2; exit 2; }

SITE_HOST=${SITE_HOST:-dashboardmcn.my.id}
CRM_USERS=${CRM_USERS:-cecil:owner:Cecil,fattah:admin:Fattah}
CRM_LOGIN_DOMAIN=${CRM_LOGIN_DOMAIN:-mcnasia.biz}
CRM_WORKSPACE=${CRM_WORKSPACE:-toko-demo}
CRM_PASSWORD=${CRM_PASSWORD:-}
if [[ $MODE == deploy && ${#CRM_PASSWORD} -lt 8 ]]; then
  echo "Set CRM_PASSWORD (8+ characters) for the accounts." >&2; exit 2
fi

ssh_opts=(-o ConnectTimeout=15)
[[ -n ${SSH_KEY:-} ]] && ssh_opts+=(-i "$SSH_KEY")

{
  printf 'MODE=%q SITE_HOST=%q SITE_FILE=%q CRM_USERS=%q CRM_LOGIN_DOMAIN=%q CRM_WORKSPACE=%q CRM_PASSWORD=%q\n' \
    "$MODE" "$SITE_HOST" "${SITE_FILE:-}" "$CRM_USERS" "$CRM_LOGIN_DOMAIN" "$CRM_WORKSPACE" "$CRM_PASSWORD"
  cat <<'REMOTE'
set -euo pipefail
ROOT=/opt/mcnasia-crm; APP=$ROOT/app; NODE_DIR=$ROOT/node; APP_USER=mcncrm
API_PORT=18080; WEB_PORT=13000; PG_PORT=15433; MOUNT=/crm
REPO=https://github.com/cecilburger/public-crm.git; BRANCH=development
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# The site's server block: named by SITE_FILE, or found by its server_name.
site_files() {
  if [[ -n $SITE_FILE ]]; then readlink -f "$SITE_FILE"; return; fi
  { grep -lsE "server_name[^;]*\b${SITE_HOST//./\\.}\b" /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null || true; } \
    | xargs -r -n1 readlink -f | sort -u
}
# Where the include goes inside that file: after the server_name line for the
# site, or — for a catch-all block that never names it — after `server_name _;`.
anchor_re() {
  if [[ -n $SITE_FILE ]]; then echo "server_name[^;]*;"; else echo "server_name[^;]*\b${SITE_HOST//./\\.}\b[^;]*;"; fi
}

if [[ $MODE == check ]]; then
  say "server";  echo "user: $(whoami)  host: $(hostname)  $(. /etc/os-release; echo "$PRETTY_NAME")  arch: $(uname -m)"
  echo "cpus: $(nproc)  $(free -m | awk '/Mem/{print "RAM MB total/available: "$2"/"$7}')  disk free: $(df -h / | awk 'NR==2{print $4}')"
  echo "node: $(command -v node >/dev/null && node -v || echo none)  git: $(command -v git >/dev/null && echo yes || echo NO)  curl: $(command -v curl >/dev/null && echo yes || echo NO)  xz: $(command -v xz >/dev/null && echo yes || echo NO)  systemd: $(command -v systemctl >/dev/null && echo yes || echo NO)"
  say "ports this deploy wants (must be free, or already ours)"
  for p in $API_PORT $WEB_PORT $PG_PORT; do
    if ss -ltnH "sport = :$p" | grep -q .; then echo "$p IN USE: $(ss -ltnpH "sport = :$p" | awk '{print $NF}')"; else echo "$p free"; fi
  done
  say "nginx site files for $SITE_HOST"
  files=$(site_files); [[ -n $files ]] || echo "none found by server_name"
  for f in $files; do
    echo "--- $f"; grep -nE '^\s*(listen|server_name|location|include|return|root|proxy_pass)\b' "$f" | sed 's/^/  /'
  done
  say "every server block nginx loads (nginx -T)"
  nginx -T 2>/dev/null | grep -E '^# configuration file|^\s*(listen|server_name|location|return|proxy_pass)\b' \
    | grep -v '^# configuration file /etc/nginx/\(mime.types\|fastcgi\|snippets/fastcgi\|koi\|win\|scgi\|uwsgi\|proxy_params\)' \
    | sed 's/^\s*/  /' | head -150
  say "existing install"; ls -la $ROOT 2>/dev/null || echo "none"
  systemctl is-active mcnasia-crm-api mcnasia-crm-web 2>/dev/null || true
  exit 0
fi

[[ $(id -u) == 0 ]] || die "deploy needs root (systemd units, nginx, a system user)"
command -v git >/dev/null && command -v curl >/dev/null && command -v xz >/dev/null \
  || die "install git, curl and xz-utils first"
files=$(site_files); [[ -n $files ]] || die "no nginx server block names $SITE_HOST"

say "system user and directories"
id $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/$APP_USER --shell /usr/sbin/nologin $APP_USER
mkdir -p $ROOT && chown $APP_USER: $ROOT
as_app() { runuser -u $APP_USER -- env HOME=/var/lib/$APP_USER PATH="$NODE_DIR/bin:/usr/bin:/bin" "$@"; }

say "Node 22 (private to this app)"
if [[ ! -x $NODE_DIR/bin/node ]]; then
  case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) die "unsupported arch $(uname -m)";; esac
  tarball=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}')
  [[ -n $tarball ]] || die "could not find a Node 22 build"
  as_app mkdir -p $NODE_DIR
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$tarball" | as_app tar -xJ -C $NODE_DIR --strip-components=1
fi
as_app node -v

say "code: $BRANCH"
if [[ -d $APP/.git ]]; then
  as_app git -C $APP fetch -q origin $BRANCH && as_app git -C $APP reset -q --hard origin/$BRANCH
else
  as_app git clone -q -b $BRANCH $REPO $APP
fi
as_app git -C $APP log -1 --format='%h %an — %s'

say "dependencies"
( cd $APP && as_app npm ci --no-audit --no-fund --loglevel=error )

if [[ ! -f $APP/.env ]]; then
  say "configuration (first deploy: fresh encryption key)"
  as_app cp $APP/.env.example $APP/.env
  kek=$(openssl rand -base64 32)
  as_app sed -i -e "s|^KIRANA_KEK=.*|KIRANA_KEK=$kek|" -e "s|^PORT=.*|PORT=$API_PORT|" $APP/.env
  grep -q '^PORT=' $APP/.env || echo "PORT=$API_PORT" | as_app tee -a $APP/.env >/dev/null
fi

say "console build (mounted at $MOUNT)"
( cd $APP && as_app env CONSOLE_BASE_PATH=$MOUNT KIRANA_API_URL=http://127.0.0.1:$API_PORT npm run build:console --silent ) \
  | tail -5

say "services"
cat > /etc/systemd/system/mcnasia-crm-api.service <<UNIT
[Unit]
Description=MCNASIA CRM API + Postgres (test stack)
After=network.target
[Service]
User=$APP_USER
WorkingDirectory=$APP
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
Environment=PORT=$API_PORT
Environment=DEV_STACK_PG_PORT=$PG_PORT
ExecStart=$APP/node_modules/.bin/tsx --env-file=.env tools/dev-stack.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/mcnasia-crm-web.service <<UNIT
[Unit]
Description=MCNASIA CRM console at $MOUNT (test stack)
After=network.target mcnasia-crm-api.service
[Service]
User=$APP_USER
WorkingDirectory=$APP/apps/console
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=CONSOLE_BASE_PATH=$MOUNT
Environment=CONSOLE_WORKSPACE=$CRM_WORKSPACE
Environment=CONSOLE_LOGIN_DOMAIN=$CRM_LOGIN_DOMAIN
ExecStart=$APP/node_modules/.bin/next start -p $WEB_PORT -H 127.0.0.1
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q mcnasia-crm-api mcnasia-crm-web
systemctl restart mcnasia-crm-api
for i in $(seq 1 180); do curl -fs http://127.0.0.1:$API_PORT/healthz >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:$API_PORT/healthz >/dev/null || { journalctl -u mcnasia-crm-api -n 40 --no-pager; die "API did not come up"; }
echo "API up on 127.0.0.1:$API_PORT"
systemctl restart mcnasia-crm-web
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:$WEB_PORT$MOUNT/masuk && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:$WEB_PORT$MOUNT/masuk || { journalctl -u mcnasia-crm-web -n 40 --no-pager; die "console did not come up"; }
echo "console up on 127.0.0.1:$WEB_PORT$MOUNT"

say "accounts"
( cd $APP && as_app env DEV_STACK_PG_PORT=$PG_PORT CRM_WORKSPACE="$CRM_WORKSPACE" CRM_LOGIN_DOMAIN="$CRM_LOGIN_DOMAIN" \
    CRM_USERS="$CRM_USERS" CRM_PASSWORD="$CRM_PASSWORD" CRM_DISABLE_OTHERS=1 \
    node_modules/.bin/tsx --env-file=.env tools/set-users.ts )

say "nginx"
cat > /etc/nginx/snippets/mcnasia-crm.conf <<NGINX
# MCNASIA CRM test stack — see $APP/ops/deploy-crm.sh
# ^~ so no regex location elsewhere in the site can take these URLs.
location ^~ $MOUNT {
    proxy_pass http://127.0.0.1:$WEB_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    # Live updates are a server-sent event stream; buffering would hold them back.
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 25m;
}
NGINX
mkdir -p /root/nginx-backups
stamp=$(date +%Y%m%d-%H%M%S)
for f in $files; do
  if grep -q 'snippets/mcnasia-crm.conf' "$f"; then echo "$f already includes the snippet"; continue; fi
  cp -p "$f" "/root/nginx-backups/$(basename "$f").$stamp"
  echo "backup: /root/nginx-backups/$(basename "$f").$stamp"
  sed -i -E "/$(anchor_re)/a\\    include snippets/mcnasia-crm.conf; # mcnasia-crm" "$f"
done
if ! nginx -t 2>&1; then
  for f in $files; do
    b="/root/nginx-backups/$(basename "$f").$stamp"; [[ -f $b ]] && cp -p "$b" "$f"
  done
  nginx -t >/dev/null 2>&1 && die "nginx rejected the change — original config restored, nothing reloaded"
  die "nginx config test failing even after restore — check by hand before reloading"
fi
systemctl reload nginx

say "live check"
for p in "$MOUNT/masuk" "$MOUNT/logo.webp"; do
  printf '%s  https://%s%s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$SITE_HOST$p")" "$SITE_HOST" "$p"
done
echo; echo "Done: https://$SITE_HOST$MOUNT"
REMOTE
} | ssh "${ssh_opts[@]}" "$TARGET" 'bash -s'
