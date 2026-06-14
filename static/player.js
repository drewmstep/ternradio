// ── Constants ─────────────────────────────────────────────────────────────────
const GIST_MAX_SEC     = 60;   // hard ceiling for an AI News Brief (it may run shorter)
const RAW_FALLBACK_SEC = 45;   // cut length when no gist is available for a clip
const CLIP_FADE_SEC    = 2;    // news clip fades out over this many seconds before the cut
const BRIDGE_SEC      = 3.5;   // short music segue between clips (both modes)
const GAP_SEC         = 1;     // fallback silence if music can't play

// ── Music tracks (Pixabay CC0) — short segue played between clips ──────────────
const MUSIC_TRACKS = [
    "https://cdn.pixabay.com/audio/2026/06/04/audio_a080dd0481.mp3",
    "https://cdn.pixabay.com/audio/2026/06/04/audio_dc6e7a9bab.mp3",
    "https://cdn.pixabay.com/audio/2025/08/10/audio_80e095916c.mp3",
    "https://cdn.pixabay.com/audio/2026/01/25/audio_3e05235d9a.mp3",
    "https://cdn.pixabay.com/audio/2026/04/08/audio_c088c1e0ea.mp3",
];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    queue:           [],       // the continuous News Brief stream
    index:           -1,
    playing:         false,
    phase:           'idle',   // idle | clip | transition | interlude
    mode:            'briefs', // 'briefs' | 'fullstories'
    briefIndex:      0,        // where to resume the brief stream after full stories
    cutPoint:        30,
    clipStart:       0,                // where the current clip begins playing (gist start)
    clipFadeStarted: false,
    segmentSec:      RAW_FALLBACK_SEC, // raw cut length when a clip has no gist
    fullStory:       false,            // (per-item full story is on item.fullStory)
};

// Saved full stories (added via "Queue Full Story"), played via "Launch Full Stories".
const fullStoryQueue = [];
let briefsPlayed = 0;                  // count of briefs actually played
const STILL_LISTENING_EVERY = 50;      // insert a "Still listening?" card this often
let autoLoading = false;               // guard so we only auto-fetch briefs once at a time

// The list currently being played through.
function activeList() {
    return state.mode === 'fullstories' ? fullStoryQueue : state.queue;
}

// Smart Gist: only fetch /api/gist when the server says the feature is on, so
// when it's off the player makes zero gist calls and behaves exactly as before.
const GIST_ENABLED = document.body.dataset.gist === 'on';

// Fetch the smart-gist window for a clip once; store {start_time,end_time} on it.
function ensureGist(item) {
    if (!GIST_ENABLED || !item || item.gistRequested) return;
    item.gistRequested = true;
    const lang = item.language || state.mixLanguage || 'en';
    fetch(`/api/gist?url=${encodeURIComponent(item.audio_url)}&lang=${encodeURIComponent(lang)}&max=${GIST_MAX_SEC}`)
        .then(r => (r.ok ? r.json() : { gist: null }))
        .then(d => {
            item.gist = (d && d.gist) || null;
            if (item.gist) {
                console.log(`[gist] ${item.source}: ${item.gist.start_time}–${item.gist.end_time}s` +
                            ` · skip: ${item.gist.skip_reason || ''} · end: ${item.gist.end_reason || ''}`);
            }
            maybeApplyGistToCurrent(item);   // rescue the first clip if it's mid-intro
            renderQueue();                   // brief length now known → refresh playlist
        })
        .catch(() => { item.gist = null; });
}

// If a clip's gist arrives WHILE it's already playing raw (typically the first
// clip), apply it on the fly: if we're still in the intro, jump to the brief
// start and fade in; if we're already inside the brief, just adopt its end cut.
function maybeApplyGistToCurrent(item) {
    if (state.mode !== 'briefs' || state.phase !== 'clip' || state.queue[state.index] !== item) return;
    if (state.fullStory || item.fullStory) return;
    const g = item.gist;
    if (!g || (state.clipStart === g.start_time && state.cutPoint === g.end_time)) return;
    const ct = clipAudio.currentTime;
    if (ct < g.start_time - 0.5) {              // still in the intro → skip to the news
        state.clipStart = g.start_time;
        state.cutPoint  = g.end_time;
        state.clipFadeStarted = false;
        try { clipAudio.currentTime = g.start_time; } catch (e) {}
        clipAudio.volume = 0;
        fadeAudio(clipAudio, 0, 1.0, 300);
        console.log(`[gist] applied to current clip → ${g.start_time}-${g.end_time}s`);
    } else if (ct < g.end_time) {              // already inside the brief → just cut at end
        state.clipStart = g.start_time;
        state.cutPoint  = g.end_time;
    }
}

// ── Audio elements ────────────────────────────────────────────────────────────
const clipAudio  = new Audio();
const musicAudio = new Audio();
let   lastMusicIndex = -1;

