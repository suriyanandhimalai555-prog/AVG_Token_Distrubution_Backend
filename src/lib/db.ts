import mongoose from "mongoose";
import dns from "dns";

// Force all DNS lookups (including mongodb+srv SRV records) to use Google DNS.
// Fixes ECONNREFUSED / ENOTFOUND errors when the local router blocks SRV queries.
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

let isConnected = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function isDbConnected(): boolean {
  return isConnected;
}

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[DB] MONGODB_URI not set — running without database");
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
    });
    isConnected = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    console.log("[DB] MongoDB connected");
  } catch (err) {
    isConnected = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Connection failed: ${msg}`);
    console.warn("[DB] Retrying in 15s... (server continues without DB)");
    retryTimer = setTimeout(() => connectDB(), 15_000);
  }

  mongoose.connection.on("error", (err) => {
    console.error("[DB] Error:", err.message);
    isConnected = false;
  });

  mongoose.connection.on("disconnected", () => {
    if (isConnected) {
      console.warn("[DB] Disconnected — retrying in 15s");
      isConnected = false;
      retryTimer = setTimeout(() => connectDB(), 15_000);
    }
  });

  mongoose.connection.on("connected", () => {
    isConnected = true;
    console.log("[DB] Reconnected");
  });
}
