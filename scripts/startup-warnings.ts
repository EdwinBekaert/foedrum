// The permission rules Claude Code warns about at startup, or skips, because they never match
// what they seem to (#42). The list follows the Claude Code docs, which can change:
// https://code.claude.com/docs/en/permissions#match-by-input-parameter
// https://code.claude.com/docs/en/permissions#tool-name-wildcards
// https://code.claude.com/docs/en/permissions#read-and-edit
// https://code.claude.com/docs/en/errors#has-a-wildcard-before-the-rest-of-the-command
// https://code.claude.com/docs/en/errors#is-not-matched-by-file-permission-checks

export interface Permissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

// The canonical tool names (https://code.claude.com/docs/en/tools-reference), with the removed
// TaskOutput and the legacy MultiEdit, which Claude Code still knows.
const KNOWN_TOOLS = new Set([
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

// File permission checks consult only Edit and Read path rules.
const UNCHECKED_PATH_TOOLS = new Set(['Write', 'NotebookEdit', 'Glob', 'MultiEdit']);

// Each tool's main field, which a Tool(param:value) rule cannot match.
const MAIN_FIELDS: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'path',
  Glob: 'path',
  NotebookEdit: 'notebook_path',
  WebFetch: 'url',
};

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

type List = keyof Permissions;

// Why Claude Code warns about the rule, or undefined.
const ruleWarning = (list: List, rule: string): string | undefined => {
  const match = /^([^(]*)(?:\((.*)\))?$/s.exec(rule);
  const tool = match?.[1] ?? rule;
  const content = match?.[2];
  if (list === 'allow' && tool.includes('*') && !/^mcp__[^*]+__/.test(tool)) {
    return 'an allow glob not anchored to one MCP server is skipped';
  }
  if (list !== 'allow' && !KNOWN_TOOLS.has(tool) && !/[_*]/.test(tool)) {
    return `no tool is called ${tool}`;
  }
  if (content === undefined) return undefined;
  const field = Object.hasOwn(MAIN_FIELDS, tool) ? MAIN_FIELDS[tool] : undefined;
  if (field !== undefined && new RegExp(`^\\s*${field}\\s*:`).test(content)) {
    return `a rule on ${tool}'s main field ${field} is ignored`;
  }
  if (UNCHECKED_PATH_TOOLS.has(tool)) {
    return `file permission checks never consult ${tool} path rules; use Edit or Read`;
  }
  if (list === 'allow' && SHELL_TOOLS.has(tool) && /\*\s+\S/.test(content)) {
    return 'a * before a later word also approves any options inserted there';
  }
  return undefined;
};

// One line per rule Claude Code would warn about, naming the list, the rule and why.
export const startupWarnings = (permissions: Permissions): string[] =>
  (['allow', 'ask', 'deny'] as const).flatMap((list) =>
    (permissions[list] ?? []).flatMap((rule) => {
      const why = ruleWarning(list, rule);
      return why === undefined ? [] : [`${list}: ${rule}: ${why}`];
    }),
  );
