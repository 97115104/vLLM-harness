FROM node:22-alpine
WORKDIR /app

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3001
CMD ["node", "dist/index.js"]
