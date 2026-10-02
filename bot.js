import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import QRCode from 'qrcode'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import {
  jidDecode, normalizeMessageContent, getContentType, downloadContentFromMessage
} from '@whiskeysockets/baileys'
import config from './config.js'

/* ------------------------------ Pengaturan per sesi ------------------------------ */
const cache = new Map()
const sfile = n => path.join(config.sessionsPath, n, 'settings.json')
export function getSettings(n) {
  if (!cache.has(n)) {
    let s = { enabled: true, self: false }
    try { s = { ...s, ...JSON.parse(fs.readFileSync(sfile(n), 'utf8')) } } catch {}
    cache.set(n, s)
  }
  return cache.get(n)
}
export function setSettings(n, patch) {
  const s = { ...getSettings(n), ...patch }
  cache.set(n, s)
  try { fs.mkdirSync(path.dirname(sfile(n)), { recursive: true }); fs.writeFileSync(sfile(n), JSON.stringify(s)) } catch {}
}

/* ------------------------------ Helper ------------------------------ */
const ids = list => list.filter(Boolean).map(j => jidDecode(j)?.user).filter(Boolean)
const quotedOf = c => c?.[getContentType(c)]?.contextInfo
const bodyOf = c => c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || ''
const isAdminP = p => p.admin === 'admin' || p.admin === 'superadmin'
const matchP = (p, list) => ids([p.id, p.phoneNumber, p.lid]).some(u => list.includes(u))

async function download(node, type) {
  const stream = await downloadContentFromMessage(node, type.replace('Message', ''))
  const chunks = []
  for await (const ch of stream) chunks.push(ch)
  return Buffer.concat(chunks)
}

// Ambil media dari pesan itu sendiri atau dari pesan yang di-reply
async function getMedia(ctx, allowed) {
  const q = quotedOf(ctx.c)?.quotedMessage
  for (const src of [ctx.c, q && normalizeMessageContent(q)]) {
    if (!src) continue
    const t = getContentType(src)
    if (allowed.includes(t)) return { type: t, node: src[t], buf: await download(src[t], t) }
  }
  return null
}

const toMp3 = buf => new Promise((resolve, reject) => {
  const id = `${Date.now()}${Math.random().toString(36).slice(2)}`
  const i = path.join(os.tmpdir(), `${id}.in`), o = path.join(os.tmpdir(), `${id}.mp3`)
  fs.writeFileSync(i, buf)
  const p = spawn(ffmpegPath, ['-y', '-i', i, '-vn', '-ac', '2', '-b:a', '128k', o])
  p.on('error', reject)
  p.on('close', code => {
    try { if (code !== 0) throw new Error('Konversi audio gagal'); resolve(fs.readFileSync(o)) }
    catch (e) { reject(e) }
    finally { fs.rmSync(i, { force: true }); fs.rmSync(o, { force: true }) }
  })
})

