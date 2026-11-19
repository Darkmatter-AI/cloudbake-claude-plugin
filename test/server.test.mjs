// The plugin's MCP server, run as Claude Code runs it (a child process on stdio), against the fake API.
// Run: node --test claude-plugin/test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FAKE_KEY, PNG, startFakeApi } from './fake-api.mjs';

const SERVER = new URL('../server/cloudbake-mcp.mjs', import.meta.url).pathname;
const BLEND = Buffer.concat([Buffer.from('BLENDER-v405REND'), Buffer.alloc(4096, 7)]);

let fake;
let project;

before(async () => {
  fake = await startFakeApi();
  project = await mkdtemp(join(tmpdir(), 'cloudbake-plugin-'));
  await writeFile(join(project, 'scene.blend'), BLEND);
  await writeFile(join(project, 'broken.blend'), BLEND);
  await writeFile(join(project, 'notes.txt'), 'not a scene');
});
const children = new Set();
after(async () => {
  for (const child of children) child.kill();
  await fake.close();
  await rm(project, { recursive: true, force: true });
});

// Start the server with these settings; talk to it as an MCP client.
function connect(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, CLOUDBAKE_URL: fake.origin, CLOUDBAKE_PROJECT_DIR: project, CLOUDBAKE_POLL_MS: '5', CLOUDBAKE_WAIT_SECONDS: '5', CLOUDBAKE_API_KEY: FAKE_KEY, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const waiting = new Map();
  const notes = [];
  const out = [];
  let err = '';
  child.stderr.on('data', (chunk) => (err += chunk));
  createInterface({ input: child.stdout }).on('line', (line) => {
    out.push(line);
    const message = JSON.parse(line);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else notes.push(message);
  });
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const ask = (method, params) => {
    const id = next++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((done) => waiting.set(id, done));
  };
  const tool = async (name, args = {}, meta) => {
    const answer = await ask('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.ok(answer.result, `tools/call ${name} answered ${JSON.stringify(answer)}`);
    return { ...answer.result, text: answer.result.content.map((part) => part.text).join('\n') };
  };
  return {
    ask,
    send,
    tool,
    notes,
    output: () => out.join('\n') + err,
    close: () => (child.stdin.end(), new Promise((done) => child.on('exit', done))),
  };
}

const jobOf = (text) => JSON.parse(text.slice(text.indexOf('\n\n') + 2));

test('initialize answers the protocol the client asked for, and lists six tools with schemas', async () => {
  const mcp = connect();
  const init = await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'cloudbake');
  assert.match(init.result.instructions, /one test frame/);
  const newer = await mcp.ask('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(newer.result.protocolVersion, '2025-11-25');
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await mcp.ask('tools/list', {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['render', 'convert', 'status', 'download', 'cancel', 'whoami']);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description && tool.title && tool.annotations, tool.name);
    assert.equal(tool.run, undefined);
  }
  assert.deepEqual((await mcp.ask('ping', {})).result, {});
  assert.equal((await mcp.ask('resources/list', {})).error.code, -32601);
  assert.equal((await mcp.ask('tools/call', { name: 'bake', arguments: {} })).error.code, -32602);
  await mcp.close();
});

test('whoami names the account and the key', async () => {
  const mcp = connect();
  const answer = await mcp.tool('whoami');
  assert.equal(answer.isError, undefined);
  assert.match(answer.text, /"Claude Code" \(ending 4567\) of ana@studio.com/);
  await mcp.close();
});

