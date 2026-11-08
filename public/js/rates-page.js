/*
 * /rates: small conveniences over a page that works without them.
 *
 *  - The trend and job-budget filters apply on change (without scripting, a Show button).
 *  - "Save scenario" copies the page's own URL: the benchmark lives entirely in the query
 *    string, so the link IS the scenario and nothing is stored anywhere.
 *  - "Export PDF" opens the print dialog; the print stylesheet keeps only the benchmark.
 *  - The share form's amount label follows Contract / Permanent.
 * No fetch, no innerHTML.
 */
(function () {
  'use strict';

  function start() {
    document.querySelectorAll('form.rates-autosubmit select').forEach(function (select) {
      select.addEventListener('change', function () { select.form.submit(); });
    });

    var save = document.querySelector('[data-rates-save]');
    var print = document.querySelector('[data-rates-print]');
    var saved = document.querySelector('[data-rates-saved]');
    if (save) {
      save.hidden = false;
      save.addEventListener('click', function () {
        var url = window.location.href.split('#')[0] + '#benchmark';
        var done = function () { if (saved) saved.hidden = false; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link to reopen the scenario:', url); });
        } else {
          window.prompt('Copy this link to reopen the scenario:', url);
        }
      });
    }
    if (print) {
      print.hidden = false;
      print.addEventListener('click', function () {
        document.body.classList.add('rates-printing');
        window.print();
      });
      window.addEventListener('afterprint', function () { document.body.classList.remove('rates-printing'); });
    }

    var engagement = document.getElementById('s-engagement');
    var label = document.getElementById('s-amount-label');
    if (engagement && label) {
      engagement.addEventListener('change', function () {
        label.textContent = engagement.value === 'permanent' ? 'Annual salary (EUR)' : 'Day rate (EUR)';
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
