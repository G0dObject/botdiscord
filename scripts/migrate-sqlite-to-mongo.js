require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { MongoClient } = require('mongodb');

const sqlitePath = path.join(process.cwd(), 'data', 'guildforge.db');
const tables = ['users', 'items', 'inventory', 'roulette_history', 'game_stats', 'achievements', 'promocodes', 'promo_claims', 'audit_log', 'auctions'];

async function migrate() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required to migrate SQLite data.');
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);
  const sqlite = new Database(sqlitePath, { readonly: true });
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const database = client.db('guildforge');
    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const documents = rows.map(row => {
        if (table === 'users' || table === 'promocodes') return { ...row, _id: row.id || row.code };
        if (['inventory', 'game_stats', 'achievements', 'promo_claims'].includes(table)) return { ...row, _id: table === 'inventory' ? `${row.user_id}:${row.item_id}` : table === 'game_stats' ? `${row.user_id}:${row.game}` : `${row.user_id}:${row.code}` };
        return { ...row, _id: row.id };
      });
      await database.collection(table).bulkWrite(documents.map(document => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })));
      console.log(`${table}: ${documents.length} imported`);
    }
    for (const table of ['items', 'roulette_history', 'audit_log', 'auctions']) {
      const latest = await database.collection(table).find({}, { sort: { id: -1 }, limit: 1 }).toArray();
      if (latest.length) await database.collection('counters').updateOne({ _id: table }, { $max: { value: latest[0].id } }, { upsert: true });
    }
  } finally {
    sqlite.close();
    await client.close();
  }
}

migrate().catch(error => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
