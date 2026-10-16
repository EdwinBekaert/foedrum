// A stand-in for the Anthropic Messages API on 127.0.0.1, for tests that run the real `claude`
// CLI without a login and without spending tokens: `claude` talks to it through
// ANTHROPIC_BASE_URL. Its "model" calls one tool, then answers `done` once a tool result came.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMessagesApi {
  /** The base URL to pass as ANTHROPIC_BASE_URL. */
  url: string;
  close: () => Promise<void>;
}

/** The one tool call the fake model makes. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface Block {
  type: 'text' | 'tool_use';
  [key: string]: unknown;
}

// One server-sent event of the streaming Messages API.
const event = (name: string, data: Record<string, unknown>): string =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

const streamed = (message: Record<string, unknown>, content: Block[]): string =>
  [
    event('message_start', { message: { ...message, content: [], stop_reason: null } }),
    ...content.flatMap((block, index) => {
      const { input, text, ...start } = block;
      const delta =
        block.type === 'text'
          ? { type: 'text_delta', text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(input) };
      return [
        event('content_block_start', {
          index,
          content_block:
            block.type === 'text' ? { type: 'text', text: '' } : { ...start, input: {} },
        }),
        event('content_block_delta', { index, delta }),
        event('content_block_stop', { index }),
      ];
    }),
    event('message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event('message_stop', {}),
  ].join('');

export const startFakeMessagesApi = async (tool: ToolCall): Promise<FakeMessagesApi> => {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const path = request.url ?? '';
      // Anything but a model call (a reachability check, token counting) gets a plain answer.
      if (request.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(path)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const parsed = JSON.parse(body) as { model: string; stream?: boolean; messages: unknown };
      calls += 1;
      const answered = JSON.stringify(parsed.messages).includes('"tool_result"');
      const content: Block[] = answered
        ? [{ type: 'text', text: 'done' }]
        : [{ type: 'tool_use', id: `toolu_fake${calls}`, name: tool.name, input: tool.input }];
      const message = {
        id: `msg_fake${calls}`,
        type: 'message',
        role: 'assistant',
        model: parsed.model,
        content,
        stop_reason: answered ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (parsed.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamed(message, content));
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
};
