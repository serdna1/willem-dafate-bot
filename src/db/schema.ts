import { pgTable, text, integer, serial, jsonb, boolean } from 'drizzle-orm/pg-core';

export const adventures = pgTable('adventures', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').default(false),
  language: text('language').default('english'),
});

export const characters = pgTable('characters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id),
  discordUserId: text('discord_user_id'),
  name: text('name').notNull(),
  description: text('description'),
  refresh: integer('refresh').default(3),
  aspects: text('aspects').default(''),
  skills: jsonb('skills').default({}),
  stunts: text('stunts'),
  extras: text('extras'),
  physicalStress: jsonb('physical_stress').default([false, false, false, false]),
  mentalStress: jsonb('mental_stress').default([false, false, false, false]),
  consequences: jsonb('consequences').default({ mild: '', moderate: '', severe: '' }),
});

export const encounters = pgTable('encounters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id),
  name: text('name').notNull(),
  sceneAspects: text('scene_aspects').default(''),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  isActive: boolean('is_active').default(true),
  selectedCharId: integer('selected_char_id'),
  turnQueue: jsonb('turn_queue').default([]),
});