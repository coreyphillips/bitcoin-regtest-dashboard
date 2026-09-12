FROM node:20-alpine

WORKDIR /app

# Ensure app directory is owned by the node user (uid 1000)
RUN chown -R node:node /app

# Install dependencies first so this layer stays cached across source changes
COPY --chown=node:node backend/package*.json ./
RUN npm ci --omit=dev

# Copy the whole backend, not just server.js: the app is split across
# lib/ and routes/ and would fail at boot with MODULE_NOT_FOUND otherwise.
COPY --chown=node:node backend/ ./

# Copy frontend files
COPY --chown=node:node frontend/ ./frontend/

# Switch to non-root user (node user has uid 1000)
USER node

EXPOSE 3000

CMD ["node", "server.js"]
