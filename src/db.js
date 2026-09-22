const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'guildforge.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    last_daily INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    icon TEXT NOT NULL DEFAULT '◆',
    stock INTEGER NOT NULL DEFAULT -1,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS inventory (
    user_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_id),
    FOREIGN KEY (item_id) REFERENCES items(id)
  );
`);

const count = db.prepare('SELECT COUNT(*) AS count FROM items').get().count;
if (!count) {
  const insert = db.prepare('INSERT INTO items (name, description, price, icon, stock) VALUES (?, ?, ?, ?, ?)');
  const seed = db.transaction(() => {
    insert.run('Эликсир удачи', 'Увеличивает награду за daily на 25%.', 750, '✦', 25);
    insert.run('Кристалл опыта', 'Одноразовый буст для быстрого роста уровня.', 1200, '◇', 40);
    insert.run('Талисман стрика', 'Защищает серию активности от одного пропуска.', 2400, '◎', 10);
    insert.run('Золотой ящик', 'Редкий предмет с сюрпризом внутри.', 5000, '▣', 5);
  });
  seed();
}

function ensureUser(id, username = 'Unknown') {
  db.prepare(`INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username`).run(id, username, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function addXp(userId, amount) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const xp = user.xp + amount;
  const level = Math.max(1, Math.floor(xp / 500) + 1);
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, userId);
  return { xp, level, levelUp: level > user.level };
}

module.exports = { db, ensureUser, addXp };
