let library = { songs: [], lists: [] };
let selectedList = null;
let editingId = null;
let selectedSongs = new Set();
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
  document.querySelectorAll('[name=rounds]').forEach(input => { input.disabled = !count; });
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
  renderPicker(); show('s-library');
}
function renderPicker() {
  const query = $('song-search').value.toLocaleLowerCase('fr');
  $('song-picker').replaceChildren();
  const songs = library.songs.filter(s => (s.title + ' ' + s.film).toLocaleLowerCase('fr').includes(query) && (!$('selected-only').checked || selectedSongs.has(s.id)));
  songs.forEach(song => {
    const label = node('label', 'song-option', '');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedSongs.has(song.id);
    input.onchange = () => { input.checked ? selectedSongs.add(song.id) : selectedSongs.delete(song.id); updateCount(); if ($('selected-only').checked) renderPicker(); };
    const text = node('span', '', song.title); text.append(node('small', '', song.film)); const memberships = library.lists.filter(l => l.songIds.includes(song.id)); if (memberships.length) text.append(node('small', 'membership-tags', memberships.map(l => l.name).join(' · ')));  label.append(input, text); $('song-picker').append(label);
  });
  if (!songs.length) $('song-picker').append(node('p', 'empty', 'Aucune chanson trouvée.'));
  updateCount();
}
function updateCount() { $('selected-count').textContent = selectedSongs.size + ' sélectionnée' + (selectedSongs.size > 1 ? 's' : ''); }
$('song-search').oninput = renderPicker;
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
$('create-room').onclick = () => {
  if (!socket.connected || creatingRoom) return;
  creatingRoom = true; $('create-room').disabled = true; $('create-room').textContent = 'Création du salon…';
  socket.emit('host:create', { listId: selectedList.id, rounds: Number(document.querySelector('[name=rounds]:checked').value) });
};
socket.on('host:created', ({ code, rounds, joinUrl, qr }) => {
  creatingRoom = false; $('create-room').textContent = 'Créer le salon →'; $('code').textContent = code; $('players').replaceChildren(); $('start').disabled = true;
  if (qr) $('qr').src = qr;
  $('join-url').textContent = joinUrl || '';
  $('lobby-msg').textContent = 'En attente des joueurs…';
  $('lobby-style').textContent = selectedList.name + ' · ' + rounds + ' manches';
  show('s-lobby');
});
socket.on('host:error', message => { $('create-room').textContent = 'Créer le salon →'; creatingRoom = false; $('create-room').disabled = false; notify(message); });
$('leave-room').onclick = () => { socket.emit('host:leave'); show('s-menu'); };
function connectionState() {
  $('connection').textContent = socket.connected ? 'Connecté' : 'Connexion interrompue';
  $('create-room').disabled = !socket.connected || !selectedList?.songIds.length;
}
socket.on('connect', connectionState);
socket.on('disconnect', () => { creatingRoom = false; audio.pause(); connectionState(); show('s-menu'); notify('Connexion interrompue. Le salon a été fermé ; vous pourrez en recréer un après reconnexion.'); });
connectionState(); loadLibrary();
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
$('selected-only').onchange = renderPicker;
$('select-visible').onclick = () => { const query = $('song-search').value.toLocaleLowerCase('fr'); library.songs.filter(s => (s.title+' '+s.film).toLocaleLowerCase('fr').includes(query)).forEach(s => selectedSongs.add(s.id)); renderPicker(); };
$('clear-selection').onclick = () => { selectedSongs.clear(); renderPicker(); };
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Le plein écran est indisponible dans ce navigateur.'); } };
document.addEventListener('fullscreenchange', () => $('fullscreen').setAttribute('aria-label',document.fullscreenElement ? 'Quitter le plein écran' : 'Passer en plein écran'));

function updateRounds() {
 const count = selectedList?.songIds.length || 0;
 const rounds = Number(document.querySelector('[name=rounds]:checked').value);
 $('detail-count').textContent = count + ' chansons · ' + Math.min(rounds,count) + ' manches';
}
document.querySelectorAll('[name=rounds]').forEach(input => input.addEventListener('change',updateRounds));

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

