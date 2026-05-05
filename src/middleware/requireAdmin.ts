import { RequestHandler } from "express";

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.isAuthenticated() || req.user?.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
};
