import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NamedError,
  UnknownError,
  ToolExecutionError,
  ProviderError,
  ConfigError,
  PermissionError,
  ValidationError,
} from '../src/utils/namedError.js';

// ── Basic creation ──────────────────────────────────────────────────────────

test('NamedError.create returns a constructor with correct name', () => {
  const MyErr = NamedError.create('MyError', { detail: 'string' });
  assert.equal(MyErr.name, 'MyError');
  const e = new MyErr({ detail: 'hello' });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof NamedError);
  assert.equal(e.name, 'MyError');
  assert.equal(e.data.detail, 'hello');
});

test('error has stack trace', () => {
  const MyErr = NamedError.create('StackErr');
  const e = new MyErr();
  assert.ok(typeof e.stack === 'string');
  assert.ok(e.stack.includes('StackErr'));
});

// ── Field types ─────────────────────────────────────────────────────────────

test('validates string field type', () => {
  const MyErr = NamedError.create('TypeErr', { val: 'string' });
  assert.throws(() => new MyErr({ val: 123 }), /expected string, got number/);
  assert.doesNotThrow(() => new MyErr({ val: 'ok' }));
});

test('validates number field type', () => {
  const MyErr = NamedError.create('NumErr', { count: 'number' });
  assert.throws(() => new MyErr({ count: 'bad' }), /expected number, got string/);
  assert.doesNotThrow(() => new MyErr({ count: 42 }));
});

test('validates boolean field type', () => {
  const MyErr = NamedError.create('BoolErr', { flag: 'boolean' });
  assert.throws(() => new MyErr({ flag: 1 }), /expected boolean, got number/);
  assert.doesNotThrow(() => new MyErr({ flag: true }));
});

test('validates object field type', () => {
  const MyErr = NamedError.create('ObjErr', { cfg: 'object' });
  assert.throws(() => new MyErr({ cfg: [1] }), /expected object, got object/);
  assert.doesNotThrow(() => new MyErr({ cfg: { a: 1 } }));
});

test('"any" type accepts everything', () => {
  const MyErr = NamedError.create('AnyErr', { x: 'any' });
  assert.doesNotThrow(() => new MyErr({ x: 1 }));
  assert.doesNotThrow(() => new MyErr({ x: 'str' }));
  assert.doesNotThrow(() => new MyErr({ x: null }));
});

// ── Required fields ─────────────────────────────────────────────────────────

test('required field throws TypeError when missing', () => {
  const MyErr = NamedError.create('ReqErr', {
    requiredField: { type: 'string', required: true },
  });
  assert.throws(() => new MyErr({}), /required field "requiredField" is missing/);
});

test('required field is accepted when provided', () => {
  const MyErr = NamedError.create('ReqOk', {
    requiredField: { type: 'string', required: true },
  });
  assert.doesNotThrow(() => new MyErr({ requiredField: 'yes' }));
});

// ── Default values ──────────────────────────────────────────────────────────

test('field with default uses default when omitted', () => {
  const MyErr = NamedError.create('DefErr', {
    status: { type: 'number', default: 500 },
  });
  const e = new MyErr({});
  assert.equal(e.data.status, 500);
});

test('provided value overrides default', () => {
  const MyErr = NamedError.create('DefOverride', {
    status: { type: 'number', default: 500 },
  });
  const e = new MyErr({ status: 404 });
  assert.equal(e.data.status, 404);
});

// ── Optional fields ─────────────────────────────────────────────────────────

test('optional field is omitted from data when not provided', () => {
  const MyErr = NamedError.create('OptErr', { opt: 'string' });
  const e = new MyErr({});
  assert.ok(!('opt' in e.data));
});

// ── String shorthand for field definitions ───────────────────────────────────

test('string shorthand creates optional field with type string', () => {
  const MyErr = NamedError.create('ShortErr', { msg: 'string' });
  const e = new MyErr({ msg: 'hi' });
  assert.equal(e.data.msg, 'hi');
  const e2 = new MyErr({});
  assert.ok(!('msg' in e2.data));
});

// ── hasName ─────────────────────────────────────────────────────────────────

test('hasName returns true for matching error', () => {
  const e = new ToolExecutionError({ tool: 'read_file' });
  assert.ok(NamedError.hasName(e, 'ToolExecutionError'));
});

test('hasName returns false for non-matching name', () => {
  const e = new ToolExecutionError({ tool: 'read_file' });
  assert.ok(!NamedError.hasName(e, 'OtherError'));
});

test('hasName returns false for non-error values', () => {
  assert.ok(!NamedError.hasName(null, 'X'));
  assert.ok(!NamedError.hasName(undefined, 'X'));
  assert.ok(!NamedError.hasName('string', 'X'));
  assert.ok(!NamedError.hasName({ name: 'X' }, 'X'));
});

// ── isInstance ──────────────────────────────────────────────────────────────

