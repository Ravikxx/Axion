import { getValidAccessToken } from '../oauth/oauth.js';

async function token() {
  const t = await getValidAccessToken('google');
  if (!t) throw new Error('Google not connected — run /oauth connect google');
  return t;
}

async function gFetch(url, opts = {}) {
  const tok = await token();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Google API error ${res.status}`);
  }
  return res.json();
}

// ── Drive ─────────────────────────────────────────────────────────────────────

export async function driveList({ query = '', limit = 20 } = {}) {
  const q = query ? encodeURIComponent(query) : '';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime,size)${q ? `&q=${q}` : ''}`;
  const data = await gFetch(url);
  return data.files || [];
}

export async function driveRead({ fileId, fileName } = {}) {
  // Resolve name to ID if needed
  if (!fileId && fileName) {
    const files = await driveList({ query: `name='${fileName}'`, limit: 5 });
    if (!files.length) throw new Error(`File not found: ${fileName}`);
    fileId = files[0].id;
  }
  if (!fileId) throw new Error('Provide fileId or fileName');

  // Get metadata to check mimeType
  const meta = await gFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,name`);

  // Google Docs → export as plain text
  if (meta.mimeType === 'application/vnd.google-apps.document') {
    const tok  = await token();
    const res  = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return { name: meta.name, content: await res.text() };
  }

  // Other files — download raw (limit to text-ish)
  const tok  = await token();
  const res  = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const text = await res.text();
  return { name: meta.name, content: text.slice(0, 8000) };
}

export async function driveSearch({ query, limit = 10 } = {}) {
  return driveList({ query: `fullText contains '${query}'`, limit });
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export async function calendarListEvents({ days = 7, calendarId = 'primary', maxResults = 20 } = {}) {
  const now    = new Date().toISOString();
  const future = new Date(Date.now() + days * 86400000).toISOString();
  const url    = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${now}&timeMax=${future}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;
  const data   = await gFetch(url);
  return (data.items || []).map(e => ({
    id:       e.id,
    title:    e.summary,
    start:    e.start?.dateTime || e.start?.date,
    end:      e.end?.dateTime   || e.end?.date,
    location: e.location,
    desc:     e.description?.slice(0, 200),
  }));
}

export async function calendarCreateEvent({ title, start, end, description = '', location = '', calendarId = 'primary' } = {}) {
  const body = {
    summary:     title,
    description,
    location,
    start: { dateTime: new Date(start).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end:   { dateTime: new Date(end).toISOString(),   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
  return gFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body:   JSON.stringify(body),
  });
}

export async function calendarDeleteEvent({ eventId, calendarId = 'primary' } = {}) {
  const tok = await token();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to delete event: ${res.status}`);
  return { deleted: true, eventId };
}

// ── Tool definitions (Anthropic format) ───────────────────────────────────────

export const GOOGLE_TOOL_DEFINITIONS = [
  {
    name:        'google_drive_list',
    description: 'List files in the user\'s Google Drive. Optionally filter by query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Drive search query e.g. "name contains \'report\'" or "mimeType=\'application/pdf\'"' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name:        'google_drive_read',
    description: 'Read the content of a file from Google Drive by ID or name.',
    input_schema: {
      type: 'object',
      properties: {
        fileId:   { type: 'string', description: 'Google Drive file ID' },
        fileName: { type: 'string', description: 'File name to search for (if ID unknown)' },
      },
    },
  },
  {
    name:        'google_drive_search',
    description: 'Search Google Drive files by content or name.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name:        'google_calendar_list_events',
    description: 'List upcoming calendar events from Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        days:       { type: 'number', description: 'How many days ahead to look (default 7)' },
        maxResults: { type: 'number', description: 'Max events to return (default 20)' },
      },
    },
  },
  {
    name:        'google_calendar_create_event',
    description: 'Create a new event in Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Event title' },
        start:       { type: 'string', description: 'Start date/time (ISO 8601 or natural language)' },
        end:         { type: 'string', description: 'End date/time (ISO 8601 or natural language)' },
        description: { type: 'string', description: 'Event description' },
        location:    { type: 'string', description: 'Event location' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name:        'google_calendar_delete_event',
    description: 'Delete an event from Google Calendar by event ID.',
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Google Calendar event ID' },
      },
      required: ['eventId'],
    },
  },
];

export const GOOGLE_TOOL_DEFINITIONS_OPENAI = GOOGLE_TOOL_DEFINITIONS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export async function executeGoogleTool(name, input) {
  switch (name) {
    case 'google_drive_list':          return driveList(input);
    case 'google_drive_read':          return driveRead(input);
    case 'google_drive_search':        return driveSearch(input);
    case 'google_calendar_list_events': return calendarListEvents(input);
    case 'google_calendar_create_event': return calendarCreateEvent(input);
    case 'google_calendar_delete_event': return calendarDeleteEvent(input);
    default: return null;
  }
}
