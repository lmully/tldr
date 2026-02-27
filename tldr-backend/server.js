require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS — allow requests from Chrome extensions ──────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true) // Chrome extensions have null origin
}));

// ── Raw body needed for Stripe webhook signature verification ──────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Helper: generate a license key ────────────────────────────────
function generateLicenseKey() {
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `TLDR-${seg()}-${seg()}-${seg()}`;
}

// ── Helper: verify a license key exists and is active ─────────────
async function verifyLicense(key) {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', key)
    .eq('active', true)
    .single();
  if (error || !data) return null;
  return data;
}

// ─────────────────────────────────────────────────────────────────
// POST /summarise
// Called by the Chrome extension with a license key + page text
// ─────────────────────────────────────────────────────────────────
app.post('/summarise', async (req, res) => {
  const { licenseKey, text, title } = req.body;

  if (!licenseKey || !text) {
    return res.status(400).json({ error: 'Missing licenseKey or text' });
  }

  // 1. Verify license
  const license = await verifyLicense(licenseKey);
  if (!license) {
    return res.status(403).json({ error: 'INVALID_LICENSE' });
  }

  // 2. Call OpenRouter
  try {
    const trimmed = text.slice(0, 6000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://tldr-extension.app',
        'X-Title': 'AI TL;DR Extension'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: `You are a concise summariser. Respond with ONLY a JSON object, no markdown, no extra text:
{
  "headline": "One sharp sentence capturing the core idea (max 15 words)",
  "bullets": [
    "First key point — specific and useful",
    "Second key point — specific and useful",
    "Third key point — specific and useful"
  ],
  "readTime": "X min read"
}`
          },
          {
            role: 'user',
            content: `Page title: ${title}\n\nPage content:\n${trimmed}`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(502).json({ error: err.error?.message || 'AI API error' });
    }

    const data = await response.json();
    const raw = data.choices[0].message.content.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // 3. Log usage (optional — useful for monitoring)
    await supabase.from('usage').insert({
      license_key: licenseKey,
      created_at: new Date().toISOString()
    });

    return res.json({ result: JSON.parse(raw) });

  } catch (err) {
    console.error('Summarise error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /verify?key=TLDR-XXXX-XXXX-XXXX
// Called by extension on startup to check if license is still valid
// ─────────────────────────────────────────────────────────────────
app.get('/verify', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ valid: false });
  const license = await verifyLicense(key);
  res.json({ valid: !!license });
});

// ─────────────────────────────────────────────────────────────────
// POST /webhook  (Stripe)
// Fires when a user completes a one-time payment
// ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const licenseKey = generateLicenseKey();

    // Save license to Supabase
    const { error } = await supabase.from('licenses').insert({
      key: licenseKey,
      email: email,
      stripe_session_id: session.id,
      active: true,
      created_at: new Date().toISOString()
    });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to create license' });
    }

    // Send license key email via Stripe (or log it for now)
    console.log(`✅ New license created: ${licenseKey} for ${email}`);

    // TODO: Send email with licenseKey to the customer
    // You can use Resend, SendGrid, or Postmark for this
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'AI TL;DR Backend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
