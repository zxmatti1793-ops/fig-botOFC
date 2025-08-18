import express from "express";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
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

// Variável global para o QR code
let qrGlobal = null;

// Healthchecks
app.get("/", (_req, res) => res.send("✅ Bot ativo"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Página para mostrar QR code
app.get("/qrcode", async (_req, res) => {
  if (!qrGlobal) return res.send("Nenhum QR gerado ainda. Reinicie o bot para gerar.");
  res.send(`
    <h1>Escaneie o QR code com seu WhatsApp</h1>
    <img src="${qrGlobal}" />
  `);
});

// Util: rodar ffmpeg via ffmpeg-static
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))));
  });
}

// Pega duração de um vídeo
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpeg, ["-i", filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("close", () => {
      const match = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (!match) return resolve(0);
      const [, hh, mm, ss] = match;
      const dur = parseInt(hh) * 3600 + parseInt(mm) * 60 + parseFloat(ss);
      resolve(dur);
    });
    ff.on("error", reject);
  });
}

// Converte buffer -> sticker .webp
async function convertToSticker(buffer, format) {
  const id = Date.now();
  const tmpDir = path.join(__dirname, "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const input = path.join(tmpDir, `in-${id}.${format}`);
  const output = path.join(tmpDir, `st-${id}.webp`);

  fs.writeFileSync(input, buffer);

  let duration = 0;
  if (format === "mp4") {
    duration = await getVideoDuration(input);
  }

  const maxDuration = 6;
  const finalDuration = duration > maxDuration ? maxDuration : duration;

  const args =
    format === "jpg" || format === "jpeg" || format === "png"
      ? [
          "-y",
          "-i", input,
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
          output,
        ]
      : [
          "-y",
          "-i", input,
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=20",
          "-t", `${finalDuration || maxDuration}`,
          "-c:v", "libwebp",
          "-q:v", "50",
          "-loop", "0",
          "-an",
          "-vsync", "0",
          output,
        ];

  await runFfmpeg(args);
  const stickerBuffer = fs.readFileSync(output);

  try {
    fs.unlinkSync(input);
    fs.unlinkSync(output);
  } catch {}

  return stickerBuffer;
}

// Inicia o bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info"));

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["RenderBot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  // Mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const m = msg.message;
    const type = Object.keys(m)[0];
    const text = (m.conversation || m.extendedTextMessage?.text || "").trim();

    if (text) {
      const low = text.toLowerCase();
      if (low === "oi") await sock.sendMessage(from, { text: "Oi 👋 tudo bem?" });
      else if (low === "reset") await sock.sendMessage(from, { text: "Bot resetado ✅" });
    }

    // Imagem -> sticker
    if (type === "imageMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer");
      const sticker = await convertToSticker(buffer, "jpg");
      await sock.sendMessage(from, { sticker });
    }

    // Vídeo -> sticker
    if (type === "videoMessage") {
      const buffer = await downloadMediaMessage(msg, "buffer");
      const sticker = await convertToSticker(buffer, "mp4");
      await sock.sendMessage(from, { sticker });
    }
  });

  // Conexão
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      qrGlobal = await QRCode.toDataURL(qr);
      console.log("📱 QR code gerado - acesse /qrcode para escanear");
    }

    if (connection === "open") {
      console.log("✅ Bot conectado!");
      qrGlobal = null;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Conexão fechada", { statusCode, shouldReconnect });
      if (shouldReconnect) startBot();
      else console.log("Deslogado. Escaneie o QR novamente.");
    }
  });
}

// Sobe HTTP + inicia bot
app.listen(PORT, () => {
  console.log(`🌐 HTTP na porta ${PORT}`);
  startBot().catch((e) => {
    console.error("Erro ao iniciar bot:", e);
    process.exit(1);
  });
});
