import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH || './casino.db';
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, '');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// --- Schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  blackjacks INTEGER NOT NULL DEFAULT 0,
  net_profit INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  meta TEXT
);
`);

export const STARTING_BALANCE = 500; // à ajuster
const DAILY_BONUS = 200;

// --- Statements ---
const getUserStmt = db.prepare('SELECT * FROM users WHERE guild_id=? AND user_id=?');
const upsertUserStmt = db.prepare(`
  INSERT INTO users (guild_id, user_id, balance) VALUES (?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO NOTHING
`);

// balance delta + net profit delta
const balanceDeltaStmt = db.prepare(
  'UPDATE users SET balance = balance + ?, net_profit = net_profit + ? WHERE guild_id=? AND user_id=?'
);

const recordTxnStmt = db.prepare(
  'INSERT INTO txns (guild_id, user_id, ts, type, amount, meta) VALUES (?, ?, ?, ?, ?, ?)'
);

const incStatsStmt = db.prepare(`
  UPDATE users
  SET games_played = games_played + 1,
      wins = wins + ?,
      losses = losses + ?,
      pushes = pushes + ?,
      blackjacks = blackjacks + ?
  WHERE guild_id=? AND user_id=?
`);

const setDailyStmt = db.prepare('UPDATE users SET last_daily=? WHERE guild_id=? AND user_id=?');

// set absolute balance + net profit diff
const setBalanceAbsStmt = db.prepare(`
  UPDATE users
  SET balance = ?, net_profit = net_profit + ?
  WHERE guild_id = ? AND user_id = ?
`);

const resetStatsStmt = db.prepare(`
  UPDATE users
  SET games_played = 0,
      wins = 0,
      losses = 0,
      pushes = 0,
      blackjacks = 0,
      net_profit = 0
  WHERE guild_id=? AND user_id=?
`);

// --- Core helpers ---
export function ensureUser(guildId, userId) {
  upsertUserStmt.run(guildId, userId, 0);
  const u = getUserStmt.get(guildId, userId);
  return (
    u || {
      guild_id: guildId,
      user_id: userId,
      balance: 0,
      games_played: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      blackjacks: 0,
      net_profit: 0,
      last_daily: null,
    }
  );
}

export function getUser(guildId, userId) {
  return getUserStmt.get(guildId, userId);
}

export function grantStartingIfNeeded(guildId, userId) {
  const u = ensureUser(guildId, userId);
  if ((u.balance || 0) <= 0 && (u.games_played || 0) === 0) {
    balanceDeltaStmt.run(STARTING_BALANCE, 0, guildId, userId);
    recordTxnStmt.run(guildId, userId, Date.now(), 'faucet', STARTING_BALANCE, 'starting');
  }
  return getUser(guildId, userId);
}

export function faucet(guildId, userId) {
  ensureUser(guildId, userId);
  balanceDeltaStmt.run(STARTING_BALANCE, 0, guildId, userId);
  recordTxnStmt.run(guildId, userId, Date.now(), 'faucet', STARTING_BALANCE, 'manual');
  return getUser(guildId, userId);
}

export function claimDaily(guildId, userId) {
  const u = ensureUser(guildId, userId);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  if (u.last_daily && now - u.last_daily < DAY) {
    const next = u.last_daily + DAY;
    const remainingMs = next - now;
    return { ok: false, remainingMs };
  }

  balanceDeltaStmt.run(DAILY_BONUS, 0, guildId, userId);
  setDailyStmt.run(now, guildId, userId);
  recordTxnStmt.run(guildId, userId, now, 'system', DAILY_BONUS, 'daily');
  return { ok: true, user: getUser(guildId, userId) };
}

export function canAfford(guildId, userId, amount) {
  const u = ensureUser(guildId, userId);
  return (u.balance || 0) >= (amount || 0);
}

export function applyGameResult(guildId, userId, { bet, delta, result, blackjack = false }) {
  // delta = variation solde (peut être négative)
  const win = result === 'win' ? 1 : 0;
  const loss = result === 'loss' ? 1 : 0;
  const push = result === 'push' ? 1 : 0;

  const trx = db.transaction(() => {
    balanceDeltaStmt.run(delta, delta, guildId, userId);
    incStatsStmt.run(win, loss, push, blackjack ? 1 : 0, guildId, userId);
    recordTxnStmt.run(guildId, userId, Date.now(), result, delta, JSON.stringify({ bet, blackjack }));
  });
  trx();

  return getUser(guildId, userId);
}

export function getStats(guildId, userId) {
  const u = ensureUser(guildId, userId);
  const games = u.games_played || 0;
  const wr = games ? u.wins / games : 0;
  return { ...u, winrate: wr };
}

export function topLeaderboard(guildId, metric = 'balance', limit = 10) {
  const allowed = new Set(['balance', 'net_profit', 'wins']);

  if (metric === 'winrate') {
    return db
      .prepare(`
        SELECT user_id,
               games_played,
               wins,
               CASE WHEN games_played=0 THEN 0.0 ELSE CAST(wins AS REAL)/games_played END AS winrate
        FROM users
        WHERE guild_id=?
        ORDER BY winrate DESC, games_played DESC
        LIMIT ?
      `)
      .all(guildId, limit);
  }

  const orderCol = allowed.has(metric) ? metric : 'balance';
  return db
    .prepare(`
      SELECT user_id, ${orderCol} AS value, balance, net_profit, wins, losses, pushes, games_played
      FROM users
      WHERE guild_id=?
      ORDER BY ${orderCol} DESC
      LIMIT ?
    `)
    .all(guildId, limit);
}

/**
 * Met le solde à "newBalance".
 * Si resetStats=true, remet aussi les stats à zéro.
 * Enregistre une transaction "system" avec la différence appliquée.
 */
export function setBalance(guildId, userId, newBalance, resetStats = false, reason = 'admin_reset') {
  const before = ensureUser(guildId, userId);
  const diff = Math.trunc(newBalance) - (before.balance || 0);

  try {
    const trx = db.transaction(() => {
      if (resetStats) resetStatsStmt.run(guildId, userId);
      setBalanceAbsStmt.run(Math.trunc(newBalance), diff, guildId, userId);
      recordTxnStmt.run(
        guildId,
        userId,
        Date.now(),
        'system',
        diff,
        JSON.stringify({ reason, before: before.balance, after: Math.trunc(newBalance), resetStats })
      );
    });
    trx();
  } catch (e) {
    console.error('setBalance error:', e);
    return undefined;
  }

  return getUserStmt.get(guildId, userId);
}

// ───────────────────────────────────────────────────────────
// Casino helpers (utilisés par les courses de chevaux)
// ───────────────────────────────────────────────────────────

/**
 * Escrow: débite immédiatement la mise (et net_profit) + log txn.
 */
export function escrow(guildId, userId, amount, meta = {}) {
  const amt = Math.max(0, Math.trunc(amount || 0));
  ensureUser(guildId, userId);
  const u = getUser(guildId, userId);
  if (!u || (u.balance || 0) < amt) return { ok: false, message: 'Solde insuffisant' };

  const trx = db.transaction(() => {
    balanceDeltaStmt.run(-amt, -amt, guildId, userId);
    recordTxnStmt.run(guildId, userId, Date.now(), 'escrow', -amt, JSON.stringify(meta || {}));
  });
  trx();

  return { ok: true, user: getUser(guildId, userId) };
}

/**
 * Crédit d'un gain: +balance +net_profit, txn win.
 */
export function creditWin(guildId, userId, amount, meta = {}) {
  const amt = Math.max(0, Math.trunc(amount || 0));
  if (amt === 0) return ensureUser(guildId, userId);

  ensureUser(guildId, userId);
  const trx = db.transaction(() => {
    balanceDeltaStmt.run(amt, amt, guildId, userId);
    recordTxnStmt.run(guildId, userId, Date.now(), 'win', amt, JSON.stringify(meta || {}));
  });
  trx();
  return getUser(guildId, userId);
}

/**
 * Remboursement: +balance, net_profit inchangé, txn system.
 */
export function refund(guildId, userId, amount, meta = {}) {
  const amt = Math.max(0, Math.trunc(amount || 0));
  if (amt === 0) return ensureUser(guildId, userId);

  ensureUser(guildId, userId);
  const trx = db.transaction(() => {
    balanceDeltaStmt.run(amt, 0, guildId, userId);
    recordTxnStmt.run(guildId, userId, Date.now(), 'system', amt, JSON.stringify({ ...meta, refund: true }));
  });
  trx();
  return getUser(guildId, userId);
}

/**
 * Débit direct (utilisé si tu veux retirer des fonds hors updateBalance).
 * Met le solde à max(0, balance-amt) et trace une txn.
 */
export function debitLoss(guildId, userId, amount, meta = {}) {
  const amt = Math.max(0, Math.trunc(amount || 0));
  if (amt === 0) return ensureUser(guildId, userId);

  const u = ensureUser(guildId, userId);
  const newBalance = Math.max(0, (u.balance || 0) - amt);

  setBalance(guildId, userId, newBalance, false, 'debit');

  const type = meta?.kind || 'bet';
  recordTxnStmt.run(guildId, userId, Date.now(), type, -amt, JSON.stringify(meta || {}));

  return getUser(guildId, userId);
}
