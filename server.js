const { Resend } = require('resend');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

// ── Lazy-load clients so missing env vars don't crash at startup ──
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

// ── CORS — allow requests from Chrome extensions ──────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true)
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Helper: generate a license key ────────────────────────────────
function generateLicenseKey() {
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `TLDR-${seg()}-${seg()}-${seg()}`;
}

// ── Helper: verify a license key ──────────────────────────────────
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

// ── Health check ──────────────────────────────────────────────────
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

// ── POST /summarise ───────────────────────────────────────────────
app.post('/summarise', async (req, res) => {
  const { licenseKey, text, title } = req.body;
  if (!licenseKey || !text) return res.status(400).json({ error: 'Missing licenseKey or text' });

  const license = await verifyLicense(licenseKey);
  if (!license) return res.status(403).json({ error: 'INVALID_LICENSE' });

  try {
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

// ── GET /verify ───────────────────────────────────────────────────
app.get('/verify', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ valid: false });
  const license = await verifyLicense(key);
  res.json({ valid: !!license });
});

// ── POST /webhook (Stripe) ────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const licenseKey = generateLicenseKey();

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

    console.log(`✅ New license: ${licenseKey} for ${email}`);
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'AI TL;DR <noreply@boltextensions.com>',
        to: email,
        subject: 'Your AI TL;DR License Key',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f0f;color:#f5f0e8;border-radius:12px">
            <h2 style="font-size:24px;margin-bottom:8px">⚡ You're all set!</h2>
            <p style="color:#aaa;margin-bottom:24px">Thanks for purchasing AI TL;DR by Bolt Extensions.</p>
            <p style="margin-bottom:8px">Your license key is:</p>
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:16px;font-family:monospace;font-size:20px;letter-spacing:0.1em;color:#f5d060;text-align:center">${licenseKey}</div>
            <p style="color:#aaa;font-size:13px;margin-top:24px">Enter this in the AI TL;DR Chrome extension popup to activate it. Keep it safe — this key is yours forever.</p>
            <p style="color:#555;font-size:11px;margin-top:32px">Bolt Extensions · boltextensions.com</p>
          </div>
        `
      });
      console.log(`📧 License email sent to ${email}`);
    } catch (emailErr) {
      console.error('Email send failed:', emailErr);
      // Don't fail the whole webhook if email fails
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bolt Extensions backend running on port ${PORT}`));
