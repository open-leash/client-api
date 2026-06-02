FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client-api/package.json apps/client-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/dashboard-api/package.json apps/dashboard-api/package.json
COPY apps/desktop-client/package.json apps/desktop-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @openleash/client-api --workspace @openleash/shared --include-workspace-root

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/client-api apps/client-api
COPY infra infra
RUN npm run build -w @openleash/shared && npm run build -w @openleash/client-api

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/client-api/package.json apps/client-api/package.json
COPY apps/dashboard-web/package.json apps/dashboard-web/package.json
COPY apps/dashboard-api/package.json apps/dashboard-api/package.json
COPY apps/desktop-client/package.json apps/desktop-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace @openleash/client-api --workspace @openleash/shared --include-workspace-root && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/client-api/dist apps/client-api/dist
COPY infra infra
EXPOSE 9318 9319
CMD ["node", "apps/client-api/dist/server.js"]
