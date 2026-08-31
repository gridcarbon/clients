# gridcarbon MCP server — the mcp/ package of this monorepo.
#
# Build context is the REPO ROOT, not mcp/:
#     docker build -t gridcarbon-mcp .
#
# This is a stdio MCP server. It speaks JSON-RPC on stdin/stdout and exits as
# soon as stdin closes, so it MUST be run with -i. A bare `docker run` writes
# its banner to stderr and exits 0 with empty stdout — that is a server with
# nobody to talk to, not a failure.
#     docker run -i --rm gridcarbon-mcp
#
# MCP client config:
#     {"command": "docker", "args": ["run", "-i", "--rm", "gridcarbon-mcp"]}
#
# Optional: -e GRIDCARBON_API_URL=... to point at a non-production API.
# No credentials, no API key, no volumes.

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer caches independently of src/.
# Safe with no sources present: this package has no `prepare` and no install
# lifecycle scripts, and `prepublishOnly` only fires on `npm publish`.
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci

COPY mcp/tsconfig.json ./
COPY mcp/src ./src

# tsconfig emits .d.ts and .js.map for the npm publish path. The runtime image
# ships no src/, so those sourceMappingURL comments would point at nothing.
# Stripped here rather than in tsconfig, which still needs them for publishing.
RUN npm run build \
    && find dist \( -name '*.js.map' -o -name '*.d.ts' \) -delete \
    && test -f dist/index.js


FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# node installs no SIGTERM handler. As PID 1 it would ignore SIGTERM outright
# and `docker stop` would wait out the full grace period before SIGKILL. tini
# takes PID 1 and forwards signals to a normal child.
RUN apk add --no-cache tini && test -x /sbin/tini

COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# package.json is not only an install input: its "type": "module" is what makes
# node treat dist/*.js as ESM. Node >= 22.12 would infer it, but engines allows
# >= 18, where dropping this breaks the server. Do not "slim" it away.
COPY --from=build /app/dist ./dist
COPY mcp/LICENSE mcp/DATA-LICENSE.md ./

LABEL org.opencontainers.image.title="gridcarbon-mcp" \
      org.opencontainers.image.description="Hourly electricity carbon intensity for 45 zones, from ENTSO-E, EIA and NESO. No API key needed." \
      org.opencontainers.image.url="https://gridcarbon.dev" \
      org.opencontainers.image.source="https://github.com/gridcarbon/clients" \
      org.opencontainers.image.licenses="MIT"

USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
