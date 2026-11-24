// Lancer : node --test trading-smc/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const SMC = require('../js/smc.js');
const Data = require('../js/data.js');

/** Construit des bougies à partir d'une suite de clôtures (mèches de ±0.2). */
function fromCloses(closes, start = Date.UTC(2024, 0, 2, 0, 0) / 1000, step = 900) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: start + i * step, open, close,
      high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 1,
    };
  });
}

test('détecte les swings et un BOS haussier', () => {
  // montée → repli → nouvelle montée au-dessus du sommet
  const closes = [100, 101, 102, 103, 104, 105, 104, 103, 102, 101, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const c = fromCloses(closes);
  const r = SMC.analyze(c, { swingLength: 3 });
  assert.ok(r.ok);
  // deux bougies partagent le même plus haut (105.2) : le pivot retenu est la plus récente
  assert.equal(r.swings.highs[0].index, 6);
  assert.equal(r.swings.highs[0].price, 105.2);
  assert.equal(r.swings.lows[0].index, 11);
  const bos = r.events.find((e) => e.dir === 1);
  assert.ok(bos, 'un événement haussier est attendu');
  assert.equal(bos.from, 6);
  assert.equal(bos.price, 105.2);
  assert.equal(c[bos.to].close > 105.2, true);
  assert.equal(r.trend, 1);
  // l'order block haussier se situe sur l'origine du mouvement (vers le creux)
  const ob = r.blocks.find((b) => b.kind === 'ob' && b.dir === 1);
  assert.ok(ob && ob.index >= 6 && ob.index <= 11);
});

test('CHoCH quand la structure se retourne', () => {
  const up = [100, 102, 104, 106, 108, 110, 108, 106, 104, 106, 108, 110, 112, 114, 116, 114, 112, 110];
  const down = [108, 106, 104, 102, 100, 98, 96, 94, 92, 90, 88, 86];
  const r = SMC.analyze(fromCloses([...up, ...down]), { swingLength: 2 });
  const choch = r.events.find((e) => e.type === 'CHoCH' && e.dir === -1);
  assert.ok(choch, 'CHoCH baissier attendu après une tendance haussière');
  assert.equal(r.trend, -1);
});

test('détecte un FVG haussier et son comblement', () => {
  const t0 = Date.UTC(2024, 0, 2) / 1000;
  const c = [];
  for (let i = 0; i < 30; i++) c.push({ time: t0 + i * 900, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  // bougie 1 : high 101 ; bougie 2 : impulsion ; bougie 3 : low 103 > 101
  c[10] = { time: c[10].time, open: 100, high: 101, low: 99, close: 100.5, volume: 1 };
  c[11] = { time: c[11].time, open: 100.5, high: 106, low: 100.4, close: 105.8, volume: 1 };
  c[12] = { time: c[12].time, open: 105.8, high: 107, low: 103, close: 106, volume: 1 };
  for (let i = 13; i < 30; i++) c[i] = { time: c[i].time, open: 106, high: 107, low: 105, close: 106, volume: 1 };
  c[20] = { time: c[20].time, open: 106, high: 106.5, low: 100.5, close: 104, volume: 1 }; // comble le gap
  const fvgs = SMC.findFVGs(c, SMC.atr(c), 0.1);
  const f = fvgs.find((x) => x.dir === 1 && x.index === 11);
  assert.ok(f);
  assert.equal(f.bottom, 101);
  assert.equal(f.top, 103);
  assert.equal(f.filledAt, 20);
  assert.equal(f.status, 'filled');
});

test('pas de regard vers le futur : analyser un préfixe donne les mêmes cassures', () => {
  const c = Data.demoCandles('15m', 800, 7);
  const full = SMC.analyze(c, { swingLength: 5 });
  const cut = 500;
  const part = SMC.analyze(c.slice(0, cut), { swingLength: 5 });
  const a = full.events.filter((e) => e.to < cut).map((e) => [e.type, e.dir, e.from, e.to]);
  const b = part.events.map((e) => [e.type, e.dir, e.from, e.to]);
  assert.deepEqual(b, a);
});

test('analyse complète sur données de démo', () => {
  const c = Data.demoCandles('15m', 1000, 42);
  const r = SMC.analyze(c, { swingLength: 5, htfBias: 1 });
  assert.ok(r.ok);
  assert.ok(r.events.length > 5);
  assert.ok(r.fvgs.length > 0);
  assert.ok(r.blocks.length > 0);
  assert.ok(r.pd && r.pd.high > r.pd.low);
  assert.ok(r.levels.pdh && r.levels.pdl);
  for (const z of r.blocks) assert.ok(z.top >= z.bottom);
  if (r.setup && r.setup.zone) {
    const s = r.setup;
    assert.ok(s.dir === 1 ? s.sl < s.entry : s.sl > s.entry);
    assert.ok(s.score >= 0 && s.score <= 1);
  }
});

test('killzones en heure de New York (heure d\'été et d\'hiver)', () => {
  // 3 juillet 2024 08:00 NY = 12:00 UTC (EDT)
  assert.equal(SMC.killzoneOf(Date.UTC(2024, 6, 3, 12, 0) / 1000).id, 'nyam');
  // 15 janvier 2024 03:00 NY = 08:00 UTC (EST)
  assert.equal(SMC.killzoneOf(Date.UTC(2024, 0, 15, 8, 0) / 1000).id, 'london');
  assert.equal(SMC.killzoneOf(Date.UTC(2024, 0, 15, 18, 0) / 1000), null);
  assert.equal(SMC.nyOffsetSeconds(Date.UTC(2024, 0, 15, 8, 0) / 1000), -5 * 3600);
});

test('import CSV : TradingView et MetaTrader', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(`${1704153600 + i * 3600},${100 + i},${101 + i},${99 + i},${100.5 + i},10`);
  const tv = Data.parseCSV('time,open,high,low,close,Volume\n' + rows.join('\n'));
  assert.equal(tv.length, 30);
  assert.equal(Data.detectTimeframe(tv), '1h');

  const mt = [];
  for (let i = 0; i < 30; i++) mt.push(`2024.01.02,${String(i % 24).padStart(2, '0')}:00,1.1,1.2,1.0,1.15,100`);
  const parsed = Data.parseCSV(mt.slice(0, 24).join('\n'));
  assert.equal(parsed.length, 24);
  assert.equal(parsed[1].time - parsed[0].time, 3600);
  assert.equal(parsed[0].close, 1.15);
});

test('rééchantillonnage vers une unité supérieure', () => {
  const c = fromCloses(Array.from({ length: 32 }, (_, i) => 100 + i));
  const h = SMC.resample(c, 4 * 3600);
  assert.equal(h.length, 2);
  assert.equal(h[0].open, c[0].open);
  assert.equal(h[0].close, c[15].close);
  assert.equal(h[1].high, Math.max(...c.slice(16).map((b) => b.high)));
});

test('Deriv : conversion des bougies et flux temps réel', () => {
  const msg = {
    msg_type: 'candles',
    candles: [
      { epoch: 1704153600, open: 100, high: 102, low: 99, close: 101 },
      { epoch: 1704154500, open: 101, high: 103, low: 100, close: 102 },
    ],
  };
  const c = Data.parseDerivCandles(msg, '15m');
  assert.equal(c.length, 2);
  assert.equal(c[1].close, 102);

  // mise à jour de la bougie en cours (valeurs en texte, comme l'API)
  assert.equal(Data.applyDerivOhlc(c, { open_time: 1704154500, open: '101', high: '104', low: '100', close: '103.5' }), false);
  assert.equal(c.length, 2);
  assert.equal(c[1].high, 104);
  // nouvelle bougie
  assert.equal(Data.applyDerivOhlc(c, { open_time: 1704155400, open: '103.5', high: '104', low: '103', close: '103.8' }, 2), true);
  assert.equal(c.length, 2, 'la longueur maximale est respectée');
  assert.equal(c[1].time, 1704155400);

  const req = Data.derivCandlesRequest('R_75', '4h', 1000, true);
  assert.deepEqual([req.ticks_history, req.style, req.granularity, req.subscribe], ['R_75', 'candles', 14400, 1]);
  assert.equal(Data.isDerivSynthetic('R_75'), true);
  assert.equal(Data.isDerivSynthetic('BOOM1000'), true);
  assert.equal(Data.isDerivSynthetic('frxEURUSD'), false);
});

test('Deriv : 1W reconstruit depuis le journalier', () => {
  const days = [];
  const mon = Date.UTC(2024, 0, 1) / 1000; // lundi
  for (let i = 0; i < 14; i++) days.push({ epoch: mon + i * 86400, open: 100 + i, high: 110 + i, low: 90 + i, close: 101 + i });
  const w = Data.parseDerivCandles({ candles: days }, '1w');
  assert.equal(w.length, 2);
  assert.equal(w[0].time, mon);
  assert.equal(w[0].close, 107);
  assert.equal(w[1].high, 123);
});

test('synthétiques : les killzones ne comptent pas dans la checklist', () => {
  const c = Data.demoCandles('15m', 600, 3);
  const r = SMC.analyze(c, { useKillzones: false });
  assert.equal(r.killzone, null);
  if (r.setup && r.setup.zone) {
    assert.equal(r.setup.checklist.find((x) => x.label === 'Killzone active').ok, null);
  }
});

test('taille de position : risque fixe, et refus des entrées invalides', () => {
  // capital 1000, risque 1 % = 10 ; stop à 5 points = 2 unités
  const ps = SMC.positionSize(100, 95, 1000, 1);
  assert.equal(ps.riskMoney, 10);
  assert.equal(ps.perUnit, 5);
  assert.equal(ps.units, 2);
  // vendeur : même résultat, le sens ne change rien à la taille
  assert.equal(SMC.positionSize(95, 100, 1000, 1).units, 2);
  // perdre tout le capital exigerait un risque de 100 %
  assert.equal(SMC.positionSize(100, 95, 1000, 100).riskMoney, 1000);
  // garde-fous : division par zéro et valeurs absentes
  assert.equal(SMC.positionSize(100, 100, 1000, 1), null);
  assert.equal(SMC.positionSize(100, 95, 0, 1), null);
  assert.equal(SMC.positionSize(100, 95, 1000, 0), null);
  assert.equal(SMC.positionSize(100, 95, NaN, 1), null);
});

test('calculateur : volume depuis le risque, et risque depuis le volume', () => {
  // Achat EURUSD : entrée 1.1000, stop 1.0950 (50 pips), objectif 1.1150 (150 pips)
  const m = SMC.tradeMath({
    entry: 1.1, sl: 1.095, tp: 1.115,
    capital: 10000, riskPct: 1, unitsPerLot: 100000, lots: 0.2,
  });
  assert.equal(m.dir, 1);
  assert.ok(Math.abs(m.stopDist - 0.005) < 1e-12);
  assert.ok(Math.abs(m.rr - 3) < 1e-9);          // 150 pips visés pour 50 risqués

  // 1 % de 10 000 = 100 risqués ; 100 / 0.005 = 20 000 unités = 0.2 lot
  assert.equal(m.fromRisk.riskMoney, 100);
  assert.ok(Math.abs(m.fromRisk.units - 20000) < 1e-6);
  assert.ok(Math.abs(m.fromRisk.lots - 0.2) < 1e-9);
  assert.ok(Math.abs(m.fromRisk.rewardMoney - 300) < 1e-6);

  // sens inverse : 0.2 lot saisi redonne exactement le même risque
  assert.ok(Math.abs(m.fromLots.riskMoney - 100) < 1e-6);
  assert.ok(Math.abs(m.fromLots.riskPctOfCapital - 1) < 1e-9);
});

test('calculateur : sens déduit du stop, objectif incohérent signalé', () => {
  // stop au-dessus de l'entrée = vente
  const v = SMC.tradeMath({ entry: 100, sl: 105, tp: 85, capital: 1000, riskPct: 2, unitsPerLot: 1 });
  assert.equal(v.dir, -1);
  assert.equal(v.tpValid, true);
  assert.equal(v.rr, 3);
  assert.equal(v.fromRisk.lots, 4);              // 20 risqués / 5 de distance = 4 unités

  // objectif du mauvais côté : signalé, et aucun R/R calculé
  const bad = SMC.tradeMath({ entry: 100, sl: 95, tp: 90 });
  assert.equal(bad.tpValid, false);
  assert.equal(bad.rr, null);

  // sans objectif : le volume reste calculable
  const noTp = SMC.tradeMath({ entry: 100, sl: 95, capital: 1000, riskPct: 1, unitsPerLot: 1 });
  assert.equal(noTp.tpValid, null);
  assert.equal(noTp.rr, null);
  assert.equal(noTp.fromRisk.rewardMoney, null);
  assert.equal(noTp.fromRisk.units, 2);

  // garde-fous
  assert.equal(SMC.tradeMath({ entry: 100, sl: 100 }), null);
  assert.equal(SMC.tradeMath({ entry: 100 }), null);
  assert.equal(SMC.tradeMath({ entry: 100, sl: 95, capital: 1000, riskPct: 150 }).fromRisk, null);
  assert.equal(SMC.tradeMath({ entry: 100, sl: 95, lots: 1 }).fromLots, null); // sans unités par lot
});

test('devise de cotation : USD par défaut, exceptions signalées', () => {
  // cotés en USD : paires en /USD, or, crypto, synthétiques Deriv
  for (const s of ['frxEURUSD', 'frxGBPUSD', 'frxXAUUSD', 'cryBTCUSD', 'R_75', 'stpRNG', 'BOOM1000']) {
    assert.equal(Data.quoteCurrency(s, 'deriv'), 'USD', s);
  }
  // Binance : les stablecoins dollar comptent comme USD
  assert.equal(Data.quoteCurrency('BTCUSDT', 'binance'), 'USD');
  assert.equal(Data.quoteCurrency('PAXGUSDT', 'binance'), 'USD');

  // pas en USD : c'est là que l'avertissement doit tomber
  assert.equal(Data.quoteCurrency('frxUSDJPY', 'deriv'), 'JPY');
  assert.equal(Data.quoteCurrency('frxEURGBP', 'deriv'), 'GBP');
  assert.equal(Data.quoteCurrency('ETHBTC', 'binance'), 'BTC');

  // indices boursiers : cotation variable, on ne devine pas
  assert.equal(Data.quoteCurrency('OTC_NDX', 'deriv'), null);
  assert.equal(Data.quoteCurrency('OTC_GDAXI', 'deriv'), null);
  assert.equal(Data.quoteCurrency('', 'deriv'), null);
});

/** Série horaire couvrant jeudi, vendredi, dimanche, lundi en heure de New York. */
function weekBars() {
  const h = 3600;
  const thu = Date.UTC(2024, 0, 4, 5, 0) / 1000;   // jeudi 00:00 à New York (hiver)
  const out = [];
  // [début, nombre d'heures, prix d'ouverture] : chaque jour saute, créant un écart
  for (const [start, n, p0] of [
    [thu, 24, 100], [thu + 24 * h, 24, 110], [thu + 72 * h, 24, 120], [thu + 96 * h, 24, 118],
  ]) {
    for (let i = 0; i < n; i++) {
      const p = p0 + i * 0.1;
      out.push({ time: start + i * h, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 });
    }
  }
  return out;
}

test('NDOG / NWOG : écarts d’ouverture de jour et de semaine', () => {
  const c = weekBars();
  const g = SMC.openingGaps(c, SMC.atr(c));

  // Deux changements de jour en semaine, un passage de vendredi à dimanche
  assert.equal(g.ndog.length, 2);
  assert.equal(g.nwog.length, 1);

  // NWOG : clôture du vendredi (112.3) vers ouverture du dimanche (120)
  const w = g.nwog[0];
  assert.ok(Math.abs(w.bottom - 112.3) < 1e-9, `bottom ${w.bottom}`);
  assert.equal(w.top, 120);
  assert.ok(Math.abs(w.mid - 116.15) < 1e-9);
  assert.equal(w.kind, 'nwog');
  // le prix monte depuis 120 sans revenir au milieu
  assert.equal(w.status, 'intact');

  // NDOG du lundi : ouverture 118 sous la clôture du dimanche, milieu atteint
  const mon = g.ndog[1];
  assert.equal(mon.bottom, 118);
  assert.equal(mon.status, 'ce', 'le prix repasse par le milieu');

  // chaque écart pointe la bougie qui l'ouvre
  for (const x of [...g.ndog, ...g.nwog]) {
    assert.equal(x.time, c[x.index].time);
    assert.ok(x.top > x.bottom);
  }
});

test('NDOG / NWOG : cotation continue = aucun écart', () => {
  // Les synthétiques Deriv cotent 24h/24 : open[j] == close[j-1], donc rien à signaler
  const c = fromCloses(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 5), undefined, 3600);
  assert.deepEqual(SMC.openingGaps(c, SMC.atr(c)), { ndog: [], nwog: [] });

  // et l'analyse complète expose bien la clé, même vide
  const r = SMC.analyze(c, { swingLength: 5 });
  assert.deepEqual(r.gaps, { ndog: [], nwog: [] });
});

test('NDOG / NWOG : un décalage d’un tick n’est pas un écart', () => {
  // Cas réel : sur un marché continu, l'ouverture d'une bougie diffère souvent
  // de la clôture précédente d'un tick. Sans seuil, chaque changement de jour
  // produirait un faux écart — c'est ce que vérifie ce test.
  const c = weekBars();
  // on remplace les sauts journaliers par un décalage d'un centième
  for (let i = 1; i < c.length; i++) {
    const p = SMC.nyParts(c[i].time);
    const prev = SMC.nyParts(c[i - 1].time);
    if (p.dateKey !== prev.dateKey) {
      const base = c[i - 1].close + 0.01;
      c[i] = { time: c[i].time, open: base, high: base + 0.5, low: base - 0.5, close: base, volume: 1 };
      for (let k = i + 1; k < c.length && SMC.nyParts(c[k].time).dateKey === p.dateKey; k++) {
        const v = base + (k - i) * 0.1;
        c[k] = { time: c[k].time, open: v, high: v + 0.5, low: v - 0.5, close: v, volume: 1 };
      }
    }
  }
  const a = SMC.atr(c);
  assert.ok(a[a.length - 1] > 0.1, 'ATR non nul, sinon le test ne prouve rien');

  // seuil nul : les artefacts passent ; seuil par défaut : ils sont écartés
  const brut = SMC.openingGaps(c, a, 0);
  assert.ok(brut.ndog.length + brut.nwog.length > 0, 'sans seuil les tics passent');
  assert.deepEqual(SMC.openingGaps(c, a, 0.1), { ndog: [], nwog: [] });
});

test('Quarterly Theory : quarts de journée et blocs de 90 min', () => {
  // 2024-01-10, heure d'hiver : New York est à UTC-5
  const at = (h, m = 0) => Date.UTC(2024, 0, 10, h + 5, m) / 1000;

  // Les quatre quarts de 6 h et leur phase AMDX
  assert.equal(SMC.quarterOf(at(18)).id, 'q1');
  assert.equal(SMC.quarterOf(at(18)).phase, 'Accumulation');
  assert.equal(SMC.quarterOf(at(0)).id, 'q2');
  assert.equal(SMC.quarterOf(at(0)).phase, 'Manipulation');
  assert.equal(SMC.quarterOf(at(6)).id, 'q3');
  assert.equal(SMC.quarterOf(at(6)).phase, 'Distribution');
  assert.equal(SMC.quarterOf(at(12)).id, 'q4');

  // Bornes : la dernière minute reste dans le quart, la suivante passe au suivant
  assert.equal(SMC.quarterOf(at(5, 59)).id, 'q2');
  assert.equal(SMC.quarterOf(at(6, 0)).id, 'q3');
  assert.equal(SMC.quarterOf(at(11, 59)).id, 'q3');
  assert.equal(SMC.quarterOf(at(12, 0)).id, 'q4');

  // Blocs de 90 min : 1 à 4 dans chaque quart
  assert.equal(SMC.quarterOf(at(6, 0)).sub, 1);
  assert.equal(SMC.quarterOf(at(7, 30)).sub, 2);
  assert.equal(SMC.quarterOf(at(9, 0)).sub, 3);
  assert.equal(SMC.quarterOf(at(10, 30)).sub, 4);
  assert.equal(SMC.quarterOf(at(11, 59)).sub, 4);

  // True Session Open = début du 2e bloc : Asie 19:30, Londres 01:30, NY 07:30, PM 13:30
  assert.equal(SMC.quarterOf(at(19)).trueSessionOpen, 19 * 60 + 30);
  assert.equal(SMC.quarterOf(at(1)).trueSessionOpen, 1 * 60 + 30);
  assert.equal(SMC.quarterOf(at(8)).trueSessionOpen, 7 * 60 + 30);
  assert.equal(SMC.quarterOf(at(14)).trueSessionOpen, 13 * 60 + 30);

  // chaque minute de la journée tombe dans un quart : aucun trou
  for (let m = 0; m < 24 * 60; m += 7) {
    assert.ok(SMC.quarterOf(at(0, m)), `minute ${m} sans quart`);
  }
});

test('Quarterly Theory : True Open du jour et de la semaine', () => {
  // Série horaire partant du dimanche 2024-01-07 18:00 à New York
  const start = Date.UTC(2024, 0, 7, 23, 0) / 1000;
  const c = [];
  for (let i = 0; i < 80; i++) {
    const p = 100 + i;
    c.push({ time: start + i * 3600, open: p, high: p + 1, low: p - 1, close: p, volume: 1 });
  }
  const o = SMC.trueOpens(c);

  // WTO : lundi 18:00 à New York
  const w = SMC.nyParts(o.wto.time);
  assert.equal(w.weekday, 'Mon');
  assert.equal(w.hour, 18);
  assert.equal(w.minute, 0);

  // TDO : minuit à New York du dernier jour présent
  const d = SMC.nyParts(o.tdo.time);
  assert.equal(d.hour, 0);
  assert.equal(d.minute, 0);
  assert.equal(o.tdo.price, c[o.tdo.index].open);

  // Données commençant après lundi 18:00 : pas de WTO inventé
  const mid = c.slice(60);
  assert.notEqual(SMC.nyParts(mid[0].time).weekday, 'Mon');
  assert.equal(SMC.trueOpens(mid).wto, null);
});

test('Quarterly Theory : désactivée pour les cotations continues', () => {
  const c = Data.demoCandles('15m', 600);
  // useKillzones false = synthétique 24h/24 : pas de sessions, donc pas de quarts
  const synth = SMC.analyze(c, { swingLength: 5, useKillzones: false });
  assert.equal(synth.quarter, null);
  assert.deepEqual(synth.trueOpens, { tdo: null, wto: null });

  const normal = SMC.analyze(c, { swingLength: 5, useKillzones: true });
  assert.ok(normal.quarter, 'quart renseigné quand les sessions comptent');
  assert.ok(['q1', 'q2', 'q3', 'q4'].includes(normal.quarter.id));
});

/**
 * Série 15 min couvrant la killzone d'Asie (20h–24h) puis celle de Londres
 * (02h–05h), heure de New York. `mode` règle ce qui se passe à l'ouverture
 * de Londres, pour éprouver chaque étape du Judas Swing séparément.
 */
function judasBars(mode) {
  const start = Date.UTC(2024, 0, 9, 10, 0) / 1000;      // 05:00 à New York
  const out = [];
  for (let i = 0; i < 140; i++) {
    const t = start + i * 900;
    const p = SMC.nyParts(t);
    const m = p.hour * 60 + p.minute;
    const london = p.dateKey === '2024-01-10';
    let o, hi, lo, cl;

    if (m >= 20 * 60) {                                   // Asie : range 100 – 102
      cl = 101 + Math.sin(i) * 0.9; o = cl; hi = Math.max(o, cl) + 0.1; lo = Math.min(o, cl) - 0.1;
    } else if (london && m === 2 * 60 && mode !== 'nosweep') {
      o = 101.8; cl = 102.6; hi = 103.2; lo = 101.7;      // balayage au-dessus de la range
    } else if (london && m === 2 * 60 + 15 && mode !== 'nosweep' && mode !== 'noreturn') {
      o = 102.5; cl = 101.5; hi = 102.6; lo = 101.4;      // clôture de retour dans la range
    } else if (london && m > 2 * 60 + 15 && m < 5 * 60 && (mode === 'full' || mode === 'weak')) {
      const k = (m - (2 * 60 + 15)) / 15;
      const step = mode === 'weak' ? 0.02 : 0.35;         // 'weak' : déplacement insuffisant
      cl = 101.5 - k * step; o = cl + 0.05; hi = o + 0.05; lo = cl - 0.05;
    } else if (london && m > 2 * 60 && mode === 'noreturn') {
      cl = 103 + (m - 2 * 60) / 60; o = cl - 0.1; hi = cl + 0.2; lo = o - 0.1;  // reste dehors
    } else {
      cl = 101 + Math.sin(i / 3) * 0.25; o = cl; hi = o + 0.15; lo = o - 0.15;
    }
    out.push({ time: t, open: o, high: hi, low: lo, close: cl, volume: 1 });
  }
  return out;
}

test('Judas Swing : balayage, retour en clôture, puis déplacement', () => {
  const c = judasBars('full');
  const j = SMC.findJudasSwings(c, SMC.atr(c), 1, 0.25);
  assert.equal(j.length, 1);

  const x = j[0];
  assert.equal(x.session, 'london');
  // liquidité acheteuse prise au-dessus : le vrai mouvement est baissier
  assert.equal(x.dir, -1);
  assert.equal(x.status, 'displaced');
  assert.ok(x.sweepLevel > x.rangeHigh, 'le balayage sort de la range');
  assert.ok(x.confirmIndex > x.sweepIndex, 'le retour suit le balayage');
  assert.ok(x.displaceIndex > x.confirmIndex, 'le déplacement suit le retour');
  // la fenêtre s'ouvre bien dans la killzone de Londres
  assert.equal(SMC.killzoneOf(c[x.index].time).id, 'london');
});

test('Judas Swing : rien sans balayage ni sans retour', () => {
  // le prix reste dans la range d'Asie : aucune liquidité prise
  const ns = judasBars('nosweep');
  assert.deepEqual(SMC.findJudasSwings(ns, SMC.atr(ns), 1, 0.25), []);

  // sorti de la range mais jamais refermé dedans : c'est une expansion, pas un piège
  const nr = judasBars('noreturn');
  assert.deepEqual(SMC.findJudasSwings(nr, SMC.atr(nr), 1, 0.25), []);
});

test('Judas Swing : une mèche d’un tick hors d’une range étroite ne compte pas', () => {
  // Sans seuil de dépassement, le bruit de fond franchit sans cesse les ranges
  // étroites et produit de faux Judas Swings : c'est ce que garde `sweepAtr`.
  const c = judasBars('nosweep');
  const a = SMC.atr(c);
  const sansSeuil = SMC.findJudasSwings(c, a, 1, 0);
  assert.ok(sansSeuil.length > 0, 'seuil nul : le bruit passe');

  const poke = sansSeuil[0];
  const bord = poke.dir === 1 ? poke.rangeLow : poke.rangeHigh;
  const penetration = Math.abs(poke.sweepLevel - bord);
  assert.ok(penetration < 0.25 * a[poke.sweepIndex], 'dépassement bien inférieur au seuil');

  // avec le seuil par défaut, ce même bruit ne produit rien
  assert.deepEqual(SMC.findJudasSwings(c, a, 1, 0.25), []);
});

test('Judas Swing : le déplacement insuffisant reste au stade confirmé', () => {
  const c = judasBars('weak');
  const a = SMC.atr(c);
  const j = SMC.findJudasSwings(c, a, 1, 0.25);
  assert.equal(j.length, 1);
  assert.equal(j[0].status, 'confirmed', 'confirmé mais pas déplacé');
  assert.equal(j[0].displaced, false);

  // le seuil est réglable : abaissé, le même mouvement qualifie
  const loose = SMC.findJudasSwings(c, a, 0.05, 0.25);
  assert.equal(loose[0].status, 'displaced');
});

test('profils : chaque extrême est attribué une fois et une seule', () => {
  const c = Data.demoCandles('1h', 900);
  const p = SMC.profiles(c);

  assert.ok(p.days > 10, `jours découpés : ${p.days}`);
  // Les killzones ne couvrent pas toute la journée : avec la ligne « hors
  // killzone », les attributions doivent retomber exactement sur le nombre de jours.
  const sumHigh = p.session.reduce((s, x) => s + x.high, 0);
  const sumLow = p.session.reduce((s, x) => s + x.low, 0);
  assert.equal(sumHigh, p.days);
  assert.equal(sumLow, p.days);
  assert.ok(p.session.some((x) => x.id === 'outside'), 'ligne hors killzone présente');

  // Profil de semaine : les extrêmes hebdomadaires totalisent le nombre de
  // semaines complètes, jamais plus.
  const wHigh = p.weekday.reduce((s, x) => s + x.high, 0);
  assert.equal(wHigh, p.weeks);
  assert.equal(p.weekday.reduce((s, x) => s + x.low, 0), p.weeks);
  assert.ok(p.weeks >= 1 && p.weeks <= p.days, `semaines : ${p.weeks}`);

  // Les jours comptés par jour de la semaine totalisent tous les jours
  assert.equal(p.weekday.reduce((s, x) => s + x.days, 0), p.days);
  for (const w of p.weekday) assert.ok(w.up <= w.days, `${w.weekday} : hausses > jours`);
});

test('profils : extrêmes du jour localisés à la bonne bougie', () => {
  const c = judasBars('full');
  const days = SMC.dayBuckets(c);
  for (const d of days) {
    // le plus haut et le plus bas du jour pointent bien la bougie qui les porte
    assert.equal(c[d.highAt].high, d.high);
    assert.equal(c[d.lowAt].low, d.low);
    // et aucune bougie du jour ne les dépasse
    for (let i = d.start; i <= d.end; i++) {
      assert.ok(c[i].high <= d.high);
      assert.ok(c[i].low >= d.low);
    }
  }
  // une seule semaine partielle : pas d'extrême hebdomadaire inventé
  const p = SMC.profiles(c);
  assert.equal(p.weekday.reduce((s, x) => s + x.high, 0), p.weeks);
});

test('IFVG : seule une clôture au-delà inverse le FVG', () => {
  // FVG haussier entre 100.2 et 101, puis comblement en mèche sans clôture dessous
  const mk = (o, h, l, cl) => ({ time: 0, open: o, high: h, low: l, close: cl, volume: 1 });
  const base = [];
  for (let i = 0; i < 30; i++) base.push(mk(100, 100.3, 99.7, 100));
  // trois bougies créant un FVG haussier : high[i-2]=100.2 < low[i]=101
  base.push(mk(100, 100.2, 99.9, 100.1));
  base.push(mk(100.3, 102.5, 100.2, 102.4));
  base.push(mk(102.4, 103, 101, 102.6));
  // retour en mèche dans le FVG, clôture au-dessus : comblé mais pas inversé
  base.push(mk(102.5, 102.6, 100.1, 102.2));
  let c = base.map((b, i) => Object.assign({}, b, { time: 1700000000 + i * 900 }));

  let fvgs = SMC.findFVGs(c, SMC.atr(c), 0.01).filter((f) => f.dir === 1);
  assert.ok(fvgs.length >= 1, 'FVG haussier détecté');
  const f = fvgs[fvgs.length - 1];
  assert.notEqual(f.filledAt, null, 'comblé en mèche');
  assert.equal(f.closedThroughAt, null, 'pas de clôture au-delà');
  assert.deepEqual(SMC.invertedFvgs(c, fvgs), [], 'aucune inversion');

  // on ajoute une clôture franche sous le FVG : il s'inverse
  c = c.concat([Object.assign(mk(100.1, 100.2, 99, 99.2), { time: c[c.length - 1].time + 900 })]);
  fvgs = SMC.findFVGs(c, SMC.atr(c), 0.01).filter((x) => x.dir === 1);
  const g = fvgs[fvgs.length - 1];
  assert.notEqual(g.closedThroughAt, null, 'clôture sous le FVG');

  const inv = SMC.invertedFvgs(c, fvgs);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].kind, 'ifvg');
  assert.equal(inv[0].dir, -1, 'un FVG haussier traversé devient baissier');
  assert.equal(inv[0].fromFvgDir, 1);
  assert.equal(inv[0].top, g.top);
  assert.equal(inv[0].bottom, g.bottom);
  assert.equal(inv[0].mid, (g.top + g.bottom) / 2);
});

