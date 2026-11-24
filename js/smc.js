/*
 * Moteur d'analyse Smart Money Concepts (SMC) / ICT.
 *
 * Toutes les fonctions sont pures : elles prennent un tableau de bougies
 *   { time (secondes UTC), open, high, low, close, volume }
 * trié par temps croissant, et renvoient des objets décrivant la structure.
 *
 * Aucune détection n'utilise de données "du futur" : un sommet/creux (swing)
 * n'est utilisé qu'à partir de la bougie où il est confirmé (index + longueur).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Heure de New York (référence des sessions ICT)
  // ---------------------------------------------------------------------------
  const NY_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const nyCache = new Map();

  function nyParts(ts) {
    let p = nyCache.get(ts);
    if (p) return p;
    const o = {};
    for (const x of NY_FMT.formatToParts(new Date(ts * 1000))) o[x.type] = x.value;
    let hour = +o.hour;
    if (hour === 24) hour = 0;
    p = {
      y: +o.year, mo: +o.month, d: +o.day, hour, minute: +o.minute,
      weekday: o.weekday, dateKey: `${o.year}-${o.month}-${o.day}`,
    };
    if (nyCache.size > 100000) nyCache.clear();
    nyCache.set(ts, p);
    return p;
  }

  /** Décalage (secondes) à ajouter à un timestamp UTC pour l'afficher en heure de New York. */
  function nyOffsetSeconds(ts) {
    const p = nyParts(ts);
    const base = Math.floor(ts / 60) * 60;
    return Date.UTC(p.y, p.mo - 1, p.d, p.hour, p.minute) / 1000 - base;
  }

  // Killzones ICT, en minutes depuis minuit (heure de New York)
  const KILLZONES = [
    { id: 'asia', name: 'Asie', start: 20 * 60, end: 24 * 60, color: 'rgba(156,120,255,0.07)' },
    { id: 'london', name: 'Londres', start: 2 * 60, end: 5 * 60, color: 'rgba(66,165,245,0.08)' },
    { id: 'nyam', name: 'New York AM', start: 7 * 60, end: 10 * 60, color: 'rgba(255,183,77,0.08)' },
    { id: 'lclose', name: 'London Close', start: 10 * 60, end: 12 * 60, color: 'rgba(240,98,146,0.06)' },
  ];

  function killzoneOf(ts) {
    const p = nyParts(ts);
    const m = p.hour * 60 + p.minute;
    return KILLZONES.find((k) => m >= k.start && m < k.end) || null;
  }

  // ---------------------------------------------------------------------------
  // Indicateurs de base
  // ---------------------------------------------------------------------------
  /** Average True Range (lissage de Wilder). */
  function atr(c, period = 14) {
    const out = new Array(c.length);
    let prev = 0;
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      const tr = i === 0
        ? b.high - b.low
        : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close));
      prev = i < period ? (prev * i + tr) / (i + 1) : (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
    return out;
  }

  /**
   * Sommets / creux (pivots) : la bougie i est un swing high si son plus haut
   * dépasse les `len` bougies de chaque côté.
   */
  function findSwings(c, len) {
    const highs = [];
    const lows = [];
    for (let i = len; i < c.length - len; i++) {
      let isH = true;
      let isL = true;
      for (let j = i - len; j <= i + len && (isH || isL); j++) {
        if (j === i) continue;
        if (j < i ? c[j].high > c[i].high : c[j].high >= c[i].high) isH = false;
        if (j < i ? c[j].low < c[i].low : c[j].low <= c[i].low) isL = false;
      }
      if (isH) highs.push({ index: i, price: c[i].high, confirmedAt: i + len, side: 'high' });
      if (isL) lows.push({ index: i, price: c[i].low, confirmedAt: i + len, side: 'low' });
    }
    // Étiquettes HH / LH / HL / LL
    for (let k = 0; k < highs.length; k++) {
      highs[k].label = k === 0 ? 'H' : highs[k].price > highs[k - 1].price ? 'HH' : 'LH';
    }
    for (let k = 0; k < lows.length; k++) {
      lows[k].label = k === 0 ? 'L' : lows[k].price < lows[k - 1].price ? 'LL' : 'HL';
    }
    return { highs, lows };
  }

  // ---------------------------------------------------------------------------
  // Structure de marché : BOS / CHoCH + Order Blocks
  // ---------------------------------------------------------------------------
  function findOrderBlockCandle(c, from, to, dir) {
    // Origine du mouvement impulsif : plus bas (haussier) ou plus haut (baissier)
    // entre le swing cassé et la bougie de cassure.
    let m = from + 1;
    for (let k = from + 1; k <= to; k++) {
      if (dir === 1 ? c[k].low < c[m].low : c[k].high > c[m].high) m = k;
    }
    // Dernière bougie de couleur opposée au mouvement, à l'origine ou juste avant.
    for (let k = m; k >= Math.max(from, m - 5); k--) {
      const opposite = dir === 1 ? c[k].close < c[k].open : c[k].close > c[k].open;
      if (opposite) return k;
    }
    return m;
  }

  function analyzeStructure(c, swings) {
    const n = c.length;
    const byConfirm = new Map();
    for (const s of [...swings.highs, ...swings.lows]) {
      if (s.confirmedAt >= n) continue;
      if (!byConfirm.has(s.confirmedAt)) byConfirm.set(s.confirmedAt, []);
      byConfirm.get(s.confirmedAt).push(s);
    }

    let trend = 0; // 1 haussier, -1 baissier, 0 indéterminé
    let lastHigh = null;
    let lastLow = null;
    const events = [];
    const orderBlocks = [];

    for (let i = 0; i < n; i++) {
      const confirmed = byConfirm.get(i);
      if (confirmed) {
        for (const s of confirmed) {
          if (s.side === 'high') lastHigh = { ...s, broken: false };
          else lastLow = { ...s, broken: false };
        }
      }
      const close = c[i].close;

      if (lastHigh && !lastHigh.broken && close > lastHigh.price) {
        events.push({
          type: trend === -1 ? 'CHoCH' : 'BOS', dir: 1,
          price: lastHigh.price, from: lastHigh.index, to: i,
        });
        lastHigh.broken = true;
        trend = 1;
        const j = findOrderBlockCandle(c, lastHigh.index, i, 1);
        orderBlocks.push({
          kind: 'ob', dir: 1, top: c[j].high, bottom: c[j].low,
          index: j, createdAt: i, breakIndex: i, eventType: events[events.length - 1].type,
        });
      }

      if (lastLow && !lastLow.broken && close < lastLow.price) {
        events.push({
          type: trend === 1 ? 'CHoCH' : 'BOS', dir: -1,
          price: lastLow.price, from: lastLow.index, to: i,
        });
        lastLow.broken = true;
        trend = -1;
        const j = findOrderBlockCandle(c, lastLow.index, i, -1);
        orderBlocks.push({
          kind: 'ob', dir: -1, top: c[j].high, bottom: c[j].low,
          index: j, createdAt: i, breakIndex: i, eventType: events[events.length - 1].type,
        });
      }
    }
    return { trend, events, orderBlocks };
  }

  /**
   * Suivi des zones (OB / breakers) : mitigation (prix revient dans la zone)
   * et invalidation (clôture au-delà de la zone). Un OB invalidé devient un
   * Breaker Block de direction opposée.
   */
  /**
   * Suit les zones et fabrique les breakers.
   *
   * `onBodies` décide du seuil d'invalidation. Un order block est délimité par
   * les mèches de sa bougie, mais la livraison se lit sur les corps : exiger une
   * clôture au-delà de la mèche fait manquer des breakers qui partent ensuite en
   * forte expansion. On invalide donc par défaut sur le corps de la bougie
   * d'origine (`bodyTop` / `bodyBottom`), la zone dessinée restant inchangée.
   *
   * Passer `onBodies` à false restaure l'ancien comportement, plus strict.
   */
  function trackBlocks(c, blocks, onBodies = true) {
    const n = c.length;
    const out = [];
    const queue = blocks.slice();
    while (queue.length) {
      const z = queue.shift();
      z.mitigatedAt = null;
      z.invalidatedAt = null;
      // Seuil de clôture : corps de la bougie d'origine quand il est connu,
      // sinon les bornes de la zone (cas des IFVG, qui n'ont pas de bougie).
      const src = c[z.index];
      const useBodies = onBodies && src && z.kind !== 'ifvg';
      const killLow = useBodies ? Math.min(src.open, src.close) : z.bottom;
      const killHigh = useBodies ? Math.max(src.open, src.close) : z.top;
      z.killLow = killLow;
      z.killHigh = killHigh;
      for (let k = z.createdAt + 1; k < n; k++) {
        const b = c[k];
        if (z.mitigatedAt === null && (z.dir === 1 ? b.low <= z.top : b.high >= z.bottom)) z.mitigatedAt = k;
        if (z.dir === 1 ? b.close < killLow : b.close > killHigh) {
          z.invalidatedAt = k;
          if (z.kind === 'ob') {
            queue.push({
              kind: 'breaker', dir: -z.dir, top: z.top, bottom: z.bottom,
              index: z.index, createdAt: k,
            });
          }
          break;
        }
      }
      z.status = z.invalidatedAt !== null ? 'invalidated' : z.mitigatedAt !== null ? 'mitigated' : 'fresh';
      out.push(z);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fair Value Gaps (déséquilibres sur 3 bougies)
  // ---------------------------------------------------------------------------
  function findFVGs(c, a, minAtr) {
    const n = c.length;
    const fvgs = [];
    for (let i = 2; i < n; i++) {
      const minGap = minAtr * a[i];
      if (c[i].low > c[i - 2].high && c[i].low - c[i - 2].high >= minGap) {
        fvgs.push({ kind: 'fvg', dir: 1, top: c[i].low, bottom: c[i - 2].high, index: i - 1, createdAt: i });
      } else if (c[i].high < c[i - 2].low && c[i - 2].low - c[i].high >= minGap) {
        fvgs.push({ kind: 'fvg', dir: -1, top: c[i - 2].low, bottom: c[i].high, index: i - 1, createdAt: i });
      }
    }
    for (const f of fvgs) {
      f.filledAt = null;
      f.closedThroughAt = null;
      f.fill = 0; // proportion comblée (0 → 1)
      f.mid = (f.top + f.bottom) / 2;            // consequent encroachment
      const size = f.top - f.bottom;
      // On continue après le comblement en mèche : c'est la clôture au-delà qui
      // décide si le FVG s'inverse, et elle arrive souvent plus tard.
      for (let k = f.createdAt + 1; k < n; k++) {
        const b = c[k];
        if (f.dir === 1) {
          if (b.low < f.top) f.fill = Math.max(f.fill, Math.min(1, (f.top - b.low) / size));
          if (f.filledAt === null && b.low <= f.bottom) f.filledAt = k;
          if (b.close < f.bottom) { f.closedThroughAt = k; break; }
        } else {
          if (b.high > f.bottom) f.fill = Math.max(f.fill, Math.min(1, (b.high - f.bottom) / size));
          if (f.filledAt === null && b.high >= f.top) f.filledAt = k;
          if (b.close > f.top) { f.closedThroughAt = k; break; }
        }
      }
      f.status = f.filledAt !== null ? 'filled' : f.fill > 0 ? 'partial' : 'fresh';
    }
    return fvgs;
  }

  /**
   * IFVG (Inversion Fair Value Gap) : un FVG traversé **en clôture** cesse d'être
   * un déséquilibre et devient une zone de sens inverse.
   *
   * Le comblement en mèche ne suffit pas : c'est la clôture au-delà qui change
   * l'état de livraison. Le suivi (fraîche / mitigée / invalidée) réutilise
   * `trackBlocks`, qui attend exactement cette forme de zone.
   */
  function invertedFvgs(c, fvgs) {
    const zones = fvgs
      .filter((f) => f.closedThroughAt !== null)
      .map((f) => ({
        kind: 'ifvg',
        dir: -f.dir,                             // le FVG change de camp
        top: f.top,
        bottom: f.bottom,
        mid: f.mid,
        index: f.index,
        createdAt: f.closedThroughAt,
        fromFvgDir: f.dir,
      }));
    return trackBlocks(c, zones);
  }

  // ---------------------------------------------------------------------------
  // Liquidité : Equal Highs / Equal Lows, BSL / SSL, sweeps
  // ---------------------------------------------------------------------------
  function sweepInfo(c, level, side, start) {
    for (let k = start; k < c.length; k++) {
      if (side === 'high' ? c[k].high > level : c[k].low < level) {
        const rejected = side === 'high' ? c[k].close < level : c[k].close > level;
        return { sweptAt: k, rejected };
      }
    }
    return { sweptAt: null, rejected: false };
  }

  function findLiquidity(c, swings, a, tolAtr) {
    const pools = [];
    for (const side of ['high', 'low']) {
      const list = side === 'high' ? swings.highs : swings.lows;
      for (let i = 1; i < list.length; i++) {
        const s2 = list[i];
        if (s2.confirmedAt >= c.length) continue;
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const s1 = list[j];
          const tol = tolAtr * a[s2.index];
          if (Math.abs(s1.price - s2.price) <= tol) {
            const level = side === 'high' ? Math.max(s1.price, s2.price) : Math.min(s1.price, s2.price);
            // Le niveau doit être resté intact entre les deux points.
            let intact = true;
            for (let k = s1.index + 1; k < s2.index; k++) {
              if (side === 'high' ? c[k].high > level : c[k].low < level) { intact = false; break; }
            }
            if (!intact) continue;
            pools.push({
              side, type: side === 'high' ? 'EQH' : 'EQL', level,
              from: s1.index, to: s2.index, confirmedAt: s2.confirmedAt,
              ...sweepInfo(c, level, side, s2.index + 1),
            });
            break;
          }
        }
      }
    }
    // Swings non pris = liquidité "externe" (BSL au-dessus, SSL en dessous)
    const swingLiquidity = [];
    for (const s of [...swings.highs, ...swings.lows]) {
      if (s.confirmedAt >= c.length) continue;
      swingLiquidity.push({
        side: s.side, type: s.side === 'high' ? 'BSL' : 'SSL', level: s.price,
        from: s.index, ...sweepInfo(c, s.price, s.side, s.index + 1),
      });
    }
    const sweeps = swingLiquidity
      .filter((l) => l.sweptAt !== null && l.rejected)
      .concat(pools.filter((p) => p.sweptAt !== null && p.rejected))
      .sort((x, y) => x.sweptAt - y.sweptAt);
    return { pools, swingLiquidity, sweeps };
  }

  // ---------------------------------------------------------------------------
  // Niveaux clés ICT : PDH / PDL, Midnight Open (heure NY)
  // ---------------------------------------------------------------------------
  function keyLevels(c) {
    const days = [];
    for (let i = 0; i < c.length; i++) {
      const key = nyParts(c[i].time).dateKey;
      let d = days[days.length - 1];
      if (!d || d.key !== key) {
        d = { key, high: -Infinity, low: Infinity, open: c[i].open, start: i, end: i };
        days.push(d);
      }
      d.high = Math.max(d.high, c[i].high);
      d.low = Math.min(d.low, c[i].low);
      d.end = i;
    }
    const res = {};
    if (days.length >= 2) {
      const prev = days[days.length - 2];
      res.pdh = { price: prev.high, from: prev.start };
      res.pdl = { price: prev.low, from: prev.start };
    }
    if (days.length >= 1) {
      const cur = days[days.length - 1];
      res.midnightOpen = { price: cur.open, from: cur.start };
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Quarterly Theory : quarts de journée, blocs de 90 min, True Opens
  // ---------------------------------------------------------------------------
  // La journée se découpe en quatre quarts de 6 h (heure de New York), chacun
  // subdivisé en quatre blocs de 90 min. La séquence attendue est AMDX :
  // accumulation, manipulation, distribution, puis continuation ou retournement.
  //
  // La variante XAMD (l'expansion d'abord) existe quand le cycle se décale :
  // c'est un jugement de trader, pas une règle mécanique, donc non codée ici.
  //
  // Comme les killzones, ce découpage suppose des sessions : il n'a pas de sens
  // pour les indices synthétiques, qui cotent en continu.
  const DAILY_QUARTERS = [
    { id: 'q1', name: 'Q1 Asie', start: 18 * 60, end: 24 * 60, phase: 'Accumulation' },
    { id: 'q2', name: 'Q2 Londres', start: 0, end: 6 * 60, phase: 'Manipulation' },
    { id: 'q3', name: 'Q3 New York', start: 6 * 60, end: 12 * 60, phase: 'Distribution' },
    { id: 'q4', name: 'Q4 Après-midi', start: 12 * 60, end: 18 * 60, phase: 'Continuation / retournement' },
  ];

  const SUB_MINUTES = 90;

  /**
   * Quart de journée et bloc de 90 min contenant un instant donné.
   * `trueSessionOpen` est le début du 2e bloc du quart : l'ouverture « vraie »
   * de la session, après la manipulation du 1er bloc.
   */
  function quarterOf(ts) {
    const p = nyParts(ts);
    const m = p.hour * 60 + p.minute;
    const q = DAILY_QUARTERS.find((x) => m >= x.start && m < x.end);
    if (!q) return null;
    const sub = Math.floor((m - q.start) / SUB_MINUTES) + 1;
    return {
      id: q.id,
      name: q.name,
      phase: q.phase,
      start: q.start,
      end: q.end,
      sub,                                        // 1 à 4
      subStart: q.start + (sub - 1) * SUB_MINUTES,
      subEnd: q.start + sub * SUB_MINUTES,
      trueSessionOpen: q.start + SUB_MINUTES,
    };
  }

  /** Minutes depuis minuit (heure de New York). */
  function nyMinutes(ts) {
    const p = nyParts(ts);
    return p.hour * 60 + p.minute;
  }

  /**
   * True Opens : prix de référence du cycle, pris à l'ouverture de son 2e quart.
   *
   * - `tdo` (jour) : 00:00 à New York, c'est-à-dire le début du Q2 Londres.
   * - `wto` (semaine) : lundi 18:00 à New York.
   *
   * Les True Opens mensuel et annuel demandent des mois d'historique : hors de
   * portée d'un graphique intraday, donc non calculés.
   */
  function trueOpens(c) {
    const res = { tdo: null, wto: null };
    for (let i = 0; i < c.length; i++) {
      const p = nyParts(c[i].time);
      const m = p.hour * 60 + p.minute;
      const prev = i > 0 ? nyParts(c[i - 1].time) : null;

      // Première bougie d'un jour à New York
      if (!prev || prev.dateKey !== p.dateKey) {
        res.tdo = { price: c[i].open, index: i, time: c[i].time };
      }
      // Première bougie à partir de lundi 18:00
      if (p.weekday === 'Mon' && m >= 18 * 60) {
        const prevBefore = !prev || prev.weekday !== 'Mon' || prev.hour * 60 + prev.minute < 18 * 60;
        if (prevBefore) res.wto = { price: c[i].open, index: i, time: c[i].time };
      }
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Régime du jour : expansion, normal, consolidation
  // ---------------------------------------------------------------------------
  // La range du jour comparée à la médiane des jours précédents. La médiane, et
  // non la moyenne : un seul jour d'annonce économique suffirait à faire paraître
  // normaux tous les suivants.
  //
  // La conséquence pratique est celle qu'énonce HugoFX : un marché en expansion
  // se trade sur les unités supérieures, où les niveaux tiennent mieux et les
  // swings sont longs ; un marché en consolidation se trade sur les unités
  // inférieures.
  function medianOf(values) {
    if (!values.length) return 0;
    const v = [...values].sort((x, y) => x - y);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function dayRegime(c, lookback, expandRatio, quietRatio) {
    const days = dayBuckets(c);
    if (days.length < 3) return null;

    // Le jour en cours n'est pas terminé : sa range est mécaniquement plus
    // petite que celle d'une journée pleine, et le comparer classerait tout en
    // consolidation. On juge donc le dernier jour **complet**, et on indique à
    // part où en est la journée en cours.
    const last = days.length - 1;
    const running = days[last].end === c.length - 1;
    const subject = running ? last - 1 : last;
    if (subject < 2) return null;

    const ranges = days.map((d) => d.high - d.low);
    const cur = ranges[subject];
    const ref = ranges.slice(Math.max(0, subject - lookback), subject);
    const median = medianOf(ref);
    if (median <= 0) return null;

    const ratio = cur / median;
    const kind = ratio >= expandRatio ? 'expansion' : ratio <= quietRatio ? 'consolidation' : 'normal';

    return {
      kind,
      ratio,
      range: cur,
      median,
      days: ref.length,
      key: days[subject].key,
      // Journée en cours, donnée pour information : sa range n'est pas comparable
      running: running ? { key: days[last].key, range: ranges[last], ratio: ranges[last] / median } : null,
      advice: kind === 'expansion'
        ? 'Expansion : privilégier les unités de temps supérieures, les niveaux y tiennent mieux.'
        : kind === 'consolidation'
          ? 'Consolidation : privilégier les unités de temps inférieures.'
          : 'Journée dans la norme.',
    };
  }

  // ---------------------------------------------------------------------------
  // Retracement doux vs retracement fort
  // ---------------------------------------------------------------------------
  // Critère de HugoFX, sur la jambe de retracement en cours : la question n'est
  // pas de savoir si le prix revient dans ton niveau, mais **comment** il y
  // revient.
  //
  //   doux : petites bougies alternées, aucun FVG laissé derrière, aucune zone
  //          qui bloquerait la suite — le niveau devrait tenir, le rejet est
  //          jouable ;
  //   fort : displacement, un FVG et un order block laissés derrière — la Smart
  //          Money s'est engagée dans ce sens, le niveau est en danger et ne se
  //          trade pas.
  //
  // Mesuré sur la jambe qui va du dernier extrême de structure jusqu'à la
  // dernière bougie : trois indices objectifs, et la décision au vote.
  function retracementStrength(c, a, swings, trend, fvgs, opts) {
    const n = c.length;
    if (!trend) return null;

    // Départ de la jambe : dernier extrême dans le sens de la tendance
    const pool = trend === 1 ? swings.highs : swings.lows;
    const anchor = [...pool].reverse().find((sw) => sw.confirmedAt < n);
    if (!anchor) return null;
    const from = anchor.index;
    const bars = n - 1 - from;
    if (bars < 2) return null;

    const atrNow = a[n - 1] || 0;
    if (atrNow <= 0) return null;

    // Le retracement va contre la tendance
    const dir = -trend;

    // Encore faut-il qu'il y ait retracement : si le prix a dépassé l'extrême
    // d'ancrage, la jambe est une expansion, pas un retour. Rien à classer.
    const anchorPrice = trend === 1 ? c[from].high : c[from].low;
    const retraced = trend === 1 ? c[n - 1].close < anchorPrice : c[n - 1].close > anchorPrice;
    if (!retraced) return null;

    // 1. plus gros corps de la jambe, en ATR
    let maxBody = 0;
    for (let i = from + 1; i < n; i++) {
      maxBody = Math.max(maxBody, Math.abs(c[i].close - c[i].open));
    }
    const bodyAtr = maxBody / atrNow;

    // 2. FVG laissés par la jambe, dans le sens du retracement
    const legFvgs = fvgs.filter(
      (f) => f.dir === dir && f.createdAt > from && f.status !== 'filled',
    );

    // 3. plus longue suite de corps de même sens.
    //    Un retracement doux alterne — « petite bougie haussière, après on fait
    //    noir » ; une suite ininterrompue signe un engagement. Compter les order
    //    blocks ne marcherait pas : dans cette app ils naissent sur une cassure
    //    de structure, et une jambe de retracement n'en contient aucune.
    let run = 0;
    let longestRun = 0;
    for (let i = from + 1; i < n; i++) {
      if (bodyDir(c[i]) === dir) { run++; longestRun = Math.max(longestRun, run); } else run = 0;
    }

    // Vote : deux indices sur trois suffisent à qualifier un retracement fort
    const signs = [
      bodyAtr >= opts.strongBodyAtr,
      legFvgs.length > 0,
      longestRun >= opts.strongRunLength,
    ];
    const score = signs.filter(Boolean).length;
    const strong = score >= 2;

    return {
      kind: strong ? 'fort' : 'doux',
      strong,
      dir,
      from,
      bars,
      bodyAtr,
      fvgCount: legFvgs.length,
      longestRun,
      score,
      // Conséquence pratique, telle qu'il l'énonce
      verdict: strong
        ? 'La Smart Money s’est engagée dans le retracement : le niveau opposé est en danger, ne pas le trader.'
        : 'Retracement sans trace : le niveau opposé devrait tenir, le rejet est jouable.',
    };
  }

  // ---------------------------------------------------------------------------
  // Turtle soup / CRT : prise de liquidité sur la bougie précédente
  // ---------------------------------------------------------------------------
  // Motif à deux bougies : la mèche sort du plus haut (ou du plus bas) de la
  // bougie précédente, mais la clôture revient **à l'intérieur** de sa range, et
  // le corps ne dépasse pas. La liquidité est prise, la direction ne change pas.
  //
  // C'est distinct des sweeps déjà détectés, qui portent sur des niveaux de
  // swing : ici la référence est la seule bougie d'avant, ce qui en fait un
  // signal beaucoup plus local et beaucoup plus fréquent.
  const MAX_TURTLE = 8;

  /**
   * `minWickAtr` : dépassement minimal de la bougie précédente, en multiples
   * d'ATR. Le réglage est déterminant, et c'est la mesure sur données réelles
   * qui a fixé le défaut — sur BTCUSDT en 1 h, le motif touche :
   *   0,10 ATR → 29 % des bougies (du bruit) ;
   *   0,25 ATR → 15 % ;
   *   0,50 ATR → 5 %, environ une bougie sur vingt — un événement notable.
   *
   * Même à 0,50, le motif ne vaut que **dans un niveau clé** : seul, il ne dit
   * rien. C'est la checklist du setup qui fait ce rapprochement.
   */
  function findTurtleSoup(c, a, minWickAtr) {
    const out = [];
    for (let i = 1; i < c.length; i++) {
      const prev = c[i - 1];
      const b = c[i];
      const margin = minWickAtr * (a[i] || 0);
      const bodyTop = Math.max(b.open, b.close);
      const bodyBottom = Math.min(b.open, b.close);

      // Prise de liquidité en haut : le vrai mouvement attendu est baissier
      if (b.high > prev.high + margin && b.close < prev.high && bodyTop <= prev.high) {
        out.push({
          kind: 'turtle', dir: -1, side: 'high',
          level: prev.high, wick: b.high, index: i, time: b.time,
        });
        continue;
      }
      if (b.low < prev.low - margin && b.close > prev.low && bodyBottom >= prev.low) {
        out.push({
          kind: 'turtle', dir: 1, side: 'low',
          level: prev.low, wick: b.low, index: i, time: b.time,
        });
      }
    }
    return out.slice(-MAX_TURTLE);
  }

  // ---------------------------------------------------------------------------
  // CISD : Change in State of Delivery
  // ---------------------------------------------------------------------------
  // Une bougie dont le **corps clôture au-delà du prix d'ouverture de la série
  // de bougies opposées** qui venait de livrer le prix. C'est le signal de
  // retournement le plus précoce de la méthode : il se lit sur les corps, là où
  // le MSS se lit sur les mèches et les swings, donc il déclenche avant.
  //
  // Le niveau du CISD est cette ouverture franchie : c'est elle qu'on surveille,
  // pas la bougie de cassure.
  const MAX_CISD = 6;

  /** Sens d'une bougie par son corps : +1 haussière, -1 baissière, 0 doji. */
  function bodyDir(b) {
    return b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
  }

  /**
   * Repère les CISD. `minLeg` est le nombre minimal de bougies consécutives
   * exigé pour parler de « jambe de livraison » : une seule bougie opposée est
   * du bruit, pas une livraison.
   */
  function findCisd(c, minLeg) {
    const out = [];
    const n = c.length;

    for (let i = 1; i < n; i++) {
      const dir = bodyDir(c[i]);
      if (dir === 0) continue;

      // Jambe de livraison opposée immédiatement avant la bougie i
      let k = i - 1;
      while (k >= 0 && bodyDir(c[k]) === -dir) k--;
      const legStart = k + 1;
      const legLength = i - legStart;
      if (legLength < minLeg) continue;

      // Le niveau à franchir : l'ouverture de la première bougie de la jambe
      const level = c[legStart].open;
      const broken = dir === 1 ? c[i].close > level : c[i].close < level;
      if (!broken) continue;

      out.push({
        kind: 'cisd',
        dir,
        level,
        index: i,
        time: c[i].time,
        legStart,
        legLength,
        // extrême atteint par la jambe : référence de stop naturelle
        legExtreme: dir === 1
          ? Math.min(...c.slice(legStart, i).map((b) => b.low))
          : Math.max(...c.slice(legStart, i).map((b) => b.high)),
      });
    }

    return out.slice(-MAX_CISD);
  }

  // ---------------------------------------------------------------------------
  // Unicorn : breaker block chevauchant un FVG
  // ---------------------------------------------------------------------------
  // Quatre ingrédients, dans l'ordre :
  //   1. balayage d'une poche de liquidité ;
  //   2. cassure de structure (MSS / CHoCH) en sens inverse ;
  //   3. FVG laissé par l'impulsion de cette cassure ;
  //   4. breaker block — l'order block opposé que le prix a traversé en clôture.
  //
  // La condition qui fait l'Unicorn est le **chevauchement** du breaker et du
  // FVG : s'ils n'occupent pas le même territoire de prix, ce n'est pas un
  // Unicorn, juste un breaker et un FVG voisins.
  //
  // Entrée au CE (50 %) du FVG situé dans le breaker ; stop au-delà de l'extrême
  // balayé, jamais dans le chevauchement.
  //
  // Trois contrôles de matérialité, chacun ajouté après avoir vu le cas inverse
  // sur données réelles :
  //   - `overlapAtr` : un chevauchement de 11 points pour un ATR de 314 n'est
  //     pas une confluence, c'est deux zones qui se frôlent par le bord ;
  //   - le CE du FVG peut tomber hors du chevauchement quand le FVG déborde
  //     largement du breaker : l'entrée est alors ramenée dans la zone tradable ;
  //   - `sweepAtr` : une fenêtre seulement temporelle laissait passer un
  //     balayage situé 4000 points plus bas. Le balayage doit aussi être proche
  //     en prix, sinon le stop qu'il donne n'a aucun sens.
  const MAX_UNICORNS = 5;

  function findUnicorns(c, blocks, fvgs, liquidity, events, recent, overlapAtr, sweepAtr) {
    const a = atr(c);
    const out = [];
    const breakers = blocks.filter((z) => z.kind === 'breaker' && z.status !== 'invalidated');

    for (const b of breakers) {
      // 3. un FVG de même sens, encore ouvert, né de l'impulsion (donc pas avant
      //    la naissance du breaker) et chevauchant sa zone
      const candidates = fvgs.filter(
        (f) => f.dir === b.dir
          && f.status !== 'filled'
          && f.createdAt >= b.createdAt - recent
          && f.bottom <= b.top && f.top >= b.bottom,
      );
      if (!candidates.length) continue;
      // le plus proche de la naissance du breaker : c'est l'impulsion en cause
      candidates.sort((x, y) => Math.abs(x.createdAt - b.createdAt) - Math.abs(y.createdAt - b.createdAt));
      const fvg = candidates[0];

      // 2. cassure de structure dans le sens du breaker, autour de sa naissance
      const mss = [...events].reverse().find(
        (e) => e.dir === b.dir && e.to <= b.createdAt + recent && e.to >= b.createdAt - recent,
      );
      if (!mss) continue;

      const overlap = { top: Math.min(b.top, fvg.top), bottom: Math.max(b.bottom, fvg.bottom) };
      const atrNow = a[b.createdAt] || 0;
      // chevauchement matériel exigé
      if (atrNow > 0 && overlap.top - overlap.bottom < overlapAtr * atrNow) continue;

      // 1. balayage de la liquidité opposée. Trois conditions, et la troisième
      //    n'est pas une finesse : le balayage doit être du bon **côté** de la
      //    zone. Un creux balayé *au-dessus* d'une zone d'achat donnerait un
      //    stop au-dessus de l'entrée, ce qui ne veut rien dire. Vu sur BNBUSDT
      //    en 1 h, où la seule contrainte de distance laissait passer un balayage
      //    situé 23 points au-dessus de la zone.
      const side = b.dir === 1 ? 'low' : 'high';
      const reach = atrNow > 0 ? sweepAtr * atrNow : Infinity;
      const edge = side === 'low' ? overlap.bottom : overlap.top;
      const sweep = [...liquidity.sweeps].reverse().find(
        (sw) => sw.side === side
          && sw.sweptAt <= b.createdAt && sw.sweptAt >= b.createdAt - 2 * recent
          && (side === 'low' ? sw.level <= edge : sw.level >= edge)
          && Math.abs(sw.level - edge) <= reach,
      );
      if (!sweep) continue;

      // Stop au-delà de l'extrême réellement atteint par la mèche du balayage,
      // pas au niveau historique de la poche de liquidité.
      const swept = c[sweep.sweptAt];
      const sl = b.dir === 1 ? Math.min(swept.low, sweep.level) : Math.max(swept.high, sweep.level);

      // Entrée au CE du FVG, ramenée dans le chevauchement s'il est en dehors.
      const entryRaw = fvg.mid;
      const entry = Math.min(overlap.top, Math.max(overlap.bottom, entryRaw));

      out.push({
        kind: 'unicorn',
        dir: b.dir,
        index: Math.min(b.index, fvg.index),
        createdAt: b.createdAt,
        // zone tradable : l'intersection du breaker et du FVG
        top: overlap.top,
        bottom: overlap.bottom,
        // entrée au CE du FVG, ramenée dans la zone tradable si besoin
        entry,
        entryClamped: entry !== entryRaw,
        // stop au-delà de l'extrême atteint par le balayage
        sl,
        sweepLevel: sweep.level,
        breaker: { top: b.top, bottom: b.bottom, index: b.index },
        fvg: { top: fvg.top, bottom: fvg.bottom, mid: fvg.mid, index: fvg.index },
        mssType: mss.type,
        mssAt: mss.to,
        sweepType: sweep.type,
        sweptAt: sweep.sweptAt,
        status: b.status,
      });
    }

    // Un Unicorn se définit par **le** FVG laissé par l'impulsion : plusieurs
    // breakers peuvent le chevaucher et produire des zones emboîtées, mais c'est
    // la même idée de trade. Un FVG ne donne donc qu'un seul Unicorn, celui dont
    // le chevauchement est le plus large — la confluence la plus forte.
    const best = new Map();
    for (const u of out) {
      const kept = best.get(u.fvg.index);
      if (!kept || u.top - u.bottom > kept.top - kept.bottom) best.set(u.fvg.index, u);
    }

    return [...best.values()]
      // Un risque nul rendrait tout ratio R/R absurde : la zone n'est pas tradable.
      .filter((u) => Math.abs(u.entry - u.sl) > 0)
      .sort((x, y) => x.createdAt - y.createdAt)
      .slice(-MAX_UNICORNS);
  }

  // ---------------------------------------------------------------------------
  // Profils de session et de semaine
  // ---------------------------------------------------------------------------
  // Deux questions, répondues par comptage sur l'historique chargé :
  //   - quelle session forme le plus souvent l'extrême de la journée ?
  //   - quel jour forme le plus souvent l'extrême de la semaine ?
  //
  // Ce sont des statistiques, pas des détections. Le nombre d'observations est
  // donc renvoyé avec les pourcentages : 1000 bougies de 15 min ne couvrent
  // qu'une dizaine de jours, bien trop peu pour conclure quoi que ce soit, et
  // l'affichage doit pouvoir le dire.
  const WEEKDAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** Découpe les bougies en jours (heure de New York), avec leurs extrêmes. */
  function dayBuckets(c) {
    const days = [];
    for (let i = 0; i < c.length; i++) {
      const p = nyParts(c[i].time);
      let d = days[days.length - 1];
      if (!d || d.key !== p.dateKey) {
        d = {
          key: p.dateKey, weekday: p.weekday, start: i, end: i,
          high: c[i].high, low: c[i].low, highAt: i, lowAt: i,
          open: c[i].open, close: c[i].close,
        };
        days.push(d);
      } else {
        if (c[i].high > d.high) { d.high = c[i].high; d.highAt = i; }
        if (c[i].low < d.low) { d.low = c[i].low; d.lowAt = i; }
        d.end = i;
        d.close = c[i].close;
      }
    }
    return days;
  }

  function profiles(c) {
    const days = dayBuckets(c);

    // Profil de session : quelle killzone porte l'extrême du jour
    // Les killzones ICT ne pavent pas la journée : un extrême peut tomber en
    // dehors. Il est compté à part, sinon les pourcentages ne feraient pas 100 %.
    const session = KILLZONES.map((k) => ({ id: k.id, name: k.name, high: 0, low: 0 }));
    const outside = { id: 'outside', name: 'Hors killzone', high: 0, low: 0 };
    const byId = new Map(session.map((x) => [x.id, x]));
    for (const d of days) {
      const kh = killzoneOf(c[d.highAt].time);
      const kl = killzoneOf(c[d.lowAt].time);
      (kh && byId.has(kh.id) ? byId.get(kh.id) : outside).high++;
      (kl && byId.has(kl.id) ? byId.get(kl.id) : outside).low++;
    }
    session.push(outside);

    // Profil de semaine : quel jour porte l'extrême de la semaine.
    // Une semaine neuve commence quand le jour de la semaine recule.
    const weeks = [];
    for (const d of days) {
      const w = weeks[weeks.length - 1];
      const prev = w && w.days[w.days.length - 1];
      if (!w || WEEKDAY_ORDER.indexOf(d.weekday) < WEEKDAY_ORDER.indexOf(prev.weekday)) {
        weeks.push({ days: [d] });
      } else {
        w.days.push(d);
      }
    }
    const weekday = WEEKDAY_ORDER.map((w) => ({ weekday: w, high: 0, low: 0, days: 0, up: 0 }));
    const byDay = new Map(weekday.map((x) => [x.weekday, x]));
    for (const d of days) {
      const row = byDay.get(d.weekday);
      if (!row) continue;
      row.days++;
      if (d.close > d.open) row.up++;
    }
    // Une semaine d'un seul jour n'a pas d'extrême à attribuer
    const fullWeeks = weeks.filter((w) => w.days.length >= 2);
    for (const w of fullWeeks) {
      let hi = w.days[0];
      let lo = w.days[0];
      for (const d of w.days) {
        if (d.high > hi.high) hi = d;
        if (d.low < lo.low) lo = d;
      }
      if (byDay.has(hi.weekday)) byDay.get(hi.weekday).high++;
      if (byDay.has(lo.weekday)) byDay.get(lo.weekday).low++;
    }

    return {
      days: days.length,
      weeks: fullWeeks.length,
      session,
      weekday: weekday.filter((x) => x.days > 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Judas Swing : le faux mouvement d'ouverture de session
  // ---------------------------------------------------------------------------
  // Mécanique en trois temps, dans l'ordre :
  //   1. balayage  : à l'ouverture de la session, le prix sort de la range de la
  //                  session précédente et y prend la liquidité ;
  //   2. retour    : une bougie clôture de nouveau à l'intérieur de la range —
  //                  c'est la confirmation, sans elle il n'y a qu'une sortie ;
  //   3. déplacement : le vrai mouvement part dans le sens inverse du balayage.
  //
  // Les sources s'accordent sur le cas Londres (range d'Asie balayée dans la
  // killzone de Londres) ; certaines refusent la variante New York. Les deux
  // sont donc détectées et nommées, et c'est au trader de trancher.
  const JUDAS_SESSIONS = [
    { id: 'london', name: 'Londres', rangeKz: 'asia', openKz: 'london' },
    { id: 'ny', name: 'New York', rangeKz: 'london', openKz: 'nyam' },
  ];

  const MAX_JUDAS = 5;

  /**
   * Repère les Judas Swings.
   *
   * `dispAtr` : déplacement minimal, en multiples d'ATR, exigé pour qualifier le
   * vrai mouvement. `sweepAtr` : dépassement minimal de la range, même unité —
   * sans lui, une mèche qui sort d'un tick d'une range étroite suffirait, et le
   * bruit de fond produirait des Judas Swings à la chaîne. Les deux seuils sont
   * à ajuster selon l'actif : un indice synthétique volatil et une paire Forex
   * ne respirent pas de la même façon.
   */
  function findJudasSwings(c, a, dispAtr, sweepAtr) {
    const out = [];

    for (const cfg of JUDAS_SESSIONS) {
      let ref = null;        // range de la session de référence, une fois terminée
      let building = null;   // range en cours de construction
      let cand = null;       // Judas Swing en cours d'examen

      for (let i = 0; i < c.length; i++) {
        const kz = killzoneOf(c[i].time);
        const id = kz ? kz.id : null;

        // Construction de la range de référence
        if (id === cfg.rangeKz) {
          if (!building) building = { high: c[i].high, low: c[i].low, start: i };
          else {
            building.high = Math.max(building.high, c[i].high);
            building.low = Math.min(building.low, c[i].low);
          }
          building.end = i;
        } else if (building) {
          ref = building;                         // range close : utilisable
          building = null;
        }

        if (id !== cfg.openKz) {
          if (cand) { out.push(cand); cand = null; }
          continue;
        }

        // Ouverture de la session : nouvelle fenêtre d'observation
        if (!cand) {
          if (!ref) continue;                     // pas de range de référence connue
          cand = {
            session: cfg.id,
            sessionName: cfg.name,
            rangeHigh: ref.high,
            rangeLow: ref.low,
            rangeFrom: ref.start,
            rangeTo: ref.end,
            dir: 0,
            sweepIndex: null,
            sweepLevel: null,
            confirmIndex: null,
            displaced: false,
            status: 'none',
            time: c[i].time,
            index: i,
          };
        }

        // 1. balayage — le premier côté franchi nettement fixe le sens
        if (cand.status === 'none') {
          const margin = sweepAtr * (a[i] || 0);
          if (c[i].high > cand.rangeHigh + margin) {
            // liquidité acheteuse prise en haut : le vrai mouvement est baissier
            Object.assign(cand, { dir: -1, sweepIndex: i, sweepLevel: c[i].high, status: 'swept' });
          } else if (c[i].low < cand.rangeLow - margin) {
            Object.assign(cand, { dir: 1, sweepIndex: i, sweepLevel: c[i].low, status: 'swept' });
          }
          continue;
        }

        // 2. retour dans la range, en clôture
        if (cand.status === 'swept') {
          const back = c[i].close <= cand.rangeHigh && c[i].close >= cand.rangeLow;
          if (back) { cand.confirmIndex = i; cand.status = 'confirmed'; }
          continue;
        }

        // 3. déplacement dans le sens inverse du balayage, avant la fin de session
        if (cand.status === 'confirmed') {
          const atrNow = a[cand.confirmIndex] || 0;
          const from = c[cand.confirmIndex].close;
          const moved = cand.dir === 1 ? c[i].high - from : from - c[i].low;
          if (atrNow > 0 && moved >= dispAtr * atrNow) {
            cand.displaced = true;
            cand.status = 'displaced';
            cand.displaceIndex = i;
          }
        }
      }

      if (cand) out.push(cand);
    }

    // Un balayage sans retour n'est pas un Judas Swing : on ne garde que les
    // fenêtres où au moins la confirmation a eu lieu.
    return out
      .filter((j) => j.status === 'confirmed' || j.status === 'displaced')
      .sort((x, y) => x.index - y.index)
      .slice(-MAX_JUDAS);
  }

  // ---------------------------------------------------------------------------
  // Écarts d'ouverture : NDOG (jour) et NWOG (semaine)
  // ---------------------------------------------------------------------------
  // L'écart entre la clôture d'une période et l'ouverture de la suivante est un
  // déséquilibre que le prix revient souvent combler. ICT en fait un niveau de
  // référence, avec son milieu (« consequent encroachment ») comme cible.
  //
  // Un écart doit être matériel pour compter. Sur un marché continu, l'ouverture
  // d'une bougie diffère souvent de la clôture précédente d'un seul tick : sur
  // BTCUSDT, un open sur deux décale de 0,01. Écarter les seuls écarts nuls
  // laisserait donc passer ces artefacts, d'où un seuil en multiples d'ATR,
  // comme pour les FVG.
  const MAX_GAPS = 5;

  /** Index de l'ordre des jours de la semaine en heure de New York. */
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /**
   * Suit le sort d'un écart après sa création.
   *
   * `intact` : le prix n'est pas revenu au milieu — l'écart reste une référence.
   * `ce`     : le milieu a été atteint (consequent encroachment), le niveau que
   *            la méthode ICT surveille réellement.
   * `filled` : l'écart a été parcouru de bout en bout, il ne sert plus.
   *
   * Le bord de l'écart n'est pas un critère : le prix ouvre dessus par
   * construction, le signaler n'apprendrait rien.
   */
  function gapStatus(c, gap, from) {
    let status = 'intact';
    let lowSeen = Infinity;
    let highSeen = -Infinity;
    for (let i = from; i < c.length; i++) {
      if (c[i].high >= gap.mid && c[i].low <= gap.mid) status = 'ce';
      lowSeen = Math.min(lowSeen, c[i].low);
      highSeen = Math.max(highSeen, c[i].high);
      if (lowSeen <= gap.bottom && highSeen >= gap.top) return 'filled';
    }
    return status;
  }

  /**
   * Repère les écarts d'ouverture de jour (NDOG) et de semaine (NWOG).
   * Un jour commence à minuit, heure de New York ; une semaine commence au
   * premier jour dont le jour de la semaine recule (dimanche après vendredi).
   */
  function openingGaps(c, a, minAtr = 0.1) {
    // Bornes des jours en heure de New York
    const days = [];
    for (let i = 0; i < c.length; i++) {
      const p = nyParts(c[i].time);
      const d = days[days.length - 1];
      if (!d || d.key !== p.dateKey) {
        days.push({ key: p.dateKey, weekday: p.weekday, start: i, end: i });
      } else {
        d.end = i;
      }
    }

    const ndog = [];
    const nwog = [];
    for (let k = 1; k < days.length; k++) {
      const prev = days[k - 1];
      const cur = days[k];
      const close = c[prev.end].close;
      const open = c[cur.start].open;
      const width = Math.abs(open - close);
      const atrNow = a ? a[cur.start] : 0;
      // Sans ATR disponible, on retombe sur le seul test possible : un écart non nul.
      const floor = atrNow > 0 ? minAtr * atrNow : 0;
      if (width <= floor) continue;

      const gap = {
        top: Math.max(close, open),
        bottom: Math.min(close, open),
        close,
        open,
        // `index` et non `from` : même forme que les OB et les FVG, donc le même
        // code de dessin les accepte sans adaptation.
        index: cur.start,
        time: c[cur.start].time,
      };
      gap.mid = (gap.top + gap.bottom) / 2;      // consequent encroachment
      gap.status = gapStatus(c, gap, cur.start);  // exige gap.mid, calculé juste avant

      // Un recul du jour de la semaine marque le passage à une semaine neuve.
      const newWeek = WEEKDAYS[cur.weekday] < WEEKDAYS[prev.weekday];
      (newWeek ? nwog : ndog).push(Object.assign({ kind: newWeek ? 'nwog' : 'ndog' }, gap));
    }

    return { ndog: ndog.slice(-MAX_GAPS), nwog: nwog.slice(-MAX_GAPS) };
  }

  // ---------------------------------------------------------------------------
  // Premium / Discount + OTE
  // ---------------------------------------------------------------------------
  function premiumDiscount(c, swings, trend) {
    const n = c.length;
    const hs = swings.highs.filter((s) => s.confirmedAt < n);
    const ls = swings.lows.filter((s) => s.confirmedAt < n);
    if (!hs.length || !ls.length) return null;
    let hi = hs[hs.length - 1];
    let lo = ls[ls.length - 1];
    let high = hi.price;
    let low = lo.price;
    let highIndex = hi.index;
    let lowIndex = lo.index;
    for (let k = hi.index + 1; k < n; k++) if (c[k].high > high) { high = c[k].high; highIndex = k; }
    for (let k = lo.index + 1; k < n; k++) if (c[k].low < low) { low = c[k].low; lowIndex = k; }
    const range = high - low;
    if (range <= 0) return null;
    const eq = (high + low) / 2;
    const price = c[n - 1].close;
    const position = (price - low) / range; // 0 = bas du range, 1 = haut
    // OTE : retracement 62 % – 79 % de la jambe dans le sens de la tendance
    const ote = trend === -1
      ? { from: low + 0.62 * range, to: low + 0.79 * range }
      : { from: high - 0.79 * range, to: high - 0.62 * range };
    return {
      high, low, eq, highIndex, lowIndex, start: Math.min(highIndex, lowIndex),
      position, zone: position > 0.5 ? 'premium' : 'discount', ote,
    };
  }

  // ---------------------------------------------------------------------------
  // Setup de trade (aide à la décision — pas un conseil financier)
  // ---------------------------------------------------------------------------
  function buildSetup(c, a, ctx, htfBias, useKillzones) {
    const n = c.length;
    const dir = ctx.trend;
    if (!dir) return null;
    const price = c[n - 1].close;
    const atrNow = a[n - 1];

    const zones = [
      ...ctx.blocks.filter((z) => z.dir === dir && z.status !== 'invalidated'),
      ...ctx.fvgs.filter((f) => f.dir === dir && f.status !== 'filled'),
      ...(ctx.ifvgs || []).filter((z) => z.dir === dir && z.status !== 'invalidated'),
    ].filter((z) => (dir === 1 ? z.bottom < price : z.top > price));
    if (!zones.length) return { dir, zone: null, checklist: [], score: 0 };

    // Zone la plus proche du prix
    zones.sort((x, y) => (dir === 1 ? y.top - x.top : x.bottom - y.bottom));
    const zone = zones[0];
    const inZone = price <= zone.top && price >= zone.bottom;
    const entry = dir === 1 ? Math.min(zone.top, price) : Math.max(zone.bottom, price);
    const sl = dir === 1 ? zone.bottom - 0.2 * atrNow : zone.top + 0.2 * atrNow;
    const risk = Math.abs(entry - sl);

    // Cible : liquidité opposée non prise la plus proche
    const side = dir === 1 ? 'high' : 'low';
    const candidates = [
      ...ctx.liquidity.pools.filter((p) => p.side === side && p.sweptAt === null).map((p) => ({ price: p.level, label: p.type })),
      ...ctx.liquidity.swingLiquidity.filter((p) => p.side === side && p.sweptAt === null).map((p) => ({ price: p.level, label: p.type })),
    ];
    if (ctx.levels.pdh && dir === 1) candidates.push({ price: ctx.levels.pdh.price, label: 'PDH' });
    if (ctx.levels.pdl && dir === -1) candidates.push({ price: ctx.levels.pdl.price, label: 'PDL' });
    const beyond = candidates
      .filter((t) => (dir === 1 ? t.price > entry + risk : t.price < entry - risk))
      .sort((x, y) => (dir === 1 ? x.price - y.price : y.price - x.price));
    let target = beyond[0] || null;
    if (!target && ctx.pd) target = { price: dir === 1 ? ctx.pd.high : ctx.pd.low, label: dir === 1 ? 'Range high' : 'Range low' };
    const rr = target && risk > 0 ? Math.abs(target.price - entry) / risk : null;

    const recent = 30;
    const lastEvent = ctx.events[ctx.events.length - 1];
    const checklist = [
      {
        label: 'Biais HTF aligné',
        ok: htfBias === undefined || htfBias === null ? null : htfBias === dir,
      },
      {
        label: dir === 1 ? 'Prix en zone Discount' : 'Prix en zone Premium',
        ok: ctx.pd ? (dir === 1 ? ctx.pd.zone === 'discount' : ctx.pd.zone === 'premium') : null,
      },
      {
        label: dir === 1 ? 'Liquidité vendeuse (SSL) prise récemment' : 'Liquidité acheteuse (BSL) prise récemment',
        ok: ctx.liquidity.sweeps.some((s) => s.side === (dir === 1 ? 'low' : 'high') && s.sweptAt >= n - recent),
      },
      {
        label: 'Cassure de structure récente dans le sens du biais',
        ok: !!lastEvent && lastEvent.dir === dir && lastEvent.to >= n - 3 * recent,
      },
      {
        label: 'Zone de qualité (OB avec FVG / déplacement)',
        ok: zone.kind === 'fvg' || !!zone.hasFvg,
      },
      { label: 'Killzone active', ok: useKillzones ? !!killzoneOf(c[n - 1].time) : null },
      {
        label: 'Zone adossée à un écart d’ouverture (NWOG/NDOG)',
        ok: !ctx.gaps ? null : [...ctx.gaps.nwog, ...ctx.gaps.ndog]
          .filter((g) => g.status !== 'filled')
          // chevauchement de la zone d'entrée et de l'écart
          .some((g) => g.bottom <= zone.top && g.top >= zone.bottom),
      },
      {
        label: 'Turtle soup / CRT dans la zone d’entrée',
        ok: !ctx.turtle ? null : ctx.turtle.some(
          (t) => t.dir === dir && t.index >= n - recent
            && c[t.index].low <= zone.top && c[t.index].high >= zone.bottom,
        ),
      },
      {
        label: 'CISD récent dans le sens du biais',
        ok: !ctx.cisd ? null : ctx.cisd.some((x) => x.dir === dir && x.index >= n - recent),
      },
      {
        label: 'Judas Swing de session dans le sens du biais',
        ok: !useKillzones || !ctx.judas ? null
          : ctx.judas.some((j) => j.dir === dir && j.sweepIndex >= n - recent),
      },
      { label: 'Ratio risque/rendement ≥ 2', ok: rr !== null && rr >= 2 },
    ];
    const graded = checklist.filter((x) => x.ok !== null);
    const score = graded.length ? graded.filter((x) => x.ok).length / graded.length : 0;
    return { dir, zone, inZone, entry, sl, target, rr, checklist, score };
  }

  // ---------------------------------------------------------------------------
  // Point d'entrée
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    swingLength: 5, fvgMinAtr: 0.1, eqTolAtr: 0.1, htfBias: null, useKillzones: true,
    judasDispAtr: 1, judasSweepAtr: 0.25, gapMinAtr: 0.1,
    unicornRecent: 20, unicornOverlapAtr: 0.1, unicornSweepAtr: 3, cisdMinLeg: 2, turtleWickAtr: 0.5, breakerOnBodies: true, strongBodyAtr: 1.5, strongRunLength: 3,
    regimeLookback: 20, expansionRatio: 1.3, consolidationRatio: 0.7,
  };

  function analyze(candles, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const c = candles;
    const n = c.length;
    if (n < o.swingLength * 2 + 5) {
      return { ok: false, error: 'Pas assez de bougies pour analyser.' };
    }
    const a = atr(c);
    const swings = findSwings(c, o.swingLength);
    const st = analyzeStructure(c, swings);
    const fvgs = findFVGs(c, a, o.fvgMinAtr);

    // OB accompagné d'un FVG (déplacement) entre sa bougie et la cassure
    for (const ob of st.orderBlocks) {
      ob.hasFvg = fvgs.some((f) => f.dir === ob.dir && f.index > ob.index && f.index <= ob.breakIndex);
    }
    const blocks = trackBlocks(c, st.orderBlocks, o.breakerOnBodies);
    const ifvgs = invertedFvgs(c, fvgs);
    const liquidity = findLiquidity(c, swings, a, o.eqTolAtr);
    const levels = keyLevels(c);
    const gaps = openingGaps(c, a, o.gapMinAtr);
    const quarter = o.useKillzones ? quarterOf(c[n - 1].time) : null;
    const judas = o.useKillzones ? findJudasSwings(c, a, o.judasDispAtr, o.judasSweepAtr) : [];
    const profile = profiles(c);
    const cisd = findCisd(c, o.cisdMinLeg);
    const turtle = findTurtleSoup(c, a, o.turtleWickAtr);
    const retracement = retracementStrength(c, a, swings, st.trend, fvgs, o);
    const regime = dayRegime(c, o.regimeLookback, o.expansionRatio, o.consolidationRatio);
    const unicorns = findUnicorns(
      c, blocks, fvgs, liquidity, st.events,
      o.unicornRecent, o.unicornOverlapAtr, o.unicornSweepAtr,
    );
    const opens = o.useKillzones ? trueOpens(c) : { tdo: null, wto: null };
    const pd = premiumDiscount(c, swings, st.trend);

    const ctx = {
      trend: st.trend, events: st.events, blocks, fvgs, ifvgs, liquidity, levels, pd,
      gaps, judas, turtle, cisd, unicorns,
    };
    const setup = buildSetup(c, a, ctx, o.htfBias, o.useKillzones);

    return {
      ok: true,
      atr: a,
      swings,
      trend: st.trend,
      events: st.events,
      blocks,
      fvgs,
      ifvgs,
      liquidity,
      levels,
      gaps,
      quarter,
      judas,
      unicorns,
      cisd,
      turtle,
      retracement,
      regime,
      profile,
      trueOpens: opens,
      pd,
      setup,
      killzone: o.useKillzones ? killzoneOf(c[n - 1].time) : null,
      useKillzones: o.useKillzones,
    };
  }

  /** Regroupe des bougies dans une unité de temps supérieure (secondes). */
  function resample(c, seconds) {
    const out = [];
    for (const b of c) {
      const t = Math.floor(b.time / seconds) * seconds;
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
        last.volume += b.volume || 0;
      } else {
        out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Calculateur de position (l'ordre est passé à la main chez le broker)
  // ---------------------------------------------------------------------------
  const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);

  /**
   * Arithmétique complète d'un trade : distances, R/R, taille déduite du risque
   * et, si un volume est saisi, le risque réel qu'il représente.
   *
   * `unitsPerLot` est la taille d'un contrat chez le broker : 100 000 pour un
   * lot Forex standard, 100 pour l'or (XAU), 1 pour la plupart des indices.
   * Toutes les sommes sont dans la devise de cotation de l'actif.
   */
  function tradeMath(p) {
    const entry = Number(p.entry);
    const sl = Number(p.sl);
    if (!Number.isFinite(entry) || !Number.isFinite(sl)) return null;
    const stopDist = Math.abs(entry - sl);
    if (stopDist <= 0) return null;

    // Le stop est forcément du côté perdant : il donne le sens du trade.
    const dir = sl < entry ? 1 : -1;
    const tp = Number(p.tp);
    const hasTp = Number.isFinite(tp);
    const targetDist = hasTp ? Math.abs(tp - entry) : null;
    // Un objectif du mauvais côté de l'entrée est une saisie erronée, pas un trade.
    const tpValid = hasTp ? (dir === 1 ? tp > entry : tp < entry) : null;
    const rr = tpValid && targetDist > 0 ? targetDist / stopDist : null;

    const capital = pos(Number(p.capital));
    const riskPct = pos(Number(p.riskPct));
    const unitsPerLot = pos(Number(p.unitsPerLot));

    let fromRisk = null;
    if (capital && riskPct && riskPct <= 100) {
      const riskMoney = capital * (riskPct / 100);
      const units = riskMoney / stopDist;
      fromRisk = {
        riskMoney,
        units,
        lots: unitsPerLot ? units / unitsPerLot : null,
        rewardMoney: tpValid ? targetDist * units : null,
      };
    }

    let fromLots = null;
    const lots = pos(Number(p.lots));
    if (lots && unitsPerLot) {
      const units = lots * unitsPerLot;
      const riskMoney = stopDist * units;
      fromLots = {
        lots,
        units,
        riskMoney,
        rewardMoney: tpValid ? targetDist * units : null,
        riskPctOfCapital: capital ? (riskMoney / capital) * 100 : null,
      };
    }

    return {
      dir, stopDist, targetDist, rr, tpValid,
      pointValuePerLot: unitsPerLot,
      fromRisk, fromLots,
    };
  }

  // ---------------------------------------------------------------------------
  // Taille de position (raccourci utilisé par la carte Setup)
  // ---------------------------------------------------------------------------
  // ponytail: unités de l'actif, pas des lots. Un lot Forex = 100 000 unités,
  // un contrat Deriv a sa propre échelle : conversion à la main chez le broker.
  // Ajouter une table de contrats par actif si l'usage le demande.
  function positionSize(entry, sl, capital, riskPct) {
    const perUnit = Math.abs(entry - sl);
    if (!Number.isFinite(perUnit) || perUnit <= 0) return null;
    if (!Number.isFinite(capital) || capital <= 0) return null;
    if (!Number.isFinite(riskPct) || riskPct <= 0) return null;
    const riskMoney = capital * (riskPct / 100);
    return { riskMoney, perUnit, units: riskMoney / perUnit };
  }

  const SMC = {
    analyze, atr, findSwings, analyzeStructure, trackBlocks, findFVGs, invertedFvgs, findLiquidity,
    keyLevels, openingGaps, premiumDiscount, resample, nyParts, nyOffsetSeconds, nyMinutes,
    killzoneOf, KILLZONES, quarterOf, trueOpens, DAILY_QUARTERS, findJudasSwings,
    profiles, dayBuckets, findUnicorns, findCisd, findTurtleSoup, bodyDir,
    retracementStrength, dayRegime, positionSize, tradeMath,
  };
  root.SMC = SMC;
  if (typeof module !== 'undefined' && module.exports) module.exports = SMC;
})(typeof window !== 'undefined' ? window : globalThis);
