import { pgTable, text, integer, serial, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';

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
  selectedCharId: integer('selected_char_id'),
  turnQueue: jsonb('turn_queue').default([]),
  createdAt: timestamp('created_at').defaultNow(),
});

export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
  content: text('content').default(''),
  isPublic: boolean('is_public').default(false),
  isPinned: boolean('is_pinned').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});