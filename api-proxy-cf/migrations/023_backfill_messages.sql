-- One-time backfill of messages from the JSON blob into rows. Safe to
-- re-run: it only inserts ids that don't already exist, and ids are
-- deterministic (chat_id + array position), so a partial or repeated
-- run cannot duplicate a row.
INSERT OR IGNORE INTO messages (id, chat_id, user_id, seq, role, content, tool_calls, tool_call_id, generation_id, created_at)
SELECT
  chats.id || '-' || (json_each.key + 1),
  chats.id,
  chats.user_id,
  json_each.key + 1,
  json_extract(json_each.value, '$.role'),
  json_extract(json_each.value, '$.content'),
  json_extract(json_each.value, '$.tool_calls'),
  json_extract(json_each.value, '$.tool_call_id'),
  json_extract(json_each.value, '$.generation_id'),
  COALESCE(json_extract(json_each.value, '$.ts'), chats.updated, chats.created, 0)
FROM chats, json_each(chats.messages)
WHERE chats.messages IS NOT NULL AND chats.messages NOT IN ('', '[]');
