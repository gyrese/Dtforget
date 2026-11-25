let library = { songs: [], lists: [] };
let selectedList = null;
let editingId = null;
let selectedSongs = new Set();
let pickerPage = 0;
let creatingRoom = false;
let draftCover = "";
let coverRevision = 0;
function coverSource(theme, image) { return image || "/assets/record-" + ({magic:"magic",rock:"rock",mix:"mix"}[theme] || "mix") + ".svg"; }
function art(theme, image) {
  const el = document.createElement('div');
  el.className = 'art ' + theme;
  const img = document.createElement('img');
  img.src = coverSource(theme, image);
  img.alt = ''; img.className = 'universe-illustration';
  el.append(img); return el;
}
function node(tag, cls, text) {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
}
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; }
async function loadLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error('La bibliothèque est indisponible. Rechargez la page pour réessayer.');
    library = await res.json(); renderStyles();
  } catch (error) { notify(error.message); }
}
function renderStyles() {
  $('styles').replaceChildren();
  $('library-count').textContent = library.lists.length + ' UNIVERS · ' + library.songs.length + ' CHANSONS';
  library.lists.forEach((list) => {
    const card = node('button', 'style-card', ''); card.type = 'button';
    card.setAttribute('aria-label', list.name + ', ' + list.songIds.length + ' chansons');
    const copy = node('div', 'card-copy', '');
    copy.append(node('h2', '', list.name));
    const bottom = node('div', 'card-bottom', '');
    bottom.append(node('span', '', list.songIds.length + ' chansons'), node('span', 'card-arrow', '↗'));
    copy.append(bottom);
    card.append(art(list.theme, list.coverImage), copy);
    card.dataset.listId = list.id;
    card.onclick = () => selectUniverse(list.id);
    $('styles').append(card);
  });
  selectUniverse(selectedList?.id || library.lists[0]?.id);
  document.dispatchEvent(new CustomEvent('host:library-rendered'));
}
function openDetail(id) {
  selectedList = library.lists.find(l => l.id === id);
  if (!selectedList) return;
  $('notice').hidden = true;
  $('detail-cover').replaceChildren(art(selectedList.theme, selectedList.coverImage));
  $('detail-name').textContent = selectedList.name;
  $('detail-description').textContent = selectedList.description;
  const count = selectedList.songIds.length;
  document.querySelectorAll('[name=rounds], #rounds-custom').forEach(input => { input.disabled = !count; });
  $('rounds-custom').max = Math.max(1, count);
  updateRounds();
  $('create-room').disabled = !count || !socket.connected;
  $('detail-hint').textContent = count ? '' : 'Ajoutez des chansons pour jouer.';
  $('detail-songs').replaceChildren();
  library.songs.filter(s => selectedList.songIds.includes(s.id)).forEach(s => {
    const tile = node('div', 'song-tile', s.title); tile.append(node('small', '', s.film)); $('detail-songs').append(tile);
  });
  show('s-detail');
}
function openEditor(id) {
  editingId = id;
  coverRevision++;
  $("save-list").disabled = false;
  const list = library.lists.find(l => l.id === id);
  selectedSongs = new Set(list?.songIds || []);
  $('list-name').value = list?.name || '';
  $('list-description').value = list?.description || '';
  $('list-theme').value = list?.theme || 'mix';
  draftCover = list?.coverImage || ''; $('list-cover').value = ''; $('cover-status').textContent = ''; updateCoverPreview();
  $('song-search').value = ''; $('selected-only').checked = false; $('save-status').textContent = '';
  $('list-nav').replaceChildren();
  library.lists.forEach(l => {
    const b = node('button', 'quiet', l.name + ' · ' + l.songIds.length); b.setAttribute('aria-current', String(l.id === id)); b.onclick = () => openEditor(l.id); $('list-nav').append(b);
  });
  resetPickerPage(); show('s-library');
}
function matchingSongs() {
  const query = $('song-search').value;
  const selectedOnly = $('selected-only').checked;
  return library.songs.filter((song) =>
    (!selectedOnly || selectedSongs.has(song.id)) && libraryMatches(query, song.title, song.film));
}
function renderPicker() {
  const songs = matchingSongs().sort((a, b) => libraryCollator.compare(a.title, b.title) || libraryCollator.compare(a.film, b.film));
  const page = libraryPage('song', songs, pickerPage, 12);
  pickerPage = page.current;
  const picker = $('song-picker');
  picker.replaceChildren();
  picker.scrollTop = 0;
  $('song-results').textContent = songs.length ? songs.length + (songs.length === 1 ? ' chanson' : ' chansons') : '';
  $('select-visible').disabled = !songs.some((song) => !selectedSongs.has(song.id));
  page.items.forEach(song => {
    const label = node('label', 'song-option', '');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedSongs.has(song.id);
    input.onchange = () => { input.checked ? selectedSongs.add(song.id) : selectedSongs.delete(song.id); updateCount(); if ($('selected-only').checked) renderPicker();
      else $('select-visible').disabled = !songs.some((song) => !selectedSongs.has(song.id)); };
    const text = node('span', '', song.title); text.append(node('small', '', song.film)); const memberships = library.lists.filter(l => l.songIds.includes(song.id)); if (memberships.length) text.append(node('small', 'membership-tags', memberships.map(l => l.name).join(' · ')));  label.append(input, text);
    const test = node('button', 'quiet test-song', '▶ Tester'); test.type = 'button';
    test.setAttribute('aria-label', 'Tester « ' + song.title + ' » seul, sans salon');
    test.onclick = (event) => { event.preventDefault(); startSoloTest(song); };
    label.append(test); $('song-picker').append(label);
  });
  if (!songs.length) $('song-picker').append(node('p', 'empty', 'Aucune chanson trouvée.'));
  updateCount();
}
function updateCount() { $('selected-count').textContent = selectedSongs.size + ' sélectionnée' + (selectedSongs.size > 1 ? 's' : ''); }
function resetPickerPage() { pickerPage = 0; renderPicker(); }
$('song-search').oninput = resetPickerPage;
$('song-prev').onclick = () => { pickerPage--; renderPicker(); };
$('song-next').onclick = () => { pickerPage++; renderPicker(); };
$('manage').onclick = () => openEditor(library.lists[0]?.id || null);
$('new-list').onclick = () => { openEditor(null); $('list-name').focus(); };
$('edit-list').onclick = () => openEditor(selectedList.id);
document.querySelectorAll('.back-menu').forEach(b => b.onclick = () => { $('notice').hidden = true; show('s-menu'); });
$('list-form').onsubmit = async (event) => {
  event.preventDefault(); $('save-list').disabled = true; $('save-status').textContent = 'Enregistrement…';
  try {
    const response = await fetch(editingId ? '/api/lists/' + encodeURIComponent(editingId) : '/api/lists', {
      method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('list-name').value, description: $('list-description').value, theme: $('list-theme').value, coverImage: draftCover, songIds: [...selectedSongs] }),
    });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Enregistrement impossible.');
    if ((result.coverImage || '') !== draftCover) throw new Error('Le serveur utilise une ancienne version et n’a pas enregistré cette image. Votre aperçu est conservé. Redémarrez le serveur puis réessayez.');
    const index = library.lists.findIndex(l => l.id === result.id);
    if (index < 0) library.lists.push(result); else library.lists[index] = result;
    renderStyles(); openEditor(result.id); $('save-status').textContent = 'Liste enregistrée.';
  } catch (error) { $('save-status').textContent = error.message; }
  finally { $('save-list').disabled = false; }
};
const HOST_SESSION_KEY = 'dtf-host-session';
let hostSession = null;
try { hostSession = JSON.parse(sessionStorage.getItem(HOST_SESSION_KEY) || 'null'); } catch {}
let hostRequest = null;
let hostRetry;