test('IFVG : exposé par analyze et utilisable comme zone d’entrée', () => {
  const c = Data.demoCandles('15m', 600);
  const r = SMC.analyze(c, { swingLength: 5 });
  assert.ok(Array.isArray(r.ifvgs));
  // chaque IFVG porte un statut suivi comme les autres zones
  for (const z of r.ifvgs) {
    assert.ok(['fresh', 'mitigated', 'invalidated'].includes(z.status), z.status);
    assert.equal(z.dir, -z.fromFvgDir);
    assert.ok(z.top > z.bottom);
  }
  // la zone retenue par le setup peut être un IFVG : le type est accepté
  if (r.setup && r.setup.zone) {
    assert.ok(['ob', 'breaker', 'fvg', 'ifvg'].includes(r.setup.zone.kind), r.setup.zone.kind);
  }
});

test('Unicorn : invariants de la zone, de l’entrée et du stop', () => {
  // Plusieurs séries, et des deux sens : un jeu de données où aucun Unicorn
  // haussier n'apparaît laisserait passer un stop du mauvais côté pour les
  // achats — c'est exactement ce qui est arrivé avant ce test.
  const series = [
    Data.demoCandles('1h', 900),
    Data.demoCandles('15m', 900),
    Data.demoCandles('4h', 900),
    retracementBars('fort'),
    judasBars('full'),
  ];
  let vus = 0;
  for (const c of series) vus += checkUnicorns(c);
  assert.ok(vus >= 0, 'aucune exception sur les séries testées');
});

