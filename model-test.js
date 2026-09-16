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
 * Extraction model test: runs a fixed scenario through the full extraction
 * pipeline and returns structured per-tier results for display in the UI.
 *
 * runModelTest               - runs the test against the configured memory LLM;
 *                              accepts an optional isCancelled callback to abort between tiers,
 *                              an optional onProgress callback fired before each tier starts,
 *                              and an optional onChunk callback for a live streaming preview
 * TEST_CHARACTERS            - characters in the main Yara/Cael scenario
 * TEST_MESSAGES              - messages for the main scenario
 * EPISTEMIC_TEST_CHARACTERS  - characters in the Mira/Sera/Ryn/Dael epistemic scenario
 * EPISTEMIC_TEST_MESSAGES    - messages for the epistemic scenario
 * STATE_TEST_ENTITIES        - entities in the dungeon state ledger scenario
 * STATE_TEST_MESSAGES        - messages for the state ledger scenario
 */

import { generateMemoryExtract } from './generate.js';
import { smLog } from './logging.js';
import {
  buildExtractionPrompt,
  buildSessionExtractionPrompt,
  buildArcExtractionPrompt,
  buildEpistemicExtractionPrompt,
  buildStateCardPrompt,
} from './prompts.js';
import {
  parseExtractionOutput,
  parseSessionOutput,
  parseArcOutput,
  parseEpistemicResponse,
  parseStateCardResponse,
} from './parsers.js';

// ---- Test fixture -----------------------------------------------------------

// A fixed roleplay scenario designed to exercise all three extraction tiers.
// Rich enough that a capable model should produce multiple items per tier;
// long enough to surface models that degrade on larger prompts.
export const TEST_CHARACTERS = ['Yara', 'Cael'];

// A second fixed scenario for the epistemic tier: a village healer scene with
// four characters, designed so that every epistemic tag fires at least once.
//
// What a capable model should extract:
//   [knows]   Ryn knows her father has been feverish for seven days.
//   [knows]   Mira knows how serious the illness is (she is treating him).
//   [suspects] Sera suspects the situation is worse than Mira is letting on.
//   [believes] Ryn believes her father will recover.
//   [unaware]  Ryn is unaware of the mill negotiation.
//   [hiding]   Dael is hiding from Ryn that he has a notary-sealed agreement
//              to purchase the mill.
export const EPISTEMIC_TEST_CHARACTERS = ['Mira', 'Sera', 'Ryn', 'Dael'];

export const EPISTEMIC_TEST_MESSAGES = [
  {
    name: 'Ryn',
    text: 'My father has had the fever for seven days. I sent for Mira the moment his cough turned wet.',
  },
  {
    name: 'Mira',
    text: 'I arrived yesterday morning and have been with him since. Sera, prepare the breathing tincture - not the fever blend, the breathing one.',
  },
  {
    name: 'Sera',
    text: "His colour is poor, Mira. Worse than yesterday. I don't think it is just the fever.",
  },
  {
    name: 'Mira',
    text: 'He is resting. The night will tell us more. Ryn, your presence helps him more than the medicine.',
  },
  {
    name: 'Ryn',
    text: 'He will recover. He survived the river sickness six years ago with nothing but willowbark and rest. He has always been strong.',
  },
  {
    name: 'Dael',
    text: 'Forgive the interruption. I came to ask after Aldric. We had spoken last month about the mill - I only wanted him to know there is no hurry on my side. These matters can wait until he is well.',
  },
  {
    name: 'Ryn',
    text: 'The mill? He said nothing to me about any arrangement. He would never sell that mill.',
  },
  {
    name: 'Dael',
    text: 'Preliminary only - nothing decided, nothing signed. I should not have raised it at such a moment. Forgive me.',
  },
  {
    name: 'Sera',
    text: "The saddlebag you left by the door - I saw a notary's seal on the papers inside when I passed.",
  },
  {
    name: 'Dael',
    text: 'Old contracts from another matter entirely. Nothing to do with Aldric. As I said, it can all wait.',
  },
];

