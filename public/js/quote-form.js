/* eslint-env browser */
/*
 * The estimate form (/quotes/new): steps, the collapsible scope list and its search, the
 * review summary, and the running total.
 *
 * Progressive enhancement only. Without this file the page is one long form that submits and
 * validates on the server exactly as it does with it. Nothing here computes a figure: the
 * running total is POST /quotes/preview, the same engine the save uses.
 */
(function () {
  'use strict';

  var form = document.querySelector('form[data-quote-form]');
  if (!form) return;

  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ------------------------------------------------------------------ steps */

  var panels = $$('[data-step]', form);
  var tabs = $$('[data-goto-step]');
  var stepBar = $('[data-quote-steps]');
  var current = 1;

  if (stepBar) stepBar.hidden = false;
  $$('[data-step-nav]', form).forEach(function (nav) { nav.hidden = false; });
  $$('.quote-step-nav-final [data-prev-step]', form).forEach(function (b) { b.hidden = false; });
  // Validation is done step by step below; native validation cannot focus a field in a
  // hidden step and would refuse the submit with nothing visible to explain why.
  form.noValidate = true;

  function fieldsOf(panel) {
    return $$('input, select, textarea', panel).filter(function (el) { return el.willValidate; });
  }

  function firstInvalid(panel) {
    return fieldsOf(panel).find(function (el) { return !el.checkValidity(); }) || null;
  }

  function hasScope() {
    return $$('input[name="families"]:checked, input[name="modules"]:checked, input[name="isvs"]:checked', form).length > 0 ||
      ($('#other_modules', form).value || '').trim() !== '';
  }

  var scopeRequired = $('[data-scope-required]', form);

  /** The first step, up to `upTo`, that is not ready — or 0 when all of them are. */
  function blockingStep(upTo) {
    for (var n = 1; n <= upTo; n += 1) {
      var panel = panels[n - 1];
      if (firstInvalid(panel)) return n;
      if (n === 2 && !hasScope()) return n;
    }
    return 0;
  }

  function explain(step) {
    var panel = panels[step - 1];
    var bad = firstInvalid(panel);
    if (bad) { bad.reportValidity(); return; }
    if (step === 2 && scopeRequired) {
      scopeRequired.hidden = false;
      scopeRequired.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function show(step, options) {
    var scroll = !options || options.scroll !== false;
    current = step;
    panels.forEach(function (p, i) { p.hidden = i + 1 !== step; });
    tabs.forEach(function (t) {
      var n = Number(t.getAttribute('data-goto-step'));
      t.classList.toggle('is-current', n === step);
      t.classList.toggle('is-done', n < step);
      if (n === step) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current');
    });
    if (step === 4) fillReview();
    if (scroll && stepBar) stepBar.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function go(target) {
    if (target > current) {
      var blocked = blockingStep(target - 1);
      if (blocked) { show(blocked); explain(blocked); return; }
    }
    show(target);
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { go(Number(t.getAttribute('data-goto-step'))); });
  });
  $$('[data-next-step]', form).forEach(function (b) {
    b.addEventListener('click', function () { go(current + 1); });
  });
  $$('[data-prev-step]', form).forEach(function (b) {
    b.addEventListener('click', function () { go(current - 1); });
  });

  form.addEventListener('submit', function (event) {
    var blocked = blockingStep(4);
    if (blocked) {
      event.preventDefault();
      show(blocked);
      explain(blocked);
    }
  });

  /* ------------------------------------------------------- scope: collapse and search */

  var clouds = $$('[data-scope-cloud]', form);

  function updateCloud(cloud) {
    var boxes = $$('[data-scope-modules] input[name="modules"]', cloud);
    var picked = boxes.filter(function (b) { return b.checked; }).length;
    var count = $('[data-scope-count]', cloud);
    if (count) count.textContent = picked ? picked + ' of ' + boxes.length + ' modules' : boxes.length + ' modules';
    cloud.classList.toggle('has-picks', picked > 0 || $('[data-scope-family]', cloud).checked);
  }

  function setOpen(cloud, open) {
    cloud.setAttribute('data-open', open ? '1' : '');
    var toggle = $('[data-scope-toggle]', cloud);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('[data-scope-modules]', cloud).hidden = !open;
  }

  clouds.forEach(function (cloud) {
    var toggle = $('[data-scope-toggle]', cloud);
    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', function () { setOpen(cloud, cloud.getAttribute('data-open') !== '1'); });
    }
    setOpen(cloud, cloud.getAttribute('data-open') === '1');
    updateCloud(cloud);
    // Ticking the cloud opens its modules: that is the moment somebody wants to pick them.
    $('[data-scope-family]', cloud).addEventListener('change', function (e) {
      if (e.target.checked) setOpen(cloud, true);
      updateCloud(cloud);
    });
    $$('input[name="modules"]', cloud).forEach(function (b) {
      b.addEventListener('change', function () { updateCloud(cloud); });
    });
  });

  var search = $('[data-scope-search]', form);
  var emptyNote = $('[data-scope-empty]', form);
  var isvItems = $$('[data-scope-isvs] [data-scope-item]', form);

  function textOf(el) { return (el.getAttribute('data-search-text') || '').toLowerCase(); }

  function applySearch() {
    var q = (search.value || '').trim().toLowerCase();
    var anyVisible = false;
    clouds.forEach(function (cloud) {
      var items = $$('[data-scope-modules] [data-scope-item]', cloud);
      var modulesBox = $('[data-scope-modules]', cloud);
      if (!q) {
        cloud.hidden = false;
        items.forEach(function (i) { i.hidden = false; });
        modulesBox.hidden = cloud.getAttribute('data-open') !== '1';
        anyVisible = true;
        return;
      }
      var cloudHit = textOf($('label[data-search-text]', cloud)).indexOf(q) !== -1;
      var hits = items.filter(function (i) { return textOf(i).indexOf(q) !== -1; });
      cloud.hidden = !cloudHit && hits.length === 0;
      items.forEach(function (i) { i.hidden = !cloudHit && hits.indexOf(i) === -1; });
      // A match inside a cloud is shown, whatever the cloud's own open state.
      modulesBox.hidden = cloud.hidden || (!hits.length && cloud.getAttribute('data-open') !== '1');
      if (!cloud.hidden) anyVisible = true;
    });
    isvItems.forEach(function (i) {
      i.hidden = Boolean(q) && textOf(i).indexOf(q) === -1;
      if (!i.hidden) anyVisible = true;
    });
    if (emptyNote) emptyNote.hidden = !q || anyVisible;
  }

  if (search) {
    search.addEventListener('input', applySearch);
    // Enter in the search box must not submit the whole estimate.
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  }

  /* ------------------------------------------------------------ the running total */

  var daysEl = $('[data-total-days]');
  var budgetEl = $('[data-total-budget]');
  var noteEl = $('[data-preview-note]');
  var bar = $('[data-total-bar]');
  var barText = $('[data-total-bar-text]');
  var lastPreview = null;
  var timer = null;
  var inFlight = 0;

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency, notation: 'compact', maximumFractionDigits: 1 }).format(amount);
    } catch (e) {
      return currency + ' ' + Math.round(amount).toLocaleString('en-GB');
    }
  }

  function counts() {
    ['families', 'modules', 'isvs'].forEach(function (name) {
      var item = $('[data-count="' + name + '"]');
      if (!item) return;
      var n = $$('input[name="' + name + '"]:checked', form).length;
      item.textContent = '';
      var strong = document.createElement('span');
      strong.textContent = String(n);
      item.appendChild(strong);
      item.appendChild(document.createTextNode(' ' + item.getAttribute(n === 1 ? 'data-one' : 'data-many')));
    });
  }

  function render(data) {
    lastPreview = data;
    if (!data || data.empty) {
      daysEl.textContent = '—';
      budgetEl.textContent = 'Pick a cloud, module or add-on to see a figure.';
      if (bar) bar.hidden = true;
    } else {
      var days = data.totalManDays.toLocaleString('en-GB') + ' man-days';
      var budget = '~' + money(data.totalBudget, data.currency);
      daysEl.textContent = days;
      budgetEl.textContent = budget + ' · about ' + data.projectDurationWeeks + ' weeks';
      if (bar && barText) { barText.textContent = days + ' · ' + budget; bar.hidden = false; }
    }
    if (current === 4) fillReview();
  }

  function refresh() {
    counts();
    if (scopeRequired && hasScope()) scopeRequired.hidden = true;
    var seq = ++inFlight;
    fetch('/quotes/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form))
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        if (seq !== inFlight) return; // an older answer arriving after a newer one
        if (noteEl) noteEl.classList.remove('text-warning-strong');
        render(data);
      })
      .catch(function () {
        if (seq !== inFlight || !noteEl) return;
        // Keep the last figure rather than blanking it; the saved estimate is unaffected.
        noteEl.textContent = 'The running total could not update just now. Calculate estimate still works.';
        noteEl.classList.add('text-warning-strong');
      });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 350);
  }

  form.addEventListener('change', schedule);
  form.addEventListener('input', function (e) {
    if (e.target === search) return;
    if (e.target.type === 'number' || e.target.tagName === 'TEXTAREA') schedule();
  });
  refresh();

  /* ------------------------------------------------------------------- review */

  function labelsOf(name, attr) {
    return $$('input[name="' + name + '"]:checked', form).map(function (b) {
      if (attr) return b.getAttribute(attr);
      var label = form.querySelector('label[for="' + b.id + '"]');
      return label ? (label.getAttribute('data-search-text') || label.textContent.trim()) : b.value;
    });
  }

  function listText(items, extra) {
    var all = items.concat(extra ? [extra] : []);
    return all.length ? all.join(', ') : 'None';
  }

  function valueOf(id) { var el = $('#' + id, form); return el ? (el.value || '').trim() : ''; }
  function chosenTitle(name) {
    var r = $('input[name="' + name + '"]:checked', form);
    var title = r ? form.querySelector('label[for="' + r.id + '"] .choice-card-title') : null;
    // The title's own text, without the multiplier printed beside it.
    return title && title.firstChild ? title.firstChild.textContent.trim() : '';
  }

  function setReview(key, text) {
    var dd = $('[data-review="' + key + '"]', form);
    if (dd) dd.textContent = text || '—';
  }

  function fillReview() {
    var company = valueOf('client_company');
    var contact = valueOf('client_name');
    setReview('client', [company, contact && '(' + contact + ')'].filter(Boolean).join(' '));
    setReview('project', valueOf('project_name'));
    setReview('families', listText(labelsOf('families')));
    setReview('modules', listText(labelsOf('modules', 'data-label'), valueOf('other_modules') && 'other: ' + valueOf('other_modules')));
    setReview('isvs', listText(labelsOf('isvs', 'data-label')));
    var n = Number(valueOf('number_of_integrations')) || 0;
    var cx = $('#integration_complexity', form);
    var integ = n ? n + ' × ' + cx.options[cx.selectedIndex].textContent.trim() : 'None';
    if (valueOf('other_integrations')) integ += '; other: ' + valueOf('other_integrations');
    setReview('integrations', integ);
    setReview('shape', [
      chosenTitle('complexity') + ' complexity',
      chosenTitle('customization_level') + ' customisation',
      valueOf('number_of_users') + ' users',
      valueOf('number_of_orgs') + ' org' + (valueOf('number_of_orgs') === '1' ? '' : 's'),
      valueOf('contingency_percentage') + '% contingency',
      valueOf('currency')
    ].join(' · '));
    var included = [];
    if ($('#include_training', form).checked) included.push('Training & adoption');
    if ($('#include_support', form).checked) included.push('Hypercare (' + valueOf('support_duration_days') + ' days)');
    setReview('included', included.length ? included.join(', ') : 'Neither — their share goes into build');

    var phasesBox = $('[data-review-phases]', form);
    var list = $('[data-review-phase-list]', form);
    if (phasesBox && list) {
      list.textContent = '';
      var phases = lastPreview && !lastPreview.empty ? lastPreview.phases : [];
      phases.forEach(function (p) {
        var li = document.createElement('li');
        li.textContent = p.name + ' — ' + p.days.toLocaleString('en-GB') + ' days';
        list.appendChild(li);
      });
      phasesBox.hidden = phases.length === 0;
    }
  }

  /* -------------------------------------------------------------------- start */

  show(Number(form.getAttribute('data-start-step')) || 1, { scroll: false });
})();
