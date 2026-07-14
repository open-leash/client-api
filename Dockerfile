FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client-api/package.json apps/client-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/dashboard-api/package.json apps/dashboard-api/package.json
COPY apps/desktop-client/package.json apps/desktop-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @openleash/client-api --workspace @openleash/shared

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/client-api apps/client-api
COPY infra infra
RUN npm run build -w @openleash/shared && npm run build -w @openleash/client-api

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/client-api/package.json apps/client-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/dashboard-api/package.json apps/dashboard-api/package.json
COPY apps/desktop-client/package.json apps/desktop-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace @openleash/client-api --workspace @openleash/shared \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/client-api/dist apps/client-api/dist
COPY --from=build /app/apps/client-api/infra apps/client-api/infra
COPY infra infra
COPY scripts/db-create-organization.mjs scripts/db-create-organization.mjs
EXPOSE 9318 9319
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/client-api/dist/server.js"]
