const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// CONFIGURAÇÕES GERAIS E SEGURANÇA
// ==========================================
// No Render, estas variáveis serão injetadas através do painel "Environment"
const token = process.env.TELEGRAM_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!token || !supabaseUrl || !supabaseKey) {
    console.error("ERRO: Variáveis de ambiente em falta! Configura o TELEGRAM_TOKEN, SUPABASE_URL e SUPABASE_KEY no Render.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const supabase = createClient(supabaseUrl, supabaseKey);

// Sistema de Sessões Simples (Guarda os IDs do Telegram que já fizeram login)
// A chave é o chatId do utilizador, o valor é o objeto do "player"
const userSessions = {}; 

// Variáveis para controlar o estado do login
const pendingLogins = {};

// ==========================================
// 1. SERVIDOR "ISCA" PARA O RENDER NÃO ADORMECER
// ==========================================
const app = express();
app.get('/', (req, res) => { res.send('O Bot do Spotify RPG está Online e Acordado! 🟢'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor web a rodar na porta ${PORT}`); });

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================
// Formata números para ficar bonito (ex: 1.500.000)
const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : '0';

// ==========================================
// COMANDO: /start (E Lógica de Login)
// ==========================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // No grupo, apenas damos a mensagem genérica ou o link
    if (isGroup) {
        const mensagem = `👋 Olá a todos! Bem-vindos ao <b>Spotify RPG</b>.\n\nPara gerires os teus artistas e veres o chart, fala comigo em privado ou clica no botão abaixo!`;
        bot.sendMessage(chatId, mensagem, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🎧 Abrir Painel de Jogo", web_app: { url: "https://melancholyloveoff.github.io/spotify/" } }]] }
        });
        return;
    }

    // Se já estiver logado, não pedimos de novo
    if (userSessions[chatId]) {
        return sendMainMenu(chatId, userSessions[chatId].name);
    }

    // Pede o Login
    pendingLogins[chatId] = { step: 'name' };
    bot.sendMessage(chatId, `🔒 <b>Acesso ao Spotify RPG</b>\n\nOlá, ${msg.from.first_name}! Para gerires a tua carreira, precisamos de verificar as tuas credenciais.\n\n👉 <b>Qual é o teu Nome de Jogador (Login)?</b>`, { parse_mode: 'HTML' });
});

// Captura as respostas de texto para o fluxo de Login
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignora comandos (que começam por /)
    if (!text || text.startsWith('/')) return;

    if (pendingLogins[chatId]) {
        if (pendingLogins[chatId].step === 'name') {
            pendingLogins[chatId].name = text.trim();
            pendingLogins[chatId].step = 'password';
            bot.sendMessage(chatId, `🔑 Perfeito, <b>${pendingLogins[chatId].name}</b>.\n\n👉 <b>Agora, digita a tua Senha:</b>`, { parse_mode: 'HTML' });
        } 
        else if (pendingLogins[chatId].step === 'password') {
            const username = pendingLogins[chatId].name;
            const password = text.trim();
            delete pendingLogins[chatId]; // Limpa o estado pendente

            bot.sendMessage(chatId, "⏳ A verificar credenciais na base de dados...");

            // Vai ao Supabase tentar encontrar o jogador
            const { data: player, error } = await supabase
                .from('players')
                .select('*')
                .ilike('name', username) // case-insensitive
                .eq('password', password)
                .single();

            if (error || !player) {
                bot.sendMessage(chatId, "❌ <b>Login falhou!</b> Nome de utilizador ou senha incorretos.\n\nUsa /start para tentar de novo.", { parse_mode: 'HTML' });
            } else {
                // Guarda a sessão
                userSessions[chatId] = player;
                bot.sendMessage(chatId, `✅ <b>Sessão Iniciada com Sucesso!</b>\n\nBem-vindo de volta, <b>${player.name}</b>. A tua conta foi verificada.`, { parse_mode: 'HTML' });
                sendMainMenu(chatId, player.name);
            }
        }
    }
});

function sendMainMenu(chatId, playerName) {
    const mensagem = `🎵 <b>Painel Principal - ${playerName}</b>\n\nO que queres fazer hoje? Seleciona uma opção no menu abaixo:`;
    
    // Podemos usar comandos normais ou um menu inline (fica mais bonito)
    const teclado = {
        inline_keyboard: [
            [{ text: "🎭 Meus Personagens", callback_data: "cmd_personagens" }],
            [{ text: "📈 Ver Chart Diário", callback_data: "cmd_chart" }],
            [{ text: "⚡ Realizar Ações", callback_data: "cmd_acoes" }],
            [{ text: "🎧 Abrir o Jogo Completo", web_app: { url: "https://melancholyloveoff.github.io/spotify/" } }]
        ]
    };
    bot.sendMessage(chatId, mensagem, { parse_mode: 'HTML', reply_markup: teclado });
}

// ==========================================
// COMANDO: /chart (Retorna o Top 10)
// ==========================================
bot.onText(/\/chart/, async (msg) => { handleChartCommand(msg.chat.id); });

async function handleChartCommand(chatId) {
    bot.sendMessage(chatId, "📊 A gerar o chart atual...");

    // Busca as músicas ordenadas pelo current_rank
    const { data: songs, error } = await supabase
        .from('songs')
        .select('id, title, streams, current_rank, previous_rank, artist_ids')
        .not('current_rank', 'is', null) // Apenas músicas que já entraram no chart
        .order('current_rank', { ascending: true })
        .limit(10);

    if (error || !songs || songs.length === 0) {
        return bot.sendMessage(chatId, "😔 Não foi possível carregar o chart no momento ou ele está vazio.");
    }

    let chartMsg = `🏆 <b>SPOTIFY RPG - CHART DIÁRIO (TOP 10)</b> 🏆\n\n`;

    for (const song of songs) {
        // Lógica da setinha de tendência
        let trend = "➖";
        if (!song.previous_rank) trend = "🆕";
        else if (song.current_rank < song.previous_rank) trend = "🔺";
        else if (song.current_rank > song.previous_rank) trend = "🔻";

        // Tentar ir buscar o nome do artista (assumindo que o primeiro ID é o artista principal)
        let artistName = "Artista Desconhecido";
        if (song.artist_ids && song.artist_ids.length > 0) {
            // Nota: Para manter o bot rápido, estamos a fazer querys dentro do loop. 
            // Numa versão de produção gigante, faríamos uma cache de artistas.
            const { data: artist } = await supabase.from('artists').select('name').eq('id', song.artist_ids[0]).single();
            if (artist) artistName = artist.name;
        }

        let medal = song.current_rank === 1 ? "🥇" : song.current_rank === 2 ? "🥈" : song.current_rank === 3 ? "🥉" : `<b>${song.current_rank}.</b>`;

        chartMsg += `${medal} <b>${song.title}</b> - ${artistName}\n`;
        chartMsg += `└ ${trend} • <i>${formatNumber(song.streams)} streams</i>\n\n`;
    }

    bot.sendMessage(chatId, chartMsg, { parse_mode: 'HTML' });
}

// ==========================================
// COMANDO: /personagem (Mostra os personagens do Player)
// ==========================================
bot.onText(/\/personagem/, async (msg) => { handlePersonagemCommand(msg.chat.id); });

async function handlePersonagemCommand(chatId) {
    if (!userSessions[chatId]) return bot.sendMessage(chatId, "❌ Precisas de iniciar sessão primeiro! Usa /start");

    const player = userSessions[chatId];
    
    // O Supabase devolve os IDs no formato de string, precisamos de garantir que é um array
    let artistIds = player.artist_ids;
    if (typeof artistIds === 'string') {
        // Se vier como string do tipo "{id1,id2}", limpamos:
        artistIds = artistIds.replace('{', '').replace('}', '').split(',');
    }

    if (!artistIds || artistIds.length === 0 || (artistIds.length === 1 && artistIds[0] === "")) {
        return bot.sendMessage(chatId, "🎭 <b>A tua Agência está vazia!</b>\n\nAinda não geres nenhum artista.", { parse_mode: 'HTML' });
    }

    bot.sendMessage(chatId, "🎭 A procurar os teus artistas...");

    const { data: artists, error } = await supabase
        .from('artists')
        .select('*')
        .in('id', artistIds);

    if (error || !artists || artists.length === 0) {
        return bot.sendMessage(chatId, "😔 Ocorreu um erro ao procurar os teus artistas.");
    }

    let msg = `🎭 <b>AGÊNCIA DE ${player.name.toUpperCase()}</b>\n\n`;

    artists.forEach(artist => {
        msg += `👤 <b>${artist.name}</b>\n`;
        msg += `└ Pontos RPG: ${artist.rpg_points || 0} • Pessoais: ${artist.personal_points || 0}\n`;
        if(artist.image_url) msg += `[📸 Foto do Perfil](${artist.image_url})\n`;
        msg += `\n`;
    });

    bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: false });
}

// ==========================================
// CAPTURAR CLIQUES NOS BOTÕES DO MENU (Callback Queries)
// ==========================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;

    // Responde ao Telegram que o botão foi clicado (tira o ícone de relógio no botão)
    bot.answerCallbackQuery(query.id);

    if (action === 'cmd_chart') {
        handleChartCommand(chatId);
    } else if (action === 'cmd_personagens') {
        handlePersonagemCommand(chatId);
    } else if (action === 'cmd_acoes') {
        bot.sendMessage(chatId, "⚡ <b>Sistema de Ações</b>\n\nFuncionalidade em desenvolvimento. Em breve poderás fazer promoções de TV, Rádio e Internet diretamente por aqui!", { parse_mode: 'HTML' });
    }
});

console.log('🤖 Bot do RPG (Versão Supabase) iniciado com sucesso!');