test('render a file: it is sent whole, the job starts on it, status follows it to done, download saves the frames', async () => {
  const mcp = connect();
  const puts = fake.state.puts.length;
  const started = await mcp.tool('render', { file: 'scene.blend', frames: '1-3', samples: 16 });
  assert.equal(started.isError, undefined, started.text);
  const job = jobOf(started.text);
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.frames, { total: 3, done: 0 });
  assert.match(started.text, /upload up_[0-9a-f]{16}/);

  const put = fake.state.puts.at(-1);
  assert.equal(fake.state.puts.length, puts + 1);
  assert.equal(put.bytes, BLEND.length);
  assert.equal(put.head, 'BLENDER');
  const created = fake.state.calls.findLast((call) => call.path === '/v1/jobs');
  assert.deepEqual(created.body, { upload: job.upload, frames: '1-3', samples: 16 });
  assert.match(created.idempotencyKey, /^[0-9a-f-]{36}$/);
  const uploaded = fake.state.calls.findLast((call) => call.path === '/v1/uploads');
  assert.deepEqual(uploaded.body, { name: 'scene.blend', bytes: BLEND.length });

  const early = await mcp.tool('download', { job: job.id });
  assert.match(early.text, /has not ended yet/);

  const followed = await mcp.tool('status', { job: job.id, wait: true }, { progressToken: 'p1' });
  assert.match(followed.text, /is done: 3 of 3 frames/);
  assert.ok(mcp.notes.some((note) => note.method === 'notifications/progress' && note.params.progressToken === 'p1'), 'progress was told');

  const saved = await mcp.tool('download', { job: job.id, folder: 'out/frames' });
  assert.match(saved.text, /Saved 3 files/);
  const names = (await readdir(join(project, 'out/frames'))).sort();
  assert.deepEqual(names, ['frame_00001.png', 'frame_00002.png', 'frame_00003.png']);
  assert.deepEqual(await readFile(join(project, 'out/frames/frame_00002.png')), PNG);

  const zipped = await mcp.tool('download', { job: job.id, zip: true });
  assert.match(zipped.text, /Saved 1 file of/);
  assert.deepEqual(await readdir(join(project, 'renders', job.id)), ['frames.zip']);

  // The same file again, by its upload, sends nothing.
  const again = await mcp.tool('render', { upload: job.upload, frames: 7 });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(fake.state.puts.length, puts + 1);
  await mcp.close();
});

test('render refuses, before sending anything, what cannot be right', async () => {
  const mcp = connect();
  const puts = fake.state.puts.length;
  const calls = fake.state.calls.length;
  const cases = [
    [{ file: 'scene.blend' }, /Say which frames/],
    [{ file: 'missing.blend', frames: 1 }, /There is no file at .*missing\.blend/],
    [{ file: 'notes.txt', frames: 1 }, /is not a \.blend file/],
    [{ file: '.', frames: 1 }, /is a folder/],
    [{ file: 'scene.blend', sample: true, frames: 1 }, /exactly one of/],
    [{ frames: 1 }, /exactly one of/],
    [{ upload: 'up_nope', frames: 1 }, /upload id like/],
  ];
  for (const [args, said] of cases) {
    const answer = await mcp.tool('render', args);
    assert.equal(answer.isError, true, JSON.stringify(args));
    assert.match(answer.text, said);
  }
  assert.equal((await mcp.tool('status', { job: 'nope' })).isError, true);
  assert.equal(fake.state.puts.length, puts);
  assert.equal(fake.state.calls.length, calls);
  await mcp.close();
});

test('the sample renders without a file', async () => {
  const mcp = connect();
  const started = await mcp.tool('render', { sample: true });
  const job = jobOf(started.text);
  assert.equal(job.scene, 'sample');
  assert.deepEqual(fake.state.calls.findLast((call) => call.path === '/v1/jobs').body, { scene: 'sample' });
  await mcp.close();
});

test('a job that fails says why and what to do; the API\'s refusals come through as they are', async () => {
  const mcp = connect();
  const started = await mcp.tool('render', { file: 'broken.blend', frames: 1 });
  const job = jobOf(started.text);
  const ended = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(ended.text, /failed: The scene has no camera\. Add one .* Change the scene or the request/);

  fake.state.outOfCredit = true;
  const refused = await mcp.tool('render', { sample: true, frames: '1-2' });
  fake.state.outOfCredit = false;
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Your balance is \$0\.00.*\(out_of_credit\)/);

  const unknown = await mcp.tool('status', { job: 'rq_00000000deadbeef' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /job_not_found/);
  await mcp.close();
});

