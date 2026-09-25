# CLAUDE.md

MCP server that exposes sms-backend to AI agents (compact, role-filtered tools; writes are drafted and confirmed by a human). Its only caller is sms-agent. See README.md for the tools and the human-in-the-loop design.

## Commands

```bash
npm run dev        # tsx watch, reads ./.env (local port 4020)
npm test           # vitest
npm run typecheck
npm run build      # tsc -> dist/
```

## Config

`src/env.ts` loads `./.env` if present (variables already in the environment win); `src/config.ts` reads it. Keys: see `.env.example`. `MCP_SHARED_SECRET` must equal `SMS_MCP_KEY` in sms-agent; every `/mcp` request without it gets 401. `/healthz` is open.

## Ports: local dev vs deployed (read before touching any port)

- Local: 4020 (`.env`, `helping-scripts/start.sh` in the workspace root). Never routed through the Cloudflare tunnel.
- Deployed: stage 3031, production 3030 — from SSM `MCP_PORT`. Always bound to `127.0.0.1`.
- **Never change deployed settings to match local**, and do not touch AWS (SSM, EC2) or stage/production unless the user explicitly asks for that action in the current conversation.

## Deployment

GitHub Actions `.github/workflows/deploy-ec2.yml`, same pattern as the other repos:

- Runs only on a push to `development` (stage, GitHub environment `development`) or `main` (production, repo-level secrets). No PR triggers; merging a PR is the push that deploys.
- Runner: `npm ci`, `npm test`, `npm run build`, then SCP `dist/`, `scripts/fetch-aws-ssm.mjs`, `package*.json`, `ecosystem.config.cjs` to `/home/deployer/sms-mcp-<env>/`.
- Server: `npm ci --omit=dev`, `node scripts/fetch-aws-ssm.mjs` writes `.env` from SSM `/sms-mcp/<env>/*` (instance role `ec2-ssm-role`), PM2 start/restart as `sms-mcp-<env>`, `pm2 save`, then the job fails unless `http://127.0.0.1:$MCP_PORT/healthz` answers.
- PM2: one fork-mode process (`ecosystem.config.cjs`, `max_memory_restart: 300M`). Logs are rotated by the server's `pm2-logrotate` module.
- **No public hostname and no nginx site**: sms-agent calls it on the same server at `http://127.0.0.1:<port>/mcp`. Publishing it would need `MCP_ALLOWED_HOSTS`.
- SSM `/sms-mcp/development/`: `SMS_API_URL=https://sms-dev-api.colegios.in` (use the backend's public domain, as the other services do), `MCP_HOST=127.0.0.1`, `MCP_PORT=3031`, `MCP_EXPOSE_CONFIRM_TOOL=false`, `MCP_CONTEXT_TTL_SECONDS`, `MCP_REQUEST_TIMEOUT_MS`, `MCP_SHARED_SECRET` (SecureString).
- Production (`/sms-mcp/production/`, port 3030, `SMS_API_URL=https://sms-api.colegios.in`) is not provisioned yet — set it up before the first push to `main`.
