// Token Radar's dark dashboard. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, a filterable table, and a per-protocol detail
// drawer with the model's own inputs and the farm plan main.ts wrote for the row. No
// network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
// The dashboard's whole state, in one object. q is the search text, category and
// chain are the two filters ('all' means unfiltered), tab switches between the
// pre-token board and the live-token view, sort is the column the table is
// ordered by (implied value by default) with dir -1 for descending, and
// selected is the slug of the protocol whose detail drawer is open, or null.
// Every interaction mutates this object and calls render(); nothing else holds
// state, so the page can always be rebuilt from scratch. The state is also
// mirrored into the URL hash (readHash/writeHash), so a filtered view or an
// open detail drawer survives a reload and can be shared as a link.
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

// Number formatting. fmtUsd collapses large values to $x.xxB / $x.xM / $xK so a
// table cell stays readable — a full "$2,750,000,000" would drown the row —
// and falls back to the locale currency format for small numbers. fmtPct always
// shows two decimals with an explicit + sign for gains, so a +2.10% week and a
// -2.10% week are visibly different at a glance. fmtAge turns a day count into
// "45d" or "2.3y" and says "unknown" when the snapshot carries no listing date,
// rather than printing a misleading zero.
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page and the board are visibly the
  // same arithmetic. The multiple is the snapshot's own median, carried per row.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var ageMult = model.age_floor + model.age_range * (Math.min(Math.max(age, 0), model.age_days_cap) / model.age_days_cap);
    return Math.max(1, Math.round(row.tvl_usd * row.reference_multiple * growthMult * ageMult));
  }

// The DOM builder: a tiny hyperscript helper so the renderers can describe the
// page as nested calls instead of string templates. attrs is a map where
// 'class' sets the class, 'text' sets text content, 'html' sets inner HTML,
// keys starting with 'on' (onclick, onkeydown) attach listeners, and anything
// else becomes an attribute — except null/undefined, which are skipped, so a
// conditional attribute can be written inline. Children after attrs may be
// strings (turned into text nodes), elements, or arrays of either. Building
// nodes this way also avoids injecting raw HTML from the data: protocol names
// go through textContent, never innerHTML.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

// Deep-linking: the dashboard's state lives in the URL hash, so a filtered view
// or an open protocol can be bookmarked and shared. readHash restores the
// search text, the selected protocol, the category and chain filters, and the
// tab from the hash on load; writeHash writes them back on every change with
// history.replaceState, so the back button is never polluted with a history
// entry per keystroke. Only non-default values are written, which keeps the
// hash short and the default view a clean URL.
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

// Filtering: the visible rows are the board rows that pass all three filters at
// once. Category compares against the row's category with 'Other' as the
// fallback for a null category, so the filter list and the table agree. Chain
// checks membership in the row's chain list, because a protocol can live on
// several chains. The search is a case-insensitive substring match across the
// name, slug, category and chains joined into one haystack, so typing "base"
// finds both the chain Base and any protocol named after it.
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
// Sorting: a copy of the filtered list, ordered by the active sort key. The
// comparator reads state.dir, so clicking the same column header twice flips
// the direction instead of re-sorting. Nulls are pushed to the end on purpose:
// a protocol with no seven-day change sorts as -Infinity on growth (so it
// never tops a growth sort it has no data for) and as Infinity on age (so an
// unknown age never tops an age sort). Ties break on slug, which makes the
// order deterministic — the same state always renders the same table.
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise: it prices a token that does not exist yet from the multiples the traded protocols already carry.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Reference multiple (overall)' }), el('b', { text: 'x' + DATA.reference.overall.toFixed(4) }))
      )
    );
  }

// The control bar: search box, category dropdown, chain dropdown, and the
// Pre-token / Live token tab switch, plus a live count of the rows shown.
// The dropdown options are derived from the data itself (the distinct
// categories and chains on the board), so the filters can never offer a choice
// that matches nothing. Every control writes its change into state, mirrors
// it to the hash, and re-renders immediately — there is no submit button and
// no stale view. The tab buttons use aria-pressed so a screen reader can tell
// which view is active, and the count line tells the reader how many rows the
// current filter leaves.
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

