import { handleEconomyCommand } from '../features/economy.js';
import { handleHorseCommand } from '../features/horses.js';
import { handleBlackjackButton, handleBlackjackCommand } from '../games/blackjack/blackjack.js';
import { handleSlotsButton, handleSlotsCommand } from '../games/slots/slots.js';

export function registerInteractionCreate(client, { debug = false } = {}) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (debug) {
        console.log('[INT]', {
          type: interaction.type,
          name: interaction.commandName,
          customId: interaction.customId,
          user: interaction.user?.id,
          guild: interaction.guildId,
        });
      }

      // Buttons (Blackjack)
      if (interaction.isButton()) {
        if (await handleSlotsButton(interaction)) return;
        const handled = await handleBlackjackButton(interaction);
        if (handled) return;
      }

      // Slash commands
      if (interaction.isChatInputCommand()) {
        if (await handleEconomyCommand(interaction)) return;
        if (await handleHorseCommand(interaction)) return;
        if (await handleSlotsCommand(interaction)) return;
        if (await handleBlackjackCommand(interaction)) return;
      }
    } catch (err) {
      console.error('[interactionCreate] error:', err);
      try {
        if (interaction?.isRepliable?.()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'Une erreur est survenue.', components: [] });
          } else {
            await interaction.reply({ content: 'Une erreur est survenue.', ephemeral: true });
          }
        }
      } catch {
        // ignore secondary errors
      }
    }
  });
}
