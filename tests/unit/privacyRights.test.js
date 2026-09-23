'use strict';

const fs = require('fs');
const path = require('path');

const AccountErasure = require('../../models/AccountErasure');
const dataExport = require('../../services/dataExport');
const legal = require('../../config/legal');
const { PUBLIC_PATHS } = require('../../config/seoMeta');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('erasure destroys a person and keeps what is not theirs alone', () => {
  /*
   * The privacy policy said "ask us and your account and its data are removed" and there was
   * no route, no form and no address to ask at. A promise a system cannot keep is worse than
   * one it never made, because it is the sentence somebody relies on.
   *
   * The obvious implementation — DELETE the row, let 32 foreign keys cascade — is wrong three
   * ways, and each is a rule stated elsewhere in this codebase. These tests pin all three.
   */

  it('keeps the tables whose loss would break somebody else', () => {
    const kept = AccountErasure.RETAINED.map(([t]) => t).join(' ');

    // 1. A published percentile must not move because somebody left. CLAUDE.md: there is
    //    deliberately no path to remove a figure, and erasure must not become one.
    expect(kept).toMatch(/rate_submissions/);
    // 2. posts.reply_count is written in the same transaction as the row it counts and
    //    nothing recomputes it, so a cascading delete leaves other people's questions wrong.
    expect(kept).toMatch(/posts/);
    // 3. Financial records carry a statutory retention period. Erasure does not override it.
    expect(kept).toMatch(/payments/);

    for (const [table, why] of AccountErasure.RETAINED) {
      expect(typeof table).toBe('string');
      // Every retention has to carry its reason: this list is what the closure page shows
      // the person, and "we kept some things" is not an explanation.
      expect(why.length).toBeGreaterThan(30);
    }
  });

  it('purges the profile tables, and never a retained one', () => {
    for (const table of ['consultant_profiles', 'consultant_work_experiences', 'company_profiles', 'recruiter_profiles']) {
      expect(AccountErasure.PURGE).toContain(table);
    }
    // The photo and logo tables hold the BYTES keyed by user_id — deleting the profile row
    // does not reach them, and a photograph of a face is the least ambiguous personal data
    // on this site.
    for (const table of ['consultant_photos', 'company_logos', 'recruiter_logos']) {
      expect(AccountErasure.PURGE).toContain(table);
    }
    // Credentials and the LinkedIn subject, which identifies a named person elsewhere.
    for (const table of ['password_reset_tokens', 'external_identities']) {
      expect(AccountErasure.PURGE).toContain(table);
    }

    const retained = AccountErasure.RETAINED.flatMap(([t]) => t.split(',').map((x) => x.trim()));
    for (const table of AccountErasure.PURGE) {
      expect(retained).not.toContain(table);
    }
  });

  it('overwrites every identifying column on the account row', () => {
    const source = read('models/AccountErasure.js');
    const update = source.slice(source.indexOf('UPDATE users SET'), source.indexOf('WHERE id = ?', source.indexOf('UPDATE users SET')));

    // signup_ip is the one a reader forgets: an IP address is personal data on its own.
    for (const column of ['email', 'name', 'password_hash', 'gender', 'date_of_birth', 'signup_ip', 'signup_country']) {
      expect(update).toMatch(new RegExp(`\\b${column}\\s*=`));
    }
    expect(update).toMatch(/anonymised_at = NOW\(\)/);
    expect(update).toMatch(/is_active = 0/);
  });

  it('writes an address that can never route', () => {
    // RFC 2606 reserves .invalid precisely so that a placeholder cannot reach a real inbox.
    expect(AccountErasure.erasedEmail(12)).toMatch(/@.*\.invalid$/);
    expect(AccountErasure.erasedEmail(12)).not.toEqual(AccountErasure.erasedEmail(13));
  });

  it('is the only module that erases an account', () => {
    // Same rule as models/Moderation.js owning the hidden flags: a second eraser is a second
    // place that can forget a table, and the failure is silent — a name left in a row nobody
    // thought about.
    for (const dir of ['routes', 'services', 'models']) {
      for (const file of fs.readdirSync(path.join(ROOT, dir))) {
        if (file === 'AccountErasure.js') continue;
        const body = read(path.join(dir, file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(body).not.toMatch(/DELETE FROM users\b/);
        expect(body).not.toMatch(/anonymised_at\s*=\s*NOW/);
      }
    }
  });
});

describe('the data export answers Article 15 without creating a breach', () => {
  it('never exports a password hash, a token or an IP', () => {
    expect(dataExport.USER_COLUMNS).not.toMatch(/password_hash/);
    expect(dataExport.USER_COLUMNS).not.toMatch(/signup_ip/);
    for (const forbidden of ['password_hash', 'token', 'signup_ip']) {
      expect(dataExport.NEVER.has(forbidden)).toBe(true);
    }
  });

  it('lists the user columns explicitly rather than selecting everything', () => {
    // `SELECT *` here would export password_hash the moment somebody adds a column and
    // forgets this file exists. These files end up in inboxes.
    const source = read('services/dataExport.js');
    expect(source).toMatch(/SELECT \$\{USER_COLUMNS\} FROM users/);
    expect(source).not.toMatch(/SELECT \* FROM users/);
  });

  it('scopes every query to one account', () => {
    // An export that reaches another row is a privacy feature with a breach attached, which
    // is a worse outcome than not having built it.
    const source = read('services/dataExport.js').replace(/\/\*[\s\S]*?\*\//g, '');
    const selects = source.match(/SELECT[\s\S]*?`/g) || [];
    expect(selects.length).toBeGreaterThan(0);
    for (const q of selects) {
      expect(q).toMatch(/WHERE|\$\{USER_COLUMNS\}/);
    }
    // Only the person's own messages. The other party's words are the other party's data.
    expect(source).toMatch(/m\.sender_user_id = \?/);
  });
});

describe('the site can say who is responsible for the data', () => {
  it('invents nothing when the controller is unset', () => {
    expect(legal.controller.name).toBe(process.env.LEGAL_CONTROLLER_NAME || '');
    expect(legal.isConfigured()).toBe(Boolean(legal.controller.name && legal.controller.address));
  });

  it('names only the processors this deployment actually uses', () => {
    // A policy that names Stripe on a site with no Stripe key is inaccurate in the direction
    // that matters.
    expect(legal.activeProcessors({})).toEqual([]);
    const withAI = legal.activeProcessors({ ANTHROPIC_API_KEY: 'x' });
    expect(withAI.map((p) => p.name)).toEqual(['Anthropic']);
    expect(withAI[0].purpose).toMatch(/never sent your name/i);
  });

  it('the privacy policy covers what it is required to', () => {
    const page = read('views/legal/privacy.ejs');
    for (const required of [
      /Who is responsible/i,
      /How long it is kept/i,
      /Who else receives it/i,
      /Your rights/i,
      /data protection\s*\n?\s*authority/i
    ]) {
      expect(page).toMatch(required);
    }
    // And it must link the two rights the site can actually honour, not just describe them.
    expect(page).toMatch(/\/profile\/data/);
    expect(page).toMatch(/\/profile\/close/);
  });
});

describe('every public path has a page behind it', () => {
  it('nothing in PUBLIC_PATHS 404s', () => {
    /*
     * `/contact` sat in this list for the life of the project. robots.txt allowed it and the
     * sitemap handed it to search engines, and it 404'd because no route had ever been
     * written — which mattered more than a dead link, because the privacy policy said "ask
     * us" and this was the page that would have said how.
     */
    const routes = fs.readdirSync(path.join(ROOT, 'routes'))
      .map((f) => read(path.join('routes', f)))
      .join('\n');

    const missing = PUBLIC_PATHS.filter((p) => {
      if (p === '/') return !routes.includes("router.get('/'");
      // Mounted routers strip their prefix, so check the full path and the leaf.
      const leaf = '/' + p.split('/').slice(2).join('/');
      return !routes.includes(`'${p}'`) && !(leaf !== '/' && routes.includes(`'${leaf}'`));
    });
    expect(missing).toEqual([]);
  });
});

describe('the seed refuses to run against a live site', () => {
  it('guards on NODE_ENV before it touches a model', () => {
    const source = read('scripts/seed-data.js');
    const guard = source.indexOf('Refusing to seed');
    expect(guard).toBeGreaterThan(-1);
    // Before the models load, so it cannot half-run.
    expect(guard).toBeLessThan(source.indexOf("require('../models/User')"));
    expect(source).toMatch(/config\.isProduction/);
    expect(source).toMatch(/process\.exit\(1\)/);
    // The override is spelled out rather than any truthy value, so it cannot be set by
    // accident by an orchestrator exporting SEED_ALLOW_PRODUCTION=0.
    expect(source).toMatch(/SEED_ALLOW_PRODUCTION !== 'yes'/);
  });
});
