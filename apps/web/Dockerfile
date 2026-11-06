# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile .
# The web app has no database access; it reaches the API at T2T_API_URL, read when it starts.
# Behind a TLS-inspecting proxy, pass its CA as an optional build secret: --secret id=extra_ca,src=<ca.pem>
FROM node:22-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca \
  pnpm install --frozen-lockfile --filter "@talk2tax/web..."
# Workspace packages are used from their build output, then the self-contained Next.js server.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@talk2tax/web^..." run build && NEXT_OUTPUT=standalone pnpm --filter @talk2tax/web run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["apps/web/server.js"]