function pickMusicTrack() {
    if (MUSIC_TRACKS.length <= 1) return 0;
    let i;
    do { i = Math.floor(Math.random() * MUSIC_TRACKS.length); } while (i === lastMusicIndex);
    lastMusicIndex = i;
    return i;
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const el = {
    playBtn:        document.getElementById('playBtn'),
    nextBtn:        document.getElementById('nextBtn'),
    quickStartBtn:  document.getElementById('quickStartBtn'),
    customStartBtn: document.getElementById('customStartBtn'),
    startCustomBtn: document.getElementById('startCustomBtn'),
    newMixBtn:      document.getElementById('newMixBtn'),
    homeLink:       document.getElementById('homeLink'),
    prefsPanel:     document.getElementById('prefsPanel'),
    trackTitle:     document.getElementById('trackTitle'),
    trackSummary:   document.getElementById('trackSummary'),
    sourceBadge:    document.getElementById('sourceBadge'),
    nowCountry:     document.getElementById('nowCountry'),
    nowMeta:        document.getElementById('nowMeta'),
    backTimeBtn:    document.getElementById('backTimeBtn'),
    addTimeBtn:     document.getElementById('addTimeBtn'),
    thumbUpBtn:     document.getElementById('thumbUpBtn'),
    thumbDownBtn:   document.getElementById('thumbDownBtn'),
    addFullStoryBtn:document.getElementById('addFullStoryBtn'),
    progressFill:   document.getElementById('progressFill'),
    timeInfo:       document.getElementById('timeInfo'),
    queueList:      document.getElementById('queueList'),
    fullStoryList:  document.getElementById('fullStoryList'),
    fullCount:      document.getElementById('fullCount'),
    launchFullBtn:  document.getElementById('launchFullBtn'),
    statusDot:      document.getElementById('statusDot'),
    statusText:     document.getElementById('statusText'),
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function setStatus(text, mode) {
    el.statusText.textContent = text;
    el.statusDot.className = 'dot ' + (mode || '');
}

function fmt(s) {
    if (s == null || isNaN(s)) return '--:--';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function parseDuration(str) {
    if (!str) return null;
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    const p = str.split(':').map(Number);
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    return null;
}

function timeAgo(iso) {
    if (!iso) return 'recently';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(d) || d < 0) return 'recently';
    if (d < 120)   return 'moments ago';
    if (d < 3600)  return `${Math.round(d / 60)} minutes ago`;
    if (d < 86400) return `${Math.round(d / 3600)} hours ago`;
    return `${Math.round(d / 86400)} days ago`;
}

// How long a given clip will play for, given the chosen segment length /
// Full Story setting — used both for scheduling and the actual cut.
function clipSeconds(item) {
    const raw = parseDuration(item.duration);
    if (state.fullStory || item.fullStory) return raw || 600;   // full story (estimate)
    return Math.min(raw || state.segmentSec, state.segmentSec);
}

function nextStartSeconds() {
    if (!state.queue.length) return 0;
    const last = state.queue[state.queue.length - 1];
    const bridgeSec = CLIP_FADE_SEC + BRIDGE_SEC;
    return last.startSeconds + clipSeconds(last) + bridgeSec;
}

function getSelectedLanguage() {
    const btn = document.querySelector('.lang-btn.active');
    return btn ? btn.dataset.lang : 'en';
}

function getSelectedMood() {
    const inp = document.querySelector('.mood-card.active input');
    return inp ? inp.value : 'balanced';
}

const LANG_LABELS = { en: 'English', fr: 'Français', es: 'Español' };
function langLabel(code, short) {
    if (short) return (code || 'en').toUpperCase();
    return LANG_LABELS[code] || (code || '').toUpperCase();
}

// "11 Jun, 14:00 GMT+1" — 24-hour time + the listener's local time zone.
function formatPublished(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
        day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZoneName: 'short',
    });
}

// ── Music fading ──────────────────────────────────────────────────────────────
function fadeAudio(audioEl, fromVol, toVol, durationMs, callback) {
    audioEl.volume = fromVol;
    const steps    = 40;
    const interval = durationMs / steps;
    const delta    = (toVol - fromVol) / steps;
    let   step     = 0;
    const timer = setInterval(() => {
        step++;
        audioEl.volume = Math.max(0, Math.min(1, fromVol + delta * step));
        if (step >= steps) { clearInterval(timer); callback?.(); }
    }, interval);
    return timer;
}

// ── Clip volume fade ──────────────────────────────────────────────────────────
function fadeClipOut(durationMs) {
    fadeAudio(clipAudio, clipAudio.volume, 0, durationMs, () => clipAudio.pause());
}

// ── Sequencing token ──────────────────────────────────────────────────────────
// playToken invalidates any in-flight transition the instant playback is stopped or
// advanced, so stale timers never fire for the wrong clip.
let playToken = 0;
let seqTimer  = null;

// ── Order the brief stream newest-first ─────────────────────────────────────────
// Latest news plays first; older stories arrive as you keep listening (the
// background auto-load appends older, un-heard clips). Items without a date go last.
function publishedMs(item) {
    const t = item && item.published ? new Date(item.published).getTime() : NaN;
    return isNaN(t) ? -Infinity : t;
}
function orderBriefs() {
    state.queue.sort((a, b) => publishedMs(b) - publishedMs(a));
    restampQueue();
    renderQueue();
}

// Recompute cumulative start timestamps after a reorder.
function restampQueue() {
    const bridgeSec = CLIP_FADE_SEC + BRIDGE_SEC;
    let cursor = 0;
    for (const item of state.queue) {
        item.startSeconds = cursor;
        cursor += clipSeconds(item) + bridgeSec;
    }
}

// ── Session start ──────────────────────────────────────────────────────────────
// Waits briefly so a few clips can stream in, then shuffles and begins playback at a
// random first source.
function startSession() {
    if (!state.playing) return;
    const token = ++playToken;
    clearTimeout(seqTimer);

    state.index = -1;
    state.phase = 'idle';
    el.sourceBadge.style.display = 'none';
    el.trackTitle.textContent    = 'Building your mix…';
    el.trackSummary.textContent  = '';
    setStatus('Building your mix…', 'loading');

    waitForBuffer(token);
}

// Hold briefly until enough clips have arrived to shuffle a real mix (or the stream
// finishes / a max wait elapses), then shuffle and play.
function waitForBuffer(token) {
    if (token !== playToken || !state.playing) return;
    if (streamDone || state.queue.length >= 5) {
        orderBriefs();
        startItem(0);
        return;
    }
    setStatus('Curating your mix…', 'loading');
    seqTimer = setTimeout(() => {
        if (token !== playToken) return;
        if (waitForBuffer._waited === undefined) waitForBuffer._waited = 0;
        waitForBuffer._waited += 350;
        if (waitForBuffer._waited >= 6000) {   // hard cap ~6s
            orderBriefs();
            startItem(0);
        } else {
            waitForBuffer(token);
        }
    }, 350);
}

