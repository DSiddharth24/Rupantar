FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer-cached unless package files change)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
