// Chrome and real Socket.IO over a local IPC socket, with an isolated two-song program.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Agent, Server, request } from 'node:http';
import { connect } from 'node:net';
import { on, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mock } from 'node:test';
import { chromium } from 'playwright-core';
import { io } from 'socket.io-client';

const fixture = await mkdtemp(join(tmpdir(), 'dtforget-'));
const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\dtforget-' + randomUUID() : join(fixture, 'game.sock');
const base = 'http://dtforget.test';
const agent = new Agent({ keepAlive: true });
agent.createConnection = (_options, callback) => {
  const open = (retries) => {
    const socket = connect(pipe);
    const fail = async (error) => {
      if (!retries || !['ENOENT', 'EBUSY'].includes(error.code)) return callback(error);
      await delay(30 + Math.random() * 40);
      open(retries - 1);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      callback(null, socket);
    });
  };
  open(30);
};
const clients = [];
let server;
let browser;

function relay(browserRequest) {
  const url = new URL(browserRequest.url());
  const headers = browserRequest.headers();
  delete headers['accept-encoding'];
  return new Promise((resolve, reject) => {
    const upstream = request({ agent, method: browserRequest.method(), path: url.pathname + url.search, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.end(browserRequest.postDataBuffer());
  });
}

async function page(mobile = false) {
  const context = await browser.newContext({
    isMobile: mobile, hasTouch: mobile,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 900 },
  });
  await context.route(base + '/**', async (route) => {
    try { await route.fulfill(await relay(route.request())); }
    catch { await route.abort().catch(() => {}); }
  });
  await context.routeWebSocket('**/socket.io/**', (ws) => ws.close());
  const tab = await context.newPage();
  tab.setDefaultTimeout(9000);
  return tab;
}

function openClient(transport = 'websocket') {
  const socket = io(base, { transports: [transport], agent, forceNew: true, reconnection: false });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const call = (socket, event, body) => socket.timeout(3000).emitWithAck(event, body);
const visible = (p, selector) => p.waitForSelector(selector, { state: 'visible', timeout: 9000 });

async function joinPhone(p, code, name) {
  await p.goto(base + '/play.html?code=' + code);
  await p.fill('#name', name);
  await p.click('#join-btn');
}

try {
  const hz = 8000;
  const audio = Buffer.alloc(44 + 2 * hz * 12);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(hz, 24);
  audio.writeUInt32LE(hz * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  await mkdir(join(fixture, 'clips'));
  await writeFile(join(fixture, 'clips', 'test.wav'), audio);
  const songs = ['Premier', 'Second'].map(title => ({
    title, film: 'Test', audio: '/media/test.wav', cutAt: 3, bedEnd: 4, revealAt: 5,
    answer: 'le refrain', words: [{ x: 'Écoute', t: 0.1, e: 2 }, { x: 'le refrain', t: 3, e: 4, gap: true }],
  }));
  await writeFile(join(fixture, 'content.json'), JSON.stringify(songs));
  await writeFile(join(fixture, 'lists.json'), JSON.stringify([{
    id: 'disney', name: 'Disney', theme: 'magic', songIds: songs.map(song => JSON.stringify([song.film, song.title])),
  }]));
  Object.assign(process.env, { DATA_DIR: fixture, LISTS_FILE: join(fixture, 'lists.json'), ATELIER: 'off', INTRO_MS: '650', PUBLIC_URL: '', HOST_GRACE_MS: '12000', PLAYER_GRACE_MS: '2500' });
  const listen = Server.prototype.listen;
  const listener = mock.method(Server.prototype, 'listen', function (_port, _host, callback) {
    server = this;
    return listen.call(this, pipe, callback);
  });
  try {
    await import('../server.js');
  } finally {
    listener.mock.restore();
  }

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const [host, first, late, remote] = await Promise.all([page(), page(true), page(true), page(true)]);
  const pageErrors = [];
  for (const tab of [host, first, late, remote]) tab.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.error(error.message);
  });
  await host.goto(base + '/host.html');
  await host.locator('button.style-card', { hasText: 'Disney' }).click();
  await host.click('#explore-universe');
  await host.click('#create-room');
  await visible(host, '#s-lobby');
  const code = await host.textContent('#code');
  assert.match(code, /^[A-Z]{4}$/);
  assert.equal(await host.textContent('#join-url'), base + '/play.html?code=' + code);
  await joinPhone(first, code.toLowerCase(), 'Camille');
  await visible(first, '#v-wait');
  await remote.goto(base + '/remote.html?code=' + code);
  await visible(remote, '#v-remote');
  const other = await openClient('polling');
  const identity = { code: ' ' + code.toLowerCase() + ' ', name: 'Attente', token: randomUUID() };
  await remote.click('#action');
  await visible(host, '#s-play');
  const seat = await call(other, 'player:join', identity);
  assert.equal(seat.state, 'playing');
  await host.click('#live-join summary');
  await visible(host, '#live-qr');
  assert.equal(await host.getAttribute('#live-link', 'href'), base + '/play.html?code=' + code);
  console.log('OK salon, accès via QR en cours de manche et lancement via télécommande');

  await visible(first, '#v-answer');
  const retried = await call(other, 'player:join', identity);
  assert.equal(retried.state, 'answering');
  assert.equal(retried.token, seat.token);
  assert.equal((await call(other, 'player:join', null)).ok, false);
  await joinPhone(late, code, 'Camille');
  await visible(late, '#v-answer');
  await first.fill('#answer', 'le refrain');
  await first.reload();
  await visible(first, '#v-answer');
  assert.equal(await first.inputValue('#answer'), 'le refrain');
  await first.click('#answer-btn');
  await visible(first, '#ans-status');
  await host.waitForFunction(() => document.getElementById('answers').textContent.startsWith('1'));

  let dropped = false;
  await late.route('**/socket.io/**', async (route) => {
    if (!dropped && route.request().postData()?.includes('"player:answer"')) {
      dropped = true;
      await route.abort();
    } else {
      await route.fallback();
    }
  });
  await late.fill('#answer', 'un autre mot');
  await late.click('#answer-btn');
  await visible(late, '#ans-status');
  assert.ok(dropped, 'première tentative de réponse perdue pendant la coupure');
  await host.reload();
  await visible(host, '#s-play');
  assert.equal(await host.textContent('#code'), code);
  assert.match(await host.textContent('#answers'), /^2 /);
  await first.reload();
  await visible(first, '#ans-status');
  assert.ok(await first.isDisabled('#answer-btn'));
  console.log('OK retardataire pendant les réponses, brouillon conservé, réponse renvoyée et retour hôte avec le bon compteur');

  const audience = await Promise.all(Array.from({ length: 32 }, (_, i) => openClient(i % 2 ? 'polling' : 'websocket')));
  const joined = await Promise.all(audience.map((socket, i) => call(socket, 'player:join', { code, name: 'Joueur ' + i })));
  assert.ok(joined.every(s => s.state === 'answering'));
  assert.equal(new Set(joined.map(s => s.token)).size, 32);
  const replaced = await openClient();
  assert.equal((await call(replaced, 'player:resume', { code, token: seat.token })).ok, true);
  assert.equal((await call(other, 'player:answer', { round: 1, text: 'fausse réponse' })).ok, false);
  assert.equal((await call(replaced, 'player:answer', { round: 2, text: 'fausse réponse' })).ok, false);
  assert.equal((await call(replaced, 'player:answer', { round: 1, text: 'le refrain' })).ok, true);
  assert.equal((await call(replaced, 'player:answer', { round: 1, text: 'fausse réponse' })).ok, true);
  await remote.reload();
  await visible(remote, '#v-remote');
  assert.equal(await remote.textContent('#players'), '35');
  await remote.click('#action');
  await visible(host, '#s-reveal');
  await Promise.all([first.reload(), late.reload()]);
  await Promise.all([visible(first, '#v-result'), visible(late, '#v-result')]);
  assert.equal(await first.textContent('#res-pts'), '+2');
  assert.equal(await late.textContent('#res-pts'), '+0');
  const afterReveal = await openClient();
  const fresh = await call(afterReveal, 'player:join', { code, name: 'Dernier' });
  assert.equal(fresh.result.points, 0);
  assert.equal((await call(replaced, 'player:resume', { code, token: seat.token })).result.points, 2);
  console.log('OK 32 arrivées simultanées mixtes, reprise par jeton, réponses uniques et résultats de deux pseudos identiques');

  await host.click('#next');
  await visible(host, '#s-play');
  await visible(first, '#v-answer');
  await remote.click('#action');
  await visible(host, '#s-reveal');
  await host.click('#next');
  await visible(host, '#s-over');
  await first.reload();
  await visible(first, '#v-over');
  assert.equal(await first.textContent('#over-pts'), '2 pts');
  assert.equal((await call(other, 'player:join', { code, name: 'Après la fin' })).ok, false);
  await host.click('#again');
  await visible(first, '#v-join');
  await visible(remote, '#v-join');
  assert.equal((await call(replaced, 'player:resume', { code, token: seat.token })).ok, false);

  await host.click('#explore-universe');
  await host.click('#create-room');
  await visible(host, '#s-lobby');
  const nextCode = await host.textContent('#code');
  await first.fill('#code', nextCode);
  await first.click('#join-btn');
  await visible(first, '#v-wait');
  await first.reload();
  await visible(first, '#v-wait');
  assert.equal(await first.textContent('#wait-code'), nextCode);
  await host.click('#leave-room');
  await visible(first, '#v-join');
  assert.deepEqual(pageErrors, []);
  console.log('OK score final après rechargement, fermeture et entrée dans le salon suivant');

  const secondHost = await openClient();
  const secondRoom = await call(secondHost, 'host:create', { rounds: 1, answerSeconds: 20, token: randomUUID() });
  const secondRemote = await openClient();
  const online = await openClient();
  const disconnected = await openClient();
  const secondCode = secondRoom.code;
  await call(online, 'player:join', { code: secondCode, name: 'En ligne' });
  await call(disconnected, 'player:join', { code: secondCode, name: 'Déconnecté' });
  await call(secondRemote, 'remote:join', { code: secondRoom.code });
  const answerOpen = once(online, 'answer:open', { signal: AbortSignal.timeout(9000) });
  secondHost.emit('host:start');
  await answerOpen;
  const remoteStates = on(secondRemote, 'remote:state', { signal: AbortSignal.timeout(9000) });
  disconnected.close();
  for await (const [remoteView] of remoteStates) {
    if (remoteView.connected !== 1) continue;
    assert.equal(remoteView.players, 2);
    break;
  }
  const reveal = once(secondHost, 'reveal', { signal: AbortSignal.timeout(9000) });
  assert.equal((await call(online, 'player:answer', { round: 1, text: 'le refrain' })).ok, true);
  assert.equal((await call(secondRemote, 'remote:join', { code: secondRoom.code })).state.state, 'answering');
  await reveal;
  assert.equal((await call(secondHost, 'host:leave')).ok, true);
  console.log('OK délai de retour pour un joueur déconnecté, puis révélation automatique');
} finally {
  for (const socket of clients) socket.close();
  await browser?.close();
  agent.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(fixture, { recursive: true, force: true });
}
