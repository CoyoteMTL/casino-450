import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { ensureUser, escrow, creditWin, refund } from '../db.js';
import { logToCasino, logHorseResolution } from '../lib/logger.js';
import { now, randInt, sleep } from '../lib/utils.js';

// 1 course active par salon
const races = new Map();

// --- Helpers ---
async function closeBets(client, state, reason = 'timer') {
  const current = races.get(state.channelId);
  if (!current) return;
  if (current.status !== 'OPEN') return;

  current.status = 'BET_CLOSED';
  races.set(state.channelId, current);

  // Met à jour le message original de création si possible
  try {
    const channel = await client.channels.fetch(current.channelId);
    if (channel?.isTextBased?.() && current.messageId) {
      const msg = await channel.messages.fetch(current.messageId);
      const embed = new EmbedBuilder()
        .setTitle('🏇 Paris fermés')
        .setDescription(
          [
            `• **Distance**: ${current.distance} cases`,
            `• **Chevaux**: ${current.numHorses} (IDs: 1 à ${current.numHorses})`,
            `• **Paris fermés** (${reason})`,
            `• Pot actuel: **${current.totals}**`,
            '• Utilise `/chevaux demarrer` pour lancer la course.',
          ].join('\n')
        )
        .setFooter({ text: `Race ID: ${current.raceId}` })
        .setTimestamp();

      await msg.edit({ embeds: [embed] });
    }
  } catch {
    // Pas critique (permissions / message supprimé / etc.)
  }
}

function scheduleBetClose(client, state) {
  const delay = Math.max(0, state.closesAt - now());
  state.closeTimer = setTimeout(() => {
    closeBets(client, state, 'timer').catch(() => {});
  }, delay);
}

