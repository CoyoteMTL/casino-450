import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { LIMITS } from '../../config/constants.js';
import { escrow, creditWin } from '../../db.js';

const { MIN_BET, MAX_BET } = LIMITS;

//cooldown antispam 
const COOLDOWN_MS = 1500;
const lastSpin = new Map(); 

//Les 5 paylines
const PAYLINES = [
    { id: 1, name: 'Haut', cells: [[0, 0], [0, 1], [0, 2]] },
    { id: 2, name: 'Milieu', cells: [[1, 0], [1, 1], [1, 2]] },
    { id: 3, name: 'Bas', cells: [[2, 0], [2, 1], [2, 2]] },
    { id: 4, name: 'Diag ↘', cells: [[0, 0], [1, 1], [2, 2]] },
    { id: 5, name: 'Diag ↗', cells: [[2, 0], [1, 1], [0, 2]] },
];

// Table (95% RTP, sur 5 lignes en moyenne)
const SYMBOLS = [
  { key: '7', emoji: '7️⃣', weight: 1, lineMult: 60, fullMult: 1000 }, // jackpot full screen
  { key: 'D', emoji: '💎', weight: 2, lineMult: 30, fullMult: 700 },
  { key: 'S', emoji: '⭐', weight: 3, lineMult: 20, fullMult: 400 },
  { key: 'B', emoji: '🔔', weight: 4, lineMult: 10, fullMult: 300 },
  { key: 'G', emoji: '🍇', weight: 6, lineMult: 6,  fullMult: 200 },
  { key: 'C', emoji: '🍒', weight: 7, lineMult: 4,  fullMult: 150 },
  { key: 'L', emoji: '🍋', weight: 8, lineMult: 3,  fullMult: 100 },
];

const TOTAL_WEIGHT = SYMBOLS.reduce((a, s) => a + s.weight, 0);

function getFullScreenSymbol(grid) {
    const k = grid[0][0].key;
    for (const row of grid) {
        for (const s of row) {
            if (s.key !== k ) return null;
        }
    }
    return grid[0][0]; // le symbole commun
}

function pickSymbol() {
    const r = crypto.randomInt(TOTAL_WEIGHT); 
    let acc = 0;
    for (const s of SYMBOLS) {
        acc += s.weight;
        if (r < acc) return s;
    }
    return SYMBOLS[SYMBOLS.length - 1];
}

function spinGrid() {
    return Array.from({ length: 3 }, () =>
        Array.from({ length: 3}, () => pickSymbol())
    );
}

function evaluate(grid, bet) {
  // ✅ FULL SCREEN (9 mêmes symboles)
  const full = getFullScreenSymbol(grid);
  if (full) {
    const payout = bet * full.fullMult;
    return {
      hits: [
        {
          kind: 'FULL_SCREEN',
          label: 'FULL SCREEN',
          symbol: full.emoji,
          mult: full.fullMult,
          amount: payout,
        },
      ],
      payout,
      jackpot: full.key === '7', // full screen de 7 = mega jackpot
    };
  }

  // Sinon: paylines normales
  const hits = [];
  let jackpot = false;

  for (const line of PAYLINES) {
    const [a, b, c] = line.cells.map(([r, col]) => grid[r][col]);
    if (a.key === b.key && b.key === c.key) {
      let mult = a.lineMult;

      // ✅ Jackpot boost : 7-7-7 SUR LA LIGNE DU MILIEU (id=2 dans ton code)
      if (a.key === '7' && line.id === 2) {
        mult = 600;      // au lieu de 60
        jackpot = true;
      }

      const amount = bet * mult;
      hits.push({
        kind: 'PAYLINE',
        lineId: line.id,
        lineName: line.name,
        symbol: a.emoji,
        mult,
        amount,
      });
    }
  }

  const payout = hits.reduce((sum, h) => sum + h.amount, 0);
  return { hits, payout, jackpot };
}

function renderGrid(grid) {
  // Affiche 3 lignes
  return [
    `${grid[0][0].emoji} ${grid[0][1].emoji} ${grid[0][2].emoji}`,
    `${grid[1][0].emoji} ${grid[1][1].emoji} ${grid[1][2].emoji}`,
    `${grid[2][0].emoji} ${grid[2][1].emoji} ${grid[2][2].emoji}`,
  ].join('\n');
}