function saveHostSession(value) {
  hostSession = value;
  try {
    if (value) sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(HOST_SESSION_KEY);
  } catch {}
}

function connectionState(message = '') {
  $('connection').textContent = socket.connected && !message ? 'Connecté' : 'Connexion au serveur…';
  $('stage-connection').textContent = message;
  $('stage-connection').hidden = !message;
  creatingRoom = Boolean(hostSession?.pending);
  $('create-room').textContent = creatingRoom ? 'Création du salon…' : 'Créer le salon →';
  $('create-room').disabled = !socket.connected || Boolean(hostSession) || !selectedList?.songIds.length;
  $('leave-room').disabled = !socket.connected || Boolean(message);
  $('again').disabled = !socket.connected || Boolean(message);
  if (message) {
    $('start').disabled = true;
    $('next').disabled = true;
  }
}

function renderRoom(data) {
  if (data.list) roomCover = coverSource(data.list.theme, data.list.coverImage);
  $('code').textContent = data.code;
  $('live-code').textContent = data.code;
  for (const id of ['qr', 'live-qr']) {
    $(id).hidden = !data.qr;
    if (data.qr) $(id).src = data.qr;
  }
  $('join-url').textContent = data.joinUrl;
  $('live-link').href = data.joinUrl;
  $('lobby-style').textContent = (data.list?.name || 'Salon') + ' · ' + data.rounds + ' manches';
  renderPlayers(data.players);
  if (data.state === 'lobby') return show('s-lobby');
  renderIntro(data.intro);
  if (data.clip) renderClip(data.clip);
  if (data.answerWindow) {
    renderAnswerWindow(data.answerWindow);
    renderAnswerCount(data.answers);
  }
  if (data.reveal) renderReveal(data.reveal);
  if (data.final) renderFinal(data.final);
}