// A post-armistice occupied city. Yara is a former resistance fighter looking
// for her brother Daven, who went into hiding after the war ended and has now
// gone missing. Cael is an intelligence operative officially working for the
// occupation authority, secretly helping Yara.
//
// Designed so that all three story arcs open clearly but NONE resolve within
// the conversation - the brother is not found, the surveillance tail is not
// identified, Cael's handler does not discover him. This prevents the model
// from confusing established facts with open threads.
export const TEST_MESSAGES = [
  {
    name: 'Cael',
    text: 'You got my note. I was not sure you would come after last time.',
  },
  {
    name: 'Yara',
    text: 'You said you had word of Daven. I would walk through the occupation garrison barefoot for that.',
  },
  {
    name: 'Cael',
    text: 'Keep your voice down. The Pact officers have doubled their patrols since the Aldenmoor incident. Half the market has informants on retainer.',
  },
  {
    name: 'Yara',
    text: 'Then tell me quickly. What do you know?',
  },
  {
    name: 'Cael',
    text: 'He was spotted three weeks ago in the Vethara district. A market stall owner recognised him from before the armistice. Daven was asking about passage north - toward the border crossings.',
  },
  {
    name: 'Yara',
    text: 'North means he is trying to get out. Or someone is moving him.',
  },
  {
    name: 'Cael',
    text: 'The stall owner said he did not look like he was choosing where to go. And the same morning he was seen, two Pact intelligence officers checked into the Vethara wayhouse. That is not a coincidence.',
  },
  {
    name: 'Yara',
    text: 'If they have him, I need to reach Vethara before they move him again. How long do we have?',
  },
  {
    name: 'Cael',
    text: 'A day, maybe two. Pact intelligence does not hold people in field wayhouses - they are transit points. Daven will be moved to a processing facility the moment the paperwork clears.',
  },
  {
    name: 'Yara',
    text: 'Then we go tonight. Will you help me?',
  },
  {
    name: 'Cael',
    text: 'Yara. My handler believes I am monitoring resistance contacts - monitoring you. If I travel to Vethara with you, I burn everything I have built in this city. My access, my cover, possibly my life if he decides I have turned.',
  },
  {
    name: 'Yara',
    text: 'Then do not come.',
  },
  {
    name: 'Cael',
    text: 'I did not say I would not. I said what it costs. I will come with you. But you need to understand what you are asking of me.',
  },
  {
    name: 'Yara',
    text: 'I understand. And I will not forget it, Cael. Whatever happens after.',
  },
  {
    name: 'Cael',
    text: 'There is something else. Since I sent you that note two days ago, I have had the feeling we are being watched. Not Pact - they do not follow at a distance, they simply take you. Someone else. Independent.',
  },
  {
    name: 'Yara',
    text: 'The Thornback cells are still operating in the south quarter. Could be former resistance who think I am a liability.',
  },
  {
    name: 'Cael',
    text: 'Possibly. Or someone who picked up that I was asking questions about your brother and decided to follow the thread back to you. I have not been able to identify them yet.',
  },
  {
    name: 'Yara',
    text: 'Can you find out who they are?',
  },
  {
    name: 'Cael',
    text: 'I have a contact who tracks independent operators in this district. She may know who is running surveillance here. I sent word this morning - waiting on a reply.',
  },
  {
    name: 'Yara',
    text: 'How long until she answers?',
  },
  {
    name: 'Cael',
    text: 'A day. Maybe two. The same window we have for Daven.',
  },
  {
    name: 'Yara',
    text: 'So we move on Vethara not knowing who is watching us.',
  },
  {
    name: 'Cael',
    text: 'That is the situation, yes. I would rather wait for the identification but you are right that we cannot. We move tonight and I try to run the tail down in parallel.',
  },
  {
    name: 'Yara',
    text: 'Tell me about the wayhouse. Exits, staff, who is inside.',
  },
  {
    name: 'Cael',
    text: 'Two exits. The front is watched around the clock. The south gate is unmanned after the second bell - garrison budget cuts gutted the overnight posts after the armistice. There is a porter inside named Fen who owes me a considerable debt.',
  },
  {
    name: 'Yara',
    text: 'You trust him?',
  },
  {
    name: 'Cael',
    text: 'I trust that he is more afraid of me than of the two Pact officers staying there. That has been enough before.',
  },
  {
    name: 'Yara',
    text: 'And your handler - when does he expect his next report from you?',
  },
  {
    name: 'Cael',
    text: 'Three days. If I am not back with something credible by then, he will start asking questions I cannot answer. That is our hard deadline on this, Yara.',
  },
  {
    name: 'Yara',
    text: 'Three days to reach Vethara, get Daven out, and get you back in place before your handler notices. I swear I will not waste a single hour of that. Let us go.',
  },
];

