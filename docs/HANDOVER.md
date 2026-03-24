# HANDOVER — 15 maart 2026 (avond)

## MATHIJS-OS: Volledige systeemoverdracht

Dit document vervangt alle eerdere handovers (gearchiveerd in docs/archive/). Lees dit volledig voordat je begint. Dan CLAUDE.md. Dan het relevante plan-document.

## 1. WAT IS MATHIJS-OS

Persoonlijk crypto trading intelligence systeem van Mathijs Dijkstra. Telegram bot + Qwen 72B lokaal + Hyblock/Kraken/Nansen/CoinGlass APIs.

- **Repo:** nestfriesland-ctrl/Mathijs-OS (ook greute-OS remote naam)
- **Lokaal:** ~/mathijs-os/ op M4 Max 128GB
- **Codebase:** ~18.800 regels Python over 25+ bestanden
- **Runtime:** Python 3.9 op macOS. `from __future__ import annotations` voor type hints.
- **Filosofie:** Data → Score → LLM → Deliver. Observe-only, geen live trading executie.
- **Taal:** Nederlands in comments/prompts/TG output, Engels in code identifiers.

### Hardware

- **Actief:** MacBook Pro M4 Max 128GB — Qwen 2.5 72B (~42GB, 81/81 layers Metal)
- **Besteld:** Mac Studio M3 Ultra 512GB — meerdere modellen simultaan (Fase 2)

### Vercel Projecten

- **skyld-portal** — SKYLD B2B ice cream portal
- **Nest-website-v2** — NEST Wellness website (i18n: nl/en/de/fy)
- **mathijs-os-report** — Morning Report statische HTML (nieuw, deze sessie)
  - Domein: mathijs-os-report.vercel.app
  - Repo: nestfriesland-ctrl/mathijs-os-report
  - Deploy: elke git push naar main

## 2. CREDENTIALS

- **Repo PAT:** (gebruik token uit git remote, Mathijs revoket per sessie)
- **Git identiteit:** mathijs@i-seo.nl / Mathijs
- **TG bot token:** 8321756067:AAG1nwhHSjcKnlq_MdJGu8gymjSKHt6d0sY
- **HYBLOCK:** in .env: HYBLOCK_CLIENT_ID / HYBLOCK_CLIENT_SECRET / HYBLOCK_API_KEY
- **NANSEN_API_KEY:** ndy7OWuwOxt6JeKBWlUERHzQrm7nc4UA
- **COINGLASS_API_KEY:** 51b9f05882874932a2b87ec549bde33f
- **Vercel SKYLD deploy hook:** https://api.vercel.com/v1/integrations/deploy/prj_JNDrbfl5w3z7qqK0NEHGRe5W4T4k/9yDnLwSZSg
- **Vercel NEST deploy hook:** https://api.vercel.com/v1/integrations/deploy/prj_34QfdsuLQf716BhnfkJTiAeR04NI/shQFSDeFst
- **Test emails:** mathijs@i-seo.nl + info@tarapalermo.nl

## 3. DEPLOY PROTOCOL

```bash
# Normaal deploy (na merge):
git push origin main && bash bin/deploy

# Feature branch workflow:
git fetch origin
git merge origin/<branch> --no-edit
git push origin main
bash bin/deploy

# BELANGRIJK: bin/deploy doet `git fetch && git reset --hard origin/main`
# Dus ALTIJD eerst pushen naar main VOORDAT je deploy runt.
# Volgorde: merge → push → deploy. Anders overschrijft deploy je lokale merge.

# Syntax validatie (Python 3.9!):
python3 -c "import ast; ast.parse(open('file.py').read())"
# Python 3.9 staat geen backslash (\u, \n) in f-string expressies toe.
# Gebruik .format() of pre-compute variabelen voor unicode in conditionals.
```

## 4. ARCHITECTUUR OVERZICHT

