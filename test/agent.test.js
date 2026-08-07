import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ThinkStreamFilter ──────────────────────────────────────────────────────────
// Import lazily — agent.js has top-level side effects we want to skip until here
let ThinkStreamFilter;
test('import ThinkStreamFilter', () => {
  // Dynamic import so test runner doesn't fail if deps missing
  return import('../src/agent/agent.js').then(mod => { ThinkStreamFilter = mod.ThinkStreamFilter; });
});

test('ThinkStreamFilter passes plain text to onText', () => {
  const texts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), () => {});
  f.push('hello world');
  f.flush();
  assert.equal(texts.join(''), 'hello world');
});

test('ThinkStreamFilter strips <think> tags and sends content to onThought', () => {
  const texts = [];
  const thoughts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), t => thoughts.push(t));
  f.push('before <think>inner</think> after');
  f.flush();
  assert.equal(texts.join(''), 'before  after');
  assert.equal(thoughts.join(''), 'inner');
});

test('ThinkStreamFilter handles <thinking> tag variant', () => {
  const texts = [];
  const thoughts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), t => thoughts.push(t));
  f.push('a <thinking>deep</thinking> b');
  f.flush();
  assert.equal(texts.join(''), 'a  b');
  assert.equal(thoughts.join(''), 'deep');
});

test('ThinkStreamFilter handles multiple think blocks', () => {
  const texts = [];
  const thoughts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), t => thoughts.push(t));
  f.push('a <think>one</think> b <think>two</think> c');
  f.flush();
  assert.equal(texts.join(''), 'a  b  c');
  assert.deepEqual(thoughts, ['one', 'two']);
});

test('ThinkStreamFilter handles partial tags across chunks (safe tail)', () => {
  const texts = [];
  const thoughts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), t => thoughts.push(t));
  f.push('before <thi');
  f.push('nk>inner</think> after');
  f.flush();
  assert.equal(texts.join(''), 'before  after');
  assert.equal(thoughts.join(''), 'inner');
});

test('ThinkStreamFilter flush outputs remaining thinkBuf', () => {
  const texts = [];
  const thoughts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), t => thoughts.push(t));
  f.push('before <think>unclosed');
  f.flush();
  assert.equal(texts.join(''), 'before ');
  assert.equal(thoughts.join(''), 'unclosed');
});

test('ThinkStreamFilter handles empty chunks', () => {
  const texts = [];
  const f = new ThinkStreamFilter(t => texts.push(t), () => {});
  f.push('');
  f.flush();
  assert.equal(texts.length, 0);
});

// ── Agent loop accumulation (chart strip regex) ───────────────────────────────

test('strip chart blocks from accumulated text', () => {
  const acc = 'some text\n```chart\n{"type":"pie","data":{"datasets":[{"data":[1,2]}]}}\n```\nmore text';
  const cleaned = acc.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  assert.equal(cleaned, 'some text\n\nmore text');
});

test('strip chart block at start of accumulated text', () => {
  const acc = '```chart\n{"type":"pie","data":{"datasets":[{"data":[1]}]}}\n```\nremaining';
  const cleaned = acc.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{2,}/g, '\n').trim();
  assert.equal(cleaned, 'remaining');
});

test('strip multiple chart blocks from accumulated text', () => {
  const acc = 'a\n```chart\n{"type":"pie"}\n```\nb\n```chart\n{"type":"bar"}\n```\nc';
  const cleaned = acc.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{2,}/g, '\n').trim();
  assert.equal(cleaned, 'a\nb\nc');
});

test('combine accumulated text with new text (no chart blocks)', () => {
  const accumulatedText = 'step 1 done.';
  const text = 'step 2 done.';
  const stripped = accumulatedText.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{2,}/g, '\n').trim();
  const final = stripped ? stripped + '\n' + text : text;
  assert.equal(final, 'step 1 done.\nstep 2 done.');
});

test('combine with empty accumulated text uses new text directly', () => {
  const accumulatedText = '';
  const text = 'hello';
  const stripped = accumulatedText.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{2,}/g, '\n').trim();
  const final = stripped ? stripped + '\n' + text : text;
  assert.equal(final, 'hello');
});

test('end_conversation clears context and the next request contains only the new message', async () => {
  const { Agent } = await import('../src/agent/agent.js');
  const events = [];
  const tokenEvents = [];
  const agent = new Agent({
    modelAlias: 'test-model',
    mode: 'auto',
    onMessage: (event) => events.push(event),
    onTokens: (event) => tokenEvents.push(event),
  });

  agent.history = [
    { role: 'user', content: 'old private context' },
    { role: 'assistant', content: 'old answer' },
  ];
  agent.pendingMessages = ['queued before termination'];
  agent.totalTokens = 123;
  agent.inputTokens = 80;
  agent.outputTokens = 43;
  agent.contextTokens = 100;

  agent._callModel = async () => ({
    type: 'openai',
    text: 'draft that must not survive',
    toolCalls: [{ id: 'end-1', name: 'end_conversation', input: { reason: 'internal reason' } }],
  });

  await agent.run('end this conversation');

  assert.equal(agent.terminated, true);
  assert.deepEqual(agent.history, []);
  assert.deepEqual(agent.pendingMessages, []);
  assert.equal(agent.totalTokens, 0);
  assert.ok(tokenEvents.some((event) => event.total === 0 && event.context === 0));
  assert.deepEqual(
    events.filter((event) => event.role === 'session-ended').map((event) => event.content),
    ['Conversation ended. Type a message to start a new conversation.'],
  );
  assert.ok(events.findIndex((event) => event.role === 'session-ended') > events.findIndex((event) => event.role === 'assistant'));

  let requestHistory;
  agent._callModel = async () => {
    requestHistory = structuredClone(agent.history);
    return { type: 'openai', text: 'fresh answer', toolCalls: [] };
  };
  await agent.run('fresh prompt');

  assert.equal(agent.terminated, false);
  assert.deepEqual(requestHistory, [{ role: 'user', content: 'fresh prompt' }]);
  assert.deepEqual(agent.history, [
    { role: 'user', content: 'fresh prompt' },
    { role: 'assistant', content: 'fresh answer' },
  ]);
  assert.doesNotMatch(JSON.stringify(agent.history), /old private context|queued before termination|draft that must not survive/);
});
