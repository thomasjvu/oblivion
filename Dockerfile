FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY docs ./docs
COPY public ./public
COPY src ./src

EXPOSE 8080

CMD ["node", "--import", "tsx", "src/server.ts"]
