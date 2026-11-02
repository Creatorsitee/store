require('dotenv').config();
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const tako = require('./tako');
const mail = require('./mailer');

const {
  PANEL_URL, PANEL_API_KEY, NEST_ID, EGG_ID,
  LOCATION_IDS = '', WEBHOOK_SECRET, DEV_AUTO_PAID, PORT = 3000,
  TAKO_API_KEY, TAKO_USERNAME, PAY_TIMEOUT_MIN = 15, POLL_SEC = 4,
  PERIOD_DAYS = 30, GRACE_DAYS = 7, AUTO_DELETE, ADMIN_TOKEN, TRUST_PROXY,
} = process.env;

// Paket tetap: pembeli hanya memilih paket, bukan node/spesifikasi detail.
const PLANS = [
  { id: 'mini',  name: 'Mini',  ram: 1024, disk: 5120,  cpu: 100, price: 10000 },
  { id: 'medium', name: 'Medium', ram: 2048, disk: 10240, cpu: 150, price: 25000 },
  { id: 'pro',   name: 'Pro',   ram: 4096, disk: 20480, cpu: 250, price: 50000 },
];

const DB = './orders.json';
const orders = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : {};
const save = () => fs.writeFileSync(DB, JSON.stringify(orders, null, 2));

async function panel(path, method = 'GET', body) {
  const res = await fetch(`${PANEL_URL}/api/application${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PANEL_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Panel ${res.status}: ${JSON.stringify(data.errors || data)}`);
  return data;
}

// Pilih node otomatis: yang punya sisa RAM+disk terbanyak dan masih muat untuk paket.
async function pickNode(plan) {
  const locs = LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const { data } = await panel('/nodes?per_page=100');
  const free = (total, over, used) => total * (1 + over / 100) - used;
  const candidates = data
    .map(n => n.attributes)
    .filter(n => !n.maintenance_mode && (!locs.length || locs.includes(n.location_id)))
    .map(n => ({
      n,
      ram: free(n.memory, n.memory_overallocate, n.allocated_resources.memory),
      disk: free(n.disk, n.disk_overallocate, n.allocated_resources.disk),
    }))
    .filter(c => c.ram >= plan.ram && c.disk >= plan.disk)
    .sort((a, b) => b.ram - a.ram);
  if (!candidates.length) throw new Error('Tidak ada node dengan kapasitas cukup');
  return candidates[0].n;
}

// Ambil allocation (IP:port) yang masih kosong di node terpilih.
async function pickAllocation(nodeId) {
  const { data } = await panel(`/nodes/${nodeId}/allocations?per_page=500`);
  const a = data.map(x => x.attributes).find(x => !x.assigned);
  if (!a) throw new Error('Allocation kosong habis di node ini, tambah port di panel');
  return a.id;
}

async function findOrCreateUser(email, username) {
  const found = await panel(`/users?filter[email]=${encodeURIComponent(email)}`);
  if (found.data.length) return { id: found.data[0].attributes.id, password: null };
  const password = crypto.randomBytes(9).toString('base64url');
  const u = await panel('/users', 'POST', {
    email, username, first_name: username, last_name: 'User', password,
  });
  return { id: u.attributes.id, password };
}

