FROM node:22-alpine
WORKDIR /app

# Install native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]