/* ------------------------------ Daftar perintah ------------------------------ */
// owner: khusus owner | group: hanya grup | admin: pengirim harus admin | botAdmin: bot harus admin
export const commands = [
  {
    name: 'menu', desc: 'Tampilkan menu', hidden: true,
    async run({ sock, jid, m, number }) {
      const st = getSettings(number)
      const p = config.prefix
      const list = commands.filter(c => !c.hidden).map(c => `${p}${c.name.padEnd(9)} ${c.desc}`).join('\n')
      const caption = `${config.botName}\nMode: ${st.self ? 'Self' : 'Public'}\n\n${list}\n\nSaluran: ${config.channelLink}`
      try { await sock.sendMessage(jid, { image: { url: config.catboxMenuImg }, caption }, { quoted: m }) }
      catch { await sock.sendMessage(jid, { text: caption }, { quoted: m }) }
    }
  },
  {
    name: 'tiktok', desc: 'Unduh video TikTok tanpa watermark',
    async run({ sock, jid, m, text, reply }) {
      const url = text.match(/https?:\/\/\S*tiktok\.com\S*/i)?.[0]
      if (!url) return reply(`Format: ${config.prefix}tiktok <link tiktok>`)
      const j = await (await fetch('https://www.tikwm.com/api/?hd=1&url=' + encodeURIComponent(url))).json()
      if (j.code !== 0) return reply('Video tidak ditemukan atau link tidak valid.')
      const d = j.data
      const abs = u => (u?.startsWith('/') ? 'https://www.tikwm.com' + u : u)
      if (d.images?.length) {
        for (const img of d.images.slice(0, 10)) await sock.sendMessage(jid, { image: { url: abs(img) } }, { quoted: m })
        return
      }
      await sock.sendMessage(jid, { video: { url: abs(d.hdplay || d.play) }, caption: `${d.title || ''}\n@${d.author?.unique_id || ''}` }, { quoted: m })
    }
  },
  {
    name: 'selfmode', desc: 'Mode self on/off (owner)', owner: true,
    async run({ args, number, reply }) {
      const v = args[0]?.toLowerCase()
      if (!['on', 'off'].includes(v)) return reply(`Format: ${config.prefix}selfmode on / off`)
      setSettings(number, { self: v === 'on' })
      reply(`Self mode ${v === 'on' ? 'aktif, hanya owner yang bisa memakai bot.' : 'nonaktif, bot bisa dipakai semua orang.'}`)
    }
  },
  {
    name: 'toptv', desc: 'Video jadi pesan video bulat (reply video)',
    async run({ sock, jid, m, reply, ...ctx }) {
      const media = await getMedia({ ...ctx, m }, ['videoMessage'])
      if (!media) return reply('Reply atau kirim video dengan perintah ini.')
      await sock.sendMessage(jid, { video: media.buf, ptv: true }, { quoted: m })
    }
  },
  {
    name: 'toimg', desc: 'Stiker jadi gambar (reply stiker)',
    async run({ sock, jid, m, reply, ...ctx }) {
      const media = await getMedia({ ...ctx, m }, ['stickerMessage'])
      if (!media) return reply('Reply stiker dengan perintah ini.')
      const png = await sharp(media.buf).png().toBuffer()
      await sock.sendMessage(jid, { image: png, caption: 'Selesai.' }, { quoted: m })
    }
  },
  {
    name: 'kick', desc: 'Keluarkan 1 anggota (tag/reply/nomor)', group: true, admin: true, botAdmin: true,
    async run({ sock, jid, c, args, meta, reply }) {
      const ci = quotedOf(c)
      const ments = ci?.mentionedJid || []
      const nums = args.map(a => a.replace(/\D/g, '')).filter(a => a.length >= 8)
      if (ments.length > 1 || nums.length > 1) return reply('Kick hanya bisa 1 user per perintah.')
      const cand = ments[0] || ci?.participant || (nums[0] ? nums[0].replace(/^0/, '62') + '@s.whatsapp.net' : null)
      if (!cand) return reply(`Tag, reply pesan, atau ketik nomor.\nContoh: ${config.prefix}kick @user`)
      const list = ids([cand])
      const target = meta.participants.find(p => matchP(p, list))
      if (!target) return reply('User tidak ada di grup ini.')
      if (isAdminP(target)) return reply('Admin grup tidak bisa dikeluarkan.')
      await sock.groupParticipantsUpdate(jid, [target.id], 'remove')
      reply('User berhasil dikeluarkan.')
    }
  },
  {
    name: 'rvo', desc: 'Buka pesan sekali lihat (reply)',
    async run({ sock, jid, m, c, reply }) {
      const q = quotedOf(c)?.quotedMessage
      const inner = q && normalizeMessageContent(q)
      const type = inner && getContentType(inner)
      if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(type)) return reply('Reply pesan sekali lihat (foto/video/audio).')
      const buf = await download(inner[type], type)
      const key = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' }[type]
      const body = { [key]: buf }
      if (key === 'audio') body.mimetype = 'audio/mp4'
      else body.caption = inner[type].caption || ''
      await sock.sendMessage(jid, body, { quoted: m })
    }
  },
  {
    name: 'open', desc: 'Buka grup untuk semua anggota', group: true, admin: true, botAdmin: true,
    async run({ sock, jid, reply }) { await sock.groupSettingUpdate(jid, 'not_announcement'); reply('Grup dibuka. Semua anggota bisa mengirim pesan.') }
  },
  {
    name: 'close', desc: 'Tutup grup, hanya admin yang bisa chat', group: true, admin: true, botAdmin: true,
    async run({ sock, jid, reply }) { await sock.groupSettingUpdate(jid, 'announcement'); reply('Grup ditutup. Hanya admin yang bisa mengirim pesan.') }
  },
  {
    name: 'toqr', desc: 'Teks/link jadi QR code',
    async run({ sock, jid, m, c, text, reply }) {
      const q = quotedOf(c)?.quotedMessage
      const src = text || bodyOf(q && normalizeMessageContent(q))
      if (!src) return reply(`Format: ${config.prefix}toqr <teks atau link>`)
      const png = await QRCode.toBuffer(src.slice(0, 1000), { width: 512, margin: 2 })
      await sock.sendMessage(jid, { image: png, caption: 'QR code siap dipindai.' }, { quoted: m })
    }
  },
  {
    name: 'tomp3', desc: 'Video/audio jadi MP3 (reply)',
    async run({ sock, jid, m, reply, ...ctx }) {
      const media = await getMedia({ ...ctx, m }, ['videoMessage', 'audioMessage'])
      if (!media) return reply('Reply video atau audio dengan perintah ini.')
      const mp3 = await toMp3(media.buf)
      await sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: m })
    }
  },
  {
    name: 'getpp', desc: 'Ambil foto profil (reply/nomor/tag)',
    async run({ sock, jid, m, c, args, isGroup, senders, reply }) {
      const ci = quotedOf(c)
      const digits = args.join('').replace(/\D/g, '')
      let target = ci?.mentionedJid?.[0] || ci?.participant
      if (!target && digits.length >= 8) target = digits.replace(/^0/, '62') + '@s.whatsapp.net'
      if (!target && !isGroup) target = jid
      if (!target) return reply(`Reply chat, tag, atau ketik nomor.\nContoh: ${config.prefix}getpp 62812xxxx`)
      let url
      try { url = await sock.profilePictureUrl(target, 'image') } catch {}
      if (!url) return reply('Foto profil tidak tersedia atau disembunyikan.')
      await sock.sendMessage(jid, { image: { url }, caption: `Foto profil ${jidDecode(target)?.user || ''}` }, { quoted: m })
    }
  },
  {
    name: 'revoke', desc: 'Reset link undangan grup', group: true, admin: true, botAdmin: true,
    async run({ sock, jid, reply }) {
      await sock.groupRevokeInvite(jid)
      const code = await sock.groupInviteCode(jid)
      reply(`Link grup sudah direset.\nLink baru: https://chat.whatsapp.com/${code}`)
    }
  }
]

