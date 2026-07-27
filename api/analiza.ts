import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import { Resend } from 'resend'
import { randomUUID } from 'node:crypto'

const WEBHOOK_DIAGNOSTICO = 'https://services.leadconnectorhq.com/hooks/21Q9Ac26brV00Bu7vffn/webhook-trigger/46cf2dc2-7f69-4d43-a587-efc5243d6c70'

const CALENDAR_URL = process.env.CALENDAR_URL ?? 'https://links.artismamkt.com/widget/booking/R2GlUF85rT7113z54MEW'

// Vercel retiro su producto KV propio: el almacenamiento ahora se conecta
// desde el Marketplace, y segun el proveedor las variables llegan como
// KV_REST_API_* (Upstash via la integracion de Vercel) o como
// UPSTASH_REDIS_REST_* . Se aceptan ambos nombres para que conectar el
// store no dependa de cual haya elegido quien lo configuro.
let kvClient: Awaited<ReturnType<typeof buildKv>> = null

async function buildKv() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  const { createClient } = await import('@vercel/kv')
  return createClient({ url, token })
}

async function getKv() {
  if (kvClient === null) kvClient = await buildKv()
  return kvClient
}

const kvEnabled = () =>
  Boolean((process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) &&
          (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN))

// Debe salir de un dominio verificado en Resend o el envio se rechaza.
const RESEND_FROM = process.env.RESEND_FROM ?? 'Artisma <reportes@reportes.artismamkt.com>'

const SECTION_LABELS: Array<[keyof Scores, string]> = [
  ['velocidad', 'Velocidad y experiencia en el celular'],
  ['seo', 'Qué tan fácil te encuentran'],
  ['googleVisibility', 'Si Google puede leer tu sitio'],
  ['herramientas', 'Medición de visitantes'],
  ['captacion', 'Facilidad para contactarte'],
]

const scoreColor = (n: number | null) =>
  n === null ? '#888888' : n >= 75 ? '#3f9c54' : n >= 50 ? '#a8862c' : '#c4453c'

// Barras en HTML, no caracteres de bloque dentro de un <pre>: los clientes
// de correo no garantizan una fuente monoespaciada y las etiquetas de
// distinto largo desalinean las barras.
function scoreRowsHtml(scores: Scores) {
  return SECTION_LABELS.map(([key, label]) => {
    const v = scores[key]
    return `
      <tr>
        <td style="padding:10px 0 2px;font:14px/1.4 sans-serif;color:#333">${label}</td>
        <td style="padding:10px 0 2px;font:600 14px/1.4 sans-serif;color:${scoreColor(v)};text-align:right;white-space:nowrap">${v === null ? '—' : `${v}/100`}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 6px">
          <div style="height:6px;background:#ececec;border-radius:3px;font-size:0;line-height:0">
            <div style="height:6px;width:${v ?? 0}%;background:${scoreColor(v)};border-radius:3px"></div>
          </div>
        </td>
      </tr>`
  }).join('')
}

