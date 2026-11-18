import { fileURLToPath } from 'node:url';

export function taskModeInstructions(runtime) {
  const helper = fileURLToPath(new URL('./task-finish.mjs', import.meta.url));
  const command = "node '" + helper.replaceAll("'", "'\\''") + "'";
  const instructions = [
    'This is a Stack Task mode terminal for one task. Work on the task the user types here.',
    'If you need input or the task is incomplete, explain what is needed and leave the session open.',
    'When the task is complete, make your last action the finish command below. It saves the brief to the Stack Inbox and closes this terminal.',
    `Run ${command} with two quoted arguments: a short task title, then a brief account of the result and any verification or limits. Retry if the command reports that saving failed.`,
  ].join(' ');
  return runtime === 'codex' ? `developer_instructions=${JSON.stringify(instructions)}` : instructions;
}
