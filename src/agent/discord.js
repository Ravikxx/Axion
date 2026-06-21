import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';

let client = null;
let _onMessage = null;

export const DISCORD_STATE = { running: false, username: null };

// Per-user rate limit: ignore messages within 2s of the last one
const _lastMsg = new Map();
const RATE_MS = 2000;

function isRateLimited(userId) {
  const now = Date.now();
  const last = _lastMsg.get(userId) || 0;
  if (now - last < RATE_MS) return true;
  _lastMsg.set(userId, now);
  return false;
}

// Track bot replies so edits can update them: userMsgId → Message[]
const _sentReplies = new Map();

export function trackReply(userMsgId, messages) {
  _sentReplies.set(userMsgId, messages);
}

export async function editReply(userMsgId, channelOrMsg, newText) {
  const prev = _sentReplies.get(userMsgId);
  const LIMIT = 1900;
  if (prev?.length === 1 && newText.length <= LIMIT) {
    try { await prev[0].edit(newText); return; } catch {}
  }
  // Multi-message or edit failed — delete old messages and send fresh
  if (prev) for (const m of prev) { try { await m.delete(); } catch {} }
  const sent = await _sendChunks(channelOrMsg, newText);
  _sentReplies.set(userMsgId, sent);
}

export async function startDiscord(token, onMessage) {
  if (client) await stopDiscord();

  _onMessage = onMessage;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessageTyping,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });

  await new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (c) => {
      DISCORD_STATE.running = true;
      DISCORD_STATE.username = c.user.tag;
      resolve();
    });
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (!_onMessage) return;
    if (msg.guild) {
      if (!msg.mentions.has(client.user)) return;
      // Strip the bot mention so the AI sees clean text
      msg = Object.create(msg);
      msg.content = msg.content.replace(/<@!?\d+>/g, '').trim();
    }
    if (isRateLimited(msg.author.id)) return;
    await _onMessage(msg);
  });

}

export async function stopDiscord() {
  if (!client) return;
  _onMessage = null;
  try { await client.destroy(); } catch {}
  client = null;
  DISCORD_STATE.running = false;
  DISCORD_STATE.username = null;
  _sentReplies.clear();
}

export async function sendTyping(channelOrMsg) {
  if (!client) return;
  try { await (channelOrMsg.channel ?? channelOrMsg).sendTyping(); } catch {}
}

// Returns Message[] so callers can track replies for edit support
export async function sendDM(channelOrMsg, text) {
  if (!client) throw new Error('Discord bot not running');
  return _sendChunks(channelOrMsg, text);
}

async function _sendChunks(channelOrMsg, text) {
  const channel = channelOrMsg.channel ?? channelOrMsg;
  const LIMIT = 1900;
  if (text.length <= LIMIT) return [await channel.send(text)];
  // Split on newlines where possible to avoid cutting mid-word or mid-codeblock
  const chunks = [];
  let remaining = text;
  while (remaining.length > LIMIT) {
    let cut = remaining.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  const sent = [];
  for (const chunk of chunks) sent.push(await channel.send(chunk));
  return sent;
}
