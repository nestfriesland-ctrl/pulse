# press.me — DNS / Vercel / Resend setup

Stappen voor Mathijs om de stack live te zetten zodra de code-PRs gemerged zijn. Geen van deze stappen wordt door Claude uitgevoerd.

## 1. Cloudflare — domein toevoegen

1. Log in op Cloudflare → **Add a site** → `press.me` → Free plan
2. Cloudflare scanned bestaande records — keur ze allemaal goed of leeg ze
3. Cloudflare geeft 2 nameservers (`xxx.ns.cloudflare.com`, `yyy.ns.cloudflare.com`)
4. Bij de registrar waar je `press.me` hebt geclaimd → nameservers omzetten naar de Cloudflare-paar
5. Wacht op nameserver-propagatie (1–24u; meestal <1u). Cloudflare-dashboard meldt "Active".

## 2. Cloudflare — DNS records

Voeg deze records toe (proxy = **DNS only**, het grijze wolkje, niet oranje — Vercel & Resend wantrouwen Cloudflare-proxy):

| Type  | Name              | Content                                  | TTL   | Proxy |
|-------|-------------------|------------------------------------------|-------|-------|
| A     | `@`               | `76.76.21.21`                            | Auto  | DNS only |
| A     | `*`               | `76.76.21.21`                            | Auto  | DNS only |
| CNAME | `www`             | `cname.vercel-dns.com`                   | Auto  | DNS only |
| MX    | `@`               | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | Auto | — |
| TXT   | `@`               | `v=spf1 include:amazonses.com -all`      | Auto  | — |
| TXT   | `_dmarc`          | `v=DMARC1; p=none`                       | Auto  | — |
| TXT   | `resend._domainkey` | _DKIM-waarde uit Resend-dashboard_     | Auto  | — |

**Let op:** de DKIM-record (`resend._domainkey`) krijg je pas nadat je het domein in Resend hebt toegevoegd (stap 4). Voeg de A-records, MX, SPF, DMARC nu toe; DKIM volgt.

## 3. Vercel — domein attachen

1. Vercel-dashboard → project **pulse** → **Settings → Domains**
2. **Add** → `press.me` → "Add"
3. **Add** → `*.press.me` → "Add" (wildcard subdomeinen)
4. Vercel verifieert via de A-records uit stap 2. Dit duurt ~1–5 min.
5. HTTPS-certificaten worden automatisch uitgegeven (Let's Encrypt, ~1 min)
6. Verifieer:
   - `https://press.me` → laadt pulse-dashboard
   - `https://mathijs.press.me` → laadt pulse, research-katern als default landing
   - `https://tara.press.me` → laadt pulse, research-katern voor tara

## 4. Resend — domein + inbound webhook

1. Resend-dashboard → **Domains** → **Add Domain** → `press.me`
2. Resend toont een DKIM-TXT-record (selector `resend._domainkey`). Voeg toe in Cloudflare (stap 2) en kom terug.
3. Klik **Verify Domain** in Resend. SPF + DKIM + DMARC moeten alle drie groen worden.
4. Resend → **Inbound** → **Add Endpoint** (of "Webhook Rule" — UI varieert per release):
   - **Match:** `to: mathijs@press.me` _OF_ catch-all `*@press.me` voor schaalbaarheid
   - **Webhook URL:** `https://press.me/api/research-inbox`
   - **Method:** POST
   - **Signing secret:** genereer met `openssl rand -hex 32`. **Bewaar deze waarde** — heb je in stap 5 nodig.
5. Voeg een tweede rule toe voor `to: tara@press.me` met dezelfde webhook URL en hetzelfde signing-secret. Of laat de catch-all alles afhandelen.

## 5. Vercel — env-vars

1. Vercel-dashboard → project **pulse** → **Settings → Environment Variables**
2. Bestaande variabele:
   - `GITHUB_PAT` (al gezet, niets aan doen)
3. Nieuwe variabele:
   - **Name:** `RESEND_WEBHOOK_SECRET`
   - **Value:** de waarde uit stap 4.4 (de `openssl rand -hex 32`-output)
   - **Environments:** Production, Preview, Development
4. **Save**
5. **Redeploy** de huidige main (Deployments → laatste deploy → ⋯ → Redeploy) zodat de env-var live komt.

## 6. End-to-end test

1. Vanaf gmail: stuur mail naar `mathijs@press.me`
   - Subject: `[NEST] test claim`
   - Body: `Hello pulse`
2. Resend-dashboard → **Inbound logs** → check dat de mail binnenkwam en de webhook 200 retourneerde
3. GitHub: kijk op `nestfriesland-ctrl/wiki` main — er zou een nieuwe commit moeten zijn:
   - `research(mathijs): claim YYYY-MM-DD-nest-test-claim`
4. Browser: open `https://mathijs.press.me`. Research-katern moet de claim in de strip tonen, met `[NEST]` tag.
5. Herhaal stap 1 met `tara@press.me` en open `https://tara.press.me` om tara's tree te checken.

## 7. Rollback / debug

- **Webhook retourneert 401:** signing-secret mismatch tussen Resend en Vercel. Check stap 4.4 vs 5.3.
- **Webhook retourneert 400 "unknown recipient":** `to`-veld is niet `mathijs@press.me` of `tara@press.me`. Check Resend-rule of payload-shape.
- **Webhook retourneert 502 GET/PUT failed:** PAT mist permissions of repo-naam stopgezet. Check `GITHUB_PAT`-scope (`repo` write op `nestfriesland-ctrl/wiki`).
- **HTTPS werkt op apex maar niet op subdomain:** de wildcard `*.press.me` is mogelijk nog niet geverifieerd. Vercel-dashboard → Domains, kijk of de wildcard groen is.
