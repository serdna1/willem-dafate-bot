import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { db } from './db/index.js';
import { characters } from './db/schema.js';
import { eq, and } from 'drizzle-orm';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Regex to detect "4df" or "4df+2" or "4df-1"
const diceRegex = /^4df(?:([+-]\d+))?$/i;

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const text = message.content.trim();

  // 1. Dice Roll Logic
  const match = text.match(diceRegex);
  if (match) {
    const modifier = match[1] ? parseInt(match[1], 10) : 0;
    const faces = ['-', '0', '+'];
    const values = { '-': -1, '0': 0, '+': 1 };
    
    let total = 0;
    const results = [];
    
    for (let i = 0; i < 4; i++) {
      const face = faces[Math.floor(Math.random() * faces.length)];
      results.push(face);
      total += values[face as keyof typeof values];
    }

    const finalTotal = total + modifier;
    const modifierText = modifier !== 0 ? ` (Mod: ${modifier > 0 ? '+' : ''}${modifier})` : '';
    
    await message.reply(`Tirada: [ ${results.join(' , ')} ]${modifierText}\n**Resultado Total:** \`${finalTotal}\``);
    return;
  }

  // 2. Character Search
  const character = await db.query.characters.findFirst({
    where: and(eq(characters.name, text), eq(characters.guildId, message.guildId!))
  });

  if (character) {
    const editAspectsBtn = new ButtonBuilder()
      .setCustomId(`edit_aspects_${character.id}`)
      .setLabel('Editar Aspectos')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editAspectsBtn);

    await message.reply({
      content: `**Ficha de ${character.name}**\nConcepto: ${character.highConcept || 'N/A'}\nProblema: ${character.trouble || 'N/A'}\n*... (resto de datos)*`,
      components: [row]
    });
  }
});

// 3. Modal Handling
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('edit_aspects_')) {
    const charId = interaction.customId.split('_')[2];
    
    const modal = new ModalBuilder()
      .setCustomId(`modal_aspects_${charId}`)
      .setTitle('Editar Aspectos');

    const conceptInput = new TextInputBuilder()
      .setCustomId('highConcept')
      .setLabel("Concepto Principal")
      .setStyle(TextInputStyle.Short);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(conceptInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  // 4. Save Modal Data
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_aspects_')) {
    const charId = parseInt(interaction.customId.split('_')[2], 10);
    const newConcept = interaction.fields.getTextInputValue('highConcept');

    await db.update(characters).set({ highConcept: newConcept }).where(eq(characters.id, charId));
    await interaction.reply({ content: 'Ficha actualizada.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);