export async function handleHorseCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  // /chevaux creer
  if (interaction.commandName === 'chevaux' && interaction.options.getSubcommand() === 'creer') {
    const gid = interaction.guildId;
    const cid = interaction.channelId;
    const uid = interaction.user.id;

    if (races.has(cid)) {
      const r = races.get(cid);
      if (r.status !== 'CLOSED' && r.status !== 'CANCELLED') {
        await interaction.reply({ content: 'Il y a déjà une course active dans ce salon.', ephemeral: true });
        return true;
      }
    }

    const distance = interaction.options.getInteger('distance') ?? 20;
    const numHorses = interaction.options.getInteger('chevaux') ?? 5;
    const windowSec = interaction.options.getInteger('temps') ?? 30;

    const closesAt = now() + windowSec * 1000;
    const state = {
      raceId: `${gid}:${cid}:${now()}`,
      guildId: gid,
      channelId: cid,
      hostId: uid,
      status: 'OPEN',
      distance,
      numHorses,
      closesAt,
      bets: new Map(),
      takenHorses: new Set(),
      totals: 0,
      progress: Array.from({ length: numHorses }, () => 0),
      messageId: null,
      closeTimer: null,
    };

    races.set(cid, state);

    const embed = new EmbedBuilder()
      .setTitle('🏇 Course créée — Paris ouverts')
      .setDescription(
        [
          `• **Distance**: ${distance} cases`,
          `• **Chevaux**: ${numHorses} (IDs: 1 à ${numHorses})`,
          `• **Clôture des paris**: <t:${Math.floor(closesAt / 1000)}:R>`,
          `• Une seule **personne par cheval**.`,
          `• Commande: \`/parier cheval:<id> mise:<montant>\``,
        ].join('\n')
      )
      .setFooter({ text: `Race ID: ${state.raceId}` })
      .setTimestamp();

    const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
    state.messageId = msg?.id ?? null;

    // fermeture auto des paris
    scheduleBetClose(interaction.client, state);

    return true;
  }

  // /parier
  if (interaction.commandName === 'parier') {
    const gid = interaction.guildId;
    const cid = interaction.channelId;
    const uid = interaction.user.id;

    const state = races.get(cid);
    if (!state) {
      await interaction.reply({ content: 'Aucune course ouverte pour parier ici.', ephemeral: true });
      return true;
    }

    // deadline atteinte → fermeture auto
    if (now() >= state.closesAt) {
      await closeBets(interaction.client, state, 'deadline');
    }

    if (state.status === 'BET_CLOSED') {
      await interaction.reply({ content: '⛔ Paris fermés. Utilise `/chevaux demarrer` pour lancer la course.', ephemeral: true });
      return true;
    }

    if (state.status !== 'OPEN') {
      await interaction.reply({ content: 'Aucune course ouverte pour parier ici.', ephemeral: true });
      return true;
    }

    const horseId = interaction.options.getInteger('cheval', true);
    const stake = interaction.options.getInteger('mise', true);

    if (horseId < 1 || horseId > state.numHorses) {
      await interaction.reply({ content: `Cheval invalide. Choisis entre 1 et ${state.numHorses}.`, ephemeral: true });
      return true;
    }
    if (state.takenHorses.has(horseId)) {
      await interaction.reply({ content: 'Ce cheval est déjà pris par un autre joueur.', ephemeral: true });
      return true;
    }

    // Vérif solde + escrow
    const u = ensureUser(gid, uid);
    if (u.balance < stake) {
      await interaction.reply({ content: `Solde insuffisant. Ton solde: **${u.balance}**`, ephemeral: true });
      return true;
    }

    const esc = escrow(gid, uid, stake, { game: 'horse', raceId: state.raceId, horseId });
    if (!esc.ok) {
      await interaction.reply({ content: esc.message || 'Impossible de débiter la mise.', ephemeral: true });
      return true;
    }

    state.bets.set(uid, { horseId, stake });
    state.takenHorses.add(horseId);
    state.totals += stake;

    await logToCasino(interaction.guild, {
      embeds: [
        new EmbedBuilder()
          .setTitle('🏇 Log — Pari')
          .setDescription([
            `Joueur: <@${uid}>`,
            `Cheval: **#${horseId}**`,
            `Mise: **${stake}**`,
            `Pot: **${state.totals}**`,
            `Course: \`${state.raceId}\``,
          ].join('\n'))
          .setTimestamp(),
      ],
    });

    await interaction.reply({ content: `✅ Pari enregistré: **${stake}** sur le cheval **#${horseId}**. Pot actuel: **${state.totals}**` });
    return true;
  }

  // /chevaux demarrer
  if (interaction.commandName === 'chevaux' && interaction.options.getSubcommand() === 'demarrer') {
    const gid = interaction.guildId;
    const cid = interaction.channelId;
    const uid = interaction.user.id;

    const state = races.get(cid);
    if (!state || (state.status !== 'OPEN' && state.status !== 'BET_CLOSED')) {
      await interaction.reply({ content: 'Aucune course ouverte ici.', ephemeral: true });
      return true;
    }

    // Si on démarre après la deadline, on s'assure que les paris sont fermés
    if (state.status === 'OPEN' && now() >= state.closesAt) {
      await closeBets(interaction.client, state, 'deadline');
    }

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (uid !== state.hostId && !isAdmin) {
      await interaction.reply({ content: 'Seul le créateur ou un Prestigieux+ peut démarrer.', ephemeral: true });
      return true;
    }

    // stop timer de fermeture auto si encore actif
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
    }

    state.status = 'LOCKED';

    // Si aucun pari → annulation
    if (state.bets.size === 0) {
      state.status = 'CANCELLED';
      races.set(cid, state);

      await logToCasino(interaction.guild, {
        embeds: [
          new EmbedBuilder()
            .setTitle('🏇 Log — Annulation (zéro pari)')
            .setDescription([`Course: \`${state.raceId}\``, `Salon: <#${cid}>`].join('\n'))
            .setTimestamp(),
        ],
      });

      await interaction.reply({ content: 'Aucun pari - Course annulée.' });
      return true;
    }

    // Compte à rebours
    await interaction.reply({ content: '⏳ Fermeture des paris… Départ dans **3**' });
    await sleep(800);
    await interaction.editReply({ content: '⏳ Départ dans **2**' });
    await sleep(800);
    await interaction.editReply({ content: '⏳ Départ dans **1**' });
    await sleep(800);

    // Lancer la course
    state.status = 'RUNNING';
    races.set(cid, state);

    const D = state.distance;
    const bar = (p) => {
      const clamped = Math.min(p, D);
      const filled = '■'.repeat(clamped);
      const empty = '.'.repeat(Math.max(D - clamped, 0));
      return `|${filled}${empty}| 🏁 (${clamped}/${D})`;
    };

    const render = () => {
      const lines = [];
      for (let i = 0; i < state.numHorses; i++) lines.push(`🏇 Cheval ${i + 1} ${bar(state.progress[i])}`);
      return '```\n' + lines.join('\n') + '\n```';
    };

    await interaction.editReply({
      content: 'GO !',
      embeds: [new EmbedBuilder().setTitle('🏇 Course en cours…').setDescription(render()).setTimestamp()],
    });

    // boucle d’animation
    let winner = null;
    for (let tick = 0; tick < 200; tick++) {
      for (let i = 0; i < state.numHorses; i++) state.progress[i] += randInt(0, 2);

      const reached = [];
      for (let i = 0; i < state.numHorses; i++) {
        if (state.progress[i] >= D) reached.push(i);
      }
      if (reached.length) {
        reached.sort((a, b) => state.progress[b] - state.progress[a]);
        winner = reached[0] + 1;
      }

      await sleep(800);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('🏇 Course en cours…').setDescription(render()).setTimestamp()],
      });

      if (winner !== null) break;
    }

    state.status = 'RESOLVING';

    const pot = state.totals;
    const bettors = Array.from(state.bets.entries());
    const solo = bettors.length === 1;
    const winnerBettor = bettors.find(([_, b]) => b.horseId === winner);

    if (bettors.length === 0) {
      state.status = 'CANCELLED';
      races.set(cid, state);
      await interaction.followUp({ content: 'Aucun pari — course annulée.' });
      await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'cancel_zero' });
    } else if (solo) {
      const [onlyUid, onlyBet] = bettors[0];

      if (onlyBet.horseId === winner) {
        const credit = Math.floor(onlyBet.stake * 0.5);
        creditWin(state.guildId, onlyUid, credit, { game: 'horse', raceId: state.raceId, mode: 'solo_bonus', horseId: winner, pot });
        await interaction.followUp({
          content: `🏁 **Cheval #${winner}** gagne ! Un seul joueur participait → bonus **+50%**.\n<@${onlyUid}> reçoit **+${credit}**.`,
        });

        await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'solo_win', winner, userId: onlyUid, stake: onlyBet.stake, credit });
      } else {
        await interaction.followUp({ content: `🏁 **Cheval #${winner}** gagne ! Le seul parieur avait un autre cheval → il perd sa mise.` });
        await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'solo_lose', winner, userId: onlyUid, stake: onlyBet.stake });
      }
    } else {
      if (winnerBettor) {
        const [winUid] = winnerBettor;
        creditWin(state.guildId, winUid, pot, { game: 'horse', raceId: state.raceId, mode: 'multi_pot', horseId: winner, pot });
        await interaction.followUp({ content: `🏁 **Cheval #${winner}** gagne ! <@${winUid}> avait le bon cheval et empoche **tout le pot: ${pot}**.` });
        await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'multi_win', winner, userId: winUid, pot });
      } else {
        await interaction.followUp({ content: `🏁 **Cheval #${winner}** gagne ! **Personne** n’avait misé sur le gagnant → toutes les mises sont perdues.` });
        await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'no_winner', winner, pot });
      }
    }

    state.status = 'CLOSED';
    races.set(cid, state);

    await interaction.followUp({
      embeds: [new EmbedBuilder().setTitle(`🏁 Arrivée — Gagnant: Cheval #${winner}`).setDescription(render()).setTimestamp()],
    });

    return true;
  }

  // /chevaux annuler
  if (interaction.commandName === 'chevaux' && interaction.options.getSubcommand() === 'annuler') {
    const gid = interaction.guildId;
    const cid = interaction.channelId;
    const uid = interaction.user.id;

    const state = races.get(cid);
    if (!state || (state.status !== 'OPEN' && state.status !== 'BET_CLOSED')) {
      await interaction.reply({ content: 'Aucune course ouverte annulable icite.', ephemeral: true });
      return true;
    }

    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
    }

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (uid !== state.hostId && !isAdmin) {
      await interaction.reply({ content: 'Seul le créateur ou un Prestigieux+ peut annuler.', ephemeral: true });
      return true;
    }

    for (const [uId, b] of state.bets.entries()) {
      refund(gid, uId, b.stake, { game: 'horse', raceId: state.raceId, reason: 'cancelled' });
    }

    state.status = 'CANCELLED';
    races.set(cid, state);

    await logHorseResolution(interaction.guild, { ...state, channelId: cid }, { kind: 'cancel_manual' });
    await interaction.reply({ content: 'Course annulée. Tous les paris ont été remboursés.' });
    return true;
  }

  return false;
}
