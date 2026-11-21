// Start-up and shutdown: close(), the main-module guard, and running the server as a process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, startTestServer, connect, pair, readyBoth } from './harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = file => JSON.stringify(pathToFileURL(path.join(ROOT, file)).href);

// Runs node; resolves with {code, signal, stdout, stderr, timedOut, ms}. Kills the child after limitMs.
function runNode(args, { limitMs = 15000, env = {}, onStdout } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { stdout += d; if (onStdout) onStdout(stdout, child); });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, limitMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
  });
}

test('close(): every socket is told and closed, the port is released, a second close() is the same promise', async () => {
  const s = await startTestServer({ graceMs: 60000 });
  const { a, b } = await pair(s);
  await readyBoth(a, b, 'start');
  const idle = await connect(s.wsUrl);
  const lost = await pair(s);
  await lost.a.terminate();              // a seat in its grace period: a pending 60 s timer
  await lost.b.next('peer');

  const first = s.close(), second = s.game.close();
  assert.equal(first, second);
  await first;
  for (const c of [a, b, idle, lost.b]) {
    assert.equal((await c.closed).code, 1001);
    assert.deepEqual(c.msgs.at(-1), { t: 'error', code: 'shutdown', msg: 'The server is restarting. Reload in a minute.' });
  }
  assert.deepEqual(s.game.stats(), { rooms: 0, connections: 0 });
  await assert.rejects(connect(s.wsUrl));
  await assert.rejects(fetch(`${s.httpUrl}/healthz`));
  await s.game.close();
});

test('close() works on a server that never listened', async () => {
  const { createGameServer } = await import('../server.js');
  const game = createGameServer({ log: () => {} });
  assert.equal(game.httpServer.listening, false);
  await game.close();
});

test('after close() nothing keeps the event loop alive (the process ends by itself)', async () => {
  // Production-length timers everywhere: if close() left any of them running, the child would hang.
  const script = `
    import { startTestServer, connect, pair, readyBoth } from ${url('test/harness.mjs')};
    const s = await startTestServer({ betweenMs: 3500, resolveDelayMs: 1200, graceMs: 60000, resumeDelayMs: 1500,
      hurryMs: 90000, heartbeatMs: 25000, idleRoomMs: 2700000, tickMs: 50, stepsPerTick: 1 });
    const battle = await pair(s);
    await readyBoth(battle.a, battle.b, 'start');                       // a running battle
    const hurry = await pair(s, 'campaign');
    await readyBoth(hurry.a, hurry.b, 'camp');
    hurry.a.send({ t: 'endturn' });                                     // a hurry-up timer
    await hurry.b.next(m => m.t === 'camp' && m.deadline);
    const resolving = await pair(s, 'campaign');
    await readyBoth(resolving.a, resolving.b, 'camp');
    resolving.a.send({ t: 'endturn' }); resolving.b.send({ t: 'endturn' });
    await resolving.a.next(m => m.t === 'camp' && m.phase === 'resolving');   // a resolve-delay timer
    const away = await pair(s);
    await away.a.terminate();                                           // a grace timer
    await away.b.next('peer');
    const back = await connect(s.wsUrl);
    back.send({ t: 'rejoin', code: away.code, token: away.roomA.token });   // a resume timer
    await back.next('room');
    const gone = await pair(s);
    await gone.b.terminate();                                           // another grace timer, left pending
    await gone.a.next('peer');
    await s.close();
    console.log('closed');
  `;
  const run = await runNode(['--input-type=module', '-e', script]);
  assert.equal(run.timedOut, false, `the child had to be killed; stderr: ${run.stderr}`);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'closed');
  assert.ok(run.ms < 10000);
});

test('importing server.js starts nothing', async () => {
  const script = `const m = await import(${url('server.js')}); console.log(typeof m.createGameServer);`;
  const run = await runNode(['--input-type=module', '-e', script]);
  assert.equal(run.timedOut, false, 'the import alone kept the process alive');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'function', 'no listening line, no other output');
});

// Fixed ports from the range reserved for tests; another suite running at the same moment may hold
// one, so a start that fails with EADDRINUSE is retried on another port.
async function withFreePort(start) {
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = 4520 + ((process.pid + attempt * 7) % 40);
    result = { port, ...(await start(port)) };
    if (!/EADDRINUSE/.test(result.run.stderr)) break;
  }
  return result;
}

// Starts `node server.js`, talks to it once the first log line is out, then asks it to stop.
async function runServerProcess(port) {
  let checks = null;
  const run = await runNode(['server.js'], {
    env: { PORT: String(port), RENDER: '' },
    onStdout(out, child) {
      if (checks || !out.includes('\n')) return;
      checks = (async () => {
        const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
        const c = await connect(`ws://127.0.0.1:${port}`);
        c.send({ t: 'practice', name: 'Proc' });
        const room = await c.next('room');
        child.kill('SIGTERM');   // on Windows this ends the process outright, without the handler
        const closed = await c.closed;
        return { health, room, closed, last: c.msgs.at(-1) };
      })().catch(err => { child.kill(); return { err }; });
    },
  });
  return { run, checks };
}

