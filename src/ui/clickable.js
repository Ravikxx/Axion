import { measureElement } from 'ink';

const registry = new Map();
let nextId = 0;

export function registerClickable(ref, onToggle) {
  const id = nextId++;
  registry.set(id, { ref, onToggle });
  return id;
}

export function unregisterClickable(id) {
  registry.delete(id);
}

export function dispatchClick(mx, my) {
  for (const [, entry] of registry) {
    try {
      const rect = measureElement(entry.ref);
      if (!rect) continue;
      if (mx >= rect.x && mx < rect.x + rect.width && my >= rect.y && my < rect.y + rect.height) {
        entry.onToggle();
        return true;
      }
    } catch {
      // ref may have been unmounted
    }
  }
  return false;
}
