/* eslint-env browser */
(function () {
  'use strict';

  var root = document.querySelector('[data-assistant]');
  if (!root) return; // Not configured on this deployment; the markup is not emitted.

  var launcher = root.querySelector('[data-assistant-launcher]');
  var panel = root.querySelector('[data-assistant-panel]');
  var messagesEl = root.querySelector('[data-assistant-messages]');
  var chipsEl = root.querySelector('[data-assistant-chips]');
  var form = root.querySelector('[data-assistant-form]');
  var input = root.querySelector('[data-assistant-input]');
  var closeBtn = root.querySelector('[data-assistant-close]');
  if (!launcher || !panel || !messagesEl || !form || !input) return;

  var STORAGE_KEY = 'sfAssistantHistory';
  var MAX_TURNS = 12;
  var GREETING =
    'Hi — I can help you find your way around: jobs, consultants, the rate index, '
    + 'the scope estimator and the community. What are you looking for?';
  var ERROR_FALLBACK = 'Something went wrong. Please try again in a moment.';

  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  var waiting = false;
  var typingEl = null;

  /*
   * History lives here, in the visitor's own browser, and is posted back with each
   * message. There is no server-side conversation table: storing transcripts would mean
   * holding whatever people type into a support box, indefinitely, for a feature that
   * answers questions about public pages. sessionStorage rather than localStorage so it
   * ends with the tab.
   */
  function loadHistory() {
    try {
      var parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-MAX_TURNS) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_TURNS)));
    } catch (e) {
      /* private mode, or storage full — the conversation just will not persist */
    }
  }

  var history = loadHistory();

  /* ------------------------------------------------------------ safe rendering */

  /*
   * Hrefs are restricted to same-origin RELATIVE paths: must start with a single '/',
   * no scheme, no protocol-relative '//'. A model reply is untrusted output — it can be
   * steered by whatever the visitor typed — so a link it produces must not be able to
   * leave this origin. Anything that fails this test is rendered as plain text.
   */
  var SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/]*(?:\?[A-Za-z0-9\-._~=&]*)?(?:#[A-Za-z0-9\-._~]*)?$/;

  function appendLink(parent, label, href) {
    if (!SAFE_PATH.test(href)) {
      parent.appendChild(document.createTextNode(label));
      return;
    }
    var a = document.createElement('a');
    a.href = href;
    a.className = 'sf-assistant-link';
    a.textContent = label;
    parent.appendChild(a);
  }

  /** A bare site path written in prose becomes a link: "see /jobs." */
  function appendLinkified(parent, text) {
    var pathRe = /(^|[\s(])(\/[a-z][a-z0-9\-_]*(?:\/[a-z0-9\-_]+)*)/gi;
    var last = 0;
    var m;
    while ((m = pathRe.exec(text)) !== null) {
      var pathStart = m.index + m[1].length;
      parent.appendChild(document.createTextNode(text.slice(last, pathStart)));
      appendLink(parent, m[2], m[2]);
      last = pathStart + m[2].length;
    }
    parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /** **bold** runs, with paths inside them still linkified. */
  function appendRichText(parent, text) {
    var boldRe = /\*\*([^*\n]{1,120})\*\*/g;
    var last = 0;
    var m;
    while ((m = boldRe.exec(text)) !== null) {
      appendLinkified(parent, text.slice(last, m.index));
      var strong = document.createElement('strong');
      appendLinkified(strong, m[1]);
      parent.appendChild(strong);
      last = m.index + m[0].length;
    }
    appendLinkified(parent, text.slice(last));
  }

  /** One line: [label](/path) links, then bare paths, then bold. */
  function renderInline(parent, text) {
    var mdLinkRe = /\[([^\]\n]{1,100})\]\((\/[^\s)]{0,200})\)/g;
    var last = 0;
    var m;
    while ((m = mdLinkRe.exec(text)) !== null) {
      appendRichText(parent, text.slice(last, m.index));
      appendLink(parent, m[1], m[2]);
      last = m.index + m[0].length;
    }
    appendRichText(parent, text.slice(last));
  }

  /*
   * THE rule of this file: a reply is assembled from createElement and createTextNode and
   * NEVER from innerHTML. The model's output is attacker-influenceable text; the moment it
   * is parsed as markup, a prompt-injected reply becomes stored XSS on every page of the
   * site. Rendering markdown "just for links" through innerHTML is exactly how that
   * happens, which is why the link path above builds an anchor node and validates its href
   * instead.
   */
  function renderAssistantText(bubble, text) {
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      if (i > 0) bubble.appendChild(document.createTextNode('\n'));
      var heading = lines[i].match(/^#{1,4}\s+(.*)$/);
      if (heading) {
        var strong = document.createElement('strong');
        renderInline(strong, heading[1]);
        bubble.appendChild(strong);
      } else {
        renderInline(bubble, lines[i]);
      }
    }
  }

  function appendBubble(role, text) {
    var bubble = document.createElement('div');
    bubble.className = 'sf-assistant-msg sf-assistant-msg-' + (role === 'user' ? 'user' : 'assistant');
    if (role === 'assistant') {
      renderAssistantText(bubble, String(text));
    } else {
      // What the visitor typed is never anything but text.
      bubble.textContent = text;
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  /* ------------------------------------------------------------------- plumbing */

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'sf-assistant-msg sf-assistant-msg-assistant sf-assistant-typing';
    typingEl.setAttribute('aria-label', 'The assistant is typing');
    for (var i = 0; i < 3; i += 1) {
      var dot = document.createElement('span');
      dot.className = 'sf-assistant-dot';
      typingEl.appendChild(dot);
    }
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  function updateChips() {
    if (chipsEl) chipsEl.hidden = history.length > 0;
  }

  function paintHistory() {
    messagesEl.textContent = '';
    if (!history.length) {
      appendBubble('assistant', GREETING);
    } else {
      history.forEach(function (entry) {
        appendBubble(entry.role, entry.content);
      });
    }
    updateChips();
  }

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    paintHistory();
    input.focus();
  }

  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  function sendMessage(text) {
    var message = String(text || '').trim();
    if (!message || waiting) return;

    waiting = true;
    appendBubble('user', message);
    history.push({ role: 'user', content: message });
    saveHistory();
    updateChips();
    input.value = '';
    showTyping();

    fetch('/assistant/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ message: message, history: history.slice(-MAX_TURNS, -1) })
    })
      .then(function (response) {
        return response.json().catch(function () {
          return { success: false };
        });
      })
      .then(function (data) {
        hideTyping();
        if (data && data.success && data.reply) {
          appendBubble('assistant', data.reply);
          history.push({ role: 'assistant', content: data.reply });
          saveHistory();
          return;
        }
        /*
         * A refusal is shown as the assistant's own message rather than as an error
         * banner. "The assistant has reached its budget for this month" is an answer the
         * visitor can act on; a red box saying "502" is not.
         */
        appendBubble('assistant', (data && data.error) || ERROR_FALLBACK);
      })
      .catch(function () {
        hideTyping();
        appendBubble('assistant', ERROR_FALLBACK);
      })
      .then(function () {
        waiting = false;
        input.focus();
      });
  }

  launcher.addEventListener('click', function () {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    sendMessage(input.value);
  });

  if (chipsEl) {
    chipsEl.addEventListener('click', function (event) {
      var chip = event.target.closest('.sf-assistant-chip');
      if (chip) sendMessage(chip.textContent);
    });
  }
})();
