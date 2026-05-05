import mongoose, { Document, Schema } from "mongoose";

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId;
  productLine: "TOKEN_HOLDER" | "DEX_AUTOMATION";
  planKey: string;
  status: "ACTIVE" | "EXPIRED" | "CANCELLED" | "PENDING";
  walletLimit: number;
  startedAt: Date;
  expiresAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    productLine: { type: String, enum: ["TOKEN_HOLDER", "DEX_AUTOMATION"], required: true },
    planKey: { type: String, required: true },
    status: {
      type: String,
      enum: ["ACTIVE", "EXPIRED", "CANCELLED", "PENDING"],
      default: "PENDING",
    },
    walletLimit: { type: Number, required: true },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model<ISubscription>("Subscription", SubscriptionSchema);
