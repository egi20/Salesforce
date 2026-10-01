/* eslint-env browser */
(function () {
  'use strict';

  /**
   * Every fetch from this page carries the CSRF token from the meta tag.
   * Server-rendered forms carry it as a hidden field instead.
   */
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  function apiFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'X-CSRF-Token': csrfToken }, opts.headers || {});
    opts.credentials = 'same-origin';
    return fetch(url, opts);
  }

  /**
   * Unread notification badge.
   *
   * Fails silently: a 401 here simply means the session ended, and the page should not
   * grow an error banner because a decorative counter could not load.
   */
  function fillBadge(elementId, url) {
    var badge = document.getElementById(elementId);
    if (!badge) return;
    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.count > 0) {
          badge.textContent = data.count > 99 ? '99+' : String(data.count);
          badge.classList.remove('d-none');
        }
      })
      .catch(function () { /* decorative only */ });
  }

  fillBadge('messageCount', '/messages/unread-count');

  /**
   * Guard against a double-submitted form producing two writes.
   * The button is disabled after submit, but the form still submits normally, so this
   * degrades to no-op without JavaScript.
   */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.noGuard === 'true') return;
    var button = form.querySelector('button[type="submit"]');
    if (!button || button.disabled) return;
    window.setTimeout(function () {
      button.disabled = true;
      button.dataset.originalText = button.innerHTML;
      button.innerHTML = 'Working…';
    }, 0);
  });

  /**
   * Scroll reveal: a 16px rise as an element enters the viewport, once.
   *
   * Above-the-fold content is revealed immediately rather than waiting for a scroll that
   * may never happen. Anything already intersecting on load counts as above the fold.
   * With reduced motion requested, everything is revealed at once and no observer runs.
   */
  var revealTargets = document.querySelectorAll('.animate-on-scroll');
  var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (revealTargets.length) {
    if (prefersReducedMotion || typeof IntersectionObserver !== 'function') {
      Array.prototype.forEach.call(revealTargets, function (el) { el.classList.add('is-visible'); });
    } else {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });

      Array.prototype.forEach.call(revealTargets, function (el) { observer.observe(el); });
    }
  }

  /**
   * Print button (the invoice).
   *
   * Delegated rather than an inline `onclick`, so no view has to carry executable markup.
   * Without JavaScript the page still prints correctly from the browser's own menu — the
   * print stylesheet does the real work; this is only a shortcut to it.
   */
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest ? event.target.closest('[data-print]') : null;
    if (!trigger) return;
    event.preventDefault();
    window.print();
  });

  /**
   * Select the whole value of a read-only field when it is focused.
   *
   * Delegated rather than an inline `onfocus`, so no view carries executable markup.
   * Without JavaScript the field still shows the full value and can be selected by hand —
   * this only saves a drag.
   */
  document.addEventListener('focusin', function (event) {
    var field = event.target;
    if (field && field.hasAttribute && field.hasAttribute('data-select-on-focus')) field.select();
  });

  /**
   * A colour picker that writes into its hex field.
   *
   * The text field is the one that submits, so the page works identically with scripting
   * off — the picker is a convenience for choosing, never the source of the value.
   */
  document.addEventListener('input', function (event) {
    var picker = event.target;
    if (!picker || !picker.hasAttribute || !picker.hasAttribute('data-mirror')) return;
    var target = document.getElementById(picker.getAttribute('data-mirror'));
    if (target) target.value = picker.value;
  });

  /**
   * Availability date is only meaningful for a profile that is actually available.
   * Purely a convenience: the server does not depend on it.
   */
  var availability = document.getElementById('availability');
  var availableFrom = document.getElementById('available_from');
  if (availability && availableFrom) {
    var sync = function () {
      availableFrom.disabled = availability.value === 'not_available';
    };
    availability.addEventListener('change', sync);
    sync();
  }

  /*
   * Show/hide on a password field.
   *
   * BUILT HERE, not written into the markup, and that is the point: with scripting off there
   * is no button to press, and the field is simply a password field — which is the correct
   * behaviour rather than a dead control. Same rule the rest of this file follows: the page
   * works without it and this only makes it nicer.
   *
   * It matters most on a phone, where a mistyped password in a field nobody can read is the
   * commonest reason a sign-up is abandoned.
   */
  document.querySelectorAll('input[type="password"][data-toggle-visibility]').forEach(function (field) {
    var wrap = document.createElement('div');
    wrap.className = 'password-field';
    field.parentNode.insertBefore(wrap, field);
    wrap.appendChild(field);

    var button = document.createElement('button');
    // Explicitly `button`: inside a form an unspecified type submits it, so pressing this
    // would sign somebody up rather than show them what they typed.
    button.type = 'button';
    button.className = 'password-toggle';
    button.setAttribute('aria-label', 'Show password');
    button.innerHTML = '<i class="bi bi-eye" aria-hidden="true"></i>';

    button.addEventListener('click', function () {
      var shown = field.type === 'text';
      field.type = shown ? 'password' : 'text';
      button.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      button.innerHTML = '<i class="bi ' + (shown ? 'bi-eye' : 'bi-eye-slash') + '" aria-hidden="true"></i>';
      // Focus goes back to the field, at the end of what they typed — otherwise the caret
      // jumps to the start and the next keystroke lands in the wrong place.
      field.focus();
      var end = field.value.length;
      try { field.setSelectionRange(end, end); } catch (e) { /* not selectable on some types */ }
    });

    wrap.appendChild(button);
  });

  /** Ending an experience and marking it current are mutually exclusive. */
  var isCurrent = document.getElementById('is_current');
  if (isCurrent) {
    var endedOn = document.querySelector('input[name="ended_on"]');
    var syncCurrent = function () {
      if (endedOn) endedOn.disabled = isCurrent.checked;
    };
    isCurrent.addEventListener('change', syncCurrent);
    syncCurrent();
  }

  /**
   * Navbar search: the <details> element already opens and closes the panel without any
   * JavaScript. This only adds convenience on top — focus the field on open, and close on
   * an outside click, so it behaves like the dropdowns next to it.
   */
  var navSearch = document.querySelector('.nav-search');
  if (navSearch) {
    var navSearchInput = navSearch.querySelector('.nav-search-input');
    navSearch.addEventListener('toggle', function () {
      if (navSearch.open && navSearchInput) navSearchInput.focus();
    });
    document.addEventListener('click', function (event) {
      if (navSearch.open && !navSearch.contains(event.target)) navSearch.open = false;
    });
  }

  /**
   * Account menu: recent notifications are fetched once when the menu first opens, not on
   * every page render — the same reasoning as the unread badge, just for a panel instead
   * of a count. Notification titles can contain another account's chosen display name, so
   * they are set with textContent, never innerHTML.
   */
  var accountMenuToggle = document.querySelector('#accountMenu')
    ? document.querySelector('#accountMenu').closest('.dropdown')
    : null;
  if (accountMenuToggle) {
    var summaryLoaded = false;
    accountMenuToggle.addEventListener('show.bs.dropdown', function () {
      if (summaryLoaded) return;
      summaryLoaded = true;
      apiFetch('/dashboard/nav-summary')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.success) return;

          var list = document.getElementById('accountMenuNotifications');
          if (!list || !data.notifications || data.notifications.length === 0) return;
          list.textContent = '';
          data.notifications.forEach(function (n) {
            var item = document.createElement('a');
            item.className = 'account-menu-notif-item' + (n.unread ? ' is-unread' : '');
            item.href = typeof n.link === 'string' && n.link.charAt(0) === '/' ? n.link : '/notifications';
            item.textContent = n.title;
            list.appendChild(item);
          });
        })
        .catch(function () {
          summaryLoaded = false; /* decorative only, but allow a retry on next open */
        });
    });
  }

  /**
   * Consultant profile: photo change/remove and "Import from CV" all go through fetch
   * rather than a form submit, because a `<form>` cannot legally nest inside the profile
   * form that already wraps this card. A photo change reloads the page afterwards — the
   * server still sets the usual flash message, which the reload then shows, same as a
   * normal form post would.
   */
  var changePhotoBtn = document.getElementById('changePhotoBtn');
  var photoFile = document.getElementById('photoFile');
  if (changePhotoBtn && photoFile) {
    changePhotoBtn.addEventListener('click', function () { photoFile.click(); });
    photoFile.addEventListener('change', function () {
      if (!photoFile.files || !photoFile.files[0]) return;
      var data = new FormData();
      data.append('photo', photoFile.files[0]);
      changePhotoBtn.disabled = true;
      apiFetch('/profile/consultant/photo', { method: 'POST', body: data })
        .then(function () { window.location.reload(); })
        .catch(function () { changePhotoBtn.disabled = false; });
    });
  }

  var removePhotoBtn = document.getElementById('removePhotoBtn');
  if (removePhotoBtn) {
    removePhotoBtn.addEventListener('click', function () {
      removePhotoBtn.disabled = true;
      apiFetch('/profile/consultant/photo/remove', { method: 'POST' })
        .then(function () { window.location.reload(); })
        .catch(function () { removePhotoBtn.disabled = false; });
    });
  }

  var importCvBtn = document.getElementById('importCvBtn');
  var cvImportFile = document.getElementById('cvImportFile');
  var cvImportStatus = document.getElementById('cvImportStatus');
  if (importCvBtn && cvImportFile) {
    importCvBtn.addEventListener('click', function () { cvImportFile.click(); });
    cvImportFile.addEventListener('change', function () {
      if (!cvImportFile.files || !cvImportFile.files[0]) return;
      var data = new FormData();
      data.append('cv', cvImportFile.files[0]);
      importCvBtn.disabled = true;
      var originalLabel = importCvBtn.innerHTML;
      importCvBtn.textContent = 'Reading…';

      var setStatus = function (text, isError) {
        if (!cvImportStatus) return;
        cvImportStatus.textContent = text;
        cvImportStatus.classList.remove('d-none');
        cvImportStatus.classList.toggle('text-danger', Boolean(isError));
      };
      var setValue = function (id, value) {
        var el = document.getElementById(id);
        if (el && value) el.value = value;
      };

      apiFetch('/profile/consultant/import-cv', { method: 'POST', body: data })
        .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok || !result.body.success) {
            setStatus((result.body && result.body.error) || 'That file could not be imported.', true);
            return;
          }
          var f = result.body.fields;
          setValue('given_name', f.given_name);
          setValue('family_name', f.family_name);
          setValue('phone', f.phone);
          setValue('headline', f.headline);
          setValue('city', f.city);
          setValue('bio', f.bio);
          if (f.years_experience) setValue('years_experience', f.years_experience);

          var countrySelect = document.getElementById('country');
          if (countrySelect && f.country) {
            var wanted = f.country.trim().toLowerCase();
            for (var i = 0; i < countrySelect.options.length; i += 1) {
              if (countrySelect.options[i].text.trim().toLowerCase() === wanted) {
                countrySelect.selectedIndex = i;
                break;
              }
            }
          }

          var skillsInput = document.getElementById('skills');
          if (skillsInput && f.skills && f.skills.length) {
            var existing = skillsInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            var merged = existing.slice();
            f.skills.forEach(function (s) {
              if (merged.indexOf(s) === -1) merged.push(s);
            });
            skillsInput.value = merged.join(', ');
          }

          setStatus('Imported. Review the fields below, then save.', false);
        })
        .catch(function () { setStatus('That file could not be imported.', true); })
        .finally(function () {
          importCvBtn.disabled = false;
          importCvBtn.innerHTML = originalLabel;
          cvImportFile.value = '';
        });
    });
  }
})();
