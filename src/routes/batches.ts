import { Router, Request, Response } from "express";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";

const router = Router();

// GET /api/batches?sessionId=&skip=&limit=
router.get("/", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    const skip = parseInt((req.query.skip as string) ?? "0", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

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
router.get("/wallets", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    const skip = parseInt((req.query.skip as string) ?? "0", 10);
    const limit = parseInt((req.query.limit as string) ?? "50", 10);

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const [wallets, total] = await Promise.all([
      Wallet.find({ sessionId }).sort({ index: 1 }).skip(skip).limit(limit).lean(),
      Wallet.countDocuments({ sessionId }),
    ]);

    return res.json({ wallets, total });
  } catch (err) {
    console.error("[batches/wallets GET]", err);
    return res.status(500).json({ error: "Failed to get wallets" });
  }
});

// GET /api/batches/wallets/summary?sessionId=
router.get("/wallets/summary", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

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
