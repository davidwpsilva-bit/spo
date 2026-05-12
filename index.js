const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// CONFIGURAÇÕES E CONEXÃO
// ==========================================
const token = process.env.TELEGRAM_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!token || !supabaseUrl || !supabaseKey) {
    console.error("ERRO: Variáveis de ambiente em falta (TELEGRAM_TOKEN, SUPABASE_URL, SUPABASE_KEY)!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const supabase = createClient(supabaseUrl, supabaseKey);

const userSessions = {}; 
const pendingStates = {}; // Máquina de estados para fluxos de conversa (criar, editar, etc.)

// Servidor Express para manter o Render acordado
const app = express();
app.get('/', (req, res) => { res.send('Bot do Spotify RPG Online! 🟢'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor web a rodar na porta ${PORT}`); });

// Formata números (ex: 1.500.000)
const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : '0';

// Converte os IDs do banco de dados para Array
function parseArtistIds(ids) {
    if (!ids) return [];
    if (typeof ids === 'string') return ids.replace(/^{|}$/g, '').split(',').map(id => id.trim()).filter(id => id !== '');
    return ids;
}

// ==========================================
// COMANDOS DE NAVEGAÇÃO E GRUPOS
// ==========================================

bot.onText(/\/menu/, (msg) => {
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    
    if (isGroup) {
        return bot.sendMessage(msg.chat.id, "❌ O menu completo de gestão só está disponível no chat privado.", { 
            reply_markup: { inline_keyboard: [[{ text: "Falar no Privado", url: `https://t.me/SpotifyRpgBot` }]] }
        });
    }
    
    if (!userSessions[userId]) {
        return bot.sendMessage(msg.chat.id, "❌ Precisas de iniciar sessão primeiro com /start");
    }
    
    sendMainMenu(msg.chat.id, userSessions[userId].name);
});

bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (isGroup) {
        return bot.sendMessage(msg.chat.id, `👋 Bem-vindos ao <b>Spotify RPG</b>!\n\n🔒 <i>Fale comigo no privado para gerir a sua agência.</i>`, { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: [[{ text: "🎧 Abrir Jogo / Login Privado", url: `https://t.me/SpotifyRpgBot` }]] }
        });
    }

    if (userSessions[userId]) return sendMainMenu(msg.chat.id, userSessions[userId].name);
    
    pendingStates[userId] = { type: 'LOGIN_NAME' };
    bot.sendMessage(msg.chat.id, `👋 <b>Bem-vindo ao Spotify RPG!</b>\n\nPara aceder ao teu painel, digita o teu <b>Nome de Jogador</b>:`, { parse_mode: 'HTML' });
});

