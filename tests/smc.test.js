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
