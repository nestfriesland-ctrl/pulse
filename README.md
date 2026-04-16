# Pulse

Semantisch netwerk van alle systemen. Rendert de wiki repo als
navigeerbaar dashboard. Elke sensor, elke beslissing, elk project
is een node. Elke verwijzing is een edge.

## Architectuur

Pulse leest uit de `wiki` repo (GitHub raw URLs). Geen eigen database.
De wiki is de single source of truth. Pulse is de view.

## Sensoren

Real-time status van alle domeinen via `wiki/sensors/`:
- derivatives — crypto marktstructuur
- market — prijzen, volumes, macro
- infra — sites, deploys, git
- nest-seo — DR, backlinks, rankings
- enrichment — ctrl-engine pipeline
- anti-fragile — research cycles, edges

## Deploy

Vercel project: pulse (prj_nqC89fQxK4mbqb6jDlrUiqB1lwCp)
Push to main → auto deploy.

## Build

TODO: Claude Code briefing. Astro of plain HTML + JS.
Haalt wiki content op via GitHub API, rendert als graaf.
