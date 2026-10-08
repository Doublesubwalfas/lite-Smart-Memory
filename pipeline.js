/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Run-once ledger for the extraction pipeline.
 *
 * One extraction pass fans out into several sequential model calls (session
 * memories, long-term memories, arcs, state ledger, profiles, canon). Events
 * that re-fire for the same state - duplicate CHAT_LOADED/CHAT_CHANGED,
 * re-rendered messages, a group round and a solo handler both seeing the same
 * turn - would otherwise repeat that whole fan-out and pay for it again.
 *
 * Each pass is identified by a run key built from the chat, the message window
 * it covers, and a fingerprint of the newest message. A key is recorded in
 * chatMetadata only after the pass finishes, so:
 *
 *   - a pass that already completed for this exact state is skipped,
 *   - a pass that is still running is never started a second time,
 *   - a pass that failed is NOT recorded and is retried on the next turn.
 *
 * buildRunKey   - key for the current chat state and extraction cutoff
 * shouldSkipRun - true when this key already ran or is running right now
 * beginRun      - marks a key as in flight
 * endRun        - clears the in-flight mark; records the key when `completed`
 */

import { getContext } from '../../../extensions.js';
import { META_KEY } from './constants.js';
import { smLog } from './logging.js';

/* Keys currently executing. Module-level: in-flight work never survives a reload. */
const inFlight = new Set();

/** Small non-cryptographic string hash; enough to fingerprint a message. */
function hashText(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Builds the run key for an extraction pass.
 * @param {number} cutoff - Chat index the pass will advance lastExtractCutoff to.
 * @returns {string}
 */
export function buildRunKey(cutoff) {
  const context = getContext();
  const chat = context.chat ?? [];
  const tip = chat[chat.length - 1];
  // The pre-run cutoff is deliberately not part of the key: it changes when a
  // pass completes, which would make an identical re-fire look like new work.
  return [context.chatId ?? 'nochat', cutoff, chat.length, hashText(tip?.mes)].join('|');
}

/**
 * True when a pass with this key already completed or is running now.
 * @param {string} key
 * @returns {boolean}
 */
export function shouldSkipRun(key) {
  if (inFlight.has(key)) {
    smLog(`[SmartMemory] Pipeline skipped (already running): ${key}`);
    return true;
  }
  const done = getContext().chatMetadata?.[META_KEY]?.lastRunKey;
  if (done === key) {
    smLog(`[SmartMemory] Pipeline skipped (already completed): ${key}`);
    return true;
  }
  return false;
}

/** Marks a key as running. */
export function beginRun(key) {
  inFlight.add(key);
}

/**
 * Clears the running mark. When `completed` is true the key is recorded in the
 * chat so an identical pass is never repeated. The caller persists metadata.
 * @param {string} key
 * @param {boolean} completed
 */
export function endRun(key, completed) {
  inFlight.delete(key);
  if (!completed) return;
  const meta = getContext().chatMetadata?.[META_KEY];
  if (meta) meta.lastRunKey = key;
}
