import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import pino from 'pino'
import { fileURLToPath } from 'url'
import { Server } from 'socket.io'
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, jidNormalizedUser, jidDecode, normalizeMessageContent,
  getContentType, downloadMediaMessage
} from '@whiskeysockets/baileys'
import config from './config.js'
import { registerBot, getSettings, setSettings } from './bot.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESS = config.sessionsPath
fs.mkdirSync(SESS, { recursive: true })

const logger = pino({ level: 'silent' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const socks = new Map()   // number -> socket
const online = new Set()  // number yang sudah terhubung
const stores = new Map()  // number -> data chat untuk panel

const app = express()
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 30e6 })
const nsp = io.of('/panel')

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/* ------------------------------ Sesi WhatsApp ------------------------------ */
async function startSession(number, wantCode = false) {
  const dir = path.join(SESS, number)
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  })
  socks.set(number, sock)
  bindStore(sock, number)
  registerBot(sock, number)
  sock.ev.on('creds.update', saveCreds)

  let codePromise = null
  if (wantCode && !state.creds.registered) {
    codePromise = new Promise((resolve, reject) => {
      let done = false
      const go = async () => {
        if (done) return
        done = true
        try { resolve(await sock.requestPairingCode(number)) } catch (e) { reject(e) }
      }
      sock.ev.on('connection.update', u => { if (u.qr) go() })
      setTimeout(go, 4000)
    })
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (socks.get(number) !== sock) return
    if (connection === 'open') {
      online.add(number)
      console.log(`[${number}] terhubung`)
      sock.groupFetchAllParticipating().then(g => {
        const s = getStore(number)
        Object.values(g).forEach(x => s.names.set(x.id, x.subject))
      }).catch(() => {})
      nsp.emit('online', { number, online: true })
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      online.delete(number)
      socks.delete(number)
      nsp.emit('online', { number, online: false })
      const registered = sock.authState.creds.registered
      if (code === DisconnectReason.loggedOut || (!registered && code !== DisconnectReason.restartRequired)) {
        fs.rmSync(dir, { recursive: true, force: true })
        stores.delete(number)
        return
      }
      await sleep(2000)
      startSession(number).catch(e => console.error(`[${number}]`, e.message))
    }
  })
  return codePromise
}

/* ------------------------------ Web pairing API ------------------------------ */
app.post('/api/pair', async (req, res) => {
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (!/^62\d{8,13}$/.test(number)) return res.status(400).json({ error: 'Nomor harus diawali 62 dan berisi 10-15 digit.' })
  if (online.has(number)) return res.status(409).json({ error: 'Nomor ini sudah terhubung.' })
  const old = socks.get(number)
  if (old) { socks.delete(number); try { old.end(undefined) } catch {} }
  fs.rmSync(path.join(SESS, number), { recursive: true, force: true })
  try {
    const code = await startSession(number, true)
    res.json({ code })
  } catch (e) {
    console.error('[pair]', e.message)
    res.status(500).json({ error: 'Gagal membuat kode. Coba lagi sebentar lagi.' })
  }
})
app.get('/api/status/:number', (req, res) => res.json({ connected: online.has(req.params.number.replace(/\D/g, '')) }))

/* ------------------------------ Store untuk ALYZ PANEL ------------------------------ */
const num = t => (t && typeof t === 'object' ? (t.toNumber?.() ?? Number(t.low)) : Number(t)) || 0
const getStore = n => {
  if (!stores.has(n)) stores.set(n, { chats: new Map(), msgs: new Map(), names: new Map(), status: [] })
  return stores.get(n)
}
const LABEL = { imageMessage: 'Foto', videoMessage: 'Video', audioMessage: 'Audio', stickerMessage: 'Stiker', documentMessage: 'Dokumen' }

function simple(m) {
  const c = normalizeMessageContent(m.message)
  if (!c) return null
  const type = getContentType(c)
  const text = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || ''
  if (!text && !LABEL[type]) return null
  return {
    id: m.key.id, jid: m.key.remoteJid, fromMe: !!m.key.fromMe, type,
    text: text || `[${LABEL[type]}]`,
    ts: num(m.messageTimestamp) || Math.floor(Date.now() / 1000),
    name: m.pushName || ''
  }
}

function chatView(s, jid) {
  const c = s.chats.get(jid) || { jid, last: '', ts: 0, unread: 0 }
  const name = s.names.get(jid) || c.name || (jid.endsWith('@g.us') ? 'Grup' : jidDecode(jid)?.user || jid)
  return { jid, name, last: c.last, ts: c.ts, unread: c.unread || 0 }
}

function addMsg(n, m, live) {
  const s = getStore(n)
  const x = simple(m)
  if (!x || !x.jid) return
  if (x.jid === 'status@broadcast') {
    s.status = s.status.filter(i => i.id !== x.id)
    s.status.push({ ...x, who: m.key.participant || m.key.participantAlt || '', raw: m })
    s.status = s.status.filter(i => Date.now() / 1000 - i.ts < 86400).slice(-60)
    return
  }
  if (x.jid.endsWith('@broadcast') || x.jid.endsWith('@newsletter')) return
  const list = s.msgs.get(x.jid) || []
  if (list.some(i => i.id === x.id)) return
  list.push(x)
  list.sort((a, b) => a.ts - b.ts)
  s.msgs.set(x.jid, list.slice(-150))
  const old = s.chats.get(x.jid) || {}
  const nm = !x.fromMe && !x.jid.endsWith('@g.us') && x.name ? x.name : old.name
  s.chats.set(x.jid, { jid: x.jid, name: nm, last: x.text, ts: Math.max(old.ts || 0, x.ts), unread: (old.unread || 0) + (live && !x.fromMe ? 1 : 0) })
  if (live) nsp.emit('msg', { number: n, jid: x.jid, msg: x, chat: chatView(s, x.jid) })
}

