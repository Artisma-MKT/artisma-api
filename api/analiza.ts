import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import { Resend } from 'resend'

const WEBHOOK_DIAGNOSTICO = 'https://services.leadconnectorhq.com/hooks/21Q9Ac26brV00Bu7vffn/webhook-trigger/46cf2dc2-7f69-4d43-a587-efc5243d6c70'

const ALLOWED_ORIGINS = [
  'https://www.artismamkt.com',
  'https://artismamkt.com',
  'http://localhost:3000',
  'http://localhost:3001',
]

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

  try {
    const { url, email, _hp, _ms } = req.body as { url: string; email: string; _hp?: string; _ms?: number }

    if (_hp || (_ms !== undefined && _ms < 2000)) {
      return res.status(400).json({ error: 'invalid_input' })
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
    if (!url?.trim() || !email?.trim() || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'invalid_input' })
    }

    const rawUrl = url.trim().replace(/^https?:\/\//, '')
    const normalizedUrl = `https://${rawUrl}`
    let domain: string
    try {
      domain = new URL(normalizedUrl).hostname.replace(/^www\./, '')
    } catch {
      return res.status(400).json({ error: 'invalid_domain' })
    }

    if (process.env.KV_REST_API_URL) {
      const { kv } = await import('@vercel/kv')
      const forwardedFor = req.headers['x-forwarded-for']
      const ip = typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim() ?? 'unknown'
        : 'unknown'
      const ipKey = `analiza:ip:${ip}`
      const emailKey = `analiza:email:${email.toLowerCase()}`

      const [ipCount, emailExists] = await Promise.all([
        kv.get<number>(ipKey),
        kv.get(emailKey),
      ])

      if ((ipCount ?? 0) >= 3) {
        return res.status(429).json({ error: 'rate_limit_ip' })
      }
      if (emailExists) {
        return res.status(429).json({ error: 'duplicate_email' })
      }
    }

    const [psResult, htmlResult, hasSitemap] = await Promise.all([
      fetchPageSpeed(normalizedUrl).catch(() => null),
      fetchHTML(normalizedUrl).catch(() => null),
      fetchSitemap(normalizedUrl).catch(() => false),
    ])

    const html = htmlResult
    const signals = detectSignals(html ?? '')

    const velocidad: number | null = psResult?.performance ?? null
    let seo = psResult?.seo ?? 50
    if (!signals.metaDesc) seo = Math.max(0, seo - 15)
    if (!signals.ogImage) seo = Math.max(0, seo - 10)

    let herramientas: number | null = null
    let captacion: number | null = null
    let googleVisibility: number | null = null

    if (html !== null) {
      if (!signals.isJsFramework) {
        let h = 0
        if (signals.hasTracking) h += 40
        if (signals.hasPixel) h += 35
        if (signals.hasEmailMkt) h += 25
        herramientas = Math.min(100, h)
      }

      let c = 0
      if (signals.hasForm) c += 35
      if (signals.hasBlog) c += 30
      if (signals.hasNewsletter) c += 20
      if (signals.hasChat) c += 15
      captacion = Math.min(100, c)

      let gv = 0
      if (hasSitemap) gv += 35
      if (signals.noNoindex) gv += 25
      if (signals.hasCanonical) gv += 20
      if (signals.hasSchema) gv += 20
      googleVisibility = Math.min(100, gv)
    }

    const weighted: Array<[number | null, number]> = [
      [velocidad, 0.25], [seo, 0.25], [googleVisibility, 0.20],
      [herramientas, 0.15], [captacion, 0.15],
    ]
    const available = weighted.filter(([v]) => v !== null) as [number, number][]
    const totalWeight = available.reduce((s, [, w]) => s + w, 0)
    const overall = Math.round(available.reduce((s, [v, w]) => s + v * (w / totalWeight), 0))

    if (process.env.KV_REST_API_URL) {
      const { kv } = await import('@vercel/kv')
      const forwardedFor = req.headers['x-forwarded-for']
      const ip = typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim() ?? 'unknown'
        : 'unknown'
      const ipKey = `analiza:ip:${ip}`
      const emailKey = `analiza:email:${email.toLowerCase()}`
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      const ipTtl = Math.floor((midnight.getTime() - now.getTime()) / 1000)
      const currentCount = await kv.get<number>(ipKey) ?? 0
      await Promise.all([
        kv.set(ipKey, currentCount + 1, { ex: ipTtl }),
        kv.set(emailKey, domain, { ex: 60 * 60 * 24 * 30 }),
      ])
    }

    const postWebhook = async (name: string, url: string, payload: unknown) => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          console.error(`[api/analiza] ${name} non-2xx`, r.status, body.slice(0, 300))
        }
      } catch (err) {
        console.error(`[api/analiza] ${name} failed`, err)
      }
    }

    waitUntil(postWebhook('WEBHOOK_DIAGNOSTICO', WEBHOOK_DIAGNOSTICO, {
      correo: email.trim(),
      pagina_web: domain,
      score_general: overall,
      score_velocidad: velocidad ?? 0,
      score_seo: seo,
      score_visibilidad_google: googleVisibility ?? 0,
      score_herramientas: herramientas ?? 0,
      score_captacion: captacion ?? 0,
    }))

    waitUntil(
      sendNotifications(email.trim(), domain, overall, { velocidad, seo, googleVisibility, herramientas, captacion }, signals)
        .catch(err => console.error('[api/analiza] sendNotifications failed', err))
    )

    return res.status(200).json({
      domain,
      overall,
      scores: { velocidad, seo, googleVisibility, herramientas, captacion },
    })
  } catch (err) {
    console.error('[api/analiza]', err)
    return res.status(500).json({ error: 'server_error' })
  }
}

