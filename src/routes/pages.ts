import { Router } from "express";
import http from "http";

const router = Router();

// GET /page/:collection/:pageNum?highlight=...
// Proxies the RAG API's PDF page renderer — returns PNG.
// No auth required: page images contain only textbook content, no user data.
router.get("/:collection/:pageNum", async (req, res) => {
  const { collection, pageNum } = req.params;
  const highlight = req.query.highlight as string | undefined;

  const ragHost = process.env.RAG_API_URL?.replace("http://", "").split(":")[0] ?? "localhost";
  const ragPort = Number(process.env.RAG_API_URL?.split(":")[2] ?? 8000);

  const path = `/page/${collection}/${pageNum}${highlight ? `?highlight=${encodeURIComponent(highlight)}` : ""}`;

  const ragReq = http.request(
    { hostname: ragHost, port: ragPort, path, method: "GET" },
    (ragRes) => {
      if (ragRes.statusCode !== 200) {
        res.status(ragRes.statusCode ?? 500).json({ error: "Page not found" });
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=3600");
      ragRes.pipe(res);
    }
  );

  ragReq.on("error", () => res.status(502).json({ error: "RAG API unavailable" }));
  ragReq.end();
});

export default router;
