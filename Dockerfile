# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# `docker build --target test .` runs the API tests; CI does this before building the release image.
FROM node:22-bookworm-slim AS test
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
RUN node --test test/*.test.js

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Australia/Brisbane \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# The SQLite database lives in /data — mount a persistent volume there.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
