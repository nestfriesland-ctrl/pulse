# mathijs-os v2 — Systeem Documentatie

Cowork-native trading intelligence. Geen lokale daemon, geen Qwen.
Claude is het brein. Hyblock is de data. Telegram is de interface.

## Architectuur

```
Cowork Skills (brein)
  ├── hyblock skill      → research cycles, signal backtesting
  ├── scheduled tasks    → polling, alert push
  └── on-demand          → "hoe staat BTC", "push report"

mathijs-os-report repo (dit)
  ├── index.html         → live dashboard (Vercel auto-deploy)
  ├── lib/
  │   ├── telegram.py    → TG push (bot API, zero deps)
  │   ├── hyblock.py     → Hyblock API client (zero deps)
  │   └── report.py      → HTML report generator
  ├── config.env.example → credentials template
  └── docs/SYSTEM.md     → dit document

Flow:
1. Scheduled task (Cowork, elke 15 min)
   → pull Hyblock data via lib/hyblock.py
   → check signals (logic defined in hyblock skill)
   → if signal fires: push via lib/telegram.py
   → regenerate index.html via lib/report.py
   → git push → Vercel auto-deploy

2. Research cycle (on-demand via hyblock skill)
   → backtest signal hypotheses
   → rewrite hyblock SKILL.md with measured results
   → push to hyblock-skill repo

3. Ad-hoc (Cowork chat)
   → "hoe staat BTC" → live scan + TG push
   → "push report" → generate + push + deploy
```

## Credentials

Zie `config.env.example` — alle keys uit v1 geëxtraheerd.

| Var | Wat | Status |
|-----|-----|--------|
| TG_BOT_TOKEN | Telegram @mathijsdeluxebot | ✅ actief |
| TG_CHAT_ID | 562277869 (@Mathijs_EchtFit) | ✅ actief |
| HB_CLIENT_ID | Hyblock OAuth | ✅ actief |
| HB_CLIENT_SECRET | Hyblock OAuth | ✅ actief |
| HB_API_KEY | Hyblock x-api-key | ✅ actief |
| NANSEN_API_KEY | Smart money flows | 🔲 nog niet geïntegreerd |
| COINGLASS_API_KEY | Onchain + macro (18 endpoints) | 🔲 nog niet geïntegreerd |
| VERCEL_DEPLOY_SKYLD | Skyld portal deploy hook | 🔲 bewaard |
| VERCEL_DEPLOY_NEST | NEST website deploy hook | 🔲 bewaard |

## Signal Logic

Signalen worden gedefinieerd en getest in de hyblock skill.
Na PROVEN status worden ze hier als alerting rules geïmplementeerd.

### Huidige signals (na cycle 1)

| Signal | Status | Horizon | WR | Avg | Sharpe |
|--------|--------|---------|----|----|--------|
| S1 CVD div (unfiltered) | REFINE | 7d | 73.2% | +1.77% | 0.44 |
| S1 CVD div (strong) | REFINE | 7d | 80.3% | +2.45% | 0.66 |
| S1 CVD div (intraday) | ANTI-PATTERN | 1h-24h | <50% | neg | neg |
| S2 Retail long% | UNTESTED | — | — | — | — |
| S3 Bid-ask ratio | UNTESTED | — | — | — | — |
| S4 Funding reversion | UNTESTED | — | — | — | — |
| S5 OI cluster | UNTESTED | — | — | — | — |

## v1 Analyse — wat is nuttig, wat niet

Geëxtraheerd uit HANDOVER.md (15 maart 2026). Het oude systeem was ~18.800 regels
Python over 25+ bestanden. Hier de triage:

### ✅ Hergebruikt in v2
- TG bot token + chat ID (562277869)
- HTML dark luxury theme (report_renderer.py → lib/report.py)
- Hyblock API kennis (veldnamen, endpoint mapping → lib/hyblock.py + hyblock skill)
- Signal hypotheses S1-S5 (→ hyblock skill SIGNALS sectie)
- Cascade paper findings (ATR% = #1 predictor, RFI concept)

### 🔲 Nog te integreren (waardevol)
- Nansen API (smart money flows) — key bewaard, client nog bouwen
- CoinGlass API (18 endpoints, onchain + macro) — key bewaard, client nog bouwen
- Kraken spot prijs + VWAP — vervangen door simpele API call
- Regime classificatie (MOMENTUM/ACCUMULATIE/DISTRIBUTIE/CAPITULATIE/CHOP)
- Cascade Risk Index (CRI 0-10, 5 componenten)
- Virtual trades concept (setup → SL/TP → 7d outcome tracking)

### ❌ Niet meer nodig
- Qwen 72B lokaal (vervangen door Claude via Cowork)
- Examinator (LLM-op-LLM review — het probleem dat v2 oplost)
- core.py daemon loop (vervangen door Cowork scheduled tasks)
- 25+ Python skill bestanden (vervangen door 3 clean modules)
- Ollama integratie
- Mac hardware dependency

### 📋 Ideeën uit v1 roadmap (bewaard voor later)
- Bayesiaans P(bull 24h) model (edge.py concept)
- Thesis engine 4x/dag
- Multi-coin swing scanner
- OI cluster mapping als magneet-theorie

## Verwijzingen

- hyblock skill: `nestfriesland-ctrl/hyblock-skill` (SKILL.md = levend document)
- Dashboard: mathijs-os-report.vercel.app
- Telegram bot: @mathijsdeluxebot (chat ID: 562277869)
- Archive v1: branch `archive/v1` in dit repo
- v1 repo: `nestfriesland-ctrl/Mathijs-OS` (privé, op Mac)
