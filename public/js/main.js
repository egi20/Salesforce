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

          // Skills are rows now: fill the empty ones first, add rows for the rest, and never
          // duplicate a skill already listed.
          if (f.skills && f.skills.length && window.sfAddSkillRow) {
            var have = Array.prototype.map.call(document.querySelectorAll('input[name="skill_name"]'), function (i) {
              return i.value.trim().toLowerCase();
            });
            f.skills.forEach(function (name) {
              if (have.indexOf(String(name).toLowerCase()) !== -1) return;
              window.sfAddSkillRow(name);
              have.push(String(name).toLowerCase());
            });
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

  /*
   * The job board's filters apply as soon as one changes. The Apply button stays for the
   * no-script case and for the rate box, which applies on change (blur or Enter) rather than
   * on every keystroke — a request per digit typed is a request per digit typed.
   * Controls tied to the form by `form="jobFilters"` (the sort select) apply too.
   */
  var autoForm = document.querySelector('form[data-auto-apply]');
  if (autoForm) {
    var autoSubmit = function (event) {
      var t = event.target;
      if (!t || t.type === 'search' || t.hasAttribute('data-filter-list')) return;
      if (t.form !== autoForm) return;
      autoForm.requestSubmit ? autoForm.requestSubmit() : autoForm.submit();
    };
    document.addEventListener('change', autoSubmit);
  }

  /*
   * Loading cue for the board: whatever reloads the list — the filter form, a chip's ×,
   * "Clear all", a page link — fades the current results until the new page lands.
   * `pageshow` clears it again when the browser restores this page from its back cache.
   */
  var results = document.querySelector('[data-results]');
  if (results) {
    var markLoading = function () { results.classList.add('is-loading'); };
    if (autoForm) autoForm.addEventListener('submit', markLoading);
    document.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('a[href^="/jobs"]');
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (link.closest('.job-card') && !link.closest('.pagination')) return;
      if (/^\/jobs\/[^?]/.test(link.getAttribute('href'))) return; // a job page, not the list
      markLoading();
    });
    window.addEventListener('pageshow', function () { results.classList.remove('is-loading'); });
  }

  /* Controls that exist only for the no-script case (an Apply button) go when scripting runs. */
  document.querySelectorAll('[data-no-script-only]').forEach(function (el) { el.remove(); });

  /*
   * A sticky sidebar taller than the window: stick it by its BOTTOM edge instead, so it
   * scrolls with the page until its end is visible and then holds. Shorter than the window,
   * the CSS `top` applies unchanged.
   */
  var stickySidebar = document.querySelector('[data-sticky-sidebar]');
  if (stickySidebar) {
    var placeSidebar = function () {
      stickySidebar.style.top = '';
      if (window.innerWidth < 992) return;
      var room = window.innerHeight - stickySidebar.offsetHeight - 16;
      var cssTop = parseFloat(getComputedStyle(stickySidebar).top) || 0;
      if (room < cssTop) stickySidebar.style.top = room + 'px';
    };
    placeSidebar();
    window.addEventListener('resize', placeSidebar);
    stickySidebar.addEventListener('toggle', placeSidebar, true);
  }

  /*
   * The consultant profile page: sections become tabs, list rows (skills, languages) can be
   * added and removed, and the save bar says when something has changed. Without scripting
   * the same page is one long form with a contents bar, and every control still works.
   */
  var profileForm = document.querySelector('form[data-profile-tabs]');
  if (profileForm) {
    var sections = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    var tabLinks = Array.prototype.slice.call(document.querySelectorAll('[data-tab-link]'));
    var currentTab = profileForm.querySelector('[data-current-tab]');
    var names = sections.map(function (sec) { return sec.getAttribute('data-tab'); });

    var showTab = function (name, focus) {
      if (names.indexOf(name) === -1) name = names[0];
      sections.forEach(function (sec) { sec.classList.toggle('is-active', sec.getAttribute('data-tab') === name); });
      tabLinks.forEach(function (a) {
        var on = a.getAttribute('data-tab-link') === name;
        a.classList.toggle('is-active', on);
        if (a.closest('.profile-tabs')) {
          a.setAttribute('aria-current', on ? 'page' : 'false');
          // On a phone the tab row scrolls sideways; keep the active tab in view.
          if (on && a.parentNode.scrollWidth > a.parentNode.clientWidth) {
            a.parentNode.scrollLeft = a.offsetLeft - (a.parentNode.clientWidth - a.offsetWidth) / 2;
          }
        }
      });
      if (currentTab) currentTab.value = name;
      if (focus) {
        var heading = document.getElementById(name).querySelector('h2');
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
      }
    };
    document.body.classList.add('profile-tabs-ready');
    showTab((location.hash || '').slice(1), false);
    tabLinks.forEach(function (a) {
      a.addEventListener('click', function (event) {
        event.preventDefault();
        var name = a.getAttribute('data-tab-link');
        history.replaceState(null, '', '#' + name);
        showTab(name, true);
        var nav = document.querySelector('.profile-tabs');
        if (nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start' });
      });
    });

    // A required field on a hidden tab would block Save with nothing visible: show its tab.
    profileForm.addEventListener('invalid', function (event) {
      var sec = event.target.closest('[data-tab]');
      if (sec) showTab(sec.getAttribute('data-tab'), false);
    }, true);

    // Rows: clone the last row of the list, emptied.
    var addRow = function (kind, value) {
      var list = document.querySelector('[data-rows="' + kind + '"]');
      if (!list) return null;
      var rows = list.querySelectorAll('[data-row]');
      var blank = Array.prototype.find.call(rows, function (r) {
        var first = r.querySelector('input');
        return first && !first.value.trim();
      });
      var row = blank;
      if (!row) {
        row = rows[rows.length - 1].cloneNode(true);
        row.querySelectorAll('input').forEach(function (i) { i.value = ''; });
        list.appendChild(row);
      }
      if (value !== undefined) row.querySelector('input').value = value;
      return row;
    };
    window.sfAddSkillRow = function (name) { addRow('skill', name); };
    document.querySelectorAll('[data-add-row]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = addRow(btn.getAttribute('data-add-row'));
        if (row) row.querySelector('input').focus();
      });
    });
    profileForm.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-remove-row]');
      if (!btn) return;
      var row = btn.closest('[data-row]');
      var list = row.parentNode;
      if (list.querySelectorAll('[data-row]').length > 1) row.remove();
      else row.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      profileForm.dispatchEvent(new Event('input'));
    });

    // The save bar says when there is something to save, and the browser asks before leaving.
    var dirty = false;
    var note = document.querySelector('[data-unsaved-note]');
    profileForm.addEventListener('input', function (event) {
      // Fields that belong to the row forms (form="certAddForm" …) or the listing switch save
      // themselves; typing in them is not an unsaved change to the profile.
      if (dirty || (event.target && event.target.form && event.target.form !== profileForm)) return;
      dirty = true;
      if (note) { note.textContent = 'You have unsaved changes.'; note.classList.add('is-dirty'); }
    });
    profileForm.addEventListener('submit', function () { dirty = false; });
    // Adding a row or switching listing reloads the page: say so if the profile has edits.
    ['certAddForm', 'projAddForm', 'expAddForm', 'removeForm', 'visibilityForm'].forEach(function (id) {
      var f = document.getElementById(id);
      if (f) f.addEventListener('submit', function (event) {
        if (dirty && !window.confirm('Save your profile changes first? Adding this reloads the page and they would be lost.\n\nOK = continue anyway')) {
          event.preventDefault();
        } else {
          dirty = false;
        }
      });
    });
    window.addEventListener('beforeunload', function (event) {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    });

    document.querySelectorAll('[data-submit-on-change]').forEach(function (input) {
      input.addEventListener('change', function () {
        // requestSubmit, so the form's submit handler (the unsaved-changes check) runs.
        if (input.form) { if (input.form.requestSubmit) input.form.requestSubmit(); else input.form.submit(); }
      });
    });
    document.querySelectorAll('[data-click]').forEach(function (a) {
      a.addEventListener('click', function (event) {
        var target = document.getElementById(a.getAttribute('data-click'));
        if (target) { event.preventDefault(); target.click(); }
      });
    });
  }

  /* Fold a disclosure that is open by default (for the no-script case) on a narrow screen. */
  document.querySelectorAll('details[data-fold-below]').forEach(function (d) {
    if (window.innerWidth < Number(d.getAttribute('data-fold-below'))) d.open = false;
  });

  /* Narrow a long checkbox list as you type; a group with nothing left hides its heading. */
  document.querySelectorAll('input[data-filter-list]').forEach(function (input) {
    var list = document.querySelector(input.getAttribute('data-filter-list'));
    if (!list) return;
    input.addEventListener('input', function () {
      var term = input.value.trim().toLowerCase();
      list.querySelectorAll('[data-filter-group]').forEach(function (group) {
        var any = false;
        group.querySelectorAll('[data-filter-item]').forEach(function (item) {
          var match = !term || item.textContent.toLowerCase().indexOf(term) !== -1;
          item.hidden = !match;
          if (match) any = true;
        });
        group.hidden = !any;
      });
    });
  });

  /*
   * Save / unsave a job from a card without leaving the board. Without scripting the form
   * posts and the route redirects back to the same filtered page.
   */
  document.querySelectorAll('form[data-save-job]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var savedField = form.querySelector('input[name="saved"]');
      var button = form.querySelector('.btn-save');
      var icon = button.querySelector('.bi');
      button.disabled = true;
      apiFetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ saved: savedField.value })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.success) { form.submit(); return; }
          savedField.value = data.saved ? 'true' : 'false';
          button.classList.toggle('is-saved', data.saved);
          button.setAttribute('aria-pressed', data.saved ? 'true' : 'false');
          button.setAttribute('aria-label', data.saved ? 'Remove from saved jobs' : 'Save this job');
          button.title = data.saved ? 'Saved' : 'Save';
          icon.className = 'bi ' + (data.saved ? 'bi-bookmark-star-fill' : 'bi-bookmark-star');
        })
        .catch(function () { form.submit(); })
        .finally(function () { button.disabled = false; });
    });
  });

  /*
   * Copy-to-clipboard for any button carrying `data-copy` — a sales agent's link, on their
   * dashboard and on the admin tab. The value is in the attribute, server-escaped, and the
   * readonly field beside it means the page still works without scripting or without the
   * Clipboard API (which needs a secure context): the link can be selected by hand.
   */
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy');
      if (!navigator.clipboard || !value) return;
      navigator.clipboard.writeText(value).then(function () {
        var previous = button.getAttribute('aria-label');
        button.setAttribute('aria-label', 'Copied');
        button.classList.add('is-copied');
        setTimeout(function () {
          if (previous) button.setAttribute('aria-label', previous); else button.removeAttribute('aria-label');
          button.classList.remove('is-copied');
        }, 1500);
      }).catch(function () { /* Nothing to do: the link is on the page to select by hand. */ });
    });
  });
})();
