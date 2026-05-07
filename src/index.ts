import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "./config/passport";
import { connectDB } from "./lib/db";

import sessionsRouter from "./routes/sessions";
import generateRouter from "./routes/generate";
import prepareRouter from "./routes/prepare";
import distributeRouter from "./routes/distribute";
import progressRouter from "./routes/progress";
import statusRouter from "./routes/status";
import exportRouter from "./routes/export";
import batchesRouter from "./routes/batches";
import configRouter from "./routes/config";
import deployRouter from "./routes/deploy";
import walletRouter from "./routes/wallet";
import estimateRouter from "./routes/estimate";
import authRouter from "./routes/auth";
import paymentsRouter from "./routes/payments";
import adminRouter from "./routes/admin";
import { handleCoinbaseWebhook } from "./routes/paymentsWebhook";

const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

app.set("trust proxy", 1);

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL ?? "",
  process.env.CLIENT_URL ?? "",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Coinbase Commerce webhook — MUST use raw body for HMAC (before JSON parser)
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  (req, res, next) => {
    void handleCoinbaseWebhook(req, res).catch(next);
  }
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET ?? "dev-only-change-me-SESSION_SECRET";
const isProd = process.env.NODE_ENV === "production";

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store:
    process.env.MONGODB_URI != null && process.env.MONGODB_URI.length > 0
      ? MongoStore.create({
          mongoUrl: process.env.MONGODB_URI,
          ttl: 7 * 24 * 60 * 60,
        })
      : undefined,
  cookie: {
    secure: isProd,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    // Cross-site frontend/backend in production (holderforge.io -> railway.app)
    // requires SameSite=None + Secure for session cookie persistence.
    sameSite: isProd ? "none" : "lax",
  },
});

app.use(sessionMiddleware as unknown as express.RequestHandler);
app.use(passport.initialize());
app.use(passport.session());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/payments", paymentsRouter);

app.use("/api/sessions", sessionsRouter);
app.use("/api/generate", generateRouter);
app.use("/api/prepare", prepareRouter);
app.use("/api/distribute", distributeRouter);
app.use("/api/progress", progressRouter);
app.use("/api/status", statusRouter);
app.use("/api/export", exportRouter);
app.use("/api/batches", batchesRouter);
app.use("/api/config", configRouter);
app.use("/api/deploy", deployRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/estimate", estimateRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server error]", err.message);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

async function start(): Promise<void> {
  app.listen(PORT, () => {
    console.log(`[server] Running on http://localhost:${PORT}`);
  });

  connectDB().catch((err: Error) => {
    console.error("[DB] Initial connect error:", err.message);
  });
}

start().catch((err) => {
  console.error("[server] Fatal:", err);
  process.exit(1);
});