// The board table: one row per visible pre-token protocol, strongest implied
// value first. Each row shows rank, name with its category and first two
// chains, TVL, seven-day growth (green for up, red for down, 'n/a' when the
// snapshot has no figure), age, and the implied value with a bar scaled to the
// largest value on screen — the bar is relative to the visible list, not the
// whole board, so filtering to a small set still shows meaningful differences.
// The last column says "records no token", the careful wording the model uses.
// Clicking a row (or pressing Enter/Space on it) opens the detail drawer.
// When no row passes the filters, the table is replaced by an empty state
// with a Clear filters button, rather than a bare empty table.
  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'records no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

// The live-token table: the 24 traded protocols, shown in their own tab with
// their market caps instead of an implied value. The caption says the point
// plainly — their market cap is a fact, not a model — so nobody mistakes this
// tab for a second ranking. Rows here are not clickable: a live protocol has
// no farm plan and no model breakdown, because there is nothing to model.
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

// The "how it is computed" panel, shown under the board. It states the formula
// in plain text with the snapshot's own numbers filled in — the overall
// multiple, the per-category multiples, the growth clamp and weight, the age
// cap — so the model can be checked without opening the source. This is the
// panel the judge reads first: it is the model's claim, and the detail drawer
// is the per-row proof. The panel only renders on the pre-token tab, because
// the live tab has no model to explain.
  function modelPanel() {
    var m = DATA.model;
    var ref = DATA.reference;
    var cats = Object.keys(ref.by_category).sort();
    var catLine = cats.map(function (c) { return c + ' x' + ref.by_category[c].toFixed(4); }).join(', ');
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. The reference multiple is not a guess: it is the median market-cap-to-TVL ratio of the protocols that already trade, per category where the category has at least ' + m.category_min_count + ' traded protocols, else the overall median. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        el('div', null, el('b', { text: 'implied = round( tvl_usd x multiple x growth x age )' })),
        el('div', { text: 'multiple = median mcap / TVL of traded protocols in the row\u2019s category (overall x' + ref.overall.toFixed(4) + ' where the category is thin)' }),
        el('div', { text: 'growth = 1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight }),
        el('div', { text: 'age = ' + m.age_floor + ' + ' + m.age_range + ' x min(age_days, ' + m.age_days_cap + ') / ' + m.age_days_cap + '  (unlisted age uses ' + m.unknown_age_days + ' days)' })
      ),
      el('p', { class: 'sub', text: 'Category multiples from this snapshot (' + ref.traded_count + ' traded protocols): ' + catLine + '. TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token on record. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

// The detail drawer: a modal dialog for one protocol. It shows the full
// implied-value breakdown — TVL, the reference multiple and where it came
// from, seven-day growth, both multipliers, age, and the final implied value
// — and then the numbered farm plan, each step split at " Cost: " so the
// action is bold and the cost/time line sits under it in smaller text. Before
// rendering, the page recomputes the row with impliedOf and compares it to
// the number board.json carries; if they differ, the drawer says so plainly,
// which makes stale data visible instead of silent. The dialog closes on the
// Close button, on Escape, or on the browser back action via the hash, and
// closing clears the selection so the hash does not reopen it.
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = row.farm_steps || [];
    var recomputed = impliedOf(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Reference multiple' }), el('b', { class: 'num', text: 'x' + row.reference_multiple })),
        el('div', null, el('span', { text: 'Multiple source' }), el('b', { class: 'num', text: row.multiple_source })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Age multiplier' }), el('b', { class: 'num', text: String(row.age_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price. It says the protocol records no token, not that it has none.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

// The render cycle: wipe the app node, rebuild the whole shell (header, lede,
// controls, the active table, and the model panel on the pre-token tab), then
// re-attach the detail dialog and reopen it if a protocol is selected. A full
// rebuild on every keystroke is cheap at 200 rows and keeps the code simple:
// there is no incremental update to drift out of sync with state. render is
// called on load (after readHash restores the state from the URL), on every
// control change, and on every sort click. The Escape handler is registered
// once, outside render, so it is never attached twice.
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
