import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import http from "http";

const router = Router();

const DEMO_DAILY_LIMIT = 5;

function getClientIp(req: Request): string {
  // Trust Express's req.ip (app.set('trust proxy', 1) enables X-Forwarded-For parsing)
  return req.ip ?? "unknown";
}

const DemoQuerySchema = z.object({
  question:              z.string().min(1).max(2000),
  answerDepth:           z.string().optional().default("balanced"),
  answerTone:            z.string().optional().default("teaching"),
  answerRestrictiveness: z.string().optional().default("guided"),
});

/**
 * GET /demo/usage
 * Returns this IP's demo usage for today.
 */
router.get("/usage", async (req: Request, res: Response) => {
  const ip  = getClientIp(req);
  const day = new Date().toISOString().slice(0, 10);

  const row = await prisma.demoUsage.findUnique({ where: { ip_day: { ip, day } } });
  const used = row?.count ?? 0;

  res.json({ used, limit: DEMO_DAILY_LIMIT, remaining: Math.max(0, DEMO_DAILY_LIMIT - used) });
});

/**
 * POST /demo/stream
 * Unauthenticated SSE proxy to the RAG backend.
 * Limited to DEMO_DAILY_LIMIT queries per IP per day.
 */
router.post("/stream", async (req: Request, res: Response) => {
  const parsed = DemoQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { question, answerDepth, answerTone, answerRestrictiveness } = parsed.data;
  const ip  = getClientIp(req);
  const day = new Date().toISOString().slice(0, 10);

  // Check / initialise daily usage
  const usage = await prisma.demoUsage.upsert({
    where:  { ip_day: { ip, day } },
    update: {},
    create: { ip, day, count: 0 },
  });

  if (usage.count >= DEMO_DAILY_LIMIT) {
    res.status(429).json({
      error:     "Demo limit reached",
      limit:     DEMO_DAILY_LIMIT,
      remaining: 0,
      reset:     "tomorrow",
    });
    return;
  }

  // Increment before streaming (debit-first — prevents concurrent over-use)
  await prisma.demoUsage.update({
    where: { ip_day: { ip, day } },
    data:  { count: { increment: 1 } },
  });

  const remaining = DEMO_DAILY_LIMIT - usage.count - 1;

  // SSE headers — X-Accel-Buffering: no tells Cloudflare/nginx not to buffer
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Demo-Remaining", String(remaining));
  res.flushHeaders();

  const ragUrl = new URL(`${process.env.RAG_API_URL}/query/stream`);

  const ragReq = http.request(
    {
      hostname: ragUrl.hostname,
      port:     Number(ragUrl.port) || 8000,
      path:     ragUrl.pathname,
      method:   "POST",
      headers:  { "Content-Type": "application/json" },
    },
    (ragRes) => {
      ragRes.on("data", (chunk: Buffer) => {
        res.write(chunk.toString());
      });
      ragRes.on("end", () => res.end());
    }
  );

  ragReq.on("error", (err) => {
    console.error("Demo RAG API error:", err);
    res.write(`data: {"phase":"error","msg":"RAG API unavailable"}\n\n`);
    res.end();
  });

  ragReq.write(
    JSON.stringify({
      question,
      free_mode:              false,
      use_hyde:               true,
      profile_prompt:         "",
      answer_depth:           answerDepth,
      answer_tone:            answerTone,
      answer_restrictiveness: answerRestrictiveness,
    })
  );
  ragReq.end();
});

export default router;
