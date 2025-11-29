import express from "express";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import ffmpeg from "ffmpeg-static";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------
// VARIÁVEL GLOBAL DO QR
// ---------------------------
let currentQR = null;

// ---------------------------
// HEALTHCHECK
// ---------------------------
app.get("/", (req, res) => res.send("Bot rodando ✔️"));
app.get("/healthz", (req, res) => res.send("ok"));

// ---------------------------
// ROTA PARA MOSTRAR O QR
// ---------------------------
app.get("/qrcode", (req, res) => {
  if (!currentQR)
    return res.send("Nenhum QR disponível. Aguarde o bot gerar.");

  res.send(`
    <h1>Escaneie o QR abaixo para conectar no WhatsApp</h1>
    <img src="${currentQR}" />
  `);
});

// ---------------------------
// CONVERSÃO DE MÍDIA → FIGURINHA
// ---------------------------
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "ignore" });
    p.on("close", code => code === 0 ? resolve() : reject(code));
  });
}

async function convertToSticker(buf, ext) {
  const id = Date.now();
  const tmp = path.join(__dirname, "tmp");
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp);

  const input = path.join(tmp, `${id}.${ext}`);
  const output = path.join(tmp, `${id}.webp`);

  fs.writeFileSync(input, buf);

  const argsImg = ["-y", "-i", input, "-vf", "scale=512:512", output];
  const argsVid = [
    "-y",
    "-i", input,
    "-vf", "scale=512:512:force_original_aspect_ratio=decrease,fps=15",
    "-t", "6",
    "-c:v", "libwebp",
    "-loop", "0",
    output
  ];

  await runFFmpeg(ext === "mp4" ? argsVid : argsImg);

  const sticker = fs.readFileSync(output);

  fs.unlinkSync(input);
  fs.unlinkSync(output);

  return sticker;
}

// ---------------------------
// BOT WHATSAPP
// ---------------------------
async function startBot() {
  const auth = path.join(__dirname, "auth");
  const { state, saveCreds } = await useMultiFileAuthState(auth);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["RenderBot", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  // QR gerado
  sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("QR gerado! Acesse /qrcode");
    }

    if (connection === "open") {
      console.log("Bot conectado!");
      currentQR = null;
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("Conexão fechada:", code);
      if (shouldReconnect) startBot();
    }
  });

  // Mensagens recebidas
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const type = Object.keys(msg.message)[0];
    const text = msg.message.conversation?.toLowerCase()?.trim()
              || msg.message?.extendedTextMessage?.text?.toLowerCase()?.trim();

    // Comandos básicos
    if (text === "/ping") {
      await sock.sendMessage(from, { text: "pong 🏓" });
    }

    if (type === "imageMessage") {
      const buf = await downloadMediaMessage(msg, "buffer");
      const st = await convertToSticker(buf, "jpg");
      await sock.sendMessage(from, { sticker: st });
    }

    if (type === "videoMessage") {
      const buf = await downloadMediaMessage(msg, "buffer");
      const st = await convertToSticker(buf, "mp4");
      await sock.sendMessage(from, { sticker: st });
    }
  });
}

// ---------------------------
// INICIA SERVIDOR + BOT
// ---------------------------
app.listen(PORT, () => {
  console.log(`Servidor HTTP na porta ${PORT}`);
  startBot();
});
