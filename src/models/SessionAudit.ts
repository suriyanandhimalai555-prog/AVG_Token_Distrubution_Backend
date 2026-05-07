import mongoose, { Document, Schema } from "mongoose";

export interface ISessionAudit extends Document {
  userId: mongoose.Types.ObjectId;
  sessionId: string;
  action: string;
  message?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

const SessionAuditSchema = new Schema<ISessionAudit>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    message: { type: String },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

SessionAuditSchema.index({ userId: 1, createdAt: -1 });
SessionAuditSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

export const SessionAudit = mongoose.model<ISessionAudit>("SessionAudit", SessionAuditSchema);
