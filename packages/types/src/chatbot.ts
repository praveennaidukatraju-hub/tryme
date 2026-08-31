import { z } from 'zod';

export const ConversationStatus = z.enum(['BOT', 'PENDING_HUMAN', 'HUMAN', 'CLOSED']);
export type ConversationStatusT = z.infer<typeof ConversationStatus>;

export const ChatRole = z.enum(['user', 'bot', 'agent', 'system']);

export const ChatMessage = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: ChatRole,
  senderId: z.string().uuid().nullable(),
  content: z.string(),
  createdAt: z.string(), // ISO
});
export type ChatMessageT = z.infer<typeof ChatMessage>;

// frames a USER socket may send
export const WsClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), content: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('typing') }),
  z.object({ type: z.literal('escalate') }),
]);
export type WsClientFrameT = z.infer<typeof WsClientFrame>;

// frames an AGENT socket may send
export const WsAgentFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join'), conversationId: z.string().uuid() }),
  z.object({ type: z.literal('leave'), conversationId: z.string().uuid() }),
  z.object({
    type: z.literal('message'),
    conversationId: z.string().uuid(),
    content: z.string().min(1).max(4000),
  }),
  z.object({ type: z.literal('typing'), conversationId: z.string().uuid() }),
]);
export type WsAgentFrameT = z.infer<typeof WsAgentFrame>;

// frames the server pushes (both audiences)
export const WsServerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    conversationId: z.string().uuid(),
    status: ConversationStatus,
  }),
  z.object({ type: z.literal('message'), message: ChatMessage }),
  z.object({ type: z.literal('token'), conversationId: z.string().uuid(), delta: z.string() }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.string().uuid(),
    role: z.enum(['user', 'agent', 'bot']),
  }),
  z.object({
    type: z.literal('state_change'),
    conversationId: z.string().uuid(),
    status: ConversationStatus,
    reason: z.string().nullable(),
  }),
  z.object({ type: z.literal('queue_update'), pending: z.number() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type WsServerFrameT = z.infer<typeof WsServerFrame>;

export const QnaUpsert = z.object({
  question: z.string().min(3).max(2000),
  answer: z.string().min(1).max(8000),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  isActive: z.boolean().default(true),
});
export type QnaUpsertT = z.infer<typeof QnaUpsert>;
