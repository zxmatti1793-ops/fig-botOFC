import express from "express";
import {
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage
  // Removido useMultiFileAuthState
} from "@whiskeysockets/baileys";
// Importação para gerenciar estado em memória (necessário para o Render Free)
import { makeInMemoryStore } from "@adiwajshing/baileys-store"; 
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

// Util: rodar ffmpeg via ffmpeg-static
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    // Usamos 'inherit' para ver a saída do ffmpeg no log, útil para debug
    const p = spawn(ffmpeg, args, { stdio: "inherit" }); 
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))));
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

  // Argumentos do ffmpeg para imagem e vídeo
  const args =
    format === "jpg" || format === "jpeg" || format === "png"
      ? ["-y", "-i", input, "-vf", "scale=512:512", output] // Imagem estática
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
          output, // Vídeo animado (até 6s)
        ];

  await runFfmpeg(args);
  const stickerBuffer = fs.readFileSync(output);

  // Limpa arquivos temporários
  try {
    fs.unlinkSync(input);
    fs.unlinkSync(output);
  } catch {}

  return stickerBuffer;
}

// --- Inicia o Bot ---
async function startBot() {
  // 1. Cria um store em memória - O estado da sessão será mantido SOMENTE enquanto o processo estiver ativo
  const store = makeInMemoryStore({});

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: store.state, // Passa o estado da memória
    browser: ["RenderBot", "Chrome", "1.0"],
    // Adicionado tratamento de reconexão automática.
    // Em ambientes instáveis, a conexão fecha e reabre com frequência.
    // O Baileys tenta reconectar usando as credenciais que estão na memória.
    shouldIgnoreJid: (jid) => jid === "status@broadcast", // Ignorar status do WhatsApp
  });
  
  // 2. Liga o store ao socket para que o Baileys gerencie os dados do chat na memória
  store.bind(sock.ev);

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
      qrGlobal = await QRCode.toDataURL(qr); // converte QR para imagem base64
      console.log("📱 QR code gerado - acesse /qrcode para escanear");
    }

    if (connection === "open") {
      console.log("✅ Bot conectado!");
      qrGlobal = null; // QR não é mais necessário
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      
      // Apenas tenta reconectar se não foi um logout explícito ou um erro irrecuperável (como o 405)
      const shouldReconnect = 
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== 405; 

      console.log("🔌 Conexão fechada", { statusCode, shouldReconnect });
      
      if (shouldReconnect) {
        // Tenta reconectar (o Baileys fará isso automaticamente na maioria dos casos)
        startBot(); 
      } else {
        // Se desconectou (loggedOut ou 405), a sessão em memória é inválida.
        // Chamamos startBot para gerar um novo Memory Store e forçar um novo QR.
        console.log("Sessão inválida (Deslogado/405). Gerando novo QR...");
        startBot(); 
      }
    }
  });
}

// Sobe HTTP + inicia bot
app.listen(PORT, () => {
  console.log(`🌐 HTTP na porta ${PORT}`);
  // Inicia o bot e captura erros na inicialização
  startBot().catch((e) => {
    console.error("Erro ao iniciar bot:", e);
    process.exit(1);
  });
});
