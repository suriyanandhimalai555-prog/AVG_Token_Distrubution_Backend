import { Router, Request, Response } from "express";
import { Session } from "../models/Session";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";
import { isRunning } from "../lib/runner";

const router = Router();

// GET /api/status?sessionId=xxx — live session status
router.get("/", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    const [batchCount, confirmedBatches, failedBatches, sentWallets] = await Promise.all([
      Batch.countDocuments({ sessionId }),
      Batch.countDocuments({ sessionId, status: "confirmed" }),
      Batch.countDocuments({ sessionId, status: "failed" }),
      Wallet.countDocuments({ sessionId, sent: true }),
    ]);

    return res.json({
      sessionId,
      status: session.status,
      totalWallets: session.totalWallets,
      sentCount: session.sentCount,
      failedCount: session.failedCount,
      bnbSpent: session.bnbSpent,
      batchCount,
      confirmedBatches,
      failedBatches,
      sentWallets,
      isRunning: isRunning(sessionId),
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    });
  } catch (err) {
    console.error("[status GET]", err);
    return res.status(500).json({ error: "Failed to get status" });
  }
});

export default router;