// ==========================================
// CAPTURA DE RESPOSTAS (MÁQUINA DE ESTADOS)
// ==========================================
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (isGroup || !text || text.startsWith('/')) return; // Ignora grupos e comandos
    if (!pendingStates[userId]) return;

    const state = pendingStates[userId];

    // --- FLUXO: LOGIN ---
    if (state.type === 'LOGIN_NAME') {
        state.name = text.trim();
        state.type = 'LOGIN_PASS';
        return bot.sendMessage(chatId, `🔑 Perfeito, <b>${state.name}</b>! Agora digita a tua senha:`, { parse_mode: 'HTML' });
    } 
    else if (state.type === 'LOGIN_PASS') {
        bot.sendMessage(chatId, "⏳ A verificar...");
        const { data: player } = await supabase.from('players').select('*').ilike('name', state.name).eq('password', text.trim()).single();
        delete pendingStates[userId];
        
        if (player) {
            userSessions[userId] = player;
            bot.sendMessage(chatId, "✅ Login realizado com sucesso!");
            return sendMainMenu(chatId, player.name);
        } else {
            return bot.sendMessage(chatId, "❌ Nome ou senha incorretos. Digita /start para tentar novamente.");
        }
    }

    // --- FLUXO: CRIAR PERSONAGEM ---
    else if (state.type === 'CREATE_ARTIST_NAME') {
        state.artistName = text.trim();
        state.type = 'CREATE_ARTIST_PHOTO';
        return bot.sendMessage(chatId, `📸 Ótimo nome! Agora, envia o <b>URL da foto</b> do personagem (ou digita "pular" para ficar com a imagem padrão):`, { parse_mode: 'HTML' });
    }
    else if (state.type === 'CREATE_ARTIST_PHOTO') {
        const photoUrl = text.toLowerCase() === 'pular' ? null : text.trim();
        const player = userSessions[userId];
        delete pendingStates[userId];
        bot.sendMessage(chatId, "⏳ A criar personagem...");

        const { data: newArtist, error: errArt } = await supabase.from('artists').insert([{ 
            name: state.artistName, image_url: photoUrl, rpg_points: 0, personal_points: 0 
        }]).select().single();

        if (errArt || !newArtist) return bot.sendMessage(chatId, "❌ Erro ao criar o artista na base de dados.");

        const currentIds = parseArtistIds(player.artist_ids);
        currentIds.push(newArtist.id);
        
        await supabase.from('players').update({ artist_ids: currentIds }).eq('id', player.id);
        player.artist_ids = currentIds; 

        bot.sendMessage(chatId, `🎉 <b>Sucesso!</b> O personagem <b>${newArtist.name}</b> foi criado e adicionado à tua agência!`, { parse_mode: 'HTML' });
        return sendMainMenu(chatId, player.name);
    }

    // --- FLUXO: EDITAR JOGADOR ---
    else if (state.type === 'EDIT_PLAYER_NAME') {
        const newName = text.trim();
        delete pendingStates[userId];
        await supabase.from('players').update({ name: newName }).eq('id', userSessions[userId].id);
        userSessions[userId].name = newName;
        bot.sendMessage(chatId, `✅ Nome alterado com sucesso para <b>${newName}</b>!`, { parse_mode: 'HTML' });
        return sendMainMenu(chatId, newName);
    }
    else if (state.type === 'EDIT_PLAYER_PASS') {
        const newPass = text.trim();
        delete pendingStates[userId];
        await supabase.from('players').update({ password: newPass }).eq('id', userSessions[userId].id);
        userSessions[userId].password = newPass;
        return bot.sendMessage(chatId, `✅ Senha alterada com sucesso! Guarda-a num local seguro.`);
    }

    // --- FLUXO: EDITAR PERSONAGEM ---
    else if (state.type === 'EDIT_ARTIST_NAME') {
        const newArtName = text.trim();
        const artistId = state.artistId;
        delete pendingStates[userId];
        await supabase.from('artists').update({ name: newArtName }).eq('id', artistId);
        return bot.sendMessage(chatId, `✅ Nome do personagem alterado com sucesso para <b>${newArtName}</b>!`, { parse_mode: 'HTML' });
    }
    else if (state.type === 'EDIT_ARTIST_PHOTO') {
        const newPhoto = text.trim();
        const artistId = state.artistId;
        delete pendingStates[userId];
        await supabase.from('artists').update({ image_url: newPhoto }).eq('id', artistId);
        return bot.sendMessage(chatId, `✅ Foto do personagem atualizada com sucesso!`);
    }
});

// ==========================================
// INTERFACE E MENUS PRINCIPAIS
// ==========================================
function sendMainMenu(chatId, playerName) {
    const texto = `🎵 <b>CENTRAL DO MANAGER</b>\n\nOlá, <b>${playerName}</b>! O que desejas fazer?`;
    const teclado = {
        inline_keyboard: [
            [{ text: "🎭 Meus Personagens", callback_data: "menu_personagens" }, { text: "⚡ Ações", callback_data: "menu_acoes" }],
            [{ text: "➕ Criar Personagem", callback_data: "cmd_criar_personagem" }],
            [{ text: "⚙️ Configurações (Conta/Artistas)", callback_data: "menu_config" }],
            [{ text: "📈 Ver Chart Diário", callback_data: "menu_chart" }],
            [{ text: "🎮 Abrir Web App", web_app: { url: "https://melancholyloveoff.github.io/spotify/" } }]
        ]
    };
    bot.sendMessage(chatId, texto, { parse_mode: 'HTML', reply_markup: teclado });
}

function sendConfigMenu(chatId) {
    const texto = `⚙️ <b>CONFIGURAÇÕES</b>\n\nAqui podes editar os teus dados de jogador e personalizar os teus artistas:`;
    const teclado = {
        inline_keyboard: [
            [{ text: "✏️ Alterar Meu Nome", callback_data: "cfg_edit_p_name" }, { text: "🔒 Alterar Senha", callback_data: "cfg_edit_p_pass" }],
            [{ text: "🖼️ Editar Meus Personagens", callback_data: "cfg_edit_art_list" }],
            [{ text: "⬅️ Voltar", callback_data: "menu_voltar" }]
        ]
    };
    bot.sendMessage(chatId, texto, { parse_mode: 'HTML', reply_markup: teclado });
}

