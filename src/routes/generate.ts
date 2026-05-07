import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Session } from "../models/Session";
import { Wallet } from "../models/Wallet";
import { runGenerate, getScriptsDir, isRunning } from "../lib/runner";
import { requireAuth } from "../middleware/requireAuth";
import { requirePlan } from "../middleware/requirePlan";
import { recordSessionAudit } from "../lib/sessionAudit";

const router = Router();

// POST /api/generate — spawn generate-wallets.ts
router.post("/", requireAuth, requirePlan, async (req: Request, res: Response) => {
  try {
    const { sessionId, privateKey } = req.body as { sessionId: string; privateKey?: string };

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!session.userId || session.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (isRunning(sessionId)) {
      return res.status(409).json({ error: "Generation already running for this session" });
    }

    await Session.findByIdAndUpdate(sessionId, { status: "generating", startedAt: new Date() });
    await Wallet.deleteMany({ sessionId });
    await recordSessionAudit({
      userId: req.user!._id,
      sessionId,
      action: "GENERATE_STARTED",
      message: "Wallet generation started",
      details: { totalWallets: session.totalWallets },
    });

    runGenerate(
      sessionId,
      { privateKey, tokenAddress: session.tokenAddress, multisenderAddress: session.multisenderAddress, totalWallets: session.totalWallets },
      async (count) => {
        await Session.findByIdAndUpdate(sessionId, { sentCount: count });
      },
      async (mnemonic) => {
        // Store mnemonic and import wallets from the CSV the script wrote
        await Session.findByIdAndUpdate(sessionId, {
          status: "idle",
          masterMnemonic: mnemonic,
        });

        const csvPath = path.join(getScriptsDir(), "output", "wallets.csv");
        if (fs.existsSync(csvPath)) {
          const content = fs.readFileSync(csvPath, "utf8");
          const lines = content.trim().split("\n").slice(1); // skip header
          const docs = lines.map((line) => {
            const [idx, address, , derivationPath] = line.split(",");
            return {
              sessionId,
              index: parseInt(idx, 10),
              address: address ?? "",
              derivationPath: derivationPath?.trim() ?? "",
              amount: 0,
              amountWei: "0",
              packedHex: "0x",
              sent: false,
              failed: false,
            };
          }).filter((d) => d.address);

          const chunkSize = 1000;
          for (let i = 0; i < docs.length; i += chunkSize) {
            await Wallet.insertMany(docs.slice(i, i + chunkSize), { ordered: false });
          }
        }

        await Session.findByIdAndUpdate(sessionId, { status: "idle" });
        await recordSessionAudit({
          userId: req.user!._id,
          sessionId,
          action: "GENERATE_COMPLETED",
          message: "Wallet generation completed",
          details: { importedWallets: session.totalWallets },
        });
      },
      async (err) => {
        console.error("[generate] error:", err);
        await Session.findByIdAndUpdate(sessionId, { status: "error" });
        await recordSessionAudit({
          userId: req.user!._id,
          sessionId,
          action: "GENERATE_FAILED",
          message: "Wallet generation failed",
          details: { error: String(err) },
        });
      }
    );

    return res.json({ status: "started", sessionId });
  } catch (err) {
    console.error("[generate POST]", err);
    return res.status(500).json({ error: "Failed to start generation" });
  }
});

export default router;
