import { Router } from "express";
import passport from "../config/passport";
import { requireAuth } from "../middleware/requireAuth";
import { Subscription } from "../models/Subscription";

const router = Router();
const clientBase = () => process.env.CLIENT_URL ?? "http://localhost:5173";

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${clientBase()}/login`,
    session: true,
  }),
  async (req, res) => {
    const client = clientBase();
    if (!req.user) {
      res.redirect(`${client}/login`);
      return;
    }
    const sub = await Subscription.findOne({ userId: req.user._id, status: "ACTIVE" });
    if (sub) res.redirect(`${client}/dashboard`);
    else res.redirect(`${client}/dashboard/setup`);
  }
);

router.get("/me", requireAuth, async (req, res) => {
  const subscription = await Subscription.findOne({ userId: req.user!._id }).lean();
  res.json({ user: req.user, subscription });
});

router.post("/logout", requireAuth, (req, res) => {
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
