# The realtime server, for any container host (Railway, Fly.io, Cloud Run with
# session affinity, a plain VM). Render users can use `render.yaml` instead.
#
# Only `socket-server.ts` runs here. The REST API stays on Vercel; see the
# comment at the top of `socket-server.ts` for why the two are separated.

# ---- build ----------------------------------------------------------------
FROM node:20-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json ./
COPY socket-server.ts server.ts ./
COPY src ./src

# `tsc` emits the `@/*` alias verbatim and Node cannot resolve it, so
# `tsc-alias` rewrites those imports to relative paths. Skips `next build`:
# this image serves no pages.
RUN npm run build:socket

# ---- runtime --------------------------------------------------------------
FROM node:20-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Never run as root.
USER node

EXPOSE 3000

# The container is unhealthy if Socket.IO is not attached, not merely if the
# process is alive — a server that answers HTTP but has no realtime layer is
# exactly the failure this whole split exists to prevent.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.socket==='attached'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/socket-server.js"]
