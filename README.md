# AVG_Token_Distrubution_Backend

## Authentication & Payments Setup

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project → **APIs & Services** → **Credentials**.
3. Create **OAuth 2.0 Client ID** (Web application).
4. **Authorized redirect URIs** must include:
   - `http://localhost:4000/api/auth/google/callback` (or your backend port)
   - `https://yourdomain.com/api/auth/google/callback` in production
5. Copy **Client ID** and **Client Secret** into `server/.env` (or `.env` in this package).

Frontend dev (Vite) typically proxies `/api` to this server; OAuth still redirects to the **backend** callback URL above.

### Coinbase Commerce

1. Go to [Coinbase Commerce](https://commerce.coinbase.com/) and sign in or create an account.
2. **Settings** → **API Keys** → create an API key → put `COINBASE_COMMERCE_API_KEY` in `.env`.
3. **Settings** → **Webhook subscriptions** → add endpoint URL:
   - `https://yourdomain.com/api/payments/webhook`
   - Subscribe to charge events.
4. Copy the webhook shared secret to `COINBASE_COMMERCE_WEBHOOK_SECRET` in `.env`.

Webhooks must hit your server over HTTPS with a publicly reachable URL. For local testing:

```bash
npm install -g ngrok
ngrok http 4000
```

Use the ngrok HTTPS URL as `SERVER_URL` if your app constructs absolute URLs; update the webhook URL in the Coinbase dashboard to match. Restart the server after env changes.

In the Commerce dashboard, enable **test mode** when experimenting; follow Commerce docs for sandbox / test flows.

### Set Admin User

```javascript
mongosh
use your-database-name
db.users.updateOne(
  { email: "your@email.com" },
  { $set: { role: "ADMIN" } }
)
```