```
Telegram ←→ core.py (2448 regels, hart van het systeem)
                │
                ├── signal_engine.py (532) — Hyblock dossier generator
                │
                ├── skills/
                │   ├── sentinel.py (1654) — regime monitor, 15min polling, alerts
                │   ├── hyblock_signals.py (1060) — S1-S5 samengestelde signalen
                │   ├── hyblock.py (1024) — raw Hyblock API client
                │   ├── briefing.py (710) — ochtend setups via Qwen 72B
                │   ├── edge.py (662) — Bayesiaans P(bull 24h) model
                │   ├── cascade_risk.py (341) — CRI 0-10 (Hyblock paper)
                │   ├── technicals.py (672) — MA/EMA 200 + volatility features
                │   ├── report_renderer.py (484) — HTML dashboard + TG summary
                │   ├── examinator.py (462) — Claude API review (wordt optioneel)
                │   ├── actions_log.py (550) — setup tracking + 24/48h outcomes
                │   ├── positions.py (361) — handmatige positie tracking
                │   ├── kraken.py (360) — spot prijs + VWAP + orderbook
                │   ├── coinglass.py (625) — onchain + macro (18 endpoints)
                │   ├── nansen.py (315) — smart money flows
                │   ├── trade_manager.py (791) — actieve trade monitoring
                │   ├── signal_calc.py (518) — mechanical setups
                │   ├── confluence.py (690) — multi-signal scoring
                │   ├── thesis_engine.py (752) — thesis generator (4x/dag)
                │   ├── macro_signals.py (752) — cross-asset macro assessment
                │   ├── intel.py (597) — screenshot/URL analyse via minicpm-v
                │   ├── backtest.py (762) — historische signal validatie
                │   ├── rvc.py (311) — Claude API signal validatie
                │   ├── improvement.py (408) — post-transitie protocol
                │   ├── prices.py (258) — Coinbase spot feeds
                │   ├── swing_scanner.py — multi-coin swing scan
                │   └── oi_zones.py (376) — OI cluster mapping
                │
                └── bin/
                    ├── deploy — deployment script
                    └── deploy_report.sh — HTML → Vercel push
```

### Data Flow (daemon loop, elke 5 min)

```
daemon tick
  ├── vault scanner (file change detection)
  ├── sentinel.poll() (elke 3e tick = 15 min)
  │     ├── Hyblock raw scan → per-coin change detection → alerts
  │     ├── MA/EMA 200 cross detection (technicals)
  │     ├── OI zones proximity (hourly)
  │     ├── Hyblock S1-S5 signals (hourly)
  │     │     └── S1 squeeze ≥ 7 → SQUEEZE_IMMINENT alert (6h cooldown)
  │     ├── Kraken VWAP + orderbook (elke poll)
  │     └── Regime classification (3-poll hysteresis)
  ├── edge.tick() — P(bull 24h) prediction logging
  ├── actions_log.resolve_outcomes() — 24/48h setup scoring
  ├── thesis_engine (4x/dag: 06/10/14/18 UTC)
  └── trade_manager.monitor_tick() (elke tick)
```

### Telegram Menu

```
☀️ Briefing    🎯 Edge         ← rapport + probability
🔭 Sentinel    ⬡ Hyblock       ← realtime monitoring
📊 Thesis      📡 Macro        ← diepte-analyse
📈 Kraken      🔗 Nansen       ← data feeds
💹 Trade       📍 Posities     ← trade management
🗂 Dossier     📐 Swing        ← tools
⚙️ Status      🛠 Skills       ← system
⬡ Protocol     📋 Check-in     ← improvement
🔄 Reboot
```

## 5. WAT DEZE SESSIE GEBOUWD IS (15 maart 2026)

Branch: claude/morning-report-cascade-v1 (gemerged naar main)

| Bestand | Regels | Wat |
|---------|--------|-----|
| skills/technicals.py | +205 | ATR% (14h), Parkinson vol (168h), Low Vol Regime Flag |
| skills/cascade_risk.py | 341 | CRI 0-10: 5 componenten |
| skills/report_renderer.py | 484 | HTML dashboard met info-tooltips, mobile-first dark theme |
| bin/deploy_report.sh | 42 | Git push → mathijs-os-report repo → Vercel auto-deploy |
| core.py | +130 | Report pipeline, menu uitbreiding |
| skills/sentinel.py | +16 | S1 squeeze ≥ 7 alert met 6h cooldown |
| docs/HYBLOCK_ALPHA_PLAN.md | 242 | Systematisch plan Hyblock alpha extraction |
| docs/DASHBOARD_VIRTUAL_TRADES.md | 333 | Architectuur data-first dashboard + virtual trading |

### Hyblock Liquidation Cascade Paper — Key findings

- ATR% is #1 cascade voorspeller (coeff −1.57, 3x sterker dan al het andere)
- RFI (Residual Fragility Index) voor hidden market fragility
- 12 features, ROC-AUC 0.78, 3.7x lift over base rate
- Lage volatiliteit = complacency → leverage buildup → cascade

## 6. PRIORITEIT 1 — DATA-FIRST DASHBOARD + VIRTUAL TRADES

Lees: docs/DASHBOARD_VIRTUAL_TRADES.md voor de volledige architectuur.

### Het probleem

De briefing pipeline is: Qwen genereert tekst → Examinator (Claude) beoordeelt tekst → afgekeurd/goedgekeurd. Dit is LLM-op-LLM review. Vandaag afgekeurd met score 2/10 (terecht — Qwen interpreteerde funding verkeerd). Maar de blokkade betekent dat er geen rapport kwam terwijl de marktdata wel waardevol is.

### De oplossing: twee ontkoppelingen

