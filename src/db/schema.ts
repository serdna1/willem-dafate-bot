import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const guildConfigs = pgTable('guild_configs', {
  guildId: text('guild_id').primaryKey(),
  language: text('language').default('english').notNull(),
});

export const adventures = pgTable('adventures', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const characters = pgTable('characters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id, { onDelete: 'cascade' }),
  discordUserId: text('discord_user_id'),
  name: text('name').notNull(),
  tags: text('tags').default('').notNull(),
  description: text('description').default(''),
  refresh: integer('refresh').default(3).notNull(),
  aspects: text('aspects').default(''),
  skills: jsonb('skills').$type<Record<string, string[]>>().default({}),
  stunts: text('stunts').default(''),
  extras: text('extras').default(''),
  physicalStress: jsonb('physical_stress').$type<boolean[]>().default([false, false, false, false]),
  mentalStress: jsonb('mental_stress').$type<boolean[]>().default([false, false, false, false]),
  consequences: jsonb('consequences').$type<{ mild: string; moderate: string; severe: string }>().default({
    mild: '',
    moderate: '',
    severe: '',
  }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const encounters = pgTable('encounters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  sceneAspects: text('scene_aspects').default(''),
  turnQueue: jsonb('turn_queue').$type<{ characterId: number; ap: number; maxAp: number }[]>().default([]),
  selectedCharId: integer('selected_char_id'),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id, { onDelete: 'set null' }),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
  content: text('content').default(''),
  isPublic: boolean('is_public').default(true).notNull(),
  isPinned: boolean('is_pinned').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});