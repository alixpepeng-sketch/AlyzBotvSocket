import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default {
  botName: 'ALYZ BOT',
  prefix: '.',

  // Nomor owner tambahan (format 62xx). Nomor yang dipairing otomatis jadi owner.
  owners: ['6281234567890'],

  // Ganti dengan link gambar catbox.moe milikmu
  catboxMenuImg: 'https://files.catbox.moe/ganti-gambar.jpg',

  // Ganti dengan link saluran WhatsApp milikmu
  channelLink: 'https://whatsapp.com/channel/ganti-link-saluran',

  port: Number(process.env.PORT) || 3000,

  // Kunci koneksi ALYZ PANEL -> ALYZ BOT. Harus sama dengan BOT_KEY di alyz-panel/.env
  panelKey: process.env.PANEL_KEY || '2cd00b094b1a3db6e33014605a269752e17cb90bc10ab58c',

  // Anti spam: maksimal 'max' perintah per 'windowMs', lalu diblokir 'banMs'
  rateLimit: { max: 5, windowMs: 10000, banMs: 15000 },

  sessionsPath: path.join(dir, 'sessions')
}
