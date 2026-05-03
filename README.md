# TX ELECTRONICS

Monorepo for a Telegram bot backend (Node/Fastify/Telegraf), a Telegram WebApp (Vite + React), and PostgreSQL.

## Structure
- `backend/` Node.js API + Telegram bot
- `webapp/` Telegram WebApp (Vite)
- `docker-compose.yml` Orchestrates all services

## Requirements
- Docker + Docker Compose

## VPS quick start
1) Copy `.env.example` to `.env` and set real values.
2) Build and start everything:
```
docker compose up -d --build
```
3) Check logs:
```
docker compose logs -f --tail=200
```

## Update on VPS
Pull latest changes and restart:
```
/opt/update.sh
```

## Local dev (optional)
You can still run services locally without Docker.

1) Backend
```
cd backend
npm install
cp .env.example .env
npm run dev
```

2) WebApp
```
cd webapp
npm install
cp .env.example .env
npm run dev
```

## Notes
- Backend runs on `http://localhost:4000`
- WebApp runs on `http://localhost:5173`
- Postgres runs on `localhost:5432`
- Mosklad integration uses `MOSKLAD_TOKEN`
