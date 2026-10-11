// Board View on the website. The page's own calls (live.js request) are answered from the robot
// cells' shared copy (TM5S tm5s_mcp/stand_sync.py), filtered and paged the way the cell's service does
// (tm5s_mcp/point_measurements.py overview and point). Robot commands are refused here.
// New results arrive by Realtime; after a lost connection or a sleeping tab the page asks for
// everything changed since the newest change it holds.
(function () {
  const ROBOT_ONLY = 'Robot actions run on the robot cell. This website shows saved boards and results.';
  const EDIT_ONLY = 'Changes to a board are made on a robot cell. This website shows saved boards and results.';
  // Every call Board View makes to a cell, and what the website does with it. tests/test_stand_sync.py
  // fails when the page makes a call listed in none of these (BV-359 and BV-360 were such calls).
  const ANSWERED = ['/api/boards', '/api/measurements', '/api/measurements/overview', '/api/measurements/point',
    '/api/golden-capture', '/api/app-verification', '/api/board-heights', '/api/test-plans', '/api/verification-selection'];
  const BOARD_EDITS = ['/api/component-name', '/api/pinout-orientation', '/api/part-not-tested', '/api/point-not-tested',
    '/api/small-parts/fix', '/api/small-parts/undo', '/api/vias/fix', '/api/vias/undo', '/api/test-points/fix', '/api/test-points/undo', '/api/corner-review'];
  const ROBOT_CALLS = ['/api/app-mode', '/api/measurements/start', '/api/measurements/reference', '/api/measurements/huntron',
    '/api/golden-capture/preview', '/api/golden-capture/continue', '/api/golden-capture/retest-flat', '/api/test-plans/prepare',
    '/api/test-plans/verify', '/api/test-plans/master', '/api/test-plans/preview', '/api/test-plans/save',
    '/api/test-plans/deliver', '/api/board-heights/save'];
  const OLD_RUN = 'A whole run record opens on the robot cell. Its readings are in Show saved points.';
  const IV_MESSAGE = 'Saved raw IV readings across all matching runs; reference acceptance is shown separately.';
  // Catch-up looks back this far: a row written just before the newest one seen may commit after it.
  // The live channel delivers changes a moment after it says it is connected (seen 2026-10-10: a change
  // in that moment waited for the safety pass), so a page catches up again READY_MS after connecting.
  const LOOK_BACK_MS = 5000, READY_MS = 3000, SAFETY_MS = 10000, CELL_STALE_MS = 10 * 60 * 1000;

  // ---- what the cell's service computes, done the same way here ---------------------------------
  function matchesQuery(row, query) {
    if (!query) return true;
    const label = String(row.label || '').toLowerCase();
    if (/^[0-9]+$/.test(query)) return (label.match(/[0-9]+/g) || []).some(n => Number(n) === Number(query));
    const alias = query.match(/^(tp|via|v)\s*([0-9]+)$/);
    if (alias) {
      const group = alias[1] === 'tp' ? 'test_point' : 'via', saved = label.match(/^(?:tp|via|v)\s*([0-9]+)$/);
      return row.group === group && !!saved && Number(saved[1]) === Number(alias[2]);
    }
    return ['label', 'group', 'component_id'].map(key => String(row[key] || '')).join(' ').toLowerCase().includes(query);
  }

  function overview(records, meta, params, board) {
    const side = params.get('side'), reference = params.get('reference_connection') || 'GND';
    const group = params.get('group') || 'test_point', groups = group === 'all' ? null : new Set(group.split(',').filter(Boolean));
    const traceFilter = params.get('trace_filter') || (params.get('flat_only') === 'true' ? 'flat' : 'all'), flatOnly = traceFilter === 'flat';
    const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 25), q = params.get('q') || '';
    const query = q.trim().toLowerCase();
    const summary = {points_total: 0, points_recorded: 0, points_complete: 0, points_missing: 0, points_excluded: 0,
      accepted_points: 0, run_count: 0, flat_points: 0, nonflat_points: 0};
    const runs = new Set(), rows = [], matching = [];
    for (const record of [...records].sort((a, b) => a.ord - b.ord)) {
      if (groups && !groups.has(record.grp)) continue;
      const row = record.row, latest = row.latest, valid = !!(latest && latest.complete && latest.validation?.state === 'valid');
      const attempts = row.attempts || [], nonflat = valid && !row.flat_traces;
      summary.points_total += 1;
      summary.points_recorded += latest != null;
      summary.points_complete += valid;
      summary.points_missing += latest == null && !row.excluded;
      summary.points_excluded += !!row.excluded;
      summary.accepted_points += attempts.some(entry => entry.accepted_reference);
      summary.flat_points += !!row.flat_traces && record.eligible;
      summary.nonflat_points += nonflat;
      for (const entry of attempts) if (entry.source === 'measurement' && entry.run_id) runs.add(entry.run_id);
      if ((traceFilter === 'all' || (flatOnly ? row.flat_traces : nonflat)) && matchesQuery(row, query)) {
        rows.push(row);
        if (record.eligible) matching.push(row);
      }
    }
    summary.run_count = runs.size;
    return {board, side, tool: 'huntron', kind: 'iv', reference_connection: reference, group, q, flat_only: flatOnly,
      trace_filter: traceFilter, summary, total: rows.length, offset, limit,
      matching_point_ids: matching.map(row => row.point_id), matching_count: matching.length,
      retest_settings: null, retest_blocker: ROBOT_ONLY, rows: rows.slice(offset, offset + limit),
      warnings: meta?.warnings || [], latest_capture: meta?.latest_capture || null, message: IV_MESSAGE};
  }

  function when(entry) { const at = Date.parse(entry.captured_at_utc); return Number.isNaN(at) ? -Infinity : at; }

  function point(stored, problems, params, board) {
    const side = params.get('side'), pointId = params.get('point_id') || '';
    const tool = params.get('tool') || 'huntron', kind = params.get('kind') || 'iv';
    const reference = params.get('reference_connection'), power = params.get('power_state');
    const runId = params.get('run_id'), sampleId = params.get('sample_id');
    if (!/^point-[0-9a-f]{32}$/.test(pointId)) throw new Error('Choose a saved permanent point identity, not its display number.');
    const fits = row => row.tool === tool && row.kind === kind && (reference == null || row.reference_connection === reference)
      && (power == null || row.power_state === power);
    const entries = stored.filter(fits).map(row => row.entry)
      .filter(entry => (runId == null || entry.run_id === runId) && (sampleId == null || entry.sample_id === sampleId))
      .sort((a, b) => when(b) - when(a) || String(b.sample_id || b.run_id || '').localeCompare(String(a.sample_id || a.run_id || '')));
    const latest = entries.find(entry => entry.has_reading) || null, reference_ = entries.find(entry => entry.accepted_reference) || null;
    const history = entries.map(entry => {
      const {reading, settings, point: saved, binding, ...rest} = entry;
      return {...rest, range_count: Array.isArray(reading?.ranges) ? reading.ranges.length : 0,
        mode_count: Array.isArray(reading?.modes) ? reading.modes.length : 0};
    });
    const upper = kind.toUpperCase();
    return {board, side, point_id: pointId, tool, kind, power_state: power ?? null, latest, reference: reference_, history,
      warnings: (problems || []).filter(fits).map(row => ({run_id: row.run_id, message: row.message})),
      message: latest ? 'Saved raw ' + upper + ' readings; reference acceptance is shown separately.'
        : ['mm', 'lcr'].includes(kind) ? 'No saved ' + upper + ' readings match this point and selected conditions.'
          : 'No saved IV traces match this permanent point identity.'};
  }

  function withoutRunLinks(value) {
    // A finished capture opens its whole run on the cell; here its readings show in Show saved points.
    if (Array.isArray(value)) return value.map(withoutRunLinks);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'measurement_run').map(([key, item]) => [key, withoutRunLinks(item)]));
  }

  if (typeof module !== 'undefined') { module.exports = {overview, point, matchesQuery, ANSWERED, BOARD_EDITS, ROBOT_CALLS}; return; }

  // ---- the shared copy, held in this tab ---------------------------------------------------------
  const C = window.TM5S_REMOTE_CONFIG, sb = window.supabase.createClient(C.url, C.anonKey), board = C.board;
  const snaps = new Map(), rowSets = new Map(), readingSets = new Map(), cells = new Map();
  let newest = null, online = false, revision = C.revision, tool = null, refreshing = null;

  function seen(at) { if (at && (!newest || at > newest)) newest = at; }
  function fail(error) {
    const message = error?.message || String(error);
    if (/JWT|permission denied|not authenticated/i.test(message)) location.href = 'index.html?next=' + encodeURIComponent(location.pathname + location.search);
    return new Error(message);
  }
  function remember(map, key, load) {
    if (!map.has(key)) map.set(key, load().catch(error => { map.delete(key); throw fail(error); }));
    return map.get(key);
  }
  function snapshot(stand, side, path) {
    return remember(snaps, [stand, side, path].join('|'), async () => {
      const {data, error} = await sb.from('snapshots').select('body,updated_at').eq('stand_id', stand).eq('side', side).eq('path', path).maybeSingle();
      if (error) throw error;
      seen(data?.updated_at);
      return data ? data.body : null;
    });
  }
  function rows(side, reference) {
    return remember(rowSets, side + '|' + reference, async () => {
      // The first page says how many there are; the rest are read at once, not one after another.
      const read = (from, count) => sb.from('point_rows').select('point_id,ord,grp,eligible,row,updated_at', count ? {count: 'exact'} : undefined)
        .eq('stand_id', board).eq('side', side).eq('reference_connection', reference).order('ord').range(from, from + 199);
      const first = await read(0, true);
      if (first.error) throw first.error;
      const rest = await Promise.all(Array.from({length: Math.max(0, Math.ceil((first.count || 0) / 200) - 1)}, (_, i) => read((i + 1) * 200)));
      const found = new Map();
      for (const page of [first, ...rest]) {
        if (page.error) throw page.error;
        for (const record of page.data) { found.set(record.point_id, record); seen(record.updated_at); }
      }
      return found;
    });
  }
  function readings(side, pointId) {
    return remember(readingSets, side + '|' + pointId, async () => {
      const {data, error} = await sb.from('readings').select('tool,kind,reference_connection,power_state,entry,updated_at')
        .eq('stand_id', board).eq('side', side).eq('point_id', pointId);
      if (error) throw error;
      data.forEach(row => seen(row.updated_at));
      return data;
    });
  }

  function viewerTool(saved, side) {
    const base = tool || {tool: 'huntron', power_state: 'off', reference_connection: saved?.reference_connection || 'GND'};
    return {...base, run: null, board, side, id: 'website', state: 'selected', reference_choices: ['GND', 'VCC'],
      message: 'Your choice on this website only. It does not change the robot cell.'};
  }

  async function request(url, body) {
    const address = new URL(url, location.href), path = address.pathname, params = address.searchParams, side = params.get('side');
    if (body) {
      if (path === '/api/verification-selection') return {selection: body.selection, saved: false};
      if (path === '/api/app-verification' && body.action === 'set_tool') {
        tool = {tool: body.tool, power_state: body.power_state || 'off', reference_connection: body.reference_connection || 'GND'};
        const saved = await snapshot(board, body.side, '/api/app-verification');
        return {run: withoutRunLinks(saved?.run ?? null), current_tool: viewerTool(saved?.current_tool, body.side)};
      }
      throw refuse(path);
    }
    if (path === '/api/boards') return (await snapshot('*', '*', '/api/boards')) || {boards: []};
    if (path === '/api/measurements') {
      if (params.get('run')) throw new Error(OLD_RUN);
      const saved = await snapshot(board, side, '/api/measurements');
      if (!saved) throw new Error('No saved runs have been shared for this side yet.');
      return saved;
    }
    if (path === '/api/measurements/overview') {
      if ((params.get('tool') || 'huntron') !== 'huntron' || (params.get('kind') || 'iv') !== 'iv') throw new Error('Saved signatures are available for the Huntron IV tool.');
      const reference = params.get('reference_connection') || 'GND';
      const [records, meta] = await Promise.all([rows(side, reference), snapshot(board, side, 'overview:' + reference)]);
      return overview(records.values(), meta, params, board);
    }
    if (path === '/api/measurements/point') {
      const [stored, problems] = await Promise.all([readings(side, params.get('point_id')), snapshot(board, side, 'problems')]);
      return point(stored, problems, params, board);
    }
    if (path === '/api/golden-capture') return {run: withoutRunLinks((await snapshot(board, side, '/api/golden-capture'))?.run ?? null)};
    if (path === '/api/app-verification') {
      const saved = await snapshot(board, side, '/api/app-verification');
      return {run: withoutRunLinks(saved?.run ?? null), current_tool: viewerTool(saved?.current_tool, side)};
    }
    if (path === '/api/board-heights') {
      const saved = await snapshot(board, side, '/api/board-heights');
      if (!saved) throw new Error('This side’s saved needle clearance has not been shared yet.');
      // The cell names its own photo file; here the same side's photo is the shared copy on the page.
      // The board view may still be drawing it when the clearance is first read.
      let photo = null;
      for (let wait = 0; !photo && wait < 50; wait++) {
        photo = document.querySelector('img[alt="' + side + '"]')?.src;
        if (!photo) await new Promise(done => setTimeout(done, 100));
      }
      return {...saved, photo_url: photo || null};
    }
    if (path === '/api/test-plans' && !params.get('plan')) {
      const saved = await snapshot(board, side, '/api/test-plans');
      if (!saved) throw new Error('This side’s saved tests have not been shared yet.');
      return saved;
    }
    if (![...ANSWERED, ...BOARD_EDITS, ...ROBOT_CALLS].includes(path)) console.error('The website does not know the call ' + path);
    return Promise.reject(new Error(BOARD_EDITS.includes(path) ? EDIT_ONLY : ROBOT_ONLY));
  }

  // A press the website refuses says why where the person is looking, not only in a panel's note.
  let flash = null;
  function refuse(path) {
    const text = BOARD_EDITS.includes(path) ? EDIT_ONLY : ROBOT_ONLY;
    flash = {text, until: Date.now() + 6000};
    say();
    setTimeout(say, 6100);
    return new Error(text);
  }

  // ---- keeping current ---------------------------------------------------------------------------
  function redraw(changed) {
    const view = window.boardMeasurements;
    if (!view) return;
    if (changed.readings || changed.rows) view.pointReadings?.clear();
    if (changed.rows && view.view?.state?.setupStep === 'signatures') view.loadSignatures(true);
    if (changed.runs) view.refresh();
    view.view?.setState({});
  }

  function applySnapshot(record) {
    const key = [record.stand_id, record.side, record.path].join('|');
    if (snaps.has(key)) snaps.set(key, Promise.resolve(record.body));
    seen(record.updated_at);
  }
  async function applyRow(record) {
    const key = record.side + '|' + record.reference_connection;
    if (rowSets.has(key)) (await rowSets.get(key).catch(() => new Map())).set(record.point_id, record);
    seen(record.updated_at);
  }

  async function catchUp() {
    if (!newest) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const since = new Date(Date.parse(newest) - LOOK_BACK_MS).toISOString(), changed = {};
      const [rowsFound, snapsFound, readingsFound] = await Promise.all([
        sb.from('point_rows').select('side,reference_connection,point_id,ord,grp,eligible,row,updated_at').eq('stand_id', board).gt('updated_at', since).limit(1000),
        sb.from('snapshots').select('stand_id,side,path,body,updated_at').in('stand_id', [board, '*']).gt('updated_at', since).limit(1000),
        sb.from('readings').select('side,point_id,updated_at').eq('stand_id', board).gt('updated_at', since).limit(1000)]);
      for (const found of [rowsFound, snapsFound, readingsFound]) if (found.error) throw fail(found.error);
      // The database answers at most 1,000 rows at once; a full answer may have left some out, so
      // the whole set is read again when next shown.
      if (rowsFound.data.length >= 1000) { rowSets.clear(); changed.rows = true; rowsFound.data = []; }
      if (readingsFound.data.length >= 1000) { readingSets.clear(); changed.readings = true; readingsFound.data = []; }
      if (snapsFound.data.length >= 1000) { snaps.clear(); changed.runs = changed.rows = true; snapsFound.data = []; }
      for (const record of rowsFound.data) { await applyRow(record); changed.rows = true; }
      for (const record of snapsFound.data) {
        applySnapshot(record);
        if (record.path === '/api/measurements') changed.runs = true;
        if (record.path.startsWith('overview:')) changed.rows = true;
      }
      for (const record of readingsFound.data) { readingSets.delete(record.side + '|' + record.point_id); seen(record.updated_at); changed.readings = true; }
      if (changed.rows || changed.runs || changed.readings) redraw(changed);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  let pending = null;
  function soon() { clearTimeout(pending); pending = setTimeout(() => catchUp().catch(() => {}), 250); }

  async function removed(table, old) {
    if (table === 'point_rows') {
      const key = old.side + '|' + old.reference_connection;
      if (rowSets.has(key)) (await rowSets.get(key).catch(() => new Map())).delete(old.point_id);
      redraw({rows: true});
    }
    if (table === 'readings') { for (const key of [...readingSets.keys()]) readingSets.delete(key); redraw({readings: true}); }
  }

  // ---- the one line that says when this page is not current --------------------------------------
  const line = document.createElement('div');
  line.id = 'stand-freshness';
  line.setAttribute('role', 'status');
  line.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:200;max-width:calc(100vw - 32px);' +
    'padding:10px 14px;border-radius:8px;background:#302719;border:1px solid #a4772b;color:#f6c177;font:14px Arial,sans-serif;' +
    'display:none;align-items:center;gap:12px;box-shadow:0 8px 30px #0008';
  function say() {
    let text = '', action = null;
    if (flash && Date.now() < flash.until) text = flash.text;
    else if (revision !== C.revision) { text = 'A newer version of this board was published.'; action = ['Reload', () => location.reload()]; }
    else if (!online) text = 'Offline · reconnecting. Results may be out of date.';
    else {
      for (const cell of cells.values()) {
        if (Date.now() - Date.parse(cell.updated_at) > CELL_STALE_MS) continue;
        if (cell.message) { text = 'Cell ' + cell.id + ' cannot send results: ' + cell.message; break; }
        if (cell.pending > 0) { text = 'Cell ' + cell.id + ': ' + cell.pending + ' changes waiting to upload.'; break; }
      }
    }
    line.replaceChildren(document.createTextNode(text));
    if (action) {
      const button = document.createElement('button');
      button.textContent = action[0]; button.onclick = action[1];
      button.style.cssText = 'min-height:44px;padding:8px 14px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;font:inherit;cursor:pointer';
      line.append(button);
    }
    line.style.display = text ? 'flex' : 'none';
    if (text && !line.isConnected) document.body?.append(line);
  }

  function listen() {
    sb.from('cells').select('*').then(({data}) => { (data || []).forEach(cell => cells.set(cell.id, cell)); say(); });
    sb.channel('stand-' + board)
      .on('postgres_changes', {event: '*', schema: 'public', table: 'point_rows', filter: 'stand_id=eq.' + board},
        change => change.eventType === 'DELETE' ? removed('point_rows', change.old) : soon())
      .on('postgres_changes', {event: '*', schema: 'public', table: 'readings', filter: 'stand_id=eq.' + board},
        change => change.eventType === 'DELETE' ? removed('readings', change.old) : soon())
      .on('postgres_changes', {event: '*', schema: 'public', table: 'snapshots', filter: 'stand_id=eq.' + board}, soon)
      .on('postgres_changes', {event: '*', schema: 'public', table: 'snapshots', filter: 'stand_id=eq.*'}, soon)
      .on('postgres_changes', {event: '*', schema: 'public', table: 'cells'}, change => {
        if (change.new?.id) cells.set(change.new.id, change.new);
        say();
      })
      .on('postgres_changes', {event: 'UPDATE', schema: 'public', table: 'stands', filter: 'id=eq.' + board}, change => {
        if (change.new?.revision) revision = change.new.revision;
        say();
      })
      .subscribe(status => {
        const was = online;
        online = status === 'SUBSCRIBED';
        if (online && !was) { catchUp().catch(() => {}); setTimeout(() => catchUp().catch(() => {}), READY_MS); }
        say();
      });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp().catch(() => {}); });
    // The browser knows a lost network before the live channel's heartbeat does.
    window.addEventListener('offline', () => { online = false; say(); });
    window.addEventListener('online', () => catchUp().then(() => { online = true; say(); }).catch(() => {}));
    setInterval(() => { if (!document.hidden) catchUp().catch(() => {}); }, SAFETY_MS);
  }

  // The board list lives on the website's home page, not the cell's.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href="/board-view.html"]');
    if (link) { event.preventDefault(); location.href = 'index.html'; }
  }, true);

  window.TM5S_REMOTE = {request, refuse, catchUp, state: () => ({online, newest, revision})};
  listen();
})();
