#!/usr/bin/env node
// Render with CloudBake from Grok, through the xAI API. Grok calls CloudBake's hosted MCP server itself (xAI's
// "Remote MCP tools": https://docs.x.ai/developers/tools/remote-mcp), with your CloudBake API key, and answers
// with what it did. Plain Node 20 or later, no packages.
//
//   XAI_API_KEY=xai-… CLOUDBAKE_API_KEY=cb_live_… node grok/render-with-grok.mjs
//   node grok/render-with-grok.mjs "Render frames 1-4 of the CloudBake sample scene at 640x360"
//
// The keys can also be in ~/.config/xai/api_key and ~/.config/cloudbake/api_key. XAI_MODEL picks the model
// (grok-4.7 unless set). Neither key is printed. The render is paid from your CloudBake credit (a sample frame
// costs about a cent); the tokens from your xAI credit.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
async function key(variable, ...file) {
  const value = (process.env[variable] ?? '').trim();
  if (value) return value;
  try {
    return (await readFile(join(config, ...file), 'utf8')).trim();
  } catch {
    return '';
  }
}

const xai = await key('XAI_API_KEY', 'xai', 'api_key');
const cloudbake = await key('CLOUDBAKE_API_KEY', 'cloudbake', 'api_key');
if (!xai) throw new Error('Set XAI_API_KEY (make one at https://console.x.ai), or save it in ~/.config/xai/api_key.');
if (!/^cb_live_[0-9a-f]{40}$/.test(cloudbake)) {
  throw new Error('Set CLOUDBAKE_API_KEY (make one at https://cloudbake.ai/app/connections), or save it in ~/.config/cloudbake/api_key.');
}

const ask =
  process.argv[2] ??
  'Use CloudBake to render frame 1 of its sample scene. Wait until the job has ended (call status with wait: true until it is done), then tell me what it cost and give me the download link of the frame.';

const started = Date.now();
const answer = await fetch('https://api.x.ai/v1/responses', {
  method: 'POST',
  headers: { authorization: `Bearer ${xai}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.XAI_MODEL || 'grok-4.7',
    input: [{ role: 'user', content: ask }],
    tools: [
      {
        type: 'mcp',
        server_url: 'https://cloudbake.ai/mcp',
        server_label: 'cloudbake',
        server_description: 'CloudBake renders Blender scenes on cloud GPUs.',
        // The tools Grok may call. Leave out cancel, upload and the rest unless you want Grok to use them.
        allowed_tools: ['whoami', 'render', 'status', 'download', 'video'],
        // Sent to CloudBake as the Authorization header of every MCP request.
        authorization: cloudbake,
      },
    ],
  }),
});
const body = await answer.json().catch(() => null);
if (!answer.ok) throw new Error(`xAI answered ${answer.status}: ${JSON.stringify(body?.error ?? body)}`);

// What Grok called, then what it said.
for (const item of body.output ?? []) {
  if (item.type === 'mcp_call') console.log(`• ${item.server_label}.${item.name}(${item.arguments ?? ''})${item.error ? ` failed: ${item.error}` : ''}`);
}
const text = (body.output ?? [])
  .filter((item) => item.type === 'message')
  .flatMap((item) => item.content ?? [])
  .map((part) => part.text ?? '')
  .join('\n');
console.log(`\n${text || '(no text)'}\n\n${body.model}, ${Math.round((Date.now() - started) / 1000)} s, ${body.usage?.total_tokens ?? '?'} tokens`);