async function provision(order) {
  const plan = PLANS.find(p => p.id === order.plan);
  const node = await pickNode(plan);
  const allocation = await pickAllocation(node.id);
  const user = await findOrCreateUser(order.email, order.username);

  // Docker image, startup, dan variabel diambil otomatis dari egg.
  const egg = await panel(`/nests/${NEST_ID}/eggs/${EGG_ID}?include=variables`);
  const environment = {};
  for (const v of egg.attributes.relationships.variables.data) {
    environment[v.attributes.env_variable] = v.attributes.default_value;
  }

  const server = await panel('/servers', 'POST', {
    name: `${order.username}-${order.id.slice(0, 6)}`,
    user: user.id,
    egg: Number(EGG_ID),
    docker_image: egg.attributes.docker_image,
    startup: egg.attributes.startup,
    environment,
    limits: { memory: plan.ram, swap: 0, disk: plan.disk, io: 500, cpu: plan.cpu },
    feature_limits: { databases: 1, backups: 1, allocations: 1 },
    allocation: { default: allocation },
  });

  order.serverNumId = server.attributes.id;
  order.paidUntil = Date.now() + Number(PERIOD_DAYS) * 864e5;
  order.status = 'active';
  order.result = {
    paidUntil: order.paidUntil,
    panelUrl: PANEL_URL,
    serverId: server.attributes.identifier,
    node: node.name,
    email: order.email,
    password: user.password, // null jika akun sudah ada sebelumnya
  };
  save();
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

// Data order yang aman dikirim ke browser. Password hanya dikirim sekali.
function snapshot(o) {
  const out = {
    status: o.status, amount: o.amount, paymentUrl: o.paymentUrl,
    qrPng: o.qrPng, expiresAt: o.expiresAt, error: o.error,
  };
  if (o.result) {
    const pw = o.result.password || null;
    out.result = { ...o.result, password: pw };
    if (pw) { delete o.result.password; o.shown = true; save(); } // tidak disimpan di disk
  }
  return out;
}
function update(o, patch) {
  Object.assign(o, patch);
  save();
  bus.emit(o.id, o);
}

async function markPaid(o) {
  if (o.status !== 'awaiting_payment' && o.status !== 'pending') return; // idempotent
  update(o, { status: 'provisioning' });
  try {
    await (o.kind === 'renew' ? renew(o) : provision(o));
    bus.emit(o.id, o);
    const until = new Date(o.kind === 'renew' ? o.result.paidUntil : o.paidUntil).toLocaleDateString('id-ID');
    if (o.kind === 'renew') {
      mail.send(o.email, 'Perpanjangan berhasil', `Server Anda aktif sampai ${until}.\nKode pesanan: ${o.parent}`);
    } else {
      mail.send(o.email, 'Server Anda siap',
        `Panel: ${PANEL_URL}\nLogin dengan email: ${o.email}\nKode pesanan: ${o.id}\nAktif sampai: ${until}\n\nSimpan kode pesanan untuk cek dan perpanjangan.`);
    }
  } catch (e) {
    console.error('Provision gagal:', e.message);
    update(o, { status: 'failed', error: 'Pemrosesan gagal: ' + e.message });
  }
}

// Pantau transaksi Tako sampai lunas / gagal / kedaluwarsa.
async function watchPayment(o) {
  const plan = PLANS.find(p => p.id === o.plan);
  while (o.status === 'awaiting_payment') {
    if (Date.now() > o.expiresAt) return update(o, { status: 'expired' });
    try {
      const res = await tako.fetchTransaction(TAKO_API_KEY, o.tx);
      const d = (res.data && (res.data.result || res.data)) || {};
      const st = tako.statusOf(d);
      if (tako.SUCCESS.includes(st)) {
        const paid = Number(d.amount || d.price);
        if (Number.isFinite(paid) && paid < plan.price) {
          return update(o, { status: 'failed', error: 'Nominal pembayaran kurang dari harga paket' });
        }
        return markPaid(o);
      }
      if (tako.FAILED.includes(st)) return update(o, { status: 'expired' });
    } catch (e) {
      console.error('Cek Tako gagal:', e.message);
    }
    await tako.sleep(Number(POLL_SEC) * 1000);
  }
}

// Buat transaksi Tako, ambil QRIS, lalu mulai memantau.
async function startPayment(o) {
  const plan = PLANS.find(p => p.id === o.plan);
  try {
    const pay = await tako.createPayment(TAKO_API_KEY, {
      username: TAKO_USERNAME, amount: plan.price, name: o.username, email: o.email,
    });
    update(o, {
      status: 'awaiting_payment', tx: pay.transactionId, paymentUrl: pay.paymentUrl,
      amount: plan.price, expiresAt: Date.now() + Number(PAY_TIMEOUT_MIN) * 60000,
    });
    watchPayment(o); // mulai memantau tanpa menunggu QR selesai diekstrak
    const qris = await tako.extractQris(pay.paymentUrl);
    if (qris) {
      const qrPng = await QRCode.toDataURL(qris, { margin: 2, width: 320 });
      update(o, { qris, qrPng });
    }
  } catch (e) {
    console.error('Buat pembayaran gagal:', e.message);
    update(o, { status: 'failed', error: 'Gagal membuat pembayaran: ' + e.message });
  }
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.set('trust proxy', TRUST_PROXY === 'true');

// Ketersediaan kapasitas per paket (cache 30 dtk) agar pembeli tidak bayar untuk paket yang penuh.
let cap = { t: 0, v: {} };
async function availability() {
  if (Date.now() - cap.t < 30000) return cap.v;
  const v = {};
  for (const p of PLANS) {
    try { await pickAllocation((await pickNode(p)).id); v[p.id] = true; } catch { v[p.id] = false; }
  }
  cap = { t: Date.now(), v };
  return v;
}

// Pembatas sederhana: maks 6 pesanan/jam per IP, maks 3 pembayaran tertunda per email.
const hits = new Map();
function limited(req, email) {
  const now = Date.now();
  const a = (hits.get(req.ip) || []).filter(t => now - t < 3600e3);
  a.push(now); hits.set(req.ip, a);
  const pending = Object.values(orders).filter(x =>
    x.email.toLowerCase() === String(email).toLowerCase() &&
    ['creating_payment', 'awaiting_payment'].includes(x.status)).length;
  return a.length > 6 || pending >= 3;
}

app.get('/api/plans', async (_, res) => {
  const av = await availability().catch(() => ({}));
  res.json(PLANS.map(p => ({ ...p, available: av[p.id] !== false })));
});

app.post('/api/order', async (req, res) => {
  const { plan, email, username } = req.body || {};
  if (!PLANS.find(p => p.id === plan)) return res.status(400).json({ error: 'Paket tidak valid' });
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Email tidak valid' });
  if (!/^[a-z0-9_]{3,20}$/i.test(username || '')) {
    return res.status(400).json({ error: 'Username 3-20 karakter, huruf/angka/_' });
  }
  if (limited(req, email)) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti' });
  const av = await availability().catch(() => ({}));
  if (av[plan] === false) return res.status(409).json({ error: 'Paket ini sedang penuh, coba paket lain atau nanti' });
  const id = crypto.randomUUID();
  const o = orders[id] = { id, plan, email, username, status: 'creating_payment', createdAt: Date.now() };
  save();
  if (DEV_AUTO_PAID === 'true') { o.status = 'pending'; markPaid(o); } // hanya untuk testing
  else startPayment(o);
  res.json({ id });
});

app.get('/api/order/:id', (req, res) => {
  const o = orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Order tidak ditemukan' });
  res.json(snapshot(o));
});

// Real-time lewat Server-Sent Events: browser menerima perubahan status seketika.
app.get('/api/order/:id/events', (req, res) => {
  const o = orders[req.params.id];
  if (!o) return res.sendStatus(404);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = () => res.write(`data: ${JSON.stringify(snapshot(o))}\n\n`);
  send();
  bus.on(o.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off(o.id, send); });
});

// Opsional: webhook dari gateway lain.
app.post('/api/webhook/paid', (req, res) => {
  if (!WEBHOOK_SECRET || req.get('x-secret') !== WEBHOOK_SECRET) return res.sendStatus(401);
  const o = orders[req.body.orderId];
  if (!o) return res.sendStatus(404);
  markPaid(o);
  res.sendStatus(202);
});


// ── Perpanjangan, cek pesanan, admin, dan penangguhan otomatis ──
async function renew(o) {
  const p = orders[o.parent];
  const paidUntil = Math.max(p.paidUntil, Date.now()) + Number(PERIOD_DAYS) * 864e5;
  if (p.suspended) {
    await panel(`/servers/${p.serverNumId}/unsuspend`, 'POST');
    p.suspended = false;
  }
  p.paidUntil = paidUntil;
  p.reminded = false;
  update(o, { status: 'active', result: { renewed: true, paidUntil } });
}

function ownOrder(id, email) {
  const o = orders[String(id || '').trim()];
  const ok = o && o.kind !== 'renew' && o.serverNumId &&
    o.email.toLowerCase() === String(email || '').trim().toLowerCase();
  return ok ? o : null;
}

app.get('/api/lookup', (req, res) => {
  const o = ownOrder(req.query.orderId, req.query.email);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan. Periksa kode dan email.' });
  res.json({ plan: o.plan, status: o.status, paidUntil: o.paidUntil, suspended: !!o.suspended, periodDays: Number(PERIOD_DAYS) });
});

app.post('/api/renew', (req, res) => {
  const { orderId, email } = req.body || {};
  const p = ownOrder(orderId, email);
  if (!p || p.status !== 'active') return res.status(404).json({ error: 'Pesanan tidak ditemukan atau sudah tidak aktif' });
  if (p.paidUntil > Date.now() + 60 * 864e5) return res.status(400).json({ error: 'Masa aktif sudah lebih dari 60 hari' });
  if (limited(req, p.email)) return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi nanti' });
  const id = crypto.randomUUID();
  const o = orders[id] = { id, kind: 'renew', parent: p.id, plan: p.plan, email: p.email, username: p.username,
    status: 'creating_payment', createdAt: Date.now() };
  save();
  if (DEV_AUTO_PAID === 'true') { o.status = 'pending'; markPaid(o); } else startPayment(o);
  res.json({ id });
});

const admin = (req, res, next) =>
  ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.sendStatus(401);

app.get('/api/admin/orders', admin, (req, res) => {
  const list = Object.values(orders).sort((x, y) => y.createdAt - x.createdAt).map(o => ({
    id: o.id, kind: o.kind || 'new', parent: o.parent, email: o.email, username: o.username, plan: o.plan,
    status: o.status, paidUntil: o.paidUntil, suspended: !!o.suspended, hasServer: !!o.serverNumId,
    tx: o.tx, createdAt: o.createdAt, error: o.error,
  }));
  const paid = list.filter(o => o.status === 'active');
  const revenue = paid.reduce((n, o) => n + (PLANS.find(p => p.id === o.plan)?.price || 0), 0);
  res.json({ stats: { total: list.length, active: paid.length, revenue }, orders: list });
});

// Aksi admin: suspend, unsuspend, extend, delete, paid (paksa lunas), retry (ulang pembuatan server)
app.post('/api/admin/orders/:id/:action', admin, async (req, res) => {
  const o = orders[req.params.id];
  if (!o) return res.sendStatus(404);
  const needServer = ['suspend', 'unsuspend', 'delete', 'extend'];
  const act = req.params.action;
  if (needServer.includes(act) && !o.serverNumId) return res.status(400).json({ error: 'Pesanan ini belum punya server' });
  try {
    if (act === 'suspend') { await panel(`/servers/${o.serverNumId}/suspend`, 'POST'); update(o, { suspended: true }); }
    else if (act === 'unsuspend') { await panel(`/servers/${o.serverNumId}/unsuspend`, 'POST'); update(o, { suspended: false }); }
    else if (act === 'extend') update(o, { paidUntil: o.paidUntil + Number(req.body.days || PERIOD_DAYS) * 864e5, reminded: false });
    else if (act === 'delete') { await panel(`/servers/${o.serverNumId}`, 'DELETE'); update(o, { status: 'deleted' }); }
    else if (act === 'paid' || act === 'retry') {
      if (!['awaiting_payment', 'failed', 'expired'].includes(o.status)) return res.status(400).json({ error: 'Status tidak bisa diproses ulang' });
      update(o, { status: 'pending', error: undefined });
      await markPaid(o);
    } else return res.sendStatus(400);
    res.json({ ok: true, status: o.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lupa kode pesanan: kode dikirim ke email (jawaban selalu sama agar email tidak bisa ditebak).
app.post('/api/recover', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!mail.enabled) return res.status(501).json({ error: 'Email belum diaktifkan, hubungi admin' });
  if (!/^\S+@\S+\.\S+$/.test(email) || limited(req, email)) return res.status(429).json({ error: 'Coba lagi nanti' });
  const mine = Object.values(orders).filter(o =>
    o.kind !== 'renew' && o.serverNumId && o.status === 'active' && o.email.toLowerCase() === email);
  if (mine.length) {
    await mail.send(email, 'Kode pesanan Anda',
      mine.map(o => `Paket ${o.plan}: ${o.id} (aktif sampai ${new Date(o.paidUntil).toLocaleDateString('id-ID')})`).join('\n'));
  }
  res.json({ ok: true });
});

// Tiap 10 menit: tangguhkan server yang masa aktifnya habis. Hapus otomatis hanya jika AUTO_DELETE=true.
setInterval(async () => {
  const now = Date.now();
  for (const o of Object.values(orders)) {
    if (o.kind === 'renew' || o.status !== 'active' || !o.serverNumId) continue;
    try {
      if (!o.suspended && !o.reminded && now > o.paidUntil - 3 * 864e5) {
        update(o, { reminded: true });
        mail.send(o.email, 'Server Anda segera berakhir',
          `Masa aktif berakhir ${new Date(o.paidUntil).toLocaleDateString('id-ID')}.\nPerpanjang di halaman toko dengan kode pesanan: ${o.id}`);
      }
      if (AUTO_DELETE === 'true' && now > o.paidUntil + Number(GRACE_DAYS) * 864e5) {
        await panel(`/servers/${o.serverNumId}`, 'DELETE');
        update(o, { status: 'deleted' });
      } else if (now > o.paidUntil && !o.suspended) {
        await panel(`/servers/${o.serverNumId}/suspend`, 'POST');
        update(o, { suspended: true });
        mail.send(o.email, 'Server ditangguhkan', `Masa aktif habis. Perpanjang dengan kode pesanan: ${o.id}`);
      }
    } catch (e) { console.error('Scheduler', o.id, e.message); }
  }
}, 10 * 60 * 1000);

// Setelah restart, lanjutkan pemantauan order yang masih menunggu bayar.
for (const o of Object.values(orders)) {
  if (o.status === 'awaiting_payment' && o.tx) watchPayment(o);
  else if (o.status === 'creating_payment') update(o, { status: 'failed', error: 'Server restart saat membuat pembayaran' });
}

app.listen(PORT, () => console.log(`Store jalan di http://localhost:${PORT}`));