function cooldownKey(gid, uid) {
  return `${gid}:${uid}`;
}

function checkCooldown(gid, uid) {
  const key = cooldownKey(gid, uid);
  const t = lastSpin.get(key) || 0;
  const now = Date.now();
  if (now - t < COOLDOWN_MS) return { ok: false, waitMs: COOLDOWN_MS - (now - t) };
  lastSpin.set(key, now);
  return { ok: true };
}

function buildButtons(bet, ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`slots_again:${bet}:${ownerId}`)
      .setLabel('Rejouer')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`slots_table:${ownerId}`)
      .setLabel('Table des gains')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildPayoutTable() {
  const lines = SYMBOLS.map((s) => `${s.emoji} x3 (ligne) = **${s.lineMult}x**`);
  lines.push('');
  lines.push('🖥️ **JACKPOT FULL SCREEN (9 identiques)**');
  for (const s of SYMBOLS) lines.push(`${s.emoji} full = **${s.fullMult}x**`);
  lines.push('');
  lines.push('💥 **JACKPOT LIGNE**: 7️⃣7️⃣7️⃣ sur **ligne milieu** = **600x**');
  return lines.join('\n');
}

// LOGS Slots Gagnant
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const MIN_NET_LOG =0;

async function logSlotsWin(interaction, { bet, payout, net, grid, hits, jackpot}) {
    if (!LOG_CHANNEL_ID) return;
    if (payout <= 0) return;

    //antiflood
    if (!jackpot && net < MIN_NET_LOG) return;

    try {
        const logChannel = await interaction.client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased?.()) return;

        const lines = hits
        .map((h) => {
            if (h.kind === 'FULL_SCREEN') {
                return  `• 🖥️ **FULL SCREEN** — ${h.symbol} **${h.mult}x** = **+${h.amount}**`;
            }
            return `• Ligne ${h.lineId} (${h.lineName}) — ${h.symbol} **${h.mult}x** = **+${h.amount}**`;
        })
        .join ('\n');

        const msg = [
            jackpot ? '💥 **JACKPOT SLOTS**' : '🎰 **Slots Win**',
            `👤 Joueur: ${interaction.user} (${interaction.user.id})`,
            `💰 Mise: **${bet}** | Gain: **${payout}** | Net: **${net >= 0 ? '+' : ''}${net}**`,
            '```',
            renderGrid(grid),
            '```',
            lines || '(win sans détail)',
        ].join('\n');

        await logChannel.send({ content: msg });
    } catch {

    }
}

export async function handleSlotsCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'slots') return false;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Utilisable seulement sur un serveur.', ephemeral: true });
    return true;
  }

  const gid = interaction.guildId;
  const uid = interaction.user.id;

  const cd = checkCooldown(gid, uid);
  if (!cd.ok) {
    const s = Math.ceil(cd.waitMs / 1000);
    await interaction.reply({ content: `⏳ Doucement! Réessaie dans **${s}s**.`, ephemeral: true });
    return true;
  }

  const bet = Math.trunc(interaction.options.getInteger('mise', true));
  if (!Number.isFinite(bet) || bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({ content: `Mise invalide. (${MIN_BET} à ${MAX_BET})`, ephemeral: true });
    return true;
  }

  // Débit immédiat (escrow)
  const esc = escrow(gid, uid, bet, { game: 'slots', bet });
  if (!esc.ok) {
    await interaction.reply({ content: `⛔ ${esc.message || 'Solde insuffisant'}`, ephemeral: true });
    return true;
  }

  const grid = spinGrid();
  const { hits, payout } = evaluate(grid, bet);

  let finalUser = esc.user;
  if (payout > 0) {
    finalUser = creditWin(gid, uid, payout, {
      game: 'slots',
      bet,
      payout,
      hits,
      grid: grid.map((row) => row.map((s) => s.key)),
    });
  }

  const net = payout - bet;

  const desc = [
    '```',
    renderGrid(grid),
    '```',
    hits.length
      ? `✅ **Lignes gagnantes**:\n${hits.map((h) => `• Ligne ${h.lineId} (${h.lineName}) — ${h.symbol} **${h.mult}x** = **+${h.amount}**`).join('\n')}`
      : '❌ **Aucune ligne gagnante.**',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🎰 Slots — 5 lignes')
    .setDescription(desc)
    .addFields(
      { name: 'Mise', value: `${bet}`, inline: true },
      { name: 'Gain', value: `${payout}`, inline: true },
      { name: 'Net', value: `${net >= 0 ? '+' : ''}${net}`, inline: true },
      { name: 'Solde', value: `${finalUser?.balance ?? '—'}`, inline: true }
    )
    .setFooter({ text: 'Paylines: Haut • Milieu • Bas • Diag↘ • Diag↗' })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    components: [buildButtons(bet, uid)],
  });

  if (payout > 0) {
    await logSlotsWin(interaction, { bet, payout, net, grid, hits, jackpot});
  }
  return true;
}