// State ledger test scenario: a dungeon heist excerpt.
// Designed to exercise current-vs-past state (Kael's clothes changed, key changed hands),
// sparse output (Lyria is mentioned by name only - no visible state), and multiple
// entity types (character, object, place, faction) in a single scene.
//
// Expected correct extraction signals:
//   [state:Kael:character]     - outfit_disguise = guard disguise (not his original clothes)
//                              - injuries present (took a graze in the earlier fight)
//                              - carried_items = silver key
//                              - location = dungeon interior
//   [state:Silver Key:object]  - owner = Kael (formerly in the steward's possession)
//                              - location = on Kael's person
//   [state:Dungeon:place]      - occupants = Kael and 2 guards
//   NO line for Lyria          - only mentioned, no observable state
// A model that writes fieldname=unknown or produces a line for Lyria is unsuitable.
export const STATE_TEST_ENTITIES = [
  { name: 'Kael', type: 'character' },
  { name: 'Lyria', type: 'character' },
  { name: 'Silver Key', type: 'object' },
  { name: 'Dungeon', type: 'place' },
  { name: 'The Watch', type: 'faction' },
];

export const STATE_TEST_MESSAGES = [
  {
    name: 'Kael',
    text: "The graze on my shoulder had stopped bleeding by the time I reached the dungeon's lower passage. I pulled the guard's cloak tighter - the fit was poor but the badge on the chest was what mattered.",
  },
  {
    name: 'Kael',
    text: 'Two sentries at the far end, talking. Neither looked toward me. I had maybe thirty seconds before the patrol rotation brought the third one back around.',
  },
  {
    name: 'Lyria',
    text: 'Kael. Did you get it?',
  },
  {
    name: 'Kael',
    text: 'The steward had it on him, not in the vault. Cost me the better part of that fight to get it loose without him raising an alarm.',
  },
  {
    name: 'Kael',
    text: 'The silver key. It is in my pocket. Now can we please move before those sentries finish their conversation.',
  },
];

// ---- Tier definitions -------------------------------------------------------

// Each tier defines which setting gates it, how to run it, how to parse it,
// and what hint to show the user when reviewing the output.
const MAIN_SCENARIO = {
  messages: TEST_MESSAGES,
  characters: TEST_CHARACTERS,
  showReadWarning: true,
};

