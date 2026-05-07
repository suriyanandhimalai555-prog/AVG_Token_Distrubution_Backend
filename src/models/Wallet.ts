import mongoose, { Document, Schema } from "mongoose";

export interface IWallet extends Document {
  sessionId: string;
  index: number;
  address: string;
  derivationPath: string;
  amount: number;
  amountWei: string;
  packedHex: string;
  sent: boolean;
  failed?: boolean;
  failureReason?: string;
  txHash?: string;
  timestamp?: Date;
  batchId?: string;
}

const WalletSchema = new Schema<IWallet>({
  sessionId: { type: String, required: true, index: true },
  index: { type: Number, required: true },
  address: { type: String, required: true },
  derivationPath: { type: String, required: true },
  amount: { type: Number, required: true },
  amountWei: { type: String, required: true },
  packedHex: { type: String, required: true },
  sent: { type: Boolean, default: false, index: true },
  failed: { type: Boolean, default: false, index: true },
  failureReason: { type: String },
  txHash: { type: String },
  timestamp: { type: Date },
  batchId: { type: String },
});

WalletSchema.index({ sessionId: 1, index: 1 }, { unique: true });

export const Wallet = mongoose.model<IWallet>("Wallet", WalletSchema);
