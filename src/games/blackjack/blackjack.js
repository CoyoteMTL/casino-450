import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { LIMITS } from '../../config/constants.js';
import { ensureUser, canAfford, applyGameResult } from '../../db.js';
import { logToCasino } from '../../lib/logger.js';
import { safeAcknowledge, safeEdit } from '../../lib/interaction.js';

const { MIN_BET, MAX_BET } = LIMITS;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const EMOJI = { hit: '🃏', stand: '🛑', double: '✌️', surrender: '🏳️' };

const games = new Map();
const keyOf = (g, u) => `${g}:${u}`;

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(r) {
  if (r === 'A') return 11;
  if (['K', 'Q', 'J'].includes(r)) return 10;
  return parseInt(r, 10);
}

function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.r === 'A') aces++;
    total += cardValue(c.r);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function fmtCards(cards, hideFirst = false) {
  if (!cards || cards.length === 0) return '—';
  return cards
    .map((c, i) => (hideFirst && i === 0 ? '🂠' : `\`${c.r}${c.s}\``))
    .join(' ');
}

function makeButtons(userId, canDouble, ended = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bj_hit_${userId}`)
        .setLabel('Hit')
        .setEmoji(EMOJI.hit)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(ended),
      new ButtonBuilder()
        .setCustomId(`bj_stand_${userId}`)
        .setLabel('Stand')
        .setEmoji(EMOJI.stand)
        .setStyle(ButtonStyle.Success)
        .setDisabled(ended),
      new ButtonBuilder()
        .setCustomId(`bj_double_${userId}`)
        .setLabel('Double')
        .setEmoji(EMOJI.double)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(ended || !canDouble),
      new ButtonBuilder()
        .setCustomId(`bj_surrender_${userId}`)
        .setLabel('Surrender')
        .setEmoji(EMOJI.surrender)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(ended)
    ),
  ];
}

function buildEmbed(state, revealDealer = false) {
  const playerTotal = handTotal(state.player);
  const dealerShown = revealDealer ? fmtCards(state.dealer, false) : fmtCards(state.dealer, true);
  const dealerTotal = revealDealer ? handTotal(state.dealer) : '??';

  return new EmbedBuilder()
    .setTitle('🃠 Blackjack')
    .setDescription(state.ended ? state.outcomeText || 'Partie terminée.' : 'Choisis ton action.')
    .addFields(
      { name: `Croupier (${dealerTotal})`, value: dealerShown, inline: true },
      { name: `Toi (${playerTotal})`, value: fmtCards(state.player), inline: true },
      { name: 'Mise', value: `${state.bet}`, inline: true }
    )
    .setFooter({ text: `Solde avant partie: ${state.balanceStart}` })
    .setTimestamp();
}

function settle(state, reason) {
  const pt = handTotal(state.player);
  const dt = handTotal(state.dealer);
  let result = 'loss';
  let delta = -state.bet;
  let bj = false;
  let text = '';

  if (reason === 'player_bust') {
    result = 'loss';
    text = '💥 **Tu bustes**. Le croupier gagne.';
  } else if (reason === 'surrender') {
    result = 'loss';
    delta = -Math.floor(state.bet / 2);
    text = '🏳️ **Surrender** — tu perds la moitié de ta mise.';
  } else {
    if (state.naturalBJ && !state.dealerNatural) {
      result = 'win';
      bj = true;
      delta = Math.floor(state.bet * 1.5);
      text = '🖤 **Blackjack !** Paiement 3:2.';
    } else if (!state.naturalBJ && state.dealerNatural) {
      result = 'loss';
      delta = -state.bet;
      text = '🖤 **Le croupier a blackjack.**';
    } else {
      if (pt > 21) {
        result = 'loss';
        delta = -state.bet;
        text = '💥 **Tu bustes.**';
      } else if (dt > 21) {
        result = 'win';
        delta = state.bet;
        text = '💥 **Le croupier bust.** Tu gagnes !';
      } else if (pt === dt) {
        result = 'push';
        delta = 0;
        text = '🤝 **Push.**';
      } else if (pt > dt) {
        result = 'win';
        delta = state.bet;
        text = '✅ **Tu gagnes !**';
      } else {
        result = 'loss';
        delta = -state.bet;
        text = '❌ **Le croupier gagne.**';
      }
    }
  }

  state.ended = true;
  state.outcomeText = text + ` ${delta >= 0 ? `(+${delta})` : `(${delta})`}`;
  if (state.doubled) state.outcomeText += ' *(Double appliqué)*';

  return { result, delta, blackjack: bj };
}

function describeResultEmbed(state, action, { result, delta }) {
  return new EmbedBuilder()
    .setTitle('🃏 Blackjack — Résultat')
    .setDescription(
      [
        `Joueur: <@${state.userId}>`,
        `Action: **${action}**`,
        `Mise: **${state.bet}**`,
        `Résultat: **${result}**`,
        `Profits (ou perte tsé): **${delta >= 0 ? '+' : ''}${delta}**`,
      ].join('\n')
    )
    .setTimestamp();
}

export async function handleBlackjackCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'blackjack') return false;

  const gid = interaction.guildId;
  const uid = interaction.user.id;

  const bet = interaction.options.getInteger('mise');
  if (bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({ content: `La mise doit être entre ${MIN_BET} et ${MAX_BET}.`, ephemeral: true });
    return true;
  }

  const k = keyOf(gid, uid);
  if (games.has(k) && !games.get(k).ended) {
    await interaction.reply({ content: '❗ Tu as déjà une partie en cours.', ephemeral: true });
    return true;
  }

  const u = ensureUser(gid, uid);
  if (!canAfford(gid, uid, bet)) {
    await interaction.reply({ content: `Solde insuffisant. Ton solde: **${u.balance}**`, ephemeral: true });
    return true;
  }

  const deck = buildDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];

  const pTot = handTotal(player);
  const dTot = handTotal(dealer);

  const state = {
    guildId: gid,
    userId: uid,
    deck,
    player,
    dealer,
    bet,
    ended: false,
    doubled: false,
    balanceStart: u.balance,
    naturalBJ: pTot === 21,
    dealerNatural: dTot === 21,
  };

  games.set(k, state);

  // log start
  await logToCasino(interaction.guild, {
    embeds: [
      new EmbedBuilder()
        .setTitle('🃏 Blackjack — Nouvelle partie')
        .setDescription([`Joueur: <@${state.userId}>`, `Mise: **${state.bet}**`, `Solde avant partie: **${state.balanceStart}**`].join('\n'))
        .setTimestamp(),
    ],
  });

  // natural BJ resolve directly
  if (state.naturalBJ || state.dealerNatural) {
    const res = settle(state, 'reveal');
    applyGameResult(gid, uid, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
    await logToCasino(interaction.guild, {
      embeds: [describeResultEmbed(state, 'Natural', res)],
    });

    await interaction.reply({ embeds: [buildEmbed(state, true)], components: makeButtons(uid, false, true) });
    return true;
  }

  await interaction.reply({ embeds: [buildEmbed(state, false)], components: makeButtons(uid, true, false) });
  return true;
}

export function isBlackjackButton(customId) {
  return typeof customId === 'string' && customId.startsWith('bj_');
}

export async function handleBlackjackButton(interaction) {
  if (!interaction.isButton() || !isBlackjackButton(interaction.customId)) return false;

  const [prefix, action, targetUserId] = interaction.customId.split('_');
  if (prefix !== 'bj') return false;

  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: '⛔ Ce bouton n’est pas pour toi.', ephemeral: true });
    return true;
  }

  const gid = interaction.guildId;
  const uid = interaction.user.id;
  const k = keyOf(gid, uid);
  const state = games.get(k);

  if (!state) {
    await interaction.reply({ content: 'La partie a expiré ou n’existe plus.', ephemeral: true });
    return true;
  }

  if (state.ended) {
    await safeAcknowledge(interaction);
    await safeEdit(interaction, { embeds: [buildEmbed(state, true)], components: makeButtons(uid, false, true) });
    return true;
  }

  let reveal = false;

  if (action === 'hit') {
    state.player.push(state.deck.pop());
    if (handTotal(state.player) > 21) {
      const res = settle(state, 'player_bust');
      applyGameResult(state.guildId, state.userId, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
      await logToCasino(interaction.guild, { embeds: [describeResultEmbed(state, 'Hit (Bust)', res)] });
      reveal = true;
    }
  } else if (action === 'stand') {
    while (handTotal(state.dealer) < 17) state.dealer.push(state.deck.pop());
    const res = settle(state, 'stand');
    applyGameResult(state.guildId, state.userId, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
    await logToCasino(interaction.guild, { embeds: [describeResultEmbed(state, 'Stand', res)] });
    reveal = true;
  } else if (action === 'double') {
    if (state.player.length !== 2 || state.doubled) {
      await interaction.reply({ content: 'Tu ne peux pas doubler maintenant.', ephemeral: true });
      return true;
    }
    const can = canAfford(state.guildId, state.userId, state.bet);
    if (!can) {
      await interaction.reply({ content: 'Solde insuffisant pour doubler.', ephemeral: true });
      return true;
    }

    state.doubled = true;
    state.bet = state.bet * 2;
    state.player.push(state.deck.pop());

    if (handTotal(state.player) > 21) {
      const res = settle(state, 'player_bust');
      applyGameResult(state.guildId, state.userId, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
      await logToCasino(interaction.guild, { embeds: [describeResultEmbed(state, 'Double (Bust)', res)] });
      reveal = true;
    } else {
      while (handTotal(state.dealer) < 17) state.dealer.push(state.deck.pop());
      const res = settle(state, 'stand');
      applyGameResult(state.guildId, state.userId, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
      await logToCasino(interaction.guild, { embeds: [describeResultEmbed(state, 'Double', res)] });
      reveal = true;
    }
  } else if (action === 'surrender') {
    const res = settle(state, 'surrender');
    applyGameResult(state.guildId, state.userId, { bet: state.bet, delta: res.delta, result: res.result, blackjack: res.blackjack });
    await logToCasino(interaction.guild, { embeds: [describeResultEmbed(state, 'Surrender', res)] });
    reveal = true;
  }

  await safeAcknowledge(interaction);
  await safeEdit(interaction, {
    embeds: [buildEmbed(state, reveal || state.ended)],
    components: makeButtons(uid, !state.doubled && state.player.length === 2 && !state.ended, state.ended),
  });

  return true;
}
