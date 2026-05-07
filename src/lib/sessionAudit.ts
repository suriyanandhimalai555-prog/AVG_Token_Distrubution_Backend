import type mongoose from "mongoose";
import { SessionAudit } from "../models/SessionAudit";

interface AuditInput {
  userId: mongoose.Types.ObjectId;
  sessionId: string;
  action: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function recordSessionAudit(input: AuditInput): Promise<void> {
  try {
    await SessionAudit.create({
      userId: input.userId,
      sessionId: input.sessionId,
      action: input.action,
      message: input.message,
      details: input.details ?? {},
    });
  } catch (err) {
    // Audit failures should never break primary API operations.
    console.error("[session-audit] write failed:", err);
  }
}
