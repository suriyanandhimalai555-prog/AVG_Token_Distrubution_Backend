import { RequestHandler } from "express";

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: "Unauthorized" });
};