// Cada banda cierra con un siguiente paso concreto: un veredicto solo
// diagnostica, y el correo tiene que dejar claro que sigue. Las
// recomendaciones van alineadas con los tres workflows de GHL.
function overallVerdict(n: number): { verdict: string; next: string } {
  if (n >= 85) return {
    verdict: 'Tu sitio tiene bases sólidas.',
    next: 'Tu sitio ya no es el cuello de botella, así que lo que mueve la aguja ahora es la prospección activa: campañas de Google Ads con landing pages diseñadas para B2B, o correo en frío dirigido a tomadores de decisión de tu industria.',
  }
  if (n >= 65) return {
    verdict: 'Tu sitio está bien, pero puede ir mucho más lejos.',
    next: 'La base técnica está. Lo que falta es contenido constante — artículos en blog y LinkedIn — para que el sitio traiga prospectos de forma sostenida y no solo cuando hay presupuesto de anuncios.',
  }
  if (n >= 40) return {
    verdict: 'Tu sitio tiene oportunidades claras de mejora.',
    next: 'Hay conversión que se está quedando en la mesa. Un rediseño enfocado en captación suele ser el primer paso, acompañado de contenido para sostener el tráfico en el tiempo.',
  }
  return {
    verdict: 'Tu sitio necesita atención urgente.',
    next: 'Varias áreas están por debajo de lo que necesita una empresa B2B para generar prospectos en línea. El primer paso es un rediseño que resuelva la captación desde la estructura, no con parches.',
  }
}

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
    const { url, email, _hp, _ms, mode, token } = req.body as {
      url: string; email?: string; _hp?: string; _ms?: number; mode?: string; token?: string
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

    // Modo 'email': en las landing pages el reporte se entrega sin pedir
    // correo, y este se ofrece como opcional al final. Aqui solo se adjunta
    // al analisis que ya se hizo — no se vuelve a analizar el sitio.
    if (mode === 'email') {
      if (!email?.trim() || !EMAIL_RE.test(email.trim())) {
        return res.status(400).json({ error: 'invalid_input' })
      }
      return await handleEmailOptIn(res, email.trim(), url, token, req.body as Record<string, unknown>)
    }

    if (_hp || (_ms !== undefined && _ms < 2000)) {
      return res.status(400).json({ error: 'invalid_input' })
    }

    // El correo es opcional: la pagina principal lo pide por adelantado,
    // las landing pages no.
    if (!url?.trim() || (email?.trim() && !EMAIL_RE.test(email.trim()))) {
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

    const kvRead = await getKv()
    if (kvRead) {
      const kv = kvRead
      const forwardedFor = req.headers['x-forwarded-for']
      const ip = typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim() ?? 'unknown'
        : 'unknown'
      const ipKey = `analiza:ip:${ip}`

      const [ipCount, emailExists] = await Promise.all([
        kv.get<number>(ipKey),
        email?.trim() ? kv.get(`analiza:email:${email.trim().toLowerCase()}`) : Promise.resolve(null),
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
    const scores: Scores = { velocidad, seo, googleVisibility, herramientas, captacion }
    const resultToken = randomUUID()

    const kvWrite = await getKv()
    if (kvWrite) {
      const kv = kvWrite
      const forwardedFor = req.headers['x-forwarded-for']
      const ip = typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim() ?? 'unknown'
        : 'unknown'
      const ipKey = `analiza:ip:${ip}`
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      const ipTtl = Math.floor((midnight.getTime() - now.getTime()) / 1000)
      const currentCount = await kv.get<number>(ipKey) ?? 0
      await Promise.all([
        kv.set(ipKey, currentCount + 1, { ex: ipTtl }),
        // El resultado se cachea una hora para que, si el visitante pide el
        // correo despues de ver el reporte, no haya que reanalizar el sitio.
        kv.set(`analiza:token:${resultToken}`, { domain, overall, scores }, { ex: 60 * 60 }),
        email?.trim()
          ? kv.set(`analiza:email:${email.trim().toLowerCase()}`, domain, { ex: 60 * 60 * 24 * 30 })
          : Promise.resolve(),
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

    // Sin correo no hay contacto que crear en GHL. En ese caso el analisis
    // solo se notifica internamente; el webhook se dispara despues, si el
    // visitante pide los resultados por correo desde el reporte.
    if (email?.trim()) {
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
    }

    waitUntil(
      sendNotifications(email?.trim() || null, domain, overall, scores, signals)
        .catch(err => console.error('[api/analiza] sendNotifications failed', err))
    )

    return res.status(200).json({ domain, overall, scores, token: resultToken })
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
    if (res) {
      const body = await res.text().catch(() => '')
      console.error('[fetchPageSpeed] intento 1 HTTP', res.status, 'url=', url, 'keyPresent=', !!key, 'body=', body.slice(0, 500))
    }
    await new Promise(r => setTimeout(r, 1500))
    res = await fetch(endpoint, { signal: AbortSignal.timeout(38000) }).catch((err) => {
      console.error('[fetchPageSpeed] intento 2 falló:', err?.message ?? err)
      return null
    })
  }
  if (!res?.ok) {
    if (res) {
      const body = await res.text().catch(() => '')
      console.error('[fetchPageSpeed] intento 2 HTTP', res.status, 'body=', body.slice(0, 500))
    }
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

type CachedResult = { domain: string; overall: number; scores: Scores }

// Envia los resultados al prospecto. Solo se usa desde handleEmailOptIn,
// es decir, unicamente en las landing pages: ahi la persona pide el correo
// de forma explicita y hay que cumplirlo.
//
// La pagina principal no lo manda a proposito. Ahi el correo se pide antes
// de analizar, no como una solicitud del visitante, y el seguimiento lo
// cubren los workflows de GHL. Mandar ademas este correo seria duplicar.
async function sendReportEmail(email: string, domain: string, overall: number, scores: Scores) {
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) {
    console.warn('[api/analiza] RESEND_API_KEY ausente — no se envio el reporte a', email)
    return
  }

  await new Resend(resendKey).emails.send({
    from: RESEND_FROM,
    to: email,
    subject: `Tu diagnóstico web: ${domain} — ${overall}/100`,
    html: `
      <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:sans-serif;color:#222">
        <p style="font:600 11px/1 sans-serif;letter-spacing:2px;text-transform:uppercase;color:#a8862c;margin:0 0 16px">Diagnóstico web</p>
        <h1 style="font:600 22px/1.3 sans-serif;margin:0 0 6px">${domain}</h1>
        <p style="font:15px/1.5 sans-serif;color:#555;margin:0 0 28px">${overallVerdict(overall).verdict}</p>

        <div style="text-align:center;padding:24px 0;border-top:1px solid #e6e6e6;border-bottom:1px solid #e6e6e6;margin-bottom:8px">
          <div style="font:700 40px/1 sans-serif;color:${scoreColor(overall)}">${overall}<span style="font-size:18px;color:#999">/100</span></div>
          <div style="font:11px/1 sans-serif;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-top:8px">Puntuación general</div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:32px">${scoreRowsHtml(scores)}</table>

        <div style="padding-top:24px;border-top:1px solid #e6e6e6">
          <h2 style="font:600 13px/1 sans-serif;letter-spacing:1px;text-transform:uppercase;color:#999;margin:0 0 12px">El siguiente paso</h2>
          <p style="font:15px/1.6 sans-serif;color:#444;margin:0 0 24px">${overallVerdict(overall).next}</p>
        </div>

        <div style="text-align:center">
          <p style="font:15px/1.5 sans-serif;color:#555;margin:0 0 20px">Lo revisamos contigo en 45 minutos y te decimos qué haríamos primero. La llamada es sin costo.</p>
          <a href="${CALENDAR_URL}" style="display:inline-block;background:#1a1a1a;color:#ffffff;font:600 14px/1 sans-serif;text-decoration:none;padding:14px 28px;border-radius:6px">Agenda tu llamada</a>
        </div>

        <p style="font:12px/1.5 sans-serif;color:#999;margin:32px 0 0;text-align:center">
          Recibes esto porque solicitaste un diagnóstico en artismamkt.com<br>Artisma · contacto@artismamkt.com
        </p>
      </div>
    `,
  })
}

const clampScore = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

// Adjunta un correo a un analisis ya realizado. No vuelve a analizar el
// sitio: recupera los scores del cache por token.
//
// Sin Vercel KV el cache no existe, asi que se aceptan los scores que
// reenvia el cliente. Son datos publicos de rendimiento y el peor caso es
// un contacto con cifras falsas en GHL — el mismo riesgo que ya existe al
// poder enviar cualquier correo. Perder los scores, en cambio, romperia
// los workflows de GHL que dependen de ellos.
async function handleEmailOptIn(
  res: VercelResponse,
  email: string,
  url: string | undefined,
  token: string | undefined,
  body: Record<string, unknown>,
) {
  let cached: CachedResult | null = null
  let domain = ''

  try {
    domain = new URL(`https://${(url ?? '').trim().replace(/^https?:\/\//, '')}`).hostname.replace(/^www\./, '')
  } catch {
    domain = ''
  }

  const kv = await getKv()
  if (kv) {
    const emailKey = `analiza:email:${email.toLowerCase()}`

    if (await kv.get(emailKey)) {
      return res.status(429).json({ error: 'duplicate_email' })
    }

    if (token) {
      cached = await kv.get<CachedResult>(`analiza:token:${token}`)
      if (cached?.domain) domain = cached.domain
    }

    await kv.set(emailKey, domain, { ex: 60 * 60 * 24 * 30 })
  }

  if (!domain) return res.status(400).json({ error: 'invalid_domain' })

  const fallback = (body.scores ?? {}) as Record<string, unknown>
  const s = cached?.scores ?? {
    velocidad: clampScore(fallback.velocidad),
    seo: clampScore(fallback.seo),
    googleVisibility: clampScore(fallback.googleVisibility),
    herramientas: clampScore(fallback.herramientas),
    captacion: clampScore(fallback.captacion),
  }
  const overall = cached?.overall ?? clampScore(body.overall)

  try {
    const r = await fetch(WEBHOOK_DIAGNOSTICO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        correo: email,
        pagina_web: domain,
        score_general: overall,
        score_velocidad: s?.velocidad ?? 0,
        score_seo: s?.seo ?? 0,
        score_visibilidad_google: s?.googleVisibility ?? 0,
        score_herramientas: s?.herramientas ?? 0,
        score_captacion: s?.captacion ?? 0,
      }),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error('[api/analiza] WEBHOOK_DIAGNOSTICO non-2xx', r.status, body.slice(0, 300))
    }
  } catch (err) {
    console.error('[api/analiza] WEBHOOK_DIAGNOSTICO failed', err)
  }

  if (!cached) {
    console.warn('[api/analiza] email opt-in sin cache, usando scores del cliente', {
      domain,
      hasToken: Boolean(token),
      kvEnabled: kvEnabled(),
    })
  }

  waitUntil(
    sendReportEmail(email, domain, overall, s)
      .catch(err => console.error('[api/analiza] sendReportEmail failed', err))
  )

  // El aviso interno del analisis salio marcado "(sin correo)"; sin este
  // segundo aviso no habria forma de enterarse por correo de que la
  // persona si lo dejo despues.
  waitUntil(
    sendNotifications(email, domain, overall, s, null)
      .catch(err => console.error('[api/analiza] sendNotifications failed', err))
  )

  return res.status(200).json({ ok: true })
}

async function sendNotifications(email: string | null, domain: string, overall: number, scores: Scores, signals: Signals | null) {
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return

  const resend = new Resend(resendKey)
  const to = process.env.INTERNAL_NOTIFY_EMAIL ?? 'director.arturo@artismamkt.com'

  const flag = (ok: boolean, label: string) => `
    <td width="50%" style="padding:5px 0;font:14px/1.4 sans-serif;color:${ok ? '#333' : '#c4453c'}">
      <span style="display:inline-block;width:16px">${ok ? '&#10003;' : '&#10005;'}</span>${label}
    </td>`

  const signalRows = signals ? [
    [signals.metaDesc, 'Meta description', signals.ogImage, 'OG Image'],
    [signals.hasTracking, 'GA / GTM', signals.hasPixel, 'Meta Pixel'],
    [signals.hasEmailMkt, 'Email marketing', signals.hasChat, 'Chat'],
    [signals.hasForm, 'Formulario', signals.hasBlog, 'Blog / Contenido'],
    [signals.hasNewsletter, 'Newsletter', null, ''],
  ].map(([a, la, b, lb]) =>
    `<tr>${flag(Boolean(a), String(la))}${b === null ? '<td></td>' : flag(Boolean(b), String(lb))}</tr>`
  ).join('') : ''

  await resend.emails.send({
    from: RESEND_FROM,
    to,
    subject: `Nuevo diagnóstico: ${domain} — ${overall}/100${email ? '' : ' (sin correo)'}`,
    html: `
      <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:sans-serif;color:#222">
        <p style="font:600 11px/1 sans-serif;letter-spacing:2px;text-transform:uppercase;color:#a8862c;margin:0 0 16px">Nuevo diagnóstico</p>
        <h1 style="font:600 22px/1.3 sans-serif;margin:0 0 24px">${domain}</h1>

        <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
          <tr>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;font:14px/1.4 sans-serif;color:#777">Contacto</td>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;font:14px/1.4 sans-serif;color:${email ? '#222' : '#c4453c'};text-align:right">${email ?? 'No lo dejó'}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;font:14px/1.4 sans-serif;color:#777">Score general</td>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;font:700 18px/1.2 sans-serif;color:${scoreColor(overall)};text-align:right">${overall}/100</td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;border-bottom:1px solid #e6e6e6;font:14px/1.4 sans-serif;color:#777">Veredicto</td>
            <td style="padding:8px 0;border-top:1px solid #e6e6e6;border-bottom:1px solid #e6e6e6;font:14px/1.4 sans-serif;color:#555;text-align:right">${overallVerdict(overall).verdict}</td>
          </tr>
        </table>

        <h2 style="font:600 13px/1 sans-serif;letter-spacing:1px;text-transform:uppercase;color:#999;margin:28px 0 4px">Scores por sección</h2>
        <table style="width:100%;border-collapse:collapse">${scoreRowsHtml(scores)}</table>

        ${signals ? `
        <h2 style="font:600 13px/1 sans-serif;letter-spacing:1px;text-transform:uppercase;color:#999;margin:28px 0 4px">Señales detectadas</h2>
        <table style="width:100%;border-collapse:collapse">${signalRows}</table>` : ''}
      </div>
    `,
  }).catch(err => console.error('[api/analiza] resend send failed', err))
}