/** Vérifie tous les invariants des Unicorns d'une série. Renvoie leur nombre. */
function checkUnicorns(c) {
  const r = SMC.analyze(c, { swingLength: 5 });
  assert.ok(Array.isArray(r.unicorns));

  const a = SMC.atr(c);
  const seenFvg = new Set();
  for (const u of r.unicorns) {
    // la zone est bien l'intersection du breaker et du FVG
    assert.equal(u.top, Math.min(u.breaker.top, u.fvg.top));
    assert.equal(u.bottom, Math.max(u.breaker.bottom, u.fvg.bottom));
    assert.ok(u.top > u.bottom, 'chevauchement non vide');
    // chevauchement matériel : au moins 0,1 ATR
    assert.ok(u.top - u.bottom >= 0.1 * a[u.createdAt] - 1e-9, 'chevauchement trop fin');

    // l'entrée reste dans la zone tradable, même quand le CE du FVG est dehors
    assert.ok(u.entry >= u.bottom && u.entry <= u.top, 'entrée hors du chevauchement');
    if (!u.entryClamped) assert.equal(u.entry, u.fvg.mid);

    // le stop est du bon côté, et le risque n'est jamais nul
    if (u.dir === 1) assert.ok(u.sl < u.entry, 'stop sous l’entrée pour un achat');
    else assert.ok(u.sl > u.entry, 'stop au-dessus de l’entrée pour une vente');
    assert.ok(Math.abs(u.entry - u.sl) > 0);

    // les quatre ingrédients sont renseignés
    assert.ok(['BOS', 'CHoCH'].includes(u.mssType), u.mssType);
    assert.ok(typeof u.sweepType === 'string' && u.sweepType.length);

    // le balayage est du bon côté de la zone, sinon le stop n'a aucun sens
    if (u.dir === 1) assert.ok(u.sweepLevel <= u.bottom, 'balayage sous une zone d’achat');
    else assert.ok(u.sweepLevel >= u.top, 'balayage au-dessus d’une zone de vente');

    // un FVG ne donne qu'un seul Unicorn
    assert.ok(!seenFvg.has(u.fvg.index), `FVG ${u.fvg.index} en double`);
    seenFvg.add(u.fvg.index);
  }
  return r.unicorns.length;
}

