import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  ensureUser,
  getStats,
  topLeaderboard,
  grantStartingIfNeeded,
  faucet,
  claimDaily,
  setBalance,
  STARTING_BALANCE,
} from '../db.js';
import { logToCasino } from '../lib/logger.js';

export async function handleEconomyCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const gid = interaction.guildId;
  const uid = interaction.user.id;

  if (interaction.commandName === 'balance') {
    const u = grantStartingIfNeeded(gid, uid);
    await interaction.reply({ content: `💳 **Ton solde:** ${u.balance}` });
    return true;
  }

  if (interaction.commandName === 'faucet') {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isAdmin) {
      await interaction.reply({ content: '⛔ Réservé aux Prestigieux+.', ephemeral: true });
      return true;
    }
    const u = faucet(gid, uid);
    await interaction.reply({ content: `💧 Faucet effectué. Nouveau solde: **${u.balance}**` });
    return true;
  }

  if (interaction.commandName === 'daily') {
    const res = claimDaily(gid, uid);
    if (res.ok) {
      await interaction.reply({ content: `🎁 Daily réclamé ! Nouveau solde: **${res.user.balance}**` });
      return true;
    }
    const ms = res.remainingMs;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    await interaction.reply({ content: `⏳ Reviens dans **${h}h ${m}m** pour le prochain daily.`, ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'stats') {
    const target = interaction.options.getUser('utilisateur') ?? interaction.user;
    const s = getStats(gid, target.id);
    const wr = (s.winrate * 100).toFixed(1);
    const embed = new EmbedBuilder()
      .setTitle(`📊 Stats — ${target.tag ?? target.username}`)
      .addFields(
        { name: 'Solde', value: `${s.balance}`, inline: true },
        { name: 'Profit net', value: `${s.net_profit}`, inline: true },
        { name: 'Parties', value: `${s.games_played}`, inline: true },
        { name: 'Victoires', value: `${s.wins}`, inline: true },
        { name: 'Défaites', value: `${s.losses}`, inline: true },
        { name: 'Pushes', value: `${s.pushes}`, inline: true },
        { name: 'Blackjacks', value: `${s.blackjacks}`, inline: true },
        { name: 'Winrate', value: `${wr}%`, inline: true }
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === 'top') {
    const metric = interaction.options.getString('metric') ?? 'balance';
    const limit = interaction.options.getInteger('limite') ?? 10;
    const rows = topLeaderboard(gid, metric, Math.min(Math.max(1, limit), 20));
    if (!rows.length) {
      await interaction.reply({ content: 'Aucune donnée pour le leaderboard…' });
      return true;
    }

    let desc = '';
    if (metric === 'winrate') {
      rows.forEach((r, i) => {
        const wr = ((r.winrate || 0) * 100).toFixed(1);
        desc += `**${i + 1}.** <@${r.user_id}> — **${wr}%** (${r.wins}/${r.games_played})\n`;
      });
    } else {
      rows.forEach((r, i) => {
        const v = r.value ?? r.balance;
        desc += `**${i + 1}.** <@${r.user_id}> — **${v}** (balance:${r.balance} • profit:${r.net_profit} • W:${r.wins}/${r.games_played})\n`;
      });
    }

    const embed = new EmbedBuilder().setTitle(`🏆 Leaderboard — ${metric}`).setDescription(desc).setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === 'resetbalance') {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Utilisable seulement sur un serveur.', ephemeral: true });
      return true;
    }
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isAdmin) {
      await interaction.reply({ content: '⛔ Réservé aux Prestigieux+.', ephemeral: true });
      return true;
    }

    const target = interaction.options.getUser('utilisateur', true);
    const amount = interaction.options.getInteger('montant') ?? STARTING_BALANCE;
    const resetStats = interaction.options.getBoolean('reinitialiser_stats') ?? false;

    const beforeUser = ensureUser(gid, target.id);
    const beforeBalance = beforeUser.balance ?? 0;

    const updated = setBalance(gid, target.id, amount, resetStats, 'admin_resetbalance');
    if (!updated) {
      await interaction.reply({ content: 'Erreur lors du reset (updated vide).', ephemeral: true });
      return true;
    }

    const embed = new EmbedBuilder()
      .setTitle('♻️ Réinitialisation de solde')
      .setDescription(`Solde de ${target} mis à jour ${resetStats ? 'et stats réinitialisées' : ''}.`)
      .addFields(
        { name: 'Avant', value: `${beforeBalance}`, inline: true },
        { name: 'Après', value: `${updated.balance}`, inline: true },
        { name: 'Stats remises à zéro ?', value: resetStats ? 'Oui' : 'Non', inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === 'reglement') {
    const jeu = interaction.options.getString('jeu', true);
    const embed = buildRulesEmbed(jeu);
    if (!embed) {
      await interaction.reply({ content: 'Jeu inconnu.', ephemeral: true });
      return true;
    }
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'test-log') {
    const ok = await logToCasino(interaction.guild, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Test log')
          .setDescription(`Serveur: **${interaction.guild.name}**\nHeure: <t:${Math.floor(Date.now() / 1000)}:T>`)
          .setTimestamp(),
      ],
    });

    await interaction.reply({
      content: ok ? '✅ Message envoyé dans le salon de logs.' : '❌ Impossible d’écrire dans le salon de logs (regarde la console).',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}

function buildRulesEmbed(jeu) {
  if (jeu === 'bj') {
    return new EmbedBuilder()
      .setTitle('📜 Règlement — Blackjack')
      .setDescription(
        [
          '• Objectif : total des cartes **> croupier** sans dépasser **21**.',
          '• Valeurs : 2–10 = face ; J/Q/K = 10 ; As = 1 ou 11.',
          '• Déroulé : 2 cartes au joueur & croupier (1 cachée).',
          '• Actions : **Tirer** (Hit), **Rester** (Stand), **Doubler** (Double, uniquement avec 2 cartes si solde suffisant), **Abandon** (Surrender, ½ mise).',
          '• Croupier : tire jusqu’à **17** (soft 17 = 17).',
          '• Blackjack naturel (A + 10/J/Q/K) bat 21 non naturel.',
        ].join('\n')
      )
      .addFields(
        {
          name: 'Paiements',
          value: ['• Victoire : **1:1** (gagnes ta mise).', '• Blackjack : **3:2**.', '• Égalité : **push** (remboursé).', '• Abandon : **–½ mise**.'].join('\n'),
        },
        { name: 'Divers', value: ['• Mise minimum/maximum : 10/100000', '• Anti-spam : 1 partie active par joueur.'].join('\n') }
      )
      .setTimestamp();
  }

  if (jeu === 'horse') {
    return new EmbedBuilder()
      .setTitle('🏇 Règlement — Courses de chevaux (Paris)')
      .setDescription(
        ['• **Principe** : parie sur **un seul cheval** avant le départ.', '• **Une seule personne par cheval** (si pris, choisis-en un autre).', '• **Escrow** : ta mise est débitée à la prise de pari.', '• Départ : compte à rebours, course animée ; **un seul gagnant**.'].join('\n')
      )
      .addFields(
        {
          name: 'Payout',
          value: [
            '• **Un seul joueur dans la course** :',
            '  – Si son cheval gagne → **+50%** de sa mise (profit net +50%).',
            '  – Sinon → mise perdue.',
            '• **Plusieurs joueurs** :',
            '  – Le parieur sur le cheval gagnant prend **tout le pot** (somme de toutes les mises).',
            '  – Si personne n’a parié le gagnant → **tout le monde perd** (la maison garde le pot).',
            '• Pas de rake.',
          ].join('\n'),
        },
        { name: 'Rappels', value: ['• Annulation avant départ → remboursement automatique.', '• Mise min/max : 10/100000', '• 1 course active par salon.'].join('\n') }
      )
      .setTimestamp();
  }

  return null;
}
