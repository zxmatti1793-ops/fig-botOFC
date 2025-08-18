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

// ---------------------- Setup paths ----------------------
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000
const AUTH_DIR = process.env.AUTH_STATE_PATH || path.join(__dirname, "auth_info")
const TMP_DIR = path.join(__dirname, "tmp")

// Cria pasta tmp se não existir
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR)

// ---------------------- Healthcheck ----------------------
app.get("/", (_req, res) => res.send("✅ Bot ativo"))
app.get("/healthz", (_req, res) => res.send("ok"))

// ---------------------- Utils ----------------------
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "inherit" })
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))))
  })
}

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

  // Limpa arquivos temporários
  try {
    fs.unlinkSync(input)
    fs.unlinkSync(output)
  } catch {}

  return stickerBuffer
}

// ---------------------- Bot ----------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    browser: ["RenderBot", "Chrome", "1.0"],
  })

  sock.ev.on("creds.update", saveCreds)

  // ---------------------- QR / Conexão ----------------------
  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      QRCode.toFile("qr.png", qr, (err) => {
        if (err) console.error("Erro ao salvar QR:", err)
        else console.log("✅ QR salvo em qr.png - abra e escaneie com o WhatsApp")
      })
    }

    if (connection === "open") console.log("✅ Bot conectado!")
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log("🔌 Conexão fechada", { statusCode, shouldReconnect })
      if (shouldReconnect) startBot()
      else console.log("❌ Deslogado. Apague a pasta de auth para parear novamente.")
    }
  })

  // ---------------------- Mensagens ----------------------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg || !msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const m = msg.message
    const type = Object.keys(m)[0]
    const text = (m.conversation || m.extendedTextMessage?.text || "").trim()

    // Texto
    if (text) {
      const low = text.toLowerCase()
      if (low === "oi") await sock.sendMessage(from, { text: "Oi 👋 tudo bem?" })
      else if (low === "reset") await sock.sendMessage(from, { text: "Bot resetado com sucesso ✅" })
      else await sock.sendMessage(from, { text: `Você disse: "${text}"` })
    }

    // Imagem -> Sticker
    if (type === "imageMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer")
      const sticker = await convertToSticker(buffer, "jpg")
      await sock.sendMessage(from, { sticker })
    }

    // Vídeo -> Sticker
    if (type === "videoMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer")
      const sticker = await convertToSticker(buffer, "mp4")
      await sock.sendMessage(from, { sticker })
    }
  })
}

// ---------------------- Start ----------------------
app.listen(PORT, () => {
  console.log(`🌐 HTTP na porta ${PORT}`)
  startBot().catch((e) => {
    console.error("❌ Erro ao iniciar bot:", e)
    process.exit(1)
  })
})


