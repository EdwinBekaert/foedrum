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
 * apostrophe, inside other text, or with another separator.
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
