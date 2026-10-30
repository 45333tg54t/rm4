const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rm4.surge.sh').split(',');
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));

const PORT = process.env.PORT || 3000;
// v2 - MongoDB IP whitelist enabled
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ADMIN_KEY = process.env.ADMIN_KEY || 'rm4admin2026';
const MONGODB_URI = process.env.MONGODB_URI || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'ntmb972@gmail.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'RM4market';
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';

const WALLETS = {
  BTC: 'bc1pga0nwgy57jj92f0686qjuvtr0ug7lte4fsxwkja5678qcyx4tm5qlxeek4',
  ETH: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  LTC: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  XMR: '4RM4market9K2p7V5n3S8c4D6e0F2g7H5j',
  CASH: '7XXuRwCAV6KUmegrLSkzo2TGqnL9BbNZKDk7ELbfR87A',
  USDT: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  USDC: '4UBbshhXTuqpCBDoSnhvbbtz6UwE8dV1oenvS4rfrypf',
  SOL: '4UBbshhXTuqpCBDoSnhvbbtz6UwE8dV1oenvS4rfrypf'
};

const COINS = {
  LTC:  { name: 'Litecoin',  rate: 84.52,   symbol: 'Ł', confirmMin: 5  },
  BTC:  { name: 'Bitcoin',   rate: 64143.68, symbol: '₿', confirmMin: 30 },
  ETH:  { name: 'Ethereum',  rate: 1876.17, symbol: 'Ξ', confirmMin: 3  },
  XMR:  { name: 'Monero',    rate: 158.44,  symbol: 'M', confirmMin: 5  },
  CASH: { name: 'Cash',      rate: 1.0,      symbol: '$', confirmMin: 5  },
  USDT: { name: 'Tether',    rate: 1.0,      symbol: '₮', confirmMin: 5  },
  USDC: { name: 'USD Coin',  rate: 1.0,      symbol: '$', confirmMin: 5  },
  SOL:  { name: 'Solana',    rate: 145.0,    symbol: '◎', confirmMin: 5  }
};

let db = null;
let mongoError = '';
const orders = new Map();
const users = new Map();
const payments = [];
const processedTxids = new Set();

// Load data from MongoDB
async function loadFromDB() {
  if (!db) return;
  try {
    const usersCol = db.collection('users');
    const ordersCol = db.collection('orders');
    const paymentsCol = db.collection('payments');
    const txidsCol = db.collection('txids');

    const usersArr = await usersCol.find({}).toArray();
    usersArr.forEach(u => users.set(u.username, u));

    const ordersArr = await ordersCol.find({}).toArray();
    ordersArr.forEach(o => orders.set(o.id, o));

    const paymentsArr = await paymentsCol.find({}).toArray();
    paymentsArr.forEach(p => payments.push(p));

    const txidsArr = await txidsCol.find({}).toArray();
    txidsArr.forEach(t => processedTxids.add(t.txid));

    console.log('Loaded from DB: ' + users.size + ' users, ' + orders.size + ' orders, ' + payments.length + ' payments');
  } catch (e) {
    console.error('DB load error:', e.message);
  }
}

// Save helpers
async function saveUser(u) { if (db) await db.collection('users').updateOne({ username: u.username }, { $set: u }, { upsert: true }); }
async function saveOrder(o) { if (db) await db.collection('orders').updateOne({ id: o.id }, { $set: o }, { upsert: true }); }
async function savePayment(p) { if (db) await db.collection('payments').insertOne(p); }
async function saveTxid(t) { if (db) await db.collection('txids').updateOne({ txid: t }, { $set: { txid: t } }, { upsert: true }); }

function genId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// --- Register ---
app.post('/api/register', async (req, res) => {
  const { username, email, password, emailCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username y password requeridos' });
  if (username.length < 5) return res.status(400).json({ error: 'Username mínimo 5 caracteres' });
  if (password.length < 5) return res.status(400).json({ error: 'Password mínimo 5 caracteres' });
  if (REQUIRE_EMAIL_VERIFICATION) {
    if (!validEmail(email)) return res.status(400).json({ error: 'Debes usar un correo válido y existente' });
    const vc = checkCode(email, emailCode, 'register');
    if (!vc.ok) return res.status(400).json({ error: vc.reason });
  }
  if (users.has(username)) return res.status(400).json({ error: 'El usuario ya existe' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const u = { username, email: email || '', passwordHash: hash, salt, balance: 0, purchases: [], createdAt: new Date().toISOString() };
  users.set(username, u);
  await saveUser(u);
  res.json({ success: true, username, balance: 0 });
});

// --- Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = users.get(username);
  if (!u) return res.status(401).json({ error: 'Usuario no encontrado' });
  const h = crypto.scryptSync(password, u.salt, 64).toString('hex');
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.passwordHash, 'hex'))) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = crypto.randomBytes(32).toString('hex');
  res.json({ success: true, token, username: u.username, email: u.email, balance: u.balance });
});

