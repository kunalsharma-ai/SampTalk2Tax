# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:26-bookworm-slim AS build
# Node 25+ no longer ships corepack, so install it before enabling pnpm.
RUN npm install -g corepack@0.36.0 && corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile && pnpm --filter @talk2tax/api... run build
RUN pnpm deploy --filter @talk2tax/api --prod --legacy /out && cp -r apps/api/dist /out/dist \
  && cp -r packages/database/prisma /out/prisma

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
