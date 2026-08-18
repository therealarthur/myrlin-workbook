/* ==========================================================================
   Myrlin Workbook / landing site behaviour
   --------------------------------------------------------------------------
   WHAT
   Five small pieces of behaviour, no framework and no dependency: the light
   and dark toggle, the copy buttons on the install commands, a development
   mode that repoints every remote asset at a local directory, the reduced
   motion swap that replaces the animated hero with its poster frame, and the
   section highlight in the top bar.

   WHY EACH ONE EXISTS

   1. CHROME TOGGLE. The stylesheet already answers the system preference on
      its own, so this file only handles the case where a reader disagrees with
      their system. The choice is stored under one key and re-read before the
      first paint by the inline script in index.html, so there is no flash.

   2. COPY. The install command is the single thing most visitors came for.
      Selecting it by hand out of a scrolling code line is the one interaction
      a landing page should never make someone do.

   3. DEV ASSET MODE. Every image on this page is an absolute raw.github URL
      pinned to main, because the same files are referenced from the README,
      which npmjs.com renders with no repository context. Those files are
      produced by a separate pipeline and land on main independently of this
      page, so during layout review they do not resolve yet. Loading the page
      with ?dev repoints every element carrying data-asset at a local
      directory, WITHOUT touching the markup: production HTML keeps the raw
      URLs and only a query string changes them. See DEV MODE below.

   4. REDUCED MOTION. An animated WebP cannot be paused from CSS, so honouring
      prefers-reduced-motion means swapping the source for the poster frame
      that the media contract produces for exactly this purpose. It listens for
      changes rather than reading once, so toggling the OS setting takes effect
      without a reload.

   5. SECTION HIGHLIGHT. The active section link takes a background wash and a
      weight change, never an underline or a bar. That absence is the app's own
      idiom and this file only supplies the state; the paint is in styles.css.

   DEV MODE
     ?dev                  assets resolve to   ./dev-assets/<data-asset>
     ?dev=/some/path       assets resolve to   /some/path/<data-asset>
   The data-asset value is the file's path underneath docs/media/, so
   data-asset="media/hero.webp" reads ./dev-assets/media/hero.webp, and data-asset="images/logo.png" reads ./dev-assets/images/logo.png (values are paths under docs/).
   Anchors carrying data-asset (the tour link) are repointed the same way.
   Without the query string nothing is rewritten at all.

   Created: 2026-08-18.
   ========================================================================== */

