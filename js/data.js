/*
 * Sources de données : Binance (API publique, sans clé), fichier CSV, démo.
 * Toutes renvoient des bougies { time (s, UTC), open, high, low, close, volume }.
 */
(function (root) {
  'use strict';

  const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  // Unité de temps supérieure utilisée pour le biais (analyse multi-timeframe)
  const HTF = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '4h': '1d', '1d': '1w', '1w': '1w' };

  const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

  async function fetchBinance(symbol, interval, limit = 1000) {
    const params = `symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${limit}`;
    let lastErr;
    for (const host of BINANCE_HOSTS) {
      try {
        const res = await fetch(`${host}/api/v3/klines?${params}`);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Binance ${res.status} : ${body.slice(0, 120)}`);
        }
        const rows = await res.json();
        return rows.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        }));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Binance injoignable');
  }

  // ---------------------------------------------------------------------------
  // Deriv (API WebSocket publique) : indices synthétiques, Forex, matières
  // premières, indices boursiers, crypto. Documentation : https://api.deriv.com
  // ---------------------------------------------------------------------------
  // app_id 1089 = application de test publique de Deriv. Pour un usage régulier,
  // enregistrer sa propre application sur api.deriv.com et saisir son app_id.
  const DERIV_DEFAULT_APP_ID = '1089';
  const DERIV_HOSTS = ['wss://ws.derivws.com/websockets/v3', 'wss://ws.binaryws.com/websockets/v3'];
  // Granularités acceptées par Deriv (secondes). Le 1W est reconstruit depuis le 1D.
  const DERIV_GRANULARITY = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 86400 };

  const DERIV_SYMBOLS = [
    ['R_10', 'Volatility 10 Index'], ['R_25', 'Volatility 25 Index'], ['R_50', 'Volatility 50 Index'],
    ['R_75', 'Volatility 75 Index'], ['R_100', 'Volatility 100 Index'],
    ['1HZ10V', 'Volatility 10 (1s) Index'], ['1HZ75V', 'Volatility 75 (1s) Index'], ['1HZ100V', 'Volatility 100 (1s) Index'],
    ['BOOM500', 'Boom 500 Index'], ['BOOM1000', 'Boom 1000 Index'], ['CRASH500', 'Crash 500 Index'], ['CRASH1000', 'Crash 1000 Index'],
    ['stpRNG', 'Step Index'], ['JD25', 'Jump 25 Index'],
    ['frxEURUSD', 'EUR/USD'], ['frxGBPUSD', 'GBP/USD'], ['frxUSDJPY', 'USD/JPY'], ['frxXAUUSD', 'Or / USD'],
    ['OTC_NDX', 'US Tech 100'], ['OTC_SPC', 'US 500'], ['OTC_DJI', 'Wall Street 30'], ['OTC_GDAXI', 'Germany 40'],
    ['cryBTCUSD', 'BTC/USD'], ['cryETHUSD', 'ETH/USD'],
  ];

  /** Les indices synthétiques tournent 24h/24 : les killzones ICT n'y ont pas de sens. */
  function isDerivSynthetic(symbol) {
    return !/^(frx|cry|OTC_|WLD)/.test(symbol);
  }

  /** Connexion WebSocket Deriv avec requêtes identifiées (req_id). */
  class DerivConnection {
    constructor(appId) {
      this.appId = String(appId || DERIV_DEFAULT_APP_ID).trim();
      this.ws = null;
      this.pending = new Map();
      this.nextId = 1;
      this.onStream = null;
      this.onClose = null;
      this.ping = null;
    }

    async open() {
      let lastErr;
      for (const host of DERIV_HOSTS) {
        try {
          await this._connect(`${host}?app_id=${encodeURIComponent(this.appId)}&l=FR`);
          return this;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Deriv injoignable');
    }

    _connect(url) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); reject(new Error('Deriv : délai de connexion dépassé')); }, 10000);
        ws.onopen = () => {
          clearTimeout(timer);
          this.ws = ws;
          // Deriv coupe les connexions inactives : ping régulier
          this.ping = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
          resolve();
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('Deriv injoignable')); };
        ws.onclose = () => {
          clearInterval(this.ping);
          for (const p of this.pending.values()) p.reject(new Error('Connexion Deriv fermée'));
          this.pending.clear();
          if (this.ws === ws && this.onClose) this.onClose();
        };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          const p = msg.req_id !== undefined ? this.pending.get(msg.req_id) : null;
          if (msg.msg_type === 'ohlc' && this.onStream && !msg.error) {
            this.onStream(msg.ohlc);
            return;
          }
          if (p) {
            this.pending.delete(msg.req_id);
            if (msg.error) p.reject(new Error(`Deriv : ${msg.error.message || msg.error.code}`));
            else p.resolve(msg);
          }
        };
      });
    }

    send(req) {
      if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Connexion Deriv fermée'));
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ ...req, req_id: id }));
      });
    }

    close() {
      clearInterval(this.ping);
      const ws = this.ws;
      this.ws = null;
      if (ws) ws.close();
    }
  }

  function derivCandlesRequest(symbol, interval, count, subscribe) {
    const req = {
      ticks_history: symbol, style: 'candles', end: 'latest',
      granularity: DERIV_GRANULARITY[interval] || 900,
      count: Math.min(5000, interval === '1w' ? count * 7 : count),
      adjust_start_time: 1,
    };
    if (subscribe) req.subscribe = 1;
    return req;
  }

  /** Convertit la réponse `ticks_history` (style candles) en bougies. */
  function parseDerivCandles(msg, interval) {
    const list = (msg && msg.candles) || [];
    let out = list.map((k) => ({
      time: +k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0,
    })).filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite));
    out = normalize(out);
    if (interval === '1w') out = resampleWeekly(out);
    return out;
  }

  function resampleWeekly(c) {
    const out = [];
    for (const b of c) {
      const d = new Date(b.time * 1000);
      const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) / 1000;
      const last = out[out.length - 1];
      if (last && last.time === monday) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
      } else {
        out.push({ ...b, time: monday });
      }
    }
    return out;
  }

  /**
   * Intègre un message `ohlc` du flux temps réel : met à jour la dernière
   * bougie ou en ajoute une nouvelle. Renvoie true si une bougie a été ajoutée.
   */
  function applyDerivOhlc(candles, ohlc, maxLength = 1000) {
    const b = {
      time: +ohlc.open_time, open: +ohlc.open, high: +ohlc.high,
      low: +ohlc.low, close: +ohlc.close, volume: 0,
    };
    if (![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) return false;
    const last = candles[candles.length - 1];
    if (last && b.time === last.time) {
      candles[candles.length - 1] = b;
      return false;
    }
    if (last && b.time < last.time) return false;
    candles.push(b);
    while (candles.length > maxLength) candles.shift();
    return true;
  }

  async function fetchDeriv(symbol, interval, count, appId, htfInterval) {
    const conn = await new DerivConnection(appId).open();
    try {
      const main = await conn.send(derivCandlesRequest(symbol, interval, count, false));
      const candles = parseDerivCandles(main, interval);
      let htf = null;
      if (htfInterval && htfInterval !== interval) {
        try {
          const h = await conn.send(derivCandlesRequest(symbol, htfInterval, 500, false));
          htf = { tf: htfInterval, candles: parseDerivCandles(h, htfInterval) };
        } catch (e) { /* biais HTF facultatif */ }
      }
      return { candles, htf, pip: main.pip_size };
    } finally {
      conn.close();
    }
  }

  /**
   * Flux temps réel : onCandle(ohlc) à chaque tick. Renvoie la connexion
   * (appeler .close() pour arrêter). Le 1W n'est pas diffusé en direct.
   */
  async function streamDeriv(symbol, interval, appId, onCandle, onClose) {
    const conn = await new DerivConnection(appId).open();
    conn.onStream = onCandle;
    conn.onClose = onClose;
    try {
      await conn.send(derivCandlesRequest(symbol, interval, 1, true));
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }

  async function listDerivSymbols(appId) {
    const conn = await new DerivConnection(appId).open();
    try {
      const res = await conn.send({ active_symbols: 'brief' });
      return (res.active_symbols || []).map((s) => ({
        symbol: s.symbol, name: s.display_name, market: s.market_display_name, open: !!s.exchange_is_open,
      }));
    } finally {
      conn.close();
    }
  }

  // ---------------------------------------------------------------------------
  // CSV : TradingView, MetaTrader (date et heure séparées), exports génériques
  // ---------------------------------------------------------------------------
  function parseTime(str) {
    const s = String(str).trim().replace(/^"|"$/g, '');
    if (/^\d+(\.\d+)?$/.test(s)) {
      const v = +s;
      return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    // 2024.01.02 13:00 | 2024-01-02 13:00:00 | 2024-01-02T13:00:00Z
    let iso = s.replace(/^(\d{4})[./](\d{2})[./](\d{2})/, '$1-$2-$3').replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += (iso.includes('T') ? '' : 'T00:00') + 'Z';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
      // 02/01/2024 13:00 (jour/mois/année)
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
      if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) / 1000;
      return NaN;
    }
    return Math.floor(t / 1000);
  }

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Fichier vide');
    const sep = [';', '\t', ','].find((s) => lines[0].split(s).length >= 5) || ',';
    let header = null;
    const first = lines[0].split(sep).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase());
    if (first.some((x) => /open|high|low|close|time|date/.test(x))) {
      header = first;
      lines.shift();
    }
    const idx = (names, fallback) => {
      if (!header) return fallback;
      const i = header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
      return i >= 0 ? i : fallback;
    };
    const out = [];
    for (const line of lines) {
      let cols = line.split(sep).map((x) => x.trim());
      // MetaTrader : date et heure dans deux colonnes séparées
      if (!header && /^\d{1,2}:\d{2}/.test(cols[1] || '')) cols = [cols[0] + ' ' + cols[1], ...cols.slice(2)];
      let iT = idx(['time', 'date', 'timestamp', 'datetime'], 0);
      let iO = idx(['open', 'o'], 1);
      let iH = idx(['high', 'h'], 2);
      let iL = idx(['low', 'l'], 3);
      let iC = idx(['close', 'c'], 4);
      let iV = idx(['volume', 'vol', 'tick'], 5);
      if (header && header[0] === 'date' && header[1] === 'time') {
        cols = [cols[0] + ' ' + cols[1], ...cols.slice(2)];
        iT = 0; iO -= 1; iH -= 1; iL -= 1; iC -= 1; iV -= 1;
      }
      const b = {
        time: parseTime(cols[iT]),
        open: parseFloat(cols[iO]), high: parseFloat(cols[iH]),
        low: parseFloat(cols[iL]), close: parseFloat(cols[iC]),
        volume: parseFloat(cols[iV]) || 0,
      };
      if ([b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) out.push(b);
    }
    if (out.length < 20) throw new Error('Format CSV non reconnu (colonnes attendues : time, open, high, low, close)');
    return normalize(out);
  }

  /** Tri chronologique + suppression des doublons. */
  function normalize(c) {
    c.sort((a, b) => a.time - b.time);
    const out = [];
    for (const b of c) {
      if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
      else out.push(b);
    }
    return out;
  }

  function detectTimeframe(c) {
    if (c.length < 3) return '1h';
    const diffs = [];
    for (let i = 1; i < Math.min(c.length, 200); i++) diffs.push(c[i].time - c[i - 1].time);
    diffs.sort((a, b) => a - b);
    const d = diffs[Math.floor(diffs.length / 2)];
    let best = '1h';
    let bestErr = Infinity;
    for (const [tf, s] of Object.entries(TF_SECONDS)) {
      const err = Math.abs(Math.log(d / s));
      if (err < bestErr) { bestErr = err; best = tf; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Données de démonstration (marche aléatoire avec tendances et impulsions)
  // ---------------------------------------------------------------------------
  function demoCandles(interval = '15m', count = 1000, seed = 42) {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const step = TF_SECONDS[interval] || 900;
    const end = Math.floor(Date.now() / 1000 / step) * step;
    let price = 65000;
    let drift = 0;
    const vol = 0.0025 * Math.sqrt(step / 900);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i % 60 === 0) drift = (rnd() - 0.5) * vol * 0.5;
      const impulse = rnd() < 0.03 ? (rnd() - 0.5) * vol * 8 : 0;
      const open = price;
      const ret = drift + (rnd() - 0.5) * vol * 2 + impulse;
      const close = open * (1 + ret);
      const high = Math.max(open, close) * (1 + rnd() * vol);
      const low = Math.min(open, close) * (1 - rnd() * vol);
      out.push({ time: end - (count - 1 - i) * step, open, high, low, close, volume: 100 + rnd() * 900 });
      price = close;
    }
    return out;
  }

  const Data = {
    TF_SECONDS, HTF, fetchBinance, parseCSV, parseTime, normalize, detectTimeframe, demoCandles,
    DERIV_DEFAULT_APP_ID, DERIV_SYMBOLS, isDerivSynthetic, fetchDeriv, streamDeriv, listDerivSymbols,
    parseDerivCandles, applyDerivOhlc, derivCandlesRequest,
  };
  root.SMCData = Data;
  if (typeof module !== 'undefined' && module.exports) module.exports = Data;
})(typeof window !== 'undefined' ? window : globalThis);
