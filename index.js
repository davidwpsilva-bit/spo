const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// CONFIGURAÇÕES GERAIS E SEGURANÇA
// ==========================================
const token = process.env.TELEGRAM_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!token || !supabaseUrl || !supabaseKey) {
    console.error("ERRO: Variáveis de ambiente em falta!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const supabase = createClient(supabaseUrl, supabaseKey);

// Sessões baseadas no ID DA PESSOA (msg.from.id) e não do chat
const userSessions = {}; 
const pendingLogins = {};

// ==========================================
// 1. SERVIDOR "ISCA" PARA O RENDER
// ==========================================
const app = express();
app.get('/', (req, res) => { res.send('Bot do Spotify RPG Online! 🟢'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor web a rodar na porta ${PORT}`); });

// Formata números para ficar bonito (ex: 1.500.000)
const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : '0';

// ==========================================
// COMANDO: /start (Login Seguro)
// ==========================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id; // O ID real do jogador
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // 1. Se estiver num GRUPO, nunca pede senha! Manda apenas o menu geral.
    if (isGroup) {
        const mensagem = `👋 Olá a todos! Bem-vindos ao <b>Spotify RPG</b>.\n\n🔒 <i>Para veres a tua agência ou fazeres login, fala comigo em privado.</i>`;
        return bot.sendMessage(chatId, mensagem, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🎧 Abrir Jogo / Login Privado", url: `https://t.me/${(await bot.getMe()).username}` }]] }
        });
    }

    // 2. PRIVADO: Se já tem sessão, mostra o menu
    if (userSessions[userId]) {
        return sendMainMenu(chatId, userSessions[userId].name);
    }

    // 3. PRIVADO: Pede o Login
    pendingLogins[userId] = { step: 'name', chatId: chatId };
    bot.sendMessage(chatId, `🔒 <b>Acesso ao Spotify RPG</b>\n\nOlá, ${msg.from.first_name}! Para gerires a tua carreira, precisamos de verificar as tuas credenciais.\n\n👉 <b>Qual é o teu Nome de Jogador (Login)?</b>`, { parse_mode: 'HTML' });
});

// Captura as respostas de texto para o fluxo de Login (Só no privado)
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // Ignora grupos e comandos
    if (isGroup || !text || text.startsWith('/')) return;

    if (pendingLogins[userId]) {
        if (pendingLogins[userId].step === 'name') {
            pendingLogins[userId].name = text.trim();
            pendingLogins[userId].step = 'password';
            bot.sendMessage(chatId, `🔑 Perfeito, <b>${pendingLogins[userId].name}</b>.\n\n👉 <b>Agora, digita a tua Senha:</b>`, { parse_mode: 'HTML' });
        } 
        else if (pendingLogins[userId].step === 'password') {
            const username = pendingLogins[userId].name;
            const password = text.trim();
            delete pendingLogins[userId]; // Limpa o estado

            bot.sendMessage(chatId, "⏳ A verificar credenciais na base de dados...");

            const { data: player, error } = await supabase
                .from('players')
                .select('*')
                .ilike('name', username)
                .eq('password', password)
                .single();

            if (error || !player) {
                bot.sendMessage(chatId, "❌ <b>Login falhou!</b> Nome de utilizador ou senha incorretos.\n\nUsa /start para tentar de novo.", { parse_mode: 'HTML' });
            } else {
                // Guarda a sessão ligada ao ID da PESSOA!
                userSessions[userId] = player;
                bot.sendMessage(chatId, `✅ <b>Sessão Iniciada com Sucesso!</b>\n\nBem-vindo de volta, <b>${player.name}</b>.`, { parse_mode: 'HTML' });
                sendMainMenu(chatId, player.name);
            }
        }
    }
});

function sendMainMenu(chatId, playerName) {
    const mensagem = `🎵 <b>Painel Principal - ${playerName}</b>\n\nO que queres fazer hoje? Seleciona uma opção no menu abaixo:`;
    const teclado = {
        inline_keyboard: [
            [{ text: "🎭 Meus Personagens", callback_data: "cmd_personagens" }],
            [{ text: "📈 Ver Chart Diário", callback_data: "cmd_chart" }],
            [{ text: "🎧 Abrir o Jogo Completo", web_app: { url: "https://melancholyloveoff.github.io/spotify/" } }]
        ]
    };
    bot.sendMessage(chatId, mensagem, { parse_mode: 'HTML', reply_markup: teclado });
}

