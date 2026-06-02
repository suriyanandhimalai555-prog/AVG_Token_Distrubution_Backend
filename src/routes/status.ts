import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { Session } from "../models/Session";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";
import { isRunning } from "../lib/runner";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// GET /api/status?sessionId=xxx — live session status (read-only; auth only)
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!session.userId || session.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    const [batchCount, confirmedBatches, failedBatches, sentWallets, failedWallets, confirmedBatchAgg] = await Promise.all([
      Batch.countDocuments({ sessionId }),
      Batch.countDocuments({ sessionId, status: "confirmed" }),
      Batch.countDocuments({ sessionId, status: "failed" }),
      Wallet.countDocuments({ sessionId, sent: true }),
      Wallet.countDocuments({ sessionId, sent: { $ne: true }, failed: true }),
      Batch.aggregate<{ total: number }>([
        { $match: { sessionId, status: "confirmed" } },
        { $group: { _id: null, total: { $sum: "$walletCount" } } },
      ]),
    ]);

    // Session counters and wallet sync can be stale after restart/stop.
    // Use the highest trustworthy source for sent count:
    // 1) wallet docs marked sent
    // 2) sum(walletCount) of confirmed batches
    const sentFromBatches = Number(confirmedBatchAgg?.[0]?.total ?? 0);
    const derivedSentCount = Math.max(sentWallets, sentFromBatches);

    // For stopped/error/done sessions, remaining wallets are effectively failed
    // if wallet-level failure sync has not completed yet.
    const derivedFailedCount =
      session.status === "stopped" || session.status === "error" || session.status === "done"
        ? Math.max(0, session.totalWallets - derivedSentCount)
        : failedWallets;

    return res.json({
      sessionId,
      status: session.status,
      totalWallets: session.totalWallets,
      sentCount: derivedSentCount,
      failedCount: derivedFailedCount,
      bnbSpent: session.bnbSpent,
      batchCount,
      confirmedBatches,
      failedBatches,
      sentWallets: derivedSentCount,
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
