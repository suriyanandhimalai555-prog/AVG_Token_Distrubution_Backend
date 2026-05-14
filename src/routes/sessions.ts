import { Router, Request, Response } from "express";
import { Session } from "../models/Session";
import { Batch } from "../models/Batch";
import { Wallet } from "../models/Wallet";
import { requireAuth } from "../middleware/requireAuth";
import { Subscription } from "../models/Subscription";
import { isRunning } from "../lib/runner";
import { recordSessionAudit } from "../lib/sessionAudit";
import { SessionAudit } from "../models/SessionAudit";

const router = Router();
router.use(requireAuth);

// POST /api/sessions — create a new session
router.post("/", async (req: Request, res: Response) => {
  try {
    const isAdmin = req.user?.role === "ADMIN";
    const sub = isAdmin
      ? null
      : await Subscription.findOne({ userId: req.user!._id, status: "ACTIVE" });
    if (!isAdmin && !sub) {
      return res.status(403).json({ error: "No active plan", code: "NO_ACTIVE_PLAN" });
    }

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

    if (!isAdmin && (!Number.isFinite(totalWallets) || totalWallets > (sub?.walletLimit ?? 0))) {
      return res.status(403).json({
        error: `Your plan allows max ${sub?.walletLimit ?? 0} wallets.`,
      });
    }

    const session = await Session.create({
      userId: req.user!._id,
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

    await recordSessionAudit({
      userId: req.user!._id,
      sessionId: session._id.toString(),
      action: "SESSION_CREATED",
      message: "Session created from setup",
      details: {
        network,
        totalWallets,
        tokenAddress,
        tokenName,
        multisenderAddress,
      },
    });

    return res.status(201).json({ sessionId: session._id.toString(), session });
  } catch (err) {
    console.error("[sessions POST]", err);
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions — list all sessions (most recent first)
router.get("/", async (req: Request, res: Response) => {
  try {
    const sessions = await Session.find({ userId: req.user!._id }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ sessions });
  } catch (err) {
    console.error("[sessions GET]", err);
    return res.status(500).json({ error: "Failed to list sessions" });
  }
});

// GET /api/sessions/history — audit timeline for this user
router.get("/history", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) ?? "200", 10)));
    const audits = await SessionAudit.find({ userId: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ audits });
  } catch (err) {
    console.error("[sessions/history GET]", err);
    return res.status(500).json({ error: "Failed to load session history" });
  }
});

// GET /api/sessions/:id — single session with batch + wallet counts
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const session = await Session.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!session.userId || session.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

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
    const existing = await Session.findById(req.params.id).lean();
    if (!existing || !existing.userId || existing.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: "Cannot update setup while process is running. Stop first." });
    }

    const patch = req.body as Partial<{
      totalWallets: number;
      network: "bscMainnet" | "bscTestnet";
      tokenAddress: string;
      tokenName: string;
      multisenderAddress: string;
    }>;

    const nextTotalWallets = patch.totalWallets ?? existing.totalWallets;
    if (!Number.isFinite(nextTotalWallets) || nextTotalWallets < 1 || nextTotalWallets > 100_000) {
      return res.status(400).json({ error: "totalWallets must be between 1 and 100,000" });
    }

    const isAdmin = req.user?.role === "ADMIN";
    if (!isAdmin) {
      const sub = await Subscription.findOne({ userId: req.user!._id, status: "ACTIVE" });
      if (!sub) {
        return res.status(403).json({ error: "No active plan", code: "NO_ACTIVE_PLAN" });
      }
      if (nextTotalWallets > sub.walletLimit) {
        return res.status(403).json({ error: `Your plan allows max ${sub.walletLimit} wallets.` });
      }
    }

    const setupChanged =
      (patch.totalWallets !== undefined && patch.totalWallets !== existing.totalWallets) ||
      (patch.network !== undefined && patch.network !== existing.network) ||
      (patch.tokenAddress !== undefined && patch.tokenAddress !== existing.tokenAddress) ||
      (patch.multisenderAddress !== undefined && patch.multisenderAddress !== existing.multisenderAddress);

    /** Same setup fields but session already finished (or stopped/errored) — must wipe run data or UI keeps old wallets/progress. */
    const terminalRun = existing.status === "done" || existing.status === "stopped" || existing.status === "error";
    const shouldResetRunData = setupChanged || terminalRun;

    if (shouldResetRunData) {
      await Promise.all([
        Wallet.deleteMany({ sessionId: req.params.id }),
        Batch.deleteMany({ sessionId: req.params.id }),
      ]);
      Object.assign(patch, {
        status: "idle",
        sentCount: 0,
        failedCount: 0,
        bnbSpent: 0,
        startedAt: undefined,
        completedAt: undefined,
        masterMnemonic: undefined,
      });
    }

    const session = await Session.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!session) return res.status(404).json({ error: "Session not found" });

    await recordSessionAudit({
      userId: req.user!._id,
      sessionId: req.params.id,
      action: shouldResetRunData ? "SESSION_SETUP_UPDATED" : "SESSION_UPDATED",
      message: shouldResetRunData
        ? setupChanged
          ? "Setup fields changed; run data reset"
          : "New run after completed/stopped/error; run data reset"
        : "Session metadata updated",
      details: {
        updatedFields: Object.keys(req.body ?? {}),
        setupChanged,
        terminalRun,
      },
    });

    return res.json({ session });
  } catch (err) {
    console.error("[sessions/:id PATCH]", err);
    return res.status(500).json({ error: "Failed to update session" });
  }
});

// DELETE /api/sessions/:id — delete one session and related data
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await Session.findById(req.params.id).lean();
    if (!existing || !existing.userId || existing.userId.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: "Cannot delete while distribution is running. Stop it first." });
    }

    await Promise.all([
      Wallet.deleteMany({ sessionId: req.params.id }),
      Batch.deleteMany({ sessionId: req.params.id }),
      Session.deleteOne({ _id: req.params.id }),
    ]);

    await recordSessionAudit({
      userId: req.user!._id,
      sessionId: req.params.id,
      action: "SESSION_DELETED",
      message: "Session deleted by user",
      details: {
        snapshot: {
          status: existing.status,
          totalWallets: existing.totalWallets,
          sentCount: existing.sentCount,
          failedCount: existing.failedCount,
          bnbSpent: existing.bnbSpent,
          network: existing.network,
          tokenAddress: existing.tokenAddress,
          tokenName: existing.tokenName,
        },
      },
    });

    return res.json({ success: true, deletedSessionId: req.params.id });
  } catch (err) {
    console.error("[sessions/:id DELETE]", err);
    return res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
