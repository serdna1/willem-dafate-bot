import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  StringSelectMenuBuilder,
  TextChannel
} from 'discord.js';
import { db } from './db/index.js';
import { characters, adventures, encounters } from './db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getTranslation } from './i18n.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const EMBED_COLOR = 0xFF1493;
const SHEET_COLOR = 0xFFA500; // Color distintivo para la ficha de personaje
const BATTLE_COLOR = 0xDC143C;

interface QueueItem {
  characterId: number;
  ap: number;
  isCurrent: boolean;
}

async function getGuildLanguage(guildId: string): Promise<string> {
  const activeAdv = await db.query.adventures.findFirst({
    where: and(eq(adventures.guildId, guildId), eq(adventures.isActive, true))
  });
  return activeAdv?.language || 'english';
}

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

/**
 * Parsea expresiones de dados tipo:
 * - "4df"
 * - "4df +2"
 * - "4df investigar"
 * - "4df investigar Antonio"
 * - "2dfss +1"
 * - "4dfs investigar"
 */
async function parseAndExecuteRoll(
  rawExpression: string,
  guildId: string,
  userId: string,
  allowPrivateS: boolean
) {
  const regex = allowPrivateS
    ? /^(\d+)df(ss|s)?(?:\s+(.*))?$/i
    : /^(\d+)df(ss)?(?:\s+(.*))?$/i;

  const match = rawExpression.trim().match(regex);
  if (!match) return null;

  const diceCount = parseInt(match[1], 10);
  if (diceCount < 1 || diceCount > 100) return null;

  const mode = (match[2] || '').toLowerCase(); // '' | 's' | 'ss'
  const rest = (match[3] || '').trim();

  let modifier = 0;
  let labelDetail = '';

  if (rest) {
    // Comprobar si es modificador numérico directo (+2, -1)
    const numMatch = rest.match(/^([+-]?\d+)$/);
    if (numMatch) {
      modifier = parseInt(numMatch[1], 10);
      labelDetail = `Mod: ${modifier >= 0 ? '+' : ''}${modifier}`;
    } else {
      // Es habilidad y opcionalmente nombre de personaje: "<skill>" o "<skill> <characterName>"
      const parts = rest.split(/\s+/);
      let character = null;
      let skillQuery = '';

      if (parts.length >= 2) {
        // Intentar buscar personaje con la última palabra o combinaciones
        const possibleCharName = parts.slice(1).join(' ');
        character = await db.query.characters.findFirst({
          where: and(eq(characters.name, possibleCharName), eq(characters.guildId, guildId))
        });

        if (character) {
          skillQuery = parts[0].toLowerCase();
        }
      }

      // Si no se especificó personaje válido al final, buscar el linkado al usuario
      if (!character) {
        skillQuery = rest.toLowerCase();
        character = await db.query.characters.findFirst({
          where: and(eq(characters.discordUserId, userId), eq(characters.guildId, guildId))
        });
      }

      if (!character) {
        return { error: 'CHAR_NOT_FOUND' };
      }

      const skillsObj = (character.skills as Record<string, string[]>) || {};
      let found = false;

      for (const [modStr, skillList] of Object.entries(skillsObj)) {
        const matchedSkill = skillList.find(s => s.toLowerCase() === skillQuery);
        if (matchedSkill) {
          modifier = parseInt(modStr, 10);
          labelDetail = `${character.name} — ${matchedSkill} (${modifier >= 0 ? '+' : ''}${modifier})`;
          found = true;
          break;
        }
      }

      if (!found) {
        return { error: 'SKILL_NOT_FOUND' };
      }
    }
  }

  const roll = rollDice(diceCount, modifier);
  return {
    mode,
    results: roll.results,
    total: roll.total,
    labelDetail
  };
}

/**
 * Construye el payload completo (Embed + Componentes) de la ficha larga del personaje
 */
