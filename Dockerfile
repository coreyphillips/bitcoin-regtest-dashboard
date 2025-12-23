FROM node:20-alpine

WORKDIR /app

# Ensure app directory is owned by the node user (uid 1000)
RUN chown -R node:node /app

# Copy backend files
COPY --chown=node:node backend/package*.json ./
RUN npm install --production

COPY --chown=node:node backend/server.js ./

# Copy frontend files
COPY --chown=node:node frontend/ ./frontend/

# Switch to non-root user (node user has uid 1000)
USER node

EXPOSE 3000

CMD ["node", "server.js"]