// ── Playback sequence ─────────────────────────────────────────────────────────
function startItem(i) {
    const list = activeList();
    if (i >= list.length) { onListEnd(); return; }

    ++playToken;                   // invalidates any in-flight transition
    clearTimeout(seqTimer);
    state.index           = i;
    state.phase           = 'idle';
    state.clipFadeStarted = false;

    const item = list[i];

    // "Still listening?" check-in card — pause and wait for a choice.
    if (item.interlude) {
        stopMusic();
        clipAudio.pause();
        state.phase   = 'interlude';
        state.playing = false;
        el.sourceBadge.style.display = 'none';
        if (el.nowCountry) el.nowCountry.textContent = '';
        if (el.nowMeta)    el.nowMeta.innerHTML       = '';
        el.trackTitle.textContent   = 'Still listening?';
        el.trackSummary.textContent = 'News briefs can keep going — press ▶ to continue. Or tap “Launch Full Stories” below to hear the full stories you’ve saved.';
        el.progressFill.style.width = '0%';
        el.timeInfo.textContent     = '';
        el.playBtn.textContent      = '▶ Continue';
        el.playBtn.disabled         = false;
        el.nextBtn.disabled         = false;
        refreshClipControls();
        renderQueue();
        setStatus('Paused — still listening?', '');
        return;
    }

    if (state.mode === 'briefs') {
        ensureGist(item);              // prefetch this + the next couple's briefs
        ensureGist(list[i + 1]);
        ensureGist(list[i + 2]);
    }
    el.sourceBadge.style.display = 'inline-block';
    el.sourceBadge.textContent   = item.source;
    el.trackTitle.textContent    = item.title;
    el.trackSummary.textContent  = item.summary || '';
    el.progressFill.style.width  = '0%';
    el.timeInfo.textContent      = '';
    el.playBtn.disabled          = false;
    renderNowMeta(item);
    refreshClipControls();
    renderQueue();
    renderFullStories();

    startClip(item);
}

// Country + language + published date/time + a subtle full-story length.
function renderNowMeta(item) {
    if (el.nowCountry) el.nowCountry.textContent = item.country ? `· ${item.country}` : '';
    if (!el.nowMeta) return;
    const bits = [];
    if (item.language) bits.push(langLabel(item.language));
    const pub = formatPublished(item.published);
    if (pub) bits.push(`Published ${pub}`);
    let html = bits.join('<span class="nm-sep">·</span>');
    const full = parseDuration(item.duration);
    if (full) {
        html += `${bits.length ? '<span class="nm-sep">·</span>' : ''}<span class="nm-fulllen">Full story ${fmt(full)}</span>`;
    }
    el.nowMeta.innerHTML = html;
}

// Enable the playing controls and reflect the current item's thumbs reaction.
function refreshClipControls() {
    const item = activeList()[state.index];
    const isInterlude = !!(item && item.interlude);
    const has  = !!item && !isInterlude;
    const inBriefs = state.mode === 'briefs';
    if (el.backTimeBtn)     el.backTimeBtn.disabled     = !has;
    if (el.addTimeBtn)      el.addTimeBtn.disabled      = !has || (item && item.fullStory);
    if (el.thumbUpBtn)      el.thumbUpBtn.disabled      = !has;
    if (el.thumbDownBtn)    el.thumbDownBtn.disabled    = !has;
    if (el.addFullStoryBtn) el.addFullStoryBtn.disabled = !has || !inBriefs;
    const reaction = item ? item.reaction : null;
    if (el.thumbUpBtn) {
        el.thumbUpBtn.classList.toggle('active', reaction === 'up');
        el.thumbUpBtn.setAttribute('aria-pressed', reaction === 'up' ? 'true' : 'false');
    }
    if (el.thumbDownBtn) {
        el.thumbDownBtn.classList.toggle('active', reaction === 'down');
        el.thumbDownBtn.setAttribute('aria-pressed', reaction === 'down' ? 'true' : 'false');
    }
}

function startClip(item) {
    if (!state.playing) return;
    state.phase = 'clip';
    const myToken = playToken;   // guards the async seek against skips/stops

    // Use the smart-gist window only for headline playback (not Full Story) and
    // only if the gist is already available for this clip; otherwise raw 30s.
    const g = (!state.fullStory && !item.fullStory && item.gist &&
               typeof item.gist.start_time === 'number' &&
               typeof item.gist.end_time === 'number') ? item.gist : null;
    state.clipStart = g ? g.start_time : 0;
    state.cutPoint  = (state.fullStory || item.fullStory) ? Infinity
                      : (g ? g.end_time : state.segmentSec);
    if (g) console.log(`[gist] playing ${item.source} from ${g.start_time}s to ${g.end_time}s`);

    clipAudio.src = item.audio_url;
    clipAudio.load();
    const label = state.mode === 'fullstories' ? 'Full story' : 'Brief';
    setStatus(`${label} ${state.index + 1} of ${activeList().length} — ${item.source}`, 'active');
    el.playBtn.textContent = '⏸ Pause';

    const onFail = () => {
        if (!state.playing || myToken !== playToken) return;
        setStatus('Could not load audio — skipping', '');
        setTimeout(() => startItem(state.index + 1), 800);
    };

    if (g && g.start_time > 0) {
        // Seeking needs metadata: start muted, jump to the gist start, fade in.
        clipAudio.volume = 0;
        const seekPlay = () => {
            if (myToken !== playToken) return;     // a newer clip took over
            try { clipAudio.currentTime = g.start_time; } catch (e) {}
            clipAudio.play()
                .then(() => { if (myToken === playToken) fadeAudio(clipAudio, 0, 1.0, 300); })
                .catch(onFail);
        };
        if (clipAudio.readyState >= 1) seekPlay();
        else clipAudio.addEventListener('loadedmetadata', seekPlay, { once: true });
    } else {
        clipAudio.volume = 1.0;
        clipAudio.play().catch(onFail);
    }
}

// Short music segue (~BRIDGE_SEC) between clips: fade in, hold, fade out, then
// proceed. If music can't play, it degrades to a brief silent bridge.
function playMusicBridge(done) {
    clearTimeout(seqTimer);
    const token = playToken;

    if (MUSIC_TRACKS.length) {
        musicAudio.src    = MUSIC_TRACKS[pickMusicTrack()];
        musicAudio.volume = 0;
        musicAudio.play()
            .then(() => { if (playToken === token) fadeAudio(musicAudio, 0, 0.7, 600); })
            .catch(() => {});   // no music → still proceed after the hold below
    }

    seqTimer = setTimeout(() => {
        if (playToken !== token) { stopMusic(); return; }
        fadeAudio(musicAudio, musicAudio.volume || 0, 0, 500, () => {
            stopMusic();
            if (playToken === token && state.playing) done();
        });
    }, BRIDGE_SEC * 1000);
}

