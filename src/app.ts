import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import "dotenv/config";

import threadsRouter from "./routes/threads";
import queryRouter from "./routes/query";
import quizRouter from "./routes/quiz";
import pagesRouter from "./routes/pages";
import imagesRouter from "./routes/images";
import demoRouter from "./routes/demo";

const app = express();

// Trust one hop of reverse proxy (Cloudflare/nginx) so req.ip resolves correctly
app.set("trust proxy", 1);

app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:3000" }));
app.use(express.json({ limit: "32kb" })); // reject oversized bodies

// Global rate limit — all routes: 120 req / 1 min per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});

// Strict limit on the expensive SSE query endpoint: 20 req / 1 min per IP
const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many queries, please wait a moment." },
});

app.use(globalLimiter);
app.use("/query/stream", queryLimiter);
app.use("/quiz/stream", queryLimiter);
app.use("/demo/stream", queryLimiter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/threads", threadsRouter);
app.use("/query", queryRouter);
app.use("/quiz", quizRouter);
app.use("/demo", demoRouter);
app.use("/page", pagesRouter);
app.use("/images", imagesRouter);

export default app;
