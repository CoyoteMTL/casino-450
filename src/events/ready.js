import { ActivityType } from 'discord.js';
import { env, getGuildIdsForDeploy } from '../config/env.js';
import { commands } from '../commands/definitions.js';
import { deployCommands } from '../lib/deployCommands.js';

export function registerReady(client) {
  client.once('ready', async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);

    client.user.setActivity({ name: 'le casino', type: ActivityType.Playing });

    const guildIds = getGuildIdsForDeploy();
    await deployCommands({
      token: env.discordToken,
      clientId: env.clientId,
      guildIds,
      deployGlobal: env.deployGlobal,
      commands,
    });
  });
}