function bindStore(sock, n) {
  const s = getStore(n)
  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
    contacts.forEach(c => (c.name || c.notify) && s.names.set(c.id, c.name || c.notify))
    chats.forEach(c => s.chats.set(c.id, { jid: c.id, name: c.name, last: '', ts: num(c.conversationTimestamp), unread: c.unreadCount || 0 }))
    messages.forEach(m => addMsg(n, m, false))
  })
  sock.ev.on('contacts.upsert', cs => cs.forEach(c => (c.name || c.notify) && s.names.set(c.id, c.name || c.notify)))
  sock.ev.on('contacts.update', cs => cs.forEach(c => c.notify && !s.names.has(c.id) && s.names.set(c.id, c.notify)))
  sock.ev.on('chats.upsert', cs => cs.forEach(c => !s.chats.has(c.id) && s.chats.set(c.id, { jid: c.id, name: c.name, last: '', ts: num(c.conversationTimestamp), unread: 0 })))
  sock.ev.on('messages.upsert', ({ messages }) => messages.forEach(m => addMsg(n, m, true)))
}

/* ------------------------------ RPC dari ALYZ PANEL ------------------------------ */
nsp.use((s, next) => (s.handshake.auth?.key === config.panelKey ? next() : next(new Error('unauthorized'))))
nsp.on('connection', s => {
  s.on('rpc', async (name, number, args, cb) => {
    try { cb?.({ data: await rpc(name, number, args || {}) }) }
    catch (e) { cb?.({ error: e.message || 'Terjadi kesalahan' }) }
  })
})

async function rpc(name, n, a) {
  if (name === 'sessions') return [...socks.keys()].map(x => ({ number: x, online: online.has(x), enabled: getSettings(x).enabled }))

  if (name === 'logout') {
    const k = socks.get(n)
    socks.delete(n); online.delete(n)
    try { await k?.logout() } catch {}
    await sleep(1000)
    fs.rmSync(path.join(SESS, n), { recursive: true, force: true })
    stores.delete(n)
    return true
  }

  const sock = socks.get(n)
  if (!sock || !online.has(n)) throw new Error('Perangkat belum online')
  const s = getStore(n)
  const own = jidNormalizedUser(sock.user.id)

  switch (name) {
    case 'state': return { ...getSettings(n), name: sock.user.name || '', number: n }
    case 'toggle': setSettings(n, { enabled: !!a.on }); return true
    case 'chats': return [...s.chats.keys()].map(j => chatView(s, j)).filter(c => c.ts || c.last).sort((x, y) => y.ts - x.ts)
    case 'messages': {
      const c = s.chats.get(a.jid); if (c) c.unread = 0
      return s.msgs.get(a.jid) || []
    }
    case 'send':
      if (!a.text?.trim()) throw new Error('Pesan kosong')
      await sock.sendMessage(a.jid, { text: a.text })
      return true
    case 'statusList':
      return s.status.map(({ raw, ...r }) => ({ ...r, name: s.names.get(r.who) || r.name || jidDecode(r.who)?.user || 'Kontak' }))
    case 'statusMedia': {
      const item = s.status.find(i => i.id === a.id); if (!item) throw new Error('Status sudah kedaluwarsa')
      const buf = await downloadMediaMessage(item.raw, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
      const c = normalizeMessageContent(item.raw.message)
      return { mime: c[item.type]?.mimetype || 'application/octet-stream', data: buf.toString('base64') }
    }
    case 'statusPost': {
      const list = new Set([own])
      ;[...s.chats.keys(), ...s.names.keys()].forEach(j => !j.endsWith('@g.us') && !j.endsWith('@broadcast') && list.add(j))
      const opts = { statusJidList: [...list], backgroundColor: '#000000', font: 2 }
      let content
      if (a.data) {
        const buf = Buffer.from(a.data, 'base64')
        content = a.mime?.startsWith('video') ? { video: buf, caption: a.caption || '' } : { image: buf, caption: a.caption || '' }
      } else {
        if (!a.caption?.trim()) throw new Error('Isi teks atau pilih file')
        content = { text: a.caption, backgroundColor: '#000000', font: 2 }
      }
      await sock.sendMessage('status@broadcast', content, opts)
      return true
    }
    case 'profile': {
      const jid = a.jid || own
      let pp = null, about = null
      try { pp = await sock.profilePictureUrl(jid, 'image') } catch {}
      try {
        const r = await sock.fetchStatus(jid)
        const x = Array.isArray(r) ? r[0] : r
        const v = x?.status?.status ?? x?.status
        about = typeof v === 'string' ? v : null
      } catch {}
      return { jid, number: jidDecode(jid)?.user, name: jid === own ? sock.user.name : (s.names.get(jid) || ''), about, pp }
    }
  }
  throw new Error('Perintah tidak dikenal')
}

/* ------------------------------ Start ------------------------------ */
server.listen(config.port, async () => {
  console.log(`ALYZ BOT berjalan di http://localhost:${config.port}`)
  for (const n of fs.readdirSync(SESS)) {
    if (fs.existsSync(path.join(SESS, n, 'creds.json'))) {
      startSession(n).catch(e => console.error(`[${n}]`, e.message))
      await sleep(1500)
    }
  }
})
