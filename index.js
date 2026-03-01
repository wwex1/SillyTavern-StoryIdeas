/**
 * Story Ideas - Episode Suggestion Extension for SillyTavern
 * 캐릭터/세계관/대화 맥락을 분석하여 다음 에피소드 아이디어를 추천합니다.
 * 하단 드로어 패널 + 가로 카드 슬라이더 UI
 */

import { event_types } from '../../../events.js';
import { getCurrentChatId, user_avatar } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getWorldInfoPrompt } from '../../../world-info.js';

const EXT_NAME = 'SillyTavern-StoryIdeas';

// ─── 기본값 ───

const INITIAL_PROMPT = `Based on the current roleplay context—characters, world-building, and recent conversation—suggest possible next episode or story arc ideas.

Consider:
- Unresolved tensions or foreshadowed events
- Character goals, secrets, or unspoken desires
- World events, politics, or environmental changes
- Relationship developments or conflicts
- Interesting "what if" scenarios that fit the setting

Each suggestion should include a short title and a description.`;

const DEFAULTS = {
    enabled: true,
    apiSource: 'main',
    connectionProfileId: '',
    count: 3,
    detailLevel: 'normal',
    lang: 'en',
    prompt: INITIAL_PROMPT,
    promptPresets: {},
    cache: {},  // { chatId: { ideas: [...], ts } }
};

// ─── 상태 ───

let cfg = {};
let ctx = null;
let generating = false;

// ─── 유틸 ───

function persist() { ctx.saveSettingsDebounced(); }

function esc(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
}

function cacheKey() {
    const chatId = getCurrentChatId();
    return chatId || null;
}

// ─── 부팅 ───

async function boot() {
    console.log(`[${EXT_NAME}] Booting...`);
    ctx = SillyTavern.getContext();

    if (!ctx.extensionSettings[EXT_NAME]) {
        ctx.extensionSettings[EXT_NAME] = structuredClone(DEFAULTS);
    }
    cfg = ctx.extensionSettings[EXT_NAME];

    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (cfg[k] === undefined) cfg[k] = v;
    }

    seedPresets();
    createDrawerDOM();
    await mountSettings();
    bindEvents();

    console.log(`[${EXT_NAME}] Ready.`);
}

function seedPresets() {
    if (!cfg.promptPresets) cfg.promptPresets = {};
    if (Object.keys(cfg.promptPresets).length > 0) return;

    cfg.promptPresets['Default'] = INITIAL_PROMPT;

    cfg.promptPresets['Drama & Conflict'] = `Suggest dramatic episode ideas focusing on interpersonal conflicts, betrayals, moral dilemmas, and emotionally charged confrontations.

Consider:
- Hidden secrets being revealed
- Loyalties being tested
- Impossible choices the characters must face
- Power struggles and shifting alliances
- Emotional breaking points`;

    cfg.promptPresets['Adventure & Exploration'] = `Suggest adventure-oriented episode ideas involving quests, discoveries, and world exploration.

Consider:
- Unexplored locations or mysterious places
- Dangerous missions or objectives
- New characters or factions encountered
- Environmental challenges and survival
- Treasures, artifacts, or hidden knowledge`;

    cfg.promptPresets['Slice of Life'] = `Suggest slice-of-life episode ideas that deepen character relationships through everyday moments.

Consider:
- Casual outings or shared activities
- Heartfelt conversations and bonding
- Humorous misunderstandings
- Personal growth moments
- Quiet, meaningful interactions`;

    persist();
}

// ─── 드로어 DOM 생성 ───

function createDrawerDOM() {
    if ($('#si-drawer').length) return;

    const overlay = $('<div id="si-overlay" class="si-overlay"></div>');
    const drawer = $(`
        <div id="si-drawer" class="si-drawer">
            <div class="si-handle"></div>
            <div class="si-drawer-head">
                <span class="si-drawer-title">💡 에피소드 추천</span>
                <div class="si-drawer-actions">
                    <button class="si-drawer-btn si-btn-refresh" title="새로 생성">🔄</button>
                    <button class="si-drawer-btn si-btn-trash" title="삭제">🗑️</button>
                    <button class="si-drawer-btn si-btn-close" title="닫기">✕</button>
                </div>
            </div>
            <div class="si-slider-wrap">
                <div id="si-content" class="si-slider"></div>
            </div>
        </div>
    `);

    $('body').append(overlay).append(drawer);

    // 닫기
    overlay.on('click', () => closeDrawer());
    drawer.find('.si-btn-close').on('click', () => closeDrawer());

    // 재생성
    drawer.find('.si-btn-refresh').on('click', async () => {
        if (generating) return;
        const key = cacheKey();
        if (key && cfg.cache[key]) {
            delete cfg.cache[key];
            persist();
        }
        await generate();
    });

    // 삭제
    drawer.find('.si-btn-trash').on('click', () => {
        const key = cacheKey();
        if (key && cfg.cache[key]) {
            delete cfg.cache[key];
            persist();
        }
        $('#si-content').html('<div class="si-empty">추천이 삭제되었습니다.</div>');
        toastr.success('추천 삭제됨');
    });
}