function stopMusic() {
    try { musicAudio.pause(); } catch (e) {}
    musicAudio.src = '';
    musicAudio.volume = 0;
}

function onCutReached() {
    if (state.phase !== 'clip') return;
    state.phase = 'transition';
    clipAudio.pause();
    if (state.mode === 'briefs') briefsPlayed++;
    // Bridge to the next clip with a short burst of music.
    playMusicBridge(() => { if (state.playing) advance(); });
}

// Decide what plays after the current clip (briefs auto-load + 50-brief check-in).
function advance() {
    if (state.mode === 'briefs') {
        maybeAutoLoad();
        const next = state.queue[state.index + 1];
        if (briefsPlayed > 0 && briefsPlayed % STILL_LISTENING_EVERY === 0 && !(next && next.interlude)) {
            state.queue.splice(state.index + 1, 0, { interlude: true });
            restampQueue();
        }
    }
    startItem(state.index + 1);
}

// Reached the end of the active list.
function onListEnd() {
    if (state.mode === 'fullstories') {
        state.mode = 'briefs';            // saved stories done → back to the brief stream
        renderFullStories();
        setStatus('Back to news briefs', 'active');
        startItem(Math.max(0, state.briefIndex));
        return;
    }
    autoLoadBriefs(() => {
        if (state.playing && state.queue.length > state.index + 1) startItem(state.index + 1);
        else finishPlaylist();
    });
}

function maybeAutoLoad() {
    if ((state.queue.length - state.index - 1) <= 2) autoLoadBriefs();
}

// Fetch more briefs in the background (older, un-heard) and append them.
function autoLoadBriefs(done) {
    if (autoLoading) { if (done) done(0); return; }
    autoLoading = true;
    const heard = state.queue.filter(i => i.audio_url).map(i => i.audio_url);
    fetch('/api/playlist/continue', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            heard_urls: heard,
            language:   state.mixLanguage  || getSelectedLanguage(),
            mood:       state.mixMood       || getSelectedMood(),
            countries:  state.mixCountries != null ? state.mixCountries : getSelectedCountries(),
        }),
    })
    .then(r => (r.ok ? r.json() : { items: [] }))
    .then(data => {
        const items = (data.items || []).map(it => ({ ...it, language: state.mixLanguage }));
        if (items.length) {
            state.queue.push(...items);
            restampQueue();
            renderQueue();
            items.forEach(ensureGist);
        }
        autoLoading = false;
        if (done) done(items.length);
    })
    .catch(() => { autoLoading = false; if (done) done(0); });
}

function finishPlaylist() {
    playToken++;
    clearTimeout(seqTimer);
    stopMusic();
    state.playing = false;
    state.phase   = 'idle';
    el.playBtn.textContent      = '▶ Play';
    el.progressFill.style.width = '100%';
    setStatus('Playlist complete');
    renderQueue();
}

function stopAll() {
    playToken++;                  // invalidate any pending transition
    clearTimeout(seqTimer);
    stopMusic();
    clipAudio.pause();
    clipAudio.volume = 1.0;
    state.playing = false;
    state.phase   = 'idle';
}

// ── Audio events ──────────────────────────────────────────────────────────────
clipAudio.addEventListener('playing', () => {
    el.playBtn.textContent = '⏸ Pause';
    el.nextBtn.disabled    = false;
});

clipAudio.addEventListener('waiting', () => {
    setStatus(`Buffering — ${activeList()[state.index]?.source || ''}`, 'loading');
});

clipAudio.addEventListener('timeupdate', () => {
    if (state.phase !== 'clip') return;
    const { currentTime, duration } = clipAudio;
    const cap = state.cutPoint;

    // Full Story: play to the natural end; show progress against real duration.
    if (cap === Infinity) {
        if (duration && !isNaN(duration)) {
            el.progressFill.style.width = `${Math.min((currentTime / duration) * 100, 100)}%`;
            el.timeInfo.textContent     = `${fmt(currentTime)} / ${fmt(duration)}`;
        }
        return;   // 'ended' triggers the transition
    }

    // Progress is measured within the gist window [clipStart, cap].
    const start = state.clipStart || 0;
    const span  = Math.max(1, cap - start);
    el.progressFill.style.width = `${Math.min(Math.max((currentTime - start) / span, 0) * 100, 100)}%`;
    el.timeInfo.textContent     = `${fmt(Math.max(0, currentTime - start))} / ${fmt(span)}`;

    if (!state.clipFadeStarted && currentTime >= cap - CLIP_FADE_SEC) {
        state.clipFadeStarted = true;
        fadeClipOut(CLIP_FADE_SEC * 1000);
    }

    if (currentTime >= cap) onCutReached();
});

clipAudio.addEventListener('ended', () => {
    if (state.phase === 'clip') onCutReached();
});

clipAudio.addEventListener('error', () => {
    if (!state.playing || state.phase !== 'clip') return;
    setStatus('Audio error — skipping', '');
    setTimeout(() => startItem(state.index + 1), 600);
});

// ── Queue rendering ────────────────────────────────────────────────────────────
function itemMetaHtml(item) {
    const meta = [];
    if (item.language) meta.push(langLabel(item.language, true));
    let lenSec = null;
    if (item.fullStory) lenSec = parseDuration(item.duration);
    else if (item.gist) lenSec = item.gist.end_time - item.gist.start_time;
    if (lenSec) meta.push(fmt(lenSec));
    const pub = formatPublished(item.published);
    if (pub) meta.push(pub);
    return meta.length ? ` <span class="qi-meta">· ${meta.join(' · ')}</span>` : '';
}

