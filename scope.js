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
 * Storage scope: decides WHERE a character's long-term record lives.
 *
 * Historically every per-character tier (memories, entities, relationship
 * history, epistemic knowledge, canon, persistent arcs) was stored in
 * extension_settings.smart_memory.characters[<name>]. That bucket is global:
 * every chat with a character of that name shares it, so facts from one story
 * leak into another, and anything keyed by a stale or duplicate name lands in
 * the wrong bucket.
 *
 * This module is the single choke point for that storage. Two scopes exist:
 *
 *   'chat'      (default) - the record lives in chatMetadata[META_KEY].store[name].
 *                           It belongs to exactly one chat and is deleted with it.
 *   'character' (legacy)  - the record lives in the global characters map, as before.
 *
 * Records are still keyed by speaker name inside a chat so group chats keep
 * one record per member.
 *
 * It also owns active-character resolution. SillyTavern's context.name2 is
 * mutable (character switches, /sendas, impersonation, group speaker changes),
 * so each 1:1 chat is bound once to the card it actually belongs to and every
 * later lookup resolves through that binding.
 *
 * getStorageScope           - current scope ('chat' | 'character')
 * getRecord / setRecord     - read / write a per-speaker record
 * deleteRecord              - remove a per-speaker record
 * persistRecords            - save whichever backing store was just written
 * resolveCharacterName      - stable active-character name for the current chat
 * resolveCharacterCard      - the actual card object for a speaker, never a same-named lookalike
 * resolveActiveName         - resolveCharacterName with the group/legacy name2 fallback
 * importLegacyRecord        - one-time copy of a legacy global record into this chat
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { smLog } from './logging.js';

/** @returns {'chat'|'character'} */
export function getStorageScope() {
  return extension_settings[MODULE_NAME]?.storage_scope === 'character' ? 'character' : 'chat';
}

// ---- Backing-store access -----------------------------------------------

/**
 * Returns the map of per-speaker records for the active scope, creating it
 * when `create` is true. Returns null when the scope has no usable container
 * (e.g. chat scope with no chat loaded) so callers degrade to a no-op.
 * @param {boolean} create
 * @returns {Object|null}
 */
function getStoreMap(create) {
  if (getStorageScope() === 'character') {
    const s = extension_settings[MODULE_NAME];
    if (!s) return null;
    if (!s.characters && create) s.characters = {};
    return s.characters ?? null;
  }
  const context = getContext();
  if (!context?.chatMetadata) return null;
  if (!context.chatMetadata[META_KEY]) {
    if (!create) return null;
    context.chatMetadata[META_KEY] = {};
  }
  const meta = context.chatMetadata[META_KEY];
  if (!meta.store && create) meta.store = {};
  return meta.store ?? null;
}

/**
 * Returns the stored record for a speaker, or undefined when none exists.
 * @param {string} name
 * @returns {Object|undefined}
 */
export function getRecord(name) {
  if (!name) return undefined;
  return getStoreMap(false)?.[name];
}

/**
 * Replaces the stored record for a speaker.
 * Callers still decide when to persist; most call persistRecords() after.
 * @param {string} name
 * @param {Object} record
 */
export function setRecord(name, record) {
  if (!name) return;
  const map = getStoreMap(true);
  if (!map) return;
  map[name] = record;
}

/**
 * Merges a patch into the stored record, creating it if needed.
 * @param {string} name
 * @param {Object} patch
 */
export function patchRecord(name, patch) {
  if (!name) return;
  setRecord(name, { ...(getRecord(name) ?? {}), ...patch });
}

/**
 * Removes the stored record for a speaker.
 * @param {string} name
 */
export function deleteRecord(name) {
  if (!name) return;
  const map = getStoreMap(false);
  if (map && name in map) delete map[name];
}

// ---- Persistence --------------------------------------------------------

let metaSaveInFlight = false;
let metaSaveDirty = false;

/**
 * Persists chatMetadata without stacking concurrent writes. A save requested
 * while one is running is coalesced into a single follow-up save.
 */
async function saveChatMetadataCoalesced() {
  if (metaSaveInFlight) {
    metaSaveDirty = true;
    return;
  }
  metaSaveInFlight = true;
  try {
    do {
      metaSaveDirty = false;
      await getContext().saveMetadata();
    } while (metaSaveDirty);
  } catch (err) {
    console.error('[SmartMemory] Failed to save chat metadata:', err);
  } finally {
    metaSaveInFlight = false;
  }
}

/**
 * Persists whichever store the active scope writes to. Safe to call after
 * any set/patch/delete; in chat scope this saves the chat file's metadata,
 * in character scope it schedules the usual debounced settings save.
 */
export function persistRecords() {
  if (getStorageScope() === 'character') {
    saveSettingsDebounced();
  } else {
    saveChatMetadataCoalesced();
  }
}

// ---- Active character resolution ----------------------------------------

