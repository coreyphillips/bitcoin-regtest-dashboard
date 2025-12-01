FROM node:20-alpine

WORKDIR /app

# Copy backend files
COPY backend/package*.json ./
RUN npm install --production

COPY backend/server.js ./

# Copy frontend files
COPY frontend/ ./frontend/

EXPOSE 3000

CMD ["node", "server.js"]