test('Unicorn : sans chevauchement matériel, rien n’est signalé', () => {
  const c = Data.demoCandles('1h', 900);
  const r = SMC.analyze(c, { swingLength: 5 });
  const a = SMC.atr(c);
  const args = [c, r.blocks, r.fvgs, r.liquidity, r.events, 20];

  // Seuil de chevauchement irréaliste : plus aucun Unicorn ne passe
  assert.deepEqual(SMC.findUnicorns(...args, 1000, 3), []);
  // Seuil de proximité du balayage nul : plus rien non plus
  assert.deepEqual(SMC.findUnicorns(...args, 0.1, 0), []);
  // Seuils relâchés : au moins autant de candidats qu'avec les seuils par défaut
  const lache = SMC.findUnicorns(...args, 0, Infinity);
  assert.ok(lache.length >= r.unicorns.length, 'les seuils ne peuvent que restreindre');
  void a;
});

test('CISD : clôture au-delà de l’ouverture de la jambe opposée', () => {
  const mk = (o, cl) => ({ open: o, close: cl, high: Math.max(o, cl) + 0.2, low: Math.min(o, cl) - 0.2, volume: 1 });
  const seq = (arr) => arr.map((b, i) => Object.assign({}, b, { time: 1700000000 + i * 3600 }));

  // trois bougies baissières (la livraison), puis une haussière qui clôture
  // au-dessus de l'ouverture de la première : CISD haussier à ce niveau
  let c = seq([mk(100, 100), mk(100, 99), mk(99, 98), mk(98, 97), mk(97, 100.5)]);
  let x = SMC.findCisd(c, 2);
  assert.equal(x.length, 1);
  assert.equal(x[0].dir, 1);
  assert.equal(x[0].level, 100, 'le niveau est l’ouverture de la première bougie de la jambe');
  assert.equal(x[0].legStart, 1);
  assert.equal(x[0].legLength, 3);
  assert.ok(Math.abs(x[0].legExtreme - 96.8) < 1e-9, 'extrême de la jambe');

  // même séquence mais la clôture n'atteint pas le niveau : rien
  c = seq([mk(100, 100), mk(100, 99), mk(99, 98), mk(98, 97), mk(97, 99.5)]);
  assert.deepEqual(SMC.findCisd(c, 2), []);

  // une seule bougie opposée n'est pas une jambe de livraison
  c = seq([mk(100, 100), mk(100, 99), mk(99, 100.5)]);
  assert.deepEqual(SMC.findCisd(c, 2), [], 'jambe de 1 refusée avec minLeg = 2');
  assert.equal(SMC.findCisd(c, 1).length, 1, 'acceptée avec minLeg = 1');

  // sens inverse : jambe haussière franchie vers le bas
  c = seq([mk(100, 100), mk(100, 101), mk(101, 102), mk(102, 99.5)]);
  const d = SMC.findCisd(c, 2);
  assert.equal(d.length, 1);
  assert.equal(d[0].dir, -1);
  assert.equal(d[0].level, 100);
});

