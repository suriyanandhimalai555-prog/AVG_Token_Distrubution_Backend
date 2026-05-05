import mongoose from "mongoose";
import { Session as DistSession } from "../models/Session";

export async function assertSessionOwned(
  sessionId: string | undefined,
  userId: mongoose.Types.ObjectId
): Promise<boolean> {
  if (!sessionId) return false;
  const doc = await DistSession.findById(sessionId).lean();
  if (!doc?.userId) return false;
  return doc.userId.toString() === userId.toString();
}
