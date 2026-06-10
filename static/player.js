// ── Constants ─────────────────────────────────────────────────────────────────
const CUT_MIN_SEC    = 80;
const CUT_MAX_SEC    = 100;
const PRE_MUSIC_SEC  = 4;    // music fades in this many seconds before the cut
const CLIP_FADE_SEC  = 2;    // news clip fades out over this many seconds before cut
const MUSIC_HOLD_SEC = 8;    // music plays solo for this many seconds after cut
const MUSIC_FADE_SEC = 2;    // music fades out over this many seconds before next intro

// ── Music tracks (Pixabay CC0) ────────────────────────────────────────────────
// Paste your cdn.pixabay.com/audio/... URLs here.
// To find them: open each Pixabay page in Chrome → F12 → Network tab →
// press play on the track → copy the .mp3 request URL.
const MUSIC_TRACKS = [
    "https://cdn.pixabay.com/audio/2026/06/04/audio_a080dd0481.mp3",
    "https://cdn.pixabay.com/audio/2026/06/04/audio_dc6e7a9bab.mp3",
    "https://cdn.pixabay.com/audio/2025/08/10/audio_80e095916c.mp3",
    "https://cdn.pixabay.com/audio/2026/01/25/audio_3e05235d9a.mp3",
    "https://cdn.pixabay.com/audio/2026/04/08/audio_c088c1e0ea.mp3",
];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    queue:            [],
    index:            -1,
    playing:          false,
    phase:            'idle',   // idle | intro | clip | music
    cutPoint:         90,
    musicFadeStarted: false,
    clipFadeStarted:  false,
};

// ── Audio elements ────────────────────────────────────────────────────────────
const clipAudio  = new Audio();
const musicAudio = new Audio();
musicAudio.loop  = true;   // loop in case the track is shorter than the transition window
let   musicTimer = null;

// ── Voice selection ───────────────────────────────────────────────────────────
let djVoice = null;

function loadVoices() {
    const voices = speechSynthesis.getVoices();
    djVoice =
        voices.find(v => v.name === 'Google UK English Female')          ||
        voices.find(v => v.name.includes('Google') && v.lang === 'en-GB') ||
        voices.find(v => v.lang === 'en-GB')                              ||
        voices.find(v => v.name.includes('Google') && v.lang.startsWith('en')) ||
        voices.find(v => v.lang.startsWith('en'))                         ||
        null;
    if (djVoice) console.log('DJ voice:', djVoice.name);
}

speechSynthesis.addEventListener('voiceschanged', loadVoices);
loadVoices();

