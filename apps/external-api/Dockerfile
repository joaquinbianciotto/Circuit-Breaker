FROM node:22.22.2-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/external-api/package.json apps/external-api/package.json
COPY apps/frontend/package.json apps/frontend/package.json

FROM manifests AS build
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/external-api apps/external-api
RUN npm run build -w @resilience/contracts && npm run build -w @resilience/external-api

FROM manifests AS dependencies
RUN npm ci --omit=dev --workspace @resilience/contracts --workspace @resilience/external-api

FROM node:22.22.2-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/external-api/package.json ./apps/external-api/package.json
COPY --from=build /app/apps/external-api/dist ./apps/external-api/dist
USER node
EXPOSE 3002
CMD ["node", "apps/external-api/dist/main.js"]