// --- Email codes (Brevo) for verification & password reset ---
const emailCodes = new Map(); // key: purpose:email -> { code, expires }

async function sendEmail(to, subject, text) {
  if (!BREVO_API_KEY) return { ok: false, status: 0, reason: 'Falta BREVO_API_KEY' };
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
        to: [{ email: to }],
        subject: subject,
        textContent: text
      })
    });
    const d = await r.json().catch(() => ({}));
    console.log('Brevo response:', r.status, JSON.stringify(d));
    return { ok: r.status === 200 || r.status === 201, status: r.status, reason: d.message || d.code || '', messageId: d.messageId || '' };
  } catch (e) {
    console.log('Brevo error:', e.message);
    return { ok: false, status: 0, reason: e.message };
  }
}

function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

app.post('/api/request-code', async (req, res) => {
  const { email, purpose } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: 'Correo inválido' });
  const p = purpose === 'reset' ? 'reset' : 'register';
  const code = genCode();
  emailCodes.set(p + ':' + String(email).toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000 });
  const subject = p === 'reset' ? 'RM4market - Codigo para restablecer tu contrasena' : 'RM4market - Codigo de verificacion';
  const text = p === 'reset'
    ? 'Hola,\n\nTu codigo para restablecer tu contrasena es: ' + code + '\n\nValido por 10 minutos. Si no solicitaste esto, ignora este correo.'
    : 'Hola,\n\nTu codigo de verificacion de correo es: ' + code + '\n\nValido por 10 minutos. Confirma que este correo es tuyo.';
  const r = await sendEmail(email, subject, text);
  if (!r.ok) return res.status(500).json({ error: 'No se pudo enviar el correo. Intenta de nuevo.', detail: r.reason, status: r.status });
  res.json({ success: true, message: 'Codigo enviado a ' + email, messageId: r.messageId, code: code });
});

function checkCode(email, code, purpose) {
  const key = purpose + ':' + String(email || '').toLowerCase();
  const rec = emailCodes.get(key);
  if (!rec) return { ok: false, reason: 'No se solicitó código. Solicita uno nuevo.' };
  if (Date.now() > rec.expires) { emailCodes.delete(key); return { ok: false, reason: 'El código expiró. Solicita uno nuevo.' }; }
  if (rec.code !== String(code)) return { ok: false, reason: 'El código no coincide.' };
  return { ok: true };
}

app.post('/api/verify-code', (req, res) => {
  const { email, code, purpose } = req.body;
  const p = purpose === 'reset' ? 'reset' : 'register';
  const r = checkCode(email, code, p);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.json({ success: true });
});

app.post('/api/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!newPassword || newPassword.length < 5) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 5 caracteres' });
  const r = checkCode(email, code, 'reset');
  if (!r.ok) return res.status(400).json({ error: r.reason });
  const needle = String(email).toLowerCase();
  let key = null;
  for (const [k, u] of users) { if (u.email && String(u.email).toLowerCase() === needle) { key = k; break; } }
  if (!key) return res.status(404).json({ error: 'No existe ninguna cuenta con ese correo' });
  const u = users.get(key);
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt;
  u.passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
  users.set(key, u);
  await saveUser(u);
  res.json({ success: true, username: key, message: 'Contraseña actualizada' });
});

// Admin: restore accounts locally recovered (bypass email verification)
app.post('/api/admin/restore-user', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'No autorizado' });
  const { username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (users.has(username)) return res.json({ success: true, skipped: true, username });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { username, email: email || '', passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'), salt, balance: 0, purchases: [], createdAt: new Date().toISOString() };
  users.set(username, u);
  await saveUser(u);
  res.json({ success: true, username });
});

// --- Create order ---
app.post('/api/create-order', (req, res) => {
  const { amount, coin, user } = req.body;
  const a = parseFloat(amount);
  if (!isFinite(a) || a < 10 || a > 100000) return res.status(400).json({ error: 'Monto inválido (10-100000)' });
  if (!COINS[coin]) return res.status(400).json({ error: 'Moneda no soportada' });
  const c = COINS[coin];
  const cryptoAmount = a / c.rate;
  const orderId = genId();
  const order = {
    id: orderId, user: user || 'anonymous', amount: a, coin, cryptoAmount, rate: c.rate,
    address: WALLETS[coin], status: 'pending', createdAt: Date.now(), txid: null,
    bonus: a >= 100 ? Math.round(a * 0.05 * 100) / 100 : 0
  };
  orders.set(orderId, order);
  saveOrder(order);
  res.json({ orderId, address: order.address, amountCrypto: cryptoAmount, rate: c.rate, bonus: order.bonus });
});

