import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import { Subscription } from "../models/Subscription";
import { User } from "../models/User";

const router = Router();

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
}

function toSessionUser(user: {
  _id: mongoose.Types.ObjectId;
  googleId?: string;
  email: string;
  name: string;
  avatar?: string;
  role: "USER" | "ADMIN";
}): Express.User {
  return {
    _id: user._id,
    googleId: user.googleId,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    role: user.role,
  };
}

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
    const cleanName = (name ?? "").trim();
    const cleanEmail = (email ?? "").trim().toLowerCase();
    const rawPassword = password ?? "";

    if (!cleanName || !cleanEmail || !rawPassword) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (rawPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const exists = await User.findOne({ email: cleanEmail }).lean();
    if (exists) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(rawPassword, salt);
    const user = await User.create({
      name: cleanName,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash,
      role: "USER",
    });

    await new Promise<void>((resolve, reject) => {
      req.login(toSessionUser(user), (err) => (err ? reject(err) : resolve()));
    });

    return res.status(201).json({ success: true, user: toSessionUser(user) });
  } catch (err) {
    console.error("[auth/register]", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const cleanEmail = (email ?? "").trim().toLowerCase();
    const rawPassword = password ?? "";
    if (!cleanEmail || !rawPassword) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user || !user.passwordSalt || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const computed = hashPassword(rawPassword, user.passwordSalt);
    if (computed !== user.passwordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await new Promise<void>((resolve, reject) => {
      req.login(toSessionUser(user), (err) => (err ? reject(err) : resolve()));
    });

    const subscription = await Subscription.findOne({ userId: user._id }).lean();
    return res.json({ success: true, user: toSessionUser(user), subscription });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

router.get("/me", async (req, res) => {
  if (!req.isAuthenticated() || !req.user?._id) {
    return res.json({ user: null, subscription: null });
  }
  const subscription = await Subscription.findOne({ userId: req.user._id }).lean();
  return res.json({ user: req.user, subscription });
});

router.post("/logout", (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ success: true });
  }
  req.logout((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    req.session.destroy((e) => {
      if (e) {
        res.status(500).json({ error: "Session destroy failed" });
        return;
      }
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });
});

export default router;