// ==========================================
// LISTAGENS E AÇÕES (COM FOTOGRAFIAS)
// ==========================================
async function handlePersonagens(chatId, userId) {
    const player = userSessions[userId];
    const artistIds = parseArtistIds(player.artist_ids);

    if (artistIds.length === 0) return bot.sendMessage(chatId, "A tua agência está vazia. Usa a opção 'Criar Personagem'!");

    const { data: artists } = await supabase.from('artists').select('*').in('id', artistIds);

    for (const artist of artists) {
        const legenda = `👤 <b>${artist.name}</b>\n✨ Pontos RPG: <b>${artist.rpg_points || 0}</b> | 💎 Pessoais: <b>${artist.personal_points || 0}</b>`;
        const foto = artist.image_url || "https://i.imgur.com/AD3MbBi.png";
        await bot.sendPhoto(chatId, foto, { caption: legenda, parse_mode: 'HTML' });
    }
}

async function handleAcoesMenu(chatId, userId) {
    const player = userSessions[userId];
    const artistIds = parseArtistIds(player.artist_ids);
    if (artistIds.length === 0) return bot.sendMessage(chatId, "Precisas de ter um personagem primeiro!");

    const { data: artists } = await supabase.from('artists').select('id, name').in('id', artistIds);
    const teclado = { inline_keyboard: artists.map(a => [{ text: `👤 ${a.name}`, callback_data: `sel_art_${a.id}` }]) };
    teclado.inline_keyboard.push([{ text: "⬅️ Voltar", callback_data: "menu_voltar" }]);
    bot.sendMessage(chatId, "⚡ <b>SISTEMA DE PROMOÇÃO</b>\nEscolhe o artista:", { parse_mode: 'HTML', reply_markup: teclado });
}