function buildFullSheetPayload(character: any, t: any) {
  const aspectsText = character.aspects && character.aspects.trim() !== '' ? character.aspects : 'None';
  const stuntsText = character.stunts && character.stunts.trim() !== '' ? character.stunts : 'None';
  const extrasText = character.extras && character.extras.trim() !== '' ? character.extras : 'None';
  const consequences = (character.consequences as { mild: string; moderate: string; severe: string }) || { mild: '', moderate: '', severe: '' };
  const constText = `**${t.mild}:** ${consequences.mild || 'None'}\n**${t.moderate}:** ${consequences.moderate || 'None'}\n**${t.severe}:** ${consequences.severe || 'None'}`;

  const phys = (character.physicalStress as boolean[]) || [false, false, false, false];
  const ment = (character.mentalStress as boolean[]) || [false, false, false, false];
  const renderBoxes = (arr: boolean[]) => arr.map((v, i) => (v ? `[■ ${i + 1}]` : `[□ ${i + 1}]`)).join(' ');

  const skillsObj = (character.skills as Record<string, string[]>) || {};
  const skillsTextLines: string[] = [];
  const sortedMods = Object.keys(skillsObj).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  for (const mod of sortedMods) {
    if (skillsObj[mod]?.length > 0) {
      skillsTextLines.push(`**${mod}:** ${skillsObj[mod].join(', ')}`);
    }
  }
  const formattedSkillsText = skillsTextLines.join('\n') || 'None';

  const embed = new EmbedBuilder()
    .setColor(SHEET_COLOR)
    .setTitle(`✦ ${t.character.toUpperCase()}: ${character.name.toUpperCase()} ✦`)
    .addFields(
      { name: t.description, value: character.description || 'N/A' },
      { name: t.refresh, value: `**${character.refresh ?? 3}**`, inline: true },
      { name: t.physicalStress, value: renderBoxes(phys), inline: true },
      { name: t.mentalStress, value: renderBoxes(ment), inline: true },
      { name: t.aspects, value: aspectsText },
      { name: t.skills, value: formattedSkillsText },
      { name: t.stunts, value: stuntsText },
      { name: t.extras, value: extrasText },
      { name: t.consequences, value: constText }
    );

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

  const skillRows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentSkillRow = new ActionRowBuilder<ButtonBuilder>();
  let skillButtonCount = 0;

  for (const mod of sortedMods) {
    for (const skill of skillsObj[mod]) {
      if (skillRows.length >= 3) break; // Máximo 5 filas totales en Discord (2 edit + 3 skills)
      if (skillButtonCount >= 5) {
        skillRows.push(currentSkillRow);
        currentSkillRow = new ActionRowBuilder<ButtonBuilder>();
        skillButtonCount = 0;
      }
      currentSkillRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`skill_roll_${character.id}_${skill}`)
          .setLabel(`${t.roll} ${skill} (${mod})`)
          .setStyle(ButtonStyle.Success)
      );
      skillButtonCount++;
    }
  }
  if (skillButtonCount > 0 && skillRows.length < 3) {
    skillRows.push(currentSkillRow);
  }

  return { embeds: [embed], components: [editRow1, editRow2, ...skillRows] };
}

/**
 * Construye y actualiza el mensaje Dashboard del Encuentro/Combate
 */
async function buildBattleDashboard(encounter: any, t: any) {
  const queue = (encounter.turnQueue as QueueItem[]) || [];
  const allChars = await db.query.characters.findMany({
    where: eq(characters.guildId, encounter.guildId)
  });
  const charMap = new Map(allChars.map(c => [c.id, c]));

  const renderStress = (arr: boolean[]) => (arr || [false, false, false, false]).map(v => (v ? '■' : '□')).join('');
  const renderAP = (ap: number) => {
    const clamped = Math.max(0, Math.min(3, ap));
    return '🔴'.repeat(clamped) + '⚪'.repeat(3 - clamped);
  };

  let descriptionLines: string[] = [];

  if (encounter.sceneAspects && encounter.sceneAspects.trim() !== '') {
    descriptionLines.push(`🌍 **${t.sceneAspects}:**\n> ${encounter.sceneAspects.replace(/\n/g, '\n> ')}\n`);
  }

  if (queue.length === 0) {
    descriptionLines.push('_No characters in turn order yet. Use `/battle-add` or the button below._');
  } else {
    queue.forEach((item, index) => {
      const char = charMap.get(item.characterId);
      if (!char) return;

      const pointer = item.isCurrent ? '▶️ ' : '';
      const header = item.isCurrent
        ? `${pointer}**${index + 1}. ${char.name.toUpperCase()}** _(${t.currentTurn})_`
        : `**${index + 1}. ${char.name}**`;

      const ef = renderStress(char.physicalStress as boolean[]);
      const em = renderStress(char.mentalStress as boolean[]);
      const stats = `\`${t.ap}: ${renderAP(item.ap)} (${item.ap}/3)\` | \`${t.refresh}: ${char.refresh ?? 3}\` | \`EF:[${ef}]\` | \`EM:[${em}]\``;

      descriptionLines.push(`${header}\n${stats}`);
    });
  }

  const embed = new EmbedBuilder()
    .setColor(BATTLE_COLOR)
    .setTitle(`⚔️ ${t.encounter}: ${encounter.name}`)
    .setDescription(descriptionLines.join('\n\n'));

  if (!encounter.isActive) {
    embed.setFooter({ text: t.encounterEnded });
    return { embeds: [embed], components: [] };
  }

  // Fila 1: Controles del personaje activo (Current Turn)
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`btl_ap_add_${encounter.id}`).setLabel(`+1 ${t.ap}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btl_ap_sub_${encounter.id}`).setLabel(`-1 ${t.ap}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btl_pd_sub_${encounter.id}`).setLabel(`-1 ${t.refresh}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btl_pd_add_${encounter.id}`).setLabel(`+1 ${t.refresh}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btl_skip_${encounter.id}`).setLabel(`⏭️ ${t.skipTurn}`).setStyle(ButtonStyle.Success)
  );

  const components: any[] = [row1];

  // Fila 2: Selector de personaje
  if (queue.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`btl_select_${encounter.id}`)
      .setPlaceholder(t.selectCharPlaceholder);

    queue.forEach((item, idx) => {
      const char = charMap.get(item.characterId);
      if (char) {
        selectMenu.addOptions({
          label: `${idx + 1}. ${char.name}`,
          value: String(char.id),
          default: encounter.selectedCharId === char.id
        });
      }
    });

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

    // Fila 3: Manipulación sobre el personaje seleccionado
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`btl_up_${encounter.id}`).setLabel(`⬆️ ${t.moveUp}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`btl_down_${encounter.id}`).setLabel(`⬇️ ${t.moveDown}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`btl_turn_${encounter.id}`).setLabel(`⚡ ${t.giveTurn}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`btl_stress_${encounter.id}`).setLabel(`🩸 ${t.stress}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`btl_del_${encounter.id}`).setLabel(`❌ ${t.removeChar}`).setStyle(ButtonStyle.Danger)
    );
    components.push(row3);
  }

  // Fila 4: Escena y añadir personaje rápido
  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`btl_scene_${encounter.id}`).setLabel(`🌍 ${t.editSceneAspects}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btl_addchar_${encounter.id}`).setLabel(`➕ ${t.addNpcBtn}`).setStyle(ButtonStyle.Secondary)
  );
  components.push(row4);

  return { embeds: [embed], components };
}

