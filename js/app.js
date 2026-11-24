/* Interface : chargement des données, graphique, dessin des concepts SMC/ICT. */
(function () {
  'use strict';

  const { SMC, SMCData: Data, LightweightCharts: LWC } = window;
  const $ = (id) => document.getElementById(id);

  const COLORS = {
    bull: '#26a69a', bear: '#ef5350', text: '#d6dde6', muted: '#8b96a5',
    bullZone: 'rgba(38,166,154,', bearZone: 'rgba(239,83,80,',
    fvgBull: 'rgba(79,140,255,', fvgBear: 'rgba(255,152,0,',
    gap: 'rgba(179,157,219,',
    ifvg: 'rgba(0,188,212,',
    unicorn: 'rgba(174,213,129,',
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
        known: [...document.querySelectorAll('[data-layer]')].map((b) => b.dataset.layer),
        capital: $('capital').value, riskPct: $('riskPct').value,
        unitsPerLot: $('cUnitsPerLot').value,
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
  /** Somme en USD : 2 décimales suffisent. */
  const money = (v) => (Number.isFinite(v) ? v.toFixed(2) + ' USD' : '—');

  /** Volume : assez de décimales pour un micro-lot, sans bruit inutile. */
  const vol = (v) => {
    if (!Number.isFinite(v)) return '—';
    if (v >= 100) return v.toFixed(2);
    if (v >= 1) return v.toFixed(3);
    return v.toPrecision(3);
  };

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
    if (state.layers.has('judas') && r.judas) {
      for (const j of r.judas) {
        if (T[j.sweepIndex] !== undefined) {
          markers.push({
            time: T[j.sweepIndex],
            position: j.dir === 1 ? 'belowBar' : 'aboveBar',
            color: '#ffb74d',
            shape: j.dir === 1 ? 'arrowUp' : 'arrowDown',
            text: 'Judas ' + j.sessionName,
          });
        }
      }
    }

    if (state.layers.has('cisd') && r.cisd) {
      for (const x of r.cisd.slice(-3)) {
        if (T[x.index] === undefined) continue;
        markers.push({
          time: T[x.index],
          position: x.dir === 1 ? 'belowBar' : 'aboveBar',
          color: '#26c6da',
          shape: x.dir === 1 ? 'arrowUp' : 'arrowDown',
          text: 'CISD',
        });
      }
    }

    if (state.layers.has('turtle') && r.turtle) {
      for (const t of r.turtle.slice(-6)) {
        if (T[t.index] === undefined) continue;
        markers.push({
          time: T[t.index],
          position: t.side === 'high' ? 'aboveBar' : 'belowBar',
          color: '#ab47bc',
          shape: 'circle',
          size: 0.6,
          text: '$',
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
    // Le True Open du jour vaut le Midnight Open : on ne redessine que celui de
    // la semaine, qui n'est affiché nulle part ailleurs.
    if (state.layers.has('quarters') && intraday && r.trueOpens && r.trueOpens.wto) {
      line(r.trueOpens.wto.price, '#b39ddb', 'WTO (lundi 18h)', LWC.LineStyle.LargeDashed);
    }
    if (state.layers.has('cisd') && r.cisd && r.cisd.length) {
      const x = r.cisd[r.cisd.length - 1];
      line(x.level, '#26c6da', 'CISD ' + (x.dir === 1 ? '↑' : '↓'), LWC.LineStyle.Dotted);
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
    if (z.kind === 'fvg') return (z.dir === 1 ? 'FVG haussier (BISI)' : 'FVG baissier (SIBI)');
    if (z.kind === 'ifvg') return (z.dir === 1 ? 'IFVG haussier' : 'IFVG baissier');
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

    // Quarterly Theory : séparateurs des quarts de 6 h et des blocs de 90 min
    if (state.layers.has('quarters') && r.useKillzones && Data.TF_SECONDS[state.tf] <= 3600) {
      const vr = ts.getVisibleLogicalRange();
      if (vr) {
        const from = Math.max(1, Math.floor(vr.from));
        const to = Math.min(n - 1, Math.ceil(vr.to));
        for (let i = from; i <= to; i++) {
          const q = SMC.quarterOf(state.candles[i].time);
          const prev = SMC.quarterOf(state.candles[i - 1].time);
          if (!q || !prev) continue;
          const newQuarter = q.id !== prev.id;
          const newBlock = newQuarter || q.subStart !== prev.subStart;
          if (!newBlock) continue;
          const xq = x(i) - bw / 2;
          if (xq === null) continue;
          g.strokeStyle = newQuarter ? 'rgba(179,157,219,.45)' : 'rgba(179,157,219,.14)';
          g.setLineDash(newQuarter ? [] : [2, 4]);
          g.beginPath(); g.moveTo(xq, 0); g.lineTo(xq, h); g.stroke();
          g.setLineDash([]);
          if (newQuarter) label(`${q.name} · ${q.phase}`, xq + 4, 12, 'rgba(179,157,219,.75)');
          else label(`${q.sub}`, xq + 3, 24, 'rgba(179,157,219,.4)');
        }
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
    // Écarts d'ouverture : la zone, plus son milieu (CE) en pointillé — c'est le
    // niveau que la méthode surveille, pas les bords.
    if (state.layers.has('gaps') && r.gaps) {
      for (const gp of [...r.gaps.nwog, ...r.gaps.ndog]) {
        if (!history && gp.status === 'filled') continue;
        const alpha = gp.status === 'filled' ? 0.05 : gp.status === 'ce' ? 0.10 : 0.18;
        drawZone(gp, null, COLORS.gap, alpha, gp.kind.toUpperCase());
        const ym = y(gp.mid);
        const xm = x(gp.index);
        if (ym !== null && xm !== null) {
          g.strokeStyle = COLORS.gap + '.55)';
          g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(Math.max(xm, 0), ym); g.lineTo(w, ym); g.stroke();
          g.setLineDash([]);
        }
      }
    }

    // Judas Swing : la range de référence, du début de la session de référence
    // jusqu'au balayage qui l'a prise.
    if (state.layers.has('judas') && r.judas) {
      for (const j of r.judas) {
        const zone = { index: j.rangeFrom, top: j.rangeHigh, bottom: j.rangeLow };
        drawZone(zone, j.sweepIndex, 'rgba(255,183,77,', 0.08, `Range ${j.sessionName}`);
      }
    }

    // Unicorn : on dessine le chevauchement, la zone réellement tradable.
    if (state.layers.has('unicorn') && r.unicorns) {
      for (const u of r.unicorns) {
        drawZone(u, null, COLORS.unicorn, 0.22, 'Unicorn');
        const ye = y(u.entry);
        const xe = x(u.index);
        if (ye !== null && xe !== null) {
          g.strokeStyle = COLORS.unicorn + '.8)';
          g.setLineDash([4, 2]);
          g.beginPath(); g.moveTo(Math.max(xe, 0), ye); g.lineTo(w, ye); g.stroke();
          g.setLineDash([]);
        }
      }
    }

    // IFVG : un FVG traversé en clôture, désormais zone de sens inverse.
    if (state.layers.has('ifvg') && r.ifvgs) {
      for (const z of r.ifvgs) {
        if (!history && z.status === 'invalidated') continue;
        const alpha = z.status === 'invalidated' ? 0.05 : z.status === 'mitigated' ? 0.12 : 0.20;
        drawZone(z, z.invalidatedAt, COLORS.ifvg, alpha, 'IFVG');
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
  // Taille de position (exécution manuelle chez le broker)
  // ---------------------------------------------------------------------------
  /** Lignes « Taille de position » de la carte Setup. */
  function sizeRows(s) {
    const ps = SMC.positionSize(s.entry, s.sl, parseFloat($('capital').value), parseFloat($('riskPct').value));
    if (!ps) return '<div class="row"><span class="k">Taille de position</span><span class="muted">renseigner Capital et Risque %</span></div>';
    const u = ps.units;
    const units = u >= 100 ? u.toFixed(2) : u >= 1 ? u.toFixed(4) : u.toPrecision(3);
    return `
          <div class="row"><span class="k">Risque par unité</span><span>${fmt(ps.perUnit)}</span></div>
          <div class="row"><span class="k">Montant risqué</span><span class="bear">${money(ps.riskMoney)}</span></div>
          <div class="row"><span class="k">Taille de position</span><span><b>${units}</b> unités</span></div>
          ${quoteWarning()}`;
  }

  // ---------------------------------------------------------------------------
  // Alertes du serveur (si l'app est servie par server/server.js)
  // ---------------------------------------------------------------------------
  // Ouverte en file://, l'app n'a pas de serveur : la carte reste simplement
  // absente, aucune erreur affichée.
  const SERVER_ALERTS_MS = 30000;

  function alertAge(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `il y a ${s} s`;
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
    return `il y a ${Math.round(s / 86400)} j`;
  }

  async function refreshServerAlerts() {
    const el = $('serverAlerts');
    let data;
    try {
      const res = await fetch('api/alerts?limit=25', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch (e) {
      el.innerHTML = '';                         // pas de serveur : rien à montrer
      return;
    }
    const rows = Array.isArray(data.alerts) ? data.alerts : [];
    if (!rows.length) {
      el.innerHTML = '<div class="card"><h3>Alertes du serveur</h3><p class="muted">Aucune alerte enregistrée pour l’instant.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="card">
        <h3>Alertes du serveur</h3>
        <ul class="zone-list">
          ${rows.map((a) => `
            <li>
              <span><span class="tag">${esc(a.symbol)} ${esc(a.tf)}</span>
                <span class="${a.dir === 1 ? 'bull' : a.dir === -1 ? 'bear' : ''}">${esc(a.text)}</span></span>
              <span class="sub">${esc(alertAge(a.detected_at))}${a.notified ? '' : ' · non envoyée'}</span>
            </li>`).join('')}
        </ul>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Onglet Calculateur
  // ---------------------------------------------------------------------------
  const CALC_FIELDS = ['cEntry', 'cSl', 'cTp', 'cCapital', 'cRiskPct', 'cUnitsPerLot', 'cLots'];

  /**
   * Avertissement si l'actif courant n'est pas coté en USD : les montants
   * calculés sont alors dans la devise de cotation, pas en USD.
   */
  function quoteWarning() {
    const q = Data.quoteCurrency(state.label, $('source').value);
    if (!q || q === 'USD') return '';
    return `<p class="sub bear">${esc(state.label)} est coté en ${esc(q)}, pas en USD : les montants ci-dessus sont en ${esc(q)}. Convertir en USD au taux ${esc(q)}/USD.</p>`;
  }

  function renderCalc() {
    const el = $('calcOut');
    const m = SMC.tradeMath({
      entry: $('cEntry').value, sl: $('cSl').value, tp: $('cTp').value,
      capital: $('cCapital').value, riskPct: $('cRiskPct').value,
      unitsPerLot: $('cUnitsPerLot').value, lots: $('cLots').value,
    });
    if (!m) {
      el.innerHTML = '<div class="card"><h3>Résultat</h3><p class="muted">Renseigner une entrée et un stop loss différents l’un de l’autre.</p></div>';
      return;
    }

    const parts = [];
    const sens = m.dir === 1 ? '<span class="bias bull">Achat</span>' : '<span class="bias bear">Vente</span>';
    parts.push(`
      <div class="card">
        <h3>Trade</h3>
        <div class="row"><span class="k">Sens</span><span>${sens}</span></div>
        <div class="row"><span class="k">Distance au stop</span><span class="bear">${fmt(m.stopDist)}</span></div>
        <div class="row"><span class="k">Distance à l'objectif</span><span class="bull">${m.tpValid ? fmt(m.targetDist) : '—'}</span></div>
        <div class="row"><span class="k">Risque / rendement</span><span>${m.rr ? '1 : ' + m.rr.toFixed(2) : '—'}</span></div>
        ${m.tpValid === false ? `<p class="sub bear">Objectif du mauvais côté de l'entrée pour un ${m.dir === 1 ? 'achat' : 'vente'} : il devrait être ${m.dir === 1 ? 'au-dessus' : 'en dessous'} de l'entrée.</p>` : ''}
      </div>`);

    const r = m.fromRisk;
    parts.push(`
      <div class="card">
        <h3>Volume conseillé</h3>
        ${r ? `
        <div class="row"><span class="k">Montant risqué</span><span class="bear">${money(r.riskMoney)}</span></div>
        <div class="row"><span class="k">Gain si objectif touché</span><span class="bull">${money(r.rewardMoney)}</span></div>
        <div class="row"><span class="k">Taille</span><span>${vol(r.units)} unités</span></div>
        <div class="row"><span class="k">Volume</span><span><b>${r.lots === null ? '—' : vol(r.lots)}</b> lots</span></div>
        ${quoteWarning()}`
      : '<p class="muted">Renseigner Capital et Risque % (entre 0,1 et 100).</p>'}
      </div>`);

    const f = m.fromLots;
    if (f) {
      const over = f.riskPctOfCapital !== null && f.riskPctOfCapital > Number($('cRiskPct').value || 0);
      parts.push(`
        <div class="card">
          <h3>Volume saisi : ${vol(f.lots)} lots</h3>
          <div class="row"><span class="k">Taille</span><span>${vol(f.units)} unités</span></div>
          <div class="row"><span class="k">Montant risqué</span><span class="bear">${money(f.riskMoney)}</span></div>
          <div class="row"><span class="k">Gain si objectif touché</span><span class="bull">${money(f.rewardMoney)}</span></div>
          <div class="row"><span class="k">Part du capital</span><span class="${over ? 'bear' : ''}">${f.riskPctOfCapital === null ? '—' : f.riskPctOfCapital.toFixed(2) + ' %'}</span></div>
          ${over ? '<p class="sub bear">Ce volume risque plus que le pourcentage fixé.</p>' : ''}
        </div>`);
    }

    el.innerHTML = parts.join('');
  }

  /** Recopie l'entrée, le stop et l'objectif du setup courant dans le calculateur. */
  function calcFromSetup() {
    const s = state.result && state.result.setup;
    if (!s || !s.zone) { toast('Aucun setup en cours à reprendre.', true); return; }
    $('cEntry').value = s.entry;
    $('cSl').value = s.sl;
    $('cTp').value = s.target ? s.target.price : '';
    savePrefs();
    renderCalc();
  }

  function initCalc(p) {
    // Capital et risque : mêmes valeurs que la barre d'outils, dans les deux sens.
    $('cCapital').value = $('capital').value;
    $('cRiskPct').value = $('riskPct').value;
    if (p.unitsPerLot) $('cUnitsPerLot').value = p.unitsPerLot;

    for (const id of CALC_FIELDS) {
      $(id).addEventListener('input', () => {
        if (id === 'cCapital') $('capital').value = $(id).value;
        if (id === 'cRiskPct') $('riskPct').value = $(id).value;
        if (id === 'cCapital' || id === 'cRiskPct') renderPanel();
        savePrefs();
        renderCalc();
      });
    }
    $('cFromSetup').addEventListener('click', calcFromSetup);
    renderCalc();
  }

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
          ${sizeRows(s)}
          <div class="row"><span class="k">Confluences</span><span>${pct} %</span></div>
          <div class="meter"><i style="width:${pct}%"></i></div>
          <ul class="checklist">
            ${s.checklist.map((x) => `<li><span class="ico ${x.ok === true ? 'bull' : x.ok === false ? 'bear' : 'muted'}">${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'}</span><span>${esc(x.label)}</span></li>`).join('')}
          </ul>
        </div>`);
    } else {
      parts.push(`<div class="card"><h3>Setup</h3><p class="muted">${r.trend ? 'Pas de zone valide (OB/FVG) dans le sens du biais sous le prix actuel.' : 'Structure indéterminée : attendre une cassure (BOS/CHoCH).'}</p></div>`);
    }

    const prof = r.profile;
    if (prof && prof.days >= 3) {
      // Échantillon trop court = statistique sans valeur : on le dit au lieu de
      // laisser croire à une tendance.
      const thin = prof.weeks < 20;
      const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) + ' %' : '—');
      const JOURS = { Sun: 'Dim', Mon: 'Lun', Tue: 'Mar', Wed: 'Mer', Thu: 'Jeu', Fri: 'Ven', Sat: 'Sam' };
      parts.push(`
        <div class="card">
          <h3>Profils observés</h3>
          <div class="row"><span class="k">Échantillon</span><span>${prof.days} jours · ${prof.weeks} semaines complètes</span></div>
          ${thin ? '<p class="sub bear">Échantillon trop court pour une tendance : ces chiffres décrivent l’historique chargé, ils ne prédisent rien. Charger plus de bougies ou une unité de temps supérieure.</p>' : ''}
          <p class="sub">Session portant l'extrême du jour</p>
          <ul class="zone-list">
            ${prof.session.map((x) => `<li><span>${esc(x.name)}</span><span>haut ${pct(x.high, prof.days)} · bas ${pct(x.low, prof.days)}</span></li>`).join('')}
          </ul>
          <p class="sub">Jour portant l'extrême de la semaine</p>
          <ul class="zone-list">
            ${prof.weekday.map((x) => `<li><span>${esc(JOURS[x.weekday] || x.weekday)} <span class="tag">${x.days} j</span></span><span>haut ${pct(x.high, prof.weeks)} · bas ${pct(x.low, prof.weeks)} · haussier ${pct(x.up, x.days)}</span></li>`).join('')}
          </ul>
        </div>`);
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

    if (r.regime) {
      const g = r.regime;
      const cls = g.kind === 'expansion' ? 'bull' : g.kind === 'consolidation' ? 'bear' : '';
      parts.push(`
        <div class="card">
          <h3>Régime du jour</h3>
          <div class="row"><span class="k">Dernier jour complet</span><span class="${cls}">${g.kind} <span class="tag">${esc(g.key)}</span></span></div>
          <div class="row"><span class="k">Range / médiane</span><span>${fmt(g.range)} / ${fmt(g.median)} <span class="tag">×${g.ratio.toFixed(2)}</span></span></div>
          ${g.running ? `<div class="row"><span class="k">Journée en cours</span><span class="muted">×${g.running.ratio.toFixed(2)} — incomplète, non comparable</span></div>` : ''}
          <p class="sub">${esc(g.advice)}</p>
        </div>`);
    }

    if (r.retracement) {
      const x = r.retracement;
      parts.push(`
        <div class="card">
          <h3>Retracement en cours</h3>
          <div class="row"><span class="k">Type</span><span class="${x.strong ? 'bear' : 'bull'}"><b>${x.kind}</b> <span class="tag">${x.score}/3</span></span></div>
          <div class="row"><span class="k">Plus gros corps</span><span>${x.bodyAtr.toFixed(2)} ATR</span></div>
          <div class="row"><span class="k">FVG laissés</span><span>${x.fvgCount}</span></div>
          <div class="row"><span class="k">Suite de même sens</span><span>${x.longestRun} bougies</span></div>
          <p class="sub">${esc(x.verdict)}</p>
        </div>`);
    }

    if (r.quarter) {
      const q = r.quarter;
      const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}h${String(m % 60).padStart(2, '0')}`;
      const o = r.trueOpens || {};
      parts.push(`
        <div class="card">
          <h3>Quarterly Theory</h3>
          <div class="row"><span class="k">Quart</span><span>${esc(q.name)} <span class="tag">${hhmm(q.start)} – ${hhmm(q.end)}</span></span></div>
          <div class="row"><span class="k">Phase attendue</span><span>${esc(q.phase)}</span></div>
          <div class="row"><span class="k">Bloc 90 min</span><span>${q.sub} / 4 <span class="tag">${hhmm(q.subStart)} – ${hhmm(q.subEnd)}</span></span></div>
          <div class="row"><span class="k">True Session Open</span><span>${hhmm(q.trueSessionOpen)}</span></div>
          <div class="row"><span class="k">True Open du jour</span><span>${o.tdo ? fmt(o.tdo.price) : '—'}</span></div>
          <div class="row"><span class="k">True Open de la semaine</span><span>${o.wto ? fmt(o.wto.price) : '<span class="muted">hors historique</span>'}</span></div>
          <p class="sub">Séquence attendue AMDX : accumulation, manipulation, distribution, puis continuation ou retournement. La variante XAMD relève du jugement et n'est pas détectée.</p>
        </div>`);
    }

    if (r.unicorns && r.unicorns.length) {
      parts.push(`
        <div class="card">
          <h3>Unicorn</h3>
          <ul class="zone-list">
            ${[...r.unicorns].reverse().map((u) => {
              const rr = Math.abs(u.entry - u.sl);
              return `
              <li>
                <span><span class="tag">${u.dir === 1 ? 'achat' : 'vente'}</span>
                  <span class="${u.dir === 1 ? 'bull' : 'bear'}">${fmt(u.bottom)} – ${fmt(u.top)}</span>
                  <span class="sub">${esc(u.mssType)} · balayage ${esc(u.sweepType)}</span></span>
                <span>entrée ${fmt(u.entry)}${u.entryClamped ? ' <span class="tag">ramenée</span>' : ''}
                  <span class="bear">stop ${fmt(u.sl)}</span>
                  <span class="sub">risque ${fmt(rr)}</span></span>
              </li>`;
            }).join('')}
          </ul>
          <p class="sub">Breaker chevauchant un FVG, après balayage de liquidité et cassure de structure. Entrée au CE du FVG, stop au-delà de l'extrême balayé.</p>
        </div>`);
    }

    if (r.judas && r.judas.length) {
      const JUDAS_STATUS = { confirmed: 'confirmé', displaced: 'déplacement confirmé' };
      parts.push(`
        <div class="card">
          <h3>Judas Swing</h3>
          <ul class="zone-list">
            ${[...r.judas].reverse().map((j) => `
              <li>
                <span><span class="tag">${esc(j.sessionName)}</span>
                  <span class="${j.dir === 1 ? 'bull' : 'bear'}">${j.dir === 1 ? 'haussier' : 'baissier'}</span>
                  <span class="sub">range ${fmt(j.rangeLow)} – ${fmt(j.rangeHigh)}</span></span>
                <span>${fmt(j.sweepLevel)} <span class="tag">${JUDAS_STATUS[j.status]}</span>
                  <span class="sub">il y a ${c.length - 1 - j.sweepIndex} b.</span></span>
              </li>`).join('')}
          </ul>
          <p class="sub">Liquidité prise hors de la range d'ouverture, puis clôture de retour dedans. Le sens affiché est celui du vrai mouvement attendu, à l'opposé du balayage.</p>
        </div>`);
    }

    const gapList = r.gaps ? [...r.gaps.nwog, ...r.gaps.ndog].sort((a, b) => b.index - a.index) : [];
    if (gapList.length) {
      const GAP_STATUS = { intact: 'intact', ce: 'milieu atteint', filled: 'comblé' };
      parts.push(`
        <div class="card">
          <h3>Écarts d'ouverture</h3>
          <ul class="zone-list">
            ${gapList.slice(0, 8).map((gp) => `
              <li>
                <span><span class="tag">${gp.kind.toUpperCase()}</span> ${fmt(gp.bottom)} – ${fmt(gp.top)}</span>
                <span>milieu ${fmt(gp.mid)} <span class="tag">${GAP_STATUS[gp.status]}</span></span>
              </li>`).join('')}
          </ul>
          <p class="sub">Le milieu (consequent encroachment) est le niveau suivi par la méthode, pas les bords.</p>
        </div>`);
    }

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
      // Le flux Deriv ne passe pas par le relais : un WebSocket ne se proxyfie
      // pas avec une simple requête. Mais si le relais sert les bougies, on peut
      // rafraîchir régulièrement — moins fin qu'un tick, suffisant pour suivre.
      if (Data.relayAvailable()) {
        state.timer = setInterval(run, 30000);
        toast(`Flux direct indisponible (${e.message}). Rafraîchissement par le serveur toutes les 30 s.`, true);
        return;
      }
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
    if (p.capital) $('capital').value = p.capital;
    if (p.riskPct) $('riskPct').value = p.riskPct;
    const boxes = document.querySelectorAll('[data-layer]');
    // Un calque que les préférences enregistrées ne connaissaient pas garde
    // l'état coché du HTML : sans ça, chaque nouveau calque arriverait décoché
    // pour les utilisateurs existants. `known` liste les calques connus lors de
    // la sauvegarde ; les préférences antérieures à ce champ portent sur le jeu
    // de calques ci-dessous.
    const PRE_KNOWN_LAYERS = [
      'structure', 'swings', 'ob', 'breaker', 'fvg',
      'liquidity', 'pd', 'killzones', 'levels', 'history',
    ];
    if (Array.isArray(p.layers)) {
      const known = Array.isArray(p.known) ? p.known : PRE_KNOWN_LAYERS;
      boxes.forEach((b) => {
        if (known.includes(b.dataset.layer)) b.checked = p.layers.includes(b.dataset.layer);
      });
    }
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
    for (const id of ['capital', 'riskPct']) {
      $(id).addEventListener('input', () => {
        $(id === 'capital' ? 'cCapital' : 'cRiskPct').value = $(id).value;
        savePrefs();
        renderPanel();
        renderCalc();
      });
    }
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
      for (const name of ['analysis', 'calc', 'guide']) {
        $('tab-' + name).hidden = t.dataset.tab !== name;
      }
    }));

    initCalc(p);
    refreshServerAlerts();
    setInterval(refreshServerAlerts, SERVER_ALERTS_MS);
    updateSourceFields();
    loadDerivSymbolList();
    run();
  }

  init();
})();
