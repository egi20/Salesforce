# Salesforce Hub.
#
# Debian slim rather than Alpine ON PURPOSE: `sharp` ships prebuilt binaries for glibc,
# and on musl it falls back to compiling libvips from source — a ten-minute build that
# fails on a small VPS for reasons that look nothing like the real cause.
#
# Node 24 (LTS). Node 20 reached end of life in April 2026, and two dependencies already
# declare they need newer: geoip-lite 2.0.3 wants >=24 and sanitize-html 2.17.7 >=22.12. The
# build printed EBADENGINE for both — warnings today, a missing security fix tomorrow. Keep
# this, `engines` in package.json and `node-version` in the CI workflow on the same major.
FROM node:24-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, so a code change does not re-download the world.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force --loglevel=error

COPY . .

# Run as a non-root user. The image writes nothing at runtime — every durable byte lives
# in MySQL (see ImageBlob) — so there is no directory this needs to own.
USER node

EXPOSE 3000

# `npm start` applies pending migrations and syncs the community categories before it
# serves, so a deploy carries its own schema change. The runner takes an advisory lock, so
# two instances starting at once cannot both migrate.
CMD ["npm", "start"]