async function refreshEncounterMessage(encounterId: number, t: any) {
  const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
  if (!encounter || !encounter.channelId || !encounter.messageId) return;

  try {
    const channel = (await client.channels.fetch(encounter.channelId)) as TextChannel;
    if (!channel) return;
    const msg = await channel.messages.fetch(encounter.messageId);
    if (!msg) return;

    const payload = await buildBattleDashboard(encounter, t);
    await msg.edit(payload);
  } catch (err) {
    console.error('Could not refresh battle message:', err);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  await client.application?.commands.set([
    {
      name: 'roll',
      description: 'Roll Fate dice (supports 4df, 4dfs, 4dfss, modifiers, skills and character names)',
      options: [
        {
          name: 'expression',
          type: ApplicationCommandOptionType.String,
          description: 'e.g. 4df, 4dfs, 4dfss, 4df +2, 4df Shoot, 4df Shoot Antonio',
          required: true
        }
      ]
    },
    {
      name: 'sheet',
      description: 'View character sheet privately (ephemeral)',
      options: [
        {
          name: 'name',
          type: ApplicationCommandOptionType.String,
          description: 'Character name (optional, defaults to your linked character)',
          required: false
        }
      ]
    },
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
      description: 'Show active adventure details and edit options'
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
      name: 'battle-start',
      description: 'Start a turn-based encounter dashboard',
      options: [
        { name: 'name', type: ApplicationCommandOptionType.String, description: 'Encounter name', required: true },
        { name: 'scene_aspects', type: ApplicationCommandOptionType.String, description: 'Initial scene aspects', required: false }
      ]
    },
    {
      name: 'battle-add',
      description: 'Add a character to the active encounter (creates it if it does not exist)',
      options: [
        { name: 'name', type: ApplicationCommandOptionType.String, description: 'Character name', required: true }
      ]
    },
    {
      name: 'battle-end',
      description: 'End the active encounter'
    },
    {
      name: 'View Character Sheet',
      type: ApplicationCommandType.User
    }
  ]);
});

