import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import http from "http";

const router = Router();

const FREE_DAILY_LIMIT = 30;
const FREE_MONTHLY_LIMIT = 100;

const QuizSchema = z.object({
  topic:    z.string().min(1).max(500),
  count:    z.number().int().min(1).max(10).optional().default(5),
  threadId: z.string().uuid(),
});

router.post("/stream", requireAuth, async (req: Request, res: Response) => {
  const parsed = QuizSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { topic, count, threadId } = parsed.data;
  const today      = new Date().toISOString().slice(0, 10);
  const thisMonth  = today.slice(0, 7);

  const thread = await prisma.thread.upsert({
    where:  { id: threadId },
    create: { id: threadId, userId: req.userId },
    update: {},
  });
  if (thread.userId !== req.userId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // Quota — counts against the same daily/monthly limits as regular queries
  const userQuota = await prisma.userQuota.findUnique({ where: { userId: req.userId } });
  const dailyLimit   = userQuota?.dailyLimitOverride   ?? FREE_DAILY_LIMIT;
  const monthlyLimit = userQuota?.monthlyLimitOverride ?? FREE_MONTHLY_LIMIT;

  const dailyUsage = await prisma.queryUsage.upsert({
    where:  { userId_day: { userId: req.userId, day: today } },
    update: {},
    create: { userId: req.userId, day: today, count: 0 },
  });
  if (dailyUsage.count >= dailyLimit) {
    res.status(429).json({ error: "Daily limit reached", limit: dailyLimit, reset: "tomorrow" });
    return;
  }

  const monthlyUsage = await prisma.queryUsage.upsert({
    where:  { userId_day: { userId: req.userId, day: thisMonth } },
    update: {},
    create: { userId: req.userId, day: thisMonth, count: 0 },
  });
  if (monthlyUsage.count >= monthlyLimit) {
    res.status(429).json({ error: "Monthly limit reached", limit: monthlyLimit, reset: "next month" });
    return;
  }

  // Save user message
  await prisma.message.create({
    data: { threadId, role: "user", content: `Quiz: ${topic}` },
  });

  // Auto-title thread on first quiz
  if (!thread.title || thread.title === "New conversation") {
    await prisma.thread.update({
      where: { id: threadId },
      data:  { title: `Quiz: ${topic.slice(0, 45)}` },
    });
  }

  // Increment usage
  await Promise.all([
    prisma.queryUsage.update({
      where: { userId_day: { userId: req.userId, day: today } },
      data:  { count: { increment: 1 } },
    }),
    prisma.queryUsage.update({
      where: { userId_day: { userId: req.userId, day: thisMonth } },
      data:  { count: { increment: 1 } },
    }),
  ]);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const ragUrl     = new URL(`${process.env.RAG_API_URL}/quiz/stream`);
  const startTime  = Date.now();

  let sseBuffer  = "";
  let mcqs: any[] = [];
  let chunkRefs: { page: number; source: string; collection: string }[] = [];
  let latencyMs  = 0;

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
        const text = chunk.toString();
        res.write(text); // proxy immediately to frontend

        sseBuffer += text;
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(6));
            if (data.phase === "done") {
              mcqs      = data.mcqs ?? [];
              latencyMs = Math.round((data.latency_total_s ?? 0) * 1000);
              chunkRefs = (data.chunks ?? []).map((c: any) => ({
                page: c.page, source: c.source, collection: c.collection,
              }));
            }
          } catch { /* ignore malformed event */ }
        }
      });

      ragRes.on("end", async () => {
        latencyMs = latencyMs || Date.now() - startTime;

        await prisma.message.create({
          data: {
            threadId,
            role:           "assistant",
            content:        JSON.stringify(mcqs),
            pipeline:       "quiz",
            chunkRefs:      chunkRefs.length ? chunkRefs : undefined,
            latencyTotalMs: latencyMs,
          },
        });

        res.end();
      });
    }
  );

  ragReq.on("error", (err) => {
    console.error("RAG API error (quiz):", err);
    res.write(`data: {"phase":"error","msg":"RAG API unavailable"}\n\n`);
    res.end();
  });

  ragReq.write(JSON.stringify({ topic, count }));
  ragReq.end();
});

export default router;
