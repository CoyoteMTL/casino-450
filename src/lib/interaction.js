export async function safeAcknowledge(interaction) {
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  }
}

export async function safeEdit(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply({ ...payload, flags: payload.flags ?? 64 });
}