function clearHostRoom(message = '') {
  saveHostSession(null);
  hostRequest = null;
  clearTimeout(hostRetry);
  $('live-join').open = false;
  connectionState();
  show('s-menu');
  if (message) notify(message);
}

function syncHost(event = 'host:resume') {
  clearTimeout(hostRetry);
  if (!socket.connected || !hostSession || hostRequest) return;
  const attempt = hostRequest = hostSession;
  connectionState(attempt.leaving ? 'Fermeture du salon…' : attempt.pending ? 'Création du salon…' : 'Reprise du salon…');
  const onResponse = (error, data) => {
    if (hostRequest !== attempt) return;
    hostRequest = null;
    if (!socket.connected) return;
    if (error || data?.retry) {
      hostRetry = setTimeout(syncHost, 1000);
      return;
    }
    if (event === 'host:leave' && data?.ok) return clearHostRoom();
    if (!data?.ok) {
      if (event === 'host:resume' && attempt.pending) return syncHost('host:create');
      if (event === 'host:resume' && attempt.leaving) return clearHostRoom();
      clearHostRoom(data?.error || 'Le salon a expiré. Créez un nouveau salon.');
      return;
    }
    saveHostSession({ token: attempt.token, leaving: attempt.leaving });
    if (attempt.leaving) return syncHost('host:leave');
    connectionState();
    renderRoom(data);
  };
  const request = socket.timeout(GAME_ACK_MS);
  if (event === 'host:leave') request.emit(event, onResponse);
  else request.emit(event, { ...attempt.pending, token: attempt.token }, onResponse);
}

$('create-room').onclick = () => {
  if (!socket.connected || creatingRoom || hostSession) return;
  $('notice').hidden = true;
  saveHostSession({ token: gameToken(), pending: {
    listId: selectedList.id, rounds: roundsWanted(), origin: location.origin,
    answerSeconds: Number(document.querySelector('[name=answer-time]:checked').value),
  } });
  syncHost('host:create');
};
$('leave-room').onclick = $('again').onclick = () => {
  if (!socket.connected || !hostSession || hostRequest) return;
  saveHostSession({ token: hostSession.token, leaving: true });
  syncHost('host:leave');
};
socket.on('connect', () => { connectionState(); syncHost(); });
socket.on('disconnect', () => {
  hostRequest = null;
  clearTimeout(hostRetry);
  audio.pause();
  connectionState('Connexion interrompue. Reconnexion automatique…');
});
socket.on('connect_error', () => connectionState('Serveur inaccessible pour le moment. Nouvel essai automatique…'));
socket.on('host:replaced', () => clearHostRoom('Le salon est ouvert sur un autre écran hôte.'));
reconnectWhenOnline(socket);
connectionState('Connexion au serveur…');
socket.connect();
loadLibrary();
// Navigation de la collection au clavier, comme un menu de console.
$('styles').addEventListener('keydown', event => {
  const cards = [...$('styles').querySelectorAll('.style-card')];
  const index = cards.indexOf(document.activeElement);
  if (index < 0) return;
  let next;
  if (event.key === 'ArrowRight') next = (index + 1) % cards.length;
  if (event.key === 'ArrowLeft') next = (index - 1 + cards.length) % cards.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = cards.length - 1;
  if (next !== undefined) { event.preventDefault(); cards[next].focus(); }
});