app.get('/api/order/:id', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(o);
});

// --- Verify payment on-chain ---
async function verifyOnChain(coin, address, txid, expectedAmount) {
  try {
    if (coin === 'BTC') {
      const r = await fetch('https://api.blockcypher.com/v1/btc/main/txs/' + txid);
      if (!r.ok) return { ok: false, reason: 'TX no encontrada en Bitcoin' };
      const d = await r.json();
      const outputs = d.outputs || [];
      const match = outputs.some(o => o.addresses && o.addresses.indexOf(address) !== -1 && (o.value / 1e8) >= expectedAmount * 0.99);
      if (!match) return { ok: false, reason: 'La TX no envía fondos a tu dirección o el monto no coincide' };
      return { ok: true };
    }
    if (coin === 'ETH' || coin === 'USDT' || coin === 'USDC') {
      const r = await fetch('https://api.etherscan.io/api?module=transaction&action=gettxinfo&txhash=' + txid + '&apikey=' + ETHERSCAN_API_KEY);
      if (!r.ok) return { ok: false, reason: 'Error consultando Etherscan' };
      const d = await r.json();
      if (d.status !== '1' || !d.result) return { ok: false, reason: 'TX no encontrada o fallida en Ethereum' };
      const tx = d.result;
      if (tx.to && tx.to.toLowerCase() !== address.toLowerCase()) return { ok: false, reason: 'La TX no va a tu dirección' };
      const valueEth = parseInt(tx.value, 10) / 1e18;
      if (valueEth < expectedAmount * 0.99) return { ok: false, reason: 'Monto insuficiente' };
      return { ok: true };
    }
    if (coin === 'SOL' || coin === 'CASH') {
      const r = await fetch(SOLANA_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [txid, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }) });
      if (!r.ok) return { ok: false, reason: 'Error consultando Solana RPC' };
      const d = await r.json();
      if (!d.result) return { ok: false, reason: 'TX no encontrada en Solana' };
      if (d.result.meta && d.result.meta.err) return { ok: false, reason: 'La TX falló en la red' };
      return { ok: true };
    }
    if (coin === 'LTC') {
      const r = await fetch('https://api.blockcypher.com/v1/ltc/main/txs/' + txid + (BLOCKCYPHER_TOKEN ? '?token=' + BLOCKCYPHER_TOKEN : ''));
      if (!r.ok) return { ok: false, reason: 'TX no encontrada en Litecoin' };
      const d = await r.json();
      const outputs = d.outputs || [];
      const match = outputs.some(o => o.addresses && o.addresses.indexOf(address) !== -1 && (o.value / 1e8) >= expectedAmount * 0.99);
      if (!match) return { ok: false, reason: 'La TX no envía fondos a tu dirección o el monto no coincide' };
      return { ok: true };
    }
    if (coin === 'XMR') return { ok: true, reason: 'Verificación de Monero no implementada' };
    return { ok: false, reason: 'Moneda no soportada para verificación' };
  } catch (e) {
    return { ok: false, reason: 'Error de red: ' + e.message };
  }
}

app.post('/api/verify-payment', async (req, res) => {
  const { orderId, txid, user } = req.body;
  const o = orders.get(orderId);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  if (o.status === 'paid') return res.status(400).json({ error: 'Orden ya pagada' });
  if (!txid || txid.length < 10) return res.status(400).json({ error: 'TXID inválido' });
  for (const [id, ord] of orders) {
    if (ord.txid === txid && id !== orderId) return res.status(400).json({ error: 'Este TXID ya fue usado en otra orden' });
  }
  if (o.txid) {
    const u = users.get(o.user) || { balance: 0, purchases: [] };
    return res.json({ success: true, message: 'Pago ya verificado automáticamente', balance: u.balance, bonus: o.bonus, auto: true });
  }
  const result = await verifyOnChain(o.coin, o.address, txid, o.cryptoAmount);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  o.status = 'paid';
  o.txid = txid;
  o.paidAt = Date.now();
  orders.set(orderId, o);
  processedTxids.add(txid);
  const u = users.get(o.user) || { balance: 0, purchases: [] };
  u.balance += o.amount + (o.bonus || 0);
  if (!u.purchases.includes(o.id)) u.purchases.push(o.id);
  users.set(o.user, u);
  payments.push({ id: genId(), orderId: o.id, user: o.user, coin: o.coin, amount: o.amount, bonus: o.bonus, txid: txid, status: 'completed', date: new Date().toISOString(), method: 'manual' });
  await saveUser(u);
  await saveOrder(o);
  await savePayment(payments[payments.length - 1]);
  await saveTxid(txid);
  res.json({ success: true, message: 'Pago verificado y saldo acreditado', balance: u.balance, bonus: o.bonus });
});

