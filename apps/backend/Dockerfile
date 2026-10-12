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
COPY apps/backend apps/backend
RUN npm run build -w @resilience/contracts && npm run build -w @resilience/backend

FROM manifests AS dependencies
RUN npm ci --omit=dev --workspace @resilience/contracts --workspace @resilience/backend

FROM node:22.22.2-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
USER node
EXPOSE 3001
CMD ["node", "apps/backend/dist/main.js"]
