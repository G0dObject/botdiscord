require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
app.post('/api/users/:id/balance', auth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: 'Укажи целое ненулевое количество монет' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) ensureUser(req.params.id, req.body.username || 'Unknown');
  db.prepare('UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?').run(amount, req.params.id);
  res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
});
app.post('/api/users/:id/items', auth, (req, res) => {
  const itemId = Number(req.body.itemId); const quantity = Number(req.body.quantity);
  if (!Number.isInteger(itemId) || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: 'Неверный предмет или количество' });
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)) return res.status(404).json({ error: 'Предмет не найден' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) ensureUser(req.params.id, req.body.username || 'Unknown');
  db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity').run(req.params.id, itemId, quantity);
  res.json({ ok: true });
});
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
  new SlashCommandBuilder().setName('inventory').setDescription('Показать инвентарь'),
  new SlashCommandBuilder().setName('capitalization').setDescription('Показать общую капитализацию сервера'),
  new SlashCommandBuilder().setName('roulette').setDescription('Сделать ставку на число').addIntegerOption(o => o.setName('bet').setDescription('Размер ставки в монетах').setMinValue(1).setRequired(true))
].map(command => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates] });
const redNumbers = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rouletteColor = number => number === 0 ? 'зеро' : redNumbers.has(number) ? 'красное' : 'чёрное';
const rouletteHistory = () => db.prepare('SELECT number, color FROM roulette_history ORDER BY id DESC LIMIT 10').all();
const historyText = () => {
  const history = rouletteHistory();
  return history.length ? `\nПоследние игры: ${history.map(game => `${game.number} ${game.color === 'красное' ? '🔴' : game.color === 'чёрное' ? '⚫' : '🟢'}`).join(' · ')}\n` : '\nПоследних игр пока нет.\n';
};
const rouletteButton = (number, ownerId, bet, page) => new ButtonBuilder()
  .setCustomId(`roulette:${ownerId}:${bet}:${page}:${number}`)
  .setLabel(String(number))
  .setStyle(number === 0 ? ButtonStyle.Success : redNumbers.has(number) ? ButtonStyle.Danger : ButtonStyle.Secondary);