// --- Auto-detection ---
async function checkPendingOrders() {
  const pending = Array.from(orders.values()).filter(o => o.status === 'pending');
  if (pending.length === 0) return;
  for (const o of pending) {
    try {
      let foundTxid = null;
      if (o.coin === 'BTC') {
        const r = await fetch('https://api.blockcypher.com/v1/btc/main/addrs/' + WALLETS.BTC + '?limit=10');
        if (r.ok) {
          const d = await r.json();
          const txs = d.txrefs || [];
          for (const tx of txs) {
            if (tx.tx_hash && !processedTxids.has(tx.tx_hash) && tx.value / 1e8 >= o.cryptoAmount * 0.99) { foundTxid = tx.tx_hash; break; }
          }
        }
      } else if (o.coin === 'ETH' || o.coin === 'USDT' || o.coin === 'USDC') {
        const r = await fetch('https://api.etherscan.io/api?module=account&action=txlist&address=' + WALLETS.ETH + '&sort=desc&apikey=' + ETHERSCAN_API_KEY);
        if (r.ok) {
          const d = await r.json();
          if (d.status === '1' && Array.isArray(d.result)) {
            for (const tx of d.result.slice(0, 10)) {
              if (tx.hash && !processedTxids.has(tx.hash) && tx.to && tx.to.toLowerCase() === WALLETS.ETH.toLowerCase()) {
                const valueEth = parseInt(tx.value, 10) / 1e18;
                if (valueEth >= o.cryptoAmount * 0.99) { foundTxid = tx.hash; break; }
              }
            }
          }
        }
      } else if (o.coin === 'SOL' || o.coin === 'CASH') {
        const r = await fetch(SOLANA_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [WALLETS.SOL, { limit: 10 }] }) });
        if (r.ok) {
          const d = await r.json();
          if (d.result && Array.isArray(d.result)) {
            for (const sig of d.result) {
              if (sig.signature && !processedTxids.has(sig.signature) && !sig.err) { foundTxid = sig.signature; break; }
            }
          }
        }
      } else if (o.coin === 'LTC') {
        const r = await fetch('https://api.blockcypher.com/v1/ltc/main/addrs/' + WALLETS.LTC + '?limit=10' + (BLOCKCYPHER_TOKEN ? '&token=' + BLOCKCYPHER_TOKEN : ''));
        if (r.ok) {
          const d = await r.json();
          const txs = d.txrefs || [];
          for (const tx of txs) {
            if (tx.tx_hash && !processedTxids.has(tx.tx_hash) && tx.value / 1e8 >= o.cryptoAmount * 0.99) { foundTxid = tx.tx_hash; break; }
          }
        }
      }
      if (foundTxid) {
        processedTxids.add(foundTxid);
        o.status = 'paid';
        o.txid = foundTxid;
        o.paidAt = Date.now();
        o.autoDetected = true;
        orders.set(o.id, o);
        const u = users.get(o.user) || { balance: 0, purchases: [] };
        u.balance += o.amount + (o.bonus || 0);
        if (!u.purchases.includes(o.id)) u.purchases.push(o.id);
        users.set(o.user, u);
        payments.push({ id: genId(), orderId: o.id, user: o.user, coin: o.coin, amount: o.amount, bonus: o.bonus, txid: foundTxid, status: 'completed', date: new Date().toISOString(), method: 'auto' });
        await saveUser(u);
        await saveOrder(o);
        await savePayment(payments[payments.length - 1]);
        await saveTxid(foundTxid);
        console.log('Auto-verified payment for order ' + o.id + ' txid: ' + foundTxid);
      }
    } catch (e) {
      console.error('Auto-check error for ' + o.coin + ':', e.message);
    }
  }
}

setInterval(checkPendingOrders, 30000);
setTimeout(checkPendingOrders, 5000);

// --- Admin: GET all payments ---
app.get('/api/pagos', (req, res) => {
  res.json({ payments: payments, total: payments.length });
});

// --- Admin: GET all users ---
app.get('/api/usuarios', (req, res) => {
  const list = Array.from(users.entries()).map(function (entry) {
    return { username: entry[0], email: entry[1].email || '', balance: entry[1].balance || 0, purchases: entry[1].purchases || [], createdAt: entry[1].createdAt };
  });
  res.json({ users: list, total: list.length });
});

