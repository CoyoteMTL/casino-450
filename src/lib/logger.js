import { EmbedBuilder } from 'discord.js';
import { env } from '../config/env.js';

function parseLogChannelsMap(raw) {
  // format: guildId:channelId,guildId2:channelId2
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => pair.split(':').map((x) => x.trim()))
    .filter((p) => p.length === 2 && p[0] && p[1]);
  return Object.fromEntries(entries);
}

const LOGS_MAP = parseLogChannelsMap(env.logChannelsRaw);

/**
 * Envoie un payload (message/embeds) dans le salon de logs du casino.
 * Retourne true si envoyé, sinon false.
 */
export async function logToCasino(guild, payload) {
  const cid = LOGS_MAP[guild.id] || env.logChannelId || null;
  if (!cid) return false;

  const ch = guild.channels.cache.get(cid) || (await guild.channels.fetch(cid).catch(() => null));
  if (!ch?.isTextBased?.()) return false;

  try {
    await ch.send(payload);
    return true;
  } catch (e) {
    console.error('[logToCasino] Error', e);
    return false;
  }
}

// Helper: log de résolution des courses (hors du handler principal)
export async function logHorseResolution(guild, state, outcome) {
  // outcome.kind: 'solo_win'|'solo_lose'|'multi_win'|'no_winner'|'cancel_zero'|'cancel_manual'
  const lines = [
    `Course: \`${state.raceId}\``,
    state.channelId ? `Salon: <#${state.channelId}>` : null,
  ].filter(Boolean);

  switch (outcome.kind) {
    case 'cancel_zero':
      lines.push('Annulation: aucun pari');
      break;
    case 'cancel_manual':
      lines.push('Annulation manuelle (parieurs remboursés)');
      break;
    case 'solo_win':
      lines.push(
        `Gagnant: Cheval #${outcome.winner}`,
        `Joueur: <@${outcome.userId}>`,
        `Mise: **${outcome.stake}**`,
        `Crédit: **+${outcome.credit}**`
      );
      break;
    case 'solo_lose':
      lines.push(
        `Gagnant: Cheval #${outcome.winner}`,
        `Joueur (perdant): <@${outcome.userId}>`,
        `Mise perdue: **${outcome.stake}**`
      );
      break;
    case 'multi_win':
      lines.push(
        `Gagnant: Cheval #${outcome.winner}`,
        `Gagnant (joueur): <@${outcome.userId}>`,
        `Pot: **${outcome.pot}**`,
        `Crédit: **+${outcome.pot}**`
      );
      break;
    case 'no_winner':
      lines.push(
        `Gagnant: Cheval #${outcome.winner}`,
        `Pot: **${outcome.pot}**`,
        `Aucun parieur sur le gagnant → pot pour la maison`
      );
      break;
  }

  await logToCasino(guild, {
    embeds: [
      new EmbedBuilder()
        .setTitle('🏇 Course — Résolution')
        .setDescription(lines.join('\n'))
        .setFooter({ text: state.raceId })
        .setTimestamp(),
    ],
  });
}
