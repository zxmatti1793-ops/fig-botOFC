import express from "express";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import ffmpeg from "ffmpeg-static";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

let qrGlobal = null;
let currentSock = null;
let reconnectAttempts = 0;
const RECONNECT_MAX = 10;
const BASE_RECONNECT_DELAY = 3000;

// Rotas
app.get("/", (_req, res) => res.send("✅ Bot ativo"));
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/qrcode", async (_req, res) => {
  if (!qrGlobal) return res.send("Nenhum QR gerado ainda.");
  res.send(`
    <h1>Escaneie o QR code com seu WhatsApp</h1>
    <img src="${qrGlobal}" />
  `);
});

// Util FFMPEG
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject()));
    p.on("error", reject);
  });
}

async function convertToSticker(buffer, format) {
  const id = Date.now();
  const tmpDir = path.join(__dirname, "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const input = path.join(tmpDir, `in-${id}.${format}`);
  const output = path.join(tmpDir, `st-${id}.webp`);

  fs.writeFileSync(input, buffer);

  const args =
    ["jpg", "jpeg", "png"].includes(format)
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
        ];

  await runFfmpeg(args);

  const stickerBuffer = fs.readFileSync(output);
  fs.unlinkSync(input);
  fs.unlinkSync(output);

  return stickerBuffer;
}

async function safeCloseSocket() {
  try {
    if (currentSock?.end) await currentSock.end();
    if (currentSock?.close) await currentSock.close();
  } catch {}
  currentSock = null;
}

// BOT
async function startBot() {
  if (currentSock) {
    console.log("Instância já ativa, ignorando novo start.");
    return;
  }

  const authDir = path.join(__dirname, "auth_info");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // ⚠️ AQUI ESTÁ A CORREÇÃO PRINCIPAL
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["Chrome", "Windows", "10.0"],
    version,                      // ✅ versão correta e atual
    syncFullHistory: false,
  });

  currentSock = sock;
  sock.ev.on("creds.update", saveCreds);

  // MENSAGENS
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const m = msg.message;
      const type = Object.keys(m)[0];
      const text = (m.conversation || m.extendedTextMessage?.text || "").trim();

      if (text) {
        const low = text.toLowerCase();

        if (low === "oi") {
          await sock.sendMessage(from, { text: "Oi 👋 tudo bem?" });
        } else if (low === "/ping") {
          const start = Date.now();
          const sent = await sock.sendMessage(from, { text: "pong 🏓" });
          const latency = Date.now() - start;
          await sock.sendMessage(from, { text: `⏱ Latência: ${latency}ms` }, { quoted: sent });
        }
      }

      if (type === "imageMessage") {
        const buffer = await downloadMediaMessage(msg, "buffer");
        const st = await convertToSticker(buffer, "jpg");
        await sock.sendMessage(from, { sticker: st });
      }

      if (type === "videoMessage") {
        const buffer = await downloadMediaMessage(msg, "buffer");
        const st = await convertToSticker(buffer, "mp4");
        await sock.sendMessage(from, { sticker: st });
      }
    } catch (err) {
      console.log("Erro msg:", err);
    }
  });

  // CONEXÃO
  sock.ev.on("connection.update", async (update) => {
    try {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        qrGlobal = await QRCode.toDataURL(qr);
        console.log("📱 QR gerado → acesse /qrcode");
      }

      if (connection === "open") {
        console.log("✅ Conectado!");
        qrGlobal = null;
        reconnectAttempts = 0;
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode || 0;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        console.log("🔌 Conexão fechada", { code, shouldReconnect });

        await safeCloseSocket();

        if (shouldReconnect && reconnectAttempts < RECONNECT_MAX) {
          reconnectAttempts++;
          const delay = BASE_RECONNECT_DELAY * reconnectAttempts;
          console.log(`🔄 Tentando reconectar em ${delay}ms`);
          setTimeout(startBot, delay);
        } else {
          console.log("❌ Deslogado. Delete auth_info para novo QR.");
        }
      }
    } catch (e) {
      console.log("Erro update:", e);
    }
  });

  sock.ev.on("error", (err) => console.log("Erro socket:", err));
}

app.listen(PORT, () => {
  console.log(`🌐 HTTP ON ${PORT}`);
  startBot();
});
