FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer-cached unless package files change)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Railway injects $PORT at runtime — we don't hardcode it here
EXPOSE 8080

CMD ["node", "server.js"]
