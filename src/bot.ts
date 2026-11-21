import {
  Client,
  Events,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  CheckboxGroupBuilder,
  CheckboxBuilder,
  TextDisplayBuilder,
  EmbedBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  TextChannel
} from 'discord.js';
import { db } from './db/index.js';
import { characters, adventures, encounters, notes } from './db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getTranslation } from './i18n.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const EMBED_COLOR = 0xFF1493;
const SHEET_COLOR = 0xFFA500;
const BATTLE_COLOR = 0xDC143C;
const NOTE_COLOR = 0x00CED1;

interface QueueItem {
  characterId: number;
  ap: number;
  maxAp: number;
}

interface PendingRollData {
  results: string[];
  total: number;
  detail: string;
  user: string;
}

const activeSheetInteractions = new Map<string, { interaction: any; page: number }>();

// Almacén en memoria para tiradas ocultas/privadas (evita superar el límite de 100 caracteres del custom_id de Discord)
const pendingRolls = new Map<string, PendingRollData>();

function storePendingRoll(data: PendingRollData): string {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  pendingRolls.set(id, data);
  // Limpieza automática tras 24 horas
  setTimeout(() => pendingRolls.delete(id), 24 * 60 * 60 * 1000);
  return id;
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
  const results: string[] = [];

  for (let i = 0; i < diceCount; i++) {
    const face = faces[Math.floor(Math.random() * faces.length)];
    results.push(face);
    total += values[face as keyof typeof values];
  }
  return { results, total: total + modifier };
}

async function parseAndExecuteRoll(
  rawExpression: string,
  guildId: string,
  userId: string,
  allowPrivateS: boolean
) {
  const regex = /^(\d+)df(ss|s)?(?:\s+(.*)|([+-]\d+))?$/i;
  const match = rawExpression.trim().match(regex);
  if (!match) return null;

  const diceCount = parseInt(match[1], 10);
  if (diceCount < 1 || diceCount > 100) return null;

  const mode = (match[2] || '').toLowerCase();
  if (mode === 's' && !allowPrivateS) return null;

  const rest = (match[3] || match[4] || '').trim();
  let modifier = 0;
  let labelDetail = '';

  if (rest) {
    const numMatch = rest.match(/^([+-]?\d+)$/);
    if (numMatch) {
      modifier = parseInt(numMatch[1], 10);
      labelDetail = `Mod: ${modifier >= 0 ? '+' : ''}${modifier}`;
    } else {
      const parts = rest.split(/\s+/);
      let character = null;
      let skillQuery = '';

      if (parts.length >= 2) {
        const possibleCharName = parts.slice(1).join(' ');
        character = await db.query.characters.findFirst({
          where: and(eq(characters.name, possibleCharName), eq(characters.guildId, guildId))
        });
        if (character) {
          skillQuery = parts[0].toLowerCase();
        }
      }

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
 * Helper para construir el modal de estrés con CheckboxGroups (1, 2, 3, 4)
 */
function buildStressModal(customId: string, title: string, character: any, t: any) {
  const phys = (character?.physicalStress as boolean[]) || [false, false, false, false];
  const ment = (character?.mentalStress as boolean[]) || [false, false, false, false];

  const physGroup = new CheckboxGroupBuilder()
    .setCustomId('physical')
    .setMinValues(0)
    .setMaxValues(4)
    .setRequired(false)
    .setOptions(
      [1, 2, 3, 4].map((num, idx) => ({
        label: String(num),
        value: String(num),
        default: Boolean(phys[idx])
      }))
    );

  const mentGroup = new CheckboxGroupBuilder()
    .setCustomId('mental')
    .setMinValues(0)
    .setMaxValues(4)
    .setRequired(false)
    .setOptions(
      [1, 2, 3, 4].map((num, idx) => ({
        label: String(num),
        value: String(num),
        default: Boolean(ment[idx])
      }))
    );

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel(t.physicalStress).setCheckboxGroupComponent(physGroup),
      new LabelBuilder().setLabel(t.mentalStress).setCheckboxGroupComponent(mentGroup)
    );
}

function buildSheetPagePayload(character: any, page: number, t: any) {
  const totalPages = 7;
  const safePage = ((page % totalPages) + totalPages) % totalPages;

  const pageTitles = [
    t.description,
    t.aspects,
    t.skills,
    t.stunts,
    t.extras,
    t.consequences,
    t.stress
  ];

  const embed = new EmbedBuilder()
    .setColor(SHEET_COLOR)
    .setTitle(`✦ ${t.character.toUpperCase()}: ${character.name.toUpperCase()} ✦`)
    .setDescription(`**${t.refresh}:** \`${character.refresh ?? 3}\`  |  **${pageTitles[safePage]}**`)
    .setFooter({ text: `${t.page} ${safePage + 1}/${totalPages}` });

  const headerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sh_edit_name_${character.id}_${safePage}`).setLabel(t.editName).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sh_edit_refresh_${character.id}_${safePage}`).setLabel(t.editRefresh).setStyle(ButtonStyle.Secondary)
  );

  const skillRows: ActionRowBuilder<ButtonBuilder>[] = [];

  if (safePage === 0) {
    embed.addFields({ name: t.description, value: character.description || 'N/A' });
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_desc_${character.id}_${safePage}`).setLabel(t.editDescription).setStyle(ButtonStyle.Secondary)
    );
  } else if (safePage === 1) {
    embed.addFields({ name: t.aspects, value: character.aspects && character.aspects.trim() !== '' ? character.aspects : 'None' });
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_aspects_${character.id}_${safePage}`).setLabel(t.editAspects).setStyle(ButtonStyle.Secondary)
    );
  } else if (safePage === 2) {
    const skillsObj = (character.skills as Record<string, string[]>) || {};
    const sortedMods = Object.keys(skillsObj).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    const lines: string[] = [];
    for (const mod of sortedMods) {
      if (skillsObj[mod]?.length > 0) {
        lines.push(`**${mod}:** ${skillsObj[mod].join(', ')}`);
      }
    }
    embed.addFields({ name: t.skills, value: lines.join('\n') || 'None' });
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_skills_${character.id}_${safePage}`).setLabel(t.editSkills).setStyle(ButtonStyle.Secondary)
    );

    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    let count = 0;
    for (const mod of sortedMods) {
      for (const skill of skillsObj[mod]) {
        if (skillRows.length >= 3) break;
        if (count >= 5) {
          skillRows.push(currentRow);
          currentRow = new ActionRowBuilder<ButtonBuilder>();
          count = 0;
        }
        currentRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`skill_roll_${character.id}_${skill}`)
            .setLabel(`${t.roll} ${skill} (${mod})`)
            .setStyle(ButtonStyle.Success)
        );
        count++;
      }
    }
    if (count > 0 && skillRows.length < 3) {
      skillRows.push(currentRow);
    }
  } else if (safePage === 3) {
    embed.addFields({ name: t.stunts, value: character.stunts && character.stunts.trim() !== '' ? character.stunts : 'None' });
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_stunts_${character.id}_${safePage}`).setLabel(t.editStunts).setStyle(ButtonStyle.Secondary)
    );
  } else if (safePage === 4) {
    embed.addFields({ name: t.extras, value: character.extras && character.extras.trim() !== '' ? character.extras : 'None' });
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_extras_${character.id}_${safePage}`).setLabel(t.editExtras).setStyle(ButtonStyle.Secondary)
    );
  } else if (safePage === 5) {
    const cons = (character.consequences as { mild: string; moderate: string; severe: string }) || { mild: '', moderate: '', severe: '' };
    embed.addFields(
      { name: t.mild, value: cons.mild || 'None' },
      { name: t.moderate, value: cons.moderate || 'None' },
      { name: t.severe, value: cons.severe || 'None' }
    );
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_cons_${character.id}_${safePage}`).setLabel(t.editConsequences).setStyle(ButtonStyle.Secondary)
    );
  } else if (safePage === 6) {
    const phys = (character.physicalStress as boolean[]) || [false, false, false, false];
    const ment = (character.mentalStress as boolean[]) || [false, false, false, false];
    const renderBoxes = (arr: boolean[]) => arr.map((v, i) => (v ? `[■ ${i + 1}]` : `[□ ${i + 1}]`)).join(' ');

    embed.addFields(
      { name: t.physicalStress, value: renderBoxes(phys), inline: true },
      { name: t.mentalStress, value: renderBoxes(ment), inline: true }
    );
    headerRow.addComponents(
      new ButtonBuilder().setCustomId(`sh_edit_stress_${character.id}_${safePage}`).setLabel(t.editStress).setStyle(ButtonStyle.Secondary)
    );
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sh_page_${character.id}_${safePage - 1}`).setLabel(t.prevPage).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sh_page_${character.id}_${safePage + 1}`).setLabel(t.nextPage).setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [headerRow, ...skillRows, navRow] };
}