test('static isInstance works correctly', () => {
  const e = new ToolExecutionError({ tool: 'grep' });
  assert.ok(ToolExecutionError.isInstance(e));
  assert.ok(!ProviderError.isInstance(e));
});

// ── toObject ────────────────────────────────────────────────────────────────

test('instance toObject returns { name, data, message }', () => {
  const e = new ProviderError({ provider: 'openai', status: 429, message: 'rate limited' });
  const obj = e.toObject();
  assert.deepEqual(obj, {
    name: 'ProviderError',
    data: { provider: 'openai', status: 429, message: 'rate limited' },
    message: 'rate limited',
  });
});

test('static toObject works on NamedError instances', () => {
  const e = new ConfigError({ message: 'bad config' });
  const obj = NamedError.toObject(e);
  assert.equal(obj.name, 'ConfigError');
  assert.deepEqual(obj.data, { message: 'bad config' });
});

test('static toObject falls back for plain Error', () => {
  const e = new Error('plain');
  const obj = NamedError.toObject(e);
  assert.equal(obj.name, 'Error');
  assert.equal(obj.message, 'plain');
  assert.deepEqual(obj.data, {});
});

test('static toObject handles non-error values', () => {
  const obj = NamedError.toObject('not an error');
  assert.equal(obj.name, 'UnknownError');
});

// ── isNamedError ────────────────────────────────────────────────────────────

test('isNamedError returns true for NamedError instances', () => {
  assert.ok(NamedError.isNamedError(new ToolExecutionError({ tool: 'x' })));
});

test('isNamedError returns false for plain Error', () => {
  assert.ok(!NamedError.isNamedError(new Error('x')));
});

// ── Built-in error types ────────────────────────────────────────────────────

test('ToolExecutionError requires tool field', () => {
  assert.throws(() => new ToolExecutionError({}), /required field "tool"/);
  const e = new ToolExecutionError({ tool: 'write_file', message: 'denied' });
  assert.equal(e.data.tool, 'write_file');
  assert.equal(e.data.message, 'denied');
});

test('ProviderError requires provider field', () => {
  assert.throws(() => new ProviderError({}), /required field "provider"/);
  const e = new ProviderError({ provider: 'anthropic', status: 500 });
  assert.equal(e.data.provider, 'anthropic');
  assert.equal(e.data.status, 500);
});

test('ConfigError requires message field', () => {
  assert.throws(() => new ConfigError({}), /required field "message"/);
  const e = new ConfigError({ message: 'missing key', key: 'API_KEY' });
  assert.equal(e.data.key, 'API_KEY');
});

test('PermissionError requires message field', () => {
  assert.throws(() => new PermissionError({}), /required field "message"/);
  const e = new PermissionError({ tool: 'edit', action: 'write', message: 'denied' });
  assert.equal(e.data.tool, 'edit');
});

test('ValidationError requires message field', () => {
  assert.throws(() => new ValidationError({}), /required field "message"/);
  const e = new ValidationError({ field: 'path', message: 'invalid' });
  assert.equal(e.data.field, 'path');
});

test('UnknownError requires message field', () => {
  assert.throws(() => new UnknownError({}), /required field "message"/);
  const e = new UnknownError({ message: 'something broke', ref: 'abc' });
  assert.equal(e.data.message, 'something broke');
  assert.equal(e.data.ref, 'abc');
});

// ── Serialization round-trip ────────────────────────────────────────────────

test('toObject output is JSON-serializable', () => {
  const e = new ProviderError({ provider: 'groq', status: 429, message: 'limited' });
  const json = JSON.stringify(e.toObject());
  const parsed = JSON.parse(json);
  assert.equal(parsed.name, 'ProviderError');
  assert.equal(parsed.data.provider, 'groq');
  assert.equal(parsed.data.status, 429);
});

// ── Message derivation ──────────────────────────────────────────────────────

test('message defaults to name when not in data', () => {
  const MyErr = NamedError.create('NoMsgErr');
  const e = new MyErr();
  assert.equal(e.message, 'NoMsgErr');
});

test('message from data.message overrides default', () => {
  const MyErr = NamedError.create('WithMsg', { message: 'string' });
  const e = new MyErr({ message: 'custom msg' });
  assert.equal(e.message, 'custom msg');
});

// ── Empty fields ────────────────────────────────────────────────────────────

test('create with no fields works', () => {
  const EmptyErr = NamedError.create('EmptyErr');
  const e = new EmptyErr();
  assert.equal(e.name, 'EmptyErr');
  assert.deepEqual(e.data, {});
});

// ── hasName edge cases ──────────────────────────────────────────────────────

test('hasName with plain Error that has same name', () => {
  const e = new Error('test');
  e.name = 'ToolExecutionError';
  assert.ok(NamedError.hasName(e, 'ToolExecutionError'));
});
