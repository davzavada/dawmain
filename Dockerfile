# Build stage: install all workspaces, build the SPA, drop dev dependencies.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web && npm prune --omit=dev

# Runtime: tsx runs the TypeScript server directly; no native modules,
# so the same image builds for amd64 and arm64 without a toolchain.
FROM node:24-alpine
ENV NODE_ENV=production \
    DB_PATH=/data/crm.sqlite \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
