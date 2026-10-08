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
 * Lightweight registry that tracks per-tier trim statistics.
 *
 * Each inject function reports its full content size and its injected size.
 * The token bar reads these stats to show a visual indicator when a tier is
 * actively dropping content to stay within budget.
 *
 * In group chats multiple characters inject per round, each overwriting the
 * current stats for their tiers. Auto-tune must size budgets for the greediest
 * character seen across the session, not just the last one to inject. The high
 * water mark (_hwStats) tracks the maximum `full` demand per tier since the
 * last chat change - auto-tune reads from there, the token bar reads _stats.
 *
 * reportTierTrimStats    - records injected vs full token counts for a tier
 * getTierTrimStats       - returns the stored stats for a tier key
 * getTierHWStats         - returns the high water mark stats for a tier key
 * clearTierTrimStats     - resets all stats and HWM (call on chat change)
 * clearTierStats         - clears recent-injection stats for one tier (keeps HWM)
 * hasAnyTrimmedTier      - returns true when at least one non-exempt tier is over budget
 * markTrimToastFired     - records that the one-time trim toast has been shown
 * hasTrimToastFired      - returns true if the toast has already been shown
 * resetTrimToastFlag     - clears toast + load-complete flags (call on chat change)
 * markChatLoadComplete   - signals that the initial chat load injection pass is done
 * isChatLoadComplete     - returns true once the load pass has finished
 */

/** @type {Object.<string, {injected: number, full: number}>} */
const _stats = {};

/**
 * High water mark: tracks the maximum `full` token demand seen per tier since
 * the last chat change. Unlike _stats (which is overwritten each injection pass),
 * _hwStats only moves upward. Auto-tune uses this so group chat budgets are
 * sized for the greediest character in the session, not the last one to inject.
 * @type {Object.<string, {injected: number, full: number}>}
 */
const _hwStats = {};

/** Prevents the one-time "content trimmed" toast from re-firing mid-chat. */
let _trimToastFired = false;

/**
 * Set to true after the initial chat load injection pass completes.
 * The trim toast is gated on this so it does not fire immediately on chat load
 * before the user has done anything - it fires only after the first post-load
 * injection cycle.
 */
let _chatLoadComplete = false;

/**
 * Records the injected and full (pre-trim) token counts for a tier.
 * Also updates the high water mark when the new `full` value exceeds the
 * previously stored maximum - so group chat budgets account for the greediest
 * character seen in the session, not just the last one to inject.
 *
 * @param {string} key - The injection slot key (PROMPT_KEY_* constant).
 * @param {number} injected - Tokens actually injected after budget trimming.
 * @param {number} full - Tokens the full content would have needed before trimming.
 */
export function reportTierTrimStats(key, injected, full) {
  _stats[key] = { injected, full };
  if (!_hwStats[key] || full > _hwStats[key].full) {
    _hwStats[key] = { injected, full };
  }
}

/**
 * Returns the stored trim stats for a tier, or null if none recorded yet.
 * Reflects the most recent injection pass - may vary per character in group chats.
 *
 * @param {string} key
 * @returns {{injected: number, full: number}|null}
 */
export function getTierTrimStats(key) {
  return _stats[key] ?? null;
}

/**
 * Returns the high water mark stats for a tier: the maximum `full` token demand
 * seen since the last chat change. Use this for auto-tune budget calculations
 * so the result accounts for every character that has injected this session.
 *
 * @param {string} key
 * @returns {{injected: number, full: number}|null}
 */
export function getTierHWStats(key) {
  return _hwStats[key] ?? null;
}

/**
 * Resets all stored trim stats and high water marks. Call on chat change so
 * stale data from a previous chat does not show false alarms on the new one.
 */
export function clearTierTrimStats() {
  for (const k of Object.keys(_stats)) delete _stats[k];
  for (const k of Object.keys(_hwStats)) delete _hwStats[k];
}

/**
 * Clears the most-recent injection stats for a single tier without touching
 * the high water mark. Call when auto-tune expands a tier's budget so the
 * load-pass trim record for that tier is not mistaken for current trim on the
 * next updateTokenDisplay call. The HWM is preserved so auto-tune still has
 * demand data for future passes.
 *
 * @param {string} key - The injection slot key (PROMPT_KEY_* constant).
 */
export function clearTierStats(key) {
  delete _stats[key];
}

// Tiers excluded from the trim warning toast. Short-term is excluded because
// the compaction summary self-corrects on the next compaction pass anyway -
// transient overshoot is normal and not actionable by the user.
const TOAST_EXEMPT_KEYS = new Set(['smart_memory_short']);

/**
 * Returns true if at least one non-exempt tier has reported trimmed content
 * this chat. Short-term is excluded since it self-corrects on the next
 * compaction pass.
 * @returns {boolean}
 */
export function hasAnyTrimmedTier() {
  return Object.entries(_stats).some(([k, s]) => !TOAST_EXEMPT_KEYS.has(k) && s.full > s.injected);
}

/** Records that the one-time trim notification has been shown for this chat. */
export function markTrimToastFired() {
  _trimToastFired = true;
}

/** Returns true if the trim toast has already fired for this chat. */
export function hasTrimToastFired() {
  return _trimToastFired;
}

/**
 * Resets the trim toast and chat-load-complete flags.
 * Call on chat change alongside clearTierTrimStats.
 */
export function resetTrimToastFlag() {
  _trimToastFired = false;
  _chatLoadComplete = false;
}

/**
 * Signals that the initial injection pass after chat load has finished.
 * Call once at the end of onChatChangedImpl, after the first updateTokenDisplay.
 * The trim toast will not fire until this has been called.
 */
export function markChatLoadComplete() {
  _chatLoadComplete = true;
}

/**
 * Returns true once the initial chat load injection pass has completed.
 * @returns {boolean}
 */
export function isChatLoadComplete() {
  return _chatLoadComplete;
}