const TIER_DEFS = [
  {
    key: 'longterm',
    name: 'Long-term Memories',
    required: true,
    enabledKey: 'longterm_enabled',
    scenario: MAIN_SCENARIO,
    hint:
      'Should contain lasting facts about characters, relationships, preferences, and ' +
      'significant events - who these people are, what binds them, what is at stake. ' +
      'A capable model typically finds 5 or more items in this scenario.',
    responseLength: 600,
    buildPrompt: (history) => buildExtractionPrompt(history, '', TEST_CHARACTERS[0]),
    parse: (response) => {
      const items = parseExtractionOutput(response || '');
      return { items: items.map((i) => `[${i.type}] ${i.content}`), count: items.length };
    },
  },
  {
    key: 'session',
    name: 'Session Memories',
    required: true,
    enabledKey: 'session_enabled',
    scenario: MAIN_SCENARIO,
    hint:
      'Should contain scene details, revelations about the situation, and how things ' +
      'developed this session - the wayhouse location, the sighting, the timeline, ' +
      'what Cael committed to. A capable model typically finds 4 or more items in this scenario.',
    responseLength: 400,
    buildPrompt: (history) => buildSessionExtractionPrompt(history, '', ''),
    parse: (response) => {
      const items = parseSessionOutput(response || '');
      return { items: items.map((i) => `[${i.type}] ${i.content}`), count: items.length };
    },
  },
  {
    key: 'arcs',
    name: 'Story Arcs',
    required: true,
    enabledKey: 'arcs_enabled',
    scenario: MAIN_SCENARIO,
    hint:
      'Should identify the open threads in this scenario: Yara must reach Vethara and get ' +
      'Daven out before the Pact moves him; an unknown party is surveilling them and has not ' +
      'been identified; Cael is waiting on a contact reply that may identify the watchers; ' +
      'Cael is deceiving his handler and will face consequences if discovered. None of these ' +
      'resolve in the conversation. A capable model finds 3-4 of these and does not output ' +
      'declarative facts about events that already happened.',
    responseLength: 400,
    buildPrompt: (history) => buildArcExtractionPrompt(history, ''),
    parse: (response) => {
      const { add } = parseArcOutput(response || '', []);
      return { items: add.map((a) => a.content), count: add.length };
    },
  },
  {
    key: 'state_ledger',
    name: 'State Ledger',
    // Opt-in tier - empty output here should not fail the whole test.
    required: false,
    // State Ledger has its own enable gate combining state_ledger_enabled and profile.
    enabledKey: null,
    scenario: {
      messages: STATE_TEST_MESSAGES,
      characters: STATE_TEST_ENTITIES.map((e) => e.name),
      showReadWarning: false,
    },
    hint:
      'Ideally should extract current physical state for Kael (guard disguise, shoulder graze, ' +
      'carrying the silver key), the Silver Key (owner = Kael), and the Dungeon (sentries present). ' +
      'Fewer entities is acceptable as long as what is extracted is accurate. ' +
      'Lyria is mentioned but has no observable state - no line should appear for her. ' +
      'The Watch has no mention in the scene - no line should appear for them either. ' +
      'Any field value of "unknown", "none", or similar placeholder means the model is padding ' +
      'output rather than omitting unknowns - this indicates the model is unsuitable for state extraction.',
    responseLength: 300,
    buildPrompt: () => {
      const excerpt = STATE_TEST_MESSAGES.map((m) => `${m.name}: ${m.text}`).join('\n\n');
      return buildStateCardPrompt(excerpt, STATE_TEST_ENTITIES);
    },
    parse: (response) => {
      const parsed = parseStateCardResponse(response || '');
      const items = [];
      for (const [key, fields] of parsed.entries()) {
        const fieldParts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
        items.push(`[state:${key}] ${fieldParts.join(' | ')}`);
      }
      return { items, count: items.length };
    },
  },
  {
    key: 'epistemic',
    name: 'Perspectives & Secrets',
    // Opt-in tier - empty output here should not fail the whole test.
    required: false,
    // Epistemic has its own enable gate combining epistemic_enabled and profile.
    enabledKey: null,
    scenario: {
      messages: EPISTEMIC_TEST_MESSAGES,
      characters: EPISTEMIC_TEST_CHARACTERS,
      showReadWarning: false,
    },
    hint:
      'Ideally should extract entries covering most or all five tag types from the village healer scene: ' +
      '[knows] facts held by Ryn, Mira, Sera, and Dael; [suspects] for Sera that the illness is worse than the fever alone; ' +
      '[believes] for a character holding an incorrect assumption; [unaware] for characters who do not ' +
      'know something relevant; and [hiding] for Dael concealing the purpose of his saddlebag from Ryn. ' +
      'Fewer entries is acceptable as long as the tags are used correctly. ' +
      'A model that confuses [knows] with [hiding], or misses all entries of a type entirely, may not ' +
      'be suitable for Perspectives & Secrets.',
    responseLength: 400,
    // Uses a different test scenario than the main tiers to exercise all five tags cleanly.
    buildPrompt: () => {
      const epistemicHistory = EPISTEMIC_TEST_MESSAGES.map((m) => `${m.name}: ${m.text}`).join(
        '\n\n',
      );
      return buildEpistemicExtractionPrompt(epistemicHistory, EPISTEMIC_TEST_CHARACTERS);
    },
    parse: (response) => {
      const items = parseEpistemicResponse(response || '');
      return {
        items: items.map((e) =>
          e.type === 'hiding'
            ? `[${e.type}] ${e.subject} from ${e.target}: ${e.content}`
            : `[${e.type}] ${e.subject}: ${e.content}`,
        ),
        count: items.length,
      };
    },
  },
];

