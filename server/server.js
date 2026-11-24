/**
 * Serveur SMC · ICT : sert l'application, surveille une liste d'actifs 24h/24,
 * enregistre les signaux en base et les envoie sur un webhook.
 *
 * Lancer : node server/server.js
 * Zéro dépendance : http, fs, node:sqlite, WebSocket et fetch sont dans la
 * bibliothèque standard de Node 22+.
 *
 * Secrets : jamais dans ce fichier ni dans config.json, uniquement en variables
 * d'environnement (ALERT_WEBHOOK, ALERT_CHAT_ID, DERIV_APP_ID).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SMC = require('../js/smc.js');
const Data = require('../js/data.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  pollSeconds: 60,
  swingLength: 5,
  watch: [{ source: 'binance', symbol: 'BTCUSDT', tf: '15m' }],
};

function loadConfig() {
  const file = process.env.SMC_CONFIG || path.join(__dirname, 'config.json');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json illisible : ${err.message}`);
    console.warn(`[config] ${file} absent, valeurs par défaut utilisées`);
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.host = process.env.HOST || cfg.host;
  cfg.port = Number(process.env.PORT || cfg.port);
  cfg.pollSeconds = Math.max(15, Number(cfg.pollSeconds) || 60);
  cfg.derivAppId = process.env.DERIV_APP_ID || Data.DERIV_DEFAULT_APP_ID;
  cfg.watch = (Array.isArray(cfg.watch) ? cfg.watch : []).filter(
    (w) => w && typeof w.symbol === 'string' && Data.TF_SECONDS[w.tf],
  );
  if (!cfg.watch.length) throw new Error('config.json : aucune ligne « watch » valide');
  return cfg;
}

// -----------------------------------------------------------------------------
// Base de données (signaux uniquement)
// -----------------------------------------------------------------------------
// ponytail: on ne stocke pas les bougies — Deriv et Binance en rendent 1000 en
// une requête, les dupliquer n'apporte rien. Ajouter une table `candles` le jour
// où il faut un historique plus long que ce que l'API accepte de rendre.
function openStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'alerts.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL,
      symbol      TEXT    NOT NULL,
      tf          TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      dir         INTEGER,
      price       REAL,
      bar_time    INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      text        TEXT    NOT NULL,
      notified    INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS alerts_unique
      ON alerts (symbol, tf, kind, bar_time, price);
    CREATE INDEX IF NOT EXISTS alerts_recent ON alerts (detected_at DESC);
  `);
  return db;
}

// -----------------------------------------------------------------------------
// Signaux : ce qui mérite une alerte
// -----------------------------------------------------------------------------
/**
 * Extrait d'une analyse les signaux notables. Fonction pure : testée, et c'est
 * la clé d'unicité (symbole, tf, kind, bar_time, price) qui évite les doublons,
 * pas un état en mémoire — le serveur peut redémarrer sans réalerter.
 */
