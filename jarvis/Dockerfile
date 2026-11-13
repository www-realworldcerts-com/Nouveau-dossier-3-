# Production image for the JARVIS Next.js app.
# Build from the jarvis/ directory:
#   docker build -t jarvis-web:2.0.0 .
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
RUN bun run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Prisma's SQLite query engine needs OpenSSL at runtime.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# The build script places static assets inside the standalone output.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