test('convert, then download the converted files', async () => {
  const mcp = connect();
  const started = await mcp.tool('convert', { file: 'scene.blend', formats: ['glb', 'usdz'], draco: true });
  const job = jobOf(started.text);
  assert.deepEqual(fake.state.calls.findLast((call) => call.path === '/v1/jobs').body, { upload: job.upload, kind: 'convert', formats: ['glb', 'usdz'], draco: true });
  assert.match((await mcp.tool('status', { job: job.id, wait: true })).text, /is done: converted to glb, usdz/);
  const saved = await mcp.tool('download', { job: job.id, folder: join(project, 'models') });
  assert.match(saved.text, /Saved 2 files/);
  assert.deepEqual((await readdir(join(project, 'models'))).sort(), ['scene.glb', 'scene.usdz']);
  await mcp.close();
});

test('cancel stops a job, and says so when it had ended', async () => {
  const mcp = connect();
  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-24' })).text);
  assert.match((await mcp.tool('cancel', { job: job.id })).text, /Asked CloudBake to cancel/);
  assert.match((await mcp.tool('cancel', { job: job.id })).text, /had ended already \(cancelled\)/);
  await mcp.close();
});

test('a job still going after the wait says to call again', async () => {
  const mcp = connect({ CLOUDBAKE_WAIT_SECONDS: '0.05', CLOUDBAKE_POLL_MS: '20' });
  const job = jobOf((await mcp.tool('render', { sample: true, frames: '1-24' })).text);
  const answer = await mcp.tool('status', { job: job.id, wait: true });
  assert.match(answer.text, /Still (checking|rendering) after .* call status with wait again/);
  await mcp.close();
});

test('the key: the plugin\'s comes first, the shell\'s is used when the plugin has none, and none is ever printed', async () => {
  const calls = fake.state.calls.length;
  // No key anywhere: a sentence that says where to make one, and nothing is sent.
  let mcp = connect({ CLOUDBAKE_API_KEY: '' });
  let answer = await mcp.tool('whoami');
  assert.equal(answer.isError, true);
  assert.match(answer.text, /No CloudBake API key is set\. Make one at https:\/\/cloudbake\.ai\/app\/connections.*\/plugin configure cloudbake@cloudbake/);
  await mcp.close();
  assert.equal(fake.state.calls.length, calls);

  // The placeholder Claude Code leaves when the plugin's key is unset: the shell's key is used.
  mcp = connect({ CLOUDBAKE_PLUGIN_KEY: '${user_config.api_key}' });
  assert.equal((await mcp.tool('whoami')).isError, undefined);
  await mcp.close();

  // The plugin's key wins over the shell's.
  mcp = connect({ CLOUDBAKE_PLUGIN_KEY: FAKE_KEY, CLOUDBAKE_API_KEY: `cb_live_${'f'.repeat(40)}` });
  assert.equal((await mcp.tool('whoami')).isError, undefined);
  assert.equal(fake.state.calls.at(-1).auth, `Bearer ${FAKE_KEY}`);
  await mcp.tool('render', { file: 'scene.blend', frames: 1 });
  const output = mcp.output();
  await mcp.close();
  assert.ok(!output.includes(FAKE_KEY.slice(8)), 'the key is never in what the server writes');

  // A key of the wrong shape is refused before it is sent.
  mcp = connect({ CLOUDBAKE_API_KEY: 'sk-not-ours' });
  answer = await mcp.tool('whoami');
  assert.match(answer.text, /does not look like one/);
  assert.ok(!mcp.output().includes('sk-not-ours'));
  await mcp.close();

  // A wrong key: the API's 401 sentence.
  mcp = connect({ CLOUDBAKE_API_KEY: `cb_live_${'a'.repeat(40)}` });
  answer = await mcp.tool('whoami');
  assert.match(answer.text, /This API key does not work.*\(api_key_invalid\)/);
  assert.ok(!mcp.output().includes('a'.repeat(40)));
  await mcp.close();
});