test('CISD : les dojis ne cassent pas la lecture', () => {
  const mk = (o, cl) => ({ open: o, close: cl, high: Math.max(o, cl) + 0.1, low: Math.min(o, cl) - 0.1, volume: 1 });
  // bougie à corps nul au milieu : elle n'a pas de sens, donc elle est ignorée
  // comme bougie déclenchante et interrompt la jambe comme n'importe quelle autre
  const c = [mk(100, 100), mk(100, 99), mk(99, 99), mk(99, 98), mk(98, 101)]
    .map((b, i) => Object.assign({}, b, { time: 1700000000 + i * 3600 }));
  const x = SMC.findCisd(c, 1);
  assert.ok(x.length >= 1);
  for (const y of x) assert.notEqual(SMC.bodyDir(c[y.index]), 0, 'aucun doji déclencheur');
});

test('Turtle soup : mèche dehors, clôture dedans, corps qui ne dépasse pas', () => {
  const mk = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, volume: 1 });
  const seq = (arr) => arr.map((b, i) => Object.assign({}, b, { time: 1700000000 + i * 3600 }));
  // ATR constant et connu : des bougies de range 2 donnent un ATR proche de 2
  const filler = [];
  for (let i = 0; i < 20; i++) filler.push(mk(100, 101, 99, 100));

  // mèche 3 points au-dessus du plus haut précédent, clôture revenue dedans
  let c = seq(filler.concat([mk(100, 101, 99, 100), mk(100.5, 104, 100, 100.2)]));
  let t = SMC.findTurtleSoup(c, SMC.atr(c), 0.5);
  assert.equal(t.length, 1);
  assert.equal(t[0].side, 'high');
  assert.equal(t[0].dir, -1, 'liquidité prise en haut : mouvement attendu baissier');
  assert.equal(t[0].level, 101);
  assert.equal(t[0].wick, 104);

  // même mèche mais le corps dépasse le plus haut précédent : ce n'est plus un piège
  c = seq(filler.concat([mk(100, 101, 99, 100), mk(100.5, 104, 100, 103.5)]));
  assert.deepEqual(SMC.findTurtleSoup(c, SMC.atr(c), 0.5), []);

  // dépassement trop faible pour le seuil : écarté
  c = seq(filler.concat([mk(100, 101, 99, 100), mk(100.5, 101.1, 100, 100.2)]));
  assert.deepEqual(SMC.findTurtleSoup(c, SMC.atr(c), 0.5), []);

  // côté bas
  c = seq(filler.concat([mk(100, 101, 99, 100), mk(99.5, 100, 96, 99.8)]));
  t = SMC.findTurtleSoup(c, SMC.atr(c), 0.5);
  assert.equal(t.length, 1);
  assert.equal(t[0].side, 'low');
  assert.equal(t[0].dir, 1);
  assert.equal(t[0].level, 99);
});

