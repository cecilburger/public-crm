FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --omit=dev --ignore-scripts

FROM base AS runtime
# Runs unprivileged, with no shell tools it does not need.
RUN addgroup -g 10001 kirana && adduser -D -u 10001 -G kirana kirana
COPY --from=deps --chown=kirana:kirana /app/node_modules ./node_modules
COPY --chown=kirana:kirana . .
USER kirana
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