/**
 * Resolves the character name memory should be filed under for the current
 * chat. Resolution order for 1:1 chats:
 *
 *   1. The card bound to this chat (by avatar, so renames still resolve).
 *   2. The card at context.characterId.
 *   3. context.name2 / context.characterName as a last resort.
 *
 * The binding is written the first time a card is resolved in a chat and never
 * silently overwritten afterwards, so a mid-chat card swap or a transient
 * name2 change cannot redirect writes into another character's record.
 *
 * Group chats have no single card; callers pass the speaker explicitly there,
 * so this returns null for groups.
 *
 * @returns {string|null}
 */
export function resolveCharacterName() {
  const context = getContext();
  if (!context || context.groupId) return null;

  const chars = context.characters ?? [];
  const meta = context.chatMetadata?.[META_KEY];
  const bound = meta?.boundCharacter;

  if (bound?.avatar) {
    const byAvatar = chars.find((c) => c.avatar === bound.avatar);
    if (byAvatar?.name) {
      if (byAvatar.name !== bound.name) {
        // Card was renamed since the binding was written; carry the record over.
        migrateRecordName(bound.name, byAvatar.name);
        meta.boundCharacter = { name: byAvatar.name, avatar: byAvatar.avatar };
        persistRecords();
      }
      return byAvatar.name;
    }
    // Bound card no longer exists in the library; keep using the stored name so
    // the chat's memory stays reachable.
    if (bound.name) return bound.name;
  }

  const active = chars[context.characterId];
  const name = active?.name || context.name2 || context.characterName || null;
  if (name && active?.avatar && context.chatMetadata) {
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].boundCharacter = { name, avatar: active.avatar };
    persistRecords();
  }
  return name;
}

/**
 * Returns the card object that belongs to a speaker in the current chat.
 *
 * Looking a card up by name alone is unsafe: libraries routinely hold several
 * cards with the same display name, and context.name2 can lag or drift. The
 * lookup is therefore anchored to identity instead:
 *
 *   1:1 chat    - the card bound to this chat (by avatar), else context.characterId.
 *                 The chat has exactly one card, so `name` is not used to pick it.
 *   group chat  - the group's own members only, matched by name, so a same-named
 *                 card elsewhere in the library can never be returned.
 *   otherwise   - first card with a matching name, as a last resort.
 *
 * @param {string|null} [name] - Speaker name; only used for group chats and the fallback.
 * @returns {Object|null}
 */
export function resolveCharacterCard(name) {
  const context = getContext();
  const chars = context?.characters ?? [];
  if (chars.length === 0) return null;

  if (context.groupId) {
    const group = context.groups?.find((g) => g.id === context.groupId);
    const members = group?.members ?? [];
    const inGroup = chars.filter((c) => members.includes(c.avatar));
    return (
      inGroup.find((c) => c.name === name) ?? (name ? chars.find((c) => c.name === name) : null) ?? null
    );
  }

  // Establishes (or re-validates) the chat's binding as a side effect.
  resolveCharacterName();
  const bound = context.chatMetadata?.[META_KEY]?.boundCharacter;
  if (bound?.avatar) {
    const byAvatar = chars.find((c) => c.avatar === bound.avatar);
    if (byAvatar) return byAvatar;
  }
  const active = chars[context.characterId];
  if (active) return active;
  return name ? (chars.find((c) => c.name === name) ?? null) : null;
}

/**
 * Active speaker name for code that previously read context.name2 directly.
 * 1:1 chats resolve through the pinned card; group chats keep name2, which
 * tracks the current speaker there.
 * @returns {string|null}
 */
export function resolveActiveName() {
  const context = getContext();
  if (context?.groupId) return context.name2 || context.characterName || null;
  return resolveCharacterName() || context.name2 || context.characterName || null;
}

/**
 * Moves a record from an old speaker name to a new one (card rename).
 * Never overwrites an existing record under the new name.
 * @param {string} from
 * @param {string} to
 */
function migrateRecordName(from, to) {
  if (!from || !to || from === to) return;
  const map = getStoreMap(false);
  if (!map || !(from in map) || to in map) return;
  map[to] = map[from];
  delete map[from];
  smLog(`[SmartMemory] Renamed stored record "${from}" -> "${to}".`);
}

// ---- Legacy import ------------------------------------------------------

/**
 * One-time import of a legacy global record into the current chat.
 *
 * Only applies in chat scope, only to chats that already hold Smart Memory
 * data (so a genuinely new chat starts clean instead of inheriting another
 * story's facts), and only once per chat.
 *
 * @param {string} name
 * @returns {boolean} True when a record was imported.
 */
export function importLegacyRecord(name) {
  if (!name || getStorageScope() !== 'chat') return false;
  const context = getContext();
  const meta = context?.chatMetadata?.[META_KEY];
  if (!meta || meta.legacyImported) return false;

  const hasHistory =
    Boolean(meta.summary) ||
    (Array.isArray(meta.sessionMemories) && meta.sessionMemories.length > 0) ||
    meta.lastExtractCutoff != null;
  if (!hasHistory) return false;

  meta.legacyImported = true;
  const legacy = extension_settings[MODULE_NAME]?.characters?.[name];
  if (!legacy || getRecord(name)) {
    persistRecords();
    return false;
  }
  setRecord(name, JSON.parse(JSON.stringify(legacy)));
  persistRecords();
  smLog(`[SmartMemory] Imported legacy record for "${name}" into this chat.`);
  return true;
}