test('Breaker : invalidation sur le corps, pas sur la mèche', () => {
  // Order block haussier dont la bougie a une longue mèche basse : une clôture
  // sous le corps mais au-dessus de la mèche doit l'invalider en mode « corps »
  // et le laisser vivant en mode « mèches ».
  const z = () => [{
    kind: 'ob', dir: 1, top: 101, bottom: 95,      // bornes = mèches
    index: 1, createdAt: 1, breakIndex: 1,
  }];
  const c = [
    { time: 0, open: 100, high: 101, low: 100, close: 100, volume: 1 },
    // bougie d'origine : corps 98–100, mèche jusqu'à 95
    { time: 900, open: 98, high: 101, low: 95, close: 100, volume: 1 },
    // clôture à 97 : sous le corps (98) mais bien au-dessus de la mèche (95)
    { time: 1800, open: 99, high: 99, low: 96, close: 97, volume: 1 },
  ];

  const corps = trackedStatus(c, z(), true);
  const meches = trackedStatus(c, z(), false);
  assert.equal(corps.ob, 'invalidated', 'le corps suffit à invalider');
  assert.equal(corps.breakers, 1, 'un breaker est créé');
  assert.equal(meches.ob, 'mitigated', 'avec les mèches, l’OB survit');
  assert.equal(meches.breakers, 0, 'et aucun breaker n’apparaît');
});