// ── DOM ───────────────────────────────────────────────────────────────────────
const el = {
    playBtn:      document.getElementById('playBtn'),
    nextBtn:      document.getElementById('nextBtn'),
    generateBtn:  document.getElementById('generateBtn'),
    trackTitle:   document.getElementById('trackTitle'),
    trackSummary: document.getElementById('trackSummary'),
    sourceBadge:  document.getElementById('sourceBadge'),
    progressFill: document.getElementById('progressFill'),
    timeInfo:     document.getElementById('timeInfo'),
    queueList:    document.getElementById('queueList'),
    statusDot:    document.getElementById('statusDot'),
    statusText:   document.getElementById('statusText'),
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

function stampSchedule(items, maxSec) {
    const bridgeSec = PRE_MUSIC_SEC + MUSIC_HOLD_SEC + MUSIC_FADE_SEC + 1.5;
    let cursor = 0;
    return items.map(item => {
        const raw  = parseDuration(item.duration);
        const clip = raw ? Math.min(raw, maxSec) : maxSec;
        const out  = { ...item, startSeconds: cursor };
        cursor += clip + bridgeSec;
        return out;
    });
}

function nextStartSeconds() {
    if (!state.queue.length) return 0;
    const last = state.queue[state.queue.length - 1];
    const raw = parseDuration(last.duration);
    const clip = raw ? Math.min(raw, CUT_MAX_SEC) : CUT_MAX_SEC;
    const bridgeSec = PRE_MUSIC_SEC + MUSIC_HOLD_SEC + MUSIC_FADE_SEC + 1.5;
    return last.startSeconds + clip + bridgeSec;
}

function getSelectedLanguage() {
    const btn = document.querySelector('.lang-btn.active');
    return btn ? btn.dataset.lang : 'en';
}

function getSelectedMood() {
    const inp = document.querySelector('.mood-card.active input');
    return inp ? inp.value : 'balanced';
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

let lastMusicIndex = -1;

function pickMusicTrack() {
    if (MUSIC_TRACKS.length === 1) return 0;
    let i;
    do { i = Math.floor(Math.random() * MUSIC_TRACKS.length); } while (i === lastMusicIndex);
    lastMusicIndex = i;
    return i;
}

function startMusicFadeIn(fadeSec) {
    if (!MUSIC_TRACKS.length) return;
    const url = MUSIC_TRACKS[pickMusicTrack()];
    musicAudio.src = url;
    musicAudio.volume = 0;
    // Start at a random point so each transition sounds different
    musicAudio.load();
    musicAudio.addEventListener('canplay', function seekAndPlay() {
        musicAudio.removeEventListener('canplay', seekAndPlay);
        if (musicAudio.duration && !isNaN(musicAudio.duration)) {
            musicAudio.currentTime = Math.random() * Math.max(0, musicAudio.duration - 30);
        }
        musicAudio.play().catch(() => {});
        fadeAudio(musicAudio, 0, 0.85, fadeSec * 1000);
    }, { once: true });
}

function stopMusicFadeOut(fadeSec, callback) {
    clearTimeout(musicTimer);
    if (!MUSIC_TRACKS.length || musicAudio.paused) { callback?.(); return; }
    fadeAudio(musicAudio, musicAudio.volume, 0, fadeSec * 1000, () => {
        musicAudio.pause();
        musicAudio.src = '';
        callback?.();
    });
}

function stopMusicHard() {
    clearTimeout(musicTimer);
    musicAudio.pause();
    musicAudio.src = '';
    musicAudio.volume = 0;
}

// ── Clip volume fade ──────────────────────────────────────────────────────────
function fadeClipOut(durationMs) {
    fadeAudio(clipAudio, clipAudio.volume, 0, durationMs, () => clipAudio.pause());
}

// ── Playback sequence ─────────────────────────────────────────────────────────
function startItem(i) {
    if (!state.playing) return;
    if (i >= state.queue.length) { finishPlaylist(); return; }

    state.index            = i;
    state.phase            = 'intro';
    state.musicFadeStarted = false;
    state.clipFadeStarted  = false;

    const item = state.queue[i];
    el.sourceBadge.style.display = 'inline-block';
    el.sourceBadge.textContent   = item.source;
    el.trackTitle.textContent    = item.title;
    el.trackSummary.textContent  = item.summary || '';
    el.progressFill.style.width  = '0%';
    el.timeInfo.textContent      = '';
    setStatus(`Intro — ${item.source}`, 'active');
    renderQueue();

    const text = `From ${item.source}, in ${item.country}, ${timeAgo(item.published)}.`;
    const utt  = new SpeechSynthesisUtterance(text);
    utt.rate   = 1.0;
    utt.pitch  = 1.0;
    utt.lang   = 'en-GB';
    if (djVoice) utt.voice = djVoice;
    utt.onend   = () => { if (state.playing) startClip(item); };
    utt.onerror = () => { if (state.playing) startClip(item); };
    speechSynthesis.speak(utt);
}

function startClip(item) {
    if (!state.playing) return;
    state.phase    = 'clip';
    state.cutPoint = CUT_MIN_SEC + Math.random() * (CUT_MAX_SEC - CUT_MIN_SEC);

    clipAudio.volume = 1.0;
    clipAudio.src    = item.audio_url;
    clipAudio.load();
    setStatus(`${state.index + 1} of ${state.queue.length} — ${item.source}`, 'active');
    el.playBtn.textContent = '⏸ Pause';

    clipAudio.play().catch(() => {
        if (!state.playing) return;
        setStatus('Could not load audio — skipping', '');
        setTimeout(() => startItem(state.index + 1), 800);
    });
}

function onCutReached() {
    if (state.phase !== 'clip') return;
    state.phase = 'music';
    clipAudio.pause();

    // If clip was too short for PRE_MUSIC_SEC to trigger, start music now
    if (!state.musicFadeStarted) {
        state.musicFadeStarted = true;
        startMusicFadeIn(1.5);
    }

    clearTimeout(musicTimer);
    musicTimer = setTimeout(() => {
        stopMusicFadeOut(MUSIC_FADE_SEC, () => {
            if (state.playing) startItem(state.index + 1);
        });
    }, MUSIC_HOLD_SEC * 1000);
}

function finishPlaylist() {
    state.playing = false;
    state.phase   = 'idle';
    stopMusicHard();
    speechSynthesis.cancel();
    el.playBtn.textContent      = '▶ Play';
    el.progressFill.style.width = '100%';
    setStatus('Playlist complete');
    renderQueue();
}

function stopAll() {
    speechSynthesis.cancel();
    clipAudio.pause();
    clipAudio.volume = 1.0;
    stopMusicHard();
    state.playing = false;
    state.phase   = 'idle';
}

// ── Audio events ──────────────────────────────────────────────────────────────
clipAudio.addEventListener('playing', () => {
    el.playBtn.textContent = '⏸ Pause';
    el.nextBtn.disabled    = false;
});

clipAudio.addEventListener('waiting', () => {
    setStatus(`Buffering — ${state.queue[state.index]?.source}`, 'loading');
});

clipAudio.addEventListener('timeupdate', () => {
    if (state.phase !== 'clip') return;
    const { currentTime, duration } = clipAudio;
    const cap = state.cutPoint;

    if (duration && !isNaN(duration)) {
        el.progressFill.style.width = `${Math.min((currentTime / cap) * 100, 100)}%`;
        el.timeInfo.textContent     = `${fmt(currentTime)} / ${fmt(cap)}`;
    }

    if (!state.musicFadeStarted && currentTime >= cap - PRE_MUSIC_SEC) {
        state.musicFadeStarted = true;
        startMusicFadeIn(PRE_MUSIC_SEC);
    }

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
    stopMusicHard();
    setTimeout(() => startItem(state.index + 1), 600);
});

// ── Queue ─────────────────────────────────────────────────────────────────────
function renderQueue() {
    if (!state.queue.length) {
        el.queueList.innerHTML = '<li class="queue-empty">No playlist loaded</li>';
        return;
    }
    el.queueList.innerHTML = state.queue.map((item, i) => {
        const cls = i === state.index ? 'active' : i < state.index ? 'done' : '';
        return `<li class="queue-item ${cls}" data-i="${i}">
            <span class="qi-ts">${fmt(item.startSeconds)}</span>
            <div>
                <div class="qi-source">${item.source} <span class="qi-country">${item.country}</span></div>
                <div class="qi-title">${item.title}</div>
            </div>
        </li>`;
    }).join('');

    el.queueList.querySelectorAll('.queue-item').forEach(li => {
        li.addEventListener('click', () => {
            stopAll();
            state.playing = true;
            startItem(parseInt(li.dataset.i));
        });
    });
}

// ── Buttons ───────────────────────────────────────────────────────────────────
el.playBtn.addEventListener('click', () => {
    if (!state.queue.length) return;
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

// ── Mood card selection ───────────────────────────────────────────────────
document.querySelectorAll('.mood-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.mood-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
    });
});

// ── Language button selection ─────────────────────────────────────────────
document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

let activeSource = null;

el.generateBtn.addEventListener('click', () => {
    if (el.generateBtn.classList.contains('loading')) return;

    // From playing state: "↺ New Mix" first returns to mood/language selection
    if (document.body.classList.contains('playing')) {
        if (activeSource) { activeSource.close(); activeSource = null; }
        stopAll();
        state.queue  = [];
        state.index  = -1;
        document.body.classList.remove('playing');
        el.generateBtn.textContent   = 'Start Mix';
        el.playBtn.disabled          = true;
        el.nextBtn.disabled          = true;
        el.progressFill.style.width  = '0%';
        el.timeInfo.textContent      = '';
        el.sourceBadge.style.display = 'none';
        el.trackTitle.textContent    = '';
        el.trackSummary.textContent  = '';
        setStatus('Ready');
        renderQueue();
        return;
    }

    // Close any in-progress stream from a previous Generate click
    if (activeSource) { activeSource.close(); activeSource = null; }

    stopAll();
    state.queue  = [];
    state.index  = -1;

    el.progressFill.style.width  = '0%';
    el.timeInfo.textContent      = '';
    el.playBtn.textContent       = '▶ Play';
    el.playBtn.disabled          = true;
    el.nextBtn.disabled          = true;
    el.generateBtn.classList.add('loading');
    el.generateBtn.textContent   = '⏳ Connecting…';
    el.sourceBadge.style.display = 'none';
    el.trackTitle.textContent    = 'Fetching global audio feeds…';
    el.trackSummary.textContent  = '';
    renderQueue();
    setStatus('Connecting to world feeds…', 'loading');

    activeSource = new EventSource(`/api/playlist/stream?language=${getSelectedLanguage()}&mood=${getSelectedMood()}`);

    activeSource.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'item') {
            const item = { ...msg.item, startSeconds: nextStartSeconds() };
            state.queue.push(item);
            renderQueue();

            // Start playing the moment the first clip arrives
            if (state.queue.length === 1) {
                document.body.classList.add('playing');
                el.playBtn.disabled = false;
                el.generateBtn.classList.remove('loading');
                el.generateBtn.textContent = '↺ New Mix';
                setStatus('Playing — more clips loading…', 'active');
                state.playing = true;
                startItem(0);
            }
        } else if (msg.type === 'done') {
            activeSource.close();
            activeSource = null;
            setStatus(`${state.queue.length} clips ready`, state.playing ? 'active' : '');
        } else if (msg.type === 'error') {
            activeSource.close();
            activeSource = null;
            if (!state.queue.length) {
                el.generateBtn.classList.remove('loading');
                el.generateBtn.textContent  = '↺ New Mix';
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
            el.generateBtn.classList.remove('loading');
            el.generateBtn.textContent  = '↺ New Mix';
            el.trackTitle.textContent   = 'Connection error';
            el.trackSummary.textContent = 'Could not reach server. Is Flask running?';
            setStatus('Error');
        }
    };
});

