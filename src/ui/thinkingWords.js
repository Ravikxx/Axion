// Whimsical "thinking" verbs shown while the agent works. Shared by the Ink and
// OpenTUI UIs.
export const THINKING_WORDS = [
  'baking', 'brewing', 'conjuring', 'weaving', 'crafting',
  'simmering', 'forging', 'hatching', 'distilling', 'wrangling',
  'cooking up', 'scheming', 'assembling', 'calibrating', 'synthesizing',
  'plotting', 'whittling', 'ruminating', 'percolating', 'manifesting',
  'untangling', 'chiseling', 'mulling', 'marinating', 'decoding',
  'reverse-engineering', 'daydreaming', 'noodling', 'spelunking', 'simulating',
  'hallucinating productively', 'connecting dots', 'running the numbers', 'vibing',
  'divining', 'transmuting', 'fermenting', 'excavating', 'theorizing',
  'triangulating', 'rabbit-holing', 'stewing', 'summoning', 'tinkering',
  'galaxy-brained', 'cross-referencing', 'deep-diving', 'unraveling', 'concocting',
  'consulting the void', 'doing math', 'stargazing', 'philosophizing',
  'overcooking it', 'having a moment', 'going feral', 'touching grass mentally',
  'running on vibes', 'checking the lore', 'speedrunning this', 'eating the context',
  'manifesting harder', 'big braining', 'in the lab', 'doing laps', 'on the grind',
  'asking the universe', 'loading…', 'buffering', 'crunching', 'questioning reality',
];

export function pickThinkingWord() {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}
