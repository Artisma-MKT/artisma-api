# artisma-api

Serverless API para el Analizador de sitios web de **artismamkt.com**.

## Contexto

Este proyecto existe como un servicio **separado** del sitio principal (artisma.com) por una razón puntual: el sitio principal está en modo estático (`output: 'export'` en Next.js) porque cuando se pasó a SSR, next-intl v4 rompió con `__dirname is not defined` en Edge Runtime de Vercel. Ver historial en `../artisma.com/` para detalles.

La decisión: dejar el sitio principal en estático, aislar la lógica del servidor aquí.

## Qué hace

Un solo endpoint: `POST /api/analiza`

Recibe `{ url, email }` de un formulario, y:

1. Llama a Google PageSpeed Insights API (mobile) — velocidad + SEO
2. Hace scraping del HTML del sitio (User-Agent Googlebot)
3. Detecta señales: GTM, Meta Pixel, chatbots, formularios, blog, newsletter, sitemap, etc.
4. Calcula 5 scores (velocidad, SEO, visibilidad Google, herramientas, captación) + un score general ponderado
5. Manda el resultado a un webhook de GHL (CRM)
6. Opcionalmente envía email vía Resend a `director.arturo@artismamkt.com`
7. Devuelve JSON con scores para que el frontend arme el reporte

## Estructura

```
artisma-api/
├── api/
│   └── analiza.ts       # el único endpoint
├── package.json
├── tsconfig.json
├── vercel.json          # CORS + config
├── .gitignore
└── CLAUDE.md            # este archivo
```

Nada de Next.js, React, Tailwind. Solo Node.js + tipos de Vercel.

## Formato de respuesta

Éxito (200):
```json
{
  "domain": "ejemplo.com",
  "overall": 62,
  "scores": {
    "velocidad": 45,
    "seo": 80,
    "googleVisibility": 60,
    "herramientas": 40,
    "captacion": 65
  },
  "token": "uuid-para-adjuntar-el-correo-despues"
}
```

En `mode: 'email'` la respuesta es `{ "ok": true }`.

Cualquier score puede ser `null` si no se pudo medir (ej. PageSpeed falló, sitio bloqueó scraping).

Errores:
- `400 invalid_input` — email o url vacíos/inválidos, o bot detectado
- `400 invalid_domain` — url no parseable
- `429 rate_limit_ip` — IP superó 3 análisis/día
- `429 duplicate_email` — email ya usó el servicio en los últimos 30 días
- `405 method_not_allowed` — no fue POST
- `500 server_error` — error interno

## Variables de entorno

Todas configurables en Vercel Dashboard → Settings → Environment Variables:

**Obligatorias:**
- `PAGESPEED_API_KEY` — Google Cloud Console → habilitar PageSpeed Insights API (gratis)

**Opcionales (recomendadas para producción):**
- `RESEND_API_KEY` — envía dos correos: el reporte al prospecto y la notificación interna. Sin esta variable no se manda ninguno de los dos (queda un `console.warn`).
- `RESEND_FROM` — remitente. Default: `Artisma <reportes@reportes.artismamkt.com>`. **Debe ser un dominio verificado en Resend** o el envío se rechaza.
- `INTERNAL_NOTIFY_EMAIL` — a quién enviar la notificación interna (default: director.arturo@artismamkt.com)
- `CALENDAR_URL` — link del botón "Agenda tu llamada" en el correo del reporte
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — activar rate limiting con Vercel KV
  - Sin estas, **no hay rate limit** (cualquiera puede llamar la API cuantas veces quiera)
  - También desactiva el cache de resultados, así que el opt-in de correo usa los scores que reenvía el cliente

## Correo: quién recibe qué

| Correo | Motor | Destinatario | Cuándo |
|---|---|---|---|
| Reporte con los scores + CTA al calendario | Resend | El prospecto | Inmediato, **solo desde landing pages** (`mode: 'email'`) |
| `Nuevo diagnóstico: [dominio] — [score]/100` | Resend | `INTERNAL_NOTIFY_EMAIL` | Al terminar el análisis, y otra vez si después llega el correo |
| Seguimiento comercial según el score | Workflow de GHL | El prospecto | 1 hora después de crearse el contacto |

El reporte por correo **no se manda desde la página principal**. Ahí el correo se pide antes de analizar, no es una solicitud del visitante, y el seguimiento lo cubre GHL. En las landing pages sí, porque la persona lo pidió explícitamente.

## El correo es opcional

