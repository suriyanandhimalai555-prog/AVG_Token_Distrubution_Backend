const clientUrl = process.env.CLIENT_URL ?? "http://localhost:5173";

export const COINBASE_CONFIG = {
  apiKey: process.env.COINBASE_COMMERCE_API_KEY ?? "",
  webhookSecret: process.env.COINBASE_COMMERCE_WEBHOOK_SECRET ?? "",
  apiBase: "https://api.commerce.coinbase.com",
  apiVersion: "2018-03-22",
  cancelUrl: `${clientUrl}/payment-result?status=cancelled`,
  redirectUrl: `${clientUrl}/payment-result`,
};

export function coinbaseHeaders(): Record<string, string> {
  return {
    "X-CC-Api-Key": COINBASE_CONFIG.apiKey,
    "X-CC-Version": COINBASE_CONFIG.apiVersion,
    "Content-Type": "application/json",
  };
}
