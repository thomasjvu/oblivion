FROM node:22-bookworm-slim@sha256:32b9e321f262db540d55ac10dc529667cf4737546e097cdd36a843c62bcbf423 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY config ./config
COPY spec ./spec
COPY public ./public
COPY scripts ./scripts
COPY src ./src

RUN npm run build:client && npm run build:fonts

FROM node:22-bookworm-slim@sha256:32b9e321f262db540d55ac10dc529667cf4737546e097cdd36a843c62bcbf423

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV TRUST_CENTER_PATH=/app/config/trust-center.json
ENV OBLIVION_EXECUTOR_MODE=record-only
ENV OBLIVION_DISABLE_PLAINTEXT_LOGS=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY spec ./spec
COPY src ./src
COPY --from=build /app/public ./public

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]