const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const databaseName = 'guildforge';
let client;
let database;
let connection;

const defaultItems = [
  ['Эликсир удачи', 'Увеличивает награду за daily на 25%.', 750, '✦', 25],
  ['Кристалл опыта', 'Одноразовый буст для быстрого роста уровня.', 1200, '◇', 40],
  ['Талисман стрика', 'Защищает серию активности от одного пропуска.', 2400, '◎', 10],
  ['Золотой ящик', 'Редкий предмет с сюрпризом внутри.', 5000, '▣', 5]
];

async function connectDb() {
  if (database) return database;
  if (!uri) throw new Error('MONGODB_URI is required. Add it to your environment before starting Guildforge.');
  if (connection) return connection;
  connection = (async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    database = client.db(databaseName);
    await Promise.all([
      database.collection('inventory').createIndex({ user_id: 1, item_id: 1 }, { unique: true }),
      database.collection('game_stats').createIndex({ user_id: 1, game: 1 }, { unique: true }),
      database.collection('achievements').createIndex({ user_id: 1, code: 1 }, { unique: true }),
      database.collection('promo_claims').createIndex({ code: 1, user_id: 1 }, { unique: true })
    ]);
    if (!await database.collection('items').countDocuments()) {
      await database.collection('items').insertMany(defaultItems.map(([name, description, price, icon, stock], index) => ({ _id: index + 1, id: index + 1, name, description, price, icon, stock, active: 1 })));
      await database.collection('counters').updateOne({ _id: 'items' }, { $max: { value: defaultItems.length } }, { upsert: true });
    }
    return database;
  })();
  try {
    return await connection;
  } catch (error) {
    connection = null;
    database = null;
    if (client) await client.close().catch(() => {});
    client = null;
    throw error;
  }
}

function db() {
  if (!database) throw new Error('Database is not connected. Call connectDb() before using repositories.');
  return database;
}

async function nextId(collection) {
  const result = await db().collection('counters').findOneAndUpdate(
    { _id: collection },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after', includeResultMetadata: false }
  );
  return result.value;
}

async function ensureUser(id, username = 'Unknown') {
  const now = Date.now();
  await db().collection('users').updateOne(
    { _id: id },
    { $set: { username }, $setOnInsert: { id, balance: 0, xp: 0, level: 1, last_daily: 0, created_at: now, last_message_reward: 0, last_voice_reward: 0, daily_streak: 0, last_reputation: 0, last_weekly: 0 } },
    { upsert: true }
  );
  return db().collection('users').findOne({ _id: id });
}

async function addXp(userId, amount) {
  const user = await db().collection('users').findOne({ _id: userId });
  if (!user) return null;
  const xp = user.xp + amount;
  const level = Math.max(1, Math.floor(xp / 500) + 1);
  await db().collection('users').updateOne({ _id: userId }, { $set: { xp, level } });
  return { xp, level, levelUp: level > user.level };
}

async function logAudit(action, userId = null, amount = null, details = '') {
  const id = await nextId('audit_log');
  await db().collection('audit_log').insertOne({ _id: id, id, action, user_id: userId, amount, details, created_at: Date.now() });
}

async function recordGame(userId, game, wagered, payout) {
  await db().collection('game_stats').updateOne({ user_id: userId, game }, { $inc: { played: 1, wagered, payout }, $setOnInsert: { _id: `${userId}:${game}`, user_id: userId, game } }, { upsert: true });
}

async function unlockAchievement(userId, code) {
  try {
    await db().collection('achievements').insertOne({ _id: `${userId}:${code}`, user_id: userId, code, unlocked_at: Date.now() });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

const collection = name => ({
  findOne: (filter, options) => db().collection(name).findOne(filter, options),
  find: (filter = {}, options = {}) => db().collection(name).find(filter, options).toArray(),
  insertOne: async document => {
    if (['items', 'roulette_history', 'audit_log', 'auctions'].includes(name) && document.id == null) document.id = await nextId(name);
    if (document._id == null) document._id = document.id;
    return db().collection(name).insertOne(document);
  },
  updateOne: (filter, update, options) => db().collection(name).updateOne(filter, update, options),
  deleteOne: filter => db().collection(name).deleteOne(filter),
  aggregate: pipeline => db().collection(name).aggregate(pipeline).toArray()
});

const collections = new Proxy({}, { get: (_, name) => collection(name) });
module.exports = { connectDb, collections, ensureUser, addXp, logAudit, recordGame, unlockAchievement };
