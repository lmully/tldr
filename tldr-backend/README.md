# AI TL;DR — Full Setup Guide

## Architecture Overview

```
User clicks TL;DR
      ↓
Chrome Extension
      ↓  (license key + page text)
Your Backend (Railway)
      ↓  verifies license in Supabase
      ↓  calls OpenRouter AI
      ↑  returns summary
Chrome Extension displays result
```

---

## Step 1: Set Up Supabase (Free)

1. Go to https://supabase.com and create a free account
2. Create a new project
3. Go to **SQL Editor** and run the contents of `supabase-setup.sql`
4. Go to **Settings → API** and copy:
   - `Project URL` → SUPABASE_URL
   - `service_role` secret key → SUPABASE_SERVICE_KEY

---

## Step 2: Set Up Stripe

1. Go to https://stripe.com and create an account
2. Go to **Products → Add Product**
   - Name: "AI TL;DR License"
   - Price: $4.99, one-time
3. Create a **Payment Link** for that product
4. Copy the payment link URL → paste into `popup.html` (replace `YOUR_STRIPE_PAYMENT_LINK`)
5. Go to **Developers → API Keys** and copy your **Secret Key** → STRIPE_SECRET_KEY

---

## Step 3: Set Up OpenRouter

1. Go to https://openrouter.ai and create a free account
2. Go to **Keys** and create an API key → OPENROUTER_API_KEY
3. Add a small credit (a few dollars covers thousands of summaries)

---

## Step 4: Deploy Backend to Railway

1. Go to https://railway.app and sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Push the `tldr-backend` folder to a GitHub repo first, then connect it
4. In Railway, go to **Variables** and add all keys from `.env.example`
5. Railway will give you a URL like `https://tldr-backend-xxxx.up.railway.app`

---

## Step 5: Add Stripe Webhook

1. In Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. URL: `https://your-railway-url.up.railway.app/webhook`
3. Event: `checkout.session.completed`
4. Copy the **Signing Secret** → STRIPE_WEBHOOK_SECRET in Railway

---

## Step 6: Update Extension with Your Backend URL

In `background.js` and `manifest.json`, replace:
```
https://your-app.up.railway.app
```
with your actual Railway URL.

---

## Step 7: Set Up License Email (Important!)

When a user pays, the backend logs their license key but doesn't email it yet.
You need to add an email service. Easiest option:

1. Sign up at https://resend.com (free tier: 3,000 emails/month)
2. Get an API key
3. In `server.js`, find the `TODO: Send email` comment and add:

```javascript
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: 'noreply@yourdomain.com',
  to: email,
  subject: 'Your AI TL;DR License Key',
  html: `
    <h2>Thanks for your purchase!</h2>
    <p>Your license key is:</p>
    <h1 style="font-family:monospace">${licenseKey}</h1>
    <p>Enter this in the AI TL;DR Chrome extension to activate it.</p>
  `
});
```

---

## Revenue Estimate

| Customers | Monthly Revenue | Your AI Cost |
|-----------|----------------|--------------|
| 100       | $499 (one-time) | ~$0.50/month |
| 500       | $2,495 (one-time) | ~$2.50/month |

OpenRouter free tier handles ~200 requests/day. Add $5 credit for unlimited.