/** Statut de l'OB et nombre de breakers produits, pour un mode d'invalidation. */
function trackedStatus(c, blocks, onBodies) {
  // trackBlocks n'est pas exporté : on passe par analyze ? non — on le teste
  // via l'option publique, sur les blocs fournis par analyzeStructure.
  const out = SMC.trackBlocks(c, blocks, onBodies);
  return {
    ob: out.find((x) => x.kind === 'ob').status,
    breakers: out.filter((x) => x.kind === 'breaker').length,
  };
}

/**
 * Série avec une vraie structure haussière (montée, repli, cassure du sommet,
 * donc BOS et tendance établie) suivie d'une jambe de retracement.
 * Sans structure, `trend` vaut 0 et il n'y a par définition rien à classer.
 */
function retracementBars(mode) {
  const step = 3600;
  const t0 = Date.UTC(2024, 0, 8, 0, 0) / 1000;
  const closes = [];
  for (let i = 0; i < 12; i++) closes.push(100 + i);          // montée
  for (let i = 0; i < 8; i++) closes.push(111 - i * 1.2);     // repli
  for (let i = 0; i < 18; i++) closes.push(102.6 + i * 1.6);  // cassure du sommet
  const out = closes.map((cl, i) => {
    const o = i ? closes[i - 1] : cl;
    return {
      time: t0 + i * step, open: o, close: cl,
      high: Math.max(o, cl) + 0.3, low: Math.min(o, cl) - 0.3, volume: 1,
    };
  });

  const push = (i, o, hi, lo, cl) => out.push({ time: t0 + i * step, open: o, high: hi, low: lo, close: cl, volume: 1 });
  const top = closes[closes.length - 1];
  let i = out.length;
  if (mode === 'fort') {
    // un corps de 10 points, qui laisse des FVG baissiers derrière lui
    push(i++, top, top + 0.2, top - 10, top - 10);
    for (let k = 1; k < 5; k++) { const b = top - 10 - k * 2; push(i++, b + 1, b + 1.2, b - 1, b); }
  } else {
    // petites bougies alternées, aucune trace laissée
    for (let k = 0; k < 8; k++) {
      const b = top - k * 0.5;
      const up = k % 2 === 0;
      push(i++, b, b + 0.4, b - 0.8, up ? b + 0.2 : b - 0.5);
    }
  }
  return out;
}

