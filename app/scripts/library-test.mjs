import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLibrary, songKey } from '../library.js';

test('lists persist, allow shared songs, and filter all clips of a song', () => {
  mkdirSync(join(import.meta.dirname, '../data'), { recursive: true });
  const dir = mkdtempSync(join(import.meta.dirname, '../data/test-library-'));
  try {
    const content = [{ film: 'Film A', title: 'Song A', id: 'a1' }, { film: 'Film A', title: 'Song A', id: 'a2' }, { film: 'Film B', title: 'Song B', id: 'b1' }];
    const file = join(dir, 'lists.json');
    const lib = createLibrary(content, file);
    assert.equal(lib.get().songs.length, 2);
    assert.equal(lib.clips('rock').length, 0);
    const custom = lib.save(null, { name: 'My mix', theme: 'mix', songIds: [songKey(content[0])] });
    assert.deepEqual(lib.clips(custom.id).map(c => c.id), ['a1', 'a2']);
    assert.equal(lib.clips('disney').length, 3);
    assert.deepEqual(createLibrary(content, file).get(), lib.get());
    assert.throws(() => lib.save(custom.id, { name: ' ', theme: 'mix', songIds: [] }));
    assert.throws(() => lib.save(custom.id, { name: 'Bad', theme: 'mix', songIds: ['missing'] }));
    lib.save(custom.id, { name: 'Renamed', theme: 'rock', songIds: [] });
    assert.equal(lib.clips(custom.id).length, 0);
    const image = 'data:image/jpeg;base64,/9j/AA==';
    const input = { name: 'Renamed', theme: 'rock', songIds: [] };
    lib.save(custom.id, { ...input, coverImage: image });
    assert.equal(createLibrary(content, file).get().lists.at(-1).coverImage, image);
    lib.save(custom.id, input);
    assert.equal(lib.get().lists.at(-1).coverImage, image);
    assert.throws(() => lib.save(custom.id, { ...input, coverImage: 'https://example.com/image.png' }));
    assert.throws(() => lib.save(custom.id, { ...input, coverImage: 'data:image/jpeg;base64,YmFk' }));
    lib.save(custom.id, { ...input, coverImage: '' });
    assert.equal(createLibrary(content, file).get().lists.at(-1).coverImage, '');
    assert.equal(createLibrary(content, file).get().lists.at(-1).name, 'Renamed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