function signalsFrom(analysis, candles) {
  if (!analysis || !analysis.ok || !candles.length) return [];
  const out = [];
  const last = candles[candles.length - 1];

  const ev = analysis.events[analysis.events.length - 1];
  if (ev) {
    const bar = candles[ev.to] || last;
    out.push({
      kind: ev.type,
      dir: ev.dir,
      price: ev.price,
      barTime: bar.time,
      text: `${ev.type} ${ev.dir === 1 ? 'haussier' : 'baissier'} à ${ev.price}`,
    });
  }

  // Judas Swing : événement de timing, celui qui vaut une notification immédiate
  const j = analysis.judas && analysis.judas[analysis.judas.length - 1];
  if (j) {
    out.push({
      kind: 'judas',
      dir: j.dir,
      price: j.sweepLevel,
      barTime: candles[j.sweepIndex] ? candles[j.sweepIndex].time : last.time,
      text:
        `Judas Swing ${j.sessionName} ${j.dir === 1 ? 'haussier' : 'baissier'} : ` +
        `liquidité prise à ${j.sweepLevel} hors de la range ${j.rangeLow} – ${j.rangeHigh}` +
        (j.status === 'displaced' ? ', déplacement confirmé' : ', retour en clôture confirmé'),
    });
  }

  // Unicorn : setup complet (balayage, cassure, FVG, breaker chevauchant), donc
  // le signal le plus actionnable de la liste.
  const u = analysis.unicorns && analysis.unicorns[analysis.unicorns.length - 1];
  if (u) {
    out.push({
      kind: 'unicorn',
      dir: u.dir,
      price: u.entry,
      barTime: candles[u.createdAt] ? candles[u.createdAt].time : last.time,
      text:
        `Unicorn ${u.dir === 1 ? 'acheteur' : 'vendeur'} : zone ${u.bottom} – ${u.top}` +
        ` · entrée ${u.entry} · stop ${u.sl} · ${u.mssType} après balayage ${u.sweepType}`,
    });
  }

  // CISD : déclencheur le plus précoce, lu sur les corps
  const x = analysis.cisd && analysis.cisd[analysis.cisd.length - 1];
  if (x) {
    out.push({
      kind: 'cisd',
      dir: x.dir,
      price: x.level,
      barTime: candles[x.index] ? candles[x.index].time : last.time,
      text:
        `CISD ${x.dir === 1 ? 'haussier' : 'baissier'} : clôture au-delà de ${x.level}` +
        ` (jambe de ${x.legLength} bougies, extrême ${x.legExtreme})`,
    });
  }

  const s = analysis.setup;
  if (s && s.zone && s.inZone) {
    out.push({
      kind: 'zone',
      dir: s.dir,
      // La zone identifie le signal : une même zone ne réalerte pas à chaque tour.
      price: s.zone.top,
      barTime: s.zone.bottom,
      text:
        `Prix dans la zone ${s.dir === 1 ? 'acheteuse' : 'vendeuse'} ` +
        `${s.zone.bottom} – ${s.zone.top} · entrée ${s.entry} · stop ${s.sl}` +
        (s.rr ? ` · R/R 1:${s.rr.toFixed(2)}` : '') +
        ` · confluences ${Math.round(s.score * 100)} %`,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Notification (webhook — fonctionne navigateur fermé)
// -----------------------------------------------------------------------------
/**
 * Corps de requête adapté au service visé. Telegram veut `chat_id` + `text`,
 * Slack lit `text`, Discord lit `content` : envoyer les deux clés couvre les
 * trois sans configuration supplémentaire.
 */
function webhookBody(url, text, chatId) {
  if (url.includes('api.telegram.org')) {
    if (!chatId) return null;
    return { chat_id: chatId, text, disable_web_page_preview: true };
  }
  return { text, content: text };
}

async function notify(alert, cfg) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return false;
  const text = `[${alert.symbol} ${alert.tf}] ${alert.text}`;
  const body = webhookBody(url, text, process.env.ALERT_CHAT_ID);
  if (!body) {
    console.error('[alerte] ALERT_CHAT_ID manquant pour Telegram');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // L'URL n'est jamais journalisée : elle contient le jeton du bot.
      console.error(`[alerte] webhook a répondu ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[alerte] envoi impossible : ${err.message}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Boucle de surveillance
// -----------------------------------------------------------------------------
const status = { startedAt: Date.now(), lastRun: null, items: {} };

async function fetchCandles(item, cfg) {
  const tf = item.tf;
  if (item.source === 'binance') {
    return Data.normalize(await Data.fetchBinance(item.symbol, tf, 1000));
  }
  if (item.source === 'demo') return Data.demoCandles(tf, 600);
  const res = await Data.fetchDeriv(item.symbol, tf, 1000, cfg.derivAppId, Data.HTF[tf]);
  return res.candles;
}

async function checkItem(item, cfg, db) {
  const key = `${item.source}:${item.symbol}:${item.tf}`;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO alerts
      (source, symbol, tf, kind, dir, price, bar_time, detected_at, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    const candles = await fetchCandles(item, cfg);
    const analysis = SMC.analyze(candles, {
      swingLength: cfg.swingLength,
      useKillzones: !(item.source === 'deriv' && Data.isDerivSynthetic(item.symbol)),
    });

    let fresh = 0;
    for (const sig of signalsFrom(analysis, candles)) {
      const r = insert.run(
        item.source, item.symbol, item.tf, sig.kind, sig.dir ?? null,
        sig.price ?? null, sig.barTime, Date.now(), sig.text,
      );
      if (r.changes === 0) continue;          // déjà vu : pas de seconde alerte
      fresh++;
      console.log(`[${key}] ${sig.text}`);
      const sent = await notify({ ...sig, symbol: item.symbol, tf: item.tf }, cfg);
      if (sent) {
        db.prepare('UPDATE alerts SET notified = 1 WHERE id = ?').run(r.lastInsertRowid);
      }
    }

    status.items[key] = {
      ok: true, at: Date.now(), candles: candles.length,
      trend: analysis.trend, fresh,
    };
  } catch (err) {
    status.items[key] = { ok: false, at: Date.now(), error: err.message };
    console.error(`[${key}] ${err.message}`);
  }
}

async function runOnce(cfg, db) {
  // En série : les API publiques n'aiment pas les rafales, et la boucle n'est
  // pas pressée. Passer en parallèle si la watchlist devient longue.
  for (const item of cfg.watch) await checkItem(item, cfg, db);
  status.lastRun = Date.now();
}

// -----------------------------------------------------------------------------
// Serveur HTTP : fichiers statiques + API de lecture
// -----------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': TYPES['.json'], 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Résout une URL vers un fichier du dépôt, ou `null` si elle en sort.
 * Sans ce contrôle, `GET /../../.ssh/id_rsa` servirait n'importe quel fichier
 * de la machine.
 */
function resolveStatic(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;                                    // pourcentage mal encodé
  }
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  // Le dossier du serveur contient la base et la configuration : hors ligne.
  if (full === __dirname || full.startsWith(__dirname + path.sep)) return null;
  return full;
}

function serveStatic(req, res) {
  const full = resolveStatic(new URL(req.url, 'http://localhost').pathname);
  if (!full) { res.writeHead(403).end('Interdit'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Introuvable'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res).on('error', () => res.destroy());
  });
}

function createServer(cfg, db) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end('Méthode non autorisée');
      return;
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/alerts') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const rows = db
        .prepare('SELECT * FROM alerts ORDER BY detected_at DESC, id DESC LIMIT ?')
        .all(limit);
      sendJson(res, 200, { alerts: rows });
      return;
    }

    // Relais Deriv : le navigateur n'a pas toujours accès au WebSocket de Deriv
    // (réseau, proxy, extension, Cloudflare). Le serveur, lui, y accède depuis
    // l'endroit où il tourne — et c'est le même code que la surveillance.
    //
    // Les paramètres viennent du réseau : ils sont validés strictement, sinon ce
    // point d'entrée deviendrait un proxy ouvert vers n'importe quel symbole.
    if (url.pathname === '/api/deriv/candles') {
      const symbol = String(url.searchParams.get('symbol') || '');
      const tf = String(url.searchParams.get('tf') || '');
      const count = Math.min(5000, Math.max(50, Number(url.searchParams.get('count')) || 1000));
      if (!/^[A-Za-z0-9_]{1,32}$/.test(symbol)) {
        sendJson(res, 400, { error: 'symbole invalide' });
        return;
      }
      if (!Data.TF_SECONDS[tf]) {
        sendJson(res, 400, { error: 'unité de temps inconnue' });
        return;
      }
      Data.fetchDeriv(symbol, tf, count, cfg.derivAppId, Data.HTF[tf])
        .then((r) => sendJson(res, 200, { candles: r.candles, htf: r.htf || null }))
        // Le message de Deriv est repris tel quel : c'est lui qui dit pourquoi.
        .catch((err) => sendJson(res, 502, { error: err.message }));
      return;
    }

    if (url.pathname === '/api/status') {
      sendJson(res, 200, {
        startedAt: status.startedAt,
        lastRun: status.lastRun,
        pollSeconds: cfg.pollSeconds,
        notifier: process.env.ALERT_WEBHOOK ? 'webhook configuré' : 'aucun webhook',
        watch: cfg.watch,
        items: status.items,
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'inconnu' }); return; }
    serveStatic(req, res);
  });
}

// -----------------------------------------------------------------------------
// Démarrage
// -----------------------------------------------------------------------------
function main() {
  const cfg = loadConfig();
  const db = openStore();
  const server = createServer(cfg, db);

  server.listen(cfg.port, cfg.host, () => {
    console.log(`SMC · ICT sur http://${cfg.host}:${cfg.port}`);
    console.log(`Surveillance : ${cfg.watch.map((w) => `${w.symbol} ${w.tf}`).join(', ')}`);
    console.log(`Cadence : ${cfg.pollSeconds} s · alertes : ${process.env.ALERT_WEBHOOK ? 'webhook actif' : 'base seulement (ALERT_WEBHOOK non défini)'}`);
  });

  runOnce(cfg, db);
  const timer = setInterval(() => runOnce(cfg, db), cfg.pollSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { loadConfig, signalsFrom, webhookBody, resolveStatic, createServer, openStore, ROOT };
