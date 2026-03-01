import 'dotenv/config';

export const env = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,

  // deploy
  guildId: process.env.GUILD_ID || null,
  guildIds: (process.env.GUILD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  deployGlobal: process.env.DEPLOY_GLOBAL === 'true',

  // db
  dbPath: process.env.DB_PATH || './casino.db',

  // logs
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  logChannelsRaw: process.env.LOG_CHANNELS || '',

  debug: process.env.DEBUG === 'true',
};

if (!env.discordToken) {
  throw new Error('DISCORD_TOKEN manquant. Mets-le dans ton fichier .env');
}
if (!env.clientId) {
  // pas strictement requis si tu ne déploies pas les commandes, mais le bot les déploie au démarrage
  console.warn('[WARN] CLIENT_ID manquant. Le déploiement des slash commands va échouer.');
}

export function getGuildIdsForDeploy() {
  if (env.guildIds.length) return env.guildIds;
  if (env.guildId) return [env.guildId];
  return [];
}
