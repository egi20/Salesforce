#!/usr/bin/env bash
#
# One-command install on a fresh Ubuntu server.
#
#   sudo bash deploy/setup.sh yourdomain.com you@example.com
#
# It is idempotent: running it again re-reads the existing deploy/.env rather than
# generating new secrets, so a re-run cannot lock you out of your own database.
#
# It checks DNS and the firewall BEFORE starting anything, because the failure those cause
# is a certificate loop with a message that does not mention either of them.
set -euo pipefail

DOMAIN="${1:-}"
TLS_EMAIL="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[ -n "$DOMAIN" ] && [ -n "$TLS_EMAIL" ] \
  || die "Usage: sudo bash deploy/setup.sh yourdomain.com you@example.com"

# ---------------------------------------------------------------- prerequisites
command -v docker >/dev/null 2>&1 || {
  say "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
}
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Update Docker."

# ---------------------------------------------------------------- DNS
# Checked first because this is the one that wastes an afternoon: Caddy cannot get a
# certificate until the name resolves here, and its retry message talks about ACME rather
# than about DNS.
say "Checking DNS for $DOMAIN..."
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"

if [ -z "$RESOLVED" ]; then
  die "$DOMAIN does not resolve yet.
  Add an A record for @ and for www pointing at this server (${SERVER_IP:-check its IP}), then run this again."
elif [ -n "$SERVER_IP" ] && [ "$RESOLVED" != "$SERVER_IP" ]; then
  die "$DOMAIN resolves to $RESOLVED, but this server is $SERVER_IP.
  Fix the A record, wait for it to propagate, then run this again."
else
  say "DNS points here. Good."
fi

# ---------------------------------------------------------------- ports
for port in 80 443; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
    die "Port $port is already in use. Stop whatever is listening (often Apache or nginx):
  systemctl disable --now apache2 nginx"
  fi
done
say "Ports 80 and 443 are free."

# ---------------------------------------------------------------- secrets
ENV_FILE="$HERE/.env"
if [ -f "$ENV_FILE" ]; then
  say "deploy/.env exists — keeping the secrets already in it."
else
  say "Generating secrets..."
  cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
TLS_EMAIL=$TLS_EMAIL

APP_NAME=Salesforce Hub
SUPPORT_EMAIL=$TLS_EMAIL

DB_ROOT_PASSWORD=$(openssl rand -hex 24)
DB_USER=sfhub
DB_PASSWORD=$(openssl rand -hex 24)
DB_NAME=salesforce_hub

SESSION_SECRET=$(openssl rand -hex 32)

# All optional. Each feature switches itself off when its key is missing.
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
RESEND_API_KEY=
EMAIL_FROM=Salesforce Hub <noreply@$DOMAIN>
ANTHROPIC_API_KEY=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
TAX_ADVISORY_NOTIFY=
RATE_MIN_SAMPLE=3
EOF
  chmod 600 "$ENV_FILE"
  say "Wrote deploy/.env (mode 600). Back it up somewhere safe — it holds the database password."
fi

# ---------------------------------------------------------------- up
say "Building and starting. The first build takes a few minutes."
cd "$HERE"
docker compose up -d --build

# ---------------------------------------------------------------- wait
say "Waiting for the app to answer..."
for i in $(seq 1 90); do
  if docker compose exec -T app node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    say "The app is up. Migrations applied."
    break
  fi
  [ "$i" = 90 ] && die "It did not come up. Look at:  docker compose logs app"
  sleep 2
done

cat <<EOF

  Done.

  Open      https://$DOMAIN
  Certificate: Caddy is fetching it now. Give it up to a minute on the first load.

  You have NO account yet, and no data. That is deliberate — the development
  seed would fill your public rate index with invented figures and your
  consultant directory with people who do not exist.

  Make yourself an administrator:

    cd $HERE && docker compose exec app npm run create-admin -- you@$DOMAIN "Your Name"

  It prints a password once.

  Back up regularly. Everything, including every uploaded image, is in the one
  database:

    cd $HERE && docker compose exec -T db mysqldump -u root -p"\$(grep ^DB_ROOT_PASSWORD .env | cut -d= -f2)" \\
      --single-transaction --routines salesforce_hub | gzip > ~/backup-\$(date +%F).sql.gz

EOF