test('node server.js: listens on PORT, logs the v1 line and serves', async () => {
  const { port, run, checks } = await withFreePort(runServerProcess);
  assert.equal(run.timedOut, false, `no start-up line; stderr: ${run.stderr}`);
  assert.equal(run.stdout.split(/\r?\n/)[0], `Legio Online listening on http://localhost:${port}`);
  const seen = await checks;
  assert.ifError(seen.err);
  assert.equal(seen.health, 'ok');
  assert.equal(seen.room.players.length, 2);
  if (process.platform !== 'win32') {
    assert.equal(run.code, 0, 'a clean exit after SIGTERM');
    assert.ok(run.ms < 5000, 'well inside the 3 s shutdown deadline');
    assert.equal(seen.closed.code, 1001);
    assert.equal(seen.last.code, 'shutdown');
  }
});

test('SIGTERM handler: clients are told about the restart and the process exits 0 inside 3 s', async () => {
  // The signal is emitted inside the child, so the handler is also exercised on Windows, where
  // kill() cannot deliver SIGTERM. Exit code 9 = the process ended without the client being told.
  const script = port => `
    process.env.PORT = '${port}';
    process.env.RENDER = '';
    process.argv[1] = ${JSON.stringify(path.join(ROOT, 'server.js'))};
    await import(${url('server.js')});                        // now the main module: it starts listening
    const { connect } = await import(${url('test/harness.mjs')});
    let c = null;
    process.on('exit', () => { if (!c || !c.msgs.some(m => m.code === 'shutdown')) process.exitCode = 9; });
    for (let i = 0; !c; i++) {
      try { c = await connect('ws://127.0.0.1:${port}'); } catch (err) {
        if (i > 40) throw err;
        await new Promise(r => setTimeout(r, 50));
      }
    }
    c.send({ t: 'practice', name: 'Proc' });
    await c.next('room');
    process.emit('SIGTERM');
  `;
  const { port, run } = await withFreePort(async p => ({ run: await runNode(['--input-type=module', '-e', script(p)]) }));
  assert.equal(run.timedOut, false, `the process did not stop by itself; stderr: ${run.stderr}`);
  assert.equal(run.code, 0, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.ok(run.ms < 3000, `took ${run.ms} ms`);
  assert.match(run.stdout, new RegExp(`Legio Online listening on http://localhost:${port}`));
});

// Source for a child process in which server.js is the main module (so it starts listening),
// followed by `body`, which may use `c` (a connected client), `connect` and `wsUrl`.
// The child ends by emitting SIGTERM to itself.
const mainScript = (port, env, body) => `
  Object.assign(process.env, ${JSON.stringify({ RENDER: '', TRUST_PROXY: '', ...env, PORT: String(port) })});
  process.argv[1] = ${JSON.stringify(path.join(ROOT, 'server.js'))};
  await import(${url('server.js')});
  const { connect } = await import(${url('test/harness.mjs')});
  const wsUrl = 'ws://127.0.0.1:${port}';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let c = null;
  for (let i = 0; !c; i++) {
    try { c = await connect(wsUrl); } catch (err) {
      if (i > 40) { console.error(err); process.exit(7); }
      await wait(50);
    }
  }
  ${body}
  process.emit('SIGTERM');
`;
const runMain = (env, body) => withFreePort(async p => ({ run: await runNode(['--input-type=module', '-e', mainScript(p, env, body)]) }));

test('run directly: an uncaught exception and an unhandled rejection are logged and the server keeps serving', async () => {
  const { run } = await runMain({}, `
    setTimeout(() => { throw new Error('boom-uncaught'); }, 0);
    Promise.reject(new Error('boom-rejected'));
    await wait(150);
    c.send({ t: 'practice', name: 'Proc' });
    const room = await c.next('room');
    const health = await (await fetch('http://127.0.0.1:' + process.env.PORT + '/healthz')).text();
    console.log('still serving: ' + health + ' ' + room.players.length);
  `);
  assert.equal(run.timedOut, false, `stderr: ${run.stderr}`);
  assert.equal(run.code, 0, `the process died; stderr: ${run.stderr}`);
  assert.match(run.stdout, /still serving: ok 2/);
  assert.match(run.stderr, /uncaught exception[^]*boom-uncaught/);
  assert.match(run.stderr, /unhandled rejection[^]*boom-rejected/);
});

test('run directly: on Render the first X-Forwarded-For hop is the client; TRUST_PROXY overrides that', async () => {
  // 21 connections, each claiming another client address in front of one shared last hop.
  // The default limit is 20 per address, so the number accepted shows which address was believed.
  const body = `
    await c.close();
    await wait(100);
    const all = [];
    for (let i = 1; i <= 21; i++) all.push(await connect(wsUrl, { headers: { 'X-Forwarded-For': '203.0.113.' + i + ', 198.51.100.7' } }));
    let accepted = 0;
    for (const x of all) {
      try { x.send({ t: 'ping' }); } catch { /* already closed */ }
      accepted += await x.next('pong').then(() => 1, () => 0);
    }
    console.log('accepted ' + accepted);
  `;
  const accepted = async env => {
    const { run } = await runMain(env, body);
    assert.equal(run.code, 0, `${JSON.stringify(env)} stderr: ${run.stderr}`);
    return Number((/accepted (\d+)/.exec(run.stdout) || [])[1]);
  };
  assert.equal(await accepted({}), 20, 'not behind a proxy: the header is ignored, all share the socket address');
  assert.equal(await accepted({ RENDER: 'true' }), 21, 'on Render: the first hop');
  assert.equal(await accepted({ RENDER: 'true', TRUST_PROXY: 'false' }), 20, 'switched off');
  assert.equal(await accepted({ TRUST_PROXY: '1' }), 20, 'one trusted proxy: the last hop, which a client cannot forge');
  assert.equal(await accepted({ TRUST_PROXY: '2' }), 21, 'two trusted proxies: the hop before the last');
});
