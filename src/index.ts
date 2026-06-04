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

function hostMatchesAllowed(requestOrigin: string): boolean {
  try {
    const req = new URL(requestOrigin);
    const reqBase = req.hostname.replace(/^www\./i, "");
    for (const allowed of allowedOrigins) {
      const a = new URL(allowed);
      if (a.hostname.replace(/^www\./i, "") === reqBase) return true;
    }
  } catch {
    /* ignore malformed origin */
  }
  return false;
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || hostMatchesAllowed(origin)) {
        return cb(null, true);
      }
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
const mongoUrl = process.env.MONGODB_URI;
// Default OFF for stability: Atlas TLS/network issues should not crash auth/session.
// Enable only when explicitly set to true.
const useMongoSessionStore = process.env.USE_MONGO_SESSION_STORE === "true";

class EphemeralSessionStore extends session.Store {
  private sessions = new Map<string, { expiresAt: number; data: session.SessionData }>();

  constructor() {
    super();
    setInterval(() => this.prune(), 60_000).unref();
  }

  private prune(): void {
    const now = Date.now();
    for (const [sid, entry] of this.sessions.entries()) {
      if (entry.expiresAt <= now) this.sessions.delete(sid);
    }
  }

  get(
    sid: string,
    callback: (err?: unknown, session?: session.SessionData | null) => void
  ): void {
    const entry = this.sessions.get(sid);
    if (!entry) return callback(undefined, null);
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(sid);
      return callback(undefined, null);
    }
    callback(undefined, entry.data);
  }

  set(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: unknown) => void
  ): void {
    const maxAgeMs = typeof sess.cookie?.maxAge === "number" ? sess.cookie.maxAge : 7 * 24 * 60 * 60 * 1000;
    this.sessions.set(sid, {
      expiresAt: Date.now() + maxAgeMs,
      data: sess,
    });
    callback?.();
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.sessions.delete(sid);
    callback?.();
  }
}

function buildSessionStore(): session.Store | undefined {
  if (!mongoUrl || !useMongoSessionStore) {
    if (!mongoUrl) console.warn("[session] MONGODB_URI missing — using EphemeralSessionStore");
    if (!useMongoSessionStore) console.warn("[session] USE_MONGO_SESSION_STORE=false — using EphemeralSessionStore");
    return new EphemeralSessionStore();
  }

  try {
    const store = MongoStore.create({
      mongoUrl,
      ttl: 7 * 24 * 60 * 60,
    });
    // Prevent process crash when Mongo session store emits connection errors.
    store.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[session] MongoStore error: ${msg} (continuing with degraded sessions)`);
    });
    return store;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[session] Failed to initialize MongoStore: ${msg} (using MemoryStore)`);
    return undefined;
  }
}

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: buildSessionStore(),
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
