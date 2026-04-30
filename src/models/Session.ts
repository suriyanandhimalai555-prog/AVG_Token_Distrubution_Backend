import mongoose, { Document, Schema } from "mongoose";

export interface ISession extends Document {
  createdAt: Date;
  totalWallets: number;
  network: "bscMainnet" | "bscTestnet";
  tokenAddress: string;
  tokenName: string;
  multisenderAddress: string;
  status: "idle" | "generating" | "preparing" | "distributing" | "done" | "stopped" | "error";
  sentCount: number;
  failedCount: number;
  bnbSpent: number;
  startedAt?: Date;
  completedAt?: Date;
  masterMnemonic?: string;
}

const SessionSchema = new Schema<ISession>(
  {
    totalWallets: { type: Number, required: true },
    network: { type: String, enum: ["bscMainnet", "bscTestnet"], required: true, default: "bscMainnet" },
    tokenAddress: { type: String, required: true },
    tokenName: { type: String, required: true },
    multisenderAddress: { type: String, required: true },
    status: {
      type: String,
      enum: ["idle", "generating", "preparing", "distributing", "done", "stopped", "error"],
      default: "idle",
    },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    bnbSpent: { type: Number, default: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
    masterMnemonic: { type: String },
  },
  { timestamps: true }
);

export const Session = mongoose.model<ISession>("Session", SessionSchema);
