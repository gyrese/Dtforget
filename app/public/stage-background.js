let youtubeApi;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  youtubeApi ||= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = reject;
    document.head.append(script);
  });
  return youtubeApi;
}

function createStageBackground(layer, audio) {
  let config, media, player, generation = 0, timeline, revealing = false, playing = false;
  const sync = (seek = false) => {
    if (!config || config.type === 'image') return;
    const elapsed = revealing ? Math.max(0, audio.currentTime - (timeline.revealAt ?? 0)) : audio.currentTime;
    const position = elapsed + ((revealing ? config.revealStart : config.start) ?? 0);
    const running = playing && !audio.paused && !audio.ended;
    if (player && typeof player.seekTo === 'function') {
      if (seek) player.seekTo(position, true);
      if (running) player.playVideo();
      else player.pauseVideo();
    }
    if (media instanceof HTMLVideoElement && media.readyState >= 1) {
      const time = media.loop && media.duration > 0 ? position % media.duration : position;
      if (seek || Math.abs(media.currentTime - time) > .4) media.currentTime = time;
      if (running && media.paused) media.play().catch(() => {});
      if (!running) media.pause();
    }
  };
  function clear() {
    generation++;
    config = media = null;
    if (player) player.destroy();
    player = null;
    layer.replaceChildren();
    delete layer.parentElement.dataset.background;
  }
  function set(clip, cover) {
    clear();
    config = clip.background || (cover ? { type: 'image', url: cover } : null);
    timeline = clip;
    revealing = playing = false;
    if (!config) return;
    const current = generation;
    const fallback = () => {
      if (current !== generation) return;
      if (clip.background && cover) set({ ...clip, background: null }, cover);
      else clear();
    };
    if (config.type === 'youtube') {
      const holder = document.createElement('div');
      layer.append(holder);
      loadYouTube().then((YT) => {
        if (current !== generation) return;
        player = new YT.Player(holder, {
          videoId: config.videoId,
          playerVars: { controls: 0, playsinline: 1, disablekb: 1, origin: location.origin },
          events: {
            onReady({ target }) {
              if (current !== generation) return;
              target.mute();
              target.getIframe().tabIndex = -1;
              player = target;
              layer.parentElement.dataset.background = 'on';
              sync(true);
            },
            onError: fallback,
          },
        });
        media = player.getIframe();
        if (media) media.tabIndex = -1;
      }).catch(fallback);
      return;
    }
    const video = config.type === 'video';
    media = document.createElement(video ? 'video' : 'img');
    media.addEventListener('error', fallback, { once: true });
    media.addEventListener(video ? 'loadedmetadata' : 'load', () => {
      if (current !== generation) return;
      layer.parentElement.dataset.background = 'on';
      sync(true);
    }, { once: true });
    if (video) {
      media.muted = true;
      media.playsInline = true;
      media.loop = config.start == null;
    } else media.alt = '';
    media.src = config.url || '/media/' + encodeURIComponent(config.file);
    layer.append(media);
  }

  for (const event of ['playing', 'pause', 'ended', 'waiting', 'seeked', 'timeupdate']) {
    audio.addEventListener(event, () => {
      if (event === 'playing') playing = true;
      if (['pause', 'ended', 'waiting'].includes(event)) playing = false;
      if (event !== 'timeupdate' || !player) sync(event === 'seeked');
    });
  }
  return {
    set,
    screen(id) {
      if (id !== 's-play' && id !== 's-reveal') clear();
      else {
        revealing = id === 's-reveal';
        sync(true);
      }
    },
  };
}
