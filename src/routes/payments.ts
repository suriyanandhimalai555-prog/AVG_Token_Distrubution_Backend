import { Router } from "express";
import axios from "axios";
import { requireAuth } from "../middleware/requireAuth";
import { Payment } from "../models/Payment";
import { COINBASE_CONFIG, coinbaseHeaders } from "../config/coinbase";
import { findPlan } from "../lib/plans";

const router = Router();

router.post("/create-charge", requireAuth, async (req, res) => {
  try {
    const { productLine, planKey } = req.body as { productLine?: string; planKey?: string };
    if (!productLine || !planKey) {
      return res.status(400).json({ error: "productLine and planKey are required" });
    }

    const planRaw = findPlan(productLine, planKey);
    if (
      !planRaw ||
      !("priceUSD" in planRaw) ||
      typeof (planRaw as { priceUSD?: unknown }).priceUSD !== "number"
    ) {
      return res.status(400).json({ error: "Invalid plan" });
    }
    const plan = planRaw as typeof planRaw & { name: string; priceUSD: number };

    const internalOrderId = `order_${req.user!._id.toString()}_${Date.now()}`;

    const response = await axios.post(
      `${COINBASE_CONFIG.apiBase}/charges`,
      {
        name: plan.name,
        description: `${plan.name} — ${productLine.replace("_", " ")}`,
        pricing_type: "fixed_price",
        local_price: {
          amount: plan.priceUSD.toString(),
          currency: "USD",
        },
        metadata: {
          userId: req.user!._id.toString(),
          productLine,
          planKey,
          internalOrderId,
        },
        redirect_url: `${COINBASE_CONFIG.redirectUrl}?orderId=${encodeURIComponent(internalOrderId)}`,
        cancel_url: `${COINBASE_CONFIG.cancelUrl}&orderId=${encodeURIComponent(internalOrderId)}`,
      },
      { headers: coinbaseHeaders(), validateStatus: () => true }
    );

    if (response.status >= 400) {
      console.error("[create-charge] Coinbase error", response.status, response.data);
      return res.status(502).json({ error: "Failed to create Coinbase charge" });
    }

    const charge = (response.data as { data?: Record<string, string> }).data;
    if (!charge?.id || !charge.code || !charge.hosted_url) {
      return res.status(502).json({ error: "Invalid Coinbase charge response" });
    }

    await Payment.create({
      userId: req.user!._id,
      coinbaseChargeId: charge.id,
      coinbaseChargeCode: charge.code,
      coinbaseHostedUrl: charge.hosted_url,
      coinbaseInternalOrderId: internalOrderId,
      amount: plan.priceUSD,
      status: "NEW",
      productLine,
      planKey,
    });

    return res.json({
      chargeId: charge.id,
      chargeCode: charge.code,
      hostedUrl: charge.hosted_url,
      amount: plan.priceUSD,
      planName: plan.name,
      internalOrderId,
    });
  } catch (err) {
    console.error("[create-charge]", err);
    return res.status(500).json({ error: "Failed to create charge" });
  }
});

router.get("/status/:chargeId", requireAuth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      coinbaseChargeId: req.params.chargeId,
      userId: req.user!._id,
    });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    if (COINBASE_CONFIG.apiKey) {
      try {
        const resp = await axios.get(`${COINBASE_CONFIG.apiBase}/charges/${payment.coinbaseChargeId}`, {
          headers: coinbaseHeaders(),
          validateStatus: () => true,
        });
        const charge = (resp.data as { data?: { timeline?: Array<{ status: string }> } })?.data;
        const timeline = charge?.timeline;
        if (Array.isArray(timeline) && timeline.length > 0) {
          const last = timeline[timeline.length - 1]?.status ?? "";
          if (last === "COMPLETED") {
            payment.status = "CONFIRMED";
          } else if (last === "PENDING") {
            payment.status = "PENDING";
          } else if (last === "EXPIRED") {
            payment.status = "EXPIRED";
          } else if (last === "UNRESOLVED" || last === "CANCELED" || last === "CANCELLED") {
            payment.status = "CANCELLED";
          }
          await payment.save();
        }
      } catch {
        /* keep DB values */
      }
    }

    return res.json({
      status: payment.status,
      paidAt: payment.paidAt,
      txHash: payment.coinbaseTxHash,
      cryptoType: payment.coinbaseCryptoType,
      amount: payment.amount,
      planKey: payment.planKey,
      chargeCode: payment.coinbaseChargeCode,
      hostedUrl: payment.coinbaseHostedUrl,
      productLine: payment.productLine,
    });
  } catch (err) {
    console.error("[payment status]", err);
    return res.status(500).json({ error: "Failed to fetch payment status" });
  }
});

router.get("/by-order/:internalOrderId", requireAuth, async (req, res) => {
  const payment = await Payment.findOne({
    coinbaseInternalOrderId: req.params.internalOrderId,
    userId: req.user!._id,
  }).lean();

  if (!payment) return res.status(404).json({ error: "Not found" });
  return res.json({ chargeId: payment.coinbaseChargeId, status: payment.status });
});

router.get("/history", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10) || 10));
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      Payment.find({ userId: req.user!._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments({ userId: req.user!._id }),
    ]);

    return res.json({
      payments: payments.map((p) => ({
        chargeId: p.coinbaseChargeId,
        chargeCode: p.coinbaseChargeCode,
        amount: p.amount,
        cryptoType: p.coinbaseCryptoType,
        txHash: p.coinbaseTxHash,
        status: p.status,
        planKey: p.planKey,
        productLine: p.productLine,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[payments history]", err);
    return res.status(500).json({ error: "Failed to list payments" });
  }
});

export default router;
