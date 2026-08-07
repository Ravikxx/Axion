-- One Daytona sandbox per conversation instead of one per execution — lets
-- variables, installed packages, and files written by earlier tool calls
-- persist across the rest of the chat. Never explicitly destroyed by our
-- code; Daytona's own autoStopInterval/autoArchiveInterval lifecycle is the
-- cleanup, so no TTL bookkeeping is needed here.
ALTER TABLE chats ADD COLUMN sandbox_id TEXT;