async function buildEncounterDashboard(encounter: any, t: any) {
  const queue = (encounter.turnQueue as QueueItem[]) || [];
  const allChars = await db.query.characters.findMany({
    where: eq(characters.guildId, encounter.guildId)
  });
  const charMap = new Map(allChars.map(c => [c.id, c]));

  const renderStress = (arr: boolean[]) => (arr || [false, false, false, false]).map(v => (v ? '■' : '□')).join('');
  const renderAP = (ap: number, maxAp: number) => {
    const safeMax = Math.max(1, maxAp || 3);
    const clamped = Math.max(0, Math.min(safeMax, ap));
    return '🔴'.repeat(clamped) + '⚪'.repeat(safeMax - clamped);
  };

  const descriptionLines: string[] = [];

  if (encounter.sceneAspects && encounter.sceneAspects.trim() !== '') {
    descriptionLines.push(`🌍 **${t.sceneAspects}:**\n> ${encounter.sceneAspects.replace(/\n/g, '\n> ')}\n`);
  }

  if (queue.length === 0) {
    descriptionLines.push('_No participants yet. Click "Add Character" below._');
  } else {
    queue.forEach((item, index) => {
      const char = charMap.get(item.characterId);
      if (!char) return;

      const isFirst = index === 0;
      const maxAp = item.maxAp || 3;
      const header = isFirst
        ? `▶️ **1. ${char.name.toUpperCase()}** _(${t.currentTurn})_`
        : `**${index + 1}. ${char.name}**`;

      const ef = renderStress(char.physicalStress as boolean[]);
      const em = renderStress(char.mentalStress as boolean[]);
      const stats = `\`${t.ap}: ${renderAP(item.ap, maxAp)} (${item.ap}/${maxAp})\` | \`${t.refresh}: ${char.refresh ?? 3}\` | \`EF:[${ef}]\` | \`EM:[${em}]\``;

      descriptionLines.push(`${header}\n${stats}`);
    });
  }

  const embed = new EmbedBuilder()
    .setColor(BATTLE_COLOR)
    .setTitle(`⚔️ ${t.encounter}: ${encounter.name}`)
    .setDescription(descriptionLines.join('\n\n'));

  const components: any[] = [];

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`enc_ap_add_${encounter.id}`).setLabel(`+1 ${t.ap}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`enc_ap_sub_${encounter.id}`).setLabel(`-1 ${t.ap}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`enc_skip_${encounter.id}`).setLabel(`⏭️ ${t.skipTurn}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`enc_scene_${encounter.id}`).setLabel(`🌍 ${t.editSceneAspects}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`enc_rename_${encounter.id}`).setLabel(`✏️ ${t.renameEncounter}`).setStyle(ButtonStyle.Secondary)
  );
  components.push(row1);

  if (queue.length > 0) {
    const selectInQueue = new StringSelectMenuBuilder()
      .setCustomId(`enc_select_${encounter.id}`)
      .setPlaceholder(t.selectCharPlaceholder);

    queue.forEach((item, idx) => {
      const char = charMap.get(item.characterId);
      if (char) {
        selectInQueue.addOptions({
          label: `${idx + 1}. ${char.name}`,
          value: String(char.id),
          default: encounter.selectedCharId === char.id
        });
      }
    });
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectInQueue));

    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`enc_up_${encounter.id}`).setLabel(`⬆️ ${t.moveUp}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_down_${encounter.id}`).setLabel(`⬇️ ${t.moveDown}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_turn_${encounter.id}`).setLabel(`⚡ ${t.giveTurn}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_stress_${encounter.id}`).setLabel(`🩸 ${t.stress}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_delchar_${encounter.id}`).setLabel(`❌ ${t.removeChar}`).setStyle(ButtonStyle.Danger)
    );
    components.push(row3);

    const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`enc_maxap_add_${encounter.id}`).setLabel(`+1 ${t.maxAp}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_maxap_sub_${encounter.id}`).setLabel(`-1 ${t.maxAp}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`enc_addchar_${encounter.id}`).setLabel(`➕ ${t.addCharBtn}`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`enc_delete_${encounter.id}`).setLabel(`🗑️ ${t.deleteEncounter}`).setStyle(ButtonStyle.Danger)
    );
    components.push(row4);
  } else {
    const rowEmpty = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`enc_addchar_${encounter.id}`).setLabel(`➕ ${t.addCharBtn}`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`enc_delete_${encounter.id}`).setLabel(`🗑️ ${t.deleteEncounter}`).setStyle(ButtonStyle.Danger)
    );
    components.push(rowEmpty);
  }

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
    const payload = await buildEncounterDashboard(encounter, t);
    await msg.edit(payload);
  } catch (err) {
    console.error('Could not refresh encounter message:', err);
  }
}

async function buildEncountersListPayload(guildId: string, page: number, t: any) {
  const allEncounters = await db.query.encounters.findMany({
    where: eq(encounters.guildId, guildId),
    orderBy: [desc(encounters.createdAt), desc(encounters.id)]
  });

  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(allEncounters.length / pageSize));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const slice = allEncounters.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const embed = new EmbedBuilder()
    .setColor(BATTLE_COLOR)
    .setTitle(`⚔️ ${t.encountersList}`)
    .setDescription(
      slice.length > 0
        ? slice.map((e, i) => `**${safePage * pageSize + i + 1}.** ${e.name}`).join('\n')
        : '_No encounters created yet._'
    )
    .setFooter({ text: `${t.page} ${safePage + 1}/${totalPages}` });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (slice.length > 0) {
    const openRow = new ActionRowBuilder<ButtonBuilder>();
    slice.forEach(enc => {
      openRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`enclist_open_${enc.id}`)
          .setLabel(enc.name.slice(0, 20))
          .setStyle(ButtonStyle.Secondary)
      );
    });
    components.push(openRow);
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`enclist_page_${safePage - 1}`)
      .setLabel(t.prevPage)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`enclist_page_${safePage + 1}`)
      .setLabel(t.nextPage)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages - 1)
  );
  components.push(navRow);

  return { embeds: [embed], components };
}

async function buildNotesListPayload(guildId: string, userId: string, visibilityFilter: string, page: number, t: any) {
  const allNotes = await db.query.notes.findMany({
    where: eq(notes.guildId, guildId),
    orderBy: [desc(notes.isPinned), desc(notes.createdAt), desc(notes.id)]
  });

  const filtered = allNotes.filter(n => {
    if (visibilityFilter === 'private') {
      return !n.isPublic && n.authorId === userId;
    }
    return n.isPublic === true || n.authorId === userId;
  });

  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const slice = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const embed = new EmbedBuilder()
    .setColor(NOTE_COLOR)
    .setTitle(`📝 ${t.notesTitle} (${visibilityFilter === 'private' ? t.privateLabel : 'Public & Mine'})`)
    .setFooter({ text: `${t.page} ${safePage + 1}/${totalPages}` });

  if (slice.length === 0) {
    embed.setDescription(`_${t.noNotes}_`);
  } else {
    for (const n of slice) {
      const pinIcon = n.isPinned ? '📌 ' : '';
      let contentPreview = n.content && n.content.trim() !== '' ? n.content : '_Empty_';

      const lines = contentPreview.split('\n');
      if (lines.length > 3) {
        contentPreview = lines.slice(0, 3).join('\n') + '\n...';
      }
      if (contentPreview.length > 250) {
        contentPreview = contentPreview.slice(0, 250) + '...';
      }

      let authorName = 'Unknown';
      try {
        const userObj = await client.users.fetch(n.authorId);
        authorName = userObj ? userObj.username : 'Unknown';
      } catch (e) {}

      const visText = n.isPublic ? t.publicLabel : t.privateLabel;
      const fieldVal = `${contentPreview}\n*${t.author}: ${authorName} | ${t.visibility}: ${visText}*`;

      embed.addFields({ name: `${pinIcon}${n.title}`, value: fieldVal.slice(0, 1024) });
    }
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (slice.length > 0) {
    const editRow = new ActionRowBuilder<ButtonBuilder>();
    const pinRow = new ActionRowBuilder<ButtonBuilder>();
    const visRow = new ActionRowBuilder<ButtonBuilder>();

    slice.forEach(n => {
      const shortTitle = n.title.slice(0, 14);
      editRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`note_edit_${n.id}_${visibilityFilter}_${safePage}`)
          .setLabel(`✏️ ${shortTitle}`)
          .setStyle(ButtonStyle.Secondary)
      );
      pinRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`note_pin_${n.id}_${visibilityFilter}_${safePage}`)
          .setLabel(`📌 ${shortTitle}`)
          .setStyle(ButtonStyle.Secondary)
      );
      visRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`note_vis_${n.id}_${visibilityFilter}_${safePage}`)
          .setLabel(`👁️ ${shortTitle}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    components.push(editRow, pinRow, visRow);
  }

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`note_createbtn_${visibilityFilter}_${safePage}`)
      .setLabel(`➕ ${t.createNoteBtn}`)
      .setStyle(ButtonStyle.Success)
  );
  components.push(actionRow);

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`note_page_${visibilityFilter}_${safePage - 1}`)
      .setLabel(t.prevPage)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`note_page_${visibilityFilter}_${safePage + 1}`)
      .setLabel(t.nextPage)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages - 1)
  );
  components.push(navRow);

  return { embeds: [embed], components };
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  await readyClient.application.commands.set([
    {
      name: 'roll',
      description: 'Roll Fate dice (supports 4df, 4dfs, 4dfss, modifiers, skills and character names)',
      options: [
        {
          name: 'expression',
          type: ApplicationCommandOptionType.String,
          description: 'e.g. 4df, 4dfs +2, 4dfs empathy Antonio',
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
          description: 'Character name',
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
      name: 'adventure-create',
      description: 'Create a new Fate adventure',
      options: [
        { name: 'name', type: ApplicationCommandOptionType.String, description: 'Adventure name', required: true },
        { name: 'description', type: ApplicationCommandOptionType.String, description: 'Adventure description', required: false }
      ]
    },
    {
      name: 'adventure-start',
      description: 'Set an adventure as active',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Adventure name', required: true }]
    },
    {
      name: 'adventure-end',
      description: 'Clear the active adventure'
    },
    {
      name: 'adventure-info',
      description: 'Show active adventure details and edit options'
    },
    {
      name: 'character-create',
      description: 'Create a new character in the active adventure',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Character name', required: true }]
    },
    {
      name: 'character-link',
      description: 'Link yourself to a character and get its role',
      options: [{ name: 'name', type: ApplicationCommandOptionType.String, description: 'Character name', required: true }]
    },
    {
      name: 'encounter-create',
      description: 'Create a new encounter',
      options: [
        { name: 'name', type: ApplicationCommandOptionType.String, description: 'Encounter name', required: true },
        { name: 'scene_aspects', type: ApplicationCommandOptionType.String, description: 'Initial scene aspects', required: false }
      ]
    },
    {
      name: 'encounters',
      description: 'List all encounters with pagination'
    },
    {
      name: 'note-create',
      description: 'Create a new note',
      options: [
        { name: 'title', type: ApplicationCommandOptionType.String, description: 'Note title', required: true },
        {
          name: 'visibility',
          type: ApplicationCommandOptionType.String,
          description: 'Visibility (default: private)',
          required: false,
          choices: [
            { name: 'Private', value: 'private' },
            { name: 'Public', value: 'public' }
          ]
        }
      ]
    },
    {
      name: 'notes',
      description: 'View notes list',
      options: [
        {
          name: 'visibility',
          type: ApplicationCommandOptionType.String,
          description: 'Filter notes',
          required: false,
          choices: [
            { name: 'Public', value: 'public' },
            { name: 'Private', value: 'private' }
          ]
        }
      ]
    },
    {
      name: 'View Character Sheet',
      type: ApplicationCommandType.User
    }
  ]);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId) return;
  const text = message.content.trim();

  if (!/^\d+df/i.test(text)) return;

  const lang = await getGuildLanguage(message.guildId);
  const t = getTranslation(lang);

  const rollOutcome = await parseAndExecuteRoll(text, message.guildId, message.author.id, false);
  if (!rollOutcome) return;

  if ('error' in rollOutcome) {
    const errorMsg = rollOutcome.error === 'CHAR_NOT_FOUND' ? t.charNotFound : t.skillNotFound;
    await message.reply({ content: errorMsg });
    return;
  }

  const detailText = rollOutcome.labelDetail ? ` (${rollOutcome.labelDetail})` : '';

  if (rollOutcome.mode === 'ss') {
    const rollId = storePendingRoll({
      results: rollOutcome.results,
      total: rollOutcome.total,
      detail: detailText,
      user: message.author.username
    });

    const revealBtn = new ButtonBuilder()
      .setCustomId(`reveal_ss_${rollId}`)
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

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(t.diceRollResult)
    .setDescription(`[ ${rollOutcome.results.join(' , ')} ]${detailText}\n\n**Total:** \`${rollOutcome.total}\``);

  await message.reply({ embeds: [embed] });
});

