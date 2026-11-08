'use strict';

/**
 * What "Salesforce news of the day" shows when the live feed has never been read in this
 * process — a fresh boot with the newsroom unreachable. services/salesforceNews.js reads the
 * real feed; this is only the floor under it.
 *
 * SAP Hub keeps three checked, dated headlines here. This keeps none, on purpose: a headline
 * written from memory is the thing most easily remembered wrong, and one shown on the front
 * page under "news" is a claim made in somebody else's name. So the floor is a pointer to the
 * newsroom itself, which is true whatever happened today, and the card says it is not the day's
 * headline.
 */
const FALLBACK_NEWS = Object.freeze([
  {
    title: 'The latest from the Salesforce Newsroom',
    summary: 'Today\'s headline could not be loaded just now. Salesforce\'s own newsroom has every announcement, dated, with the full story.',
    link: 'https://www.salesforce.com/news/',
    date: null,
    category: '',
    source: 'Salesforce Newsroom'
  }
]);

function assertSalesforceNewsIntegrity() {
  FALLBACK_NEWS.forEach((item) => {
    ['title', 'summary', 'link', 'source'].forEach((field) => {
      if (typeof item[field] !== 'string' || !item[field]) throw new Error(`Salesforce news fallback "${item.title}" has no ${field}`);
    });
    if (!/^https:\/\/([a-z0-9-]+\.)*salesforce\.com\//.test(item.link)) {
      throw new Error(`Salesforce news fallback "${item.title}" must link to salesforce.com over https`);
    }
    if (item.date !== null && Number.isNaN(Date.parse(item.date))) {
      throw new Error(`Salesforce news fallback "${item.title}" has an unreadable date`);
    }
  });
  return true;
}

module.exports = { FALLBACK_NEWS, assertSalesforceNewsIntegrity };
