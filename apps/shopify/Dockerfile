FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/api/package.json apps/api/
COPY apps/catalogues-web/package.json apps/catalogues-web/
COPY apps/chatbot/package.json apps/chatbot/
COPY apps/dispatcher/package.json apps/dispatcher/
COPY apps/shopify/package.json apps/shopify/
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY packages/observability/package.json packages/observability/
COPY packages/storage/package.json packages/storage/
COPY packages/types/package.json packages/types/
RUN pnpm install --no-frozen-lockfile --filter @tryme/shopify-admin...

FROM deps AS build
COPY . .
ARG VITE_SHOPIFY_API_KEY
ENV VITE_SHOPIFY_API_KEY=$VITE_SHOPIFY_API_KEY
ARG VITE_TRYME_APP_URL
ENV VITE_TRYME_APP_URL=$VITE_TRYME_APP_URL
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG VITE_SHOPIFY_APP_HANDLE
ENV VITE_SHOPIFY_APP_HANDLE=$VITE_SHOPIFY_APP_HANDLE
RUN pnpm --filter @tryme/types build
RUN NODE_ENV=production pnpm --filter @tryme/shopify-admin build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/shopify/dist /usr/share/nginx/html
COPY apps/shopify/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
