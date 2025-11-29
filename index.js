import express from "express";
import {
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState // Reintroduzido para carregar um estado vazio
} from "@whiskeysockets/baileys";
// O pacote @adiwajshing/baileys-store FOI REMOVIDO
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import ffmpeg from "ffmpeg-static";
import QRCode from "qrcode";

// --- Configuração de Caminhos ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Variável global para o QR code
let qrGlobal = null;
// Caminho para o diretório de credenciais (usado apenas para carregar estado vazio)
const AUTH_FILE_PATH = path.join(__dirname, "auth_info_mem");


// --- Endpoint HTTP ---
app.get("/", (_req, res) => res.send("✅ Bot ativo"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Página para mostrar QR code
app.get("/qrcode", async (_req, res) => {
  if (!qrGlobal) return res.send("Nenhum QR gerado ainda. Acesse o log do servidor e espere ele aparecer, depois recarregue esta página.");
  res.send(`
    <h1>Escaneie o QR code com seu WhatsApp (Expira em 60s)</h1>
    <img src="${qrGlobal}" />
  `);
});

// --- Funções de Utilitários ---
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: "inherit" }); 
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))));
  });
}

async function convertToSticker(buffer, format) {
  const id = Date.now();
  const tmpDir = path.join(__dirname, "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const input = path.join(tmpDir, `in-${id}.${format}`);
  const output = path.join(tmpDir, `st-${id}.webp`);

  fs.writeFileSync(input, buffer);

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
        ];

  await runFfmpeg(args);
  const stickerBuffer = fs.readFileSync(output);

  try {
    fs.unlinkSync(input);
    fs.unlinkSync(output);
  } catch {}

  return stickerBuffer;
}

// --- Inicia o Bot ---
async function startBot() {
  // Use useMultiFileAuthState apenas para carregar um estado vazio/novo
  // NÃO salvaremos as credenciais, garantindo novo QR em cada reinício.
  const { state } = await useMultiFileAuthState(AUTH_FILE_PATH);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state, // Passa o estado (vazio ou carregado)
    browser: ["RenderBot", "Chrome", "1.0"],
  });
  
  // NOTE: removemos sock.ev.on("creds.update", saveCreds);
  // Isso impede que as credenciais sejam salvas no disco,
  // mantendo o bot funcional no Render Free, mas exigindo um novo QR
  // a cada reinicialização do contêiner.

  // Mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const m = msg.message;
    const type = Object.keys(m)[0];
    const text = (m.conversation || m.extendedTextMessage?.text || "").trim();

    // Comandos de texto
    if (text) {
      const low = text.toLowerCase();
      if (low === "oi") await sock.sendMessage(from, { text: "Oi 👋 tudo bem?" });
      else if (low === "reset") await sock.sendMessage(from, { text: "Bot resetado ✅" });
      else if (low === "/ping") {
        const start = Date.now();
        const sent = await sock.sendMessage(from, { text: "pong 🏓" });
        const latency = Date.now() - start;
        await sock.sendMessage(from, { text: `⏱ Latência: ${latency}ms` }, { quoted: sent });
      }
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

  // Conexão (CORRIGIDO)
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
      
      const shouldReconnect = 
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== 405; 

      console.log("🔌 Conexão fechada", { statusCode, shouldReconnect });
      
      if (shouldReconnect) {
        startBot(); 
      } else {
        // Se desconectou, a sessão em memória é inválida.
        console.log("Sessão inválida (Deslogado/405). Limpando resquícios da sessão anterior e gerando novo QR...");
        
        // Limpa a pasta de auth_info (apenas para ter certeza que não haverá resquícios)
        if (fs.existsSync(AUTH_FILE_PATH)) {
            fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
        }
        
        startBot(); 
      }
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
