import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';
import { db } from './db/index.js';
import { characters, adventures } from './db/schema.js';
import { eq, and } from 'drizzle-orm';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Match Ndf with optional +/- modifier
const diceRegex = /^(\d+)df(?:([+-]\d+))?$/i;
const EMBED_COLOR = 0xFF1493; // Deep Pink

client.on('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  
  // Register slash commands globally (might take a few minutes to appear in Discord)
  await client.application?.commands.set([
    {
      name: 'create-adventure',
      description: 'Create a new Fate adventure',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Adventure name', required: true }]
    },
    {
      name: 'start-adventure',
      description: 'Set an adventure as active',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Adventure name', required: true }]
    },
    {
      name: 'end-adventure',
      description: 'Clear the active adventure'
    },
    {
      name: 'create-character',
      description: 'Create a new character in the active adventure',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Character name', required: true }]
    },
    {
      name: 'link-char',
      description: 'Link yourself to a character and get its role',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Character name', required: true }]
    },
    {
      name: 'View Character Sheet',
      type: ApplicationCommandType.User
    }
  ]);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId) return;

  const text = message.content.trim();

  // 1. Ndf Dice Roll Logic
  const match = text.match(diceRegex);
  if (match) {
    const diceCount = parseInt(match[1], 10);
    if (diceCount > 100) return; // Prevent bot crash from too many dice
    
    const modifier = match[2] ? parseInt(match[2], 10) : 0;
    const faces = ['-', '0', '+'];
    const values = { '-': -1, '0': 0, '+': 1 };
    
    let total = 0;
    const results = [];
    
    for (let i = 0; i < diceCount; i++) {
      const face = faces[Math.floor(Math.random() * faces.length)];
      results.push(face);
      total += values[face as keyof typeof values];
    }

    const finalTotal = total + modifier;
    const modifierText = modifier !== 0 ? ` (Mod: ${modifier > 0 ? '+' : ''}${modifier})` : '';
    
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Dice Roll Result')
      .setDescription(`[ ${results.join(' , ')} ]${modifierText}\n\n**Total:** \`${finalTotal}\``);

    await message.reply({ embeds: [embed] });
    return;
  }

  // 2. Character Search
  const character = await db.query.characters.findFirst({
    where: and(eq(characters.name, text), eq(characters.guildId, message.guildId))
  });

  if (character) {
    const editAspectsBtn = new ButtonBuilder()
      .setCustomId(`edit_aspects_${character.id}`)
      .setLabel('Edit Aspects')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editAspectsBtn);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`Character: ${character.name}`)
      .addFields(
        { name: 'High Concept', value: character.highConcept || 'N/A' },
        { name: 'Trouble', value: character.trouble || 'N/A' }
      );

    await message.reply({ embeds: [embed], components: [row] });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) return;

  // Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'create-adventure') {
      const name = interaction.options.getString('name', true);
      await db.insert(adventures).values({ guildId: interaction.guildId, name });
      
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Adventure **${name}** created.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'start-adventure') {
      const name = interaction.options.getString('name', true);
      
      // Find the adventure
      const adventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.name, name), eq(adventures.guildId, interaction.guildId))
      });

      if (!adventure) {
        await interaction.reply({ content: 'Adventure not found.', ephemeral: true });
        return;
      }

      // Deactivate all others, activate this one
      await db.update(adventures).set({ isActive: false }).where(eq(adventures.guildId, interaction.guildId));
      await db.update(adventures).set({ isActive: true }).where(eq(adventures.id, adventure.id));

      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Adventure **${name}** is now active.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'end-adventure') {
      await db.update(adventures).set({ isActive: false }).where(eq(adventures.guildId, interaction.guildId));
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Active adventure cleared.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'create-character') {
      const name = interaction.options.getString('name', true);
      
      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });

      if (!activeAdventure) {
        await interaction.reply({ content: 'There is no active adventure to link this character to. Use /start-adventure first.', ephemeral: true });
        return;
      }

      await db.insert(characters).values({
        guildId: interaction.guildId,
        adventureId: activeAdventure.id,
        name
      });

      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Character **${name}** created for adventure **${activeAdventure.name}**.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'link-char') {
      const name = interaction.options.getString('name', true);
      const character = await db.query.characters.findFirst({
        where: and(eq(characters.name, name), eq(characters.guildId, interaction.guildId))
      });

      if (!character) {
        await interaction.reply({ content: 'Character not found.', ephemeral: true });
        return;
      }

      // Link user to character
      await db.update(characters).set({ discordUserId: interaction.user.id }).where(eq(characters.id, character.id));

      const guild = interaction.guild!;
      let role = guild.roles.cache.find(r => r.name === character.name);
      
      // Create role if it doesn't exist
      if (!role) {
        role = await guild.roles.create({ name: character.name });
      }

      // Assign role to user
      const member = await guild.members.fetch(interaction.user.id);
      await member.roles.add(role);

      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Linked to **${character.name}** and role assigned.`);
      await interaction.reply({ embeds: [embed] });
    }
  }

  // Handle Context Menu Commands
  if (interaction.isUserContextMenuCommand() && interaction.commandName === 'View Character Sheet') {
    const targetUserId = interaction.targetId;
    
    const character = await db.query.characters.findFirst({
      where: and(eq(characters.discordUserId, targetUserId), eq(characters.guildId, interaction.guildId))
    });

    if (!character) {
      await interaction.reply({ content: 'This user has no linked character.', ephemeral: true });
      return;
    }

    const editAspectsBtn = new ButtonBuilder()
      .setCustomId(`edit_aspects_${character.id}`)
      .setLabel('Edit Aspects')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editAspectsBtn);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`Character: ${character.name}`)
      .addFields(
        { name: 'High Concept', value: character.highConcept || 'N/A' },
        { name: 'Trouble', value: character.trouble || 'N/A' }
      );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  // Handle Buttons
  if (interaction.isButton() && interaction.customId.startsWith('edit_aspects_')) {
    const charId = interaction.customId.split('_')[2];
    
    const modal = new ModalBuilder()
      .setCustomId(`modal_aspects_${charId}`)
      .setTitle('Edit Aspects');

    const conceptInput = new TextInputBuilder()
      .setCustomId('highConcept')
      .setLabel('High Concept')
      .setStyle(TextInputStyle.Short);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(conceptInput);
    modal.setComponents(row);

    await interaction.showModal(modal);
  }

  // Handle Modals
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_aspects_')) {
    const charId = parseInt(interaction.customId.split('_')[2], 10);
    const newConcept = interaction.fields.getTextInputValue('highConcept');

    await db.update(characters).set({ highConcept: newConcept }).where(eq(characters.id, charId));
    
    const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Character updated.`);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);