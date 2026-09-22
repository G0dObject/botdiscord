require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { db, ensureUser, addXp } = require('./db');

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || 'local-development-secret';
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.admin = jwt.verify(token, jwtSecret); next(); } catch { res.status(401).json({ error: 'Требуется авторизация' }); }
};

app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Неверный пароль' });
  res.json({ token: jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '12h' }) });
});

app.get('/api/stats', auth, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) count FROM users').get().count;
  const balance = db.prepare('SELECT COALESCE(SUM(balance), 0) total FROM users').get().total;
  const level = db.prepare('SELECT COALESCE(AVG(level), 0) average FROM users').get().average;
  const purchases = db.prepare('SELECT COALESCE(SUM(quantity), 0) total FROM inventory').get().total;
  res.json({ users, balance, averageLevel: Number(level).toFixed(1), purchases });
});

app.get('/api/users', auth, (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY balance DESC LIMIT 100').all()));
app.get('/api/items', auth, (req, res) => res.json(db.prepare('SELECT * FROM items ORDER BY active DESC, id DESC').all()));
app.post('/api/items', auth, (req, res) => {
  const { name, description = '', price = 0, icon = '◆', stock = -1 } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const result = db.prepare('INSERT INTO items (name, description, price, icon, stock) VALUES (?, ?, ?, ?, ?)').run(name, description, Number(price), icon, Number(stock));
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid));
});
app.patch('/api/items/:id', auth, (req, res) => {
  const { name, description, price, icon, stock, active } = req.body;
  db.prepare('UPDATE items SET name = COALESCE(?, name), description = COALESCE(?, description), price = COALESCE(?, price), icon = COALESCE(?, icon), stock = COALESCE(?, stock), active = COALESCE(?, active) WHERE id = ?').run(name, description, price, icon, stock, active, req.params.id);
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id));
});
app.delete('/api/items/:id', auth, (req, res) => { db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Показать баланс и уровень'),
  new SlashCommandBuilder().setName('daily').setDescription('Получить ежедневную награду'),
  new SlashCommandBuilder().setName('shop').setDescription('Открыть магазин предметов'),
  new SlashCommandBuilder().setName('buy').setDescription('Купить предмет').addIntegerOption(o => o.setName('item_id').setDescription('ID предмета').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('Показать инвентарь')
].map(command => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  console.log(`Discord: ${client.user.tag}`);
  if (process.env.CLIENT_ID && process.env.GUILD_ID) await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
});
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const user = ensureUser(interaction.user.id, interaction.user.username);
  if (interaction.commandName === 'balance') return interaction.reply(`**${interaction.user.username}**\nБаланс: **${user.balance.toLocaleString()} ✦**\nУровень: **${user.level}** · XP: ${user.xp % 500}/500`);
  if (interaction.commandName === 'daily') {
    if (Date.now() - user.last_daily < 86400000) return interaction.reply({ content: 'Ты уже забрал daily. Возвращайся завтра.', ephemeral: true });
    const reward = 250 + user.level * 50;
    db.prepare('UPDATE users SET balance = balance + ?, last_daily = ? WHERE id = ?').run(reward, Date.now(), user.id); addXp(user.id, 50);
    return interaction.reply(`Ежедневная награда: **+${reward} ✦** и **+50 XP**. Стрик продолжается!`);
  }
  if (interaction.commandName === 'shop') {
    const items = db.prepare('SELECT * FROM items WHERE active = 1').all();
    return interaction.reply(items.map(i => `**#${i.id} ${i.icon} ${i.name}** — ${i.price.toLocaleString()} ✦${i.stock >= 0 ? ` · осталось ${i.stock}` : ''}\n${i.description}`).join('\n\n') || 'Магазин пуст.');
  }
  if (interaction.commandName === 'inventory') {
    const items = db.prepare('SELECT i.name, i.icon, inv.quantity FROM inventory inv JOIN items i ON i.id = inv.item_id WHERE inv.user_id = ? AND inv.quantity > 0').all(user.id);
    return interaction.reply(items.length ? items.map(i => `${i.icon} **${i.name}** ×${i.quantity}`).join('\n') : 'Инвентарь пуст.');
  }
  if (interaction.commandName === 'buy') {
    const id = interaction.options.getInteger('item_id'); const item = db.prepare('SELECT * FROM items WHERE id = ? AND active = 1').get(id);
    if (!item || (item.stock === 0)) return interaction.reply({ content: 'Предмет недоступен.', ephemeral: true });
    if (user.balance < item.price) return interaction.reply({ content: `Нужно ещё ${(item.price - user.balance).toLocaleString()} ✦.`, ephemeral: true });
    const buy = db.transaction(() => { db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(item.price, user.id); db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + 1').run(user.id, item.id); if (item.stock > 0) db.prepare('UPDATE items SET stock = stock - 1 WHERE id = ?').run(item.id); addXp(user.id, 15); }); buy();
    return interaction.reply(`Куплено: ${item.icon} **${item.name}** за ${item.price.toLocaleString()} ✦.`);
  }
});

app.listen(port, () => console.log(`Admin panel: http://localhost:${port}`));
if (process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN).catch(error => console.error('Discord login failed:', error.message));
