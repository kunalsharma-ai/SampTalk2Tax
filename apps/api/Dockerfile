# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/api/Dockerfile --target api .       the API server
#   docker build -f apps/api/Dockerfile --target migrate .   applies MongoDB migrations, then exits
#
# Behind a TLS-inspecting proxy, pass its CA as an optional build secret:
#   --secret id=extra_ca,src=<ca.pem>

# The full Node image already has CA certificates; no apt needed.
FROM node:26-trixie AS build
# Node 25+ no longer ships corepack, so install it before enabling pnpm.
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca \
  pnpm install --frozen-lockfile --filter "@talk2tax/api..." && pnpm --filter "@talk2tax/api..." run build
# A production-only copy of the API and the workspace packages it uses. pnpm deploy installs the
# packages afresh without the code Prisma generates from the schema (the model types, decimals and
# the model description the data client reads), so the build's copy is put next to @prisma/client
# in the copy, and loaded once to check it. No query engine or SQL database is used.
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca \
  pnpm deploy --filter @talk2tax/api --prod --legacy /out \
  && cp -r apps/api/dist /out/dist \
  && cp -r /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma /out/node_modules/.pnpm/@prisma+client@*/node_modules/ \
  && cd /out && node -e "const { Prisma } = require(require.resolve('@prisma/client', { paths: [require.resolve('@talk2tax/database')] })); if (!Prisma.dmmf.datamodel.models.length) process.exit(1)"

# Release step, run once before new API containers start: the MongoDB migrations against MONGODB_URL.
FROM build AS migrate
WORKDIR /repo/apps/api
USER node
CMD ["node", "dist/db/migrate.js"]

# The API server: distroless (no shell or package manager), as a non-root user.
FROM gcr.io/distroless/nodejs26-debian13:nonroot AS api
WORKDIR /app
ENV NODE_ENV=production PORT=4000
# The commit the image was built from; shown under Platform admin → System health.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
COPY --from=build /out ./
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["dist/main.js"]
