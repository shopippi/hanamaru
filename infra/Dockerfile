# 本番・検証環境のイメージ。リポジトリの直下から:
#   docker build -f infra/Dockerfile --target api -t hanamaru-api .
#   docker build -f infra/Dockerfile --target web -t hanamaru-web .

FROM node:22.22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# 画面（静的ファイル）。Turnstile のサイトキーは公開してよい値
ARG VITE_TURNSTILE_SITE_KEY=""
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
# 利用規約のページ（公開トップに置く）。入会画面からリンクする
ARG VITE_TERMS_URL=""
ENV VITE_TERMS_URL=$VITE_TERMS_URL
RUN pnpm --filter @hanamaru/student --filter @hanamaru/staff --filter @hanamaru/manage build
RUN pnpm --filter @hanamaru/api deploy --prod --legacy /out/api

# --- API ---------------------------------------------------------------------
FROM node:22.22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]

# --- 画面と振り分け（Caddy） ---------------------------------------------------
FROM caddy:2.10-alpine AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/student/dist /srv/student
COPY --from=build /repo/apps/staff/dist /srv/staff
COPY --from=build /repo/apps/manage/dist /srv/manage
