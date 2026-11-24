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

Pour une surveillance continue avec alertes navigateur fermé, voir
[Serveur 24h/24](#serveur-24h24-optionnel).

## Sources de données

| Source | Détails |
|---|---|
| **Deriv** | Indices synthétiques (Volatility `R_75`, `1HZ100V`, `BOOM1000`, `CRASH1000`, `stpRNG`…), Forex (`frxEURUSD`), or (`frxXAUUSD`), indices (`OTC_NDX`), crypto. **Flux temps réel** par WebSocket (case « Temps réel »). Liste complète des actifs chargée automatiquement. |
| **Binance** | Crypto en direct, sans clé API (`BTCUSDT`, `ETHUSDT`, `PAXGUSDT` pour l'or…). Rafraîchissement auto toutes les 30 s. |
| **Fichier CSV** | Pour le Forex, les indices, les actions… Export TradingView (`time,open,high,low,close,volume`) ou MetaTrader (`date,heure,open,high,low,close,volume`). L'unité de temps est détectée ; on peut choisir une unité supérieure (rééchantillonnage). |
| **Démo** | Données simulées, utilisées automatiquement si Deriv ou Binance est injoignable. |

### Deriv : que faire si ça ne marche pas

Les données de marché Deriv ne circulent que par WebSocket. S'il n'aboutit pas, le message
d'erreur de l'application nomme désormais chaque hôte essayé et la raison du refus :

| Code de fermeture | Signification | Piste |
|---|---|---|
| `1006` | upgrade WebSocket refusé | réseau, proxy ou Cloudflare — essayer un autre réseau |
| `1008` | refusé par Deriv | `app_id` ou origine non autorisés — créer son app_id |
| `1013` | Deriv surchargé | réessayer plus tard |

Test décisif : ouvrir **[charts.deriv.com](https://charts.deriv.com)**, la page de
graphiques de Deriv, qui utilise le même WebSocket. Si elle affiche des cours, le problème
vient de l'application ; si elle reste vide, il vient du réseau.

En dernier recours, les indices synthétiques (`R_75`, `BOOM1000`, `stpRNG`…) n'existent
que chez Deriv : aucune autre source ne les propose. Pour le Forex, l'or, les indices et
la crypto, **Binance** et l'**import CSV** restent disponibles.

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
- **Écarts d'ouverture** : **NDOG** (jour) et **NWOG** (semaine), avec leur milieu (*consequent encroachment*) et son état : intact, milieu atteint, comblé.
- **Quarterly Theory** : quarts de journée Q1–Q4 (6 h), blocs de 90 min, phase AMDX attendue, *True Session Open*, True Opens du jour et de la semaine.
- **Judas Swing** : faux mouvement d'ouverture de session — range de la session précédente balayée, clôture de retour dedans, puis déplacement.
- **Profils observés** : quelle session porte l'extrême du jour, quel jour porte l'extrême de la semaine, avec la taille d'échantillon.
- **IFVG** : FVG traversé **en clôture**, devenu zone de sens inverse.
- **Unicorn** : breaker block chevauchant un FVG, après balayage et cassure de structure ; entrée au CE du FVG.
- **CISD** : clôture au-delà de l'ouverture de la jambe de livraison opposée — lu sur les corps, donc plus précoce que le MSS.
- **Turtle soup / CRT** : mèche hors de la bougie précédente, clôture revenue dedans, corps qui ne dépasse pas.
- **Retracement doux vs fort** : ce que la jambe de retour laisse derrière elle.
- **Régime du jour** : expansion, normal ou consolidation, par rapport à la médiane des jours précédents.
- **Biais multi-timeframe** : la structure de l'unité supérieure (ex. 4h pour du 15m).
- **Setup** : zone d'entrée la plus proche dans le sens du biais, stop, objectif sur la liquidité opposée, ratio R/R et checklist de confluences.
- **Taille de position** : à partir du capital et du risque en % saisis dans la barre d'outils, le montant risqué et la taille à saisir chez le broker (`risque / distance au stop`).

Le graphique est affiché en **heure de New York**, la référence ICT.
Les détections n'utilisent jamais de bougies futures : un swing n'est pris en compte qu'une fois confirmé
(après « longueur swing » bougies), comme en temps réel.

## Modèles d'entrée (IFVG, Unicorn, CISD)

### IFVG — Inversion Fair Value Gap

Un FVG comblé en mèche reste un FVG. Un FVG dont le prix **clôture au-delà** cesse d'être
un déséquilibre et devient une zone de sens inverse : un BISI traversé devient une
résistance. L'IFVG est suivi comme un order block (fraîche / mitigée / invalidée) et sert
de zone d'entrée au même titre.

### Unicorn — breaker chevauchant un FVG

Quatre ingrédients, dans l'ordre : balayage de liquidité, cassure de structure en sens
inverse, FVG laissé par l'impulsion, breaker block traversé en clôture. **La condition qui
fait l'Unicorn est le chevauchement** du breaker et du FVG ; sans lui, ce ne sont que deux
zones voisines. Entrée au CE (50 %) du FVG, stop au-delà de l'extrême balayé.

Un FVG ne donne qu'un seul Unicorn : plusieurs breakers peuvent le chevaucher, c'est la
même idée de trade.

### CISD — Change in State of Delivery

Une bougie dont le corps clôture au-delà du **prix d'ouverture de la jambe de bougies
opposées** qui venait de livrer le prix. Il se lit sur les corps là où le MSS se lit sur
les mèches : il déclenche donc avant. Observé sur BTCUSDT en 1 h, le CISD a précédé le
CHoCH d'une bougie.

`cisdMinLeg` fixe la longueur minimale de la jambe. Mesuré sur BTCUSDT 1 h : une seule
bougie opposée donne 16,5 % des bougies (du bruit), deux en donnent 3,6 %.

## Lecture du contexte (retracement, régime)

### Retracement doux vs fort

Critère de HugoFX. La question n'est pas *si* le prix revient dans le niveau, mais
**comment**. Trois indices sur la jambe en cours, deux suffisent pour « fort » :

| Indice | Seuil |
|---|---|
| plus gros corps de la jambe | ≥ `strongBodyAtr` (1,5 ATR) |
| FVG non comblés laissés dans le sens du retour | ≥ 1 |
| plus longue suite de corps de même sens | ≥ `strongRunLength` (3) |

**Doux** : bougies alternées, rien laissé derrière — le niveau opposé devrait tenir, le
rejet est jouable. **Fort** : la Smart Money s'est engagée, le niveau est en danger et ne
se trade pas.

Si le prix a dépassé l'extrême d'ancrage, il n'y a pas de retracement mais une expansion :
rien n'est classé.

### Régime du jour

Range du dernier jour **complet** comparée à la médiane des jours précédents. La médiane
et non la moyenne : un seul jour d'annonce suffirait à fausser tous les suivants. Le jour
en cours est exclu du verdict — sa range est mécaniquement plus petite — mais affiché à
part.

Expansion (≥ ×1,3) : privilégier les unités supérieures, les niveaux y tiennent mieux.
Consolidation (≤ ×0,7) : privilégier les unités inférieures.

## Concepts de timing (Quarterly Theory, Judas Swing)

Ces trois blocs supposent des **sessions**. Comme les killzones, ils sont désactivés
automatiquement pour les indices synthétiques Deriv, qui cotent 24h/24 sans sessions.

### Quarterly Theory

La journée se découpe en quatre quarts de 6 h, heure de New York, chacun subdivisé en
quatre blocs de 90 min :

| Quart | Session | Horaire (NY) | Phase attendue | True Session Open |
|---|---|---|---|---|
| Q1 | Asie | 18h00 – 00h00 | Accumulation | 19h30 |
| Q2 | Londres | 00h00 – 06h00 | Manipulation | 01h30 |
| Q3 | New York | 06h00 – 12h00 | Distribution | 07h30 |
| Q4 | Après-midi | 12h00 – 18h00 | Continuation / retournement | 13h30 |

**True Opens** : celui du jour est minuit à New York (début du Q2, identique au
*Midnight Open* déjà affiché) ; celui de la semaine est lundi 18h00 à New York.
Les True Opens mensuel et annuel demandent des mois d'historique : hors de portée d'un
graphique intraday, donc non calculés.

La variante **XAMD** (l'expansion d'abord, quand le cycle se décale) relève du jugement
du trader et n'est pas détectée.

### Judas Swing

Détecté en trois temps, dans l'ordre, et signalé seulement si au moins le retour a eu lieu :

1. **Balayage** : à l'ouverture de la session, le prix sort de la range de la session
   précédente et y prend la liquidité.
2. **Retour** : une bougie **clôture** de nouveau dans la range — c'est la confirmation.
   Sans elle, il n'y a qu'une expansion, et rien n'est signalé.
3. **Déplacement** : le vrai mouvement part dans le sens opposé au balayage.

Deux fenêtres sont examinées : **Londres** (range d'Asie balayée dans la killzone de
Londres) et **New York** (range de Londres dans la killzone NY AM). Les sources
s'accordent sur la première ; certaines refusent la seconde. Les deux sont donc détectées
et nommées, le tri revient au trader.

Deux seuils réglables, dans `DEFAULTS` de `js/smc.js` :

| Réglage | Défaut | Rôle |
|---|---|---|
| `judasSweepAtr` | `0.25` | dépassement minimal de la range, en ATR — sans lui une mèche d'un tick hors d'une range étroite suffirait, et le bruit de fond produirait des Judas Swings à la chaîne |
| `judasDispAtr` | `1` | déplacement minimal pour passer de « confirmé » à « déplacement confirmé » |
| `gapMinAtr` | `0.1` | largeur minimale d'un NDOG/NWOG, en ATR — sur un marché continu l'ouverture décale souvent d'un tick par rapport à la clôture précédente |
| `turtleWickAtr` | `0.5` | dépassement minimal d'un turtle soup — à 0,1 ATR le motif touche 29 % des bougies, à 0,5 il en touche 5 % |
| `unicornOverlapAtr` | `0.1` | chevauchement minimal breaker/FVG — un chevauchement de 11 points pour un ATR de 314 n'est pas une confluence |
| `unicornSweepAtr` | `3` | distance maximale entre le balayage et la zone, en ATR |
| `cisdMinLeg` | `2` | bougies consécutives minimales pour parler de jambe de livraison |
| `strongBodyAtr` | `1.5` | corps qualifiant un retracement de « fort » |
| `breakerOnBodies` | `true` | invalider un order block sur le **corps** de sa bougie, pas sur sa mèche |

À ajuster selon l'actif : un indice synthétique volatil et une paire Forex ne respirent
pas de la même façon.

### Profils observés

Deux comptages sur l'historique chargé : quelle session porte l'extrême du jour, et quel
jour porte l'extrême de la semaine. Les killzones ne pavent pas la journée, donc une ligne
**hors killzone** complète les totaux.

Ce sont des **statistiques descriptives, pas des prédictions**. La taille d'échantillon est
affichée, et sous 20 semaines complètes l'app prévient explicitement que les chiffres ne
valent pas tendance — 1000 bougies de 15 min ne couvrent qu'une dizaine de jours.

## Calculateur de position

Onglet **Calculateur** dans le panneau de droite. Trois blocs de saisie :

| Champ | Rôle |
|---|---|
| Entrée, Stop loss, Objectif | Niveaux du trade. Le bouton **Reprendre le setup en cours** les recopie depuis la carte Setup. |
| Capital USD, Risque % | Partagés avec la barre d'outils. |
| Unités par lot | Taille d'un contrat chez le broker : `100 000` lot Forex standard, `10 000` mini, `1 000` micro, `100` pour l'or, `1` pour la plupart des indices et crypto. |
| Volume (lots) | Optionnel. Vide : l'app conseille un volume. Renseigné : elle donne le risque réel de ce volume. |

Sorties : sens du trade (déduit du côté du stop), distances, ratio R/R, montant risqué,
gain si l'objectif est touché, taille en unités et volume en lots.

Deux garde-fous : un objectif placé du mauvais côté de l'entrée est signalé, et un volume
saisi qui dépasse le risque en % fixé est marqué en rouge.

### Devise

Tous les montants sont en **USD**, ce qui est exact pour la quasi-totalité des actifs proposés :
synthétiques Deriv, paires en `/USD` (`frxEURUSD`, `frxGBPUSD`), or (`frxXAUUSD`),
crypto Deriv (`cryBTCUSD`) et paires Binance en `USDT`/`USDC`.

Pour les rares actifs cotés dans une autre devise — `frxUSDJPY` (JPY), `frxEURGBP` (GBP),
`ETHBTC` (BTC) — le calculateur affiche un avertissement nommant la devise réelle :
les montants sont alors dans cette devise, à convertir en USD au taux du moment.
Les indices boursiers (`OTC_*`) ne déclarent pas leur devise dans le symbole ; ils sont
supposés en USD, ce qui est juste pour les indices américains mais pas pour `OTC_GDAXI` (EUR).

Aucune conversion automatique : l'app ne récupère pas de taux de change.

## Passer les trades

L'application **ne passe aucun ordre** et ne demande aucun jeton de compte : elle lit uniquement
des données de marché publiques. L'exécution est manuelle.

1. Source `Deriv` ou `Binance`, case **Temps réel** cochée.
2. Renseigner **Capital** et **Risque %** une fois (mémorisés dans le navigateur).
3. Attendre l'alerte « le prix entre dans la zone ».
4. Lire la carte **Setup** : entrée, stop, objectif, R/R, confluences, taille de position.
5. Onglet **Calculateur** → *Reprendre le setup en cours* pour obtenir le volume en lots.
6. Saisir l'ordre à la main chez le broker.

## Serveur 24h/24 (optionnel)

L'application fonctionne sans serveur. Le serveur ajoute trois choses : la page servie
par HTTP, une surveillance continue de plusieurs actifs, et des alertes qui partent
**même navigateur fermé**.

```bash
node server/server.js        # puis ouvrir http://127.0.0.1:8787
```

Zéro dépendance à installer : `node:sqlite`, `WebSocket` et `fetch` sont dans la
bibliothèque standard de **Node 22+**.

### Ce que fait la boucle

Toutes les `pollSeconds` secondes, pour chaque ligne de la watchlist : charger les bougies,
lancer la même analyse que le navigateur (`js/smc.js`), et enregistrer les signaux nouveaux :

- **BOS / CHoCH** : dernière cassure de structure
- **zone** : le prix entre dans la zone d'entrée du setup (avec entrée, stop, R/R, confluences)
- **judas** : Judas Swing de session confirmé, avec la range balayée et le niveau pris
- **unicorn** : Unicorn complet, avec sa zone, son entrée et son stop
- **cisd** : changement d'état de livraison, avec le niveau franchi

Un signal déjà vu n'est jamais réalerté, y compris après un redémarrage : l'unicité est
garantie en base par la clé `(symbole, tf, type, bougie, prix)`, pas par un état en mémoire.

### Watchlist — `server/config.json`

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "pollSeconds": 60,
  "swingLength": 5,
  "watch": [
    { "source": "deriv", "symbol": "R_75", "tf": "15m" },
    { "source": "binance", "symbol": "BTCUSDT", "tf": "15m" }
  ]
}
```

`source` vaut `deriv`, `binance` ou `demo`. Les lignes dont l'unité de temps est inconnue
sont écartées au démarrage ; si aucune ligne n'est valide, le serveur refuse de démarrer
plutôt que de tourner à vide.

### Alertes

Le serveur enregistre toujours les signaux en base. Pour qu'ils soient *envoyés*, définir
`ALERT_WEBHOOK` :

```bash
# Discord ou Slack : l'URL du webhook suffit
ALERT_WEBHOOK="https://discord.com/api/webhooks/..." node server/server.js

# Telegram : il faut aussi l'identifiant de conversation
ALERT_WEBHOOK="https://api.telegram.org/bot<TOKEN>/sendMessage" ALERT_CHAT_ID="123456789" node server/server.js
```

Le corps envoyé contient `text` et `content`, ce qui couvre Slack, Discord, ntfy et la
plupart des webhooks sans configuration. Sans `ALERT_WEBHOOK`, rien n'est envoyé : les
alertes restent consultables en base et dans l'onglet **Analyse** de la page.

### Relais Deriv

Deriv ne publie **aucun** endpoint REST pour les bougies : `ticks_history` passe
exclusivement par WebSocket. Or ce WebSocket n'aboutit pas depuis tous les réseaux —
l'entrée historique `ws.derivws.com` est derrière Cloudflare et renvoie un HTTP 520
depuis beaucoup de VPS, d'hébergeurs et de FAI.

Le serveur sert donc de relais. Quand l'application est servie en `http(s)` :

1. le navigateur tente le WebSocket Deriv **en direct** ;
2. s'il échoue, il repasse automatiquement par `GET /api/deriv/candles` ;
3. le serveur va chercher les bougies depuis là où **il** tourne et les renvoie.

Aucune configuration : le repli est automatique, et les deux chemins produisent les mêmes
bougies. Ouverte en `file://`, l'application n'a pas de serveur derrière elle et garde
l'ancien comportement.

Le flux tick par tick, lui, ne se relaie pas — un WebSocket ne se proxyfie pas avec une
simple requête. Si le flux direct échoue, « Temps réel » se dégrade en rafraîchissement
toutes les 30 s par le relais, ce que l'application annonce.

**Le relais ne contourne pas un blocage réseau.** Lancé sur ta machine, il subit le même
blocage que ton navigateur. Il ne change les choses que si le navigateur seul était en
cause (extension, proxy d'entreprise, politique de page), ou si le serveur tourne ailleurs
— sur un VPS qui, lui, atteint Deriv.

Les paramètres du relais viennent du réseau, donc ils sont validés strictement
(symbole `[A-Za-z0-9_]{1,32}`, unité de temps connue, `count` borné à 5000) : sans ça ce
serait un proxy ouvert.

### API de lecture

| Route | Contenu |
|---|---|
| `GET /api/alerts?limit=100` | historique des signaux, le plus récent d'abord |
| `GET /api/status` | démarrage, dernier tour, watchlist, état par actif |
| `GET /api/deriv/candles?symbol=R_75&tf=15m&count=1000` | relais Deriv (voir ci-dessus) |

La page, quand elle est servie par le serveur, affiche les 25 dernières alertes dans
l'onglet **Analyse**. Ouverte en `file://`, elle se comporte exactement comme avant :
la carte est simplement absente.

### Sécurité

Quatre points, qui sont des choix délibérés et non des oublis :

- **Écoute sur `127.0.0.1`** par défaut : la page n'est pas exposée au réseau. Passer à
  `0.0.0.0` l'ouvre à tout le monde — il n'y a aucune authentification. Pour un accès
  distant, mettre un reverse proxy avec mot de passe devant, ou passer par un tunnel SSH.
- **Aucune écriture par HTTP** : seuls `GET` et `HEAD` sont acceptés, l'API est en lecture
  seule. Rien de ce qui arrive par le réseau ne modifie la base ni la configuration.
- **Secrets en variables d'environnement** uniquement, jamais dans `config.json`. L'URL du
  webhook contient le jeton du bot : elle n'est jamais journalisée, même en cas d'erreur.
- **`server/data/` et `.env` sont dans `.gitignore`** : la base d'alertes et les jetons
  ne partent pas dans le dépôt.

### Tourner en continu

Le serveur est un simple processus Node, à garder en vie avec l'outil habituel de la
machine : un service **systemd** sur un VPS Linux, le **Planificateur de tâches** sur
Windows, ou `pm2`. `SIGINT`/`SIGTERM` sont traités : la base est fermée proprement.

## Structure du code

```
laf_trading_smc_ict/
├── index.html          interface
├── css/style.css
├── js/smc.js           moteur d'analyse SMC/ICT (fonctions pures, sans dépendance)
├── js/data.js          Deriv (WebSocket), Binance, import CSV, données de démo
├── js/app.js           graphique, dessin des zones, panneau d'analyse, calculateur
├── server/server.js    serveur optionnel : page, surveillance 24h/24, alertes (sans dépendance)
├── server/config.json  watchlist et cadence
├── vendor/             TradingView Lightweight Charts 4.2.0 (Apache 2.0)
├── tests/smc.test.js   tests du moteur, du calculateur et des devises
└── tests/server.test.js tests du serveur : signaux, unicité, webhook, chemins servis
```

## Tests

```bash
node --test tests/smc.test.js tests/server.test.js
```

Sur Node 24, `node --test tests/` échoue (résolution de dossier) : nommer les fichiers.

## Crédits

Graphiques : [TradingView Lightweight Charts](https://www.tradingview.com/) (licence Apache 2.0, voir `vendor/`).
