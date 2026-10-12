FROM node:22.22.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/external-api/package.json apps/external-api/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/frontend apps/frontend
RUN npm run build -w @resilience/contracts && npm run build -w @resilience/frontend

FROM nginx:1.28-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
