import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';
import { db } from './db/index.js';
import { characters, adventures } from './db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getTranslation } from './i18n.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const diceRegex = /^(\d+)df(?:([+-]\d+))?$/i;
const hiddenDiceRegex = /^(\d+)dfs(?:([+-]\d+))?$/i;
const skillDiceRegex = /^(\d+)df\s+(.+)$/i;
const EMBED_COLOR = 0xFF1493;

async function getGuildLanguage(guildId: string): Promise<string> {
  const activeAdv = await db.query.adventures.findFirst({
    where: and(eq(adventures.guildId, guildId), eq(adventures.isActive, true))
  });
  return activeAdv?.language || 'english';
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  
  await client.application?.commands.set([
    {
      name: 'change_language',
      description: 'Change bot language',
      options: [
        {
          name: 'language',
          type: ApplicationCommandOptionType.String,
          description: 'Choose language',
          required: true,
          choices: [
            { name: 'English', value: 'english' },
            { name: 'Spanish', value: 'spanish' }
          ]
        }
      ]
    },
    {
      name: 'create-adventure',
      description: 'Create a new Fate adventure',
      options: [
        { name: 'name', type: ApplicationCommandOptionType.String, description: 'Adventure name', required: true },
        { name: 'description', type: ApplicationCommandOptionType.String, description: 'Adventure description', required: false }
      ]
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
      name: 'adventure-info',
      description: 'Show active adventure details and characters'
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

function rollDice(diceCount: number, modifier: number = 0) {
  const faces = ['-', '0', '+'];
  const values = { '-': -1, '0': 0, '+': 1 };
  let total = 0;
  const results = [];
  
  for (let i = 0; i < diceCount; i++) {
    const face = faces[Math.floor(Math.random() * faces.length)];
    results.push(face);
    total += values[face as keyof typeof values];
  }
  return { results, total: total + modifier };
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId) return;
  const text = message.content.trim();
  const lang = await getGuildLanguage(message.guildId);
  const t = getTranslation(lang);

  // 1. Hidden Dice Roll (4dfs) -> Sustituye el botón por el resultado en el MISMO mensaje
  const hiddenMatch = text.match(hiddenDiceRegex);
  if (hiddenMatch) {
    const diceCount = parseInt(hiddenMatch[1], 10);
    if (diceCount > 100) return;
    const modifier = hiddenMatch[2] ? parseInt(hiddenMatch[2], 10) : 0;
    const roll = rollDice(diceCount, modifier);

    const revealBtn = new ButtonBuilder()
      .setCustomId(`reveal_roll_${Buffer.from(JSON.stringify({ r: roll.results, t: roll.total, m: modifier, user: message.author.username })).toString('base64')}`)
      .setLabel(t.showRoll)
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(revealBtn);
    await message.delete().catch(() => {});
    await message.channel.send({
      content: `🎲 **${message.author.username}** ${t.hiddenRoll}`,
      components: [row]
    });
    return;
  }

  // 2. Skill Roll via Text (4df skill_name)
  const skillMatch = text.match(skillDiceRegex);
  if (skillMatch) {
    const diceCount = parseInt(skillMatch[1], 10);
    const skillQuery = skillMatch[2].toLowerCase().trim();

    const character = await db.query.characters.findFirst({
      where: and(eq(characters.discordUserId, message.author.id), eq(characters.guildId, message.guildId))
    });

    if (!character || !character.skills) {
      await message.reply({ content: 'Character or skills not found.' });
      return;
    }

    let modifier = 0;
    let foundSkill = '';
    const skillsObj = character.skills as Record<string, string[]>;

    for (const [modStr, skillList] of Object.entries(skillsObj)) {
      if (skillList.some(s => s.toLowerCase() === skillQuery)) {
        modifier = parseInt(modStr, 10);
        foundSkill = skillList.find(s => s.toLowerCase() === skillQuery)!;
        break;
      }
    }

    if (!foundSkill) {
      await message.reply({ content: `Skill "${skillMatch[2]}" not found.` });
      return;
    }

    const roll = rollDice(diceCount, modifier);
    const modifierText = modifier !== 0 ? ` (${t.skills}: ${foundSkill} ${modifier > 0 ? '+' : ''}${modifier})` : '';

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${t.skills}: ${foundSkill}`)
      .setDescription(`[ ${roll.results.join(' , ')} ]${modifierText}\n\n**Total:** \`${roll.total}\``);

    await message.reply({ embeds: [embed] });
    return;
  }

  // 3. Normal Dice Roll
  const match = text.match(diceRegex);
  if (match) {
    const diceCount = parseInt(match[1], 10);
    if (diceCount > 100) return;
    const modifier = match[2] ? parseInt(match[2], 10) : 0;
    const roll = rollDice(diceCount, modifier);
    const modifierText = modifier !== 0 ? ` (Mod: ${modifier > 0 ? '+' : ''}${modifier})` : '';

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(t.diceRollResult)
      .setDescription(`[ ${roll.results.join(' , ')} ]${modifierText}\n\n**Total:** \`${roll.total}\``);

    await message.reply({ embeds: [embed] });
    return;
  }

  // 4. Short Character Sheet View
  const character = await db.query.characters.findFirst({
    where: and(eq(characters.name, text), eq(characters.guildId, message.guildId))
  });

  if (character) {
    const editIdBtn = new ButtonBuilder().setCustomId(`edit_id_${character.id}`).setLabel(t.editId).setStyle(ButtonStyle.Secondary);
    const showFullSheetBtn = new ButtonBuilder().setCustomId(`show_full_${character.id}`).setLabel(t.fullSheet).setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editIdBtn, showFullSheetBtn);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${t.character}: ${character.name}`)
      .addFields(
        { name: t.description, value: character.description || 'N/A' },
        { name: t.refresh, value: String(character.refresh ?? 3), inline: true }
      );

    await message.reply({ embeds: [embed], components: [row] });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) return;
  const lang = await getGuildLanguage(interaction.guildId);
  const t = getTranslation(lang);

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'change_language') {
      const selectedLang = interaction.options.getString('language', true);
      await db.update(adventures).set({ language: selectedLang }).where(and(eq(adventures.guildId, interaction.guildId), eq(adventures.isActive, true)));
      await interaction.reply({ content: t.langChanged, ephemeral: true });
    }

    if (commandName === 'create-adventure') {
      const name = interaction.options.getString('name', true);
      const description = interaction.options.getString('description');
      await db.insert(adventures).values({ guildId: interaction.guildId, name, description, language: 'english' });
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Adventure **${name}** created.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'start-adventure') {
      const name = interaction.options.getString('name', true);
      const adventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.name, name), eq(adventures.guildId, interaction.guildId))
      });
      if (!adventure) {
        await interaction.reply({ content: 'Adventure not found.', ephemeral: true });
        return;
      }
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

    if (commandName === 'adventure-info') {
      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });
      if (!activeAdventure) {
        await interaction.reply({ content: t.noActiveAdventure, ephemeral: true });
        return;
      }
      const chars = await db.query.characters.findMany({
        where: and(eq(characters.adventureId, activeAdventure.id), eq(characters.guildId, interaction.guildId))
      });
      const charNames = chars.map(c => c.name).join(', ') || 'None';

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`Adventure: ${activeAdventure.name}`)
        .addFields(
          { name: t.description, value: activeAdventure.description || 'N/A' },
          { name: t.status, value: t.active, inline: true },
          { name: t.characters, value: charNames }
        );
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'create-character') {
      const name = interaction.options.getString('name', true);
      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });
      if (!activeAdventure) {
        await interaction.reply({ content: t.noActiveAdventure, ephemeral: true });
        return;
      }
      await db.insert(characters).values({ guildId: interaction.guildId, adventureId: activeAdventure.id, name });
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Character **${name}** created.`);
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
      await db.update(characters).set({ discordUserId: interaction.user.id }).where(eq(characters.id, character.id));
      const guild = interaction.guild!;
      let role = guild.roles.cache.find(r => r.name === character.name);
      if (!role) {
        role = await guild.roles.create({ name: character.name });
      }
      const member = await guild.members.fetch(interaction.user.id);
      await member.roles.add(role);
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Linked to **${character.name}**.`);
      await interaction.reply({ embeds: [embed] });
    }
  }

  // Button Handling
  if (interaction.isButton()) {
    // 4dfs reveal: sustituye el mensaje original con el resultado
    if (interaction.customId.startsWith('reveal_roll_')) {
      const dataEncoded = interaction.customId.replace('reveal_roll_', '');
      const data = JSON.parse(Buffer.from(dataEncoded, 'base64').toString('utf8'));
      const modifierText = data.m !== 0 ? ` (Mod: ${data.m > 0 ? '+' : ''}${data.m})` : '';

      await interaction.update({
        content: `🎲 **${data.user}** ${t.showRoll}:\n[ ${data.r.join(' , ')} ]${modifierText}\n\n**Total:** \`${data.t}\``,
        components: []
      });
      return;
    }

    if (interaction.customId.startsWith('skill_roll_')) {
      const [, , charIdStr, skillName] = interaction.customId.split('_');
      const charId = parseInt(charIdStr, 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      if (!character || !character.skills) {
        await interaction.reply({ content: 'Character or skills not found.', ephemeral: true });
        return;
      }
      let modifier = 0;
      const skillsObj = character.skills as Record<string, string[]>;
      for (const [modStr, skillList] of Object.entries(skillsObj)) {
        if (skillList.includes(skillName)) {
          modifier = parseInt(modStr, 10);
          break;
        }
      }
      const roll = rollDice(4, modifier);
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${t.skills}: ${skillName}`)
        .setDescription(`[ ${roll.results.join(' , ')} ] (Mod: ${modifier > 0 ? '+' : ''}${modifier})\n\n**Total:** \`${roll.total}\``);
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.customId.startsWith('show_full_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      if (!character) {
        await interaction.reply({ content: 'Character not found.', ephemeral: true });
        return;
      }

      const aspectsList = (character.aspects as string[]).join('\n') || 'None';
      const stuntsText = character.stunts || 'None';
      const extrasText = character.extras || 'None';
      const consequences = character.consequences as { mild: string; moderate: string; severe: string };
      const constText = `${t.mild}: ${consequences.mild || 'None'}\n${t.moderate}: ${consequences.moderate || 'None'}\n${t.severe}: ${consequences.severe || 'None'}`;

      // Formatear Habilidades en texto para el embed
      const skillsObj = (character.skills as Record<string, string[]>) || {};
      const skillsTextLines: string[] = [];
      for (const [mod, list] of Object.entries(skillsObj)) {
        if (list.length > 0) {
          skillsTextLines.push(`${mod}: ${list.join(', ')}`);
        }
      }
      const formattedSkillsText = skillsTextLines.join('\n') || 'None';

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${t.fullSheet}: ${character.name}`)
        .addFields(
          { name: t.description, value: character.description || 'N/A' },
          { name: t.refresh, value: String(character.refresh ?? 3), inline: true },
          { name: t.aspects, value: aspectsList },
          { name: t.skills, value: formattedSkillsText },
          { name: t.stunts, value: stuntsText },
          { name: t.extras, value: extrasText },
          { name: t.consequences, value: constText }
        );

      // Botones en color negro (Secondary)
      const editRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`edit_id_${character.id}`).setLabel(t.editId).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_aspects_${character.id}`).setLabel(t.editAspects).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_skills_${character.id}`).setLabel(t.editSkills).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_stunts_${character.id}`).setLabel(t.editStunts).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_extras_${character.id}`).setLabel(t.editExtras).setStyle(ButtonStyle.Secondary)
      );

      const editRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`edit_stress_${character.id}`).setLabel(t.editStress).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`edit_consequences_${character.id}`).setLabel(t.editConsequences).setStyle(ButtonStyle.Secondary)
      );

      // Botones de tirada por Habilidad (Verde / Success)
      const skillRows: ActionRowBuilder<ButtonBuilder>[] = [];
      let currentSkillRow = new ActionRowBuilder<ButtonBuilder>();
      let skillButtonCount = 0;

      for (const skillList of Object.values(skillsObj)) {
        for (const skill of skillList) {
          if (skillButtonCount >= 5) {
            skillRows.push(currentSkillRow);
            currentSkillRow = new ActionRowBuilder<ButtonBuilder>();
            skillButtonCount = 0;
          }
          currentSkillRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`skill_roll_${character.id}_${skill}`)
              .setLabel(`${t.roll} ${skill}`)
              .setStyle(ButtonStyle.Success)
          );
          skillButtonCount++;
        }
      }
      if (skillButtonCount > 0) {
        skillRows.push(currentSkillRow);
      }

      await interaction.reply({ embeds: [embed], components: [editRow1, editRow2, ...skillRows], ephemeral: true });
      return;
    }

    // Abre modal para Edit ID (Valores actuales asignados y campos no requeridos)
    if (interaction.customId.startsWith('edit_id_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });

      const modal = new ModalBuilder().setCustomId(`modal_id_${charId}`).setTitle(t.editId);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(character?.name || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(character?.description || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('refresh').setLabel('Refresh').setStyle(TextInputStyle.Short).setValue(String(character?.refresh ?? 3)).setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }

    // Edit Aspects Modal
    if (interaction.customId.startsWith('edit_aspects_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      const currentAspects = (character?.aspects as string[]) || [];

      const modal = new ModalBuilder().setCustomId(`modal_aspects_${charId}`).setTitle(t.editAspects);
      for (let i = 1; i <= 5; i++) {
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(`aspect_${i}`)
              .setLabel(`${t.aspects} ${i}`)
              .setStyle(TextInputStyle.Short)
              .setValue(currentAspects[i - 1] || '')
              .setRequired(false)
          )
        );
      }
      await interaction.showModal(modal);
    }

    // Edit Skills Modal (acepta salto de línea o barra '|')
    if (interaction.customId.startsWith('edit_skills_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      const skillsObj = (character?.skills as Record<string, string[]>) || {};
      
      const lines: string[] = [];
      for (const [mod, list] of Object.entries(skillsObj)) {
        lines.push(`${mod}: ${list.join(', ')}`);
      }

      const modal = new ModalBuilder().setCustomId(`modal_skills_${charId}`).setTitle(t.editSkills);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('skills_text')
            .setLabel('Format: +4: SkillA, SkillB')
            .setPlaceholder('+4: Skill1, Skill2\n+3: Skill3')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(lines.join('\n'))
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }

    // Edit Extras Modal
    if (interaction.customId.startsWith('edit_extras_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });

      const modal = new ModalBuilder().setCustomId(`modal_extras_${charId}`).setTitle(t.editExtras);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('extras')
            .setLabel(t.extras)
            .setStyle(TextInputStyle.Paragraph)
            .setValue(character?.extras || '')
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }
    
    // Edit Stunts Modal
    if (interaction.customId.startsWith('edit_stunts_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });

      const modal = new ModalBuilder().setCustomId(`modal_stunts_${charId}`).setTitle(t.editStunts);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('stunts')
            .setLabel(t.stunts)
            .setStyle(TextInputStyle.Paragraph)
            .setValue(character?.stunts || '')
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }

    // Edit Stress Modal
    if (interaction.customId.startsWith('edit_stress_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      const phys = (character?.physicalStress as boolean[]) || [false, false, false, false];
      const ment = (character?.mentalStress as boolean[]) || [false, false, false, false];

      const physStr = phys.map((v, i) => (v ? i + 1 : null)).filter(Boolean).join(',');
      const mentStr = ment.map((v, i) => (v ? i + 1 : null)).filter(Boolean).join(',');

      const modal = new ModalBuilder().setCustomId(`modal_stress_${charId}`).setTitle(t.editStress);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('physical')
            .setLabel('Physical Stress (e.g. 1,2,4)')
            .setPlaceholder('1, 2, 3, 4')
            .setStyle(TextInputStyle.Short)
            .setValue(physStr)
            .setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('mental')
            .setLabel('Mental Stress (e.g. 1,3)')
            .setPlaceholder('1, 2, 3, 4')
            .setStyle(TextInputStyle.Short)
            .setValue(mentStr)
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }

    // Edit Consequences Modal
    if (interaction.customId.startsWith('edit_consequences_')) {
      const charId = parseInt(interaction.customId.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      const cons = (character?.consequences as { mild: string; moderate: string; severe: string }) || { mild: '', moderate: '', severe: '' };

      const modal = new ModalBuilder().setCustomId(`modal_consequences_${charId}`).setTitle(t.editConsequences);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('mild').setLabel(t.mild).setStyle(TextInputStyle.Short).setValue(cons.mild || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('moderate').setLabel(t.moderate).setStyle(TextInputStyle.Short).setValue(cons.moderate || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('severe').setLabel(t.severe).setStyle(TextInputStyle.Short).setValue(cons.severe || '').setRequired(false)
        )
      );
      await interaction.showModal(modal);
    }
  }

  // Modal Submissions
  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split('_');
    const modalType = parts[1];
    const charId = parseInt(parts[2], 10);

    if (modalType === 'id') {
      const name = interaction.fields.getTextInputValue('name');
      const description = interaction.fields.getTextInputValue('description');
      const refreshStr = interaction.fields.getTextInputValue('refresh');
      const refresh = refreshStr ? parseInt(refreshStr, 10) : 3;

      await db.update(characters).set({ name, description, refresh }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Character ID updated.', ephemeral: true });
    }

    if (modalType === 'aspects') {
      const aspects: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const val = interaction.fields.getTextInputValue(`aspect_${i}`);
        if (val && val.trim() !== '') aspects.push(val.trim());
      }
      await db.update(characters).set({ aspects }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Aspects updated.', ephemeral: true });
    }

    if (modalType === 'skills') {
      const rawText = interaction.fields.getTextInputValue('skills_text');
      const skillsObj: Record<string, string[]> = {};
      
      const lines = rawText.includes('\n') ? rawText.split('\n') : rawText.split('|');
      lines.forEach(line => {
        const [mod, list] = line.split(':');
        if (mod && list) {
          skillsObj[mod.trim()] = list.split(',').map(s => s.trim()).filter(Boolean);
        }
      });
      await db.update(characters).set({ skills: skillsObj }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Skills updated.', ephemeral: true });
    }

    if (modalType === 'stunts') {
      const stunts = interaction.fields.getTextInputValue('stunts');
      await db.update(characters).set({ stunts }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Stunts updated.', ephemeral: true });
    }

    if (modalType === 'extras') {
      const extras = interaction.fields.getTextInputValue('extras');
      await db.update(characters).set({ extras }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Extras updated.', ephemeral: true });
    }

    if (modalType === 'stress') {
      const physInput = interaction.fields.getTextInputValue('physical').split(',').map(s => parseInt(s.trim(), 10));
      const mentInput = interaction.fields.getTextInputValue('mental').split(',').map(s => parseInt(s.trim(), 10));
      const physical = [1, 2, 3, 4].map(n => physInput.includes(n));
      const mental = [1, 2, 3, 4].map(n => mentInput.includes(n));
      await db.update(characters).set({ physicalStress: physical as any, mentalStress: mental as any }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Stress updated.', ephemeral: true });
    }

    if (modalType === 'consequences') {
      const mild = interaction.fields.getTextInputValue('mild');
      const moderate = interaction.fields.getTextInputValue('moderate');
      const severe = interaction.fields.getTextInputValue('severe');
      await db.update(characters).set({ consequences: { mild, moderate, severe } }).where(eq(characters.id, charId));
      await interaction.reply({ content: 'Consequences updated.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);