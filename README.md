# PlenkaCover

Исходный код «Плёнки Контур», развернутый на VPS 24.09.2026.

- Backend: `apps/api`, `apps/gateway-agent`, `packages/contracts` — коммит `590a5f19fd7ed3e4b04bd29cd0ffbdd6e0877c2f`.
- Рабочий frontend: `frontend-siemens` — коммит `eecd93821f45d1268b6e0d55989545137eef2fb9`.

## Проверка

```bash
npm ci
npm run build
npm test
npm run lint

cd frontend-siemens
npm ci
npm run build
npm test
```

Инструкции по запуску и развертыванию backend находятся в `deploy/vps/` и `docs/operations/vps-pilot-runbook.md`. Примеры переменных окружения есть в `.env.example` и `apps/api/.env.example`; рабочие секреты не входят в репозиторий.