client.on(Events.InteractionCreate, async (interaction) => {
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

      if (rollOutcome.mode === 's') {
        const rollId = storePendingRoll({
          results: rollOutcome.results,
          total: rollOutcome.total,
          detail: detailText,
          user: interaction.user.username
        });

        const revealBtn = new ButtonBuilder()
          .setCustomId(`reveal_priv_${rollId}`)
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

      if (rollOutcome.mode === 'ss') {
        const rollId = storePendingRoll({
          results: rollOutcome.results,
          total: rollOutcome.total,
          detail: detailText,
          user: interaction.user.username
        });

        const revealBtn = new ButtonBuilder()
          .setCustomId(`reveal_ss_${rollId}`)
          .setLabel(t.showRoll)
          .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(revealBtn);

        await interaction.reply({
          content: `🎲 **${interaction.user.username}** ${t.hiddenRoll}`,
          components: [row]
        });
        return;
      }

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

      const payload = buildSheetPagePayload(character, 0, t);
      await interaction.reply({ ...payload, ephemeral: true });
      activeSheetInteractions.set(`${interaction.user.id}_${character.id}`, { interaction, page: 0 });
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

    if (commandName === 'adventure-create') {
      const name = interaction.options.getString('name', true);
      const description = interaction.options.getString('description');
      await db.insert(adventures).values({ guildId: interaction.guildId, name, description, language: 'english' });
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`Adventure **${name}** created.`);
      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'adventure-start') {
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

    if (commandName === 'adventure-end') {
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

    if (commandName === 'character-create') {
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

    if (commandName === 'character-link') {
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

    if (commandName === 'encounter-create') {
      const name = interaction.options.getString('name', true);
      const sceneAspects = interaction.options.getString('scene_aspects') || '';
      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });

      const [newEncounter] = await db
        .insert(encounters)
        .values({
          guildId: interaction.guildId,
          adventureId: activeAdventure?.id || null,
          name,
          sceneAspects,
          channelId: interaction.channelId,
          turnQueue: []
        })
        .returning();

      const payload = await buildEncounterDashboard(newEncounter, t);
      const replyMsg = await interaction.reply({ ...payload, fetchReply: true });
      await db.update(encounters).set({ messageId: replyMsg.id }).where(eq(encounters.id, newEncounter.id));
    }

    if (commandName === 'encounters') {
      const payload = await buildEncountersListPayload(interaction.guildId, 0, t);
      await interaction.reply({ ...payload, ephemeral: true });
    }

    if (commandName === 'note-create') {
      const title = interaction.options.getString('title', true);
      const visibility = interaction.options.getString('visibility') || 'private';
      const isPublic = visibility === 'public';

      const activeAdventure = await db.query.adventures.findFirst({
        where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
      });

      await db.insert(notes).values({
        guildId: interaction.guildId,
        adventureId: activeAdventure?.id || null,
        authorId: interaction.user.id,
        title,
        isPublic
      });

      await interaction.reply({ content: `✅ **${title}** (${isPublic ? t.publicLabel : t.privateLabel}) - ${t.noteCreated}`, ephemeral: true });
    }

    if (commandName === 'notes') {
      const visibility = interaction.options.getString('visibility') || 'public';
      const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, visibility, 0, t);
      await interaction.reply({ ...payload, ephemeral: visibility === 'private' });
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
    const payload = buildSheetPagePayload(character, 0, t);
    await interaction.reply({ ...payload, ephemeral: true });
    activeSheetInteractions.set(`${interaction.user.id}_${character.id}`, { interaction, page: 0 });
  }

  // ==========================================
  // 3. SELECT MENUS (MENSAJES)
  // ==========================================
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('enc_select_')) {
      const encounterId = parseInt(interaction.customId.split('_')[2], 10);
      const selectedCharId = parseInt(interaction.values[0], 10);

      await db.update(encounters).set({ selectedCharId }).where(eq(encounters.id, encounterId));
      const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
      if (encounter) {
        const payload = await buildEncounterDashboard(encounter, t);
        await interaction.update(payload);
      }
    }
  }

  // ==========================================
  // 4. BUTTONS
  // ==========================================
  if (interaction.isButton()) {
    const id = interaction.customId;

    // 4.1 Revelar tiradas (usando ID corto de pendingRolls)
    if (id.startsWith('reveal_ss_')) {
      const rollId = id.replace('reveal_ss_', '');
      const data = pendingRolls.get(rollId);
      if (!data) {
        await interaction.reply({ content: t.rollExpired, ephemeral: true });
        return;
      }
      pendingRolls.delete(rollId);
      await interaction.update({
        content: `🎲 **${data.user}** ${t.revealedRoll}:\n[ ${data.results.join(' , ')} ]${data.detail}\n\n**Total:** \`${data.total}\``,
        components: []
      });
      return;
    }

    if (id.startsWith('reveal_priv_')) {
      const rollId = id.replace('reveal_priv_', '');
      const data = pendingRolls.get(rollId);
      if (!data) {
        await interaction.reply({ content: t.rollExpired, ephemeral: true });
        return;
      }
      pendingRolls.delete(rollId);
      await interaction.update({
        content: `✅ Shared with channel.`,
        components: []
      });
      await interaction.followUp({
        content: `🎲 **${data.user}** ${t.revealedRoll}:\n[ ${data.results.join(' , ')} ]${data.detail}\n\n**Total:** \`${data.total}\``,
        ephemeral: false
      });
      return;
    }

    // 4.2 Tirada de habilidad desde ficha
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

    // 4.3 Paginación y Edición de Ficha (/sheet) con LabelBuilder y nuevos componentes de Modal
    if (id.startsWith('sh_page_')) {
      const [, , charIdStr, pageStr] = id.split('_');
      const charId = parseInt(charIdStr, 10);
      const page = parseInt(pageStr, 10);
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      if (!character) return;

      const payload = buildSheetPagePayload(character, page, t);
      await interaction.update(payload);
      activeSheetInteractions.set(`${interaction.user.id}_${charId}`, { interaction, page });
      return;
    }

    if (id.startsWith('sh_edit_')) {
      const parts = id.split('_');
      const fieldType = parts[2];
      const charId = parseInt(parts[3], 10);
      const page = parseInt(parts[4], 10);

      activeSheetInteractions.set(`${interaction.user.id}_${charId}`, { interaction, page });
      const character = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      if (!character) return;

      if (fieldType === 'name') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_name_${charId}_${page}`)
          .setTitle(t.editName)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.editName)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(100)
                  .setValue(character.name || '')
                  .setRequired(true)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'refresh') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_refresh_${charId}_${page}`)
          .setTitle(t.editRefresh)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.refresh)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(10)
                  .setValue(String(character.refresh ?? 3))
                  .setRequired(true)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'desc') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_desc_${charId}_${page}`)
          .setTitle(t.editDescription)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.description)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1000)
                  .setValue(character.description || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'aspects') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_aspects_${charId}_${page}`)
          .setTitle(t.editAspects)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.aspects)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1000)
                  .setValue(character.aspects || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'skills') {
        const skillsObj = (character.skills as Record<string, string[]>) || {};
        const lines = Object.entries(skillsObj).map(([mod, list]) => `${mod}: ${list.join(', ')}`);
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_skills_${charId}_${page}`)
          .setTitle(t.editSkills)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.skills)
              .setDescription('Format: +4: Skill1, Skill2')
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setPlaceholder('+4: Shoot, Athletics\n+3: Empathy')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1000)
                  .setValue(lines.join('\n'))
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'stunts') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_stunts_${charId}_${page}`)
          .setTitle(t.editStunts)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.stunts)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1500)
                  .setValue(character.stunts || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'extras') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_extras_${charId}_${page}`)
          .setTitle(t.editExtras)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.extras)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1500)
                  .setValue(character.extras || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'cons') {
        const cons = (character.consequences as { mild: string; moderate: string; severe: string }) || { mild: '', moderate: '', severe: '' };
        const modal = new ModalBuilder()
          .setCustomId(`modal_sh_cons_${charId}_${page}`)
          .setTitle(t.editConsequences)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.mild)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('mild')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(500)
                  .setValue(cons.mild || '')
                  .setRequired(false)
              ),
            new LabelBuilder()
              .setLabel(t.moderate)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('moderate')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(500)
                  .setValue(cons.moderate || '')
                  .setRequired(false)
              ),
            new LabelBuilder()
              .setLabel(t.severe)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('severe')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(500)
                  .setValue(cons.severe || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
      } else if (fieldType === 'stress') {
        const modal = buildStressModal(`modal_sh_stress_${charId}_${page}`, t.editStress, character, t);
        await interaction.showModal(modal);
      }
      return;
    }

    // 4.4 Editar Aventura (/adventure-info) con CheckboxBuilder
    if (id.startsWith('edit_adv_')) {
      const advId = parseInt(id.split('_')[2], 10);
      const adv = await db.query.adventures.findFirst({ where: eq(adventures.id, advId) });

      const modal = new ModalBuilder()
        .setCustomId(`modal_adv_${advId}`)
        .setTitle(t.editAdventure)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Name')
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(100)
                .setValue(adv?.name || '')
                .setRequired(true)
            ),
          new LabelBuilder()
            .setLabel(t.description)
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('description')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setValue(adv?.description || '')
                .setRequired(false)
            ),
          new LabelBuilder()
            .setLabel(t.activateLabel)
            .setCheckboxComponent(
              new CheckboxBuilder()
                .setCustomId('is_active')
                .setDefault(Boolean(adv?.isActive))
            )
        );
      await interaction.showModal(modal);
      return;
    }

    // 4.5 Lista de Encuentros (/encounters)
    if (id.startsWith('enclist_page_')) {
      const page = parseInt(id.split('_')[2], 10);
      const payload = await buildEncountersListPayload(interaction.guildId, page, t);
      await interaction.update(payload);
      return;
    }

    if (id.startsWith('enclist_open_')) {
      const encounterId = parseInt(id.split('_')[2], 10);
      const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
      if (!encounter) return;

      const payload = await buildEncounterDashboard(encounter, t);
      const msg = await interaction.reply({ ...payload, fetchReply: true });
      await db.update(encounters).set({ channelId: interaction.channelId, messageId: msg.id }).where(eq(encounters.id, encounterId));
      return;
    }

    // 4.6 Controles del Dashboard de Encuentro
    if (id.startsWith('enc_')) {
      const parts = id.split('_');
      const encounterId = parseInt(parts[parts.length - 1], 10);
      const action = parts.slice(1, parts.length - 1).join('_');

      const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
      if (!encounter) return;

      const queue = (encounter.turnQueue as QueueItem[]) || [];
      const selectedIdx = queue.findIndex(q => q.characterId === encounter.selectedCharId);

      const rotateFirstToEnd = () => {
        if (queue.length > 0) {
          const first = queue.shift()!;
          first.ap = 0;
          queue.push(first);
        }
      };

      if (action === 'ap_add' && queue.length > 0) {
        const current = queue[0];
        const maxAp = current.maxAp || 3;
        current.ap += 1;
        if (current.ap >= maxAp) {
          rotateFirstToEnd();
        }
      } else if (action === 'ap_sub' && queue.length > 0) {
        queue[0].ap = Math.max(0, queue[0].ap - 1);
      } else if (action === 'skip') {
        rotateFirstToEnd();
      } else if (action === 'up' && selectedIdx > 0) {
        [queue[selectedIdx - 1], queue[selectedIdx]] = [queue[selectedIdx], queue[selectedIdx - 1]];
      } else if (action === 'down' && selectedIdx !== -1 && selectedIdx < queue.length - 1) {
        [queue[selectedIdx + 1], queue[selectedIdx]] = [queue[selectedIdx], queue[selectedIdx + 1]];
      } else if (action === 'turn' && selectedIdx > 0) {
        const [chosen] = queue.splice(selectedIdx, 1);
        chosen.ap = 0;
        queue.unshift(chosen);
      } else if (action === 'maxap_add' && selectedIdx !== -1) {
        queue[selectedIdx].maxAp = (queue[selectedIdx].maxAp || 3) + 1;
      } else if (action === 'maxap_sub' && selectedIdx !== -1) {
        queue[selectedIdx].maxAp = Math.max(1, (queue[selectedIdx].maxAp || 3) - 1);
        if (queue[selectedIdx].ap >= queue[selectedIdx].maxAp && selectedIdx === 0) {
          rotateFirstToEnd();
        }
      } else if (action === 'delchar' && selectedIdx !== -1) {
        queue.splice(selectedIdx, 1);
      } else if (action === 'delete') {
        await db.delete(encounters).where(eq(encounters.id, encounterId));
        await interaction.update({ content: `🗑️ ${t.encounterDeleted}`, embeds: [], components: [] });
        return;
      } else if (action === 'rename') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_enc_rename_${encounterId}`)
          .setTitle(t.renameEncounter)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Name')
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('name')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(100)
                  .setValue(encounter.name)
                  .setRequired(true)
              )
          );
        await interaction.showModal(modal);
        return;
      } else if (action === 'scene') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_enc_scene_${encounterId}`)
          .setTitle(t.editSceneAspects)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.sceneAspects)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('scene_aspects')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1000)
                  .setValue(encounter.sceneAspects || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
        return;
      } else if (action === 'addchar') {
        const allChars = await db.query.characters.findMany({
          where: eq(characters.guildId, encounter.guildId)
        });
        const availableChars = allChars
          .filter(c => c.adventureId === encounter.adventureId && !queue.some(q => q.characterId === c.id))
          .slice(0, 25);

        const modal = new ModalBuilder()
          .setCustomId(`modal_enc_addchar_${encounterId}`)
          .setTitle(t.addCharBtn)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(t.addCharModalInstructions)
          );

        if (availableChars.length > 0) {
          const selectExisting = new StringSelectMenuBuilder()
            .setCustomId('existing_char')
            .setPlaceholder(t.addExistingPlaceholder)
            .setRequired(false)
            .addOptions(
              availableChars.map(c =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(c.name)
                  .setValue(String(c.id))
              )
            );

          modal.addLabelComponents(
            new LabelBuilder()
              .setLabel(t.existingCharLabel)
              .setStringSelectMenuComponent(selectExisting)
          );
        }

        modal.addLabelComponents(
          new LabelBuilder()
            .setLabel(t.newCharLabel)
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('new_char_name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(100)
                .setRequired(false)
            )
        );

        await interaction.showModal(modal);
        return;
      } else if (action === 'stress' && selectedIdx !== -1) {
        const targetCharId = queue[selectedIdx].characterId;
        const character = await db.query.characters.findFirst({ where: eq(characters.id, targetCharId) });
        const modal = buildStressModal(`modal_enc_stress_${targetCharId}_${encounterId}`, `${t.editStress}: ${character?.name}`, character, t);
        await interaction.showModal(modal);
        return;
      }

      await db.update(encounters).set({ turnQueue: queue as any }).where(eq(encounters.id, encounterId));
      const updatedEncounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });
      const payload = await buildEncounterDashboard(updatedEncounter, t);
      await interaction.update(payload);
      return;
    }

    // 4.7 Sistema de Notas (/notes) con StringSelect en Modal de creación y Paragraph maxLength
    if (id.startsWith('note_')) {
      const parts = id.split('_');
      const action = parts[1];

      if (action === 'page') {
        const vis = parts[2];
        const page = parseInt(parts[3], 10);
        const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, vis, page, t);
        await interaction.update(payload);
        return;
      }

      if (action === 'createbtn') {
        const vis = parts[2];
        const page = parseInt(parts[3], 10);

        const visSelect = new StringSelectMenuBuilder()
          .setCustomId('visibility')
          .setRequired(true)
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(t.publicLabel)
              .setValue('public')
              .setDefault(true),
            new StringSelectMenuOptionBuilder()
              .setLabel(t.privateLabel)
              .setValue('private')
              .setDefault(false)
          );

        const modal = new ModalBuilder()
          .setCustomId(`modal_note_create_${vis}_${page}`)
          .setTitle(t.createNoteBtn)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.noteTitleLabel)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('title')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(100)
                  .setRequired(true)
              ),
            new LabelBuilder()
              .setLabel(t.visibility)
              .setStringSelectMenuComponent(visSelect),
            new LabelBuilder()
              .setLabel(t.noteContentLabel)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('content')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(2000)
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
        return;
      }

      const noteId = parseInt(parts[2], 10);
      const vis = parts[3];
      const page = parseInt(parts[4], 10);
      const note = await db.query.notes.findFirst({ where: eq(notes.id, noteId) });
      if (!note) return;

      if (action === 'pin') {
        await db.update(notes).set({ isPinned: !note.isPinned }).where(eq(notes.id, noteId));
        const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, vis, page, t);
        await interaction.update(payload);
        return;
      }

      if (action === 'vis') {
        await db.update(notes).set({ isPublic: !note.isPublic }).where(eq(notes.id, noteId));
        const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, vis, page, t);
        await interaction.update(payload);
        return;
      }

      if (action === 'edit') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_note_${noteId}_${vis}_${page}`)
          .setTitle(t.editNote)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.noteTitleLabel)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('title')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(100)
                  .setValue(note.title)
                  .setRequired(true)
              ),
            new LabelBuilder()
              .setLabel(t.noteContentLabel)
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('content')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(2000)
                  .setValue(note.content || '')
                  .setRequired(false)
              )
          );
        await interaction.showModal(modal);
        return;
      }
    }
  }

  // ==========================================
  // 5. MODAL SUBMISSIONS
  // ==========================================
  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split('_');

    // 5.1 Edición de Ficha (/sheet)
    if (parts[1] === 'sh') {
      const fieldType = parts[2];
      const charId = parseInt(parts[3], 10);
      const page = parseInt(parts[4], 10);

      if (fieldType === 'name') {
        const val = interaction.fields.getTextInputValue('value');
        if (val.trim()) await db.update(characters).set({ name: val.trim() }).where(eq(characters.id, charId));
      } else if (fieldType === 'refresh') {
        const val = parseInt(interaction.fields.getTextInputValue('value'), 10);
        if (!isNaN(val)) await db.update(characters).set({ refresh: val }).where(eq(characters.id, charId));
      } else if (fieldType === 'desc') {
        const val = interaction.fields.getTextInputValue('value');
        await db.update(characters).set({ description: val }).where(eq(characters.id, charId));
      } else if (fieldType === 'aspects') {
        const val = interaction.fields.getTextInputValue('value');
        await db.update(characters).set({ aspects: val }).where(eq(characters.id, charId));
      } else if (fieldType === 'skills') {
        const rawText = interaction.fields.getTextInputValue('value');
        const skillsObj: Record<string, string[]> = {};
        const lines = rawText.includes('\n') ? rawText.split('\n') : rawText.split('|');
        lines.forEach(line => {
          const [mod, list] = line.split(':');
          if (mod && list) {
            skillsObj[mod.trim()] = list.split(',').map(s => s.trim()).filter(Boolean);
          }
        });
        await db.update(characters).set({ skills: skillsObj }).where(eq(characters.id, charId));
      } else if (fieldType === 'stunts') {
        const val = interaction.fields.getTextInputValue('value');
        await db.update(characters).set({ stunts: val }).where(eq(characters.id, charId));
      } else if (fieldType === 'extras') {
        const val = interaction.fields.getTextInputValue('value');
        await db.update(characters).set({ extras: val }).where(eq(characters.id, charId));
      } else if (fieldType === 'cons') {
        const mild = interaction.fields.getTextInputValue('mild');
        const moderate = interaction.fields.getTextInputValue('moderate');
        const severe = interaction.fields.getTextInputValue('severe');
        await db.update(characters).set({ consequences: { mild, moderate, severe } }).where(eq(characters.id, charId));
      } else if (fieldType === 'stress') {
        const physSelected = interaction.fields.getCheckboxGroup('physical') || [];
        const mentSelected = interaction.fields.getCheckboxGroup('mental') || [];
        const physical = [1, 2, 3, 4].map(n => physSelected.includes(String(n)));
        const mental = [1, 2, 3, 4].map(n => mentSelected.includes(String(n)));
        await db.update(characters).set({ physicalStress: physical as any, mentalStress: mental as any }).where(eq(characters.id, charId));
      }

      const updatedChar = await db.query.characters.findFirst({ where: eq(characters.id, charId) });
      const sheetRef = activeSheetInteractions.get(`${interaction.user.id}_${charId}`);

      if (updatedChar && sheetRef) {
        const payload = buildSheetPagePayload(updatedChar, page, t);
        await interaction.deferUpdate();
        await sheetRef.interaction.editReply(payload);
      } else {
        await interaction.reply({ content: '✅ Updated.', ephemeral: true });
      }
      return;
    }

    // 5.2 Edición de Aventura (/adventure-info)
    if (parts[1] === 'adv') {
      const advId = parseInt(parts[2], 10);
      const name = interaction.fields.getTextInputValue('name');
      const description = interaction.fields.getTextInputValue('description');
      const isActive = interaction.fields.getCheckbox('is_active');

      // Si se marca como activa, desactivar cualquier otra aventura activa del servidor
      if (isActive) {
        await db.update(adventures).set({ isActive: false }).where(eq(adventures.guildId, interaction.guildId));
      }

      await db.update(adventures).set({ name, description, isActive }).where(eq(adventures.id, advId));
      await interaction.reply({ content: '✅ Adventure updated.', ephemeral: true });
      return;
    }

    // 5.3 Modales de Encuentro
    if (parts[1] === 'enc') {
      const subAction = parts[2];

      if (subAction === 'rename') {
        const encounterId = parseInt(parts[3], 10);
        const name = interaction.fields.getTextInputValue('name').trim();
        if (name) {
          await db.update(encounters).set({ name }).where(eq(encounters.id, encounterId));
          await refreshEncounterMessage(encounterId, t);
        }
        await interaction.deferUpdate();
      } else if (subAction === 'scene') {
        const encounterId = parseInt(parts[3], 10);
        const sceneAspects = interaction.fields.getTextInputValue('scene_aspects');
        await db.update(encounters).set({ sceneAspects }).where(eq(encounters.id, encounterId));
        await refreshEncounterMessage(encounterId, t);
        await interaction.deferUpdate();
      } else if (subAction === 'addchar') {
        const encounterId = parseInt(parts[3], 10);
        const encounter = await db.query.encounters.findFirst({ where: eq(encounters.id, encounterId) });

        if (encounter) {
          let selectedExistingIds: readonly string[] = [];
          try {
            selectedExistingIds = interaction.fields.getStringSelectValues('existing_char');
          } catch {}

          const newCharName = interaction.fields.getTextInputValue('new_char_name').trim();
          let charIdToAdd: number | null = null;

          // Prioridad: si eligió existente del select, usamos ese; si no, creamos/buscamos el nuevo por nombre
          if (selectedExistingIds.length > 0) {
            charIdToAdd = parseInt(selectedExistingIds[0], 10);
          } else if (newCharName) {
            let character = await db.query.characters.findFirst({
              where: and(eq(characters.name, newCharName), eq(characters.guildId, interaction.guildId))
            });
            if (!character) {
              const [created] = await db
                .insert(characters)
                .values({ guildId: interaction.guildId, adventureId: encounter.adventureId, name: newCharName })
                .returning();
              character = created;
            }
            charIdToAdd = character.id;
          }

          if (charIdToAdd !== null) {
            const queue = (encounter.turnQueue as QueueItem[]) || [];
            if (!queue.some(q => q.characterId === charIdToAdd)) {
              queue.push({ characterId: charIdToAdd, ap: 0, maxAp: 3 });
            }
            await db
              .update(encounters)
              .set({ turnQueue: queue as any, selectedCharId: encounter.selectedCharId || charIdToAdd })
              .where(eq(encounters.id, encounterId));
            await refreshEncounterMessage(encounterId, t);
          }
        }
        await interaction.deferUpdate();
      } else if (subAction === 'stress') {
        const targetCharId = parseInt(parts[3], 10);
        const encounterId = parseInt(parts[4], 10);
        const physSelected = interaction.fields.getCheckboxGroup('physical') || [];
        const mentSelected = interaction.fields.getCheckboxGroup('mental') || [];
        const physical = [1, 2, 3, 4].map(n => physSelected.includes(String(n)));
        const mental = [1, 2, 3, 4].map(n => mentSelected.includes(String(n)));

        await db.update(characters).set({ physicalStress: physical as any, mentalStress: mental as any }).where(eq(characters.id, targetCharId));
        await refreshEncounterMessage(encounterId, t);
        await interaction.deferUpdate();
      }
      return;
    }

    // 5.4 Modales de Notas
    if (parts[1] === 'note') {
      if (parts[2] === 'create') {
        const vis = parts[3];
        const page = parseInt(parts[4], 10);
        const title = interaction.fields.getTextInputValue('title').trim();
        const visValues = interaction.fields.getStringSelectValues('visibility');
        const content = interaction.fields.getTextInputValue('content');
        const isPublic = (visValues[0] || 'public') === 'public';

        const activeAdventure = await db.query.adventures.findFirst({
          where: and(eq(adventures.isActive, true), eq(adventures.guildId, interaction.guildId))
        });

        await db.insert(notes).values({
          guildId: interaction.guildId,
          adventureId: activeAdventure?.id || null,
          authorId: interaction.user.id,
          title: title || 'Untitled',
          content,
          isPublic
        });

        const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, vis, page, t);
        await interaction.deferUpdate();
        await interaction.editReply(payload);
        return;
      }

      const noteId = parseInt(parts[2], 10);
      const vis = parts[3];
      const page = parseInt(parts[4], 10);
      const title = interaction.fields.getTextInputValue('title').trim();
      const content = interaction.fields.getTextInputValue('content');

      await db.update(notes).set({ title: title || 'Untitled', content }).where(eq(notes.id, noteId));
      const payload = await buildNotesListPayload(interaction.guildId, interaction.user.id, vis, page, t);
      await interaction.deferUpdate();
      await interaction.editReply(payload);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);