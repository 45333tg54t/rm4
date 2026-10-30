const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ADMIN_KEY = process.env.ADMIN_KEY || 'rm4admin2026';

// Persistent storage (JSON files)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

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

// Persistent stores
const orders = new Map(Object.entries(loadJSON('orders.json', {})));
const users = new Map(Object.entries(loadJSON('users.json', {})));
const payments = loadJSON('payments.json', []);
const processedTxids = new Set(loadJSON('txids.json', []));

function persist() {
  const o = {}; orders.forEach((v, k) => { o[k] = v; }); saveJSON('orders.json', o);
  const u = {}; users.forEach((v, k) => { u[k] = v; }); saveJSON('users.json', u);
  saveJSON('payments.json', payments);
  saveJSON('txids.json', Array.from(processedTxids));
}

function genId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// --- Register ---
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username y password requeridos' });
  if (username.length < 5) return res.status(400).json({ error: 'Username mínimo 5 caracteres' });
  if (password.length < 5) return res.status(400).json({ error: 'Password mínimo 5 caracteres' });
  if (users.has(username)) return res.status(400).json({ error: 'El usuario ya existe' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  users.set(username, {
    username, email: email || '', passwordHash: hash, salt,
    balance: 0, purchases: [], createdAt: new Date().toISOString()
  });
  persist();
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
  persist();
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
  persist();
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
        persist();
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
  persist();
  res.json({ success: true, user: { username: u.username, email: u.email, balance: u.balance } });
});

// --- Admin: delete user ---
app.delete('/api/usuarios/:username', (req, res) => {
  if (!users.has(req.params.username)) return res.status(404).json({ error: 'Usuario no encontrado' });
  users.delete(req.params.username);
  persist();
  res.json({ success: true, message: 'Usuario eliminado' });
});

// --- Balance & purchases ---
app.get('/api/balance/:user', (req, res) => {
  const u = users.get(req.params.user) || { balance: 0 };
  res.json({ balance: u.balance });
});

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

app.listen(PORT, () => {
  console.log('Backend running on port ' + PORT);
  setTimeout(checkPendingOrders, 5000);
  setInterval(checkPendingOrders, 30000);
});
module.exports = app;
