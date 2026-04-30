import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Session } from "../models/Session";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";
import { runDistribute, killProcess, getScriptsDir, isRunning } from "../lib/runner";

const router = Router();

// POST /api/distribute — spawn distribute.ts
router.post("/", async (req: Request, res: Response) => {
  try {
    const { sessionId, privateKey } = req.body as { sessionId: string; privateKey: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!privateKey) return res.status(400).json({ error: "privateKey is required" });

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (isRunning(sessionId)) {
      return res.status(409).json({ error: "Distribution already running for this session" });
    }

    await Session.findByIdAndUpdate(sessionId, {
      status: "distributing",
      startedAt: new Date(),
    });

    const selectedRpc =
      session.network === "bscTestnet"
        ? (process.env.BSC_TESTNET_RPC_URL || process.env.ALCHEMY_RPC_URL || "")
        : (process.env.ALCHEMY_RPC_URL || "");
    console.log(`[network] session=${sessionId} network=${session.network} rpc=${selectedRpc}`);

    runDistribute(
      sessionId,
      {
        privateKey,
        tokenAddress: session.tokenAddress,
        multisenderAddress: session.multisenderAddress,
        totalWallets: session.totalWallets,
        rpcUrl:
          session.network === "bscTestnet"
            ? (process.env.BSC_TESTNET_RPC_URL || process.env.ALCHEMY_RPC_URL)
            : process.env.ALCHEMY_RPC_URL,
        fallbackRpc1:
          session.network === "bscTestnet"
            ? (process.env.BSC_TESTNET_FALLBACK_RPC_1 || "https://data-seed-prebsc-1-s1.binance.org:8545")
            : process.env.FALLBACK_RPC_1,
        fallbackRpc2:
          session.network === "bscTestnet"
            ? (process.env.BSC_TESTNET_FALLBACK_RPC_2 || "https://data-seed-prebsc-2-s1.binance.org:8545")
            : process.env.FALLBACK_RPC_2,
      },
      async (batchIndex, _totalBatches, walletCount, txHash, gasUsed) => {
        await Batch.findOneAndUpdate(
          { sessionId, batchIndex },
          {
            $set: {
              sessionId,
              batchIndex,
              walletCount,
              txHash,
              gasUsed,
              status: "confirmed",
              confirmedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
      },
      async (sentCount, failedCount) => {
        await Session.findByIdAndUpdate(sessionId, { sentCount, failedCount });
      },
      async (bnbSpent) => {
        await Session.findByIdAndUpdate(sessionId, {
          status: "done",
          completedAt: new Date(),
          bnbSpent,
        });

        // Sync sent status from distribution-plan.json back into Wallet documents
        try {
          const planPath = path.join(getScriptsDir(), "output", "distribution-plan.json");
          if (fs.existsSync(planPath)) {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Array<{
              index: number;
              sent: boolean;
              txHash: string | null;
              timestamp: string | null;
            }>;
            const sentEntries = plan.filter((e) => e.sent);
            if (sentEntries.length > 0) {
              const ops = sentEntries.map((e) => ({
                updateOne: {
                  filter: { sessionId, index: e.index },
                  update: {
                    $set: {
                      sent: true,
                      txHash: e.txHash ?? undefined,
                      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
                    },
                  },
                },
              }));
              const chunkSize = 500;
              for (let i = 0; i < ops.length; i += chunkSize) {
                await Wallet.bulkWrite(ops.slice(i, i + chunkSize));
              }
            }
          }
        } catch (syncErr) {
          console.error("[distribute] wallet sync error:", syncErr);
        }
      },
      async (err) => {
        console.error("[distribute] error:", err);
        await Session.findByIdAndUpdate(sessionId, { status: "error" });
      }
    );

    return res.json({ status: "started", sessionId });
  } catch (err) {
    console.error("[distribute POST]", err);
    return res.status(500).json({ error: "Failed to start distribution" });
  }
});

// DELETE /api/distribute — kill running process
router.delete("/", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const killed = killProcess(sessionId);
    await Session.findByIdAndUpdate(sessionId, { status: "stopped" });

    return res.json({ status: "stopped", killed });
  } catch (err) {
    console.error("[distribute DELETE]", err);
    return res.status(500).json({ error: "Failed to stop distribution" });
  }
});

export default router;
