-- Add optional link column to announcements so dynamic cards render clickable
ALTER TABLE announcements ADD COLUMN link TEXT;
