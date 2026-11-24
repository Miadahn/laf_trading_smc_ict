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
  function trackBlocks(c, blocks) {
    const n = c.length;
    const out = [];
    const queue = blocks.slice();
    while (queue.length) {
      const z = queue.shift();
      z.mitigatedAt = null;
      z.invalidatedAt = null;
      for (let k = z.createdAt + 1; k < n; k++) {
        const b = c[k];
        if (z.mitigatedAt === null && (z.dir === 1 ? b.low <= z.top : b.high >= z.bottom)) z.mitigatedAt = k;
        if (z.dir === 1 ? b.close < z.bottom : b.close > z.top) {
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
      f.fill = 0; // proportion comblée (0 → 1)
      const size = f.top - f.bottom;
      for (let k = f.createdAt + 1; k < n; k++) {
        const b = c[k];
        if (f.dir === 1) {
          if (b.low < f.top) f.fill = Math.max(f.fill, Math.min(1, (f.top - b.low) / size));
          if (b.low <= f.bottom) { f.filledAt = k; break; }
        } else {
          if (b.high > f.bottom) f.fill = Math.max(f.fill, Math.min(1, (b.high - f.bottom) / size));
          if (b.high >= f.top) { f.filledAt = k; break; }
        }
      }
      f.status = f.filledAt !== null ? 'filled' : f.fill > 0 ? 'partial' : 'fresh';
    }
    return fvgs;
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
      { label: 'Ratio risque/rendement ≥ 2', ok: rr !== null && rr >= 2 },
    ];
    const graded = checklist.filter((x) => x.ok !== null);
    const score = graded.length ? graded.filter((x) => x.ok).length / graded.length : 0;
    return { dir, zone, inZone, entry, sl, target, rr, checklist, score };
  }

  // ---------------------------------------------------------------------------
  // Point d'entrée
  // ---------------------------------------------------------------------------
  const DEFAULTS = { swingLength: 5, fvgMinAtr: 0.1, eqTolAtr: 0.1, htfBias: null, useKillzones: true };

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
    const blocks = trackBlocks(c, st.orderBlocks);
    const liquidity = findLiquidity(c, swings, a, o.eqTolAtr);
    const levels = keyLevels(c);
    const pd = premiumDiscount(c, swings, st.trend);

    const ctx = { trend: st.trend, events: st.events, blocks, fvgs, liquidity, levels, pd };
    const setup = buildSetup(c, a, ctx, o.htfBias, o.useKillzones);

    return {
      ok: true,
      atr: a,
      swings,
      trend: st.trend,
      events: st.events,
      blocks,
      fvgs,
      liquidity,
      levels,
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

  const SMC = {
    analyze, atr, findSwings, analyzeStructure, findFVGs, findLiquidity,
    keyLevels, premiumDiscount, resample, nyParts, nyOffsetSeconds, killzoneOf, KILLZONES,
  };
  root.SMC = SMC;
  if (typeof module !== 'undefined' && module.exports) module.exports = SMC;
})(typeof window !== 'undefined' ? window : globalThis);