// ==========================================
// COMANDO: /chart (Funciona Perfeito em Grupos e Privado)
// ==========================================
bot.onText(/\/chart/, async (msg) => { handleChartCommand(msg.chat.id); });

async function handleChartCommand(chatId) {
    const { data: songs, error } = await supabase
        .from('songs')
        .select('id, title, streams, current_rank, previous_rank, artist_ids')
        .not('current_rank', 'is', null)
        .order('current_rank', { ascending: true })
        .limit(10);

    if (error || !songs || songs.length === 0) return bot.sendMessage(chatId, "😔 Chart indisponível no momento.");

    let chartMsg = `🏆 <b>SPOTIFY RPG - CHART DIÁRIO (TOP 10)</b> 🏆\n\n`;

    for (const song of songs) {
        let trend = "➖";
        if (!song.previous_rank) trend = "🆕";
        else if (song.current_rank < song.previous_rank) trend = "🔺";
        else if (song.current_rank > song.previous_rank) trend = "🔻";

        let artistName = "Artista Desconhecido";
        if (song.artist_ids && song.artist_ids.length > 0) {
            const { data: artist } = await supabase.from('artists').select('name').eq('id', song.artist_ids[0]).single();
            if (artist) artistName = artist.name;
        }

        let medal = song.current_rank === 1 ? "🥇" : song.current_rank === 2 ? "🥈" : song.current_rank === 3 ? "🥉" : `<b>${song.current_rank}.</b>`;
        chartMsg += `${medal} <b>${song.title}</b> - ${artistName}\n└ ${trend} • <i>${formatNumber(song.streams)} streams</i>\n\n`;
    }
    bot.sendMessage(chatId, chartMsg, { parse_mode: 'HTML' });
}

// ==========================================
// COMANDO: /personagem (O Segredo para funcionar no Grupo!)
// ==========================================
bot.onText(/\/personagem/, async (msg) => {
    const chatId = msg.chat.id; // Para onde enviar a mensagem (Privado ou Grupo)
    const userId = msg.from.id; // Quem pediu o comando

    // Verifica a sessão pela PESSOA, não pelo chat
    if (!userSessions[userId]) {
        return bot.sendMessage(chatId, "❌ Precisas de iniciar sessão primeiro!\n👉 Vai ao meu chat privado e digita /start");
    }

    const player = userSessions[userId];
    let artistIds = player.artist_ids;
    if (typeof artistIds === 'string') artistIds = artistIds.replace('{', '').replace('}', '').split(',');

    if (!artistIds || artistIds.length === 0 || (artistIds.length === 1 && artistIds[0] === "")) {
        return bot.sendMessage(chatId, `🎭 <b>${player.name}</b>, a tua Agência está vazia!`, { parse_mode: 'HTML' });
    }

    const { data: artists, error } = await supabase.from('artists').select('*').in('id', artistIds);

    if (error || !artists || artists.length === 0) return bot.sendMessage(chatId, "😔 Erro ao procurar os teus artistas.");

    let responseMsg = `🎭 <b>AGÊNCIA DE ${player.name.toUpperCase()}</b>\n\n`;
    artists.forEach(artist => {
        responseMsg += `👤 <b>${artist.name}</b>\n└ Pontos RPG: ${artist.rpg_points || 0} • Pessoais: ${artist.personal_points || 0}\n\n`;
    });

    bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML' });
});

// Responde aos botões do menu inline
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    query.message.from.id = query.from.id; // Força o ID da pessoa para o comando personagem funcionar pelo botão
    bot.answerCallbackQuery(query.id);

    if (query.data === 'cmd_chart') handleChartCommand(chatId);
    else if (query.data === 'cmd_personagens') bot.emit('text', { chat: { id: chatId }, from: { id: query.from.id }, text: '/personagem' });
});
