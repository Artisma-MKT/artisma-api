import type { VercelRequest, VercelResponse } from '@vercel/node'

const ALLOWED_ORIGINS = [
  'https://www.artismamkt.com',
  'https://artismamkt.com',
  'http://localhost:3000',
  'http://localhost:3001',
]

const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL!
const SHEETS_SECRET = process.env.SHEETS_SECRET!

function setCors(req: VercelRequest, res: VercelResponse) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  res.setHeader('Access-Control-Allow-Origin', allowed)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '86400')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const { evento, pagina, gclid, utm_source, utm_medium, utm_campaign, campaignid } =
    req.body as Record<string, string>

  if (!evento || !pagina) return res.status(400).json({ error: 'missing_fields' })

  try {
    await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: SHEETS_SECRET,
        evento,
        pagina,
        gclid: gclid || '',
        utm_source: utm_source || '',
        utm_medium: utm_medium || '',
        utm_campaign: utm_campaign || '',
        campaignid: campaignid || '',
      }),
    })
    return res.status(200).json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'sheets_error' })
  }
}
