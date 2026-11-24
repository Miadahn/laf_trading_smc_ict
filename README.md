# SMC · ICT Analyzer

Application web d'aide à l'analyse technique selon les **Smart Money Concepts (SMC)** et la méthode **ICT**.
Elle charge des bougies, détecte automatiquement les concepts clés et les dessine sur le graphique.

> Outil pédagogique : ce n'est pas un conseil en investissement.

## Lancer l'application

Aucune installation n'est nécessaire : ouvrir `index.html` dans un navigateur (double-clic).
Tout est inclus localement, y compris la librairie de graphiques.

Ou, pour servir le dossier :

```bash
cd laf_trading_smc_ict
python3 -m http.server 8000   # puis ouvrir http://localhost:8000
```

## Sources de données

| Source | Détails |
|---|---|
| **Deriv** | Indices synthétiques (Volatility `R_75`, `1HZ100V`, `BOOM1000`, `CRASH1000`, `stpRNG`…), Forex (`frxEURUSD`), or (`frxXAUUSD`), indices (`OTC_NDX`), crypto. **Flux temps réel** par WebSocket (case « Temps réel »). Liste complète des actifs chargée automatiquement. |
| **Binance** | Crypto en direct, sans clé API (`BTCUSDT`, `ETHUSDT`, `PAXGUSDT` pour l'or…). Rafraîchissement auto toutes les 30 s. |
| **Fichier CSV** | Pour le Forex, les indices, les actions… Export TradingView (`time,open,high,low,close,volume`) ou MetaTrader (`date,heure,open,high,low,close,volume`). L'unité de temps est détectée ; on peut choisir une unité supérieure (rééchantillonnage). |
| **Démo** | Données simulées, utilisées automatiquement si Deriv ou Binance est injoignable. |

### Deriv : App ID

L'application utilise par défaut l'`app_id` **1089**, l'application de test publique de Deriv.
Pour un usage régulier, crée gratuitement ta propre application sur [api.deriv.com](https://api.deriv.com)
(menu *Dashboard → Register application*) et saisis son identifiant dans le champ **Deriv App ID**.
Seules des données de marché publiques sont lues : aucun jeton de compte n'est demandé, aucun ordre n'est passé.

Les indices synthétiques tournent 24h/24 : pour eux, les killzones sont désactivées automatiquement.

## Ce qui est détecté

- **Structure** : swings (HH, HL, LH, LL), **BOS** (continuation) et **CHoCH** (retournement).
- **Order Blocks** : dernière bougie opposée avant l'impulsion qui casse la structure ; marqués `+ FVG` s'il y a eu déplacement ; état intact / mitigé / invalidé.
- **Breaker Blocks** : OB invalidés qui changent de camp.
- **Fair Value Gaps** : déséquilibres sur 3 bougies, avec suivi du comblement.
- **Liquidité** : Equal Highs/Lows (EQH/EQL), BSL/SSL les plus proches, **sweeps** (`$`).
- **Premium / Discount**, équilibre 50 % et zone **OTE** (62–79 %).
- **Niveaux ICT** : PDH / PDL (jour précédent), Midnight Open.
- **Killzones** (heure de New York) : Asie, Londres, New York AM, London Close.
- **Biais multi-timeframe** : la structure de l'unité supérieure (ex. 4h pour du 15m).
- **Setup** : zone d'entrée la plus proche dans le sens du biais, stop, objectif sur la liquidité opposée, ratio R/R et checklist de confluences.

Le graphique est affiché en **heure de New York**, la référence ICT.
Les détections n'utilisent jamais de bougies futures : un swing n'est pris en compte qu'une fois confirmé
(après « longueur swing » bougies), comme en temps réel.

## Structure du code

```
laf_trading_smc_ict/
├── index.html          interface
├── css/style.css
├── js/smc.js           moteur d'analyse SMC/ICT (fonctions pures, sans dépendance)
├── js/data.js          Deriv (WebSocket), Binance, import CSV, données de démo
├── js/app.js           graphique, dessin des zones, panneau d'analyse
├── vendor/             TradingView Lightweight Charts 4.2.0 (Apache 2.0)
└── tests/smc.test.js   tests du moteur
```

## Tests

```bash
node --test tests/*.test.js
```

## Crédits

Graphiques : [TradingView Lightweight Charts](https://www.tradingview.com/) (licence Apache 2.0, voir `vendor/`).
