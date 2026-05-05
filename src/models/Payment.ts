import mongoose, { Document, Schema } from "mongoose";

export interface IPayment extends Document {
  userId: mongoose.Types.ObjectId;
  subscriptionId?: mongoose.Types.ObjectId;
  coinbaseChargeId: string;
  coinbaseChargeCode: string;
  coinbaseHostedUrl: string;
  coinbaseInternalOrderId: string;
  coinbaseTxHash?: string;
  coinbaseCryptoType?: string;
  amount: number;
  status: "NEW" | "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "CANCELLED";
  productLine: string;
  planKey: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription" },
    coinbaseChargeId: { type: String, required: true, unique: true },
    coinbaseChargeCode: { type: String, required: true },
    coinbaseHostedUrl: { type: String, required: true },
    coinbaseInternalOrderId: { type: String, required: true },
    coinbaseTxHash: { type: String },
    coinbaseCryptoType: { type: String },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["NEW", "PENDING", "CONFIRMED", "FAILED", "EXPIRED", "CANCELLED"],
      default: "NEW",
    },
    productLine: { type: String, required: true },
    planKey: { type: String, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export const Payment = mongoose.model<IPayment>("Payment", PaymentSchema);