// The News Brief stream (windowed: the playing brief sits at the top, played ones
// scroll up out of view).
function renderQueue() {
    if (!state.queue.length) {
        el.queueList.innerHTML = '<li class="queue-empty">Loading…</li>';
        return;
    }
    const briefsMode = state.mode === 'briefs';
    el.queueList.innerHTML = state.queue.map((item, i) => {
        if (item.interlude) {
            const active = briefsMode && i === state.index;
            return `<li class="queue-item interlude ${active ? 'active' : ''}" data-i="${i}">
                <span class="qi-ts">☕</span>
                <div>
                    <div class="qi-source">Still listening?</div>
                    <div class="qi-title">News briefs can continue — or tap “Launch Full Stories” for your saved stories.</div>
                </div>
            </li>`;
        }
        const cls = (briefsMode && i === state.index) ? 'active'
                  : (briefsMode && i < state.index)   ? 'done' : '';
        return `<li class="queue-item ${cls}" data-i="${i}">
            <span class="qi-ts">${fmt(item.startSeconds)}</span>
            <div>
                <div class="qi-source">${item.source} <span class="qi-country">${item.country}</span>${itemMetaHtml(item)}</div>
                <div class="qi-title">${item.title}</div>
            </div>
        </li>`;
    }).join('');

    el.queueList.querySelectorAll('.queue-item').forEach(li => {
        li.addEventListener('click', () => {
            const idx = parseInt(li.dataset.i);
            const it  = state.queue[idx];
            state.mode = 'briefs';
            state.playing = true;
            startItem(it && it.interlude ? idx + 1 : idx);
        });
    });
    scrollCurrentToTop();
}

// Put the currently-playing brief at the top of the visible window.
function scrollCurrentToTop() {
    if (state.mode !== 'briefs') return;
    const active = el.queueList.querySelector('.queue-item.active');
    const first  = el.queueList.querySelector('.queue-item');
    if (active && first) el.queueList.scrollTop = active.offsetTop - first.offsetTop;
}

// The saved Full Stories list (below the brief stream).
function renderFullStories() {
    if (!el.fullStoryList) return;
    const fsMode = state.mode === 'fullstories';
    if (!fullStoryQueue.length) {
        el.fullStoryList.innerHTML = '<li class="queue-empty">Tap “Queue Full Story” on a brief to save it here.</li>';
    } else {
        el.fullStoryList.innerHTML = fullStoryQueue.map((item, i) => {
            const cls = (fsMode && i === state.index) ? 'active'
                      : (fsMode && i < state.index)   ? 'done' : '';
            return `<li class="queue-item ${cls}" data-fi="${i}">
                <span class="qi-ts">${fmt(item.startSeconds || 0)}</span>
                <div>
                    <div class="qi-source">${item.source} <span class="qi-country">${item.country}</span>${itemMetaHtml(item)} <span class="qi-full">· Full story</span></div>
                    <div class="qi-title">${item.title}</div>
                </div>
            </li>`;
        }).join('');
        el.fullStoryList.querySelectorAll('[data-fi]').forEach(li => {
            li.addEventListener('click', () => {
                if (state.mode === 'briefs') state.briefIndex = Math.max(0, state.index);
                state.mode = 'fullstories';
                state.playing = true;
                startItem(parseInt(li.dataset.fi));
            });
        });
    }
    if (el.fullCount) el.fullCount.textContent = fullStoryQueue.length ? `(${fullStoryQueue.length})` : '';
    if (el.launchFullBtn) {
        el.launchFullBtn.disabled    = !fullStoryQueue.length || fsMode;
        el.launchFullBtn.textContent = fsMode ? 'Playing Full Stories…' : 'Launch Full Stories';
    }
}

// ── Buttons ───────────────────────────────────────────────────────────────────
el.playBtn.addEventListener('click', () => {
    if (!state.queue.length) return;
    if (state.phase === 'interlude') {        // "Continue" past the check-in card
        state.playing = true;
        startItem(state.index + 1);
        return;
    }
    if (state.playing) {
        stopAll();
        el.playBtn.textContent = '▶ Play';
        setStatus('Paused');
    } else {
        state.playing = true;
        startItem(Math.max(0, state.index));
    }
});

el.nextBtn.addEventListener('click', () => {
    if (!state.queue.length) return;
    stopAll();
    state.playing = true;
    startItem(state.index + 1);
});

// Back 10s — rewind the current clip (e.g. to re-hear something), not before
// the brief's start point.
if (el.backTimeBtn) {
    el.backTimeBtn.addEventListener('click', () => {
        if (state.phase !== 'clip') return;
        const floor = state.clipStart || 0;
        clipAudio.currentTime = Math.max(floor, clipAudio.currentTime - 10);
        state.clipFadeStarted = false;   // we're earlier now; allow the fade again
        clipAudio.volume = 1.0;
    });
}

// Add Time — keep the current headline going for another 10 seconds.
if (el.addTimeBtn) {
    el.addTimeBtn.addEventListener('click', () => {
        if (state.phase !== 'clip' || state.cutPoint === Infinity) return;
        state.cutPoint += 10;
        state.clipFadeStarted = false;   // cancel any fade that had begun
        clipAudio.volume = 1.0;
        setStatus(`+10s — playing to ${fmt(state.cutPoint)}`, 'active');
    });
}

// Thumbs up / down — capture the listener's reaction on the current clip.
// (Stored on the item; will steer Claude's curation in a later step.)
function react(kind) {
    const item = activeList()[state.index];
    if (!item || item.interlude) return;
    item.reaction = (item.reaction === kind) ? null : kind;   // toggle off if same
    refreshClipControls();
}
if (el.thumbUpBtn) el.thumbUpBtn.addEventListener('click', () => react('up'));
// Thumbs down records the reaction and immediately skips to the next clip.
if (el.thumbDownBtn) {
    el.thumbDownBtn.addEventListener('click', () => {
        const item = activeList()[state.index];
        if (item && !item.interlude) item.reaction = 'down';
        stopAll();
        state.playing = true;
        startItem(state.index + 1);
    });
}

// Queue Full Story — save this clip (full length) to the Full Stories list.
if (el.addFullStoryBtn) {
    el.addFullStoryBtn.addEventListener('click', () => {
        if (state.mode !== 'briefs') return;
        const item = state.queue[state.index];
        if (!item || item.interlude) return;
        fullStoryQueue.push({ ...item, fullStory: true, reaction: null, gist: null, gistRequested: true });
        renderFullStories();
        setStatus(`Saved to Full Stories (${fullStoryQueue.length})`, state.playing ? 'active' : '');
    });
}