function openDrawer() {
    $('#si-overlay').addClass('visible');
    $('#si-drawer').addClass('open');
}

function closeDrawer() {
    $('#si-overlay').removeClass('visible');
    $('#si-drawer').removeClass('open');
}

function isDrawerOpen() {
    return $('#si-drawer').hasClass('open');
}

// ─── 설정 패널 ───

async function mountSettings() {
    const html = await ctx.renderExtensionTemplateAsync(`third-party/${EXT_NAME}`, 'settings');
    $('#extensions_settings').append(html);

    const root = $('.story_ideas_settings');

    root.find('.si_enabled')
        .prop('checked', cfg.enabled)
        .on('change', function () {
            cfg.enabled = $(this).prop('checked');
            persist();
            const menuBtn = document.getElementById('si_menu_btn');
            if (menuBtn) menuBtn.style.display = cfg.enabled ? '' : 'none';
            toastr.info(cfg.enabled ? 'Story Ideas 활성화됨' : 'Story Ideas 비활성화됨');
        });

    root.find('.si_source')
        .val(cfg.apiSource)
        .on('change', function () {
            cfg.apiSource = $(this).val();
            persist();
            $('#si_profile_area').toggle(cfg.apiSource === 'profile');
        });
    $('#si_profile_area').toggle(cfg.apiSource === 'profile');

    ctx.ConnectionManagerRequestService.handleDropdown(
        '.story_ideas_settings .si_connection_profile',
        cfg.connectionProfileId,
        (profile) => {
            cfg.connectionProfileId = profile?.id ?? '';
            persist();
        },
    );

    // 추천 설정
    bindField(root, '.si_count', 'count', 'num');
    bindField(root, '.si_detail_level', 'detailLevel');
    bindField(root, '.si_lang', 'lang');

    // 프롬프트
    root.find('.si_prompt').val(cfg.prompt).on('change', function () {
        cfg.prompt = $(this).val();
        persist();
    });

    root.find('.si_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('기본 프롬프트로 복원할까요?', '초기화')) {
            cfg.prompt = INITIAL_PROMPT;
            root.find('.si_prompt').val(INITIAL_PROMPT);
            persist();
            toastr.success('프롬프트 초기화됨');
        }
    });

    // 프리셋
    mountPresetUI(root);
}

function bindField(root, sel, key, type) {
    root.find(sel).val(cfg[key]).on('change', function () {
        cfg[key] = type === 'num' ? Number($(this).val()) : $(this).val();
        persist();
    });
}

function mountPresetUI(root) {
    const sel = root.find('.si_prompt_preset');

    function refresh() {
        sel.empty();
        Object.keys(cfg.promptPresets || {}).forEach(n => {
            sel.append(`<option value="${n}">${n}</option>`);
        });
    }
    refresh();

    root.find('.si_preset_load').on('click', () => {
        const n = sel.val();
        if (!n || !cfg.promptPresets[n]) return;
        cfg.prompt = cfg.promptPresets[n];
        root.find('.si_prompt').val(cfg.prompt);
        persist();
        toastr.success(`"${n}" 적용됨`);
    });

    root.find('.si_preset_save').on('click', async () => {
        const n = await ctx.Popup.show.input('프리셋 이름:', '저장');
        if (!n?.trim()) return;
        const t = n.trim();
        if (cfg.promptPresets[t] && !await ctx.Popup.show.confirm(`"${t}" 덮어쓸까요?`, '덮어쓰기')) return;
        cfg.promptPresets[t] = cfg.prompt;
        persist();
        refresh();
        sel.val(t);
        toastr.success(`"${t}" 저장됨`);
    });

    root.find('.si_preset_del').on('click', async () => {
        const n = sel.val();
        if (!n) return toastr.warning('프리셋을 선택하세요.');
        if (await ctx.Popup.show.confirm(`"${n}" 삭제?`, '삭제')) {
            delete cfg.promptPresets[n];
            persist();
            refresh();
            toastr.success(`"${n}" 삭제됨`);
        }
    });
}

// ─── 이벤트 ───

