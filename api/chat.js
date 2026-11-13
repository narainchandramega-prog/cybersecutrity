// Vercel serverless function: POST /api/chat
// The OpenAI API key is read only on the server and is never sent to the browser.

const recentRequests = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 12;

function allowRequest(key) {
  const now = Date.now();
  const prior = recentRequests.get(key) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > prior.resetAt) {
    prior.count = 0;
    prior.resetAt = now + WINDOW_MS;
  }
  prior.count += 1;
  recentRequests.set(key, prior);
  // Keep this best-effort in-memory map bounded.
  if (recentRequests.size > 1000) {
    for (const [k, v] of recentRequests) {
      if (now > v.resetAt) recentRequests.delete(k);
    }
  }
  return prior.count <= MAX_REQUESTS;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'The AI service is not configured yet. The site owner must add OPENAI_API_KEY in Vercel.'
    });
  }

  const forwarded = req.headers['x-forwarded-for'];
  const clientKey = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : 'unknown').slice(0, 80);
  if (!allowRequest(clientKey)) {
    return res.status(429).json({ error: 'Too many questions in a short time. Please wait a few minutes and try again.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) {
      return res.status(400).json({ error: 'Invalid request format.' });
    }
  }

  const incoming = body && Array.isArray(body.messages) ? body.messages : null;
  if (!incoming || incoming.length < 1 || incoming.length > 10) {
    return res.status(400).json({ error: 'Send between 1 and 10 recent chat messages.' });
  }

  const messages = [];
  for (const item of incoming) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
      return res.status(400).json({ error: 'Invalid chat message.' });
    }
    const content = item.content.trim();
    if (!content || content.length > 1500) {
      return res.status(400).json({ error: 'Each message must contain 1–1,500 characters.' });
    }
    messages.push({ role: item.role, content });
  }
  if (messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'The latest message must be a user question.' });
  }

  const instructions = [
    'You are CyberShield AI, a friendly, age-appropriate cybersecurity education assistant for a student audience.',
    'Help with defensive cybersecurity, scam awareness, privacy, account protection, safe browsing, and reporting suspicious activity.',
    'Give clear, practical, lawful safety guidance in simple language. Ask for no passwords, OTPs, recovery codes, bank details, addresses, or other sensitive personal information.',
    'If a user shares sensitive information, tell them not to share it and do not repeat it back.',
    'Do not provide instructions that enable hacking, credential theft, malware, evasion, surveillance, exploitation, or attacks. Redirect to safe, defensive learning.',
    'Do not claim to scan live websites, verify a sender, access accounts, or consult live threat intelligence. Explain limitations honestly.',
    'For urgent financial cyber-fraud in India, advise contacting their bank/payment provider immediately and using the official national cybercrime reporting channel; do not promise recovery.',
    'Be calm, concise, and supportive. Use short steps where useful. If unsure, say so and recommend checking with a trusted adult or official service.'
  ].join(' ');

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-6-luna',
        instructions,
        input: messages,
        max_output_tokens: 650
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = upstream.status === 429
        ? 'The AI service is busy or its usage limit has been reached. Please try again later.'
        : 'The AI provider could not complete the request. Please try again later.';
      return res.status(upstream.status === 429 ? 429 : 502).json({ error: message });
    }

    let answer = typeof data.output_text === 'string' ? data.output_text.trim() : '';
    if (!answer && Array.isArray(data.output)) {
      answer = data.output
        .filter(item => item && item.type === 'message' && Array.isArray(item.content))
        .flatMap(item => item.content)
        .filter(part => part && part.type === 'output_text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim();
    }

    if (!answer) {
      return res.status(502).json({ error: 'The AI returned no text. Please try again.' });
    }

    return res.status(200).json({ answer });
  } catch (_) {
    return res.status(502).json({ error: 'Could not connect to the AI service. Please try again later.' });
  }
};