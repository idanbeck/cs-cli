# CS-CLI Game Server Dockerfile
# Multi-stage build for smaller production image

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Environment variables (with defaults)
ENV PORT=8080
ENV HUB_PORT=8081
ENV MAX_ROOMS=100
ENV SERVER_NAME="CS-CLI Server"
# PUBLIC_URL should be set at runtime (e.g., wss://game.example.com)

# Expose ports
EXPOSE 8080
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:8080', (r) => process.exit(r.statusCode === 426 ? 0 : 1)).on('error', () => process.exit(1))"

# Run the server
CMD ["node", "dist/index.js"]
