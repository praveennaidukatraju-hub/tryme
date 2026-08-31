import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.js';
import { users } from './users.js';

export const chatbotQna = pgTable('chatbot_qna', {
  id: uuid('id').primaryKey().defaultRandom(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const chatbotEmbeddings = pgTable(
  'chatbot_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    qnaId: uuid('qna_id')
      .notNull()
      .references(() => chatbotQna.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector('english', content)`),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chatbot_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chatbot_embeddings_tsv_idx').using('gin', t.contentTsv),
  ],
);

export const chatbotConversations = pgTable(
  'chatbot_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('BOT'),
    assignedAgentId: uuid('assigned_agent_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    escalationReason: text('escalation_reason'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chatbot_conversations_one_active_idx')
      .on(t.userId)
      .where(sql`${t.status} <> 'CLOSED'`),
    index('chatbot_conversations_status_idx').on(t.status, t.lastMessageAt),
  ],
);

export const chatbotMessages = pgTable(
  'chatbot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatbotConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    senderId: uuid('sender_id'),
    content: text('content').notNull(),
    meta: jsonb('meta').$type<{ toolCalls?: string[]; qnaIds?: string[] }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chatbot_messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const chatbotEvents = pgTable('chatbot_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => chatbotConversations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
