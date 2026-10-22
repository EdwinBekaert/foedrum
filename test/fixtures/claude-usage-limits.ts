// A run-out usage window as claude reports it (#238, ADR 0091), built from Claude Code's docs and
// never captured: claude cannot be made to hit a limit. The texts are those of the error reference
// (code.claude.com/docs/en/errors, "Usage limits"); the result's shape is the Agent SDK's
// `SDKResultMessage`, which the docs leave open for a usage limit, so both arms carry the text.

/** The four documented messages, with the limit and the reset text they name. */
export const documentedUsageLimits = [
  { text: "You've hit your session limit · resets 3:45pm", limit: 'session', resets: '3:45pm' },
  {
    text: "You've hit your weekly limit · resets Mon 12:00am",
    limit: 'weekly',
    resets: 'Mon 12:00am',
  },
  { text: "You've hit your Opus limit · resets 3:45pm", limit: 'Opus', resets: '3:45pm' },
  { text: "You've hit your Sonnet limit · resets 3:45pm", limit: 'Sonnet', resets: '3:45pm' },
] as const;

/**
 * Texts near a usage limit that are none of the four: a warning before the window runs out, the
 * interactive wait's line, a spend limit, a server throttle, and the message with a curly
 * apostrophe, inside other text, with another separator, or followed by more lines.
 */
export const otherLimitTexts = [
  "You've used 85% of your session limit · resets 3:45pm",
  'Usage limit reached · limit resets 3:45pm',
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
  "You've hit your individual usage limit · ask your admin for a higher limit",
  'API Error: Server is temporarily limiting requests (not your usage limit)',
  'You’ve hit your session limit · resets 3:45pm',
  "Claude said: You've hit your session limit · resets 3:45pm",
  "You've hit your session limit - resets 3:45pm",
  "You've hit your Haiku limit · resets 3:45pm",
  "You've hit your session limit · resets ",
  "You've hit your session limit · resets 3:45pm\nSee https://status.claude.com",
] as const;

/**
 * The spend-limit and credit messages of the same reference (#257, ADR 0129; "You've hit your
 * monthly spend limit" and "Credit balance is too low", read 2026-10-22): each refuses every
 * request until a human raises the limit or adds credits. The text after the `·` varies with the
 * plan; the individual usage limit is documented without one.
 */
export const documentedSpendLimits = [
  {
    text: "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message",
    spendLimit: { kind: 'spend', limit: 'monthly spend limit' },
  },
  {
    text: "You've hit your individual spend limit · ask your admin for a higher limit",
    spendLimit: { kind: 'spend', limit: 'individual spend limit' },
  },
  {
    text: "You've hit your org's monthly spend limit · visit https://claude.ai/admin-settings/usage to raise it",
    spendLimit: { kind: 'spend', limit: "org's monthly spend limit" },
  },
  {
    text: "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage",
    spendLimit: { kind: 'spend', limit: "team's shared budget" },
  },
  {
    text: "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings",
    spendLimit: { kind: 'spend', limit: "channel's monthly spend limit" },
  },
  {
    text: "You've hit your individual usage limit",
    spendLimit: { kind: 'spend', limit: 'individual usage limit' },
  },
  { text: 'Credit balance is too low', spendLimit: { kind: 'credit' } },
] as const;

/**
 * Texts near a spend limit that are none of the documented ones: a spend limit whose plan window
 * resets by itself, a gateway's cap, a failed change of the limit, the API's own credit message,
 * a limit the docs do not name, and the message with a curly apostrophe, inside other text, with
 * another separator, with nothing after the separator, or followed by more lines.
 */
export const otherSpendTexts = [
  "You've hit your monthly spend limit · your session limit resets 3:45pm",
  'spend limit reached (daily; resets 2026-08-09 00:00 UTC)',
  'spend limit reached',
  'spend limit unavailable',
  'Could not update your spend limit: below current usage',
  'Your credit balance is too low to access the Anthropic API.',
  "You've hit your weekly spend limit · raise it at https://claude.ai/settings/usage",
  'You’ve hit your monthly spend limit · raise it at https://claude.ai/settings/usage',
  "API Error: You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
  "You've hit your monthly spend limit - raise it at https://claude.ai/settings/usage",
  "You've hit your monthly spend limit · ",
  "You've hit your monthly spend limit ·  raise it at https://claude.ai/settings/usage",
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage\nSee https://status.claude.com",
  'Credit balance is too low.',
  'Credit balance is too low\nSee https://platform.claude.com/settings/billing',
] as const;

const SESSION = '00000000-0000-4000-8000-000000000001';

/** The rejection `SDKRateLimitEvent` documents; the reader ignores it. */
export const rejectedRateLimit = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected' },
  uuid: '00000000-0000-4000-8000-000000000101',
  session_id: SESSION,
});

const totals = {
  session_id: SESSION,
  uuid: '00000000-0000-4000-8000-000000000102',
  duration_ms: 812,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
};

/**
 * The error results that may carry `text`: the success arm with the failure as its `result` (the
 * headless docs: a failure inside the run is printed as the result), and the error arm with it in
 * `errors`.
 */
export const limitResults = (text: string, isError = true): string[] => [
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    ...totals,
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: isError,
    errors: [text],
    ...totals,
  }),
];
