import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import http from "http";

const router = Router();

const FREE_DAILY_LIMIT = 30;
const FREE_MONTHLY_LIMIT = 100;

const QuerySchema = z.object({
  question:             z.string().min(1).max(2000),
  threadId:             z.string().uuid(),
  freeMode:             z.boolean().optional().default(false),
  useHyde:              z.boolean().optional().default(true),
  profilePrompt:        z.string().optional().default(""),
  answerDepth:          z.string().optional().default("balanced"),
  answerTone:           z.string().optional().default("teaching"),
  answerRestrictiveness: z.string().optional().default("guided"),
});

router.post("/stream", requireAuth, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { question, threadId, freeMode, useHyde, profilePrompt, answerDepth, answerTone, answerRestrictiveness } = parsed.data;
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const thisMonth = today.slice(0, 7);                    // YYYY-MM

  // Upsert thread — if query arrives before POST /threads completes (race condition),
  // create it now so the query can proceed without failing.
  const thread = await prisma.thread.upsert({
    where: { id: threadId },
    create: { id: threadId, userId: req.userId },
    update: {},
  });
  if (thread.userId !== req.userId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // Fetch per-user quota overrides (null = use global defaults)
  const userQuota = await prisma.userQuota.findUnique({ where: { userId: req.userId } });
  const dailyLimit   = userQuota?.dailyLimitOverride   ?? FREE_DAILY_LIMIT;
  const monthlyLimit = userQuota?.monthlyLimitOverride ?? FREE_MONTHLY_LIMIT;

  // Daily rate limit
  const dailyUsage = await prisma.queryUsage.upsert({
    where:  { userId_day: { userId: req.userId, day: today } },
    update: {},
    create: { userId: req.userId, day: today, count: 0 },
  });
  if (dailyUsage.count >= dailyLimit) {
    res.status(429).json({ error: "Daily limit reached", limit: dailyLimit, reset: "tomorrow" });
    return;
  }

  // Monthly rate limit
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
    data: { threadId, role: "user", content: question },
  });

  // Auto-title thread on first message
  if (!thread.title || thread.title === "New conversation") {
    const words = question.trim().split(/\s+/).slice(0, 6).join(" ");
    const title = words.length < question.trim().length ? words + "…" : words;
    await prisma.thread.update({ where: { id: threadId }, data: { title } });
  }

  // Increment daily and monthly usage
  await prisma.queryUsage.update({
    where: { userId_day: { userId: req.userId, day: today } },
    data:  { count: { increment: 1 } },
  });
  await prisma.queryUsage.update({
    where: { userId_day: { userId: req.userId, day: thisMonth } },
    data:  { count: { increment: 1 } },
  });

  // SSE headers — X-Accel-Buffering: no tells Cloudflare/nginx not to buffer
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const ragUrl = new URL(`${process.env.RAG_API_URL}/query/stream`);
  const startTime = Date.now();

  // Accumulate SSE buffer to parse events
  let sseBuffer = "";
  let finalAnswer = "";
  let chunkRefs: { page: number; source: string; collection: string }[] = [];
  let latencyMs = 0;
  let pipeline = freeMode ? "free_mode" : "multi_book_hyde";

  const ragReq = http.request(
    {
      hostname: ragUrl.hostname,
      port: Number(ragUrl.port) || 8000,
      path: ragUrl.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    (ragRes) => {
      ragRes.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        res.write(text); // proxy immediately to frontend

        // Parse SSE events to extract final answer
        sseBuffer += text;
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(6));
            if (data.phase === "done") {
              finalAnswer = data.answer ?? "";
              pipeline = data.pipeline ?? pipeline;
              latencyMs = Math.round((data.latency_total_s ?? 0) * 1000);
              chunkRefs = (data.chunks ?? []).map((c: any) => ({
                page:       c.page,
                source:     c.source,
                collection: c.collection,
              }));
            }
          } catch {
            // malformed event — ignore
          }
        }
      });

      ragRes.on("end", async () => {
        if (!finalAnswer) {
          finalAnswer = "(No answer received from pipeline)";
          latencyMs = Date.now() - startTime;
        }

        // Ensure thread exists — race-safe for optimistic thread creation
        await prisma.thread.upsert({
          where:  { id: threadId },
          update: {},
          create: { id: threadId, userId: req.userId!, title: "New conversation" },
        });
        await prisma.message.create({
          data: {
            threadId,
            role:          "assistant",
            content:       finalAnswer,
            pipeline,
            chunkRefs:     chunkRefs.length ? chunkRefs : undefined,
            latencyTotalMs: latencyMs,
          },
        });

        res.end();
      });
    }
  );

  ragReq.on("error", (err) => {
    console.error("RAG API error:", err);
    res.write(`data: {"phase":"error","msg":"RAG API unavailable"}\n\n`);
    res.end();
  });

  ragReq.write(
    JSON.stringify({
      question,
      free_mode: freeMode,
      use_hyde: useHyde,
      profile_prompt: profilePrompt,
      answer_depth: answerDepth,
      answer_tone: answerTone,
      answer_restrictiveness: answerRestrictiveness,
    })
  );
  ragReq.end();
});

/**
 * GET /query/usage
 * Returns the logged-in user's current daily and monthly query usage.
 */
router.get("/usage", requireAuth, async (req: Request, res: Response) => {
  const today      = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const thisMonth  = today.slice(0, 7);                      // YYYY-MM

  // Determine the first day of next month for the monthly reset date
  const [year, month] = thisMonth.split("-").map(Number);
  const nextMonthDate  = new Date(year, month, 1); // month is 0-indexed in Date constructor, so `month` (1-indexed) is already +1
  const nextMonthStr   = nextMonthDate.toISOString().slice(0, 10);

  // Tomorrow's date for the daily reset
  const tomorrowDate = new Date(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  const [userQuota, dailyRow, monthlyRow] = await Promise.all([
    prisma.userQuota.findUnique({ where: { userId: req.userId } }),
    prisma.queryUsage.findUnique({ where: { userId_day: { userId: req.userId, day: today } } }),
    prisma.queryUsage.findUnique({ where: { userId_day: { userId: req.userId, day: thisMonth } } }),
  ]);

  const dailyLimit   = userQuota?.dailyLimitOverride   ?? FREE_DAILY_LIMIT;
  const monthlyLimit = userQuota?.monthlyLimitOverride ?? FREE_MONTHLY_LIMIT;

  res.json({
    daily: {
      used:  dailyRow?.count   ?? 0,
      limit: dailyLimit,
      reset: tomorrowStr,
    },
    monthly: {
      used:  monthlyRow?.count ?? 0,
      limit: monthlyLimit,
      reset: nextMonthStr,
    },
  });
});

export default router;