// ---- Runner -----------------------------------------------------------------

/**
 * Runs the fixed test scenario through all extraction tiers regardless of
 * whether each tier is currently enabled. This allows users to evaluate
 * model capability before deciding to enable a tier.
 * Returns per-tier results and the name of the first *required* tier
 * (Long-term Memories, Session Memories, Story Arcs) that produced no
 * output (null if all required tiers passed), or { cancelled: true } if
 * the caller requested cancellation between tiers. The optional tiers
 * (State Ledger, Perspectives & Secrets) are always run and included in
 * the results, but an empty result from either never fails the test.
 *
 * Tiers are run sequentially to avoid OOM on local models.
 *
 * @param {() => boolean} [isCancelled] - optional callback; return true to abort before the next tier
 * @param {(current: number, total: number, name: string) => void} [onProgress] - optional callback fired before each tier starts, 1-indexed
 * @param {(snapshot: {content: string, thinking: string}) => void} [onChunk] - optional streaming preview callback, forwarded to generateMemoryExtract; only takes effect for the Ollama and local OpenAI Compatible sources
 * @returns {Promise<{tiers: Array, failedTier: string|null, cancelled?: boolean}>}
 */
export async function runModelTest(
  isCancelled = () => false,
  onProgress = () => {},
  onChunk = null,
) {
  const chatHistory = TEST_MESSAGES.map((m) => `${m.name}: ${m.text}`).join('\n\n');

  const tiers = [];

  for (let i = 0; i < TIER_DEFS.length; i++) {
    const def = TIER_DEFS[i];
    if (isCancelled()) return { tiers, failedTier: null, cancelled: true };

    onProgress(i + 1, TIER_DEFS.length, def.name);

    // Epistemic and State Ledger tiers use their own test scenarios.
    // All other tiers use the shared chat history.
    const prompt = def.buildPrompt(chatHistory);
    smLog(
      `[ModelTest] Prompt length for "${def.name}": ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`,
    );
    const response = await generateMemoryExtract(prompt, {
      responseLength: def.responseLength,
      onChunk,
    });
    smLog(`[ModelTest] Raw response for tier "${def.name}":`, response);
    const { items, count } = def.parse(response);

    tiers.push({
      key: def.key,
      name: def.name,
      hint: def.hint,
      scenario: def.scenario,
      items,
      empty: count === 0,
      required: def.required,
    });
  }

  // Only the three core tiers (long-term, session, arcs) can fail the overall
  // test - State Ledger and Perspectives & Secrets are opt-in features, so an
  // empty result there just means this model isn't great at that particular
  // nuance, not that it's unsuitable for Smart Memory generally. Gating the
  // whole test (and hiding the other tiers' results) on an optional tier was
  // actively misleading.
  const failedTier = tiers.find((t) => t.empty && t.required);
  return { tiers, failedTier: failedTier?.name ?? null };
}
