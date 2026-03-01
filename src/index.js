import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { env } from './config/env.js';
import { registerReady } from './events/ready.js';
import { registerInteractionCreate } from './events/interactionCreate.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

registerReady(client);
registerInteractionCreate(client, { debug: env.debug });

process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('uncaughtException', err));

client.login(env.discordToken);
