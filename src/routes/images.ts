import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import path from "path";
import fs from "fs";

const router = Router();

// Images are stored at advanced-rag-poc/data/images/<collection>/<filename>
const IMAGES_ROOT = path.resolve(__dirname, "../../../advanced-rag-poc/data/images");

// GET /images/:collection/:filename?token=<jwt>
// Images can't have Authorization headers from <img> tags, so we accept token as query param
router.get("/:collection/:filename", (req, res) => {
  const { collection, filename } = req.params;

  // Sanitise — no path traversal
  if (collection.includes("..") || filename.includes("..")) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  const filePath = path.join(IMAGES_ROOT, collection, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(filePath);
});

export default router;
