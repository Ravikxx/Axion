-- A branch is a new, independent chat that starts as a copy of another
-- chat's messages up to some point. branched_from_seq is the highest seq
-- copied, so the UI can say what point the branch started from without
-- re-diffing the two message histories.
ALTER TABLE chats ADD COLUMN branched_from_chat_id TEXT;
ALTER TABLE chats ADD COLUMN branched_from_seq INTEGER;
