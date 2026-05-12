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
    console.error("ERRO: Variáveis de ambiente em falta!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const supabase = createClient(supabaseUrl, supabaseKey);

const userSessions = {}; 
const pendingStates = {}; 

const app = express();
app.get('/', (req, res) => { res.send('Bot do Spotify RPG Online! 🟢'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor web a rodar na porta ${PORT}`); });

const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : '0';

function parseArtistIds(ids) {
    if (!ids) return [];
    if (typeof ids === 'string') return ids.replace(/^{|}$/g, '').split(',').map(id => id.trim()).filter(id => id !== '');
    return ids;
}

// ==========================================
// COMANDOS GERAIS E FLUXO INICIAL
// ==========================================

bot.onText(/^\/(novidade|novidades)(?:@\w+)?$/, (msg) => { handleNovidades(msg.chat.id); });

bot.onText(/^\/chart(?:@\w+)?$/, (msg) => { handleChartCommand(msg.chat.id); });

// CORREÇÃO: Comando menu adaptado para funcionar nos Grupos
bot.onText(/^\/menu(?:@\w+)?$/, (msg) => {
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const isLoggedIn = !!userSessions[userId];
    const playerName = isLoggedIn ? userSessions[userId].name : "Visitante";
    
    sendMainMenu(msg.chat.id, playerName, isGroup, isLoggedIn);
});

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (isGroup) {
        return bot.sendMessage(msg.chat.id, `👋 Bem-vindos ao <b>Spotify RPG</b>!\n\nUsa o comando /menu para veres os charts e novidades, ou fala comigo no privado para gerires a tua agência.`, { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: [[{ text: "🎧 Fazer Login (Privado)", url: `https://t.me/SpotifyRpgBot` }]] } // Certifica-te que pões o nome real do teu bot aqui
        });
    }

    if (userSessions[userId]) return sendMainMenu(msg.chat.id, userSessions[userId].name, false, true);
    
    pendingStates[userId] = { type: 'LOGIN_NAME' };
    bot.sendMessage(msg.chat.id, `👋 <b>Bem-vindo ao Spotify RPG!</b>\n\nPara acederes ao teu painel, digita o teu <b>Nome de Jogador</b>:`, { parse_mode: 'HTML' });
});

// ==========================================
// CAPTURA DE RESPOSTAS (TEXTO MANUAL)
// ==========================================
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (isGroup || !text || text.startsWith('/')) return; 
    if (!pendingStates[userId]) return;

    const state = pendingStates[userId];

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
            return sendMainMenu(chatId, player.name, false, true);
        } else {
            return bot.sendMessage(chatId, "❌ Nome ou senha incorretos. Digita /start para tentar novamente.");
        }
    }

    else if (state.type === 'CREATE_ARTIST_NAME') {
        state.artistName = text.trim();
        state.type = 'CREATE_ARTIST_PHOTO';
        return bot.sendMessage(chatId, `📸 Ótimo nome! Agora, envia o <b>URL da foto</b> do personagem (ou digita "pular"):`, { parse_mode: 'HTML' });
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
        return sendMainMenu(chatId, player.name, false, true);
    }

    else if (state.type === 'EDIT_PLAYER_NAME') {
        const newName = text.trim();
        delete pendingStates[userId];
        await supabase.from('players').update({ name: newName }).eq('id', userSessions[userId].id);
        userSessions[userId].name = newName;
        bot.sendMessage(chatId, `✅ Nome alterado com sucesso para <b>${newName}</b>!`, { parse_mode: 'HTML' });
        return sendMainMenu(chatId, newName, false, true);
    }
    else if (state.type === 'EDIT_PLAYER_PASS') {
        const newPass = text.trim();
        delete pendingStates[userId];
        await supabase.from('players').update({ password: newPass }).eq('id', userSessions[userId].id);
        userSessions[userId].password = newPass;
        return bot.sendMessage(chatId, `✅ Senha alterada com sucesso! Guarda-a num local seguro.`);
    }

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
// INTERFACE E MENUS
// ==========================================

