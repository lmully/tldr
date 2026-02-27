require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

let _stripe, _supabase;

function getStripe() {
  if (!_stripe) _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

function getSupabase() {
  if (!_supabase) _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  return _supabase;
}

app.use(cors({ origin: (origin, cb) => cb(null, true) }));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function generateLicenseKey() {
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `TLDR-${seg()}-${seg()}-${seg()}`;
}

async function verifyLicense(key) {
  const { data, error } = await getSupabase()
    .from('licenses')
    .select('*')
    .eq('key', key)
    .eq('active', true)
    .single();
  if (error || !data) return null;
  return data;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Bolt Extensions — AI TL;DR Backend',
    env: {
      supabase: !!process.env.SUPABASE_URL,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY
    }
  });
});

app.post('/summarise', async (req, res) => {
  try {
    const { licenseKey, text, title } = req.body;
    if (!licenseKey || !text) return res.status(400).json({ error: 'Missing licenseKey or text' });

    const license = await verifyLicense(licenseKey);
    if (!license) return res.status(403).json({ error: 'INVALID_LICENSE' });

    const trimmed = text.slice(0, 6000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://boltextensions.com',
        'X-Title': 'Bolt Extensions — AI TL;DR'
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
          { role: 'user', content: `Page title: ${title}\n\nPage content:\n${trimmed}` }
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

    await getSupabase().from('usage').insert({
      license_key: licenseKey,
      created_at: new Date().toISOString()
    });

    return res.json({ result: JSON.parse(raw) });
  } catch (err) {
    console.error('Summarise error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/verify', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ valid: false });
    const license = await verifyLicense(key);
    res.json({ valid: !!license });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ valid: false });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`📩 Webhook received: ${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const licenseKey = generateLicenseKey();

      console.log(`💳 Payment from ${email}`);

      const { error } = await getSupabase().from('licenses').insert({
        key: licenseKey,
        email,
        stripe_session_id: session.id,
        active: true,
        created_at: new Date().toISOString()
      });

      if (error) {
        console.error('Supabase insert error:', error);
        return res.status(500).json({ error: 'Failed to create license' });
      }

      // Log license key so you can manually send it while email is being set up
      console.log(`✅ LICENSE CREATED: ${licenseKey} for ${email}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bolt Extensions backend running on port ${PORT}`));
