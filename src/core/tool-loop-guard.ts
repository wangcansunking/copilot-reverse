import type { CanonicalMessage, ContentBlock } from "./canonical.js";

const MIN_REPEATED_EDITS = 12;
const numericTail = (text: string) => text.replace(/\d+(?=[^\d]*$)/, "#");
const tokenReminder = (block: ContentBlock) => block.type === "text" &&
  /^(?:<system-reminder>\s*)?<total_tokens>\d+ tokens left<\/total_tokens>(?:\s*<\/system-reminder>)?$/.test(block.text.trim());

// Inspect only the replayed tail, never shared worker state. Require successful, connected Edit
// replacements that change only the final number; ordinary edits in the same file are not a loop.
export function repeatedEditLoop(messages: CanonicalMessage[]): boolean {
  let expectedOld: string | undefined;
  let shape: string | undefined;
  let count = 0;
  let i = messages.length - 1;
  const reminder = (message: CanonicalMessage) => message.role === "user" && message.content.length > 0 && message.content.every(tokenReminder);
  while (i >= 1) {
    while (i >= 0 && reminder(messages[i])) i--;
    if (i < 1) break;
    const resultMessage = messages[i--];
    const callMessage = messages[i--];
    if (resultMessage.role !== "tool" || callMessage.role !== "assistant") break;
    const results = resultMessage.content.filter((b) => !tokenReminder(b));
    if (results.length !== 1) break;
    const result = results[0];
    const calls = callMessage.content.filter((b) => b.type === "tool_use");
    if (calls.length !== 1) break;
    const call = calls[0];
    if (result.type !== "tool_result" || result.isError || result.toolUseId !== call.id || call.name !== "Edit") break;
    if (!call.input || typeof call.input !== "object") break;
    const input = call.input as Record<string, unknown>;
    const { file_path: path, old_string: oldText, new_string: newText } = input;
    if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string" || oldText === newText) break;
    if (numericTail(oldText) !== numericTail(newText)) break;
    if (expectedOld !== undefined && newText !== expectedOld) break;
    const current = JSON.stringify([path, input.replace_all ?? false, numericTail(oldText)]);
    if (shape !== undefined && current !== shape) break;
    shape = current;
    expectedOld = oldText;
    if (++count >= MIN_REPEATED_EDITS) return true;
  }
  return false;
}