(function () {
  'use strict';

  /** Canonical remote root for every asset this page references. */
  // docs/, not docs/media/: data-asset values carry their folder (media/... or
  // images/...) since the logo is the floating hat under docs/images/.
  var ASSET_BASE = 'https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs';

  /** Directory used by ?dev when no explicit path is supplied. */
  var DEV_BASE_DEFAULT = 'dev-assets';

  /** Storage key for the reader's explicit light or dark choice. */
  var CHROME_KEY = 'mw-chrome';

  /**
   * Resolve the base URL every asset should be read from for this page load.
   * Returns the production root unless the document was loaded with ?dev, in
   * which case it returns the local directory that flag names.
   *
   * @returns {string} Base URL with no trailing slash.
   */
  function resolveAssetBase() {
    var params = new URLSearchParams(window.location.search);
    if (!params.has('dev')) return ASSET_BASE;
    var value = (params.get('dev') || '').trim();
    return (value || DEV_BASE_DEFAULT).replace(/\/+$/, '');
  }

  /**
   * Join an asset base and a path underneath docs/ (media/... or images/...).
   *
   * @param {string} base Base URL with no trailing slash.
   * @param {string} name Path relative to docs/media/, for example "hero.webp".
   * @returns {string} Full URL.
   */
  function assetUrl(base, name) {
    return base + '/' + name;
  }

  var assetBase = resolveAssetBase();

  /* ── 1. Dev asset rewrite ────────────────────────────────────────────────
     Runs first so everything downstream, including the poster background,
     computes against the base actually in use. */
  if (assetBase !== ASSET_BASE) {
    document.querySelectorAll('img[data-asset]').forEach(function (img) {
      img.src = assetUrl(assetBase, img.dataset.asset);
    });
    document.querySelectorAll('a[data-asset]').forEach(function (link) {
      link.href = assetUrl(assetBase, link.dataset.asset);
    });
    document.documentElement.dataset.assetMode = 'dev';
  }

  /* ── 2. Hero poster ──────────────────────────────────────────────────────
     The poster paints as a background behind the animated frame, so a slow or
     failed load of the multi-megabyte WebP still shows the first frame rather
     than an empty box. Under reduced motion it also replaces the source. */
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  document.querySelectorAll('img[data-poster]').forEach(function (img) {
    var posterUrl = assetUrl(assetBase, img.dataset.poster);
    var animatedUrl = assetUrl(assetBase, img.dataset.asset);
    img.style.backgroundImage = 'url("' + posterUrl + '")';

    /**
     * Point the hero at the still frame or back at the animation, following
     * the current reduced-motion preference.
     *
     * @returns {void}
     */
    function applyMotionPreference() {
      var wanted = reduceMotion.matches ? posterUrl : animatedUrl;
      if (img.getAttribute('src') !== wanted) img.setAttribute('src', wanted);
    }

    applyMotionPreference();
    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', applyMotionPreference);
    }
  });

  /* ── 3. Chrome toggle ────────────────────────────────────────────────────
     No stored choice means the page follows the system, which is what the
     stylesheet does with no attribute present. The first press therefore has
     to resolve what the system is currently showing so that it flips away
     from it rather than to it. */
  var toggle = document.getElementById('chrome-toggle');

  if (toggle) {
    toggle.addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.dataset.chrome;
      if (!current) {
        current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      root.dataset.chrome = next;
      try {
        localStorage.setItem(CHROME_KEY, next);
      } catch (e) {
        /* Private mode. The choice still applies for this page load. */
      }
    });
  }

  /* ── 4. Copy buttons ─────────────────────────────────────────────────────
     The confirmation is a label change on the button rather than a toast,
     because the button is already where the reader is looking. */
  var COPY_RESET_MS = 1600;

  document.querySelectorAll('.copy[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.dataset.copy;
      var done = function () {
        button.dataset.copied = 'true';
        window.setTimeout(function () {
          delete button.dataset.copied;
        }, COPY_RESET_MS);
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () {
          legacyCopy(text, done);
        });
      } else {
        legacyCopy(text, done);
      }
    });
  });

  /**
   * Copy through a detached textarea, for the pages served over plain HTTP on
   * a LAN address where the async clipboard API is unavailable.
   *
   * @param {string} text Text to place on the clipboard.
   * @param {Function} done Called when the copy succeeded.
   * @returns {void}
   */
  function legacyCopy(text, done) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    document.body.appendChild(field);
    field.select();
    try {
      if (document.execCommand('copy')) done();
    } catch (e) {
      /* Nothing further to try; the command text is visible and selectable. */
    } finally {
      document.body.removeChild(field);
    }
  }

  /* ── 5. Section highlight ────────────────────────────────────────────────
     One observer over the sections the top bar links to. The band nearest the
     top of the viewport wins, so a tall section does not hand the highlight to
     the next one the moment its last paragraph enters view. */
  var sectionLinks = Array.prototype.slice.call(
    document.querySelectorAll('.sections a[href^="#"]')
  );

  if (sectionLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    var targets = [];

    sectionLinks.forEach(function (link) {
      var section = document.getElementById(link.getAttribute('href').slice(1));
      if (!section) return;
      byId[section.id] = link;
      targets.push(section);
    });

    var visible = {};

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting;
      });

      var active = null;
      targets.forEach(function (section) {
        if (!active && visible[section.id]) active = section.id;
      });

      Object.keys(byId).forEach(function (id) {
        if (id === active) byId[id].setAttribute('aria-current', 'true');
        else byId[id].removeAttribute('aria-current');
      });
    }, { rootMargin: '-56px 0px -55% 0px', threshold: 0 });

    targets.forEach(function (section) {
      observer.observe(section);
    });
  }
}());