// Função geradora de markup de menus
function getMainMenuMarkup(playerName, isGroup, isLoggedIn) {
    let texto = `🎵 <b>CENTRAL DO MANAGER</b>\n\nOlá, <b>${playerName}</b>! O que desejas fazer?`;
    const teclado = { inline_keyboard: [] };
    
    teclado.inline_keyboard.push([{ text: "🌟 Novidades", callback_data: "menu_novidades" }, { text: "📈 Ver Chart Diário", callback_data: "menu_chart" }]);

    if (isLoggedIn) {
        teclado.inline_keyboard.push([{ text: "🎭 Meus Personagens", callback_data: "menu_personagens" }, { text: "⚡ Ações", callback_data: "menu_acoes" }]);
    }

    if (!isGroup) {
        if (isLoggedIn) {
            teclado.inline_keyboard.push([{ text: "➕ Criar Personagem", callback_data: "cmd_criar_personagem" }]);
            teclado.inline_keyboard.push([{ text: "⚙️ Configurações", callback_data: "menu_config" }]);
        } else {
            teclado.inline_keyboard.push([{ text: "🔑 Fazer Login", callback_data: "cmd_login" }]);
        }
    } else {
        if (!isLoggedIn) {
            texto += `\n\n<i>(Estás no modo Visitante. O teu login ficou guardado no meu chat privado. Fala comigo lá para acederes às tuas Ações.)</i>`;
        }
    }

    // Grupos não podem usar web_app
    if (isGroup) {
        teclado.inline_keyboard.push([{ text: "🎮 Abrir o Jogo (Site)", url: "https://melancholyloveoff.github.io/spotify/" }]);
    } else {
        teclado.inline_keyboard.push([{ text: "🎮 Abrir Web App", web_app: { url: "https://melancholyloveoff.github.io/spotify/" } }]);
    }

    return { texto, options: { parse_mode: 'HTML', reply_markup: teclado } };
}

// Envia uma MENSAGEM NOVA (quando usas /menu, por exemplo)
function sendMainMenu(chatId, playerName, isGroup, isLoggedIn) {
    const menu = getMainMenuMarkup(playerName, isGroup, isLoggedIn);
    bot.sendMessage(chatId, menu.texto, menu.options).catch(err => console.error("Erro sendMainMenu:", err));
}

// EDITA UMA MENSAGEM EXISTENTE (quando clicas no botão "Voltar")
function editToMainMenu(chatId, messageId, playerName, isGroup, isLoggedIn) {
    const menu = getMainMenuMarkup(playerName, isGroup, isLoggedIn);
    bot.editMessageText(menu.texto, { chat_id: chatId, message_id: messageId, ...menu.options }).catch(() => {});
}

// ==========================================
// FUNÇÕES ESPECIAIS (CHART, NOVIDADES, FOTOS)
// ==========================================

async function handleChartCommand(chatId) {
    bot.sendMessage(chatId, "📈 <i>A consultar o Top Global...</i>", { parse_mode: 'HTML' });
    const { data: songs, error } = await supabase.from('songs').select('id, title, streams, previous_rank, artist_ids').order('streams', { ascending: false }).limit(10);
    if (error || !songs || songs.length === 0) return bot.sendMessage(chatId, "😔 Chart indisponível.");
    
    let chartMsg = `🏆 <b>CHART DIÁRIO GLOBAL (TOP 10)</b> 🏆\n\n`;
    for (const [index, s] of songs.entries()) {
        const posicaoAtual = index + 1;
        let trend = "➖";
        if (!s.previous_rank) trend = "🆕";
        else if (posicaoAtual < s.previous_rank) trend = "🔺";
        else if (posicaoAtual > s.previous_rank) trend = "🔻";

        let artistName = "Artista Desconhecido";
        const artistIds = parseArtistIds(s.artist_ids);
        if (artistIds.length > 0) {
            const { data: artist } = await supabase.from('artists').select('name').eq('id', artistIds[0]).single();
            if (artist) artistName = artist.name;
        }

        let medalha = posicaoAtual === 1 ? "🥇" : posicaoAtual === 2 ? "🥈" : posicaoAtual === 3 ? "🥉" : `<b>${posicaoAtual}.</b>`;
        chartMsg += `${medalha} <b>${s.title}</b> - ${artistName} \n└ ${trend} • <i>${formatNumber(s.streams)} streams</i>\n\n`;
    }
    return bot.sendMessage(chatId, chartMsg, { parse_mode: 'HTML' });
}