function bindEvents() {
    // 마법봉 메뉴에 버튼 추가
    const menuBtn = document.createElement('div');
    menuBtn.id = 'si_menu_btn';
    menuBtn.className = 'list-group-item flex-container flexGap5 interactable';
    menuBtn.title = '에피소드 추천';
    menuBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> 에피소드 추천';
    menuBtn.style.display = cfg.enabled ? '' : 'none';

    menuBtn.addEventListener('click', async () => {
        if (!cfg.enabled) return;
        $('#extensionsMenu').hide();

        openDrawer();

        // 캐시가 있으면 바로 표시
        const key = cacheKey();
        if (key && cfg.cache[key]?.ideas?.length) {
            renderCards(cfg.cache[key].ideas);
            return;
        }

        // 없으면 생성
        await generate();
    });

    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu) {
        extMenu.appendChild(menuBtn);
    } else {
        const obs = new MutationObserver((_, o) => {
            const m = document.getElementById('extensionsMenu');
            if (m) { m.appendChild(menuBtn); o.disconnect(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // 채팅 변경 시 캐시 자동 로드 안 함 (드로어는 수동 오픈이므로)
    ctx.eventSource.on(event_types.CHAT_CHANGED, () => {
        if (isDrawerOpen()) closeDrawer();
    });
}

// ─── 생성 ───

async function generate() {
    if (generating) return;
    if (!cfg.enabled) return;

    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) {
        toastr.warning('Connection Profile을 선택하세요.');
        return;
    }

    if (!ctx.chat || ctx.chat.length === 0) {
        toastr.warning('대화 내역이 없습니다.');
        return;
    }

    const lastBotIdx = findLastBotIdx();
    if (lastBotIdx === -1) {
        toastr.warning('봇 메시지가 없습니다.');
        return;
    }

    generating = true;
    showLoading();

    try {
        const instruction = buildInstruction();
        let raw = '';

        if (cfg.apiSource === 'main') {
            const background = await gatherPlain(lastBotIdx);
            const { generateRaw } = ctx;
            if (!generateRaw) throw new Error('generateRaw not available');
            raw = await generateRaw({ systemPrompt: background, prompt: instruction, streaming: false });
        } else {
            const msgs = await gatherMessages(lastBotIdx);
            msgs.push({ role: 'user', content: instruction });

            if (!ctx.ConnectionManagerRequestService) throw new Error('Connection Manager 미로드');

            const resp = await ctx.ConnectionManagerRequestService.sendRequest(
                cfg.connectionProfileId, msgs, 4000,
                { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            ).catch(e => { throw new Error(`Profile 오류: ${e.message}`); });

            if (typeof resp === 'string') raw = resp;
            else if (resp?.choices?.[0]?.message) {
                const m = resp.choices[0].message;
                raw = m.reasoning_content || m.content || '';
            } else raw = resp?.content || resp?.message || '';
        }

        const ideas = parseIdeas(raw);
        if (!ideas?.length) throw new Error('파싱 실패');

        // 캐시 저장
        const key = cacheKey();
        if (key) {
            cfg.cache[key] = { ideas, ts: Date.now() };
            persist();
        }

        renderCards(ideas);

    } catch (err) {
        console.error(`[${EXT_NAME}]`, err);
        showError(err.message);
        toastr.error(`추천 생성 실패: ${err.message}`);
    } finally {
        generating = false;
    }
}

// ─── 프롬프트 ───

function buildInstruction() {
    const langNote = (cfg.lang || 'en') === 'ko'
        ? '⚠️ 모든 추천을 한국어로 작성하세요.'
        : '⚠️ Write all suggestions in English.';

    const detail = { brief: '1-2 sentences', normal: '3-5 sentences', detailed: '6+ sentences' };

    return `${ctx.substituteParams(cfg.prompt)}

${langNote}

OUTPUT FORMAT - Use this EXACT structure:
<suggestions>
[Title of idea 1]
Description here.

[Title of idea 2]
Description here.
</suggestions>

Rules:
- Exactly ${cfg.count} suggestions
- Detail: ${detail[cfg.detailLevel] || detail.normal} per idea
- Title in [brackets], description on next lines
- Wrap in <suggestions>...</suggestions>
- NO text outside the tags`;
}

// ─── 컨텍스트 수집 ───

function findLastBotIdx() {
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) return i;
    }
    return -1;
}

function getPersona() {
    try {
        if (!user_avatar || !power_user) return '';
        let s = '';
        const name = power_user.personas?.[user_avatar] || power_user.name || 'User';
        s += `User/Persona: ${name}\n`;
        const desc = power_user.persona_descriptions?.[user_avatar];
        if (desc?.description) s += `\nPersona Description:\n${desc.description}\n`;
        else if (power_user.persona_description) s += `\nPersona Description:\n${power_user.persona_description}\n`;
        return s.trim();
    } catch { return ''; }
}

function getCharacter() {
    try {
        const c = SillyTavern.getContext();
        const ch = c.characters?.[c.characterId];
        if (!ch) return '';
        const d = ch.data || ch;
        let s = '';
        if (ch.name) s += `Character: ${ch.name}\n`;
        if (d.description) s += `\nDescription:\n${d.description}\n`;
        if (d.personality) s += `\nPersonality:\n${d.personality}\n`;
        if (d.scenario) s += `\nScenario:\n${d.scenario}\n`;
        if (d.creator_notes) s += `\nCreator Notes:\n${d.creator_notes}\n`;
        if (d.system_prompt) s += `\nSystem Prompt:\n${d.system_prompt}\n`;
        if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries);
            if (entries.length) {
                s += `\n\nCharacter Lore (${entries.length} entries):\n`;
                entries.forEach(e => { if (e.content) s += `- ${e.content}\n`; });
            }
        }
        return s.trim();
    } catch { return ''; }
}

