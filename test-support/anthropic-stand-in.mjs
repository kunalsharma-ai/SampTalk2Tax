/**
 * A local stand-in for Anthropic's Messages API, for tests only. The copilot's real code
 * (the official SDK, streaming included) talks to it when the API runs with
 * ANTHROPIC_BASE_URL pointing here. Each test scripts what the "model" returns; nothing
 * here is a language model, and it is never used outside tests.
 *
 *   const standIn = await startAnthropicStandIn(4555);
 *   standIn.script.push((body) => ({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }));
 *   standIn.script.push(() => ({ status: 429, type: 'rate_limit_error', message: 'Slow down' }));
 */
import { createServer } from 'node:http';

export async function startAnthropicStandIn(port = 0) {
  const requests = [];
  const script = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not scripted' } }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      requests.push({ headers: req.headers, body });
      const step = script.shift();
      const out = step ? await step(body, req.headers) : { status: 500, type: 'api_error', message: 'The test did not script this request' };
      if (out.status) {
        // x-should-retry: false stops the SDK's automatic retries, so a scripted error is seen at once.
        res.writeHead(out.status, { 'content-type': 'application/json', 'x-should-retry': 'false', 'request-id': `req_standin_${++n}` });
        res.end(JSON.stringify({ type: 'error', error: { type: out.type, message: out.message } }));
        return;
      }
      const message = {
        id: `msg_standin_${++n}`,
        type: 'message',
        role: 'assistant',
        model: out.model ?? body.model,
        content: out.content,
        stop_reason: out.stop_reason ?? 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: out.inputTokens ?? 1000, output_tokens: out.outputTokens ?? 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } });
      message.content.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        } else if (block.type === 'thinking') {
          send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
          send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
          send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
        } else if (block.type === 'tool_use') {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        send('content_block_stop', { index });
      });
      send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    script,
    close: () => new Promise((r) => server.close(r)),
  };
}
