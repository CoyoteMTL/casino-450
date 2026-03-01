import { REST, Routes } from 'discord.js';

export async function deployCommands({ token, clientId, guildIds, deployGlobal, commands }) {
  if (!token || !clientId) {
    console.warn('[deployCommands] token/clientId manquants → skip deploy');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    // 1) Déploiement guild (immédiat, idéal pour tests/dev)
    for (const gid of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, gid), { body: commands });
        console.log(`✓ Commandes déployées sur la guilde ${gid}`);
      } catch (e) {
        console.error(`✗ Échec déploiement guild ${gid}:`, e);
      }
    }

    // 2) Déploiement global (visible partout ; peut prendre 5–60 min la 1re fois)
    if (deployGlobal || guildIds.length === 0) {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✓ Commandes (globales) déployées');
    }
  } catch (err) {
    console.error('Erreur de déploiement des commandes:', err);
  }
}
