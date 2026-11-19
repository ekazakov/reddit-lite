# --- Stage 1: install production dependencies ----------------------------------
# Pin the base image by digest, so every build uses the same bytes. Renovate updates the tag and the digest together.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
# Use the same folder as the final stage, so the relative pnpm symlinks stay valid after the copy.
WORKDIR /app
# Copy only the manifests first, so Docker reuses the install layer when only the source code changes.
# pnpm-workspace.yaml carries the supply-chain settings (release age, trust policy, build-script allow list).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Install the exact pnpm version from "packageManager" in package.json, so Renovate updates one place only.
# This stage is thrown away, so npm and pnpm never reach the final image.
RUN npm install -g "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"
# Install only runtime dependencies from the reviewed lockfile. --frozen-lockfile fails instead of resolving new versions.
RUN pnpm install --frozen-lockfile --prod

# --- Stage 2: runtime image ----------------------------------------------------
# Same pinned base as the deps stage, so the Node version matches the installed packages.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
# Production mode turns on production settings in the app and in libraries.
ENV NODE_ENV=production
# The app lives here. The same path as the deps stage keeps node_modules links valid.
WORKDIR /app
# Install Alpine security fixes released after the base image was built. --no-cache keeps the package index out of the image.
# Then remove npm and npx. The app never calls them, and npm's bundled packages cause most scanner findings in node images.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Copy the installed dependencies. COPY makes root the owner, so the app user cannot change them.
COPY --from=deps /app/node_modules ./node_modules
# Copy package.json, because Node reads "type": "module" from it to load the .ts files as ES modules.
COPY package.json ./
# Copy the server source code.
COPY src ./src
# Copy the SQL migrations. The start command applies them.
COPY migrations ./migrations
# Copy the static browser files that the server serves.
COPY public ./public
# Copy the scripts folder, so `node scripts/seed.ts` can load demo data from inside the container.
COPY scripts ./scripts
# Run as the unprivileged "node" user from the base image. The files above stay owned by root, so the process cannot rewrite its own code.
USER node
# Document the port that the server listens on.
EXPOSE 3000
# Apply migrations, then start the server. `exec` replaces the shell, so Node receives SIGTERM and stops cleanly.
CMD ["sh", "-c", "node src/migrate.ts && exec node src/server.ts"]
