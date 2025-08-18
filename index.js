import express from "express"
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { spawn } from "child_process"
import ffmpeg from "ffmpeg-static"
import QRCode from "qrcode"

// Configuração de diretórios
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Pasta persistente para auth no Render
const AUTH_DIR = process.env.AUTH_STATE_PATH || path.join("/data", "auth_info")

// Cria diretório tmp para arquivos temporários (figurinhas)
const TMP_DIR = path.join(__dirname, "tmp")
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// Express
const app = express()
const PORT = process.env.PORT || 3000
app.get("/", (_req, res) => res.send("✅ Bot ativo"))
app.get("/healthz", (_req, res) => res.send("ok"))

// Função utilitária: rodar ffmpeg
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "inherit" })
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))))
  })
}

// Converte imagem/vídeo em sticker
async function convertToSticker(buffer, format) {
  const id = Date.now()
  const input = path.join(TMP_DIR, `in-${id}.${format}`)
  const output = path.join(TMP_DIR, `st-${id}.webp`)

  fs.writeFileSync(input, buffer)

  const args =
    format === "jpg" || format === "jpeg" || format === "png"
      ? ["-y", "-i", input, "-vf", "scale=512:512", output]
      : [
          "-y",
          "-i",
          input,
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease,fps=15",
          "-t",
          "6",
          "-c:v",
          "libwebp",
          "-q:v",
          "50",
          "-loop",
          "0",
          "-an",
          "-vsync",
          "0",
          output,
        ]

  await runFfmpeg(args)
  const stickerBuffer = fs.readFileSync(output)

  try {
    fs.unlinkSync(input)
    fs.unlinkSync(output)
  } catch {}

  return stickerBuffer
}

// Inicia o bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    browser: ["RenderBot", "Chrome", "1.0"],
  })

  sock.ev.on("creds.update", saveCreds)

  // QR e conexão
  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      QRCode.toFile(path.join(TMP_DIR, "qr.png"), qr, (err) => {
        if (err) console.error("Erro ao salvar QR:", err)
        else console.log("✅ QR salvo em tmp/qr.png - abra e escaneie na 1ª vez")
      })
    }

    if (connection === "open") console.log("✅ Bot conectado!")
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log("🔌 Conexão fechada", { statusCode, shouldReconnect })
      if (shouldReconnect) startBot()
      else console.log("Deslogado. Apague a pasta auth para parear novamente.")
    }
  })

  // Mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg || !msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const m = msg.message
    const type = Object.keys(m)[0]
    const text = (m.conversation || m.extendedTextMessage?.text || "").trim()

    if (text) {
      const low = text.toLowerCase()
      if (low === "oi") await sock.sendMessage(from, { text: "Oi 👋 tudo bem?" })
      else if (low === "reset") await sock.sendMessage(from, { text: "Bot resetado com sucesso ✅" })
      else await sock.sendMessage(from, { text: `Você disse: "${text}"` })
    }

    // Imagem -> sticker
    if (type === "imageMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer")
      const sticker = await convertToSticker(buffer, "jpg")
      await sock.sendMessage(from, { sticker })
    }

    // Vídeo -> sticker
    if (type === "videoMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer")
      const sticker = await convertToSticker(buffer, "mp4")
      await sock.sendMessage(from, { sticker })
    }
  })
}

// Sobe HTTP + inicia bot
app.listen(PORT, () => {
  console.log(`🌐 HTTP na porta ${PORT}`)
  startBot().catch((e) => {
    console.error("Erro ao iniciar bot:", e)
    process.exit(1)
  })
})