async function getLore() {
    if (!ctx.chat?.length) return '';
    try {
        const lines = ctx.chat.map(m => m?.mes || '').filter(Boolean);
        if (!lines.length) return '';
        const r = await getWorldInfoPrompt(lines, 8000, true, undefined);
        return r?.worldInfoString?.trim() || '';
    } catch { return ''; }
}

async function gatherPlain(upTo) {
    let t = '';
    const p = getPersona();
    if (p) t += '=== PERSONA ===\n' + p + '\n\n';
    const c = getCharacter();
    if (c) t += '=== CHARACTER ===\n' + c + '\n\n';
    const l = await getLore();
    if (l) t += '=== LOREBOOK ===\n' + l + '\n\n';

    t += '=== CONVERSATION ===\n';
    const depth = 30;
    const start = Math.max(0, upTo - depth + 1);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        const who = m.is_user ? (m.name || 'User') : (m.name || 'Character');
        t += `${who}: ${m.extra?.display_text ?? m.mes}\n\n`;
    }
    return t.trim();
}

async function gatherMessages(upTo) {
    const msgs = [];
    const p = getPersona();
    const c = getCharacter();
    const l = await getLore();

    let sys = '';
    if (p) sys += p;
    if (c) sys += (sys ? '\n\n' : '') + c;
    if (l) sys += (sys ? '\n\n=== LOREBOOK ===\n' : '') + l;
    if (sys) msgs.push({ role: 'system', content: sys });

    const depth = 30;
    const start = Math.max(0, upTo - depth + 1);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        msgs.push({ role: m.is_user ? 'user' : 'assistant', content: m.extra?.display_text ?? m.mes });
    }
    return msgs;
}

// ─── 파싱 ───

function parseIdeas(content) {
    if (!content) return null;

    const tagMatch = content.match(/<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/i);
    const body = tagMatch ? tagMatch[1] : content;

    // [Title] + 본문
    const blocks = [];
    const re = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\s*\[|\s*$)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const title = m[1].trim();
        const desc = m[2].trim();
        if (title && desc.length > 5) blocks.push({ title, body: desc });
    }
    if (blocks.length) return blocks.slice(0, cfg.count || 8);

    // 숫자 리스트 폴백
    const nums = [];
    const nr = /\d+\.\s*\*?\*?([^*\n:]+)\*?\*?\s*[-:]\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    while ((m = nr.exec(body)) !== null) {
        const title = m[1].trim();
        const desc = m[2].trim();
        if (title && desc.length > 5) nums.push({ title, body: desc });
    }
    if (nums.length >= 2) return nums.slice(0, cfg.count || 8);

    // 불릿 폴백
    const bullets = body.split('\n')
        .map(l => l.trim()).filter(l => /^[-*•]\s+/.test(l))
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 10);
    if (bullets.length >= 2) return bullets.slice(0, cfg.count || 8).map(b => ({ title: '', body: b }));

    return null;
}

// ─── 렌더링 ───

function renderCards(ideas) {
    const container = $('#si-content');
    container.empty().removeClass('si-slider');

    // 슬라이더 모드
    container.addClass('si-slider');

    ideas.forEach((idea, i) => {
        const card = $(`
            <div class="si-idea">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="si-idea-num">${i + 1}</span>
                    <span class="si-idea-title">${esc(idea.title || `아이디어 ${i + 1}`)}</span>
                </div>
                <div class="si-idea-desc">${esc(idea.body || '')}</div>
            </div>
        `);
        container.append(card);
    });
}

function showLoading() {
    $('#si-content').empty().removeClass('si-slider').html(`
        <div class="si-loading">
            <div class="si-spinner"></div>
            <span>에피소드 추천 생성 중...</span>
        </div>
    `);
}

function showError(msg) {
    const container = $('#si-content');
    container.empty().removeClass('si-slider').html(`
        <div class="si-error">
            <div>❌ 생성 실패</div>
            <div style="font-size:0.85em;margin-top:4px;opacity:0.7;">${esc(msg)}</div>
            <button class="si-error-retry">🔄 재시도</button>
        </div>
    `);
    container.find('.si-error-retry').on('click', async () => {
        await generate();
    });
}

// ─── 시작 ───

jQuery(async () => { await boot(); });