/* ------------------------------ Middleware: rate limit ------------------------------ */
const hits = new Map()
function limited(key) {
  const { max, windowMs, banMs } = config.rateLimit
  const now = Date.now()
  const h = hits.get(key) || { t: [], ban: 0 }
  hits.set(key, h)
  if (now < h.ban) return 'silent'
  h.t = h.t.filter(x => now - x < windowMs)
  h.t.push(now)
  if (h.t.length > max) { h.ban = now + banMs; h.t = []; return 'warn' }
  return false
}
setInterval(() => { const n = Date.now(); for (const [k, h] of hits) if (n > h.ban && !h.t.length) hits.delete(k) }, 60000).unref()

/* ------------------------------ Handler utama ------------------------------ */
async function handle(sock, number, m) {
  if (!m.message || m.key.remoteJid === 'status@broadcast') return
  const c = normalizeMessageContent(m.message)
  const body = bodyOf(c)
  if (!body.startsWith(config.prefix)) return
  const [raw, ...args] = body.slice(config.prefix.length).trim().split(/\s+/)
  const cmd = commands.find(x => x.name === raw?.toLowerCase())
  if (!cmd) return

  const st = getSettings(number)
  if (!st.enabled) return // dimatikan dari ALYZ PANEL

  const jid = m.key.remoteJid
  const isGroup = jid.endsWith('@g.us')
  const reply = t => sock.sendMessage(jid, { text: t }, { quoted: m })
  const senders = ids(m.key.fromMe
    ? [sock.user.id, sock.user.lid]
    : [m.key.participant, m.key.participantAlt, m.key.remoteJidAlt, isGroup ? null : jid])
  const isOwner = !!m.key.fromMe || senders.some(u => config.owners.includes(u))
  const ctx = { sock, m, c, jid, isGroup, args, text: args.join(' '), number, isOwner, senders, reply }

  // 1. Mode self: hanya owner
  if (st.self && !isOwner) return
  // 2. Cek owner
  if (cmd.owner && !isOwner) return reply('Perintah ini khusus owner.')
  // 3. Rate limit anti spam
  if (!isOwner) {
    const lim = limited(senders[0] || jid)
    if (lim === 'warn') return reply('Terlalu cepat. Tunggu beberapa detik sebelum memakai perintah lagi.')
    if (lim) return
  }
  // 4. Cek grup dan admin
  if (cmd.group && !isGroup) return reply('Perintah ini hanya bisa dipakai di grup.')
  if (cmd.admin || cmd.botAdmin) {
    const meta = await sock.groupMetadata(jid)
    ctx.meta = meta
    const me = ids([sock.user.id, sock.user.lid])
    const botP = meta.participants.find(p => matchP(p, me))
    const userP = meta.participants.find(p => matchP(p, senders))
    if (cmd.admin && !(userP && isAdminP(userP))) return reply('Perintah ini khusus admin grup.')
    if (cmd.botAdmin && !(botP && isAdminP(botP))) return reply('Jadikan bot admin grup terlebih dahulu.')
  }

  try { await cmd.run(ctx) }
  catch (e) { console.error(`[${number}] ${cmd.name}:`, e.message); reply(`Perintah gagal: ${e.message}`).catch(() => {}) }
}

export function registerBot(sock, number) {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) handle(sock, number, m).catch(e => console.error('[bot]', e.message))
  })
}
