import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Session } from "../models/Session";
import { Wallet } from "../models/Wallet";
import { runPrepare, getScriptsDir, isRunning } from "../lib/runner";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";
import { recordSessionAudit } from "../lib/sessionAudit";

const router = Router();

// POST /api/prepare — spawn prepare-distribution.ts
router.post("/", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!session.userId || session.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (isRunning(sessionId)) {
      return res.status(409).json({ error: "A process is already running for this session" });
    }

    await Session.findByIdAndUpdate(sessionId, { status: "preparing" });
    await recordSessionAudit({
      userId: req.user!._id,
      sessionId,
      action: "PREPARE_STARTED",
      message: "Distribution planning started",
      details: { totalWallets: session.totalWallets },
    });

    runPrepare(
      sessionId,
      { totalWallets: session.totalWallets },
      async (totalTokens, batchCount) => {
        // Read the distribution-plan.json that the script wrote and sync amounts to MongoDB
        const planPath = path.join(getScriptsDir(), "output", "distribution-plan.json");
        if (fs.existsSync(planPath)) {
          const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Array<{
            index: number;
            address: string;
            amount: number;
            amountWei: string;
            packedHex: string;
            sent: boolean;
          }>;

          const ops = plan.map((entry) => ({
            updateOne: {
              filter: { sessionId, index: entry.index },
              update: {
                $set: {
                  amount: entry.amount,
                  amountWei: entry.amountWei,
                  packedHex: entry.packedHex,
                  sent: entry.sent,
                  failed: false,
                  failureReason: undefined,
                  address: entry.address,
                },
              },
              upsert: true,
            },
          }));

          const chunkSize = 500;
          for (let i = 0; i < ops.length; i += chunkSize) {
            await Wallet.bulkWrite(ops.slice(i, i + chunkSize));
          }
        }

        await Session.findByIdAndUpdate(sessionId, { status: "idle" });
        await recordSessionAudit({
          userId: req.user!._id,
          sessionId,
          action: "PREPARE_COMPLETED",
          message: "Distribution planning completed",
          details: { totalTokens, batchCount },
        });
        console.log(`[prepare] done. tokens=${totalTokens}, batches=${batchCount}`);
      },
      async (err) => {
        console.error("[prepare] error:", err);
        await Session.findByIdAndUpdate(sessionId, { status: "error" });
        await recordSessionAudit({
          userId: req.user!._id,
          sessionId,
          action: "PREPARE_FAILED",
          message: "Distribution planning failed",
          details: { error: String(err) },
        });
      }
    );

    return res.json({ status: "started", sessionId });
  } catch (err) {
    console.error("[prepare POST]", err);
    return res.status(500).json({ error: "Failed to start preparation" });
  }
});

export default router;
