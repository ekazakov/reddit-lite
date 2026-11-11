FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY scripts ./scripts
USER node
EXPOSE 3000
# Applies migrations, then starts the server. `exec` lets Node receive SIGTERM.
CMD ["sh", "-c", "node src/migrate.ts && exec node src/server.ts"]
