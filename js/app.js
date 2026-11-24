/* Interface : chargement des données, graphique, dessin des concepts SMC/ICT. */
(function () {
  'use strict';

  const { SMC, SMCData: Data, LightweightCharts: LWC } = window;
  const $ = (id) => document.getElementById(id);

  const COLORS = {
    bull: '#26a69a', bear: '#ef5350', text: '#d6dde6', muted: '#8b96a5',
    bullZone: 'rgba(38,166,154,', bearZone: 'rgba(239,83,80,',
    fvgBull: 'rgba(79,140,255,', fvgBear: 'rgba(255,152,0,',
    liq: '#ffd54f', eq: '#9aa4b2', ote: 'rgba(255,183,77,',
  };

  // ---------------------------------------------------------------------------
  // Préférences (stockage local, facultatif)
  // ---------------------------------------------------------------------------
  const PREF_KEY = 'smc-ict-prefs';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        source: $('source').value, symbols: state.symbols, tf: $('tf').value, appId: $('appId').value,
        swingLen: $('swingLen').value, layers: [...state.layers],
      }));
    } catch (e) { /* stockage indisponible : on ignore */ }
  }

  const state = {
    candles: [],
    displayTimes: [],
    result: null,
    htfTrend: null,
    label: '',
    tf: '15m',
    csvRaw: null,
    lastHtf: null,
    symbols: { deriv: 'R_75', binance: 'BTCUSDT' },
    stream: null,
    streamKey: '',
    streamTimer: null,
    layers: new Set(),
    priceLines: [],
    version: 0,
    lastSig: '',
    timer: null,
    loading: false,
  };

  // ---------------------------------------------------------------------------
  // Graphique
  // ---------------------------------------------------------------------------
  const chartEl = $('chart');
  const chart = LWC.createChart(chartEl, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0d1117' }, textColor: COLORS.text, attributionLogo: true },
    grid: { vertLines: { color: 'rgba(43,51,64,.45)' }, horzLines: { color: 'rgba(43,51,64,.45)' } },
    rightPriceScale: { borderColor: '#2b3340' },
    timeScale: { borderColor: '#2b3340', timeVisible: true, secondsVisible: false, rightOffset: 12 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
  });
  const series = chart.addCandlestickSeries({
    upColor: COLORS.bull, downColor: COLORS.bear, borderVisible: false,
    wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
  });

  const canvas = $('overlay');
  const g = canvas.getContext('2d');

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  function decimals(p) {
    const a = Math.abs(p);
    return a >= 1000 ? 2 : a >= 10 ? 3 : a >= 0.01 ? 5 : 8;
  }
  let priceDigits = 2;
  const fmt = (p) => (p === null || p === undefined || !Number.isFinite(p) ? '—' : p.toFixed(priceDigits));
  const dirWord = (d) => (d === 1 ? 'Haussier' : d === -1 ? 'Baissier' : 'Neutre');
  const dirClass = (d) => (d === 1 ? 'bull' : d === -1 ? 'bear' : 'neutral');
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 4500);
  }

  function setStatus(text) { $('status').textContent = text; }

  // ---------------------------------------------------------------------------
  // Chargement des données
  // ---------------------------------------------------------------------------
  async function loadCandles() {
    const source = $('source').value;
    const tf = $('tf').value;
    const symbol = normalizeSymbol($('symbol').value, source);

    if (source === 'deriv') {
      const htfTf = Data.HTF[tf];
      const res = await Data.fetchDeriv(symbol, tf, 1000, $('appId').value, htfTf);
      if (!res.candles.length) throw new Error(`Deriv : aucune donnée pour ${symbol}`);
      return { candles: res.candles, tf, label: symbol, htf: res.htf, synthetic: Data.isDerivSynthetic(symbol) };
    }

    if (source === 'binance') {
      const candles = await Data.fetchBinance(symbol, tf, 1000);
      let htf = null;
      const htfTf = Data.HTF[tf];
      if (htfTf && htfTf !== tf) {
        try {
          const hc = await Data.fetchBinance(symbol, htfTf, 500);
          htf = { tf: htfTf, candles: hc };
        } catch (e) { /* le biais HTF est facultatif */ }
      }
      return { candles, tf, label: symbol, htf };
    }

    if (source === 'csv') {
      if (!state.csvRaw) throw new Error('Choisis un fichier CSV (colonnes : time, open, high, low, close, volume).');
      const raw = state.csvRaw.candles;
      const rawSec = Data.TF_SECONDS[state.csvRaw.tf];
      let candles = raw;
      let usedTf = state.csvRaw.tf;
      if (Data.TF_SECONDS[tf] > rawSec) { candles = SMC.resample(raw, Data.TF_SECONDS[tf]); usedTf = tf; }
      return { candles, tf: usedTf, label: state.csvRaw.name, htf: resampledHtf(candles, usedTf) };
    }

    const candles = Data.demoCandles(tf, 1000);
    return { candles, tf, label: 'DÉMO', htf: resampledHtf(candles, tf) };
  }

  function resampledHtf(candles, tf) {
    const htfTf = Data.HTF[tf];
    if (!htfTf || htfTf === tf) return null;
    const hc = SMC.resample(candles, Data.TF_SECONDS[htfTf]);
    return hc.length >= 30 ? { tf: htfTf, candles: hc } : null;
  }

  async function run() {
    if (state.loading) return;
    state.loading = true;
    setStatus('Chargement…');
    try {
      const data = await loadCandles();
      applyData(data);
      syncStream();
    } catch (e) {
      console.error(e);
      const src = $('source').value;
      if ((src === 'binance' || src === 'deriv') && !state.candles.length) {
        toast(`${src === 'deriv' ? 'Deriv' : 'Binance'} injoignable (${e.message}). Passage en données de démo.`, true);
        $('source').value = 'demo';
        updateSourceFields();
        state.loading = false;
        return run();
      }
      toast(e.message, true);
      setStatus('Erreur : ' + e.message);
    } finally {
      state.loading = false;
    }
  }

  function applyData({ candles, tf, label, htf, synthetic }) {
    const swingLength = Math.max(2, Math.min(20, parseInt($('swingLen').value, 10) || 5));
    state.lastHtf = htf || null;
    state.synthetic = !!synthetic;
    let htfTrend = null;
    if (htf) {
      const hr = SMC.analyze(htf.candles, { swingLength: Math.max(3, swingLength - 1) });
      if (hr.ok) htfTrend = { tf: htf.tf, trend: hr.trend, pd: hr.pd };
    }
    const result = SMC.analyze(candles, {
      swingLength, htfBias: htfTrend ? htfTrend.trend : null, useKillzones: !synthetic,
    });
    if (!result.ok) throw new Error(result.error);

    const prev = state.result;
    const sameSeries = state.label === label && state.tf === tf;
    notifyChanges(prev, result, candles, sameSeries);

    state.candles = candles;
    state.result = result;
    state.htfTrend = htfTrend;
    state.label = label;
    state.tf = tf;
    state.version++;

    // Heure de New York (référence ICT), avec temps strictement croissants
    const times = new Array(candles.length);
    let last = -Infinity;
    for (let i = 0; i < candles.length; i++) {
      let t = candles[i].time + SMC.nyOffsetSeconds(candles[i].time);
      if (t <= last) t = last + 1;
      times[i] = t;
      last = t;
    }
    state.displayTimes = times;

    priceDigits = decimals(candles[candles.length - 1].close);
    series.applyOptions({ priceFormat: { type: 'price', precision: priceDigits, minMove: Math.pow(10, -priceDigits) } });
    series.setData(candles.map((b, i) => ({ time: times[i], open: b.open, high: b.high, low: b.low, close: b.close })));
    if (!sameSeries) chart.timeScale().setVisibleLogicalRange({ from: candles.length - 180, to: candles.length + 12 });

    renderSeriesDecorations();
    renderPanel();
    const now = new Date().toLocaleTimeString('fr-FR');
    const live = state.stream ? ' · ● temps réel' : '';
    setStatus(`${label} · ${tf} · ${candles.length} bougies · heure de New York · mis à jour ${now}${live}`);
  }

  function notifyChanges(prev, cur, candles, sameSeries) {
    if (!prev || !prev.ok || !sameSeries) return;
    const pe = prev.events[prev.events.length - 1];
    const ce = cur.events[cur.events.length - 1];
    if (ce && (!pe || ce.type !== pe.type || ce.price !== pe.price || ce.dir !== pe.dir)) {
      toast(`Nouveau ${ce.type} ${ce.dir === 1 ? 'haussier' : 'baissier'} à ${fmt(ce.price)}`);
    }
    const s = cur.setup;
    if (s && s.zone && s.inZone && !(prev.setup && prev.setup.inZone)) {
      toast(`Le prix entre dans la zone ${zoneName(s.zone)} (${fmt(s.zone.bottom)} – ${fmt(s.zone.top)})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Marqueurs et lignes de prix (gérés par la librairie)
  // ---------------------------------------------------------------------------
  function renderSeriesDecorations() {
    const r = state.result;
    const T = state.displayTimes;
    for (const pl of state.priceLines) series.removePriceLine(pl);
    state.priceLines = [];
    if (!r) { series.setMarkers([]); return; }

    const markers = [];
    if (state.layers.has('swings')) {
      const hs = r.swings.highs.filter((s) => s.confirmedAt < T.length).slice(-30);
      const ls = r.swings.lows.filter((s) => s.confirmedAt < T.length).slice(-30);
      for (const s of hs) markers.push({ time: T[s.index], position: 'aboveBar', color: COLORS.muted, shape: 'circle', size: 0.1, text: s.label });
      for (const s of ls) markers.push({ time: T[s.index], position: 'belowBar', color: COLORS.muted, shape: 'circle', size: 0.1, text: s.label });
    }
    if (state.layers.has('liquidity')) {
      for (const s of r.liquidity.sweeps.slice(-8)) {
        markers.push({
          time: T[s.sweptAt], position: s.side === 'high' ? 'aboveBar' : 'belowBar',
          color: COLORS.liq, shape: s.side === 'high' ? 'arrowDown' : 'arrowUp', text: '$',
        });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    series.setMarkers(markers);

    const line = (price, color, title, style = LWC.LineStyle.Dashed, width = 1) => {
      state.priceLines.push(series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    };
    const intraday = Data.TF_SECONDS[state.tf] < 86400;
    if (state.layers.has('levels') && intraday) {
      if (r.levels.pdh) line(r.levels.pdh.price, '#b39ddb', 'PDH', LWC.LineStyle.Dotted);
      if (r.levels.pdl) line(r.levels.pdl.price, '#b39ddb', 'PDL', LWC.LineStyle.Dotted);
      if (r.levels.midnightOpen) line(r.levels.midnightOpen.price, '#90a4ae', 'Midnight Open', LWC.LineStyle.SparseDotted);
    }
    const s = r.setup;
    if (s && s.zone) {
      line(s.entry, '#4f8cff', 'Entrée', LWC.LineStyle.Solid, 1);
      line(s.sl, COLORS.bear, 'SL', LWC.LineStyle.Solid, 1);
      if (s.target) line(s.target.price, COLORS.bull, 'TP ' + s.target.label, LWC.LineStyle.Solid, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Dessin des zones sur le canvas superposé
  // ---------------------------------------------------------------------------
  function zoneName(z) {
    if (z.kind === 'fvg') return (z.dir === 1 ? 'FVG haussier' : 'FVG baissier');
    if (z.kind === 'breaker') return (z.dir === 1 ? 'Breaker haussier' : 'Breaker baissier');
    return (z.dir === 1 ? 'OB haussier' : 'OB baissier') + (z.hasFvg ? ' + FVG' : '');
  }

  function drawOverlay() {
    const ts = chart.timeScale();
    const w = ts.width();
    const h = Math.max(0, chartEl.clientHeight - ts.height());
    const r = state.result;
    const n = state.candles.length;
    const x = (i) => ts.logicalToCoordinate(i);
    const y = (p) => series.priceToCoordinate(p);

    const refP = n ? state.candles[n - 1].close : 1;
    const sig = [w, h, x(0), y(refP), y(refP * 1.01), state.version, [...state.layers].join()].join('|');
    if (sig === state.lastSig) return;
    state.lastSig = sig;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!r || !r.ok || !n || x(0) === null) return;

    const bw = Math.max(1, x(1) - x(0));
    const history = state.layers.has('history');
    g.save();
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';

    const label = (text, lx, ly, color, align = 'left') => {
      g.fillStyle = color;
      g.textAlign = align;
      g.fillText(text, lx, ly);
    };

    // Killzones (uniquement en intraday <= 30 min)
    if (state.layers.has('killzones') && r.useKillzones && Data.TF_SECONDS[state.tf] <= 1800) {
      const vr = ts.getVisibleLogicalRange();
      if (vr) {
        const from = Math.max(0, Math.floor(vr.from));
        const to = Math.min(n - 1, Math.ceil(vr.to));
        let band = null;
        const flush = () => {
          if (!band) return;
          const x1 = x(band.start) - bw / 2;
          const x2 = x(band.end) + bw / 2;
          g.fillStyle = band.kz.color;
          g.fillRect(x1, 0, x2 - x1, h);
          if (x2 - x1 > 48) label(band.kz.name, x1 + 4, h - 10, 'rgba(214,221,230,.45)');
          band = null;
        };
        for (let i = from; i <= to; i++) {
          const kz = SMC.killzoneOf(state.candles[i].time);
          if (band && (!kz || kz.id !== band.kz.id || i !== band.end + 1)) flush();
          if (kz) { if (!band) band = { kz, start: i, end: i }; else band.end = i; }
        }
        flush();
      }
    }

    // Premium / Discount + OTE
    if (state.layers.has('pd') && r.pd) {
      const pd = r.pd;
      const x1 = x(pd.start);
      const yH = y(pd.high);
      const yE = y(pd.eq);
      const yL = y(pd.low);
      if (x1 !== null && yH !== null && yL !== null) {
        g.fillStyle = 'rgba(239,83,80,.05)';
        g.fillRect(x1, yH, w - x1, yE - yH);
        g.fillStyle = 'rgba(38,166,154,.05)';
        g.fillRect(x1, yE, w - x1, yL - yE);
        g.setLineDash([6, 4]);
        g.strokeStyle = COLORS.eq;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x1, yE); g.lineTo(w, yE); g.stroke();
        g.setLineDash([]);
        const yo1 = y(pd.ote.from);
        const yo2 = y(pd.ote.to);
        g.fillStyle = COLORS.ote + '.10)';
        g.fillRect(x1, Math.min(yo1, yo2), w - x1, Math.abs(yo2 - yo1));
        label('Premium', w - 6, yH + 10, 'rgba(239,83,80,.7)', 'right');
        label('Équilibre 50 %', w - 6, yE - 8, COLORS.eq, 'right');
        label('Discount', w - 6, yL - 10, 'rgba(38,166,154,.8)', 'right');
        label('OTE', w - 6, (yo1 + yo2) / 2, 'rgba(255,183,77,.85)', 'right');
      }
    }

    // Zones (OB, breakers, FVG)
    const drawZone = (z, end, base, alpha, text) => {
      const x1 = x(z.index) - bw / 2;
      const x2 = end === null ? w : x(end) + bw / 2;
      const y1 = y(z.top);
      const y2 = y(z.bottom);
      if (x1 === null || y1 === null || y2 === null || x2 < 0) return;
      g.fillStyle = base + alpha + ')';
      g.fillRect(x1, y1, x2 - x1, y2 - y1);
      g.strokeStyle = base + Math.min(1, alpha * 3) + ')';
      g.lineWidth = 1;
      g.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      if (x2 - x1 > 40 && Math.abs(y2 - y1) > 9) label(text, Math.max(x1, 0) + 4, (y1 + y2) / 2, 'rgba(214,221,230,.8)');
    };

    if (state.layers.has('fvg')) {
      const list = r.fvgs.filter((f) => history || f.status !== 'filled').slice(history ? -60 : -14);
      for (const f of list) {
        drawZone(f, f.filledAt, f.dir === 1 ? COLORS.fvgBull : COLORS.fvgBear, f.status === 'filled' ? 0.06 : 0.16, 'FVG');
      }
    }
    for (const z of r.blocks) {
      const layer = z.kind === 'breaker' ? 'breaker' : 'ob';
      if (!state.layers.has(layer)) continue;
      if (!history && z.status === 'invalidated') continue;
      const base = z.dir === 1 ? COLORS.bullZone : COLORS.bearZone;
      const alpha = z.status === 'invalidated' ? 0.06 : z.status === 'mitigated' ? 0.12 : 0.22;
      const text = (z.kind === 'breaker' ? 'Breaker' : 'OB') + (z.hasFvg ? ' + FVG' : '') + (z.status === 'mitigated' ? ' (mitigé)' : '');
      drawZone(z, z.invalidatedAt, base, alpha, text);
    }

    // Liquidité : EQH / EQL + BSL/SSL les plus proches
    if (state.layers.has('liquidity')) {
      g.setLineDash([2, 3]);
      g.lineWidth = 1.2;
      const pools = r.liquidity.pools.filter((p) => history || p.sweptAt === null).slice(-20);
      for (const p of pools) {
        const x1 = x(p.from);
        const x2 = p.sweptAt === null ? w : x(p.sweptAt);
        const yy = y(p.level);
        if (x1 === null || yy === null) continue;
        g.strokeStyle = p.sweptAt === null ? COLORS.liq : 'rgba(255,213,79,.35)';
        g.beginPath(); g.moveTo(x1, yy); g.lineTo(x2, yy); g.stroke();
        label(p.type, Math.min(x2, w) - 4, yy + (p.side === 'high' ? -8 : 8), COLORS.liq, 'right');
      }
      const price = state.candles[n - 1].close;
      const open = r.liquidity.swingLiquidity.filter((l) => l.sweptAt === null);
      const bsl = open.filter((l) => l.side === 'high' && l.level > price).sort((a, b) => a.level - b.level)[0];
      const ssl = open.filter((l) => l.side === 'low' && l.level < price).sort((a, b) => b.level - a.level)[0];
      g.setLineDash([8, 4]);
      for (const l of [bsl, ssl]) {
        if (!l) continue;
        const x1 = x(l.from);
        const yy = y(l.level);
        if (x1 === null || yy === null) continue;
        g.strokeStyle = 'rgba(255,213,79,.6)';
        g.beginPath(); g.moveTo(x1, yy); g.lineTo(w, yy); g.stroke();
        label(l.type + ' (liquidité ' + (l.side === 'high' ? 'acheteuse' : 'vendeuse') + ')', x1 + 4, yy + (l.side === 'high' ? -8 : 8), COLORS.liq);
      }
      g.setLineDash([]);
    }

    // Structure : BOS / CHoCH
    if (state.layers.has('structure')) {
      const evs = r.events.slice(history ? -80 : -16);
      for (const e of evs) {
        const x1 = x(e.from);
        const x2 = x(e.to);
        const yy = y(e.price);
        if (x1 === null || x2 === null || yy === null) continue;
        const color = e.dir === 1 ? COLORS.bull : COLORS.bear;
        g.strokeStyle = color;
        g.lineWidth = e.type === 'CHoCH' ? 1.6 : 1;
        g.setLineDash(e.type === 'CHoCH' ? [] : [5, 4]);
        g.beginPath(); g.moveTo(x1, yy); g.lineTo(x2, yy); g.stroke();
        g.font = e.type === 'CHoCH' ? 'bold 11px system-ui, sans-serif' : '11px system-ui, sans-serif';
        label(e.type, (x1 + x2) / 2, yy + (e.dir === 1 ? -9 : 9), color, 'center');
        g.font = '11px system-ui, sans-serif';
      }
      g.setLineDash([]);
    }
    g.restore();
  }

  (function loop() {
    try { drawOverlay(); } catch (e) { console.error(e); }
    requestAnimationFrame(loop);
  })();

  // ---------------------------------------------------------------------------
  // Panneau d'analyse
  // ---------------------------------------------------------------------------
  function renderPanel() {
    const r = state.result;
    const c = state.candles;
    const el = $('analysis');
    if (!r || !r.ok) { el.innerHTML = '<p class="muted">Aucune analyse.</p>'; return; }
    const last = c[c.length - 1];
    const prevClose = c[c.length - 2] ? c[c.length - 2].close : last.open;
    const chg = ((last.close - prevClose) / prevClose) * 100;
    const htf = state.htfTrend;
    const lastEv = r.events[r.events.length - 1];
    const kz = r.killzone;
    const parts = [];

    parts.push(`
      <div class="card">
        <h3>${esc(state.label)} · ${esc(state.tf)}</h3>
        <div class="price">${fmt(last.close)} <span class="sub ${chg >= 0 ? 'bull' : 'bear'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} %</span></div>
        <div class="row"><span class="k">Session</span><span>${!r.useKillzones ? '<span class="muted">Synthétique 24h/24</span>' : kz ? 'Killzone ' + esc(kz.name) : '<span class="muted">Hors killzone</span>'}</span></div>
        <div class="row"><span class="k">ATR (14)</span><span>${fmt(r.atr[r.atr.length - 1])}</span></div>
      </div>`);

    parts.push(`
      <div class="card">
        <h3>Biais</h3>
        <div class="row"><span class="k">Structure ${esc(state.tf)}</span><span class="bias ${dirClass(r.trend)}">${dirWord(r.trend)}</span></div>
        <div class="row"><span class="k">Biais HTF ${htf ? '(' + esc(htf.tf) + ')' : ''}</span>
          <span class="bias ${htf ? dirClass(htf.trend) : 'neutral'}">${htf ? dirWord(htf.trend) : 'Indisponible'}</span></div>
        <div class="row"><span class="k">Dernier événement</span>
          <span>${lastEv ? `<b class="${lastEv.dir === 1 ? 'bull' : 'bear'}">${lastEv.type}</b> à ${fmt(lastEv.price)}` : '—'}</span></div>
      </div>`);

    if (r.pd) {
      const pos = Math.max(0, Math.min(1, r.pd.position));
      parts.push(`
        <div class="card">
          <h3>Premium / Discount</h3>
          <div class="pd-bar"><b style="left:${(pos * 100).toFixed(1)}%"></b></div>
          <div class="row sub"><span>Discount</span><span>50 %</span><span>Premium</span></div>
          <div class="row"><span class="k">Position dans le range</span><span class="${r.pd.zone === 'discount' ? 'bull' : 'bear'}">${(pos * 100).toFixed(0)} % · ${r.pd.zone === 'discount' ? 'Discount' : 'Premium'}</span></div>
          <div class="row"><span class="k">Range</span><span>${fmt(r.pd.low)} – ${fmt(r.pd.high)}</span></div>
          <div class="row"><span class="k">Équilibre</span><span>${fmt(r.pd.eq)}</span></div>
          <div class="row"><span class="k">OTE (62–79 %)</span><span>${fmt(Math.min(r.pd.ote.from, r.pd.ote.to))} – ${fmt(Math.max(r.pd.ote.from, r.pd.ote.to))}</span></div>
        </div>`);
    }

    const s = r.setup;
    if (s && s.zone) {
      const pct = Math.round(s.score * 100);
      parts.push(`
        <div class="card">
          <h3>Setup ${s.dir === 1 ? 'acheteur' : 'vendeur'} potentiel</h3>
          <div class="row"><span class="k">Zone</span><span>${esc(zoneName(s.zone))}${s.inZone ? ' · <b>prix dedans</b>' : ''}</span></div>
          <div class="row"><span class="k">Entrée</span><span>${fmt(s.entry)}</span></div>
          <div class="row"><span class="k">Stop loss</span><span class="bear">${fmt(s.sl)}</span></div>
          <div class="row"><span class="k">Objectif</span><span class="bull">${s.target ? fmt(s.target.price) + ' (' + esc(s.target.label) + ')' : '—'}</span></div>
          <div class="row"><span class="k">Risque / rendement</span><span>${s.rr ? '1 : ' + s.rr.toFixed(2) : '—'}</span></div>
          <div class="row"><span class="k">Confluences</span><span>${pct} %</span></div>
          <div class="meter"><i style="width:${pct}%"></i></div>
          <ul class="checklist">
            ${s.checklist.map((x) => `<li><span class="ico ${x.ok === true ? 'bull' : x.ok === false ? 'bear' : 'muted'}">${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'}</span><span>${esc(x.label)}</span></li>`).join('')}
          </ul>
        </div>`);
    } else {
      parts.push(`<div class="card"><h3>Setup</h3><p class="muted">${r.trend ? 'Pas de zone valide (OB/FVG) dans le sens du biais sous le prix actuel.' : 'Structure indéterminée : attendre une cassure (BOS/CHoCH).'}</p></div>`);
    }

    const zones = [
      ...r.blocks.filter((z) => z.status !== 'invalidated'),
      ...r.fvgs.filter((f) => f.status !== 'filled'),
    ].sort((a, b) => b.top - a.top);
    const price = last.close;
    const near = zones
      .map((z) => ({ z, d: Math.min(Math.abs(z.top - price), Math.abs(z.bottom - price)) }))
      .sort((a, b) => a.d - b.d).slice(0, 10)
      .map((o) => o.z).sort((a, b) => b.top - a.top);
    parts.push(`
      <div class="card">
        <h3>Zones actives proches</h3>
        ${near.length ? `<ul class="zone-list">${near.map((z) => `
          <li><span class="${z.dir === 1 ? 'bull' : 'bear'}">${esc(zoneName(z))}</span>
          <span>${fmt(z.bottom)} – ${fmt(z.top)} <span class="tag">${statusWord(z)}</span></span></li>`).join('')}</ul>` : '<p class="muted">Aucune.</p>'}
      </div>`);

    const liq = r.liquidity;
    const openPools = liq.pools.filter((p) => p.sweptAt === null).slice(-6).reverse();
    const sweeps = liq.sweeps.slice(-5).reverse();
    parts.push(`
      <div class="card">
        <h3>Liquidité</h3>
        <ul class="zone-list">
          ${openPools.map((p) => `<li><span>${p.type} (non prise)</span><span>${fmt(p.level)}</span></li>`).join('')}
          ${sweeps.map((sw) => `<li><span class="${sw.side === 'high' ? 'bear' : 'bull'}">Sweep ${sw.type}</span><span>${fmt(sw.level)} <span class="tag">il y a ${c.length - 1 - sw.sweptAt} b.</span></span></li>`).join('')}
          ${r.levels.pdh ? `<li><span>PDH / PDL</span><span>${fmt(r.levels.pdh.price)} / ${fmt(r.levels.pdl.price)}</span></li>` : ''}
        </ul>
      </div>`);

    parts.push(`
      <div class="card">
        <h3>Derniers événements de structure</h3>
        <ul class="zone-list">
          ${r.events.slice(-6).reverse().map((e) => `<li><span class="${e.dir === 1 ? 'bull' : 'bear'}">${e.type} ${e.dir === 1 ? '↑' : '↓'}</span><span>${fmt(e.price)} <span class="tag">il y a ${c.length - 1 - e.to} b.</span></span></li>`).join('') || '<li class="muted">Aucun</li>'}
        </ul>
      </div>
      <p class="disclaimer">Aide à l'analyse uniquement — pas un conseil en investissement.</p>`);

    el.innerHTML = parts.join('');
  }

  function statusWord(z) {
    if (z.kind === 'fvg') return z.status === 'partial' ? `comblé ${Math.round(z.fill * 100)} %` : 'intact';
    return z.status === 'mitigated' ? 'mitigé' : 'intact';
  }

  // ---------------------------------------------------------------------------
  // Événements de l'interface
  // ---------------------------------------------------------------------------
  function normalizeSymbol(v, source) {
    const t = String(v || '').trim();
    if (source === 'binance') return t.toUpperCase() || 'BTCUSDT';
    if (!t) return 'R_75';
    // Deriv : préfixes en minuscules (frx, cry, stp) et R_ en majuscules
    const known = Data.DERIV_SYMBOLS.find(([sym]) => sym.toLowerCase() === t.toLowerCase());
    return known ? known[0] : t;
  }

  function updateSourceFields() {
    const src = $('source').value;
    const live = src === 'binance' || src === 'deriv';
    $('symbolField').hidden = !live;
    $('appIdField').hidden = src !== 'deriv';
    $('csvField').hidden = src !== 'csv';
    $('auto').disabled = !live;
    $('autoLabel').textContent = src === 'deriv' ? 'Temps réel' : 'Auto (30 s)';
    if (live) {
      $('symbol').setAttribute('list', 'symbols-' + src);
      $('symbol').value = state.symbols[src] || '';
    }
    if (!live && $('auto').checked) { $('auto').checked = false; }
    stopStream(); // relancé par run() une fois les nouvelles données chargées
  }

  // ---------------------------------------------------------------------------
  // Mises à jour automatiques : flux WebSocket (Deriv) ou rafraîchissement (Binance)
  // ---------------------------------------------------------------------------
  function stopStream() {
    if (state.stream) { state.stream.onClose = null; state.stream.close(); }
    state.stream = null;
    state.streamKey = '';
    clearInterval(state.timer);
    state.timer = null;
  }

  async function syncStream() {
    const src = $('source').value;
    const want = $('auto').checked && (src === 'deriv' || src === 'binance') && state.candles.length > 0;
    const key = want ? [src, state.label, state.tf, $('appId').value].join('|') : '';
    if (key === state.streamKey) return;
    stopStream();
    if (!want) return;
    state.streamKey = key;

    if (src === 'binance') {
      state.timer = setInterval(run, 30000);
      return;
    }
    if (state.tf === '1w') { toast('Pas de flux temps réel en 1W : rafraîchissement toutes les 60 s.'); state.timer = setInterval(run, 60000); return; }
    try {
      const conn = await Data.streamDeriv(state.label, state.tf, $('appId').value, onTick, () => {
        if (state.stream === conn) {
          state.stream = null;
          state.streamKey = '';
          toast('Flux Deriv interrompu, reconnexion…', true);
          setTimeout(syncStream, 3000);
        }
      });
      if (state.streamKey !== key) { conn.close(); return; }
      state.stream = conn;
      toast(`Temps réel actif sur ${state.label}`);
    } catch (e) {
      state.streamKey = '';
      $('auto').checked = false;
      toast(`Temps réel indisponible : ${e.message}`, true);
    }
  }

  function onTick(ohlc) {
    if (!state.candles.length || ohlc.symbol && ohlc.symbol !== state.label) return;
    Data.applyDerivOhlc(state.candles, ohlc, 1000);
    // Analyse limitée à une fois par seconde (les synthétiques 1s tiquent très vite)
    if (state.streamTimer) return;
    state.streamTimer = setTimeout(() => {
      state.streamTimer = null;
      try {
        applyData({ candles: state.candles, tf: state.tf, label: state.label, htf: state.lastHtf, synthetic: state.synthetic });
      } catch (e) { console.error(e); }
    }, 1000);
  }

  async function loadDerivSymbolList() {
    const dl = $('symbols-deriv');
    const fill = (list) => {
      dl.innerHTML = list.map((x) => `<option value="${esc(x.symbol)}">${esc(x.name)}${x.market ? ' · ' + esc(x.market) : ''}</option>`).join('');
    };
    fill(Data.DERIV_SYMBOLS.map(([symbol, name]) => ({ symbol, name })));
    try {
      const all = await Data.listDerivSymbols($('appId').value);
      if (all.length) fill(all);
    } catch (e) { /* on garde la liste par défaut */ }
  }

  function init() {
    const p = loadPrefs();
    if (p.source && p.source !== 'csv') $('source').value = p.source;
    if (p.symbols) Object.assign(state.symbols, p.symbols);
    if (p.appId) $('appId').value = p.appId;
    if (p.tf) $('tf').value = p.tf;
    if (p.swingLen) $('swingLen').value = p.swingLen;
    const boxes = document.querySelectorAll('[data-layer]');
    if (Array.isArray(p.layers)) boxes.forEach((b) => { b.checked = p.layers.includes(b.dataset.layer); });
    boxes.forEach((b) => {
      if (b.checked) state.layers.add(b.dataset.layer);
      b.addEventListener('change', () => {
        if (b.checked) state.layers.add(b.dataset.layer); else state.layers.delete(b.dataset.layer);
        renderSeriesDecorations();
        savePrefs();
      });
    });

    $('source').addEventListener('change', () => { updateSourceFields(); savePrefs(); if ($('source').value !== 'csv' || state.csvRaw) run(); });
    $('tf').addEventListener('change', () => { savePrefs(); run(); });
    $('swingLen').addEventListener('change', () => { savePrefs(); run(); });
    const symbolChanged = () => {
      const src = $('source').value;
      $('symbol').value = normalizeSymbol($('symbol').value, src);
      state.symbols[src] = $('symbol').value;
      savePrefs();
      run();
    };
    $('symbol').addEventListener('change', symbolChanged);
    $('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') symbolChanged(); });
    $('appId').addEventListener('change', () => { savePrefs(); loadDerivSymbolList(); if ($('source').value === 'deriv') run(); });
    $('refresh').addEventListener('click', run);
    $('auto').addEventListener('change', syncStream);

    $('csvFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const candles = Data.parseCSV(await file.text());
        const tf = Data.detectTimeframe(candles);
        state.csvRaw = { candles, tf, name: file.name.replace(/\.(csv|txt)$/i, '') };
        $('tf').value = tf;
        toast(`${candles.length} bougies importées (unité détectée : ${tf}).`);
        run();
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('tab-analysis').hidden = t.dataset.tab !== 'analysis';
      $('tab-guide').hidden = t.dataset.tab !== 'guide';
    }));

    updateSourceFields();
    loadDerivSymbolList();
    run();
  }

  init();
})();
