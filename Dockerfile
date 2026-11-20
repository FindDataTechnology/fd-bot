# Builds the fd-bot image and publishes it on our own registry chain.
#
# Why a Dockerfile at all: the service is plain Node with three runtime deps, so
# the image is one `npm ci` and a copy. The base is a pinned Node major — an
# `alpine:latest` would silently change under a rebuild.
#
# The registry prefix is injected by CI (FD_BOT_IMAGE / FD_BOT_TAG) rather than
# hardcoded, so the same file builds locally without knowing our registry.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copy the manifests first so `npm ci` layer-caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations

# Runs unprivileged. The data dir is a PVC mounted at /data; create it owned by
# `node` so the acceptance queue is writable without root.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8791
# No shell form: signals must reach the node process directly, or SIGTERM
# shutdown (ordered: stop connections → drain deliveries → close the store)
# never runs and a rolling update kills in-flight deliveries.
CMD ["node", "src/index.js"]
