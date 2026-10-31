# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile && pnpm --filter @talk2tax/api... run build
RUN pnpm deploy --filter @talk2tax/api --prod --legacy /out && cp -r apps/api/dist /out/dist \
  && cp -r packages/database/prisma /out/prisma

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
