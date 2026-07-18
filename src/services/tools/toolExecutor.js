// StreamingToolExecutor.js — Executes tool calls with concurrency control.
//
// Runs tool calls in partitioned batches: consecutive read-only (concurrent-safe)
// tools execute in parallel via Promise.allSettled, while write/exclusive tools
// run one at a time. Results are emitted in the original tool-call order.
//
// Features:
//   - Concurrency control: max N parallel tools (configurable)
//   - Result ordering: results match input order regardless of completion order
//   - Sibling abort: when one tool in a batch errors, remaining tools in the
//     batch can be cancelled via an AbortSignal
//   - Graceful error handling: failed tools get synthetic error results

import { partitionToolCalls } from './toolOrchestration.js';

function combineAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 1) return { signal: active[0], cleanup: () => {} };
  const controller = new AbortController();
  const listeners = [];
  const abortFrom = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const source of active) {
    if (source.aborted) {
      abortFrom(source);
      break;
    }
    const listener = () => abortFrom(source);
    listeners.push([source, listener]);
    source.addEventListener('abort', listener, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
    },
  };
}

export class StreamingToolExecutor {
  /**
   * @param {object} opts
   * @param {number}  opts.maxConcurrency — max parallel tools per batch (default 10)
   * @param {Function} opts.executeFn — (name, input, {signal}) => Promise<{output, success}>
   * @param {Function} opts.onToolCall — called when a tool starts: ({name, input, id})
   * @param {Function} opts.onToolResult — called when a tool completes: ({id, name, output, success})
   * @param {Function} opts.onBatchStart — called when a batch starts: (batchIndex, batch)
   * @param {Function} opts.onBatchEnd — called when a batch ends: (batchIndex, results)
   * @param {Function} opts.isCancelled — () => boolean, checks if the run should stop
   */
  constructor({ maxConcurrency = 10, executeFn, onToolCall, onToolResult, onBatchStart, onBatchEnd, isCancelled }) {
    this.maxConcurrency = maxConcurrency;
    this.executeFn = executeFn;
    this.onToolCall = onToolCall || (() => {});
    this.onToolResult = onToolResult || (() => {});
    this.onBatchStart = onBatchStart || (() => {});
    this.onBatchEnd = onBatchEnd || (() => {});
    this.isCancelled = isCancelled || (() => false);
  }

  /**
   * Execute a list of tool calls, returning results in the original order.
   *
   * @param {Array<{id:string, name:string, input:object}>} toolCalls
   * @param {AbortSignal} [signal] — optional external abort signal
   * @returns {Promise<Array<{id:string, name:string, output:string, success:boolean}>>}
   */
  async execute(toolCalls, signal) {
    if (!toolCalls.length) return [];

    const batches = partitionToolCalls(toolCalls);
    const allResults = [];

    for (let bi = 0; bi < batches.length; bi++) {
      if (this.isCancelled()) {
        // Mark remaining tools as interrupted
        for (const tc of batches[bi]) {
          const result = { id: tc.id, name: tc.name, output: 'Interrupted by user.', success: false };
          allResults.push(result);
          this.onToolResult(result);
        }
        continue;
      }

      const batch = batches[bi];
      this.onBatchStart(bi, batch);

      let batchResults;
      if (batch.length === 1) {
        // Single exclusive tool — run directly
        const tc = batch[0];
        this.onToolCall({ name: tc.name, input: tc.input, id: tc.id });
        const result = await this._runSingle(tc, signal);
        allResults.push(result);
        this.onToolResult(result);
        batchResults = [result];
      } else {
        // Multiple concurrent-safe tools — run in parallel with concurrency cap
        batchResults = await this._runParallel(batch, signal);
        for (const result of batchResults) {
          allResults.push(result);
          this.onToolResult(result);
        }
      }

      this.onBatchEnd(bi, batchResults);
    }

    return allResults;
  }

  /**
   * Run a single tool call with error handling.
   */
  async _runSingle(tc, signal) {
    try {
      const result = await this.executeFn(tc.name, tc.input, { signal });
      return { id: tc.id, name: tc.name, ...result };
    } catch (err) {
      if (this.isCancelled()) {
        return { id: tc.id, name: tc.name, output: 'Interrupted by user.', success: false };
      }
      return {
        id: tc.id,
        name: tc.name,
        output: err?.message || 'Tool execution error',
        success: false,
      };
    }
  }

  /**
   * Run multiple tools in parallel, respecting maxConcurrency.
   * Results are returned in the same order as the input toolCalls.
   * If any tool fails, sibling abort signals are triggered for the rest of the batch.
   */
  async _runParallel(batch, signal) {
    const results = new Array(batch.length);
    const batchAbort = new AbortController();

    // Combine external signal with batch-local abort
    const combined = combineAbortSignals([signal, batchAbort.signal]);
    const combinedSignal = combined.signal;

    // Track whether any tool failed (for sibling abort)
    let siblingFailed = false;

    // Process in chunks of maxConcurrency
    for (let i = 0; i < batch.length; i += this.maxConcurrency) {
      if (this.isCancelled() || siblingFailed) {
        for (let j = i; j < Math.min(i + this.maxConcurrency, batch.length); j++) {
          results[j] = { id: batch[j].id, name: batch[j].name, output: 'Interrupted by sibling error.', success: false };
        }
        break;
      }

      const chunk = batch.slice(i, i + this.maxConcurrency);

      // Notify about each tool call in this chunk
      for (const tc of chunk) {
        this.onToolCall({ name: tc.name, input: tc.input, id: tc.id });
      }

      const settled = await Promise.allSettled(
        chunk.map(tc => this.executeFn(tc.name, tc.input, { signal: combinedSignal }))
      );

      for (let j = 0; j < chunk.length; j++) {
        const tc = chunk[j];
        const r = settled[j];
        let result;
        if (r.status === 'fulfilled') {
          result = { id: tc.id, name: tc.name, ...r.value };
        } else {
          result = { id: tc.id, name: tc.name, output: r.reason?.message || 'Tool error', success: false };
          siblingFailed = true;
        }
        results[i + j] = result;
      }

      // If any failed, abort remaining siblings in the batch
      if (siblingFailed) {
        batchAbort.abort();
        // Fill remaining slots with interruption results
        for (let j = i + chunk.length; j < batch.length; j++) {
          results[j] = { id: batch[j].id, name: batch[j].name, output: 'Interrupted by sibling error.', success: false };
        }
      }
    }

    combined.cleanup();
    return results;
  }
}

/**
 * Create a StreamingToolExecutor with Axion's default settings.
 */
export function createToolExecutor(opts = {}) {
  return new StreamingToolExecutor({
    maxConcurrency: opts.maxConcurrency ?? 10,
    executeFn: opts.executeFn,
    onToolCall: opts.onToolCall,
    onToolResult: opts.onToolResult,
    onBatchStart: opts.onBatchStart,
    onBatchEnd: opts.onBatchEnd,
    isCancelled: opts.isCancelled,
  });
}
