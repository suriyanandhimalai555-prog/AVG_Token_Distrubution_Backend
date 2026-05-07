import { RequestHandler } from "express";
import { Subscription } from "../models/Subscription";

export const requirePlan: RequestHandler = async (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.user?.role === "ADMIN") {
    return next();
  }
  const sub = await Subscription.findOne({ userId: req.user!._id, status: "ACTIVE" });
  if (!sub) {
    return res.status(403).json({
      error: "No active plan. Please subscribe.",
      code: "NO_ACTIVE_PLAN",
    });
  }
  next();
};