function selectUniverse(id) {
  selectedList = library.lists.find(l => l.id === id) || library.lists[0];
  if (!selectedList) return;
  document.querySelector('.hero').dataset.theme = selectedList.theme;
  document.querySelector('.hero-art').src = coverSource(selectedList.theme, selectedList.coverImage);
  $('selected-title').textContent = selectedList.name;
  $('selected-meta').textContent = selectedList.songIds.length + ' chansons';
  document.querySelector('.hero-index').textContent = String(library.lists.indexOf(selectedList)+1).padStart(2,'0') + ' / ' + String(library.lists.length).padStart(2,'0');
  document.querySelectorAll('.style-card').forEach(c => { const selected = c.dataset.listId === selectedList.id; c.classList.toggle('is-selected',selected); c.setAttribute('aria-pressed',String(selected)); });
  $('explore-universe').disabled = false; $('edit-featured').disabled = false;
  document.dispatchEvent(new CustomEvent('host:universe-selected'));
}
$('explore-universe').onclick = () => openDetail(selectedList.id);
$('edit-featured').onclick = () => openEditor(selectedList.id);
$('selected-only').onchange = resetPickerPage;
$('select-visible').onclick = () => { matchingSongs().forEach((song) => selectedSongs.add(song.id)); renderPicker(); };
$('clear-selection').onclick = () => { selectedSongs.clear(); renderPicker(); };
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Le plein écran est indisponible dans ce navigateur.'); } };
document.addEventListener('fullscreenchange', () => $('fullscreen').setAttribute('aria-label',document.fullscreenElement ? 'Quitter le plein écran' : 'Passer en plein écran'));

// 3, 5, 10 manches, ou le nombre qu'on veut (au plus une manche par chanson de la liste)
function roundsWanted() {
 const choice = document.querySelector('[name=rounds]:checked').value;
 return choice === 'custom' ? Math.max(1, Math.round(Number($('rounds-custom').value)) || 1) : Number(choice);
}
function updateRounds() {
 const count = selectedList?.songIds.length || 0;
 $('detail-count').textContent = count + ' chansons · ' + Math.min(roundsWanted(),count) + ' manches';
}
document.querySelectorAll('[name=rounds]').forEach(input => input.addEventListener('change',updateRounds));
// taper un nombre choisit cette option
$('rounds-custom').addEventListener('input', () => { document.querySelector('[name=rounds][value=custom]').checked = true; updateRounds(); });
$('rounds-custom').addEventListener('focus', () => { document.querySelector('[name=rounds][value=custom]').checked = true; updateRounds(); });

function updateCoverPreview() { $('cover-preview').src = coverSource($('list-theme').value,draftCover); $('remove-cover').disabled = !draftCover; }
$('list-theme').addEventListener('change',updateCoverPreview);
$('remove-cover').onclick = () => { coverRevision++; draftCover = ''; $('save-list').disabled = false; $('list-cover').value = ''; $('cover-status').textContent = 'Illustration rétablie. Enregistrez pour appliquer.'; updateCoverPreview(); };
$('list-cover').onchange = async () => {
 const revision = ++coverRevision; const file = $('list-cover').files[0];
 if (!file) { $('save-list').disabled = false; return; }
 if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 15*1024*1024) { $('save-list').disabled = false; $('cover-status').textContent = 'Choisissez un JPG, PNG ou WebP de moins de 15 Mo.'; return; }
 $('save-list').disabled = true; $('cover-status').textContent = 'Préparation de l’image…';
 let bitmap;
 try {
  bitmap = await createImageBitmap(file); if (revision !== coverRevision) return;
  const ratio = Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(bitmap.width*ratio)); canvas.height = Math.max(1,Math.round(bitmap.height*ratio));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#121116'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  let data = canvas.toDataURL('image/jpeg',.82); if(data.length>700000)data=canvas.toDataURL('image/jpeg',.6);
  if(data.length>700000)throw Error('Image trop détaillée. Choisissez une image plus petite.');
  draftCover=data; updateCoverPreview(); $('cover-status').textContent = 'Image prête à enregistrer.';
 } catch(error) { if(revision===coverRevision)$('cover-status').textContent = 'Impossible de préparer cette image. Essayez une autre image.'; }
 finally { bitmap?.close(); if(revision===coverRevision)$('save-list').disabled=false; }
};