// ==========================================
// PROCESSAMENTO DE CLIQUES (CALLBACKS)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    bot.answerCallbackQuery(query.id);

    // Navegação Básica
    if (data === "menu_voltar") return sendMainMenu(chatId, userSessions[userId].name);
    if (data === "menu_personagens") return handlePersonagens(chatId, userId);
    if (data === "menu_acoes") return handleAcoesMenu(chatId, userId);
    if (data === "menu_config") return sendConfigMenu(chatId);

    // Chart Global (Ordenado por Streams!)
    if (data === "menu_chart") {
        bot.sendMessage(chatId, "📈 <i>A consultar o Top Global...</i>", { parse_mode: 'HTML' });
        
        // Puxa as 10 músicas com MAIS streams diretamente
        const { data: songs, error } = await supabase
            .from('songs')
            .select('id, title, streams, previous_rank')
            .order('streams', { ascending: false })
            .limit(10);
            
        if (error || !songs || songs.length === 0) return bot.sendMessage(chatId, "😔 Chart indisponível.");
        
        let chartMsg = `🏆 <b>CHART DIÁRIO GLOBAL (TOP 10)</b> 🏆\n\n`;
        
        songs.forEach((s, index) => {
            const posicaoAtual = index + 1;
            
            let trend = "➖";
            if (!s.previous_rank) trend = "🆕";
            else if (posicaoAtual < s.previous_rank) trend = "🔺";
            else if (posicaoAtual > s.previous_rank) trend = "🔻";

            let medalha = posicaoAtual === 1 ? "🥇" : posicaoAtual === 2 ? "🥈" : posicaoAtual === 3 ? "🥉" : `<b>${posicaoAtual}.</b>`;
            chartMsg += `${medalha} ${s.title} \n└ ${trend} • <i>${formatNumber(s.streams)} streams</i>\n\n`;
        });
        
        return bot.sendMessage(chatId, chartMsg, { parse_mode: 'HTML' });
    }

    // Criar Personagem
    if (data === "cmd_criar_personagem") {
        pendingStates[userId] = { type: 'CREATE_ARTIST_NAME' };
        return bot.sendMessage(chatId, "➕ <b>Novo Personagem</b>\n\nDigita o nome do teu novo artista/grupo:", { parse_mode: 'HTML' });
    }

    // Configurações - Jogador
    if (data === "cfg_edit_p_name") {
        pendingStates[userId] = { type: 'EDIT_PLAYER_NAME' };
        return bot.sendMessage(chatId, "✏️ Digita o teu NOVO Nome de Jogador:");
    }
    if (data === "cfg_edit_p_pass") {
        pendingStates[userId] = { type: 'EDIT_PLAYER_PASS' };
        return bot.sendMessage(chatId, "🔒 Digita a tua NOVA Senha:");
    }

    // Configurações - Selecionar Artista para Editar
    if (data === "cfg_edit_art_list") {
        const artistIds = parseArtistIds(userSessions[userId].artist_ids);
        if(artistIds.length === 0) return bot.sendMessage(chatId, "Não tens personagens para editar.");
        const { data: artists } = await supabase.from('artists').select('id, name').in('id', artistIds);
        
        const teclado = { inline_keyboard: artists.map(a => [{ text: `✏️ ${a.name}`, callback_data: `ed_art_${a.id}` }]) };
        teclado.inline_keyboard.push([{ text: "⬅️ Voltar", callback_data: "menu_config" }]);
        
        return bot.sendMessage(chatId, "Qual o personagem que desejas editar?", { reply_markup: teclado });
    }

    // Configurações - Escolher o campo do Artista
    if (data.startsWith("ed_art_")) {
        const artistId = data.replace("ed_art_", "");
        const teclado = {
            inline_keyboard: [
                [{ text: "✏️ Editar Nome", callback_data: `do_ed_art_name_${artistId}` }, { text: "🖼️ Editar Foto", callback_data: `do_ed_art_foto_${artistId}` }],
                [{ text: "⬅️ Voltar", callback_data: "cfg_edit_art_list" }]
            ]
        };
        return bot.sendMessage(chatId, "O que pretendes alterar neste personagem?", { reply_markup: teclado });
    }

    // Configurações - Inserir novo dado do Artista
    if (data.startsWith("do_ed_art_name_")) {
        pendingStates[userId] = { type: 'EDIT_ARTIST_NAME', artistId: data.replace("do_ed_art_name_", "") };
        return bot.sendMessage(chatId, "✏️ Digita o NOVO NOME do personagem:");
    }
    if (data.startsWith("do_ed_art_foto_")) {
        pendingStates[userId] = { type: 'EDIT_ARTIST_PHOTO', artistId: data.replace("do_ed_art_foto_", "") };
        return bot.sendMessage(chatId, "🖼️ Envia o NOVO URL da foto do personagem:");
    }

    // Ações - Listar Promoções
    if (data.startsWith("sel_art_")) {
        const artistId = data.replace("sel_art_", "");
        const teclado = {
            inline_keyboard: [
                [{ text: "📺 TV", callback_data: `act_promo_tv_count_${artistId}` }, { text: "📻 Rádio", callback_data: `act_promo_radio_count_${artistId}` }],
                [{ text: "📱 Internet", callback_data: `act_promo_internet_count_${artistId}` }, { text: "🛍️ Comercial", callback_data: `act_promo_commercial_count_${artistId}` }],
                [{ text: "⬅️ Voltar", callback_data: "menu_acoes" }]
            ]
        };
        return bot.sendMessage(chatId, "Seleciona a ação de promoção pretendida:", { reply_markup: teclado });
    }

    // Ações - Executar Ação e Enviar Foto
    if (data.startsWith("act_")) {
        const match = data.match(/act_(.*)_([^_]+-[^_]+-[^_]+-[^_]+-[^_]+)$/);
        if (match) {
            const column = match[1];
            const artistId = match[2];
            
            const { data: artist } = await supabase.from('artists').select('*').eq('id', artistId).single();
            const newVal = (artist[column] || 0) + 1;
            
            await supabase.from('artists').update({ [column]: newVal }).eq('id', artistId);
            
            const foto = artist.image_url || "https://i.imgur.com/AD3MbBi.png";
            bot.sendPhoto(chatId, foto, { 
                caption: `✅ <b>SUCESSO!</b>\n\nO personagem <b>${artist.name}</b> realizou uma ação.\n📈 Total acumulado: <b>${newVal}</b>`, 
                parse_mode: 'HTML' 
            });
        }
    }
});

console.log('🤖 Bot do RPG iniciado com sucesso!');
