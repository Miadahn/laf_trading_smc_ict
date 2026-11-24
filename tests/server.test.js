// Lancer : node --test tests/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Srv = require('../server/server.js');
const SMC = require('../js/smc.js');
const Data = require('../js/data.js');

test('signaux : cassure de structure et entrée en zone', () => {
  const candles = Data.demoCandles('15m', 600);
  const analysis = SMC.analyze(candles, { swingLength: 5 });
  const sigs = Srv.signalsFrom(analysis, candles);

  assert.ok(sigs.length >= 1, 'au moins la dernière cassure');
  for (const s of sigs) {
    assert.ok(['BOS', 'CHoCH', 'zone', 'judas', 'unicorn', 'cisd'].includes(s.kind), s.kind);
    assert.ok(Number.isFinite(s.barTime), 'bar_time requis pour la clé d’unicité');
    assert.ok(s.text.length > 0);
  }
  // analyse vide ou sans bougies : aucun signal, pas d'exception
  assert.deepEqual(Srv.signalsFrom(null, candles), []);
  assert.deepEqual(Srv.signalsFrom({ ok: false }, candles), []);
  assert.deepEqual(Srv.signalsFrom(analysis, []), []);
});

test('base : un même signal n’est inséré qu’une fois', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-test-'));
  try {
    // openStore() écrit dans server/data ; on teste l'unicité sur une base jetable
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 't.db'));
    db.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, symbol TEXT, tf TEXT,
        kind TEXT, dir INTEGER, price REAL, bar_time INTEGER, detected_at INTEGER,
        text TEXT, notified INTEGER DEFAULT 0);
      CREATE UNIQUE INDEX alerts_unique ON alerts (symbol, tf, kind, bar_time, price);
    `);
    const ins = db.prepare(`INSERT OR IGNORE INTO alerts
      (source, symbol, tf, kind, dir, price, bar_time, detected_at, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const row = ['deriv', 'R_75', '15m', 'BOS', 1, 100.5, 1700000000, Date.now(), 'BOS haussier'];

    assert.equal(ins.run(...row).changes, 1, 'première insertion');
    assert.equal(ins.run(...row).changes, 0, 'doublon ignoré : pas de seconde alerte');

    // un prix différent sur la même bougie est un autre signal
    const other = [...row];
    other[5] = 101.5;
    assert.equal(ins.run(...other).changes, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('webhook : corps adapté au service', () => {
  // Slack lit `text`, Discord lit `content` : les deux clés couvrent les deux
  const generic = Srv.webhookBody('https://hooks.slack.com/services/xxx', 'coucou');
  assert.equal(generic.text, 'coucou');
  assert.equal(generic.content, 'coucou');

  // Telegram exige chat_id
  const tg = Srv.webhookBody('https://api.telegram.org/botABC/sendMessage', 'coucou', '42');
  assert.deepEqual(tg, { chat_id: '42', text: 'coucou', disable_web_page_preview: true });
  assert.equal(Srv.webhookBody('https://api.telegram.org/botABC/sendMessage', 'coucou'), null);
});

test('fichiers statiques : sortie du dépôt refusée', () => {
  for (const ok of ['/', '', '/index.html', '/js/app.js', '/css/style.css']) {
    assert.ok(Srv.resolveStatic(ok), `devrait être servi : ${ok}`);
  }
  // Traversée de chemin, octet nul, encodage invalide, et le dossier du serveur
  // (il contient config.json et la base) : tout doit être refusé.
  for (const bad of [
    '/../package.json', '/../../etc/passwd', '/..%2f..%2fetc%2fpasswd',
    '/%00', '/%zz', '/server/config.json', '/server/data/alerts.db', '/server/server.js',
  ]) {
    assert.equal(Srv.resolveStatic(bad), null, `devrait être refusé : ${bad}`);
  }
  // le chemin servi reste bien dans le dépôt
  assert.ok(Srv.resolveStatic('/index.html').startsWith(Srv.ROOT + path.sep));
});

test('config : lignes de surveillance invalides écartées', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-cfg-'));
  const file = path.join(dir, 'c.json');
  const prev = process.env.SMC_CONFIG;
  try {
    fs.writeFileSync(file, JSON.stringify({
      pollSeconds: 1,                               // sous le plancher de 15 s
      watch: [
        { source: 'deriv', symbol: 'R_75', tf: '15m' },
        { source: 'deriv', symbol: 'R_75', tf: '3m' },   // unité inconnue
        { source: 'deriv', tf: '15m' },                   // sans symbole
        null,
      ],
    }));
    process.env.SMC_CONFIG = file;
    const cfg = Srv.loadConfig();
    assert.equal(cfg.watch.length, 1);
    assert.equal(cfg.watch[0].symbol, 'R_75');
    assert.equal(cfg.pollSeconds, 15, 'cadence plancher appliquée');
    assert.equal(cfg.host, '127.0.0.1', 'écoute locale par défaut');

    // aucune ligne valide : démarrage refusé plutôt que surveillance vide
    fs.writeFileSync(file, JSON.stringify({ watch: [] }));
    assert.throws(() => Srv.loadConfig(), /watch/);
  } finally {
    if (prev === undefined) delete process.env.SMC_CONFIG; else process.env.SMC_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relais Deriv : les paramètres venus du réseau sont validés', async () => {
  const cfg = { derivAppId: '1089', pollSeconds: 60, watch: [], host: '127.0.0.1', port: 0 };
  const db = { prepare: () => ({ all: () => [], get: () => ({}), run: () => ({}) }) };
  const server = Srv.createServer(cfg, db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (q) => {
    const res = await fetch(`${base}/api/deriv/candles?${q}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    // Un symbole doit ressembler à un symbole : pas de chemin, pas d'espace,
    // pas de vide. Sans ça, ce point d'entrée serait un proxy ouvert.
    for (const q of [
      'symbol=&tf=15m',
      'symbol=../../etc/passwd&tf=15m',
      'symbol=R_75 OR 1=1&tf=15m',
      'symbol=' + 'A'.repeat(40) + '&tf=15m',
      'tf=15m',
    ]) {
      const r = await get(q);
      assert.equal(r.status, 400, `devrait être refusé : ${q}`);
      assert.match(r.body.error, /symbole/);
    }

    // Unité de temps inconnue : refusée aussi
    for (const q of ['symbol=R_75&tf=3m', 'symbol=R_75&tf=', 'symbol=R_75']) {
      const r = await get(q);
      assert.equal(r.status, 400, `devrait être refusé : ${q}`);
      assert.match(r.body.error, /temps/);
    }

    // Écriture refusée : l'API est en lecture seule
    const post = await fetch(`${base}/api/deriv/candles?symbol=R_75&tf=15m`, { method: 'POST' });
    assert.equal(post.status, 405);

    // Un chemin voisin ne doit pas tomber dans le relais
    assert.equal((await fetch(`${base}/api/deriv/autre`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('relais Deriv : le serveur ne se relaie pas lui-même', () => {
  // Côté Node il n'y a pas de `location` : `fetchDeriv` ne doit jamais tenter
  // d'appeler le relais, sinon le serveur s'appellerait en boucle.
  assert.equal(Data.relayAvailable(), false);
  assert.equal(typeof Data.fetchDerivDirect, 'function');
  assert.equal(typeof Data.fetchDerivViaRelay, 'function');
});
