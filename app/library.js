import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const songKey = (clip) => JSON.stringify([clip.film, clip.title]);
export function createLibrary(content, file) {
  // recalculé à chaque appel : l'atelier ajoute des extraits pendant que le serveur tourne
  const allSongs = () => [...new Map(content.map(c => [songKey(c), { id: songKey(c), title: c.title, film: c.film }])).values()];
  let lists = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [
    { id: 'disney', name: 'Disney', description: 'Un monde de magie, des refrains inoubliables.', theme: 'magic', songIds: allSongs().map(s => s.id) },
    { id: 'rock', name: 'Rock', description: 'Montez le son. Réveillez la scène.', theme: 'rock', songIds: [] },
    { id: 'custom', name: 'Custom', description: 'Vos chansons. Vos règles. Votre soirée.', theme: 'mix', songIds: [] },
  ];
  const persist = (next) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
    renameSync(file + '.tmp', file);
    lists = next;
  };
  if (!existsSync(file)) persist(lists);
  return {
    get: () => { const songs = allSongs(); return { songs, lists: lists.map(l => ({ ...l, songIds: l.songIds.filter(id => songs.some(s => s.id === id)) })) }; },
    addSong(listId, songId) {
      if (!lists.some(l => l.id === listId)) throw new Error('Cette liste n’existe plus.');
      persist(lists.map(l => l.id === listId && !l.songIds.includes(songId) ? { ...l, songIds: [...l.songIds, songId] } : l));
    },
    clips: id => content.filter(c => lists.find(l => l.id === id)?.songIds.includes(songKey(c))),
    // liste reçue d'un autre serveur (envoi depuis l'atelier) : créée si besoin, puis la chanson y est ajoutée
    importList(src, songId) {
      if (!src || typeof src.id !== 'string' || !/^[\w-]{1,64}$/.test(src.id) || typeof src.name !== 'string' || !src.name.trim()) throw new Error('Liste invalide.');
      const cover = typeof src.coverImage === 'string' && src.coverImage.length <= 700000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(src.coverImage) ? src.coverImage : '';
      const known = lists.find(l => l.id === src.id);
      persist(known
        ? lists.map(l => l.id === src.id ? { ...l, coverImage: l.coverImage || cover, songIds: [...new Set([...l.songIds, songId])] } : l)
        : [...lists, { id: src.id, name: src.name.trim().slice(0, 40), description: String(src.description || '').trim().slice(0, 140), theme: ['magic', 'rock', 'mix'].includes(src.theme) ? src.theme : 'mix', coverImage: cover, songIds: [songId] }]);
    },
    // listes d'une chanson, d'un coup : ajoutée à celles de listIds, retirée des autres.
    // known : listes connues ailleurs (serveur en ligne) à créer ici si besoin.
    setSongLists(songId, listIds, known = []) {
      const want = new Set(listIds);
      persist(lists.map(l => want.has(l.id)
        ? (l.songIds.includes(songId) ? l : { ...l, songIds: [...l.songIds, songId] })
        : (l.songIds.includes(songId) ? { ...l, songIds: l.songIds.filter(s => s !== songId) } : l)));
      for (const def of known) if (want.has(def?.id) && !lists.some(l => l.id === def.id)) this.importList(def, songId);
    },
    // titre ou artiste modifié : la chanson garde ses listes
    renameSong(oldId, newId, stillUsed) {
      if (oldId === newId) return;
      persist(lists.map(l => l.songIds.includes(oldId)
        ? { ...l, songIds: [...new Set([...(stillUsed ? l.songIds : l.songIds.filter(s => s !== oldId)), newId])] } : l));
    },
    listsOf: songId => lists.filter(l => l.songIds.includes(songId)).map(l => l.id),
    save(id, input) {
      const songs = allSongs();
      if (id && !lists.some(l => l.id === id)) throw new Error('Cette liste n’existe plus.');
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) throw new Error('Choisissez un nom de 1 à 40 caractères.');
      if (!['magic', 'rock', 'mix'].includes(input.theme)) throw new Error('Choisissez une ambiance valide.');
      if (!Array.isArray(input.songIds) || input.songIds.some(id => !songs.some(s => s.id === id))) throw new Error('Une chanson sélectionnée n’est plus disponible.');
      const coverImage = input.coverImage === undefined ? (lists.find(l => l.id === id)?.coverImage || '') : input.coverImage;
      if (typeof coverImage !== 'string' || (coverImage && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(coverImage) || coverImage.length > 700000 || !Buffer.from(coverImage.split(',')[1], 'base64').subarray(0, 3).equals(Buffer.from([255,216,255]))))) throw new Error('Image invalide ou trop volumineuse. Importez une autre image.');
      const list = { id: id || randomUUID(), name: input.name.trim(), description: String(input.description || '').trim().slice(0, 140), theme: input.theme, coverImage, songIds: [...new Set(input.songIds)] };
      persist(id ? lists.map(l => l.id === id ? list : l) : [...lists, list]);
      return list;
    },
  };
}
