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

// Guarda referência do socket atual e controle de reconexão
let currentSock = null;
let reconnectAttempts = 0;
const RECONNECT_MAX = 10; // evita looping infinito
const BASE_RECONNECT_DELAY = 3000; // ms

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
    p.on("error", (err) => reject(err));
  });
}

// Converte buffer -> sticker .webp
async function convertToSticker(buffer, format) {
  const id = Date.now();
  const tmpDir = path.join(__dirname, "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

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
  } catch (e) {
    // ignore
  }

  return stickerBuffer;
}

// Fecha socket anterior com segurança
async function safeCloseSocket() {
  try {
    if (currentSock && currentSock.end) {
      await currentSock.end();
    } else if (currentSock && currentSock.close) {
      await currentSock.close();
    }
  } catch (e) {
    // ignore
  } finally {
    currentSock = null;
  }
}

// Inicia o bot
async function startBot() {
  // Se já estiver iniciando/rodando, não criar outra instância
  if (currentSock) {
    console.log("Já existe uma instância do bot rodando. Abortando nova inicialização.");
    return;
  }

  const authDir = path.join(__dirname, "auth_info");
  // garantir pasta existe (useMultiFileAuthState cria quando necessário)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Opções ajustadas: browser realista + versão do WhatsApp Web
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["Chrome", "Windows", "10.0"], // user-agent "realista"
    version: [2, 2411, 7], // ajuste para uma versão compatível do Web (pode atualizar se necessário)
    // evita sincronizar histórico grande (opcional)
    syncFullHistory: false,
  });

  // manter referência global
  currentSock = sock;

  // salvar credenciais quando atualizarem
  sock.ev.on("creds.update", saveCreds);

  // Mensagens
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
        } 
        else if (low === "/reset") {
          await sock.sendMessage(from, { text: "Bot resetado ✅" });
        } 
        else if (low === "/ping") {
          const start = Date.now();
          const sent = await sock.sendMessage(from, { text: "pong 🏓" });
          const latency = Date.now() - start;
          await sock.sendMessage(from, { text: `⏱ Latência: ${latency}ms` }, { quoted: sent });
        } 
        else if (low === "/dados") {
          const roll = Math.floor(Math.random() * 6) + 1;
          await sock.sendMessage(from, { text: `🎲 Você tirou: ${roll}` });
        } 
        else if (low === "/caracoroa") {
          const flip = Math.random() < 0.5 ? "Cara 🪙" : "Coroa 🪙";
          await sock.sendMessage(from, { text: `Resultado: ${flip}` });
        } 
        else if (low === "/help") {
          const helpText = `
📖 *Menu de Comandos do Bot*

🔧 Básicos
- /ping → Testa conexão
- /reset → Reinicia o bot

😂 Diversão
- /dados → Joga um dado 🎲
- /caracoroa → Moeda cara/coroa 🪙

📂 Mídia
- Envie imagem ou vídeo para virar sticker
`;
          await sock.sendMessage(from, { text: helpText });
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
    } catch (err) {
      console.error("Erro ao processar mensagem:", err);
    }
  });

  // Conexão
  sock.ev.on("connection.update", async (update) => {
    try {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        qrGlobal = await QRCode.toDataURL(qr);
        console.log("📱 QR code gerado - acesse /qrcode para escanear");
      }

      if (connection === "open") {
        console.log("✅ Bot conectado!");
        qrGlobal = null;
        reconnectAttempts = 0; // zerar tentativas
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("🔌 Conexão fechada", { statusCode, shouldReconnect });

        // fechar socket atual e limpar referência
        await safeCloseSocket();

        if (shouldReconnect && reconnectAttempts < RECONNECT_MAX) {
          reconnectAttempts += 1;
          const delay = BASE_RECONNECT_DELAY * reconnectAttempts; // backoff linear simples
          console.log(`🔄 Tentando reconectar em ${delay}ms (tentativa ${reconnectAttempts}/${RECONNECT_MAX})`);
          setTimeout(() => startBot().catch((e) => console.error("Erro no restart:", e)), delay);
        } else if (!shouldReconnect) {
          console.log("❌ Deslogado permanentemente. Delete a pasta auth_info e escaneie o QR novamente.");
        } else {
          console.log("❌ Excedeu tentativas de reconexão. Reinicie manualmente se quiser tentar novamente.");
        }
      }
    } catch (e) {
      console.error("Erro no event connection.update:", e);
    }
  });

  // tratar erros do socket (só log)
  sock.ev.on("error", (err) => {
    console.error("Erro no socket:", err);
  });

  // retornar o socket pra possível uso futuro
  return sock;
}

// Sobe HTTP + inicia bot
app.listen(PORT, () => {
  console.log(`🌐 HTTP na porta ${PORT}`);
  startBot().catch((e) => {
    console.error("Erro ao iniciar bot:", e);
    process.exit(1);
  });
});

// limpar tmp ao finalizar processo (opcional)
process.on("exit", () => {
  try {
    const tmpDir = path.join(__dirname, "tmp");
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {}
});