const rouletteRows = (ownerId, bet, page) => {
  const start = page * 13;
  const numbers = Array.from({ length: page === 2 ? 12 : 13 }, (_, index) => start + index);
  const rows = [];
  for (let index = 0; index < numbers.length; index += 5) rows.push(new ActionRowBuilder().addComponents(numbers.slice(index, index + 5).map(n => rouletteButton(n, ownerId, bet, page))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roulette-color:${ownerId}:${bet}:red`).setLabel('🔴 Красное (2x)').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`roulette-color:${ownerId}:${bet}:black`).setLabel('⚫ Чёрное (2x)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`roulette-color:${ownerId}:${bet}:zero`).setLabel('🟢 Зеро (36x)').setStyle(ButtonStyle.Success)
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roulette-page:${ownerId}:${bet}:0`).setLabel('0–12').setStyle(page === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`roulette-page:${ownerId}:${bet}:1`).setLabel('13–24').setStyle(page === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`roulette-page:${ownerId}:${bet}:2`).setLabel('25–36').setStyle(page === 2 ? ButtonStyle.Primary : ButtonStyle.Secondary)
  ));
  return rows;
};
client.once('ready', async () => {
  console.log(`Discord: ${client.user.tag}`);
  if (process.env.CLIENT_ID && process.env.GUILD_ID) await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
});
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    if (!parts[0].startsWith('roulette')) return;
    if (parts[1] !== interaction.user.id) return interaction.reply({ content: 'Эта рулетка создана другим игроком.', ephemeral: true });
    if (parts[0] === 'roulette-page') return interaction.update({ components: rouletteRows(parts[1], Number(parts[2]), Number(parts[3])) });
    const isColorBet = parts[0] === 'roulette-color';
    const bet = Number(parts[2]); const selected = isColorBet ? parts[3] : Number(parts[4]); const player = ensureUser(interaction.user.id, interaction.user.username);
    if (player.balance < bet) return interaction.reply({ content: 'Ставка больше твоего баланса.', ephemeral: true });
    const result = Math.floor(Math.random() * 37); const resultColor = rouletteColor(result);
    const won = isColorBet ? (selected === 'red' ? resultColor === 'красное' : selected === 'black' ? resultColor === 'чёрное' : result === 0) : result === selected;
    const payout = won ? bet * (isColorBet && selected !== 'zero' ? 2 : 36) : 0;
    db.prepare('INSERT INTO roulette_history (number, color, created_at) VALUES (?, ?, ?)').run(result, resultColor, Date.now());
    db.prepare('UPDATE users SET balance = balance - ? + ? WHERE id = ?').run(bet, payout, player.id);
    if (won) addXp(player.id, 25);
    return interaction.update({ content: `${historyText()}\n🎰 Выпало **${result}** — ${resultColor}.\n${won ? `🎉 Выигрыш: **${payout.toLocaleString()} ✦**` : `Потеряно: **${bet.toLocaleString()} ✦**`}`, components: [] });
  }
  if (!interaction.isChatInputCommand()) return;
  const user = ensureUser(interaction.user.id, interaction.user.username);
  if (interaction.commandName === 'balance') return interaction.reply(`**${interaction.user.username}**\nБаланс: **${user.balance.toLocaleString()} ✦**\nУровень: **${user.level}** · XP: ${user.xp % 500}/500`);
  if (interaction.commandName === 'capitalization') {
    const coins = db.prepare('SELECT COALESCE(SUM(balance), 0) total FROM users').get().total;
    const items = db.prepare('SELECT COALESCE(SUM(inv.quantity * i.price), 0) total FROM inventory inv JOIN items i ON i.id = inv.item_id').get().total;
    return interaction.reply(`**Капитализация сервера**\nМонеты на балансах: **${coins.toLocaleString()} ✦**\nСтоимость предметов: **${items.toLocaleString()} ✦**\nИтого: **${(coins + items).toLocaleString()} ✦**`);
  }
  if (interaction.commandName === 'roulette') {
    const bet = interaction.options.getInteger('bet');
    if (user.balance < bet) return interaction.reply({ content: `Для ставки нужно ещё ${(bet - user.balance).toLocaleString()} ✦.`, ephemeral: true });
    return interaction.reply({ content: `${historyText()}\n🎰 **Рулетка**\nСтавка: **${bet.toLocaleString()} ✦**\nВыбери число или поставь на цвет. Цветная ставка выигрывает при любом числе этого цвета.`, components: rouletteRows(user.id, bet, 0) });
  }
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

client.on('messageCreate', message => {
  if (message.author.bot || !message.guild) return;
  const user = ensureUser(message.author.id, message.author.username);
  if (Date.now() - user.last_message_reward < 60000) return;
  db.prepare('UPDATE users SET balance = balance + 5, last_message_reward = ? WHERE id = ?').run(Date.now(), user.id);
  addXp(user.id, 10);
});

const rewardVoiceMembers = () => {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.filter(channel => channel.isVoiceBased()).values()) {
      for (const member of channel.members.values()) {
        if (member.user.bot || member.voice.selfDeaf && member.voice.serverDeaf) continue;
        const user = ensureUser(member.id, member.user.username);
        if (Date.now() - user.last_voice_reward < 300000) continue;
        db.prepare('UPDATE users SET balance = balance + 10, last_voice_reward = ? WHERE id = ?').run(Date.now(), member.id);
        addXp(member.id, 20);
      }
    }
  }
};
client.once('ready', () => setInterval(rewardVoiceMembers, 60000));

app.listen(port, () => console.log(`Admin panel: http://localhost:${port}`));
if (process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN).catch(error => console.error('Discord login failed:', error.message));
