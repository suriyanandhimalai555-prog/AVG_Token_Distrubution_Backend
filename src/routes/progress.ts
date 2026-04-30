import { Router, Request, Response } from "express";
import { addSseClient, removeSseClient } from "../lib/runner";

const router = Router();

// GET /api/progress?sessionId=xxx — SSE stream
router.get("/", (req: Request, res: Response) => {
  const { sessionId } = req.query as { sessionId: string };

  if (!sessionId) {
    res.status(400).json({ error: "sessionId query param required" });
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send a heartbeat immediately
  res.write(": connected\n\n");

  // Register client
  addSseClient(sessionId, res);

  // Heartbeat every 20s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSseClient(sessionId, res);
  });
});

export default router;
