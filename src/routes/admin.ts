import { Router } from "express";
import mongoose from "mongoose";
import { requireAdmin } from "../middleware/requireAdmin";
import { User } from "../models/User";
import { Subscription } from "../models/Subscription";
import { Payment } from "../models/Payment";

const router = Router();
router.use(requireAdmin);

router.get("/stats", async (_req, res) => {
  try {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const [
      totalUsers,
      activeSubscriptions,
      agg,
      tokenHolderCount,
      dexCount,
      paymentsToday,
    ] = await Promise.all([
      User.countDocuments(),
      Subscription.countDocuments({ status: "ACTIVE" }),
      Payment.aggregate([
        { $match: { status: "CONFIRMED" } },
        { $group: { _id: null, revenue: { $sum: "$amount" } } },
      ]),
      Subscription.countDocuments({ status: "ACTIVE", productLine: "TOKEN_HOLDER" }),
      Subscription.countDocuments({ status: "ACTIVE", productLine: "DEX_AUTOMATION" }),
      Payment.countDocuments({ createdAt: { $gte: startOfUtcDay } }),
    ]);

    const revenueUSD = Number(agg[0]?.revenue ?? 0);

    return res.json({
      totalUsers,
      activeSubscriptions,
      revenueUSD,
      tokenHolderCount,
      dexCount,
      paymentsToday,
    });
  } catch (err) {
    console.error("[admin stats]", err);
    return res.status(500).json({ error: "Failed to load stats" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const search = String(req.query.search ?? "").trim();

    const filter = search ? { email: { $regex: search, $options: "i" } } : {};

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    const ids = users.map((u) => u._id);
    const subs = await Subscription.find({ userId: { $in: ids } }).lean();
    const subByUser = new Map(subs.map((s) => [s.userId.toString(), s]));

    const out = users.map((u) => ({
      ...u,
      subscription: subByUser.get(u._id.toString()) ?? null,
    }));

    return res.json({ users: out, total, page, limit });
  } catch (err) {
    console.error("[admin users]", err);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    const { role, subscriptionStatus } = req.body as {
      role?: "USER" | "ADMIN";
      subscriptionStatus?: string;
    };
    const id = req.params.id;

    if (role === "USER" || role === "ADMIN") {
      if (role === "USER" && req.user!.role === "ADMIN" && id === req.user!._id.toString()) {
        return res.status(400).json({ error: "You cannot revoke your own ADMIN role via this endpoint" });
      }
      await User.findByIdAndUpdate(id, { role });
    }

    if (
      subscriptionStatus &&
      ["ACTIVE", "EXPIRED", "CANCELLED", "PENDING"].includes(subscriptionStatus)
    ) {
      await Subscription.findOneAndUpdate(
        { userId: new mongoose.Types.ObjectId(id) },
        { status: subscriptionStatus }
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[admin patch user]", err);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

router.get("/payments", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const status = String(req.query.status ?? "");

    const match: Record<string, unknown> = {};
    if (status && status !== "ALL") {
      match.status = status;
    }

    const [payments, total] = await Promise.all([
      Payment.find(match)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "email name")
        .lean(),
      Payment.countDocuments(match),
    ]);

    return res.json({ payments, total, page, limit });
  } catch (err) {
    console.error("[admin payments]", err);
    return res.status(500).json({ error: "Failed to list payments" });
  }
});

export default router;