// ── Continue Program ──────────────────────────────────────────────────────
const continueBtn = document.getElementById('continueBtn');
if (continueBtn) {
    continueBtn.addEventListener('click', async () => {
        if (continueBtn.classList.contains('loading')) return;

        continueBtn.classList.add('loading');
        continueBtn.textContent = 'Loading more clips…';

        const heardUrls = state.queue.map(i => i.audio_url);
        const wasFinished = !state.playing && state.phase === 'idle' && state.queue.length > 0;

        try {
            const res = await fetch('/api/playlist/continue', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    heard_urls: heardUrls,
                    language:   getSelectedLanguage(),
                    mood:       getSelectedMood(),
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            for (const item of (data.items || [])) {
                state.queue.push({ ...item, startSeconds: nextStartSeconds() });
            }
            renderQueue();
            continueBtn.classList.remove('loading');
            continueBtn.textContent = '+ Continue Program';
            setStatus(`${state.queue.length} clips ready`, state.playing ? 'active' : '');

            // Auto-resume if playlist had just ended
            if (wasFinished && state.queue.length > state.index + 1) {
                state.playing = true;
                startItem(state.index + 1);
            }
        } catch (err) {
            console.error(err);
            continueBtn.classList.remove('loading');
            continueBtn.textContent = '+ Continue Program';
            setStatus(`Continue failed: ${err.message}`);
        }
    });
}
