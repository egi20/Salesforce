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

      /*
       * "Import from CV" never writes on its own: the result is laid out here as a list of
       * ticked boxes, built from DOM nodes (the CV is untrusted text), and only what is still
       * ticked when the consultant presses "Use selected" reaches the form or the server.
       */
      var review = document.getElementById('cvImportReview');
      var el = function (tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };
      var month = function (d) { return d ? String(d).slice(0, 7) : ''; };
      var period = function (e) { return [month(e.started_on), e.is_current ? 'present' : month(e.ended_on)].filter(Boolean).join(' – '); };
      var tick = function (label, sub) {
        var wrap = el('label', 'form-check d-flex gap-2 mb-1');
        var box = el('input', 'form-check-input mt-1');
        box.type = 'checkbox';
        box.checked = true;
        wrap.appendChild(box);
        var body = el('span');
        body.appendChild(el('span', 'fw-semibold', label));
        if (sub) body.appendChild(el('span', 'd-block small text-muted-2', sub));
        wrap.appendChild(body);
        return { node: wrap, box: box };
      };

      var renderImportReview = function (f) {
        if (!review) return;
        while (review.firstChild) review.removeChild(review.firstChild);
        review.className = 'cv-review glass-card mb-3';
        var card = el('div', 'card-body');
        review.appendChild(card);
        card.appendChild(el('h3', 'h6 mb-1', 'Found in your CV'));
        card.appendChild(el('p', 'small text-muted-2 mb-3', 'Nothing is saved yet. Untick anything that is wrong.'));
        var picks = { fields: [], skills: [], projects: [], experience: [] };

        var section = function (title) {
          var s = el('div', 'mb-3');
          s.appendChild(el('h4', 'small text-uppercase text-muted-2 mb-2', title));
          card.appendChild(s);
          return s;
        };

        var basics = [
          ['given_name', 'First name'], ['family_name', 'Last name'], ['headline', 'Professional title'],
          ['phone', 'Phone'], ['city', 'City'], ['country', 'Country'], ['years_experience', 'Years of experience'], ['bio', 'Bio']
        ].filter(function (k) { return f[k[0]] !== null && f[k[0]] !== undefined && String(f[k[0]]).trim() !== ''; });
        if (basics.length) {
          var b = section('Basics');
          basics.forEach(function (k) {
            var t = tick(k[1], String(f[k[0]]));
            b.appendChild(t.node);
            picks.fields.push({ key: k[0], value: f[k[0]], box: t.box });
          });
        }
        if (f.skills && f.skills.length) {
          var sk = section('Skills');
          var row = el('div', 'd-flex flex-wrap gap-2');
          sk.appendChild(row);
          f.skills.forEach(function (name) {
            var t = tick(name);
            t.node.classList.add('cv-review-chip');
            row.appendChild(t.node);
            picks.skills.push({ value: name, box: t.box });
          });
        }
        if (f.experience && f.experience.length) {
          var ex = section('Experience');
          f.experience.forEach(function (e) {
            var t = tick([e.title, e.company].filter(Boolean).join(' · '), [period(e), e.description].filter(Boolean).join(' — '));
            ex.appendChild(t.node);
            picks.experience.push({ value: e, box: t.box });
          });
        }
        if (f.projects && f.projects.length) {
          var pr = section('Projects');
          f.projects.forEach(function (p) {
            var t = tick([p.name, p.client].filter(Boolean).join(' · '), [period(p), p.description].filter(Boolean).join(' — '));
            pr.appendChild(t.node);
            picks.projects.push({ value: p, box: t.box });
          });
        }
        if (!basics.length && !picks.skills.length && !picks.experience.length && !picks.projects.length) {
          card.appendChild(el('p', 'mb-2', 'Nothing usable was found in that file.'));
        }

        var actions = el('div', 'd-flex flex-wrap gap-2');
        var use = el('button', 'btn btn-primary btn-sm', 'Use selected');
        use.type = 'button';
        var discard = el('button', 'btn btn-outline-secondary btn-sm', 'Discard');
        discard.type = 'button';
        actions.appendChild(use);
        actions.appendChild(discard);
        card.appendChild(actions);
        var note = el('p', 'small mb-0 mt-2');
        card.appendChild(note);

        discard.addEventListener('click', function () {
          review.className = 'd-none';
          if (cvImportStatus) cvImportStatus.classList.add('d-none');
        });

        use.addEventListener('click', function () {
          var chosen = function (list) { return list.filter(function (p) { return p.box.checked; }); };
          chosen(picks.fields).forEach(function (p) {
            if (p.key === 'country') {
              var countrySelect = document.getElementById('country');
              if (!countrySelect) return;
              var wanted = String(p.value).trim().toLowerCase();
              for (var i = 0; i < countrySelect.options.length; i += 1) {
                if (countrySelect.options[i].text.trim().toLowerCase() === wanted || countrySelect.options[i].value.toLowerCase() === wanted) {
                  countrySelect.selectedIndex = i;
                  countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
                  break;
                }
              }
              return;
            }
            var input = document.getElementById(p.key);
            if (input) {
              input.value = p.value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          if (window.sfAddSkillRow) {
            var have = Array.prototype.map.call(document.querySelectorAll('input[name="skill_name"]'), function (i) {
              return i.value.trim().toLowerCase();
            });
            chosen(picks.skills).forEach(function (p) {
              var key = String(p.value).toLowerCase();
              if (have.indexOf(key) !== -1) return;
              window.sfAddSkillRow(p.value);
              have.push(key);
            });
          }

          var projects = chosen(picks.projects).map(function (p) { return p.value; });
          var experience = chosen(picks.experience).map(function (p) { return p.value; });
          var formNote = 'Fields filled in. Press Save to keep them.';
          if (!projects.length && !experience.length) {
            note.textContent = formNote;
            use.disabled = true;
            return;
          }
          use.disabled = true;
          note.textContent = 'Adding projects and experience…';
          apiFetch('/profile/consultant/import-entries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projects: projects, experience: experience })
          })
            .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
            .then(function (res2) {
              if (!res2.ok || !res2.body.success) throw new Error('refused');
              note.textContent = 'Added ' + res2.body.projects + ' project(s) and ' + res2.body.experience +
                ' experience entr' + (res2.body.experience === 1 ? 'y' : 'ies') + '. ' + formNote +
                ' They appear under Projects & experience after the page reloads.';
            })
            .catch(function () {
              use.disabled = false;
              note.textContent = 'Projects and experience could not be added. Please try again.';
              note.classList.add('text-danger');
            });
        });
        review.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };

      apiFetch('/profile/consultant/import-cv', { method: 'POST', body: data })
        .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok || !result.body.success) {
            setStatus((result.body && result.body.error) || 'That file could not be imported.', true);
            return;
          }
          renderImportReview(result.body.fields);
          setStatus('Read your CV. Tick what you want to keep, then press "Use selected".', false);
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

  /*
   * A form carrying data-confirm asks before it posts (withdrawing an application). Without
   * scripting it simply posts: the confirmation is a convenience, never the only guard.
   */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var message = form && form.getAttribute && form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  }, true);

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
      if (currentTab && name !== 'account') currentTab.value = name;
      // Account has its own forms; the profile's Save bar would only confuse there.
      document.body.setAttribute('data-active-tab', name);
      if (focus) {
        var heading = document.getElementById(name).querySelector('h2');
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
      }
    };
    document.body.classList.add('profile-tabs-ready');
    // No #section in the link: open the first section that is not done yet.
    var firstOpen = (document.querySelector('[data-first-open]') || {}).getAttribute ? document.querySelector('[data-first-open]').getAttribute('data-first-open') : null;
    showTab((location.hash || '').slice(1) || firstOpen, false);
    window.addEventListener('hashchange', function () { showTab(location.hash.slice(1), false); });
    tabLinks.forEach(function (a) {
      a.addEventListener('click', function (event) {
        event.preventDefault();
        var name = a.getAttribute('data-tab-link');
        history.replaceState(null, '', '#' + name);
        showTab(name, true);
        /*
         * Coming from a long section, the page keeps its scroll position and the new, shorter
         * one starts above the window — its heading under the fixed menu. Bring it back, by
         * its own scroll-margin-top, only when that has happened.
         */
        var sec = document.getElementById(name);
        var menu = document.querySelector('.navbar');
        var menuBottom = menu ? menu.getBoundingClientRect().bottom : 0;
        if (sec && sec.getBoundingClientRect().top < menuBottom + 8) sec.scrollIntoView({ block: 'start' });
        // A "saved" or "profile is ready" message belongs to the moment it was shown, not to
        // every section opened after it. Errors and still-needed notes stay until closed.
        document.querySelectorAll('.alert-success.alert-dismissible').forEach(function (el) { el.remove(); });
      });
    });

    /*
     * Rate fields follow the type of work: the day and hourly rate belong to contract, the
     * salary to permanent. A field whose type is not chosen is hidden (its value is kept and
     * still posted, so unticking by mistake loses nothing) and the star sits only on what
     * the chosen types need.
     */
    var workBoxes = ['open_to_contract', 'open_to_permanent'].map(function (id) { return document.getElementById(id); });
    var syncRates = function () {
      var any = false;
      workBoxes.forEach(function (box) {
        if (!box) return;
        any = any || box.checked;
        document.querySelectorAll('[data-for-work="' + box.id + '"]').forEach(function (col) {
          col.classList.toggle('d-none', !box.checked);
        });
      });
      var none = document.querySelector('[data-rate-none]');
      if (none) none.classList.toggle('d-none', any);
      var help = document.querySelector('[data-rate-help]');
      if (help) {
        var c = workBoxes[0] && workBoxes[0].checked;
        var p = workBoxes[1] && workBoxes[1].checked;
        help.textContent = c && p ? 'Day rate between 200 and 3,000 for contract work; annual salary for permanent roles.'
          : c ? 'Day rate between 200 and 3,000.'
            : p ? 'Your expected annual salary.' : '';
      }
    };
    workBoxes.forEach(function (box) { if (box) box.addEventListener('change', syncRates); });
    syncRates();

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
    /*
     * "Unsaved" means the form differs from what was loaded — not that something was touched.
     * Ticking Permanent and unticking it again is no change, so the note goes away. FormData
     * of the profile form holds exactly what Save would post: fields tied to the row forms
     * (form="certAddForm" …) belong to those forms and are not in it, and a search box finds
     * something without changing anything.
     */
    var dirty = false;
    var note = document.querySelector('[data-unsaved-note]');
    var cleanNote = note ? note.textContent : '';
    var serializeProfile = function () {
      var parts = [];
      new FormData(profileForm).forEach(function (value, key) {
        if (key === '_csrf' || key === 'tab' || typeof value !== 'string') return;
        var field = profileForm.elements[key];
        if (field && field.type === 'search') return;
        parts.push(key + '=' + value);
      });
      return parts.join('&');
    };
    var snapshot = null;
    var checkDirty = function (event) {
      if (snapshot === null) return;
      if (event && event.target && event.target.type === 'search') return;
      dirty = serializeProfile() !== snapshot;
      if (note) {
        note.textContent = dirty ? 'You have unsaved changes.' : cleanNote;
        note.classList.toggle('is-dirty', dirty);
      }
    };
    profileForm.addEventListener('input', checkDirty);
    profileForm.addEventListener('change', checkDirty);
    // Taken once everything else on the page has set itself up (rows, the countries picker).
    setTimeout(function () { snapshot = serializeProfile(); }, 0);
    profileForm.addEventListener('submit', function () { dirty = false; });
    // Adding a row or switching listing reloads the page: say so if the profile has edits.
    Array.prototype.forEach.call(document.querySelectorAll('form[id]'), function (f) {
      if (f === profileForm || !/^(certAddForm|projAddForm|expAddForm|removeForm|visibilityForm|docUploadForm|projEdit-|expEdit-)/.test(f.id)) return;
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
    // A link that opens a section and puts the cursor in one of its fields.
    document.querySelectorAll('[data-focus]').forEach(function (a) {
      a.addEventListener('click', function (event) {
        var target = document.getElementById(a.getAttribute('data-focus'));
        var sec = target && target.closest('[data-tab]');
        if (!sec) return;
        event.preventDefault();
        showTab(sec.getAttribute('data-tab'), false);
        target.focus();
      });
    });

    document.querySelectorAll('[data-char-count]').forEach(function (field) {
      var out = document.querySelector(field.getAttribute('data-char-count'));
      if (!out) return;
      field.addEventListener('input', function () { out.textContent = field.value.length; });
    });

    /*
     * Drag to reorder projects and experience. The handle makes its row draggable only while
     * it is held, so text inside the row can still be selected. The new order is posted as
     * the full list of ids; the server refuses anything that is not exactly the owner's
     * entries rearranged, and on any failure the page reloads to the saved order. The
     * up/down buttons do the same one step at a time, without scripting.
     */
    document.querySelectorAll('[data-sortable]').forEach(function (list) {
      var dragged = null;
      list.addEventListener('mousedown', function (event) {
        var handle = event.target.closest('[data-sortable-handle]');
        if (handle) handle.closest('[data-sortable-item]').setAttribute('draggable', 'true');
      });
      list.addEventListener('dragstart', function (event) {
        dragged = event.target.closest('[data-sortable-item]');
        if (!dragged) return;
        dragged.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragged.getAttribute('data-id'));
      });
      list.addEventListener('dragover', function (event) {
        var over = event.target.closest('[data-sortable-item]');
        if (!dragged || !over || over === dragged) return;
        event.preventDefault();
        list.querySelectorAll('.is-drop-target').forEach(function (el) { el.classList.remove('is-drop-target'); });
        over.classList.add('is-drop-target');
      });
      list.addEventListener('drop', function (event) {
        var over = event.target.closest('[data-sortable-item]');
        if (!dragged || !over || over === dragged) return;
        event.preventDefault();
        var items = Array.prototype.slice.call(list.querySelectorAll('[data-sortable-item]'));
        if (items.indexOf(dragged) < items.indexOf(over)) over.after(dragged); else over.before(dragged);
        var body = new URLSearchParams();
        list.querySelectorAll('[data-sortable-item]').forEach(function (el) { body.append('ids', el.getAttribute('data-id')); });
        apiFetch(list.getAttribute('data-sortable'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body
        }).then(function (r) { if (!r.ok) window.location.reload(); })
          .catch(function () { window.location.reload(); });
      });
      list.addEventListener('dragend', function () {
        list.querySelectorAll('.is-drop-target').forEach(function (el) { el.classList.remove('is-drop-target'); });
        if (dragged) { dragged.classList.remove('is-dragging'); dragged.removeAttribute('draggable'); }
        dragged = null;
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
  /*
   * The countries picker: a search box over the hidden checkbox list. The checkboxes remain
   * the only thing the form posts; chips, suggestions and the EU shortcut only tick and untick
   * them. Built from DOM nodes — country names come from a file, but there is no reason to
   * make that the one place markup is assembled from strings.
   */
  document.querySelectorAll('[data-country-picker]').forEach(function (picker) {
    var list = document.querySelector(picker.getAttribute('data-country-picker'));
    var fallback = document.querySelector('[data-country-fallback]');
    if (!list) return;
    var boxes = Array.prototype.slice.call(list.querySelectorAll('input[type="checkbox"]'));
    var nameOf = function (box) { var l = list.querySelector('label[for="' + box.id + '"]'); return l ? l.textContent.trim() : box.value; };
    var chips = picker.querySelector('[data-country-chips]');
    var search = picker.querySelector('[data-country-search]');
    var suggest = picker.querySelector('[data-country-suggest]');
    var counter = document.querySelector('[data-country-count]');
    var eu = (picker.getAttribute('data-eu') || '').split(',').filter(Boolean);
    var euBtn = picker.querySelector('[data-country-eu]');
    var mirror = picker.querySelector('[data-mirror]');
    var real = mirror ? document.querySelector(mirror.getAttribute('data-mirror')) : null;

    picker.classList.remove('d-none');
    if (fallback) fallback.classList.add('d-none');

    var changed = function () { profileForm && profileForm.dispatchEvent(new Event('input', { bubbles: true })); };
    var render = function () {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      var chosen = boxes.filter(function (b) { return b.checked; });
      chosen.forEach(function (box) {
        var chip = document.createElement('span');
        chip.className = 'country-chip';
        chip.appendChild(document.createTextNode(nameOf(box)));
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'country-chip-x';
        x.setAttribute('aria-label', 'Remove ' + nameOf(box));
        x.textContent = '×';
        x.addEventListener('click', function () { box.checked = false; render(); changed(); search.focus(); });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      if (counter) counter.textContent = String(chosen.length);
      if (euBtn) {
        var allEu = eu.length && eu.every(function (code) { return boxes.some(function (b) { return b.value === code && b.checked; }); });
        euBtn.classList.toggle('active', Boolean(allEu));
        euBtn.setAttribute('aria-pressed', allEu ? 'true' : 'false');
      }
    };
    var hideSuggest = function () { suggest.classList.add('d-none'); };
    var showSuggest = function () {
      var q = search.value.trim().toLowerCase();
      while (suggest.firstChild) suggest.removeChild(suggest.firstChild);
      if (!q) { hideSuggest(); return; }
      var matches = boxes.filter(function (b) { return !b.checked && nameOf(b).toLowerCase().indexOf(q) !== -1; })
        .sort(function (a, b) { return (nameOf(a).toLowerCase().indexOf(q) === 0 ? 0 : 1) - (nameOf(b).toLowerCase().indexOf(q) === 0 ? 0 : 1); })
        .slice(0, 8);
      if (!matches.length) {
        var none = document.createElement('li');
        none.className = 'country-suggest-empty';
        none.textContent = 'No country matches';
        suggest.appendChild(none);
      }
      matches.forEach(function (box) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'option');
        btn.textContent = nameOf(box);
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () {
          box.checked = true; search.value = ''; hideSuggest(); render(); changed(); search.focus();
        });
        li.appendChild(btn);
        suggest.appendChild(li);
      });
      suggest.classList.remove('d-none');
    };
    search.addEventListener('input', showSuggest);
    search.addEventListener('blur', function () { setTimeout(hideSuggest, 100); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        // Enter picks the first match instead of submitting the whole profile.
        e.preventDefault();
        var first = suggest.querySelector('button');
        if (first) first.click();
      } else if (e.key === 'Escape') {
        hideSuggest();
      } else if (e.key === 'Backspace' && !search.value) {
        var last = boxes.filter(function (b) { return b.checked; }).pop();
        if (last) { last.checked = false; render(); changed(); }
      }
    });
    if (euBtn) {
      euBtn.addEventListener('click', function () {
        var allEu = euBtn.getAttribute('aria-pressed') === 'true';
        boxes.forEach(function (b) { if (eu.indexOf(b.value) !== -1) b.checked = !allEu; });
        render(); changed();
      });
    }
    if (mirror && real) {
      mirror.addEventListener('change', function () { real.checked = mirror.checked; changed(); });
    }
    render();
  });

  /*
   * CV Generator: ticking a section or choosing a document refreshes the preview and the
   * download link in place. Without scripting the "Update preview" button submits the same
   * GET form and the page re-renders — same URL, same result. The preview is server-rendered
   * HTML from this origin (escaped by the template), never text from elsewhere.
   */
  var cvForm = document.querySelector('form[data-cv-generator]');
  if (cvForm) {
    var cvPreview = cvForm.querySelector('[data-cv-preview]');
    var cvDownload = cvForm.querySelector('[data-cv-download]');
    var cvSeq = 0;
    var cvQuery = function () {
      var params = new URLSearchParams();
      new FormData(cvForm).forEach(function (value, key) { params.append(key, value); });
      return params.toString();
    };
    var refreshCv = function () {
      var q = cvQuery();
      var seq = ++cvSeq;
      if (cvDownload) {
        cvDownload.href = '/cv-generator/download?' + q;
        var chosen = cvForm.querySelector('input[name="doc"]:checked');
        var label = chosen ? chosen.closest('label').querySelector('strong').textContent : 'CV';
        cvDownload.lastChild.textContent = ' Download ' + label;
      }
      history.replaceState(null, '', '/cv-generator?' + q + '#generate');
      cvPreview.classList.add('is-loading');
      fetch('/cv-generator/preview?' + q, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (html) {
          if (seq !== cvSeq) return; // a later choice already asked for a newer preview
          cvPreview.innerHTML = html;
        })
        .catch(function () { /* keep the last good preview; the button still reloads */ })
        .finally(function () { if (seq === cvSeq) cvPreview.classList.remove('is-loading'); });
    };
    cvForm.addEventListener('change', refreshCv);
  }

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