async function handleNovidades(chatId) {
    bot.sendMessage(chatId, "🌟 <i>A reunir as últimas novidades da Agência...</i>", { parse_mode: 'HTML' });
    try {
        let encontrouNovidades = false;
        const { data: albums } = await supabase.from('albums').select('id, title, image_url, release_date, artist_id').not('release_date', 'is', null).order('release_date', { ascending: false }).limit(3);
        const { data: singles } = await supabase.from('singles').select('id, title, image_url, release_date, artist_id').not('release_date', 'is', null).order('release_date', { ascending: false }).limit(3);
        
        let releases = [];
        if (albums) releases.push(...albums.map(a => ({...a, type: 'Álbum'})));
        if (singles) releases.push(...singles.map(s => ({...s, type: 'Single'})));
        releases.sort((a, b) => new Date(b.release_date) - new Date(a.release_date));
        releases = releases.slice(0, 3);
        
        if (releases.length > 0) {
            encontrouNovidades = true;
            await bot.sendMessage(chatId, "💿 <b>ÚLTIMOS LANÇAMENTOS:</b>", { parse_mode: 'HTML' });
            for (const item of releases) {
                let artistName = "Artista Desconhecido";
                if (item.artist_id) {
                    const { data: art } = await supabase.from('artists').select('name').eq('id', item.artist_id).single();
                    if (art) artistName = art.name;
                }
                const dataStr = new Date(item.release_date).toLocaleDateString('pt-BR');
                const legenda = `🌟 <b>NOVO LANÇAMENTO</b>\n\n💿 <b>${item.title}</b> (${item.type})\n👤 Artista: <b>${artistName}</b>\n📅 Data: ${dataStr}`;
                const foto = item.image_url || "https://i.imgur.com/AD3MbBi.png";
                await bot.sendPhoto(chatId, foto, { caption: legenda, parse_mode: 'HTML' });
            }
        }

        await new Promise(resolve => setTimeout(resolve, 500)); 

        const { data: artists } = await supabase.from('artists').select('id, name, image_url, rpg_points').order('id', { ascending: false }).limit(3);
        if (artists && artists.length > 0) {
            encontrouNovidades = true;
            await bot.sendMessage(chatId, "👤 <b>NOVOS ARTISTAS NA AGÊNCIA:</b>", { parse_mode: 'HTML' });
            for (const artist of artists) {
                const legenda = `🌟 <b>NOVO ARTISTA</b>\n\n👤 <b>${artist.name}</b>\n✨ Pontos RPG Iniciais: <b>${artist.rpg_points || 0}</b>`;
                const foto = artist.image_url || "https://i.imgur.com/AD3MbBi.png";
                await bot.sendPhoto(chatId, foto, { caption: legenda, parse_mode: 'HTML' });
            }
        }

        if (!encontrouNovidades) bot.sendMessage(chatId, "😔 Nenhuma novidade encontrada no catálogo de momento.");
    } catch (error) { bot.sendMessage(chatId, "❌ Ocorreu um erro ao procurar as novidades."); }
}