export async function handleSlotsButton(interaction) {
  if (!interaction.isButton()) return false;

  // Rejouer
  if (interaction.customId.startsWith('slots_again:')) {
    const [, betStr, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: '⛔ Pas ton spin.', ephemeral: true });
      return true;
    }

    const gid = interaction.guildId;
    const uid = interaction.user.id;

    const cd = checkCooldown(gid, uid);
    if (!cd.ok) {
      const s = Math.ceil(cd.waitMs / 1000);
      await interaction.reply({ content: `⏳ Doucement! Réessaie dans **${s}s**.`, ephemeral: true });
      return true;
    }

    const bet = Math.trunc(Number(betStr));
    if (!Number.isFinite(bet) || bet < MIN_BET || bet > MAX_BET) {
      await interaction.reply({ content: 'Mise invalide.', ephemeral: true });
      return true;
    }

    const esc = escrow(gid, uid, bet, { game: 'slots', bet });
    if (!esc.ok) {
      await interaction.reply({ content: `⛔ ${esc.message || 'Solde insuffisant'}`, ephemeral: true });
      return true;
    }

    const grid = spinGrid();
    const { hits, payout, jackpot } = evaluate(grid, bet);

    let finalUser = esc.user;
    if (payout > 0) {
      finalUser = creditWin(gid, uid, payout, {
        game: 'slots',
        bet,
        payout,
        hits,
        grid: grid.map((row) => row.map((s) => s.key)),
      });
    }

    const net = payout - bet;

   const hitsText = hits.length
  ? `✅ **Gains**:\n${hits
      .map((h) => {
        if (h.kind === 'FULL_SCREEN') {
          return `• 🖥️ **${h.label}** — ${h.symbol} **${h.mult}x** = **+${h.amount}**`;
        }
        return `• Ligne ${h.lineId} (${h.lineName}) — ${h.symbol} **${h.mult}x** = **+${h.amount}**`;
      })
      .join('\n')}`
  : '❌ **Aucun gain.**';

    const desc = [
         jackpot ? '💥 **JACKPOT !**' : null,
        '```',
        renderGrid(grid),
         '```',
         hitsText,
        ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🎰 Slots — 5 lignes')
      .setDescription(desc)
      .addFields(
        { name: 'Mise', value: `${bet}`, inline: true },
        { name: 'Gain', value: `${payout}`, inline: true },
        { name: 'Net', value: `${net >= 0 ? '+' : ''}${net}`, inline: true },
        { name: 'Solde', value: `${finalUser?.balance ?? '—'}`, inline: true }
      )
      .setFooter({ text: 'Paylines: Haut • Milieu • Bas • Diag↘ • Diag↗\n⚠️ Les colonnes verticales ne sont pas payantes' })
      .setTimestamp();

    await interaction.update({
      embeds: [embed],
      components: [buildButtons(bet, ownerId)],
    });

    if (payout > 0) {
        await logSlotsWin(interaction, { bet, payout, net, grid, hits, jackpot });
    }
    return true;
  }

  // Table des gains
  if (interaction.customId.startsWith('slots_table:')) {
    const [, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: '⛔ Pas ton menu.', ephemeral: true });
      return true;
    }

    await interaction.reply({
      content: `📜 **Table des gains (3 identiques sur une ligne horizontale ou diagonale)**\n${buildPayoutTable()}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}