La página principal lo pide antes de analizar. Las landing pages entregan el reporte sin pedirlo y lo ofrecen como opcional al final, porque ahí el objetivo es que agenden una llamada y el muro de correo compite con esa conversión.

Por eso el endpoint tiene dos modos:

- **Sin `mode`** — analiza el sitio. `email` es opcional. Devuelve `token`, que referencia el resultado cacheado una hora en KV.
- **`mode: 'email'`** — adjunta un correo a un análisis ya hecho. No reanaliza: recupera los scores por `token`. Sin KV acepta los scores que reenvía el cliente, saneados a enteros de 0 a 100.

Sin correo no se dispara el webhook de GHL: no hay contacto que crear. Se dispara después, si la persona pide los resultados desde el reporte.

## CORS

Configurado en `vercel.json` para aceptar solo peticiones desde `https://www.artismamkt.com`.

Si necesitas probar desde otro origen (localhost, preview deploys), agrégalo al `Access-Control-Allow-Origin` en `vercel.json` (Vercel no soporta wildcards con credenciales, hay que listar explícitamente).

## Deploy

Primera vez:

1. Crear repo en GitHub: `artismamkt/artismamkt-api`
2. Push del código:
   ```
   git init
   git add .
   git commit -m "initial"
   git remote add origin git@github.com:artismamkt/artismamkt-api.git
   git push -u origin main
   ```
3. En Vercel: Import Project → seleccionar el repo
4. Vercel detecta automáticamente que es un proyecto de Vercel Functions (no framework)
5. Configurar env vars (ver arriba)
6. Deploy

### Subdominio

En Vercel → Settings → Domains: agregar `api.artismamkt.com`.

En el DNS de artismamkt.com (donde tengas el dominio): crear registro CNAME:
```
Type: CNAME
Name: api
Value: cname.vercel-dns.com
```

Vercel emitirá cert TLS automático.

## Desarrollo local

```
npm install
npm run dev
```

`vercel dev` levanta el endpoint en `http://localhost:3000/api/analiza`. Necesitas Vercel CLI instalado global:

```
npm i -g vercel
vercel login
vercel link    # asocia esta carpeta con el proyecto de Vercel
```

Para probarlo:
```
curl -X POST http://localhost:3000/api/analiza \
  -H "Content-Type: application/json" \
  -d '{"url":"artismamkt.com","email":"test@example.com","_ms":5000}'
```

## Cómo se conecta con el sitio principal

El componente `Analizador.tsx` en el sitio principal hace:

```ts
const res = await fetch('https://api.artismamkt.com/api/analiza', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, email, _hp: '', _ms: Date.now() - mountedAt })
})
```

Si cambias el formato de respuesta aquí, hay que actualizar el componente allá también.

## Webhooks GHL (producción)

Hardcoded al inicio de `api/analiza.ts`:

- `WEBHOOK_GHL` — webhook original de contacto (poco usado por esta ruta)
- `WEBHOOK_DIAGNOSTICO` — el importante: recibe correo + página + todos los scores

Si GHL cambia esos URLs, actualízalos ahí.

## Anti-abuso (defensa en profundidad)

1. **Honeypot** — campo `_hp` invisible en el form. Si llega con contenido, es bot.
2. **Timing** — `_ms` es milisegundos desde que se montó el form. Si es < 2000ms, es bot.
3. **Validación de email** — regex simple.
4. **Rate limit por IP** — 3 análisis/día (solo si KV está configurado).
5. **Rate limit por email** — 1 análisis por email cada 30 días (solo si KV está configurado).
6. **CORS** — solo acepta peticiones desde artismamkt.com.

## Cosas que NO hay que hacer

- **No agregar más rutas.** Este proyecto es exclusivamente para el analizador. Si necesitas otro endpoint, crea otro proyecto o considera consolidar todo en el sitio principal (si el problema de next-intl se resuelve).
- **No importar librerías de UI/framework.** Solo Node.js estándar + `resend` + `@vercel/kv`.
- **No hardcodear API keys.** Todas van en env vars.

## Debugging en producción

Vercel Dashboard → Deployments → click en el deploy → Functions tab → logs.

Los `console.error('[api/analiza]', err)` aparecen ahí.

## Costo

Plan Hobby de Vercel:
- 100 GB-Hours de Serverless Function execution → sobra
- 100k invocaciones/mes → sobra
- Vercel KV plan gratis: 30k comandos/mes → alcanza para ~10k análisis

Total: **$0** mientras estemos en volúmenes bajos.
