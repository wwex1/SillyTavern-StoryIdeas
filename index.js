/**
 * Story Ideas - Episode Suggestion Extension for SillyTavern
 * 캐릭터/세계관/대화 맥락을 분석하여 다음 에피소드 아이디어를 추천합니다.
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
    savedIdeas: {},       // { compositeKey: { ideas: [...], expanded: bool, ts: number } }
    promptPresets: {},    // { name: promptText }
};

// ─── 상태 ───

let cfg = {};
let ctx = null;
const activeJobs = new Set();

// ─── 유틸리티 ───

function compositeKey(msgIdx) {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const entry = ctx.chat[msgIdx];
    if (!entry) return null;
    const swipe = entry.swipe_id ?? 0;
    return `${chatId}|${msgIdx}|${swipe}`;
}

function persist() {
    ctx.saveSettingsDebounced();
}

function sanitize(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

// ─── 초기화 ───

async function boot() {
    console.log(`[${EXT_NAME}] Booting...`);

    ctx = SillyTavern.getContext();

    if (!ctx.extensionSettings[EXT_NAME]) {
        ctx.extensionSettings[EXT_NAME] = structuredClone(DEFAULTS);
    }
    cfg = ctx.extensionSettings[EXT_NAME];

    // 누락된 키 보완
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (cfg[k] === undefined) cfg[k] = v;
    }

    seedDefaultPresets();
    await mountSettingsPanel();
    wireEvents();

    console.log(`[${EXT_NAME}] Ready.`);
}

function seedDefaultPresets() {
    if (!cfg.promptPresets) cfg.promptPresets = {};

    if (Object.keys(cfg.promptPresets).length === 0) {
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
    }

    persist();
}

// ─── 설정 패널 ───

async function mountSettingsPanel() {
    const html = await ctx.renderExtensionTemplateAsync(`third-party/${EXT_NAME}`, 'settings');
    $('#extensions_settings').append(html);

    const root = $('.story_ideas_settings');

    // 활성화
    root.find('.si_enabled')
        .prop('checked', cfg.enabled)
        .on('change', function () {
            cfg.enabled = $(this).prop('checked');
            persist();
            if (cfg.enabled) {
                toastr.success('Story Ideas 활성화됨');
                toggleMenuBtn(true);
            } else {
                toastr.info('Story Ideas 비활성화됨');
                toggleMenuBtn(false);
            }
        });

    // API 소스
    root.find('.si_source')
        .val(cfg.apiSource)
        .on('change', function () {
            cfg.apiSource = $(this).val();
            persist();
            $('#si_profile_area').toggle(cfg.apiSource === 'profile');
        });
    $('#si_profile_area').toggle(cfg.apiSource === 'profile');

    // Connection Profile 드롭다운
    ctx.ConnectionManagerRequestService.handleDropdown(
        '.story_ideas_settings .si_connection_profile',
        cfg.connectionProfileId,
        (profile) => {
            cfg.connectionProfileId = profile?.id ?? '';
            persist();
        },
    );

    // 숫자/선택 필드들
    bindInput(root, '.si_count', 'count', 'number');
    bindInput(root, '.si_detail_level', 'detailLevel');
    bindInput(root, '.si_lang', 'lang');

    // 프롬프트
    root.find('.si_prompt')
        .val(cfg.prompt)
        .on('change', function () {
            cfg.prompt = $(this).val();
            persist();
        });

    root.find('.si_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('기본 프롬프트로 복원?', '프롬프트 복원')) {
            cfg.prompt = INITIAL_PROMPT;
            root.find('.si_prompt').val(INITIAL_PROMPT);
            persist();
            toastr.success('프롬프트 복원됨');
        }
    });

    // 프리셋 UI
    setupPresetControls(root);
}

function bindInput(root, selector, key, type) {
    const el = root.find(selector);
    el.val(cfg[key]);
    el.on('change', function () {
        cfg[key] = type === 'number' ? Number($(this).val()) : $(this).val();
        persist();
    });
}

function setupPresetControls(root) {
    const sel = root.find('.si_prompt_preset');

    function refreshList() {
        sel.empty();
        Object.keys(cfg.promptPresets || {}).forEach(name => {
            sel.append(`<option value="${name}">${name}</option>`);
        });
    }
    refreshList();

    // 불러오기
    root.find('.si_prompt_preset_load').on('click', function () {
        const name = sel.val();
        if (!name || !cfg.promptPresets[name]) return;
        cfg.prompt = cfg.promptPresets[name];
        root.find('.si_prompt').val(cfg.prompt);
        persist();
        toastr.success(`"${name}" 적용됨`);
    });

    // 저장
    root.find('.si_prompt_preset_save').on('click', async function () {
        const name = await ctx.Popup.show.input('프리셋 이름:', '저장');
        if (!name?.trim()) return;
        const trimmed = name.trim();
        if (cfg.promptPresets[trimmed]) {
            if (!await ctx.Popup.show.confirm(`"${trimmed}" 덮어쓸까요?`, '덮어쓰기')) return;
        }
        cfg.promptPresets[trimmed] = cfg.prompt;
        persist();
        refreshList();
        sel.val(trimmed);
        toastr.success(`"${trimmed}" 저장됨`);
    });

    // 삭제
    root.find('.si_prompt_preset_remove').on('click', async function () {
        const name = sel.val();
        if (!name) return toastr.warning('프리셋을 선택하세요.');
        if (await ctx.Popup.show.confirm(`"${name}" 삭제?`, '삭제')) {
            delete cfg.promptPresets[name];
            persist();
            refreshList();
            toastr.success(`"${name}" 삭제됨`);
        }
    });
}

// ─── 이벤트 바인딩 ───

function wireEvents() {
    // 확장 메뉴(마법봉)에 버튼 삽입
    const menuBtn = document.createElement('div');
    menuBtn.id = 'si_generate_btn';
    menuBtn.className = 'list-group-item flex-container flexGap5 interactable';
    menuBtn.title = '에피소드 추천 생성';
    menuBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> 에피소드 추천';
    menuBtn.style.display = cfg.enabled ? '' : 'none';

    menuBtn.addEventListener('click', async () => {
        // 마지막 봇 메시지 찾기
        const lastBotIdx = findLastBotMessageIdx();
        if (lastBotIdx === -1) {
            toastr.warning('추천할 봇 메시지가 없습니다.');
            return;
        }

        // 메뉴 닫기
        $('#extensionsMenu').hide();

        // 버튼 상태 변경
        const icon = menuBtn.querySelector('i');
        icon.classList.remove('fa-lightbulb');
        icon.classList.add('fa-spinner', 'fa-spin');
        menuBtn.style.pointerEvents = 'none';

        try {
            await produce(lastBotIdx);
        } finally {
            icon.classList.remove('fa-spinner', 'fa-spin');
            icon.classList.add('fa-lightbulb');
            menuBtn.style.pointerEvents = 'auto';
        }
    });

    // extensionsMenu에 삽입
    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu) {
        extMenu.appendChild(menuBtn);
    } else {
        // DOM이 아직 준비 안 됐으면 재시도
        const observer = new MutationObserver((mutations, obs) => {
            const menu = document.getElementById('extensionsMenu');
            if (menu) {
                menu.appendChild(menuBtn);
                obs.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 봇 메시지 렌더링 → 기존 추천 복원
    ctx.eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (msgIdx) => {
        if (!cfg.enabled) return;
        const msg = ctx.chat[msgIdx];
        if (!msg || msg.is_user) return;

        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            const rec = cfg.savedIdeas[key];
            paintIdeas(msgIdx, rec.ideas, rec.expanded);
        }
    });

    // 채팅 변경
    ctx.eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!cfg.enabled) return;
        setTimeout(restoreVisible, 1200);
    });

    // 메시지 업데이트 후 재렌더링
    ctx.eventSource.on(event_types.MESSAGE_UPDATED, (msgIdx) => {
        if (!cfg.enabled) return;
        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            $(`[mesid="${msgIdx}"] .si-panel`).remove();
            const rec = cfg.savedIdeas[key];
            setTimeout(() => paintIdeas(msgIdx, rec.ideas, rec.expanded), 100);
        }
    });

    // 메시지 삭제 → 데이터 정리
    ctx.eventSource.on(event_types.MESSAGE_DELETED, (msgIdx) => {
        if (!cfg.savedIdeas) return;
        const chatId = getCurrentChatId();
        if (!chatId) return;
        const prefix = `${chatId}|${msgIdx}|`;
        for (const k of Object.keys(cfg.savedIdeas)) {
            if (k.startsWith(prefix)) delete cfg.savedIdeas[k];
        }
        persist();
    });

    // 스와이프 → 해당 스와이프의 추천 복원
    ctx.eventSource.on(event_types.MESSAGE_SWIPED, (msgIdx) => {
        if (!cfg.enabled) return;
        const msg = ctx.chat[msgIdx];
        if (!msg || msg.is_user) return;

        $(`[mesid="${msgIdx}"] .si-panel`).remove();
        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            const rec = cfg.savedIdeas[key];
            paintIdeas(msgIdx, rec.ideas, rec.expanded);
        }
    });
}

// ─── 추천 생성 ───

async function produce(msgIdx) {
    if (!cfg.enabled) return;

    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) {
        toastr.warning('Connection Profile을 선택하세요.');
        return;
    }

    const msg = ctx.chat[msgIdx];
    if (!msg) return;

    const key = compositeKey(msgIdx);
    if (!key) return;

    if (activeJobs.has(key)) return;
    activeJobs.add(key);

    const msgEl = $(`[mesid="${msgIdx}"] .mes_text`);
    msgEl.find('.si-panel').remove();
    msgEl.append('<div class="si-panel"><div class="si-loading">에피소드 추천 생성 중...</div></div>');

    try {
        const instruction = buildInstruction();
        let raw = '';

        if (cfg.apiSource === 'main') {
            const background = await gatherContextPlain(msgIdx);
            const { generateRaw } = ctx;
            if (!generateRaw) throw new Error('generateRaw not available');

            raw = await generateRaw({
                systemPrompt: background,
                prompt: instruction,
                streaming: false,
            });
        } else {
            const conversation = await gatherContextMessages(msgIdx);
            conversation.push({ role: 'user', content: instruction });

            if (!ctx.ConnectionManagerRequestService) {
                throw new Error('Connection Manager 미로드. SillyTavern 재시작 필요.');
            }

            const resp = await ctx.ConnectionManagerRequestService.sendRequest(
                cfg.connectionProfileId,
                conversation,
                4000,
                { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            ).catch(err => {
                throw new Error(`Connection Profile 오류: ${err.message || '알 수 없음'}`);
            });

            if (typeof resp === 'string') {
                raw = resp;
            } else if (resp?.choices?.[0]?.message) {
                const m = resp.choices[0].message;
                raw = m.reasoning_content || m.content || '';
            } else {
                raw = resp?.content || resp?.message || '';
            }
        }

        const ideas = parseIdeas(raw);
        if (!ideas || ideas.length === 0) throw new Error('추천을 파싱할 수 없습니다.');

        cfg.savedIdeas[key] = {
            ideas,
            expanded: false,
            ts: Date.now(),
        };
        persist();

        msgEl.find('.si-panel').remove();
        paintIdeas(msgIdx, ideas, false);

    } catch (err) {
        console.error(`[${EXT_NAME}]`, err);
        msgEl.find('.si-panel').remove();
        msgEl.append(buildErrorHTML(err.message, msgIdx));
        toastr.error(`추천 생성 실패: ${err.message}`);
    } finally {
        activeJobs.delete(key);
    }
}

// ─── 프롬프트 구성 ───

function buildInstruction() {
    const lang = cfg.lang || 'en';
    const langNote = lang === 'ko'
        ? '⚠️ 모든 추천을 한국어로 작성하세요.'
        : '⚠️ Write all suggestions in English.';

    const detailMap = {
        brief: '1-2 sentences per idea',
        normal: '3-5 sentences per idea',
        detailed: '6+ sentences with rich context',
    };

    return `${ctx.substituteParams(cfg.prompt)}

${langNote}

OUTPUT FORMAT - Use this EXACT structure:
<suggestions>
[Title of idea 1]
Description of the episode idea here.

[Title of idea 2]
Description here.

[Title of idea 3]
Description here.
</suggestions>

Rules:
- Exactly ${cfg.count} suggestions
- Detail level: ${detailMap[cfg.detailLevel] || detailMap.normal}
- Each suggestion: title in [brackets] followed by description on next line(s)
- MUST wrap in <suggestions>...</suggestions>
- NO text outside the tags`;
}

// ─── 컨텍스트 수집 ───

function fetchPersonaData() {
    try {
        if (!user_avatar || !power_user) return '';
        let out = '';
        const pName = power_user.personas?.[user_avatar] || power_user.name || 'User';
        out += `User/Persona: ${pName}\n`;
        const pDesc = power_user.persona_descriptions?.[user_avatar];
        if (pDesc?.description) {
            out += `\nPersona Description:\n${pDesc.description}\n`;
        } else if (power_user.persona_description) {
            out += `\nPersona Description:\n${power_user.persona_description}\n`;
        }
        return out.trim();
    } catch (e) {
        console.error(`[${EXT_NAME}] Persona fetch error:`, e);
        return '';
    }
}

function fetchCharacterData() {
    try {
        const context = SillyTavern.getContext();
        const cid = context.characterId;
        const chars = context.characters;
        if (cid === undefined || !chars?.[cid]) return '';

        const ch = chars[cid];
        const d = ch.data || ch;
        let out = '';

        if (ch.name) out += `Character: ${ch.name}\n`;
        if (d.description) out += `\nDescription:\n${d.description}\n`;
        if (d.personality) out += `\nPersonality:\n${d.personality}\n`;
        if (d.scenario) out += `\nScenario:\n${d.scenario}\n`;
        if (d.creator_notes) out += `\nCreator Notes:\n${d.creator_notes}\n`;
        if (d.system_prompt) out += `\nSystem Prompt:\n${d.system_prompt}\n`;

        if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries);
            if (entries.length > 0) {
                out += `\n\nCharacter Lore (${entries.length} entries):\n`;
                entries.forEach(e => { if (e.content) out += `- ${e.content}\n`; });
            }
        }

        return out.trim();
    } catch (e) {
        console.error(`[${EXT_NAME}] Character fetch error:`, e);
        return '';
    }
}

async function fetchLorebook() {
    if (!ctx.chat || ctx.chat.length === 0) return '';
    try {
        const lines = ctx.chat.map(m => m?.mes || '').filter(Boolean);
        if (lines.length === 0) return '';

        const result = await getWorldInfoPrompt(lines, 8000, true, undefined);
        return result?.worldInfoString?.trim() || '';
    } catch (e) {
        console.error(`[${EXT_NAME}] Lorebook fetch error:`, e);
        return '';
    }
}

async function gatherContextPlain(upTo) {
    let text = '';

    const persona = fetchPersonaData();
    if (persona) text += '=== PERSONA ===\n' + persona + '\n\n';

    const character = fetchCharacterData();
    if (character) text += '=== CHARACTER ===\n' + character + '\n\n';

    const lore = await fetchLorebook();
    if (lore) text += '=== LOREBOOK / WORLD INFO ===\n' + lore + '\n\n';

    text += '=== CONVERSATION ===\n';
    const depth = 30;
    const start = Math.max(0, upTo - depth + 1);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        const who = m.is_user ? (m.name || 'User') : (m.name || 'Character');
        const body = m.extra?.display_text ?? m.mes;
        text += `${who}: ${body}\n\n`;
    }

    return text.trim();
}

async function gatherContextMessages(upTo) {
    const msgs = [];

    const persona = fetchPersonaData();
    const character = fetchCharacterData();
    const lore = await fetchLorebook();

    let sys = '';
    if (persona) sys += persona;
    if (character) sys += (sys ? '\n\n' : '') + character;
    if (lore) sys += (sys ? '\n\n=== LOREBOOK / WORLD INFO ===\n' : '') + lore;

    if (sys) msgs.push({ role: 'system', content: sys });

    const depth = 30;
    const start = Math.max(0, upTo - depth + 1);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        msgs.push({
            role: m.is_user ? 'user' : 'assistant',
            content: m.extra?.display_text ?? m.mes,
        });
    }

    return msgs;
}

// ─── 파싱 ───

function parseIdeas(content) {
    if (!content) return null;

    // 1차: <suggestions>...</suggestions> 파싱
    const tagMatch = content.match(/<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/i);
    const body = tagMatch ? tagMatch[1] : content;

    // [Title] + 본문 패턴
    const ideaBlocks = [];
    const regex = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\s*\[|\s*$)/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        const title = match[1].trim();
        const desc = match[2].trim();
        if (title && desc && desc.length > 5) {
            ideaBlocks.push({ title, body: desc });
        }
    }

    if (ideaBlocks.length > 0) {
        return ideaBlocks.slice(0, cfg.count || 8);
    }

    // 폴백: 숫자 리스트 (1. **Title** - description)
    const numericBlocks = [];
    const numRegex = /\d+\.\s*\*?\*?([^*\n:]+)\*?\*?\s*[-:]\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    while ((match = numRegex.exec(body)) !== null) {
        const title = match[1].trim();
        const desc = match[2].trim();
        if (title && desc.length > 5) {
            numericBlocks.push({ title, body: desc });
        }
    }

    if (numericBlocks.length >= 2) {
        return numericBlocks.slice(0, cfg.count || 8);
    }

    // 최후: 불릿 리스트
    const bullets = body.split('\n')
        .map(l => l.trim())
        .filter(l => /^[-*•]\s+/.test(l))
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 10);

    if (bullets.length >= 2) {
        return bullets.slice(0, cfg.count || 8).map(b => ({ title: '', body: b }));
    }

    console.error(`[${EXT_NAME}] Parse failed. Raw:`, content.substring(0, 400));
    return null;
}

// ─── 렌더링 ───

function paintIdeas(msgIdx, ideas, expanded = false) {
    const msgEl = $(`[mesid="${msgIdx}"] .mes_text`);
    msgEl.find('.si-panel').remove();

    const panel = $('<div class="si-panel"></div>').attr('data-si-msg', msgIdx);

    // 헤더 바
    const bar = $('<div class="si-bar"></div>');
    const label = $('<span class="si-label"></span>');
    label.append('💡 에피소드 추천 ');
    label.append(`<span class="si-arrow ${expanded ? 'open' : ''}">▼</span>`);

    const actions = $('<div class="si-actions"></div>');
    actions.append('<button class="si-btn si-refresh" title="재생성">🔄</button>');
    actions.append('<button class="si-btn si-remove" title="삭제">❌</button>');

    bar.append(label).append(actions);
    panel.append(bar);

    // 내용
    const body = $('<div class="si-body"></div>');
    if (!expanded) body.addClass('hidden');

    ideas.forEach(idea => {
        const card = $('<div class="si-card"></div>');
        if (idea.title) {
            card.append(`<div class="si-card-title">${sanitize(idea.title)}</div>`);
        }
        card.append(`<div class="si-card-body">${sanitize(idea.body || '')}</div>`);
        body.append(card);
    });

    panel.append(body);
    msgEl.append(panel);

    // 이벤트 핸들러
    bar.on('click', function (e) {
        if ($(e.target).closest('.si-btn').length) return;
        const isHidden = body.hasClass('hidden');
        body.toggleClass('hidden');
        panel.find('.si-arrow').toggleClass('open');

        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            cfg.savedIdeas[key].expanded = isHidden;
            persist();
        }
    });

    panel.find('.si-refresh').on('click', async function (e) {
        e.stopPropagation();
        const btn = $(this);
        btn.prop('disabled', true);

        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            delete cfg.savedIdeas[key];
            persist();
        }

        await produce(msgIdx);
        btn.prop('disabled', false);
    });

    panel.find('.si-remove').on('click', function (e) {
        e.stopPropagation();
        if (!confirm('이 추천을 삭제할까요?')) return;

        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas[key]) {
            delete cfg.savedIdeas[key];
            persist();
        }
        panel.remove();
        toastr.success('추천 삭제됨');
    });
}

function buildErrorHTML(errorMsg, msgIdx) {
    const panel = $('<div class="si-panel"></div>');
    const fail = $('<div class="si-fail"></div>');

    const header = $('<div style="display:flex;align-items:center;gap:10px;"></div>');
    header.append('<span style="font-weight:bold;">❌ 추천 생성 실패</span>');

    const retryBtn = $('<button class="si-btn">🔄 재시도</button>');
    retryBtn.on('click', async function () {
        $(this).prop('disabled', true).text('생성 중...');
        panel.remove();
        const key = compositeKey(msgIdx);
        if (key && cfg.savedIdeas?.[key]) {
            delete cfg.savedIdeas[key];
            persist();
        }
        await produce(msgIdx);
    });
    header.append(retryBtn);
    fail.append(header);

    fail.append(`
        <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-size:0.9em;color:var(--SmartThemeQuoteColor);">상세 정보</summary>
            <pre style="margin-top:6px;padding:8px;background:rgba(0,0,0,0.3);border:1px solid var(--SmartThemeBorderColor);border-radius:4px;font-size:0.85em;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow-y:auto;">${sanitize(errorMsg)}</pre>
        </details>
    `);

    panel.append(fail);
    return panel;
}

// ─── 보조 함수 ───

function toggleMenuBtn(visible) {
    const btn = document.getElementById('si_generate_btn');
    if (btn) btn.style.display = visible ? '' : 'none';
}

function findLastBotMessageIdx() {
    if (!ctx.chat || ctx.chat.length === 0) return -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) return i;
    }
    return -1;
}

function restoreVisible() {
    if (!cfg.enabled) return;

    let restored = 0;
    ctx.chat.forEach((msg, idx) => {
        if (msg.is_user) return;
        const key = compositeKey(idx);
        const el = $(`[mesid="${idx}"] .mes_text`);
        if (el.length === 0 || el.find('.si-panel').length > 0) return;

        if (key && cfg.savedIdeas[key]) {
            const rec = cfg.savedIdeas[key];
            paintIdeas(idx, rec.ideas, rec.expanded);
            restored++;
        }
    });

    console.log(`[${EXT_NAME}] Restored ${restored} panels`);
}

// ─── 부팅 ───

jQuery(async () => {
    await boot();
});
