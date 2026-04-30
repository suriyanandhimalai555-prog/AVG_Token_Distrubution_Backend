import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL ?? "",
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

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── API routes ───────────────────────────────────────────────────────────────
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

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server error]", err.message);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Start HTTP server first — never block on DB
  app.listen(PORT, () => {
    console.log(`[server] Running on http://localhost:${PORT}`);
  });

  // Connect to MongoDB in background — retries automatically on failure
  connectDB().catch((err) => {
    console.error("[DB] Initial connect error:", err.message);
  });
}

start().catch((err) => {
  console.error("[server] Fatal:", err);
  process.exit(1);
});
