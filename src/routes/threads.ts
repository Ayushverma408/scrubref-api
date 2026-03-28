import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

// GET /threads — list all threads for the user
router.get("/", requireAuth, async (req, res) => {
  const threads = await prisma.thread.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
  res.json(threads);
});

// POST /threads — create a new thread
router.post("/", requireAuth, async (req, res) => {
  const thread = await prisma.thread.create({
    data: { userId: req.userId, title: "New conversation" },
  });
  res.status(201).json(thread);
});

// GET /threads/:id — get a thread with its messages
router.get("/:id", requireAuth, async (req, res) => {
  const thread = await prisma.thread.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  res.json(thread);
});

// DELETE /threads/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const thread = await prisma.thread.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  await prisma.thread.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
