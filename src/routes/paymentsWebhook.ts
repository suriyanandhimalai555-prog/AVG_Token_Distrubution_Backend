import { Request, Response } from "express";
import crypto from "crypto";
import { Payment } from "../models/Payment";
import { Subscription } from "../models/Subscription";
import { findPlan } from "../lib/plans";

function mapEventStatus(type: string): "NEW" | "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "CANCELLED" | null {
  switch (type) {
    case "charge:created":
      return "NEW";
    case "charge:pending":
      return "PENDING";
    case "charge:confirmed":
      return "CONFIRMED";
    case "charge:failed":
      return "FAILED";
    case "charge:delayed":
      return "PENDING";
    case "charge:resolved":
      return "CONFIRMED";
    default:
      return null;
  }
}

export async function handleCoinbaseWebhook(req: Request, res: Response): Promise<void> {
  const respond = (): void => {
    res.status(200).json({ received: true });
  };

  try {
    const rawBody = req.body as Buffer;
    const signature = (req.headers["x-cc-webhook-signature"] as string | undefined) ?? "";
    const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET ?? "";

    if (!Buffer.isBuffer(rawBody) || !secret) {
      respond();
      return;
    }

    const expectedSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      respond();
      return;
    }

    const event = JSON.parse(rawBody.toString("utf8")) as {
      event?: { type?: string; data?: Record<string, unknown> };
    };
    const eventType = event.event?.type ?? "";
    const chargeData = (event.event?.data ?? {}) as {
      id?: string;
      metadata?: Record<string, string>;
      payments?: Array<{
        transaction_id?: string;
        value?: { crypto?: { currency?: string } };
      }>;
    };
    const chargeId = chargeData.id;
    if (!chargeId) {
      respond();
      return;
    }

    const payment = await Payment.findOne({ coinbaseChargeId: chargeId });
    if (!payment) {
      respond();
      return;
    }

    const mapped = mapEventStatus(eventType);
    if (mapped) {
      payment.status = mapped;
    }

    if (payment.status === "CONFIRMED") {
      payment.paidAt = new Date();
      const payments = chargeData.payments ?? [];
      if (payments.length > 0) {
        const lastPayment = payments[payments.length - 1];
        payment.coinbaseTxHash = lastPayment.transaction_id;
        payment.coinbaseCryptoType = lastPayment.value?.crypto?.currency;
      }

      const plan = findPlan(payment.productLine, payment.planKey);
      if (plan && "walletLimit" in plan) {
        const expiresAt =
          payment.productLine === "TOKEN_HOLDER"
            ? new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const subscription = await Subscription.findOneAndUpdate(
          { userId: payment.userId },
          {
            userId: payment.userId,
            productLine: payment.productLine as "TOKEN_HOLDER" | "DEX_AUTOMATION",
            planKey: payment.planKey,
            status: "ACTIVE",
            walletLimit: plan.walletLimit,
            startedAt: new Date(),
            expiresAt,
          },
          { upsert: true, new: true }
        );
        payment.subscriptionId = subscription._id;
      }
    }

    await payment.save();
  } catch (e) {
    console.error("[payments webhook]", e);
  }
  respond();
}
