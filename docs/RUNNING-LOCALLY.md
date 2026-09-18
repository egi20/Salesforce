# Running it on your own machine

Verified end to end on 2026-09-17 against MySQL 8.0.46: all 22 migrations applied, seed
data loaded, every page rendered, and a challenge submission was graded and written.

## What you need

- **Node 18 or newer** — `node -v`
- **MySQL 8** — MariaDB is close but not identical, and the schema uses MySQL 8 features
  (`JSON` columns, `JSON_CONTAINS`, `only_full_group_by` semantics). Use MySQL 8.

## Five commands

```bash
# 1. Get the code and install
git clone https://github.com/egi20/Salesforce.git
cd Salesforce
git checkout claude/dynamichub-webapp-clone-4cmj1w
npm install

# 2. Make the database and a user for it
mysql -uroot -e "CREATE DATABASE salesforce_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'sfhub'@'localhost' IDENTIFIED BY 'devpassword';
  GRANT ALL ON salesforce_hub.* TO 'sfhub'@'localhost';"

# 3. Configure
cp .env.example .env
#    then edit .env:  DB_USER=sfhub  DB_PASSWORD=devpassword
#    and set SESSION_SECRET to any 32+ character string, e.g.:
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Create the tables and some data to look at
npm run migrate
npm run sync:categories
npm run seed

# 5. Start it
npm start
```

Then open **http://localhost:3000** and sign in as **admin@example.com / Password123**.

`npm start` runs the migrations itself before serving, so step 4's `npm run migrate` is
only needed if you want to see them apply on their own.

## What works with no keys at all

Everything except the four things that talk to somebody else. Each degrades deliberately
rather than crashing:

| Unset | What happens |
|---|---|
| `STRIPE_SECRET_KEY` | Checkout offers a "not switched on" path. No payment can start. |
| `ANTHROPIC_API_KEY` | The assistant widget is not emitted into the page at all, and AI drafting is hidden. |
| `RESEND_API_KEY` | Emails are printed to the console instead of sent. |
| `LINKEDIN_CLIENT_ID` | The verification button does not appear. |

So the marketplace, the rate index, the estimator, the documents, the community, search,
the challenge, the CRM and the whole admin area all work on a fresh clone with nothing but
a database.

## Worth clicking, in this order

1. `/` → `/jobs` → open a job. Thirty seeded roles.
2. `/rates` — the privacy floor in action: buckets under three contributors show the count
   and withhold the numbers.
3. `/quotes/new` — pick clouds and modules, get a phased plan and a budget, then download
   the SOW, the work breakdown and the deck.
4. `/challenges` — five questions. Open the page source and look: the correct answer is not
   in it.
5. `/admin` → Analytics, Success stories, Member reviews.
6. `/crm` — add a lead and watch it refuse to save without a source.

## Stopping and starting again

```bash
# stop:  Ctrl-C
# wipe and start over:
mysql -uroot -e "DROP DATABASE salesforce_hub;"
```

## If something goes wrong

- **"Table 'users' already exists"** — `DB_NAME` points at another application's database.
  The migration runner refuses this on purpose; point it somewhere empty.
- **`ER_NOT_SUPPORTED_AUTH_MODE`** — an old MySQL client library against MySQL 8. Upgrade,
  or `ALTER USER 'sfhub'@'localhost' IDENTIFIED WITH mysql_native_password BY 'devpassword';`
- **`sharp` fails to install** — it needs a prebuilt binary for your platform. On Apple
  Silicon use an arm64 Node, not one running under Rosetta.
- **Port 3000 taken** — set `PORT` in `.env`.
