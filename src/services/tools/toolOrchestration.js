// toolOrchestration.js — Partitions tool calls into parallel-safe batches.
//
// Consecutive read-only tools (isConcurrencySafe) are grouped into batches
// that can execute in parallel. Write tools and non-concurrent tools execute
// alone (exclusive). Results are emitted in the original tool-call order.

/**
 * Metadata for tool concurrency classification.
 * Keys: tool name → { concurrencySafe, readOnly }
 */
const TOOL_META = {
  // Read-only & concurrent-safe: can run in parallel with each other
  read_file:         { concurrencySafe: true, readOnly: true },
  read_file_lines:   { concurrencySafe: true, readOnly: true },
  read_many_files:   { concurrencySafe: true, readOnly: true },
  file_info:         { concurrencySafe: true, readOnly: true },
  list_directory:    { concurrencySafe: true, readOnly: true },
  tree:              { concurrencySafe: true, readOnly: true },
  glob:              { concurrencySafe: true, readOnly: true },
  find_files:        { concurrencySafe: true, readOnly: true },
  grep:              { concurrencySafe: true, readOnly: true },
  grep_files:        { concurrencySafe: true, readOnly: true },
  git_status:        { concurrencySafe: true, readOnly: true },
  git_diff:          { concurrencySafe: true, readOnly: true },
  git_log:           { concurrencySafe: true, readOnly: true },
  web_search:        { concurrencySafe: true, readOnly: true },
  get_working_dir:   { concurrencySafe: true, readOnly: true },
  todo_list:         { concurrencySafe: true, readOnly: true },
  snapshot_list:     { concurrencySafe: true, readOnly: true },
  snapshot_diff:     { concurrencySafe: true, readOnly: true },
  lsp:               { concurrencySafe: true, readOnly: true },
  plan_read:         { concurrencySafe: true, readOnly: true },
  wiki_read:         { concurrencySafe: true, readOnly: true },
  wiki_search:       { concurrencySafe: true, readOnly: true },
  screenshot:        { concurrencySafe: true, readOnly: true },
  screen_size:       { concurrencySafe: true, readOnly: true },
  chrome_status:     { concurrencySafe: true, readOnly: true },
  chrome_tabs:       { concurrencySafe: true, readOnly: true },
  chrome_read_page:  { concurrencySafe: true, readOnly: true },
  chrome_screenshot: { concurrencySafe: true, readOnly: true },
  chrome_find:       { concurrencySafe: true, readOnly: true },
  chrome_html:       { concurrencySafe: true, readOnly: true },
  chrome_value:      { concurrencySafe: true, readOnly: true },

  // Write / side-effecting tools: exclusive (one at a time)
  write_file:        { concurrencySafe: false, readOnly: false },
  patch_file:        { concurrencySafe: false, readOnly: false },
  delete_file:       { concurrencySafe: false, readOnly: false },
  move_file:         { concurrencySafe: false, readOnly: false },
  copy_file:         { concurrencySafe: false, readOnly: false },
  append_file:       { concurrencySafe: false, readOnly: false },
  replace_in_files:  { concurrencySafe: false, readOnly: false },
  create_directory:  { concurrencySafe: false, readOnly: false },
  change_working_dir:{ concurrencySafe: false, readOnly: false },
  git_commit:        { concurrencySafe: false, readOnly: false },
  git_push:          { concurrencySafe: false, readOnly: false },
  run_command:       { concurrencySafe: false, readOnly: false },
  snapshot_restore:  { concurrencySafe: false, readOnly: false },
  plan_write:        { concurrencySafe: false, readOnly: false },
  wiki_write:        { concurrencySafe: false, readOnly: false },
  todo_add:          { concurrencySafe: false, readOnly: false },
  todo_done:         { concurrencySafe: false, readOnly: false },
  todowrite:         { concurrencySafe: false, readOnly: false },
  chrome_click:      { concurrencySafe: false, readOnly: false },
  chrome_type:       { concurrencySafe: false, readOnly: false },
  chrome_scroll:     { concurrencySafe: false, readOnly: false },
  chrome_navigate:   { concurrencySafe: false, readOnly: false },
  chrome_select:     { concurrencySafe: false, readOnly: false },

  // Interactive tools: exclusive (require user input)
  ask_question:      { concurrencySafe: false, readOnly: false },
  ask_multiple_choice:{ concurrencySafe: false, readOnly: false },
  ask_confirm:       { concurrencySafe: false, readOnly: false },
  ask_questions:     { concurrencySafe: false, readOnly: false },
  ask_vision:        { concurrencySafe: false, readOnly: false },
  check_task:        { concurrencySafe: false, readOnly: false },
  send_input:        { concurrencySafe: false, readOnly: false },
  send_message:      { concurrencySafe: false, readOnly: false },
  wait_for_message:  { concurrencySafe: false, readOnly: false },
  spawn_agents:      { concurrencySafe: false, readOnly: false },
  end_conversation:  { concurrencySafe: false, readOnly: false },
  schedule_followup: { concurrencySafe: false, readOnly: false },
  speak:             { concurrencySafe: false, readOnly: false },
  analyze_video:     { concurrencySafe: false, readOnly: false },
  analyze_audio:     { concurrencySafe: false, readOnly: false },
  wait:              { concurrencySafe: false, readOnly: false },
  list_tools:        { concurrencySafe: false, readOnly: false },
  click_on:          { concurrencySafe: false, readOnly: false },
  click_at:          { concurrencySafe: false, readOnly: false },
  type_text:         { concurrencySafe: false, readOnly: false },
  press_key:         { concurrencySafe: false, readOnly: false },
  scroll:            { concurrencySafe: false, readOnly: false },
};

export function getToolMeta(name) {
  return TOOL_META[name] || { concurrencySafe: false, readOnly: false };
}

/**
 * Partition an ordered list of tool calls into sequential batches.
 *
 * Each batch is either:
 *   - a single exclusive tool (concurrencySafe=false), or
 *   - a group of consecutive concurrent-safe tools that can run in parallel.
 *
 * @param {Array<{name:string}>} toolCalls — ordered tool calls from the model
 * @returns {Array<Array<{name:string}>>} — batches to execute sequentially
 */
export function partitionToolCalls(toolCalls) {
  const batches = [];
  let currentBatch = [];

  for (const tc of toolCalls) {
    const meta = getToolMeta(tc.name);
    if (meta.concurrencySafe) {
      // Accumulate into current concurrent batch
      currentBatch.push(tc);
    } else {
      // Flush any accumulated concurrent batch, then run this exclusive tool alone
      if (currentBatch.length) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      batches.push([tc]);
    }
  }

  // Flush trailing concurrent batch
  if (currentBatch.length) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Check if ALL tool calls are concurrent-safe (quick path for Promise.all).
 */
export function allConcurrentSafe(toolCalls) {
  return toolCalls.length > 1 && toolCalls.every(tc => getToolMeta(tc.name).concurrencySafe);
}