**A. Dashboard ≠ briefing.** Het rapport moet altijd de live marktdata tonen (prijs, regime, vol features, CRI, edge, posities) ongeacht of Qwen draait of afgekeurd wordt. Setups zijn een optionele sectie.

**B. Markt = examinator, niet Claude.** Elke setup wordt een virtuele trade. De daemon checkt elke 15 min of SL/TP geraakt is. Na 7 dagen: win/loss/expired. Aggregate stats vervangen de subjectieve tekst-review.

### Wat gebouwd moet worden

1. **skills/virtual_trades.py** — CRUD + check + performance stats
2. **Dashboard decoupling** in core.py
3. **Track Record sectie** in report_renderer.py
4. **Daemon integratie** — virtual_trades.check_trades() elke sentinel tick
5. **Feedback loop** (week 2) — performance stats → auto-generated rules

## 7. PRIORITEIT 2 — HYBLOCK ALPHA EXTRACTION

Lees: docs/HYBLOCK_ALPHA_PLAN.md voor het volledige plan.

### P1 features (laag complex, paper-backed, API ready)

1. Spot-Perp CVD Divergentie — anchoredCVD x2 (spot + perp), 68.8% win rate
2. Cumulative Funding 24h — paper's 2e sterkste feature
3. Bid-Ask Ratio (spot 0-5%) — Hyblock-backtested

### P2 features (medium complex)

1. Leverage Z-Score + RoC
2. OI-Price Divergentie
3. Liquidation Level Density
4. Slippage als stress indicator

### P3 features (complex, hoogste alpha)

1. RFI (Residual Fragility Index)
2. Samengestelde Cascade Probability
3. True Retail + WRD Confluence

## 8. HYBLOCK API KENNIS (KRITISCH)

```
anchoredCVD endpoint      → data[].cumulativeDelta  (NIET 'anchoredCVD'!)
fundingRate               → data[].fundingRate
whaleRetailDelta          → data[].whaleRetailDelta
openInterestDelta         → data[].openInterestDelta
traderSentimentGap        → data[].traderSentimentGap
participationRatio        → data[].participationRatio
volumeRatio               → data[].volumeRatio
buySellTradeCountRatio    → data[].buySellTradeCountRatio
cumulativeLiqLevel        → data[].totalLongLiquidationSize + totalShortLiquidationSize
topTraderAverageLeverageDelta → data[].avgLevDelta, exchange: okx_perp_coin
```

**Geldige limit waarden:** ALLEEN 5, 10, 20, 50, 100, 500, 1000

**Spot vs Perp CVD:** gebruik anchoredCVD tweemaal:
- exchange=binance_spot voor spot CVD
- exchange=binance_perp_stable voor perp CVD

## 9. BESTAANDE SYSTEEM-PROBLEMEN

1. CLAUDE.md dependency graph is stale
2. Daemon briefing trigger ontbreekt
3. Actions log vs virtual trades overlap
4. Examinator blokkeert rapport
5. BTC positie onder water — entry $72,588, huidige ~$71,523, SL $71,800

## 10. BOUWVOLGORDE VOLGENDE SESSIE

1. virtual_trades.py bouwen (CRUD + check + stats)
2. report_renderer.py uitbreiden met Track Record + Virtual Trades secties
3. core.py: generate_dashboard() ontkoppeld van briefing
4. daemon loop: virtual_trades.check_trades() integreren
5. Test: open een virtual trade, wacht op sentinel tick, check P&L update
6. P1 Hyblock features: Spot-Perp CVD divergentie
7. P1 Hyblock features: Cumulative funding 24h som
8. Deploy + test via TG menu → Briefing knop

## 11. DOCS STRUCTUUR

```
docs/
├── HANDOVER.md                    ← DIT DOCUMENT
├── DASHBOARD_VIRTUAL_TRADES.md    ← architectuur virtual trades + data-first dashboard
├── HYBLOCK_ALPHA_PLAN.md          ← systematisch plan Hyblock feature extraction
├── HYBLOCK_KNOWLEDGE.md           ← API veldnamen, indicator interpretatie
├── DEPLOY.md                      ← deployment instructies
├── ROADMAP.md                     ← milestones M1-M7
├── SOUL.md                        ← identiteit en principes
├── README.md                      ← repo overview
├── REFACTOR_PLAN_v3.5.md          ← shared modules plan
├── DIRECTIVES.md                  ← system directives
├── CHANGELOG.md                   ← wijzigingslog
├── MATHIJS_PROFIEL.md             ← persoonlijk profiel
├── PORTAL.md                      ← master entry point
└── archive/                       ← oude handovers
```

---
*Aangemaakt: 15 maart 2026 (avond) | Claude Opus 4.6*
*Vervangt alle eerdere handovers. Houd dit document actueel.*