// Launch Full Stories — play the saved full stories now, then resume briefs.
if (el.launchFullBtn) {
    el.launchFullBtn.addEventListener('click', () => {
        if (!fullStoryQueue.length || state.mode === 'fullstories') return;
        state.briefIndex = Math.max(0, state.index);   // resume the brief stream here
        state.mode    = 'fullstories';
        state.index   = -1;
        state.playing = true;
        startItem(0);
    });
}

// ── Mood card selection ───────────────────────────────────────────────────
document.querySelectorAll('.mood-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.mood-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
    });
});

// ── Language button selection (multi-select; at least one stays on) ────────
// Changing language re-marks the map: only countries with a source in the
// chosen language(s) are clickable, and the selection resets to those.
document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const active = document.querySelectorAll('.lang-btn.active');
        // Don't allow deselecting the last remaining language.
        if (btn.classList.contains('active') && active.length === 1) return;
        btn.classList.toggle('active');
        resetSelectionToAvailable();
        refreshCountryUI();
    });
});

let activeSource = null;
let streamDone   = false;   // set when the SSE stream signals 'done'

// Start a mix. opts = { language, mood, countries, segmentSec, fullStory }.
function beginMix(opts) {
    if (activeSource) { activeSource.close(); activeSource = null; }
    stopAll();
    state.queue        = [];
    state.index        = -1;
    state.mode         = 'briefs';
    state.briefIndex   = 0;
    state.segmentSec   = opts.segmentSec;
    state.fullStory    = opts.fullStory;
    state.mixLanguage  = opts.language;
    state.mixMood      = opts.mood;
    state.mixCountries = opts.countries || '';

    briefsPlayed          = 0;
    autoLoading           = false;
    fullStoryQueue.length = 0;
    renderFullStories();

    streamDone            = false;
    waitForBuffer._waited = 0;

    document.body.classList.add('playing');
    el.progressFill.style.width  = '0%';
    el.timeInfo.textContent      = '';
    el.playBtn.textContent       = '▶ Play';
    el.playBtn.disabled          = true;
    el.nextBtn.disabled          = true;
    el.sourceBadge.style.display = 'none';
    el.trackTitle.textContent    = 'Fetching global audio feeds…';
    el.trackSummary.textContent  = '';
    if (el.nowCountry) el.nowCountry.textContent = '';
    if (el.nowMeta)    el.nowMeta.innerHTML       = '';
    refreshClipControls();
    renderQueue();
    setStatus('Connecting to world feeds…', 'loading');

    const params = new URLSearchParams({
        language:  opts.language,
        mood:      opts.mood,
        countries: opts.countries || '',
    });
    activeSource = new EventSource(`/api/playlist/stream?${params.toString()}`);

    activeSource.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'item') {
            const item = { ...msg.item, language: state.mixLanguage, startSeconds: nextStartSeconds() };
            state.queue.push(item);
            ensureGist(item);   // start computing each brief as early as possible
            renderQueue();

            // First clip arrived: begin immediately. We buffer a few more clips,
            // then shuffle so playback never always starts with the same source.
            if (state.queue.length === 1) {
                el.playBtn.disabled = false;
                setStatus('Playing — more clips loading…', 'active');
                state.playing = true;
                startSession();
            }
        } else if (msg.type === 'done') {
            streamDone = true;
            activeSource.close();
            activeSource = null;
            setStatus(`${state.queue.length} clips ready`, state.playing ? 'active' : '');
        } else if (msg.type === 'error') {
            activeSource.close();
            activeSource = null;
            if (!state.queue.length) {
                el.trackTitle.textContent   = 'Error loading playlist';
                el.trackSummary.textContent = msg.message || 'Unknown error';
                setStatus('Error');
            }
        }
    };

    activeSource.onerror = () => {
        if (!activeSource) return;
        activeSource.close();
        activeSource = null;
        if (!state.queue.length) {
            el.trackTitle.textContent   = 'Connection error';
            el.trackSummary.textContent = 'Could not reach server. Is Flask running?';
            setStatus('Error');
        }
    };
}

// Return to the selection screen (the "New Mix" button).
function resetToSelection() {
    if (activeSource) { activeSource.close(); activeSource = null; }
    stopAll();
    state.queue = [];
    state.index = -1;
    state.mode  = 'briefs';
    briefsPlayed = 0;
    fullStoryQueue.length = 0;
    renderFullStories();
    document.body.classList.remove('playing');
    el.playBtn.disabled          = true;
    el.nextBtn.disabled          = true;
    el.progressFill.style.width  = '0%';
    el.timeInfo.textContent      = '';
    el.sourceBadge.style.display = 'none';
    el.trackTitle.textContent    = '';
    el.trackSummary.textContent  = '';
    if (el.nowCountry) el.nowCountry.textContent = '';
    if (el.nowMeta)    el.nowMeta.innerHTML       = '';
    refreshClipControls();
    setStatus('Ready');
    renderQueue();
}

// Quick Start — instant mix from all English sources, 30-second segments.
if (el.quickStartBtn) {
    el.quickStartBtn.addEventListener('click', () => {
        beginMix({ language: 'en', mood: getSelectedMood(), countries: '',
                   segmentSec: RAW_FALLBACK_SEC, fullStory: false });
    });
}