// Mensajes de texto normales: solo soporta Ndf y Ndfss (4dfs privado requiere /roll)
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId) return;
  const text = message.content.trim();

  if (!/^\d+df/i.test(text)) return;

  const lang = await getGuildLanguage(message.guildId);
  const t = getTranslation(lang);

  // allowPrivateS = false -> 4dfs en texto plano no se ejecuta; 4dfss y 4df sí
  const rollOutcome = await parseAndExecuteRoll(text, message.guildId, message.author.id, false);
  if (!rollOutcome) return;

  if ('error' in rollOutcome) {
    const errorMsg = rollOutcome.error === 'CHAR_NOT_FOUND' ? t.charNotFound : t.skillNotFound;
    await message.reply({ content: errorMsg });
    return;
  }

  const detailText = rollOutcome.labelDetail ? ` (${rollOutcome.labelDetail})` : '';

  // Modo 4dfss: oculto para todos hasta que alguien pulse el botón
  if (rollOutcome.mode === 'ss') {
    const payloadData = Buffer.from(
      JSON.stringify({
        r: rollOutcome.results,
        t: rollOutcome.total,
        d: detailText,
        user: message.author.username
      })
    ).toString('base64');

    const revealBtn = new ButtonBuilder()
      .setCustomId(`reveal_ss_${payloadData}`)
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

  // Modo normal Ndf
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(t.diceRollResult)
    .setDescription(`[ ${rollOutcome.results.join(' , ')} ]${detailText}\n\n**Total:** \`${rollOutcome.total}\``);

  await message.reply({ embeds: [embed] });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) return;
  const lang = await getGuildLanguage(interaction.guildId);
  const t = getTranslation(lang);

  // ==========================================
  // 1. SLASH COMMANDS
  // ==========================================
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'roll') {
      const expr = interaction.options.getString('expression', true);
      const rollOutcome = await parseAndExecuteRoll(expr, interaction.guildId, interaction.user.id, true);

      if (!rollOutcome) {
        await interaction.reply({ content: 'Invalid dice format.', ephemeral: true });
        return;
      }

      if ('error' in rollOutcome) {
        const errorMsg = rollOutcome.error === 'CHAR_NOT_FOUND' ? t.charNotFound : t.skillNotFound;
        await interaction.reply({ content: errorMsg, ephemeral: true });
        return;
      }

      const detailText = rollOutcome.labelDetail ? ` (${rollOutcome.labelDetail})` : '';

      // /roll 4dfs -> Efímero solo para el usuario que tira, con botón para hacer público
      if (rollOutcome.mode === 's') {
        const payloadData = Buffer.from(
          JSON.stringify({
            r: rollOutcome.results,
            t: rollOutcome.total,
            d: detailText,
            user: interaction.user.username
          })
        ).toString('base64');

        const revealBtn = new ButtonBuilder()
          .setCustomId(`reveal_private_${payloadData}`)
          .setLabel(t.showRoll)
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(revealBtn);

        await interaction.reply({
          content: `${t.privateRollHeader}\n[ ${rollOutcome.results.join(' , ')} ]${detailText}\n\n**Total:** \`${rollOutcome.total}\``,
          components: [row],
          ephemeral: true
        });
        return;
      }

      // /roll 4dfss -> Oculto para todos con botón público
      if (rollOutcome.mode === 'ss') {
        const payloadData = Buffer.from(
          JSON.stringify({
            r: rollOutcome.results,
            t: rollOutcome.total,
            d: detailText,
            user: interaction.user.username
          })
        ).toString('base64');

        const revealBtn = new ButtonBuilder()
          .setCustomId(`reveal_ss_${payloadData}`)
          .setLabel(t.showRoll)
          .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(revealBtn);

        await interaction.reply({
          content: `🎲 **${interaction.user.username}** ${t.hiddenRoll}`,
          components: [row]
        });
        return;
      }

      // /roll 4df -> Público normal
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(t.diceRollResult)
        .setDescription(`[ ${rollOutcome.results.join(' , ')} ]${detailText}\n\n**Total:** \`${rollOutcome.total}\``);

      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'sheet') {
      const charName = interaction.options.getString('name');
      const character = charName
        ? await db.query.characters.findFirst({
            where: and(eq(characters.name, charName), eq(characters.guildId, interaction.guildId))
          })
        : await db.query.characters.findFirst({
            where: and(eq(characters.discordUserId, interaction.user.id), eq(characters.guildId, interaction.guildId))
          });

      if (!character) {
        await interaction.reply({ content: t.charNotFound, ephemeral: true });
        return;
      }

      const payload = buildFullSheetPayload(character, t);
      await interaction.reply({ ...payload, ephemeral: true });
    }

    if (commandName === 'change_language') {
      const selectedLang = interaction.options.getString('language', true);
      await db
        .update(adventures)
        .set({ language: selectedLang })
        .where(and(eq(adventures.guildId, interaction.guildId), eq(adventures.isActive, true)));
      const newT = getTranslation(selectedLang);
      await interaction.reply({ content: newT.langChanged, ephemeral: true });
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

      const editAdvBtn = new ButtonBuilder()
        .setCustomId(`edit_adv_${activeAdventure.id}`)
        .setLabel(t.editAdventure)
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editAdvBtn);

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`Adventure: ${activeAdventure.name}`)
        .addFields(
          { name: t.description, value: activeAdventure.description || 'N/A' },
          { name: t.status, value: activeAdventure.isActive ? t.active : t.inactive, inline: true },
          { name: t.characters, value: charNames }
        );
      await interaction.reply({ embeds: [embed], components: [row] });
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
        await interaction.reply({ content: t.charNotFound, ephemeral: true });
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

    if (commandName === 'battle-start') {
      const name = interaction.options.getString('name', true);
      const sceneAspects = interaction.options.getString('scene_aspects') || '';

      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });
      if (!activeAdventure) {
        await interaction.reply({ content: t.noActiveAdventure, ephemeral: true });
        return;
      }

      // Desactivar combates anteriores en este servidor
      await db.update(encounters).set({ isActive: false }).where(eq(encounters.guildId, interaction.guildId));

      const [newEncounter] = await db
        .insert(encounters)
        .values({
          guildId: interaction.guildId,
          adventureId: activeAdventure.id,
          name,
          sceneAspects,
          channelId: interaction.channelId,
          isActive: true,
          turnQueue: []
        })
        .returning();

      const payload = await buildBattleDashboard(newEncounter, t);
      const replyMsg = await interaction.reply({ ...payload, fetchReply: true });

      await db.update(encounters).set({ messageId: replyMsg.id }).where(eq(encounters.id, newEncounter.id));
    }

    if (commandName === 'battle-add') {
      const charName = interaction.options.getString('name', true);

      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });
      if (!activeAdventure) {
        await interaction.reply({ content: t.noActiveAdventure, ephemeral: true });
        return;
      }

      const activeEncounter = await db.query.encounters.findFirst({
        where: and(eq(encounters.isActive, true), eq(encounters.guildId, interaction.guildId))
      });
      if (!activeEncounter) {
        await interaction.reply({ content: t.noActiveEncounter, ephemeral: true });
        return;
      }

      // Buscar o crear personaje automáticamente
      let character = await db.query.characters.findFirst({
        where: and(eq(characters.name, charName), eq(characters.guildId, interaction.guildId))
      });

      if (!character) {
        const [created] = await db
          .insert(characters)
          .values({
            guildId: interaction.guildId,
            adventureId: activeAdventure.id,
            name: charName
          })
          .returning();
        character = created;
      }

      const queue = (activeEncounter.turnQueue as QueueItem[]) || [];
      if (!queue.some(q => q.characterId === character!.id)) {
        queue.push({
          characterId: character.id,
          ap: 0,
          isCurrent: queue.length === 0
        });
      }

      await db
        .update(encounters)
        .set({
          turnQueue: queue as any,
          selectedCharId: activeEncounter.selectedCharId || character.id
        })
        .where(eq(encounters.id, activeEncounter.id));

      await refreshEncounterMessage(activeEncounter.id, t);
      await interaction.reply({ content: `✅ **${character.name}** added to encounter.`, ephemeral: true });
    }

    if (commandName === 'battle-end') {
      const activeEncounter = await db.query.encounters.findFirst({
        where: and(eq(encounters.isActive, true), eq(encounters.guildId, interaction.guildId))
      });
      if (!activeEncounter) {
        await interaction.reply({ content: t.noActiveEncounter, ephemeral: true });
        return;
      }

      await db.update(encounters).set({ isActive: false }).where(eq(encounters.id, activeEncounter.id));
      await refreshEncounterMessage(activeEncounter.id, t);
      await interaction.reply({ content: t.encounterEnded, ephemeral: true });
    }
  }

  // ==========================================
  // 2. USER CONTEXT MENU
  // ==========================================
  if (interaction.isUserContextMenuCommand() && interaction.commandName === 'View Character Sheet') {
    const character = await db.query.characters.findFirst({
      where: and(eq(characters.discordUserId, interaction.targetId), eq(characters.guildId, interaction.guildId))
    });
    if (!character) {
      await interaction.reply({ content: t.charNotFound, ephemeral: true });
      return;
    }
    const payload = buildFullSheetPayload(character, t);
    await interaction.reply({ ...payload, ephemeral: true });
  }

  // ==========================================
  // 3. SELECT MENUS (COMBATE)
  // ==========================================
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('btl_select_')) {
    const encounterId = parseInt(interaction.customId.split('_')[2], 10);
    const selectedCharId = parseInt(interaction.values[0], 10);

    await db.update(encounters).set({ selectedCharId }).where(eq(encounters.id, encounterId));
    const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
    if (encounter) {
      const payload = await buildBattleDashboard(encounter, t);
      await interaction.update(payload);
    }
  }

  // ==========================================
  // 4. BUTTONS
  // ==========================================
  if (interaction.isButton()) {
    const id = interaction.customId;

    // 4.1 Revelar tirada silenciosa 4dfss (edita el mensaje original)
    if (id.startsWith('reveal_ss_')) {
      const data = JSON.parse(Buffer.from(id.replace('reveal_ss_', ''), 'base64').toString('utf8'));
      await interaction.update({
        content: `🎲 **${data.user}** ${t.revealedRoll}:\n[ ${data.r.join(' , ')} ]${data.d}\n\n**Total:** \`${data.t}\``,
        components: []
      });
      return;
    }

    // 4.2 Revelar tirada privada /roll 4dfs (envía mensaje público y deshabilita botón efímero)
    if (id.startsWith('reveal_private_')) {
      const data = JSON.parse(Buffer.from(id.replace('reveal_private_', ''), 'base64').toString('utf8'));
      await interaction.update({
        content: `✅ Shared with channel.`,
        components: []
      });
      await interaction.followUp({
        content: `🎲 **${data.user}** ${t.revealedRoll}:\n[ ${data.r.join(' , ')} ]${data.d}\n\n**Total:** \`${data.t}\``,
        ephemeral: false
      });
      return;
    }

    // 4.3 Tirada de habilidad desde la ficha
    if (id.startsWith('skill_roll_')) {
      const [, , charIdStr, skillName] = id.split('_');
      const charId = parseInt(charIdStr, 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      if (!character || !character.skills) return;

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
        .setTitle(`${character.name} — ${t.skills}: ${skillName}`)
        .setDescription(`[ ${roll.results.join(' , ')} ] (Mod: ${modifier >= 0 ? '+' : ''}${modifier})\n\n**Total:** \`${roll.total}\``);
      await interaction.reply({ embeds: [embed] });
      return;
    }

    // 4.4 Botón Editar Aventura (/adventure-info)
    if (id.startsWith('edit_adv_')) {
      const advId = parseInt(id.split('_')[2], 10);
      const adv = await db.query.adventures.findFirst({ where: eq(adventures.id, advId) });

      const modal = new ModalBuilder().setCustomId(`modal_adv_${advId}`).setTitle(t.editAdventure);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(adv?.name || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('description').setLabel(t.description).setStyle(TextInputStyle.Paragraph).setValue(adv?.description || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('is_active')
            .setLabel('Active? (true / false)')
            .setStyle(TextInputStyle.Short)
            .setValue(String(adv?.isActive ?? true))
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    // 4.5 Botones de edición de Ficha de Personaje
    if (id.startsWith('edit_id_')) {
      const charId = parseInt(id.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });

      const modal = new ModalBuilder().setCustomId(`modal_id_${charId}`).setTitle(t.editId);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(character?.name || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('description').setLabel(t.description).setStyle(TextInputStyle.Paragraph).setValue(character?.description || '').setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('refresh').setLabel(t.refresh).setStyle(TextInputStyle.Short).setValue(String(character?.refresh ?? 3)).setRequired(false)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id.startsWith('edit_aspects_')) {
      const charId = parseInt(id.split('_')[2], 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });

      const modal = new ModalBuilder().setCustomId(`modal_aspects_${charId}`).setTitle(t.editAspects);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('aspects')
            .setLabel(t.aspects)
            .setStyle(TextInputStyle.Paragraph)
            .setValue(character?.aspects || '')
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id.startsWith('edit_skills_')) {
      const charId = parseInt(id.split('_')[2], 10);
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
      return;
    }

    if (id.startsWith('edit_stunts_')) {
      const charId = parseInt(id.split('_')[2], 10);
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
      return;
    }

    if (id.startsWith('edit_extras_')) {
      const charId = parseInt(id.split('_')[2], 10);
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
      return;
    }

    if (id.startsWith('edit_stress_')) {
      const charId = parseInt(id.split('_')[2], 10);
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
            .setLabel(`${t.physicalStress} (1-4)`)
            .setPlaceholder('1, 2, 3, 4')
            .setStyle(TextInputStyle.Short)
            .setValue(physStr)
            .setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('mental')
            .setLabel(`${t.mentalStress} (1-4)`)
            .setPlaceholder('1, 2, 3, 4')
            .setStyle(TextInputStyle.Short)
            .setValue(mentStr)
            .setRequired(false)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id.startsWith('edit_consequences_')) {
      const charId = parseInt(id.split('_')[2], 10);
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
      return;
    }

    // 4.6 Botones del Sistema de Turnos / Combate
    if (id.startsWith('btl_')) {
      const parts = id.split('_');
      const encounterId = parseInt(parts[parts.length - 1], 10);
      const action = parts.slice(1, parts.length - 1).join('_');

      const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
      if (!encounter || !encounter.isActive) return;

      const queue = (encounter.turnQueue as QueueItem[]) || [];
      const currentIdx = queue.findIndex(q => q.isCurrent);
      const selectedIdx = queue.findIndex(q => q.characterId === encounter.selectedCharId);

      if (action === 'ap_add' && currentIdx !== -1) {
        queue[currentIdx].ap = Math.min(3, queue[currentIdx].ap + 1);
      } else if (action === 'ap_sub' && currentIdx !== -1) {
        queue[currentIdx].ap = Math.max(0, queue[currentIdx].ap - 1);
      } else if (action === 'pd_sub' && currentIdx !== -1) {
        const char = await db.query.characters.findFirst({ where: eq(characters.id, queue[currentIdx].characterId) });
        if (char) {
          await db.update(characters).set({ refresh: Math.max(0, (char.refresh ?? 3) - 1) }).where(eq(characters.id, char.id));
        }
      } else if (action === 'pd_add' && currentIdx !== -1) {
        const char = await db.query.characters.findFirst({ where: eq(characters.id, queue[currentIdx].characterId) });
        if (char) {
          await db.update(characters).set({ refresh: (char.refresh ?? 3) + 1 }).where(eq(characters.id, char.id));
        }
      } else if (action === 'skip' && queue.length > 0) {
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % queue.length;
        queue.forEach((q, idx) => {
          q.isCurrent = idx === nextIdx;
          if (idx === nextIdx) q.ap = 0;
        });
      } else if (action === 'up' && selectedIdx > 0) {
        [queue[selectedIdx - 1], queue[selectedIdx]] = [queue[selectedIdx], queue[selectedIdx - 1]];
      } else if (action === 'down' && selectedIdx !== -1 && selectedIdx < queue.length - 1) {
        [queue[selectedIdx + 1], queue[selectedIdx]] = [queue[selectedIdx], queue[selectedIdx + 1]];
      } else if (action === 'turn' && selectedIdx !== -1) {
        queue.forEach((q, idx) => {
          q.isCurrent = idx === selectedIdx;
          if (idx === selectedIdx) q.ap = 0;
        });
      } else if (action === 'del' && selectedIdx !== -1) {
        const wasCurrent = queue[selectedIdx].isCurrent;
        queue.splice(selectedIdx, 1);
        if (wasCurrent && queue.length > 0) {
          queue[selectedIdx % queue.length].isCurrent = true;
        }
      } else if (action === 'stress' && selectedIdx !== -1) {
        const targetCharId = queue[selectedIdx].characterId;
        const character = await db.query.characters.findFirst({ where: eq(characters.id, targetCharId) });
        const phys = (character?.physicalStress as boolean[]) || [false, false, false, false];
        const ment = (character?.mentalStress as boolean[]) || [false, false, false, false];

        const physStr = phys.map((v, i) => (v ? i + 1 : null)).filter(Boolean).join(',');
        const mentStr = ment.map((v, i) => (v ? i + 1 : null)).filter(Boolean).join(',');

        const modal = new ModalBuilder().setCustomId(`modal_btlstress_${targetCharId}_${encounter.id}`).setTitle(`${t.editStress}: ${character?.name}`);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('physical').setLabel(`${t.physicalStress} (1-4)`).setValue(physStr).setRequired(false).setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('mental').setLabel(`${t.mentalStress} (1-4)`).setValue(mentStr).setRequired(false).setStyle(TextInputStyle.Short)
          )
        );
        await interaction.showModal(modal);
        return;
      } else if (action === 'scene') {
        const modal = new ModalBuilder().setCustomId(`modal_btlscene_${encounter.id}`).setTitle(t.editSceneAspects);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('scene_aspects')
              .setLabel(t.sceneAspects)
              .setStyle(TextInputStyle.Paragraph)
              .setValue(encounter.sceneAspects || '')
              .setRequired(false)
          )
        );
        await interaction.showModal(modal);
        return;
      } else if (action === 'addchar') {
        const modal = new ModalBuilder().setCustomId(`modal_btladd_${encounter.id}`).setTitle(t.addNpcBtn);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('char_name').setLabel('Name').setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      await db.update(encounters).set({ turnQueue: queue as any }).where(eq(encounters.id, encounter.id));
      const updatedEncounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounter.id) });
      const payload = await buildBattleDashboard(updatedEncounter, t);
      await interaction.update(payload);
    }
  }

  // ==========================================
  // 5. MODAL SUBMISSIONS
  // ==========================================
  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split('_');
    const modalType = parts[1];
    const targetId = parseInt(parts[2], 10);

    if (modalType === 'adv') {
      const name = interaction.fields.getTextInputValue('name');
      const description = interaction.fields.getTextInputValue('description');
      const activeRaw = interaction.fields.getTextInputValue('is_active').toLowerCase().trim();
      const isActive = activeRaw === 'true' || activeRaw === '1' || activeRaw === 'yes' || activeRaw === 'si';

      await db.update(adventures).set({ name, description, isActive }).where(eq(adventures.id, targetId));
      await interaction.reply({ content: 'Adventure updated.', ephemeral: true });
    }

    if (modalType === 'id') {
      const name = interaction.fields.getTextInputValue('name');
      const description = interaction.fields.getTextInputValue('description');
      const refreshStr = interaction.fields.getTextInputValue('refresh');
      const refresh = refreshStr ? parseInt(refreshStr, 10) : 3;

      await db.update(characters).set({ name, description, refresh }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Character ID updated.', ephemeral: true });
    }

    if (modalType === 'aspects') {
      const aspects = interaction.fields.getTextInputValue('aspects');
      await db.update(characters).set({ aspects }).where(eq(characters.id, targetId));
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
      await db.update(characters).set({ skills: skillsObj }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Skills updated.', ephemeral: true });
    }

    if (modalType === 'stunts') {
      const stunts = interaction.fields.getTextInputValue('stunts');
      await db.update(characters).set({ stunts }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Stunts updated.', ephemeral: true });
    }

    if (modalType === 'extras') {
      const extras = interaction.fields.getTextInputValue('extras');
      await db.update(characters).set({ extras }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Extras updated.', ephemeral: true });
    }

    if (modalType === 'stress') {
      const physInput = interaction.fields.getTextInputValue('physical').split(',').map(s => parseInt(s.trim(), 10));
      const mentInput = interaction.fields.getTextInputValue('mental').split(',').map(s => parseInt(s.trim(), 10));
      const physical = [1, 2, 3, 4].map(n => physInput.includes(n));
      const mental = [1, 2, 3, 4].map(n => mentInput.includes(n));
      await db.update(characters).set({ physicalStress: physical as any, mentalStress: mental as any }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Stress updated.', ephemeral: true });
    }

    if (modalType === 'consequences') {
      const mild = interaction.fields.getTextInputValue('mild');
      const moderate = interaction.fields.getTextInputValue('moderate');
      const severe = interaction.fields.getTextInputValue('severe');
      await db.update(characters).set({ consequences: { mild, moderate, severe } }).where(eq(characters.id, targetId));
      await interaction.reply({ content: 'Consequences updated.', ephemeral: true });
    }

    // Modales del sistema de combate (actualizan personaje/escena y refrescan dashboard)
    if (modalType === 'btlstress') {
      const encounterId = parseInt(parts[3], 10);
      const physInput = interaction.fields.getTextInputValue('physical').split(',').map(s => parseInt(s.trim(), 10));
      const mentInput = interaction.fields.getTextInputValue('mental').split(',').map(s => parseInt(s.trim(), 10));
      const physical = [1, 2, 3, 4].map(n => physInput.includes(n));
      const mental = [1, 2, 3, 4].map(n => mentInput.includes(n));

      await db.update(characters).set({ physicalStress: physical as any, mentalStress: mental as any }).where(eq(characters.id, targetId));
      await refreshEncounterMessage(encounterId, t);
      await interaction.reply({ content: 'Stress updated.', ephemeral: true });
    }

    if (modalType === 'btlscene') {
      const sceneAspects = interaction.fields.getTextInputValue('scene_aspects');
      await db.update(encounters).set({ sceneAspects }).where(eq(encounters.id, targetId));
      await refreshEncounterMessage(targetId, t);
      await interaction.reply({ content: 'Scene aspects updated.', ephemeral: true });
    }

    if (modalType === 'btladd') {
      const charName = interaction.fields.getTextInputValue('char_name').trim();
      const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, targetId) });
      if (!encounter) return;

      let character = await db.query.characters.findFirst({
        where: and(eq(characters.name, charName), eq(characters.guildId, interaction.guildId))
      });

      if (!character) {
        const [created] = await db
          .insert(characters)
          .values({
            guildId: interaction.guildId,
            adventureId: encounter.adventureId,
            name: charName
          })
          .returning();
        character = created;
      }

      const queue = (encounter.turnQueue as QueueItem[]) || [];
      if (!queue.some(q => q.characterId === character!.id)) {
        queue.push({
          characterId: character.id,
          ap: 0,
          isCurrent: queue.length === 0
        });
      }

      await db
        .update(encounters)
        .set({
          turnQueue: queue as any,
          selectedCharId: encounter.selectedCharId || character.id
        })
        .where(eq(encounters.id, encounter.id));

      await refreshEncounterMessage(encounter.id, t);
      await interaction.reply({ content: `✅ **${character.name}** added.`, ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);