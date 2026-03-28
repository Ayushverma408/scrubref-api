# scrubref-api

ScrubRef backend API. Sits between the Next.js frontend and the RAG pipeline — handles auth verification, thread/message persistence, quota enforcement, and SSE proxying.

## Stack

- Express 4, TypeScript
- Prisma ORM with PostgreSQL (hosted on Supabase)
- Supabase for JWT verification
- express-rate-limit for IP-level rate limiting

## Running locally

```bash
npm install
npm run dev        # ts-node-dev with hot reload, port 3001

# or production
npm run build
npm start
```

## Environment variables

Create a `.env` file:

```
DATABASE_URL=postgresql://...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=
RAG_API_URL=http://localhost:8000
PORT=3001
FRONTEND_URL=http://localhost:3000   # CORS allowed origin
```

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | No | Liveness check |
| GET | `/threads` | Yes | List user's threads |
| POST | `/threads` | Yes | Create a thread |
| GET | `/threads/:id` | Yes | Get thread + messages |
| DELETE | `/threads/:id` | Yes | Delete thread |
| POST | `/query/stream` | Yes | SSE: proxy to RAG, save messages |
| GET | `/query/usage` | Yes | Current daily + monthly usage |
| GET | `/page/:collection/:pageNum` | No | Proxy to RAG PDF page renderer |
| GET | `/images/:path*` | No | Proxy to RAG image server |

## Auth

All protected routes require `Authorization: Bearer <supabase_jwt>`. The `requireAuth` middleware calls `supabase.auth.getUser(token)` to verify the JWT and sets `req.userId` for downstream handlers.

## Quota system

Free tier: 30 queries/day, 100 queries/month.

Usage is tracked in `query_usage` with a dual-key pattern — one row per `(userId, YYYY-MM-DD)` for daily counts, one per `(userId, YYYY-MM)` for monthly counts. The `UserQuota` table stores per-user overrides; absent overrides fall back to the global free defaults.

Quota is checked and incremented atomically at the start of each `/query/stream` request. If either limit is exceeded, the request is rejected with HTTP 429 before the RAG backend is contacted.

## SSE proxy

`POST /query/stream` forwards the request to the RAG API and pipes events directly to the client in real time. On stream end, it parses the final `phase=done` event and saves the assistant message to the database with chunk references and latency.

## Thread auto-titling

When a thread's first message is sent, the title is set to the first 6 words of the question (truncated with `…` if the question is longer).

## Database schema

Managed with Prisma. Key models:

- `Thread` — belongs to a user, has many messages
- `Message` — role (`user`|`assistant`), content, optional `chunkRefs` JSON, latency
- `QueryUsage` — (userId, day) composite key; day is `YYYY-MM-DD` or `YYYY-MM`
- `UserQuota` — per-user limit overrides
- `Subscription` — Razorpay subscription state (inactive by default)

```bash
npm run db:migrate    # run pending migrations
npm run db:studio     # Prisma Studio at localhost:5555
npm run db:push       # push schema changes without migration (dev only)
```

## Rate limiting

- Global: 120 requests/min per IP across all routes
- `/query/stream`: 20 requests/min per IP (in addition to quota checks above)
