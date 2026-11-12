import { pgTable, text, integer, serial, jsonb, boolean } from 'drizzle-orm/pg-core';

export const adventures = pgTable('adventures', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').default(false),
  language: text('language').default('spanish'), // 'english' | 'spanish'
});

export const characters = pgTable('characters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id),
  discordUserId: text('discord_user_id'),
  name: text('name').notNull(),
  description: text('description'),
  refresh: integer('refresh').default(3),
  aspects: jsonb('aspects').default([]),
  skills: jsonb('skills').default({}),
  stunts: text('stunts'),
  extras: text('extras'),
  physicalStress: jsonb('physical_stress').default([false, false, false, false]),
  mentalStress: jsonb('mental_stress').default([false, false, false, false]),
  consequences: jsonb('consequences').default({ mild: '', moderate: '', severe: '' }),
});