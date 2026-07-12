// Consolidation prompt builder — adapted from openclaude's
// consolidationPrompt.ts. Drops the openclaude memdir-specific guidance
// (Axion's memoryStore is a flat dir with INDEX.md) and points the
// consolidation sub-agent at the chats directory Axion actually persists
// sessions to. Used by the optional LLM-driven consolidation path
// (`buildConsolidationLLMPrompt`); the heuristic path synthesizes a digest
// directly without invoking a model.

import { getMemoriesDir } from '../memories/memoryStore.js';

const ENTRYPOINT_NAME = 'INDEX.md';
const MAX_ENTRYPOINT_LINES = 200;

export function buildConsolidationPrompt(memoryRoot, transcriptDir, extra = '') {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: ${memoryRoot} (exists; MEMORY.md-style index at ${ENTRYPOINT_NAME}).

Session transcripts: ${transcriptDir} (JSON files — read narrowly, don't load whole files).

---

## Phase 1 — Orient

- List the memory directory to see what already exists.
- Read ${ENTRYPOINT_NAME} to understand the current index.
- Skim existing topic files so you improve them rather than creating duplicates.

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources, in rough priority order:

1. Existing memories that drifted — facts that contradict something you see in recent transcripts.
2. Recent session transcripts — read the most recent user/assistant messages and tool calls (file paths, commands, decisions, failures).

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Convert relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes. Delete contradicted facts — if today's investigation disproves an old memory, fix it at the source.

## Phase 4 — Prune and index

Update ${ENTRYPOINT_NAME} so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded.
- Add pointers to newly important memories.
- Resolve contradictions — if two files disagree, fix the wrong one.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`;
}