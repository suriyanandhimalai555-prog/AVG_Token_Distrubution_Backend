import mongoose, { Document, Schema } from "mongoose";

export interface IBatch extends Document {
  sessionId: string;
  batchIndex: number;
  walletCount: number;
  txHash?: string;
  gasUsed?: string;
  status: "pending" | "confirmed" | "failed";
  createdAt: Date;
  confirmedAt?: Date;
}

const BatchSchema = new Schema<IBatch>(
  {
    sessionId: { type: String, required: true, index: true },
    batchIndex: { type: Number, required: true },
    walletCount: { type: Number, required: true },
    txHash: { type: String },
    gasUsed: { type: String },
    status: {
      type: String,
      enum: ["pending", "confirmed", "failed"],
      default: "pending",
    },
    confirmedAt: { type: Date },
  },
  { timestamps: true }
);

BatchSchema.index({ sessionId: 1, batchIndex: 1 }, { unique: true });

export const Batch = mongoose.model<IBatch>("Batch", BatchSchema);