// Test d'une chanson seule depuis la bibliothèque : l'écran la joue comme en partie
// (présentation, paroles, coupure, chrono, révélation), sans salon ni joueur.
const SOLO_ANSWER_S = 5;
let soloTest = null;
async function startSoloTest(song) {
  if (soloTest) return;
  if (hostSession) return notify('Fermez le salon en cours avant de tester une chanson.');
  $('notice').hidden = true;
  // le clic autorise la lecture audio sur cette page
  unlockStageAudio()?.catch(() => {});
  audio.play().catch(() => {});
  audio.pause();
  let data;
  try {
    const res = await fetch('/api/test-song?' + new URLSearchParams({ id: song.id }));
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Impossible de tester cette chanson.');
  } catch (error) { return notify(error.message || 'Impossible de tester cette chanson.'); }
  roomCover = coverSource($('list-theme').value, draftCover);
  soloTest = { data, index: 0, timers: [], next: () => playSoloPassage(soloTest.index + 1) };
  $('solo-test').hidden = false;
  document.querySelector('.hint-next').hidden = true; // pas de télécommande sans salon
  playSoloPassage(0);
}
function playSoloPassage(index) {
  const test = soloTest;
  if (!test) return;
  test.timers.forEach(clearTimeout);
  test.timers = [];
  clearInterval(answerTimer);
  const passages = test.data.passages;
  if (index >= passages.length) return stopSoloTest();
  test.index = index;
  const { film, title, answer, clip: c } = passages[index];
  const last = index + 1 >= passages.length;
  const later = (seconds, run) => test.timers.push(setTimeout(() => { if (soloTest === test) run(); }, seconds * 1000));
  renderIntro({ round: index + 1, total: passages.length, film, title });
  // mêmes délais que le serveur pendant une partie : présentation, puis chrono ouvert à la coupure
  later(test.data.introMs / 1000, () => {
    renderClip({ ...c, elapsed: 0 });
    $('bar-msg').textContent = 'Test seul · aucun joueur';
    $('answers').textContent = '';
    const music = Math.max(0, c.bedEnd - c.cutAt);
    later(c.cutAt, () => {
      renderAnswerWindow({ seconds: music + SOLO_ANSWER_S, music, timer: SOLO_ANSWER_S });
      $('answers').textContent = '';
      later(music + SOLO_ANSWER_S, () => {
        renderReveal({ answer, film, title, ranking: [], last, revealAt: c.revealAt });
        $('rev-ranking').replaceChildren(node('div', 'msg', 'Test seul : aucun joueur.'));
        $('next').textContent = last ? 'Fin du test →' : 'Passage suivant →';
      });
    });
  });
}
function stopSoloTest() {
  if (!soloTest) return;
  soloTest.timers.forEach(clearTimeout);
  clearInterval(answerTimer);
  soloTest = null;
  roomCover = null;
  $('solo-test').hidden = true;
  document.querySelector('.hint-next').hidden = false;
  show('s-library'); // la liste en cours de modification reste telle quelle
}
$('replay-test').onclick = () => { if (soloTest) playSoloPassage(soloTest.index); };
$('stop-test').onclick = stopSoloTest;
document.addEventListener('keydown', (event) => { if (soloTest && event.key === 'Escape') stopSoloTest(); });
