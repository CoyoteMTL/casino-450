import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js';
import { LIMITS } from '../config/constants.js';

const { MIN_BET, MAX_BET } = LIMITS;

export const commands = [
  {
    name: 'blackjack',
    description: 'Jouer une partie de blackjack',
    options: [
      {
        name: 'mise',
        description: 'Montant (obligatoire)',
        type: ApplicationCommandOptionType.Integer,
        required: true,
        min_value: MIN_BET,
      },
    ],
  },

  // Courses de chevaux
  {
    name: 'chevaux',
    description: 'Courses de chevaux (mode paris)',
    dm_permission: false,
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'creer',
        description: 'Créer une course et ouvrir les paris',
        options: [
          { name: 'distance', description: 'Cases jusqu’à l’arrivée (15–50)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 15, max_value: 50 },
          { name: 'chevaux', description: 'Nombre de chevaux (2–8)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 2, max_value: 8 },
          { name: 'temps', description: 'Fenêtre de paris en secondes (10–60)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 10, max_value: 60 },
        ],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'demarrer', description: 'Fermer les paris et lancer la course (créateur ou admin)' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'annuler', description: 'Annuler la course ouverte (créateur ou admin)' },
    ],
  },
  {
    name: 'parier',
    description: 'Parier sur un cheval de la course en cours',
    dm_permission: false,
    options: [
      { name: 'cheval', description: 'ID du cheval (ex: 1, 2, 3…)', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 8 },
      { name: 'mise', description: 'Montant', type: ApplicationCommandOptionType.Integer, required: true, min_value: MIN_BET },
    ],
  },

  // Slots
  { 
    name: 'slots',
    description: 'Jouer à la machine à sous (5 lignes)',
    options: [
      {
        name: 'mise',
        description: 'montant',
        type: ApplicationCommandOptionType.Integer,
        required: true,
        min_value: MIN_BET,
        max_value: MAX_BET,
      },
    ],
  },

  // Économie
  { name: 'balance', description: 'Voir ton solde' },
  {
    name: 'faucet',
    description: 'Recevoir un montant de départ / renflouement',
    default_member_permissions: String(PermissionFlagsBits.Administrator),
    dm_permission: false,
  },
  { name: 'daily', description: 'Réclamer le bonus quotidien' },
  {
    name: 'stats',
    description: 'Voir tes stats ou celles de quelqu’un',
    options: [
      {
        name: 'utilisateur',
        description: 'Membre (optionnel)',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'top',
    description: 'Leaderboard du casino',
    options: [
      {
        name: 'metric',
        description: 'Classement par…',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'Balance', value: 'balance' },
          { name: 'Profit net', value: 'net_profit' },
          { name: 'Victoires', value: 'wins' },
          { name: 'Winrate', value: 'winrate' },
        ],
      },
      {
        name: 'limite',
        description: 'Nombre de joueurs (1-20)',
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
        max_value: 20,
      },
    ],
  },
  {
    name: 'resetbalance',
    description: 'Réinitialiser le solde d’un joueur',
    default_member_permissions: String(PermissionFlagsBits.Administrator),
    dm_permission: false,
    options: [
      { name: 'utilisateur', description: 'Joueur à réinitialiser', type: ApplicationCommandOptionType.User, required: true },
      { name: 'montant', description: 'Nouveau solde', type: ApplicationCommandOptionType.Integer, required: false, min_value: 0 },
      { name: 'reinitialiser_stats', description: 'Réinitialiser aussi les stats (oui/non)', type: ApplicationCommandOptionType.Boolean, required: false },
    ],
  },
  {
    name: 'reglement',
    description: 'Afficher le règlement d’un jeu',
    dm_permission: false,
    options: [
      {
        name: 'jeu',
        description: 'Choisis un jeu',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'Blackjack', value: 'bj' },
          { name: 'Chevaux', value: 'horse' },
        ],
      },
    ],
  },
  {
    name: 'test-log',
    description: 'Envoyer un message de test dans le salon de log',
    dm_permission: false,
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  },
];

export const limitsInfo = { MIN_BET, MAX_BET };
