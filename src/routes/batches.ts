import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";
import { Session } from "../models/Session";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";
import { assertSessionOwned } from "../lib/sessionAccess";
import { getScriptsDir } from "../lib/runner";

const router = Router();

// GET /api/batches?sessionId=&skip=&limit=
router.get("/", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    const skip = parseInt((req.query.skip as string) ?? "0", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const owns = await assertSessionOwned(sessionId, req.user!._id);
    if (!owns) return res.status(404).json({ error: "Session not found" });

    const [batches, total] = await Promise.all([
      Batch.find({ sessionId }).sort({ batchIndex: -1 }).skip(skip).limit(limit).lean(),
      Batch.countDocuments({ sessionId }),
    ]);

    return res.json({ batches, total });
  } catch (err) {
    console.error("[batches GET]", err);
    return res.status(500).json({ error: "Failed to get batches" });
  }
});

// GET /api/batches/wallets?sessionId=&skip=&limit=
router.get("/wallets", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    const skip = parseInt((req.query.skip as string) ?? "0", 10);
    const limit = parseInt((req.query.limit as string) ?? "50", 10);

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const owns = await assertSessionOwned(sessionId, req.user!._id);
    if (!owns) return res.status(404).json({ error: "Session not found" });

    const [wallets, total, session] = await Promise.all([
      Wallet.find({ sessionId }).sort({ index: 1 }).skip(skip).limit(limit).lean(),
      Wallet.countDocuments({ sessionId }),
      Session.findById(sessionId).lean(),
    ]);

    // Fallback sync from distribution-plan.json for older/stale sessions where
    // wallet documents were not fully updated.
    const planPath = path.join(getScriptsDir(), "output", "distribution-plan.json");
    const planByIndex = new Map<number, { sent: boolean; txHash?: string | null; timestamp?: string | null }>();
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Array<{
          index: number;
          sent: boolean;
          txHash?: string | null;
          timestamp?: string | null;
        }>;
        for (const p of plan) {
          planByIndex.set(p.index, p);
        }
      } catch {
        // ignore malformed plan file and fall back to DB fields
      }
    }

    const walletsResolved = wallets.map((w) => {
      const p = planByIndex.get(Number(w.index));
      const sentResolved = Boolean(w.sent || p?.sent || w.txHash || p?.txHash);
      const txHashResolved = w.txHash ?? p?.txHash ?? undefined;
      const timestampResolved = w.timestamp ?? (p?.timestamp ? new Date(p.timestamp) : undefined);
      const legacyPending = !sentResolved && w.failureReason === "Not sent yet";
      const failedResolved =
        sentResolved
          ? false
          : Boolean(
              (w.failed && !legacyPending) ||
              ((session?.status === "stopped" || session?.status === "error" || session?.status === "done") && !sentResolved)
            );
      const failureReasonResolved = sentResolved
        ? undefined
        : (legacyPending
          ? undefined
          : w.failureReason ??
          (session?.status === "stopped" ? "Stopped by user" : undefined) ??
          ((session?.status === "error" || session?.status === "done")
            ? "Failed to send (insufficient gas/BNB or batch failure)"
            : undefined));

      return {
        ...w,
        sent: sentResolved,
        txHash: txHashResolved,
        timestamp: timestampResolved,
        failed: failedResolved,
        failureReason: failureReasonResolved,
      };
    });

    return res.json({ wallets: walletsResolved, total });
  } catch (err) {
    console.error("[batches/wallets GET]", err);
    return res.status(500).json({ error: "Failed to get wallets" });
  }
});

// GET /api/batches/wallets/summary?sessionId=
router.get("/wallets/summary", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const owns = await assertSessionOwned(sessionId, req.user!._id);
    if (!owns) return res.status(404).json({ error: "Session not found" });

    const [stats] = await Wallet.aggregate([
      { $match: { sessionId } },
      {
        $group: {
          _id: null,
          totalWallets: { $sum: 1 },
          totalTokens: { $sum: "$amount" },
        },
      },
    ]);

    return res.json({
      totalWallets: Number(stats?.totalWallets ?? 0),
      totalTokens: Number(stats?.totalTokens ?? 0),
    });
  } catch (err) {
    console.error("[batches/wallets/summary GET]", err);
    return res.status(500).json({ error: "Failed to get wallets summary" });
  }
});

export default router;