// --- Admin: modify user ---
app.put('/api/usuarios/:username', (req, res) => {
  const u = users.get(req.params.username);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { balance, email, password } = req.body;
  if (typeof balance === 'number') u.balance = balance;
  if (email !== undefined) u.email = email;
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    u.passwordHash = hash;
    u.salt = salt;
  }
  users.set(req.params.username, u);
  saveUser(u);
  res.json({ success: true, user: { username: u.username, email: u.email, balance: u.balance } });
});

// --- Admin: delete user ---
app.delete('/api/usuarios/:username', (req, res) => {
  if (!users.has(req.params.username)) return res.status(404).json({ error: 'Usuario no encontrado' });
  users.delete(req.params.username);
  if (db) db.collection('users').deleteOne({ username: req.params.username });
  res.json({ success: true, message: 'Usuario eliminado' });
});

// --- Admin: reset all balances ---
app.post('/api/admin/reset-balances', (req, res) => {
  const key = req.headers['x-admin-key'] || req.body.adminKey;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Acceso denegado' });
  let count = 0;
  for (const [username, u] of users) {
    u.balance = 0;
    users.set(username, u);
    saveUser(u);
    count++;
  }
  res.json({ success: true, message: 'Saldos reseteados a 0', affected: count });
});

// --- Get balance ---
app.get('/api/balance/:user', (req, res) => {
  const u = users.get(req.params.user) || { balance: 0 };
  res.json({ balance: u.balance });
});

// --- Get user purchases ---
app.get('/api/purchases/:user', (req, res) => {
  const u = users.get(req.params.user) || { purchases: [] };
  res.json({ purchases: u.purchases });
});

// --- Auto-check endpoint (frontend polling) ---
app.get('/api/check-payments/:user', async (req, res) => {
  await checkPendingOrders();
  const u = users.get(req.params.user) || { balance: 0, purchases: [] };
  const pending = Array.from(orders.values()).filter(o => o.user === req.params.user && o.status === 'pending');
  res.json({ balance: u.balance, purchases: u.purchases, pendingCount: pending.length, pendingOrders: pending.map(o => o.id) });
});

// --- Health / diagnostics ---
app.get('/api/health', (req, res) => {
  res.json({
    mongo: !!db,
    mongoError: mongoError,
    mongodbUriSet: !!MONGODB_URI,
    users: users.size,
    orders: orders.size,
    payments: payments.length,
    uptime: process.uptime()
  });
});

// --- Connect to MongoDB (with automatic retry) ---
async function connectDB() {
  if (!MONGODB_URI) {
    console.log('No MONGODB_URI set, using in-memory storage');
    return;
  }
  let attempt = 0;
  while (!db) {
    attempt++;
    try {
      const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      db = client.db('rm4market');
      console.log('Connected to MongoDB (attempt ' + attempt + ')');
      mongoError = '';
      // Load persisted data, then merge anything registered while offline
      await loadFromDB();
      await syncInMemoryToDB();
      break;
    } catch (e) {
      mongoError = e.message;
      console.error('MongoDB connection attempt ' + attempt + ' failed: ' + e.message);
      await new Promise(function (r) { setTimeout(r, 10000); });
    }
  }
}

// After a late connect, persist users/orders created while DB was offline
async function syncInMemoryToDB() {
  if (!db) return;
  try {
    for (const u of users.values()) await saveUser(u);
    for (const o of orders.values()) await saveOrder(o);
    for (const t of processedTxids) await saveTxid(t);
    console.log('Synced in-memory data to DB: ' + users.size + ' users, ' + orders.size + ' orders');
  } catch (e) {
    console.error('DB sync error:', e.message);
  }
}

// Save helpers (MongoDB)
async function saveUser(u) { if (db) await db.collection('users').updateOne({ username: u.username }, { $set: u }, { upsert: true }); }
async function saveOrder(o) { if (db) await db.collection('orders').updateOne({ id: o.id }, { $set: o }, { upsert: true }); }
async function savePayment(p) { if (db) await db.collection('payments').insertOne(p); }
async function saveTxid(t) { if (db) await db.collection('txids').updateOne({ txid: t }, { $set: { txid: t } }, { upsert: true }); }

app.listen(PORT, () => {
  console.log('Backend running on port ' + PORT);
  setTimeout(checkPendingOrders, 5000);
  setInterval(checkPendingOrders, 30000);
  // Connect in background so the server is never blocked by Atlas cold starts
  connectDB();
});
module.exports = app;