// Show/hide the preferences panel (the "Start Custom Mix" button lives inside it).
function setCustomOpen(open) {
    if (!el.prefsPanel) return;
    el.prefsPanel.hidden = !open;
    if (el.customStartBtn) {
        el.customStartBtn.classList.toggle('active', open);
        el.customStartBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    // Sliders were hidden (width 0) — reposition their tips now they're visible.
    if (open) window.dispatchEvent(new Event('resize'));
}

// Custom Start — toggle the preferences panel.
if (el.customStartBtn) {
    el.customStartBtn.addEventListener('click', () => {
        const open = el.prefsPanel.hidden;             // about to open?
        setCustomOpen(open);
        if (open) el.prefsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

// Start Custom Mix — use the chosen language / mood / countries / segment length.
if (el.startCustomBtn) {
    el.startCustomBtn.addEventListener('click', () => {
        if (selectedCountries.size === 0) {
            setStatus('Select at least one country to start.');
            return;
        }
        beginMix({
            language:   getSelectedLanguage(),
            mood:       getSelectedMood(),
            countries:  getSelectedCountries(),
            segmentSec: RAW_FALLBACK_SEC,
            fullStory:  false,
        });
    });
}

// New Mix (shown during playback) — exit the mix and jump straight to the
// Preferences panel (skip the hero / re-clicking "Custom Start Radio").
if (el.newMixBtn) {
    el.newMixBtn.addEventListener('click', () => {
        resetToSelection();
        setCustomOpen(true);
        if (el.prefsPanel) el.prefsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// "TERN RADIO" wordmark — always returns to the full home landing.
function goHome() {
    resetToSelection();          // exit any active mix
    setCustomOpen(false);        // collapse preferences for a clean landing
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
if (el.homeLink) {
    el.homeLink.addEventListener('click', goHome);
    el.homeLink.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
    });
}

// (News Briefs now auto-load continuously — see advance()/autoLoadBriefs();
//  the old manual "Load" button became "Launch Full Stories" above.)

// ── World map country selector ─────────────────────────────────────────────
// static/svg/world.svg is fetched and injected, then every country that has a
// news source is made clickable. Selecting a country includes its news in the
// mix; the selection is sent to the backend as ISO codes (see getSelectedCountries)
// so only those countries' feeds are fetched and curated.
// Country display names (everything that can appear on the map).
const COUNTRY_NAMES = {
    US: 'United States', CA: 'Canada', QA: 'Qatar', DE: 'Germany',
    AU: 'Australia', NZ: 'New Zealand', JP: 'Japan', GB: 'United Kingdom',
    ES: 'Spain', FR: 'France', CH: 'Switzerland',
    SE: 'Sweden', FI: 'Finland', IS: 'Iceland',
    MX: 'Mexico', CO: 'Colombia', AR: 'Argentina',
};
// Which countries have a source IN EACH LANGUAGE (mirrors the backend feeds).
// Update this whenever feeds are added/removed.
const SOURCES_BY_LANG = {
    en: { US: ['NPR'], CA: ['CBC'], QA: ['Al Jazeera'], DE: ['Deutsche Welle'],
          AU: ['ABC'], NZ: ['RNZ'], JP: ['NHK'], GB: ['BBC', 'Guardian'],
          SE: ['Radio Sweden'], FI: ['YLE'], IS: ['RÚV'] },
    fr: { DE: ['Deutsche Welle'], JP: ['NHK'] },
    es: { DE: ['Deutsche Welle'], JP: ['NHK'], ES: ['RNE'] },
};
// Every code that has a source in SOME language → gets click handlers once.
const ALL_SOURCE_CODES = new Set();
Object.values(SOURCES_BY_LANG).forEach(m => Object.keys(m).forEach(c => ALL_SOURCE_CODES.add(c)));

const mapCountEl    = document.getElementById('mapCount');
const mapTotalEl    = document.getElementById('mapTotal');
const selectAllEl   = document.getElementById('selectAllCountries');
const mapMount      = document.getElementById('worldMapMount');
const mapTooltip    = document.getElementById('mapTooltip');
const mapFrame      = document.querySelector('.map-frame');
const countryListEl = document.getElementById('countryCheckboxes');

// Active languages (the lang buttons; defaults to English).
function activeLangs() {
    const langs = [...document.querySelectorAll('.lang-btn.active')].map(b => b.dataset.lang);
    return langs.length ? langs : ['en'];
}
// Countries that have a source in any active language.
function availableCodes() {
    const set = new Set();
    activeLangs().forEach(l => Object.keys(SOURCES_BY_LANG[l] || {}).forEach(c => set.add(c)));
    return set;
}
function sourcesForCode(code) {
    const names = new Set();
    activeLangs().forEach(l => ((SOURCES_BY_LANG[l] || {})[code] || []).forEach(s => names.add(s)));
    return [...names];
}

const selectedCountries = new Set();
function resetSelectionToAvailable() {
    selectedCountries.clear();
    availableCodes().forEach(c => selectedCountries.add(c));
}

// Comma-separated ISO codes for the backend `countries` filter.
function getSelectedCountries() {
    return Array.from(selectedCountries).join(',');
}

function updateMapCount() {
    const total = availableCodes().size;
    if (mapCountEl) mapCountEl.textContent = String(selectedCountries.size);
    if (mapTotalEl) mapTotalEl.textContent = String(total);
    if (selectAllEl) {
        const n = selectedCountries.size;
        selectAllEl.checked       = total > 0 && n === total;
        selectAllEl.indeterminate = n > 0 && n < total;
    }
    syncCountryCheckboxes();
}

// Country checkbox list — only the countries available in the chosen language(s).
function buildCountryCheckboxes() {
    if (!countryListEl) return;
    const codes = [...availableCodes()].sort((a, b) => COUNTRY_NAMES[a].localeCompare(COUNTRY_NAMES[b]));
    countryListEl.innerHTML = codes.map(code =>
        `<label><input type="checkbox" data-code="${code}" ${selectedCountries.has(code) ? 'checked' : ''}> ${COUNTRY_NAMES[code]}</label>`
    ).join('');
    countryListEl.querySelectorAll('input[data-code]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) selectedCountries.add(cb.dataset.code);
            else selectedCountries.delete(cb.dataset.code);
            applySelectionClasses();
            updateMapCount();
        });
    });
}
function syncCountryCheckboxes() {
    if (!countryListEl) return;
    countryListEl.querySelectorAll('input[data-code]').forEach(cb => {
        cb.checked = selectedCountries.has(cb.dataset.code);
    });
}

// Mark which map countries are clickable for the current language(s).
function markMapAvailability() {
    if (!mapMount) return;
    const avail = availableCodes();
    mapMount.querySelectorAll('path[data-code]').forEach(p => {
        const ok = avail.has(p.dataset.code);
        p.classList.toggle('has-source', ok);
        p.classList.toggle('no-source', !ok);
        p.setAttribute('tabindex', ok ? '0' : '-1');
        if (!ok) { p.classList.remove('selected'); p.setAttribute('aria-pressed', 'false'); }
    });
}

function applySelectionClasses() {
    if (!mapMount) return;
    const avail = availableCodes();
    mapMount.querySelectorAll('path[data-code]').forEach(p => {
        const on = avail.has(p.dataset.code) && selectedCountries.has(p.dataset.code);
        p.classList.toggle('selected', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function toggleCountry(code) {
    if (!availableCodes().has(code)) return;   // not offered in this language
    if (selectedCountries.has(code)) selectedCountries.delete(code);
    else selectedCountries.add(code);
    applySelectionClasses();
    updateMapCount();
}

// Tooltip ("Country · Source1, Source2") above the hovered/focused country.
function showCountryTooltip(path) {
    if (!mapTooltip || !mapFrame) return;
    const srcs = sourcesForCode(path.dataset.code);
    if (!srcs.length) return;
    mapTooltip.textContent = `${COUNTRY_NAMES[path.dataset.code]} · ${srcs.join(', ')}`;
    mapTooltip.hidden = false;
    const b = path.getBoundingClientRect();
    const f = mapFrame.getBoundingClientRect();
    mapTooltip.style.left = `${b.left - f.left + b.width / 2}px`;
    mapTooltip.style.top  = `${b.top  - f.top  - 8}px`;
}
function hideCountryTooltip() {
    if (mapTooltip) mapTooltip.hidden = true;
}

// Recompute everything that depends on the active language(s).
function refreshCountryUI() {
    markMapAvailability();
    applySelectionClasses();
    buildCountryCheckboxes();
    updateMapCount();
}

function initWorldMap(svgText) {
    if (!mapMount) return;
    mapMount.innerHTML = svgText;
    const svg = mapMount.querySelector('svg');
    if (!svg) return;

    // The file has width/height but no viewBox — add one so it scales fluidly.
    if (!svg.getAttribute('viewBox')) {
        const w = parseFloat(svg.getAttribute('width'))  || 1009.6727;
        const h = parseFloat(svg.getAttribute('height')) || 665.96301;
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');

    svg.querySelectorAll('path').forEach(path => {
        const code = (path.id || '').toUpperCase();
        if (!ALL_SOURCE_CODES.has(code)) {
            path.classList.add('no-source');   // never a source → permanently inert
            return;
        }
        path.dataset.code = code;
        path.setAttribute('role', 'button');
        path.addEventListener('click', () => toggleCountry(code));
        path.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCountry(code); }
        });
        path.addEventListener('mouseenter', () => showCountryTooltip(path));
        path.addEventListener('mouseleave', hideCountryTooltip);
        path.addEventListener('focus', () => showCountryTooltip(path));
        path.addEventListener('blur', hideCountryTooltip);
    });

    refreshCountryUI();   // mark availability for the current language
}

// "Select All" — toggles all AVAILABLE countries on/off.
if (selectAllEl) {
    selectAllEl.addEventListener('change', () => {
        if (selectAllEl.checked) availableCodes().forEach(c => selectedCountries.add(c));
        else selectedCountries.clear();
        applySelectionClasses();
        updateMapCount();
    });
}

// Fetch + inject the map (same-origin; permitted by CSP connect-src 'self').
fetch('/static/svg/world.svg')
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(initWorldMap)
    .catch(err => {
        console.error('World map failed to load:', err);
        const loading = document.getElementById('mapLoading');
        if (loading) loading.textContent = 'Map unavailable — you can still start a mix.';
        updateMapCount();
    });

resetSelectionToAvailable();
buildCountryCheckboxes();
updateMapCount();

// ── Preferences sliders (visual only — Phase 2 wires to backend) ───────────
// Tooltip bubbles / value readouts are presentational; nothing is sent to the
// server yet, and the existing Generate flow is untouched.
function initSlider(id, opts) {
    const slider = document.getElementById(id);
    if (!slider) return;
    const tip    = opts.tipId    ? document.getElementById(opts.tipId)    : null;
    const valEl  = opts.valueId  ? document.getElementById(opts.valueId)  : null;
    const labels = opts.labels   || null;   // notch labels keyed by value

    function render() {
        const v   = Number(slider.value);
        const min = Number(slider.min);
        const max = Number(slider.max);
        const pct = (v - min) / (max - min);
        if (tip) {
            tip.textContent = labels ? labels[String(v)] || '' : String(v);
            // Position the bubble over the thumb (thumb is ~18px wide).
            const w = slider.clientWidth;
            tip.style.left = `${pct * (w - 18) + 9}px`;
        }
        if (valEl) valEl.textContent = opts.valueFmt ? opts.valueFmt(v) : String(v);
    }
    slider.addEventListener('input', render);
    render();
    return { slider, render };
}

// News Brief Time Limit: the AI's ceiling for a brief (30-60s). Shown as an
// approximate Short/Medium/Long, sent to /api/gist as the max in ensureGist.
// News Brief length is no longer a user setting — briefs are always under 60s and
// the AI picks the exact length (see GIST_MAX_SEC + the gist prompt).
// Source Balance is disabled (Coming Soon); init is harmless.
const balanceSlider = initSlider('sliderBalance', {});
// Story Recency: exponential window (Last hour … Older). Visual for now.
const RECENCY_LABELS = ['Last hour', '6 hours', '24 hours', '1 week', 'This month', 'Older'];
const recencySlider = initSlider('sliderRecency', {
    valueId: 'recencyValue',
    valueFmt: (v) => RECENCY_LABELS[v] || '',
});

// A checkbox that greys out + disables its slider (No Headlines / No Limit).
function wireSliderToggle(checkboxId, rowId, sliderId) {
    const cb     = document.getElementById(checkboxId);
    const row    = document.getElementById(rowId);
    const slider = document.getElementById(sliderId);
    if (!cb || !row || !slider) return;
    const apply = () => {
        row.classList.toggle('slider-off', cb.checked);
        slider.disabled = cb.checked;
    };
    cb.addEventListener('change', apply);
    apply();   // set correct state on initial load (all unchecked → active)
}
wireSliderToggle('noRecencyLimit',   'rowRecency', 'sliderRecency');

// Reposition slider tooltips if the viewport changes (percentages depend on width).
window.addEventListener('resize', () => {
    balanceSlider && balanceSlider.render();
    recencySlider && recencySlider.render();
});