async function fetchPageSpeed(url: string) {
  const key = process.env.PAGESPEED_API_KEY
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo${key ? `&key=${key}` : ''}`
  let res = await fetch(endpoint, { signal: AbortSignal.timeout(38000) }).catch((err) => {
    console.error('[fetchPageSpeed] intento 1 falló:', err?.message ?? err)
    return null
  })
  if (!res?.ok) {
    if (res) console.error('[fetchPageSpeed] intento 1 HTTP', res.status)
    await new Promise(r => setTimeout(r, 1500))
    res = await fetch(endpoint, { signal: AbortSignal.timeout(38000) }).catch((err) => {
      console.error('[fetchPageSpeed] intento 2 falló:', err?.message ?? err)
      return null
    })
  }
  if (!res?.ok) {
    if (res) console.error('[fetchPageSpeed] intento 2 HTTP', res.status)
    return null
  }
  const data = await res.json() as {
    lighthouseResult?: {
      runtimeError?: { code: string }
      categories?: Record<string, { score: number | null }>
    }
  }
  if (data.lighthouseResult?.runtimeError) return null
  const cats = data.lighthouseResult?.categories
  if (!cats) return null
  return {
    performance: (cats.performance?.score != null) ? Math.round(cats.performance.score * 100) : null,
    seo: (cats.seo?.score != null) ? Math.round(cats.seo.score * 100) : null,
  }
}

async function fetchSitemap(baseUrl: string): Promise<boolean> {
  const [sitemapRes, robotsRes] = await Promise.allSettled([
    fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(5000) }),
    fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(5000) }),
  ])
  if (sitemapRes.status === 'fulfilled' && sitemapRes.value.ok) {
    const text = await sitemapRes.value.text()
    if (text.includes('<urlset') || text.includes('<sitemapindex')) return true
  }
  if (robotsRes.status === 'fulfilled' && robotsRes.value.ok) {
    const text = await robotsRes.value.text()
    if (/^sitemap:\s*https?:\/\//im.test(text)) return true
  }
  return false
}

async function fetchHTML(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  const text = await res.text()
  return text.length > 500 ? text : null
}

function detectSignals(html: string) {
  const lower = html.toLowerCase()
  return {
    metaDesc: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{10}/i.test(html) ||
              /<meta[^>]+content=["'][^"']{10}[^"']*["'][^>]+name=["']description["']/i.test(html),
    ogImage: /<meta[^>]+property=["']og:image["']/i.test(html),
    noNoindex: !/<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html) &&
               !/<meta[^>]*content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(html),
    hasCanonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    hasSchema: html.includes('application/ld+json'),
    isJsFramework: html.includes('__NEXT_DATA__') || html.includes('/_next/static/') ||
                   html.includes('__NUXT__') || html.includes('astro-island') ||
                   html.includes('data-reactroot') || html.includes('__remixContext') ||
                   lower.includes('gatsby-'),
    hasTracking: lower.includes('googletagmanager.com') || lower.includes('datalayer') ||
                 lower.includes('google-analytics.com') || lower.includes('gtag.js') ||
                 lower.includes('posthog.com') || lower.includes('posthog.init') ||
                 lower.includes('i.posthog.com') || lower.includes('posthog-js'),
    hasPixel: lower.includes('connect.facebook.net') || lower.includes("fbq('init"),
    hasEmailMkt: ['mailchimp', 'klaviyo', 'hubspot', 'activecampaign', 'brevo', 'sendinblue']
      .some(s => lower.includes(s)),
    hasChat: ['intercom', 'drift.com', 'tidio', 'crisp.chat', 'tawk.to',
              'manychat', 'chatfuel', 'landbot', 'smartsupp', 'freshchat',
              'zopim', 'zendesk', 'chatbase', 'voiceflow', 'botpress',
              'leadconnector', 'msgsndr']
      .some(s => lower.includes(s)),
    hasForm: html.includes('<form') || html.includes('<Form') ||
             /type=["'](email|tel)["']/i.test(html) ||
             html.includes('<textarea') ||
             ['typeform.com', 'hsforms.com', 'jotform.com', 'formspree.io',
              'gravity', 'wpcf7', 'contact-form'].some(s => lower.includes(s)) ||
             lower.includes('wa.me') || lower.includes('api.whatsapp.com/send') ||
             lower.includes('calendly.com'),
    hasBlog: ['/blog', '/articulos', '/recursos', '/noticias', '/insights']
      .some(s => lower.includes(s)),
    hasNewsletter: ['newsletter', 'suscri', 'subscribe'].some(s => lower.includes(s)),
    socials: {
      linkedin: lower.includes('linkedin.com'),
      instagram: lower.includes('instagram.com'),
      facebook: lower.includes('facebook.com'),
      youtube: lower.includes('youtube.com'),
      tiktok: lower.includes('tiktok.com'),
      twitter: lower.includes('twitter.com') || lower.includes('//x.com'),
    },
  }
}

type Signals = ReturnType<typeof detectSignals>
type Scores = { velocidad: number | null; seo: number; googleVisibility: number | null; herramientas: number | null; captacion: number | null }

async function sendNotifications(email: string, domain: string, overall: number, scores: Scores, signals: Signals) {
  const bar = (n: number | null) => n === null ? '— no medible' : `${'█'.repeat(Math.round(n / 10))}${'░'.repeat(10 - Math.round(n / 10))} ${n}/100`
  const bool = (b: boolean) => b ? '✅' : '❌'

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return

  const resend = new Resend(resendKey)
  const to = process.env.INTERNAL_NOTIFY_EMAIL ?? 'director.arturo@artismamkt.com'

  await resend.emails.send({
    from: 'Artisma Analizador <notificaciones@artismamkt.com>',
    to,
    subject: `Nuevo diagnóstico: ${domain} — ${overall}/100`,
    html: `
      <h2 style="font-family:sans-serif">Nuevo diagnóstico de sitio web</h2>
      <table style="font-family:monospace;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><strong>Dominio</strong></td><td>${domain}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>${email}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>Score general</strong></td><td><strong>${overall}/100</strong></td></tr>
      </table>
      <h3 style="font-family:sans-serif;margin-top:24px">Scores por sección</h3>
      <pre style="background:#f5f5f5;padding:12px;border-radius:4px">
Velocidad:         ${bar(scores.velocidad)}
SEO:               ${bar(scores.seo)}
Visibilidad Google: ${bar(scores.googleVisibility)}
Herramientas:      ${bar(scores.herramientas)}
Captación:         ${bar(scores.captacion)}</pre>
      <h3 style="font-family:sans-serif;margin-top:24px">Señales detectadas</h3>
      <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:3px 16px 3px 0">Meta description</td><td>${bool(signals.metaDesc)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">OG Image</td><td>${bool(signals.ogImage)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">GA / GTM</td><td>${bool(signals.hasTracking)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Meta Pixel</td><td>${bool(signals.hasPixel)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Email marketing</td><td>${bool(signals.hasEmailMkt)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Chat</td><td>${bool(signals.hasChat)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Formulario</td><td>${bool(signals.hasForm)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Blog / Contenido</td><td>${bool(signals.hasBlog)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0">Newsletter</td><td>${bool(signals.hasNewsletter)}</td></tr>
      </table>
    `,
  }).catch(() => {})
}
