# Salesforce Hub.
#
# Debian slim rather than Alpine ON PURPOSE: `sharp` ships prebuilt binaries for glibc,
# and on musl it falls back to compiling libvips from source — a ten-minute build that
# fails on a small VPS for reasons that look nothing like the real cause.
FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, so a code change does not re-download the world.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Run as a non-root user. The image writes nothing at runtime — every durable byte lives
# in MySQL (see ImageBlob) — so there is no directory this needs to own.
USER node

EXPOSE 3000

# `npm start` applies pending migrations and syncs the community categories before it
# serves, so a deploy carries its own schema change. The runner takes an advisory lock, so
# two instances starting at once cannot both migrate.
CMD ["npm", "start"]
