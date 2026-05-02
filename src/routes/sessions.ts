import { Router, Request, Response } from "express";
import { Session } from "../models/Session";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";

const router = Router();

// POST /api/sessions — create a new session
router.post("/", async (req: Request, res: Response) => {
  try {
    const { totalWallets, network, tokenAddress, tokenName, multisenderAddress } = req.body as {
      totalWallets: number;
      network: "bscMainnet" | "bscTestnet";
      tokenAddress: string;
      tokenName: string;
      multisenderAddress: string;
    };

    if (!Number.isFinite(totalWallets) || totalWallets < 1) {
      return res.status(400).json({ error: "totalWallets must be ≥ 1" });
    }
    if (totalWallets > 100_000) {
      return res.status(400).json({ error: "totalWallets must be ≤ 100,000" });
    }
    if (!network || !["bscMainnet", "bscTestnet"].includes(network)) {
      return res.status(400).json({ error: "network must be bscMainnet or bscTestnet" });
    }
    if (!tokenAddress) return res.status(400).json({ error: "tokenAddress is required" });
    if (!tokenName) return res.status(400).json({ error: "tokenName is required" });
    if (!multisenderAddress) return res.status(400).json({ error: "multisenderAddress is required" });

    const session = await Session.create({
      totalWallets,
      network,
      tokenAddress,
      tokenName,
      multisenderAddress,
      status: "idle",
      sentCount: 0,
      failedCount: 0,
      bnbSpent: 0,
    });

    return res.status(201).json({ sessionId: session._id.toString(), session });
  } catch (err) {
    console.error("[sessions POST]", err);
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions — list all sessions (most recent first)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const sessions = await Session.find().sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ sessions });
  } catch (err) {
    console.error("[sessions GET]", err);
    return res.status(500).json({ error: "Failed to list sessions" });
  }
});

// GET /api/sessions/:id — single session with batch + wallet counts
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const session = await Session.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    const [batchCount, walletCount] = await Promise.all([
      Batch.countDocuments({ sessionId: req.params.id }),
      Wallet.countDocuments({ sessionId: req.params.id }),
    ]);

    return res.json({ session, batchCount, walletCount });
  } catch (err) {
    console.error("[sessions/:id GET]", err);
    return res.status(500).json({ error: "Failed to get session" });
  }
});

// PATCH /api/sessions/:id — partial update
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const session = await Session.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!session) return res.status(404).json({ error: "Session not found" });
    return res.json({ session });
  } catch (err) {
    console.error("[sessions/:id PATCH]", err);
    return res.status(500).json({ error: "Failed to update session" });
  }
});

export default router;