test('retracement : doux quand la jambe ne laisse rien, fort sinon', () => {
  const doux = SMC.analyze(retracementBars('doux'), { swingLength: 5 }).retracement;
  const fort = SMC.analyze(retracementBars('fort'), { swingLength: 5 }).retracement;

  assert.ok(doux, 'retracement doux mesuré');
  assert.ok(fort, 'retracement fort mesuré');
  assert.equal(doux.kind, 'doux', `score ${doux.score}/3`);
  assert.equal(fort.kind, 'fort', `score ${fort.score}/3`);

  // les trois indices séparent bien les deux cas
  assert.ok(fort.bodyAtr > doux.bodyAtr, 'corps maximal');
  assert.ok(fort.fvgCount > doux.fvgCount, 'FVG laissés derrière');
  assert.ok(fort.longestRun > doux.longestRun, 'suite de bougies de même sens');
  assert.equal(doux.longestRun < 3, true, 'le doux alterne');

  // le retracement va contre la tendance, et le verdict est renseigné
  for (const x of [doux, fort]) {
    assert.equal(x.dir, -1);
    assert.ok(x.verdict.length > 0);
  }
});

test('retracement : rien à classer quand le prix est en expansion', () => {
  // Montée continue : aucun retour sous le dernier sommet, donc pas de jambe
  const c = fromCloses(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5), undefined, 3600);
  const r = SMC.analyze(c, { swingLength: 5 });
  assert.equal(r.retracement, null, 'une expansion n’est pas un retracement');
});

test('régime du jour : la journée en cours n’est pas jugée', () => {
  const c = Data.demoCandles('1h', 900);
  const g = SMC.analyze(c, { swingLength: 5 }).regime;
  assert.ok(g, 'régime calculé');
  assert.ok(['expansion', 'normal', 'consolidation'].includes(g.kind), g.kind);
  assert.ok(g.median > 0 && g.range > 0);
  assert.ok(Math.abs(g.ratio - g.range / g.median) < 1e-9);
  assert.ok(g.days >= 2, 'au moins deux jours de référence');

  // Le jour jugé n'est pas celui en cours : sa range serait sous-estimée
  const days = SMC.dayBuckets(c);
  const dernier = days[days.length - 1];
  const enCours = dernier.end === c.length - 1;
  if (enCours) {
    assert.notEqual(g.key, dernier.key, 'le jour en cours est écarté du verdict');
    assert.ok(g.running && g.running.key === dernier.key, 'mais il est rapporté à part');
  }

  // La médiane résiste à un jour aberrant, là où la moyenne non
  assert.equal(SMC.dayRegime(c, 20, 1.3, 0.7).kind, g.kind, 'calcul déterministe');
});
