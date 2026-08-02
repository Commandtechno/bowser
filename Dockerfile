# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-bookworm-slim

# ---- deps + build ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ---- runtime ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# system binaries the app shells out to (see requirements.txt) - ffmpeg/exiftool/poppler for
# thumbnails+metadata, rclone for protocol-based share links (optional at runtime, but always
# installed here so that feature works out of the box)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      exiftool \
      poppler-utils \
      curl \
      unzip \
      ca-certificates \
    && curl -fsSL https://rclone.org/install.sh | bash \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# node_modules is copied rather than reinstalled with --prod so native modules (sharp,
# @node-rs/argon2, @libsql/client) keep the prebuilt binaries pnpm already resolved for this
# same base image/arch in the build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# ROOT_DIR/THUMBS_DIR/DB_PATH are meant to be bind-mounted volumes (see docker-compose.yml)
# rather than baked into the image - defaults here just match .env.example
ENV HOST=0.0.0.0
ENV PORT=7504
ENV ROOT_DIR=/files
ENV THUMBS_DIR=/thumbs
ENV DB_PATH=/data/app.db

EXPOSE 7504

CMD ["node", "./dist/server/entry.mjs"]