async function handlePersonagens(chatId, userId) {
    const player = userSessions[userId];
    const artistIds = parseArtistIds(player.artist_ids);
    if (artistIds.length === 0) return bot.sendMessage(chatId, "A tua agência está vazia. Usa a opção 'Criar Personagem' no privado!");

    const { data: artists } = await supabase.from('artists').select('*').in('id', artistIds);
    for (const artist of artists) {
        const legenda = `👤 <b>${artist.name}</b>\n✨ Pontos RPG: <b>${artist.rpg_points || 0}</b> | 💎 Pessoais: <b>${artist.personal_points || 0}</b>`;
        const foto = artist.image_url || "https://i.imgur.com/AD3MbBi.png";
        await bot.sendPhoto(chatId, foto, { caption: legenda, parse_mode: 'HTML' });
    }
}

// ==========================================
// PROCESSAMENTO DOS CLIQUES (BOTÕES/CALLBACKS)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id; 
    const userId = query.from.id;
    const data = query.data;
    const isGroup = query.message.chat.type === 'group' || query.message.chat.type === 'supergroup';

    // Lista de comandos que precisam de estar "logados"
    const comandosRestritos = ["menu_personagens", "menu_acoes", "menu_config", "cmd_criar_personagem", "cfg_", "ed_art_", "act_", "sel_art_", "promosong_"];
    const isRestrito = comandosRestritos.some(prefix => data.startsWith(prefix));

    if (!userSessions[userId] && isRestrito) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Inicia sessão com /start no meu chat privado primeiro!", show_alert: true });
    }

    // Segurança para Grupos: O botão só funciona se a pessoa que clicou for o dono do Artista
    if (data.startsWith("sel_art_") || data.startsWith("act_") || data.startsWith("ed_art_")) {
        let targetArtistId = "";
        if (data.startsWith("sel_art_")) targetArtistId = data.replace("sel_art_", "");
        else if (data.startsWith("act_")) targetArtistId = data.match(/act_(.*)_([^_]+-[^_]+-[^_]+-[^_]+-[^_]+)$/)?.[2];
        else if (data.startsWith("ed_art_")) targetArtistId = data.replace("ed_art_", "");

        const myArtistIds = parseArtistIds(userSessions[userId].artist_ids);
        if (!myArtistIds.includes(targetArtistId)) {
            return bot.answerCallbackQuery(query.id, { text: "❌ Não podes interagir com um personagem que não te pertence!", show_alert: true });
        }
    }

    bot.answerCallbackQuery(query.id);

    // VOLTAR / RECONSTRUIR MENU (EDITAR)
    if (data === "menu_voltar") return editToMainMenu(chatId, messageId, userSessions[userId]?.name || "Visitante", isGroup, !!userSessions[userId]);
    
    if (data === "cmd_login") {
        pendingStates[userId] = { type: 'LOGIN_NAME' };
        return bot.editMessageText(`👋 <b>Bem-vindo!</b>\n\nDigita o teu <b>Nome de Jogador</b> no campo de texto:`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }

    // NOVIDADES, CHART E PERSONAGENS (GERAM FOTOS NOVAS)
    if (data === "menu_novidades") return handleNovidades(chatId);
    if (data === "menu_chart") return handleChartCommand(chatId);
    if (data === "menu_personagens") return handlePersonagens(chatId, userId);
    
    // MENU CONFIGURAÇÕES (EDITAR)
    if (data === "menu_config") {
        const texto = `⚙️ <b>CONFIGURAÇÕES</b>\n\nAqui podes editar os teus dados de jogador e personalizar os teus artistas:`;
        const teclado = {
            inline_keyboard: [
                [{ text: "✏️ Alterar Meu Nome", callback_data: "cfg_edit_p_name" }, { text: "🔒 Alterar Senha", callback_data: "cfg_edit_p_pass" }],
                [{ text: "🖼️ Editar Meus Personagens", callback_data: "cfg_edit_art_list" }],
                [{ text: "⬅️ Voltar", callback_data: "menu_voltar" }]
            ]
        };
        return bot.editMessageText(texto, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: teclado }).catch(() => {});
    }

    if (data === "cmd_criar_personagem" && !isGroup) {
        pendingStates[userId] = { type: 'CREATE_ARTIST_NAME' };
        return bot.editMessageText("➕ <b>Novo Personagem</b>\n\nDigita o nome do teu novo artista/grupo no campo de texto:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }

    if (data === "cfg_edit_p_name" && !isGroup) {
        pendingStates[userId] = { type: 'EDIT_PLAYER_NAME' };
        return bot.editMessageText("✏️ Digita o teu NOVO Nome de Jogador no campo de texto:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }

    if (data === "cfg_edit_p_pass" && !isGroup) {
        pendingStates[userId] = { type: 'EDIT_PLAYER_PASS' };
        return bot.editMessageText("🔒 Digita a tua NOVA Senha no campo de texto:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }

    if (data === "cfg_edit_art_list" && !isGroup) {
        const artistIds = parseArtistIds(userSessions[userId].artist_ids);
        if(artistIds.length === 0) return bot.editMessageText("Não tens personagens para editar.", { chat_id: chatId, message_id: messageId }).catch(() => {});
        const { data: artists } = await supabase.from('artists').select('id, name').in('id', artistIds);
        
        const teclado = { inline_keyboard: artists.map(a => [{ text: `✏️ ${a.name}`, callback_data: `ed_art_${a.id}` }]) };
        teclado.inline_keyboard.push([{ text: "⬅️ Voltar", callback_data: "menu_config" }]);
        return bot.editMessageText("Qual o personagem que desejas editar?", { chat_id: chatId, message_id: messageId, reply_markup: teclado }).catch(() => {});
    }

    if (data.startsWith("ed_art_") && !isGroup) {
        const artistId = data.replace("ed_art_", "");
        const teclado = {
            inline_keyboard: [
                [{ text: "📝 Editar Nome", callback_data: `do_ed_art_name_${artistId}` }, { text: "🖼️ Editar Foto", callback_data: `do_ed_art_foto_${artistId}` }],
                [{ text: "⬅️ Voltar", callback_data: "cfg_edit_art_list" }]
            ]
        };
        return bot.editMessageText("⚙️ <b>O que pretendes alterar neste personagem?</b>", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: teclado }).catch(() => {});
    }

    if (data.startsWith("do_ed_art_name_") && !isGroup) {
        pendingStates[userId] = { type: 'EDIT_ARTIST_NAME', artistId: data.replace("do_ed_art_name_", "") };
        return bot.editMessageText("✏️ Digita o NOVO NOME do personagem no campo de texto:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }
    if (data.startsWith("do_ed_art_foto_") && !isGroup) {
        pendingStates[userId] = { type: 'EDIT_ARTIST_PHOTO', artistId: data.replace("do_ed_art_foto_", "") };
        return bot.editMessageText("🖼️ Envia o NOVO URL da foto do personagem no campo de texto:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    }

    // ==========================================
    // MENU DE AÇÕES - 3 PASSOS (EDITA A MENSAGEM ATÉ AO FIM)
    // ==========================================
    
    // Passo 1: Escolher o Artista (a partir do botão "⚡ Ações")
    if (data === "menu_acoes") {
        const player = userSessions[userId];
        const artistIds = parseArtistIds(player.artist_ids);
        if (artistIds.length === 0) return bot.editMessageText("Precisas de ter um personagem primeiro!", { chat_id: chatId, message_id: messageId }).catch(() => {});

        const { data: artists } = await supabase.from('artists').select('id, name').in('id', artistIds);
        const teclado = { inline_keyboard: artists.map(a => [{ text: `👤 ${a.name}`, callback_data: `sel_art_${a.id}` }]) };
        teclado.inline_keyboard.push([{ text: "⬅️ Voltar", callback_data: "menu_voltar" }]);
        return bot.editMessageText("⚡ <b>SISTEMA DE PROMOÇÃO</b>\nEscolhe o artista:", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: teclado }).catch(() => {});
    }

    // Passo 2: Escolher o Tipo de Promoção
    if (data.startsWith("sel_art_")) {
        const artistId = data.replace("sel_art_", "");
        const teclado = {
            inline_keyboard: [
                [{ text: "📺 TV", callback_data: `act_promo_tv_count_${artistId}` }, { text: "📻 Rádio", callback_data: `act_promo_radio_count_${artistId}` }],
                [{ text: "📱 Internet", callback_data: `act_promo_internet_count_${artistId}` }, { text: "🛍️ Comercial", callback_data: `act_promo_commercial_count_${artistId}` }],
                [{ text: "🎛️ Remix", callback_data: `act_remix_count_${artistId}` }, { text: "🎬 MV", callback_data: `act_mv_count_${artistId}` }],
                [{ text: "📸 Capas", callback_data: `act_capas_count_${artistId}` }, { text: "🤝 Parcerias", callback_data: `act_parceria_count_${artistId}` }],
                [{ text: "⬅️ Voltar", callback_data: "menu_acoes" }]
            ]
        };
        return bot.editMessageText("🎯 <b>Qual ação de promoção desejas realizar?</b>", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: teclado }).catch(() => {});
    }

    // Passo 3: Escolher a Música (Só se houver limite)
    if (data.startsWith("act_")) {
        const match = data.match(/act_(.*)_([^_]+-[^_]+-[^_]+-[^_]+-[^_]+)$/);
        if (match) {
            const actionKey = match[1]; 
            const artistId = match[2];
            
            const LIMITES_ACOES = {
                'promo_tv_count': { limit: 20, minStreams: 35000, maxStreams: 350000, name: 'Televisão 📺' }, 
                'promo_radio_count': { limit: 20, minStreams: 20000, maxStreams: 50000, name: 'Rádio 📻' },
                'promo_commercial_count': { limit: 10, minStreams: 60000, maxStreams: 180000, name: 'Comercial 🛍️' }, 
                'promo_internet_count': { limit: 30, minStreams: 10000, maxStreams: 210000, name: 'Internet 📱' },
                'remix_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Remix 🎛️' }, 
                'mv_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Music Video (MV) 🎬' },
                'capas_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Capas de Revista 📸' }, 
                'parceria_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Parcerias com Marcas 🤝' }
            };

            const configDaAcao = LIMITES_ACOES[actionKey];
            const { data: artist } = await supabase.from('artists').select('*').eq('id', artistId).single();
            const countAtual = artist[actionKey] || 0;

            if (countAtual >= configDaAcao.limit) {
                return bot.editMessageText(`❌ <b>Limite Atingido!</b>\nO personagem <b>${artist.name}</b> já atingiu o limite semanal de ${configDaAcao.limit}/${configDaAcao.limit} para ${configDaAcao.name}.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: `sel_art_${artistId}` }]] } }).catch(() => {});
            }

            const { data: allSongs } = await supabase.from('songs').select('id, title, artist_ids');
            const artistSongs = allSongs.filter(s => parseArtistIds(s.artist_ids).includes(artistId));

            if (!artistSongs || artistSongs.length === 0) {
                return bot.editMessageText(`❌ <b>${artist.name}</b> não tem músicas lançadas para divulgar!`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: `sel_art_${artistId}` }]] } }).catch(() => {});
            }

            pendingStates[userId] = {
                type: 'SELECT_PROMO_SONG',
                actionKey: actionKey,
                artistId: artistId,
                artistName: artist.name,
                artistImg: artist.image_url,
                countAtual: countAtual
            };

            const teclado = { inline_keyboard: [] };
            for (let i = 0; i < Math.min(artistSongs.length, 30); i += 2) {
                const row = [];
                row.push({ text: `🎵 ${artistSongs[i].title}`, callback_data: `promosong_${artistSongs[i].id}` });
                if (i + 1 < artistSongs.length) {
                    row.push({ text: `🎵 ${artistSongs[i+1].title}`, callback_data: `promosong_${artistSongs[i+1].id}` });
                }
                teclado.inline_keyboard.push(row);
            }
            teclado.inline_keyboard.push([{ text: "⬅️ Cancelar", callback_data: `sel_art_${artistId}` }]);

            bot.editMessageText(`🎯 <b>Qual música do(a) ${artist.name} vai ser divulgada em ${configDaAcao.name}?</b>\n\n<i>(Isto vai gerar streams para a música selecionada)</i>`, { 
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: teclado 
            }).catch(() => {});
        }
    }

    // Passo 4 (Final): Processar a ação, fazer os cálculos matemáticos e ENVIAR MENSAGEM NOVA COM FOTO
    if (data.startsWith("promosong_")) {
        const songId = data.replace("promosong_", "");
        const state = pendingStates[userId];

        if (!state || state.type !== 'SELECT_PROMO_SONG') {
            return bot.sendMessage(chatId, "❌ Sessão expirou. Por favor, começa de novo pelo /menu.");
        }

        const LIMITES_ACOES = {
            'promo_tv_count': { limit: 20, minStreams: 35000, maxStreams: 350000, name: 'Televisão 📺' }, 
            'promo_radio_count': { limit: 20, minStreams: 20000, maxStreams: 50000, name: 'Rádio 📻' },
            'promo_commercial_count': { limit: 10, minStreams: 60000, maxStreams: 180000, name: 'Comercial 🛍️' }, 
            'promo_internet_count': { limit: 30, minStreams: 10000, maxStreams: 210000, name: 'Internet 📱' },
            'remix_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Remix 🎛️' }, 
            'mv_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Music Video (MV) 🎬' },
            'capas_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Capas de Revista 📸' }, 
            'parceria_count': { limit: 5, minStreams: 60000, maxStreams: 450000, name: 'Parcerias com Marcas 🤝' }
        };

        const configDaAcao = LIMITES_ACOES[state.actionKey];
        const { data: song } = await supabase.from('songs').select('title, streams').eq('id', songId).single();

        const streamsGanhos = Math.floor(Math.random() * (configDaAcao.maxStreams - configDaAcao.minStreams + 1)) + configDaAcao.minStreams;
        const novoStreams = (song.streams || 0) + streamsGanhos;
        const novoActionCount = state.countAtual + 1;

        await supabase.from('songs').update({ streams: novoStreams }).eq('id', songId);
        await supabase.from('artists').update({ [state.actionKey]: novoActionCount }).eq('id', state.artistId);

        delete pendingStates[userId];

        // Edita o balão atual dizendo que completou, e reconstrói o menu inicial nele para o jogador poder continuar a jogar rapidamente
        editToMainMenu(chatId, messageId, userSessions[userId].name, isGroup, true);
        
        // Atira a fotografia por cima como "recompensa visual"
        const foto = state.artistImg || "https://i.imgur.com/AD3MbBi.png";
        bot.sendPhoto(chatId, foto, { 
            caption: `✅ <b>AÇÃO DE PROMOÇÃO CONCLUÍDA!</b>\n\nO personagem <b>${state.artistName}</b> promoveu a música <b>${song.title}</b> em: <b>${configDaAcao.name}</b>.\n\n📈 Streams Ganhos: <b>+${formatNumber(streamsGanhos)}</b>\n💿 Streams Diários da Música: <b>${formatNumber(novoStreams)}</b>\n📊 Limite Semanal da Ação: <b>${novoActionCount}/${configDaAcao.limit}</b>`, 
            parse_mode: 'HTML' 
        });
    }
});

console.log('🤖 Bot do RPG iniciado com sucesso!');
