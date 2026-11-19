// Entry points for other modules that hand work to the agent (e.g. the Changes window adapting a
// peer's published change).
import { newSession, openChatWindow, findSession } from './store.js';
import { sendMessage } from './agent.js';

/**
 * Starts an agent on a task in a new chat session whose edits go to overlay `overlayId` (created
 * on first use if missing; a staged change's overlay is used as is). Opens a chat window on it
 * and sends `prompt` as the first user message. Returns the session id.
 *   title: the session's name (and the overlay's label if the chat creates it)
 */
export function startAgentTask({ title, overlayId, prompt, scope = null } = {}) {
  if (!prompt?.trim()) throw new Error('startAgentTask: prompt is required');
  const id = newSession(scope, { overlayId: overlayId || null, title: title || null });
  openChatWindow(id);
  sendMessage(findSession(id), prompt);
  return id;
}
