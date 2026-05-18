import { pgTable, text, integer, serial, jsonb } from 'drizzle-orm/pg-core';

export const adventures = pgTable('adventures', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  name: text('name').notNull(),
});

export const characters = pgTable('characters', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  adventureId: integer('adventure_id').references(() => adventures.id),
  name: text('name').notNull(),
  description: text('description'),
  refresh: integer('refresh').default(3),
  highConcept: text('high_concept'),
  trouble: text('trouble'),
  aspects: jsonb('aspects').default([]), // Array of strings
  skills: jsonb('skills').default({}), // Record<string, number>
  stunts: text('stunts'),
  extras: text('extras'),
  physicalStress: integer('physical_stress').default(0),
  mentalStress: integer('mental_stress').default(0),
  consequences: jsonb('consequences').default({ mild: '', moderate: '', severe: '' }),
});