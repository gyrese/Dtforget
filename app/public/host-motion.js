/*
 * Host choreography. Each engine owns a distinct surface:
 * GSAP: screen composition; Anime.js: artwork response; Lottie: end-of-game burst.
 * Navigation and game clocks are never delayed by animation completion.
 */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const stage = document.querySelector('.stage');
  if (!stage) return;
  const cardSelector = '.style-card, .universe-card';
  const micro = new Map();
  const boundCards = new WeakSet();
  let sceneContext = null;
  let shelfContext = null;
  let playersContext = null;
  let celebration = null;
  let lastScreen = null;
  let previousPlayers = 0;
  let lastHeroSource = '';

  const canMove = () => !reduced.matches && !document.hidden;
  const activeScreen = () => document.querySelector('.screen.on');
  const elements = (root, selector) => [...root.querySelectorAll(selector)];

  function restoreMicro(target) {
    const entry = micro.get(target);
    if (!entry) return;
    entry.animation?.cancel();
    target.style.transform = entry.transform;
    target.style.opacity = entry.opacity;
    micro.delete(target);
  }

  function artworkTween(target, parameters, restore = false) {
    if (!target || !canMove() || typeof window.anime?.animate !== 'function') return;
    let entry = micro.get(target);
    if (!entry) {
      entry = { transform: target.style.transform, opacity: target.style.opacity, animation: null };
      micro.set(target, entry);
    }
    entry.animation?.cancel();
    entry.animation = window.anime.animate(target, {
      duration: 420,
      ease: 'out(3)',
      ...parameters,
      onComplete: () => { if (restore) restoreMicro(target); },
    });
  }

  function destroyCelebration() {
    celebration?.destroy();
    celebration = null;
  }

  function stopMotion() {
    // Revert restores pre-animation inline styles, including interrupted entrances.
    shelfContext?.revert(); shelfContext = null;
    playersContext?.revert(); playersContext = null;
    sceneContext?.revert(); sceneContext = null;
    for (const target of [...micro.keys()]) restoreMicro(target);
    destroyCelebration();
  }

  function celebrate() {
    const container = document.getElementById('celebration-art');
    if (!container || !canMove() || typeof window.lottie?.loadAnimation !== 'function') return;
    destroyCelebration();
    container.setAttribute('aria-hidden', 'true');
    celebration = window.lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: '/assets/encore-burst.json',
      rendererSettings: { preserveAspectRatio: 'xMidYMid slice', progressiveLoad: true },
    });
    celebration.addEventListener('data_failed', destroyCelebration);
  }

  function enterScreen(screen) {
    stopMotion();
    if (!screen || !canMove()) return;
    if (window.gsap?.context) {
      sceneContext = window.gsap.context(() => {
        const timeline = window.gsap.timeline({ defaults: { duration: 0.55, ease: 'power3.out' } });
        function reveal(selector, position = 0, y = 18, stagger = 0.055) {
          const targets = elements(screen, selector);
          if (targets.length) timeline.from(targets, { opacity: 0, y, stagger, clearProps: 'opacity,transform' }, position);
        }
        switch (screen.id) {
          case 's-menu':
            reveal('.menu-header', 0, 8);
            reveal('.hero-copy > *, .menu-heading > *', 0.06, 20, 0.045);
            reveal('.collection-label, .shelf-heading', 0.16, 12);
            reveal(cardSelector, 0.19, 24, 0.065);
            reveal('.menu-footer', 0.28, 8);
            break;
          case 's-detail':
            reveal('.top', 0, 8);
            reveal('.detail-cover', 0.04, 22);
            reveal('.detail-copy > *', 0.09, 17, 0.04);
            reveal('.song-tile', 0.21, 14, 0.035);
            break;
          case 's-library':
            reveal('.top, .editor-heading, .editor-layout', 0, 18, 0.07);
            break;
          case 's-lobby':
            reveal('.top, .lobby-heading, .lobby, .lobby-footer', 0, 20, 0.07);
            reveal('#code', 0.1, 12);
            break;
          case 's-intro':
            reveal('.top', 0, 8);
            reveal('#intro-title, #intro-film', 0.05, 20, 0.07);
            break;
          case 's-reveal':
            reveal('.top', 0, 8);
            reveal('#rev-answer', 0.07, 20);
            reveal('#rev-ranking .rank', 0.15, 16, 0.07);
            break;
          case 's-over':
            reveal('.label, .final-heading, #final .rank, #again', 0, 20, 0.065);
            break;
          default:
            // Lyrics remain immediately readable. Only the supporting chrome enters.
            reveal('.top, .bar', 0, 6, 0.025);
        }
      }, screen);
    }
    if (screen.id === 's-over') celebrate();
  }

  function bindCards() {
    document.querySelectorAll(cardSelector).forEach(card => {
      if (boundCards.has(card)) return;
      boundCards.add(card);
      const illustration = () => card.querySelector('.universe-illustration, img, .art svg');
      const zoom = () => artworkTween(illustration(), { scale: 1.045, duration: 460 });
      const reset = () => artworkTween(illustration(), { scale: 1, duration: 320 }, true);
      card.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') zoom(); });
      card.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) reset(); });
      card.addEventListener('focusin', zoom);
      card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget)) reset(); });
      card.addEventListener('pointerdown', event => {
        if (event.button === 0) artworkTween(illustration(), { scale: 1.015, duration: 100 });
      });
      card.addEventListener('pointerup', event => { if (event.pointerType === 'mouse') zoom(); else reset(); });
      card.addEventListener('pointercancel', reset);
    });
  }

  function refreshShelf() {
    bindCards();
    if (activeScreen()?.id !== 's-menu' || !canMove() || !window.gsap?.context) return;
    shelfContext?.revert();
    shelfContext = window.gsap.context(() => {
      const cards = [...document.querySelectorAll(cardSelector)];
      if (cards.length) window.gsap.from(cards, {
        opacity: 0, y: 20, duration: 0.5, stagger: 0.065,
        ease: 'power3.out', clearProps: 'opacity,transform',
      });
    }, stage);
  }

  function updateHero() {
    const hero = document.querySelector('img.hero-art');
    if (!hero || hero.getAttribute('src') === lastHeroSource) return;
    lastHeroSource = hero.getAttribute('src');
    restoreMicro(hero);
    artworkTween(hero, { opacity: [0.72, 1], scale: [1.035, 1], duration: 580 }, true);
  }

  function updatePlayers() {
    const list = document.getElementById('players');
    if (!list) return;
    const players = [...list.querySelectorAll('.player')];
    const added = players.slice(previousPlayers);
    previousPlayers = players.length;
    if (activeScreen()?.id !== 's-lobby' || !canMove() || !window.gsap?.context || !added.length) return;
    playersContext?.revert();
    playersContext = window.gsap.context(() => {
      window.gsap.from(added, { opacity: 0, x: 18, scale: 0.97, duration: 0.4, stagger: 0.06, ease: 'power3.out', clearProps: 'opacity,transform' });
    }, list);
  }

  function syncScreen() {
    const screen = activeScreen();
    if (screen === lastScreen) return;
    lastScreen = screen;
    enterScreen(screen);
  }

  // The observer keeps motion decoupled from Socket.IO and all application state.
  const observer = new MutationObserver(records => {
    syncScreen();
    if (records.some(record => record.target.id === 'styles' && record.type === 'childList')) refreshShelf();
    if (records.some(record => record.target.id === 'players' && record.type === 'childList')) updatePlayers();
    if (records.some(record => record.attributeName === 'src' && record.target.matches('img.hero-art'))) updateHero();
  });
  document.querySelectorAll('.screen').forEach(screen => observer.observe(screen, { attributes: true, attributeFilter: ['class'] }));
  ['styles', 'players'].forEach(id => {
    const target = document.getElementById(id);
    if (target) observer.observe(target, { childList: true });
  });
  const hero = document.querySelector('img.hero-art');
  if (hero) observer.observe(hero, { attributes: true, attributeFilter: ['src'] });
  document.addEventListener('host:screen', syncScreen);
  document.addEventListener('host:universe-selected', updateHero);
  // Lifecycle changes restore final readable UI rather than leaving half-finished frames.
  reduced.addEventListener('change', stopMotion);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopMotion(); });
  window.addEventListener('pagehide', stopMotion);
  bindCards();
  lastHeroSource = hero?.getAttribute('src') || '';
  syncScreen();
})();
