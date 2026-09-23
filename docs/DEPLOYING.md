# Putting it online

Written after running the app for real against MySQL 8.0.46 on 2026-09-17. The facts
below about what breaks are observed, not predicted.

## The one thing that decides everything

**In production this application cannot work over plain HTTP.** The session cookie is
`Secure`, so a browser never sends it back over an unencrypted connection. Every page still
renders, and every sign-in silently fails — which is the most confusing way a deploy can
break, because nothing looks wrong.

Verified both directions:

| Request | Result |
|---|---|
| `POST /auth/login` over plain HTTP, `NODE_ENV=production` | 302 to `/`, session lost, `/dashboard` bounces back to login |
| Same request with `X-Forwarded-Proto: https` | 302 to `/dashboard`, `/dashboard` returns 200 |

So a TLS certificate is load-bearing, and whatever sits in front must send
`X-Forwarded-Proto`. The app already sets `trust proxy` when `NODE_ENV=production`; that is
the other half.

## What you actually need

Four things, and only two of them cost anything.

1. **A machine that runs Node 18+ as a long-lived process.** Not PHP shared hosting.
2. **MySQL 8.** Not Postgres — see below.
3. **A domain**, pointed at that machine's IP with an `A` record.
4. **A TLS certificate**, which the setup below obtains by itself.

## What you do NOT need

Worth knowing, because it removes the usual shopping list:

- **No object storage, no S3, no persistent disk.** Every uploaded image is re-encoded and
  stored in MySQL (`ImageBlob`). The container writes nothing.
- **No Redis.** Sessions live in MySQL.
- **No separate worker, no cron.** Migrations run on start; the one scheduled job
  (`npm run purge:expired`) is also a button in the admin area.
- **No API keys to launch.** Stripe, Resend, Anthropic and LinkedIn each switch their own
  feature off when unset. The marketplace, rate index, estimator, documents, community,
  search, challenge, CRM and admin all work without any of them.

## Why not Render, and why not Postgres

Render's managed database is **PostgreSQL**. This schema and these queries are MySQL:

- 84 foreign-key constraints
- 24 `INSERT IGNORE`, 10 `ON DUPLICATE KEY UPDATE` — the idempotency this codebase puts in
  the schema rather than in code paths
- `CAST(? AS JSON)`, `JSON_CONTAINS`, `JSON_QUOTE`, `MEDIUMBLOB`, `TINYINT(1)`,
  `DATE_FORMAT`, `INTERVAL ? DAY`
- `express-mysql-session` for the session store

Moving to Postgres is not a connection-string change; it is rewriting every one of those
and re-testing the parts where the difference is subtle. Render can still run the *app* —
it just cannot be the database.

## The setup: one server, everything on it

`deploy/docker-compose.yml` runs three containers: the app, MySQL 8, and Caddy. Caddy gets
the certificate on first start and renews it with no cron job, which matters precisely
because the certificate is load-bearing.

On a fresh Ubuntu 22.04 or 24.04 server, after the A record points here:

```bash
git clone https://github.com/egi20/Salesforce.git
cd Salesforce
sudo bash deploy/setup.sh yourdomain.com you@example.com
```

That installs Docker if it is missing, generates the three secrets, checks DNS and the
ports BEFORE starting anything, brings the stack up and waits for the app to answer. It is
idempotent: a second run reuses the existing `deploy/.env` rather than generating new
secrets, so it cannot lock you out of your own database.

The DNS check is first on purpose. Pointing the name after starting Caddy produces a
certificate retry loop whose message talks about ACME and never mentions DNS, and that is
the failure that costs an afternoon.

Then make yourself an account:

```bash
cd deploy
docker compose exec app npm run create-admin -- you@yourdomain.com "Your Name"
```

**Use `create-admin`, not `npm run seed`.** The seed is development data: 30 jobs, 24
consultant profiles, 6 companies — and 24 rate submissions. That last one is not cosmetic.
The rate index publishes percentiles from what it holds, so seeding it puts a real-looking
benchmark in front of visitors that nobody contributed to, and the seeded profiles are a
public directory of people who do not exist.

## The DNS half, at GoDaddy

None of the options on GoDaddy's "Let's connect" screen create a server — they only decide
where an existing name points. The one you want is **Connect to any website**, or the
equivalent under **Domain → DNS → Manage DNS**:

| Type | Name | Value |
|---|---|---|
| A | `@` | your server's IPv4 address |
| A | `www` | the same address |

Nothing else. No CNAME, no forwarding, no parked page. Propagation is usually minutes;
give it up to an hour before deciding something is wrong.

## Updating it later

```bash
cd Salesforce && git pull
cd deploy && docker compose up -d --build
```

Or re-run `sudo bash deploy/setup.sh yourdomain.com you@example.com`, which does the same
and keeps your secrets.

`npm start` applies pending migrations before it serves, so a deploy carries its own schema
change. The runner takes an advisory lock, so two instances starting together cannot both
migrate.

## Before real people use it

Three things this application cannot decide for you, and will warn about until you do:

- **`LEGAL_CONTROLLER_NAME` and `LEGAL_CONTROLLER_ADDRESS`.** The privacy policy must name
  who is responsible for personal data. Unset, the policy and `/contact` say so in a warning
  box and the boot logs it. Set `LEGAL_SUPERVISORY_AUTHORITY` too — which one depends on
  where you are.
- **`SUPPORT_EMAIL`.** It ships as `support@example.com` and `/contact` refuses to print that
  rather than invite people to write to an address nobody opens.
- **`RESEND_API_KEY`.** Without it, email is only logged — and login refuses unverified
  accounts, so **nobody except an administrator can sign in at all**. The site looks live
  and no real person can finish registering.

And one thing not to do: **never run `npm run seed` on a live site.** It refuses when
`NODE_ENV=production`, because it would publish 24 consultant profiles for people who do not
exist and 24 invented figures into a rate index presented as contributed by real consultants.
Use `npm run create-admin` instead.

## Backups

Nothing here does them for you, and everything is in one database — including every
uploaded image.

```bash
docker compose exec -T db mysqldump -u root -p"$DB_ROOT_PASSWORD" \
  --single-transaction --routines salesforce_hub | gzip > backup-$(date +%F).sql.gz
```

Put that in a cron job on the host and copy the file somewhere that is not this server.

## When you add the paid pieces

- **Stripe** — set the three keys, then point a webhook at
  `https://yourdomain/payments/webhook`. With `STRIPE_WEBHOOK_SECRET` unset the endpoint
  refuses every delivery rather than trusting an unsigned body, so set it before testing.
- **Resend** — `RESEND_API_KEY` and a verified sending domain. Without it, emails print to
  `docker compose logs app`.
- **Anthropic** — `ANTHROPIC_API_KEY` switches on the assistant and both drafting features.
  They share one month-to-date spend cap.
- **LinkedIn** — both `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`, with the callback
  registered as `https://yourdomain/linkedin/callback`. Setting only one fails the boot on
  purpose, rather than half-working.

## Failures worth recognising

| Symptom | Cause |
|---|---|
| Pages load, sign-in does nothing | No TLS, or the proxy is not sending `X-Forwarded-Proto`. |
| Caddy loops on the certificate | DNS is not pointing here yet, or port 80 is blocked. |
| `Table 'users' already exists` | `DB_NAME` points at another application's database. The migration runner refuses this deliberately. |
| `sharp` fails to build | Alpine. The Dockerfile uses Debian slim for exactly this reason. |
| Boot throws about `SESSION_SECRET` | It is missing or too short. `config/config.js` refuses to start in production rather than signing cookies with a default. |
